"""story-graph FastAPI sidecar。

起動: .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765
      (cwd = backend/)

エンドポイントはすべて async def にしてイベントループ上で直列実行する。
ローカル単一ユーザー前提なので、これで SQLite への書き込み競合を避ける。
"""

from __future__ import annotations

import asyncio
import os
import zipfile
from typing import Any

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

import backup
import chat_agent
import db
import generation
import llm
import rendering
import snapshots
from comfy_manager import ComfyManager
from llama_manager import LlamaManager
from store import Store
from tts_manager import TtsManager

app = FastAPI(title="story-graph backend")
app.add_middleware(
    CORSMiddleware,
    # 相手は Electron レンダラ(dev は http://localhost:<port>、本番は file:// で Origin が
    # "null")だけ。"*" だとブラウザで開いた任意のサイトからインストーラや設定を
    # 叩けてしまうので、それ以外の Origin にはプリフライトを通さない
    allow_origin_regex=r"^(null|file://.*|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# 起動時のライブラリ解決: STORY_GRAPH_LIBRARY(ルートフォルダ) >
# STORY_GRAPH_DB(DB ファイル直指定。テスト用) > リポジトリ内 data/
_library_root = os.environ.get("STORY_GRAPH_LIBRARY")
_db_path = os.environ.get("STORY_GRAPH_DB")
if _library_root:
    from pathlib import Path as _Path

    store = Store(db.connect(_Path(_library_root) / "story-graph.db"), root=_library_root)
else:
    store = Store(db.connect(_db_path), root=str(db.DEFAULT_DB_PATH.parent))
llama = LlamaManager()
comfy_mgr = ComfyManager()
tts_mgr = TtsManager()


# 書き込みメソッドの途中で例外が出ると、共有コネクションに半端な変更が残り、
# 次のリクエストの commit で意図せず確定してしまう。エラー応答時は必ず捨てる。
def _rollback_pending() -> None:
    try:
        store.conn.rollback()
    except Exception:  # noqa: BLE001
        pass


# create_task の戻りは握っておく(イベントループはタスクを弱参照しか持たず、
# 参照ゼロのタスクは GC で途中終了することがある)
_bg_tasks: set[asyncio.Task] = set()


def _spawn_bg(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


# 読み上げ音声の掃除(docs/design/voice.md §6)。清書の保存・台本や声の設定の変更・シーンの削除の
# たびに呼ばれるので、数秒まとめてから 1 回だけ走らせる
AUDIO_GC_DELAY_SEC = 3.0
_audio_gc_pending = False


def _schedule_audio_gc(delay: float = AUDIO_GC_DELAY_SEC) -> None:
    global _audio_gc_pending
    if _audio_gc_pending:
        return
    _audio_gc_pending = True

    async def run() -> None:
        global _audio_gc_pending
        await asyncio.sleep(delay)
        _audio_gc_pending = False
        await _gc_audio_now()

    _spawn_bg(run())


def _voice_housekeeping() -> None:
    """ライブラリを開いたときの声まわりの片付け。Step 1 の語り手の設定キーを声に移し、
    どの声からも参照されない参照音声(assets/voices)を消す。失敗しても開くのは止めない。"""
    import voice

    try:
        if voice.migrate_legacy_narrator(store):
            print("[voice] 語り手の設定を「語り手」の声に移しました")
        removed = store.gc_voices()
        if removed:
            print(f"[voice] 使われていない参照音声を {removed} 件削除しました")
    except Exception as e:  # noqa: BLE001
        print(f"[voice] 片付けに失敗: {e}")


async def _gc_audio_now() -> int:
    """いま読むと使う音声以外を assets/audio から消す。声の設定が壊れているときは何も消さない
    (「使う音声」が割り出せないのに消すと、全部消えてしまうため)。"""
    import voice
    from pathlib import Path as _Path

    audio = store.audio_dir()
    if audio is None:
        return 0
    try:
        keep = voice.expected_audio(store, store.get_settings())
    except Exception as e:  # noqa: BLE001 — 掃除の失敗で本来の操作を止めない
        print(f"[audio] 掃除を見送りました: {e}")
        return 0
    removed = await asyncio.to_thread(voice.sweep_audio, _Path(audio), keep)
    if removed:
        print(f"[audio] 使われなくなった読み上げ音声を {removed} 件削除しました")
    return removed


@app.exception_handler(StarletteHTTPException)
async def _http_error_rollback(request: Request, exc: StarletteHTTPException):
    _rollback_pending()
    return await http_exception_handler(request, exc)


@app.exception_handler(Exception)
async def _unhandled_error_rollback(request: Request, exc: Exception):
    _rollback_pending()
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


@app.on_event("startup")
async def _startup() -> None:
    # 埋め込みモデルは初回ロードが重いのでバックグラウンドで温める
    import asyncio

    import embed

    asyncio.get_event_loop().run_in_executor(None, embed.warmup)
    try:
        import llama_installer

        # 削除・インストール失敗の残骸(.removing-* / .installing-*)を回収する
        asyncio.get_event_loop().run_in_executor(None, llama_installer.cleanup_leftovers)
    except Exception as e:  # 回収の失敗で起動を止めない
        print(f"[llama] 残骸の回収に失敗: {e}")
    try:
        removed = store.gc_assets()
        if removed:
            print(f"[assets] 未参照ファイルを {removed} 件削除しました")
    except Exception as e:  # GC の失敗で起動を止めない
        print(f"[assets] GC に失敗: {e}")
    _voice_housekeeping()
    _schedule_audio_gc()
    _spawn_bg(_deferred_auto_backup())


@app.on_event("shutdown")
def _shutdown() -> None:
    llama.stop()
    comfy_mgr.stop()
    tts_mgr.stop()


# ---- schemas --------------------------------------------------------

class CharacterIn(BaseModel):
    name: str
    profile: str | None = None
    appearance: str | None = None
    voice: str | None = None
    color: str | None = None


class CharacterPatch(BaseModel):
    name: str | None = None
    profile: str | None = None
    appearance: str | None = None
    voice: str | None = None
    color: str | None = None
    graph_x: float | None = None
    graph_y: float | None = None
    portrait_path: str | None = None
    portrait_source_path: str | None = None
    portrait_crop: str | None = None
    ref_image_path: str | None = None
    ref_image_prompt: str | None = None
    ref_image_instructions: str | None = None
    ref_image_seed: int | None = None
    voice_profile_id: str | None = None  # 読み上げの声(null で外す = 語り手の声で読む)


class PlaceIn(BaseModel):
    name: str
    description: str | None = None
    atmosphere: str | None = None
    color: str | None = None


class PlacePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    atmosphere: str | None = None
    color: str | None = None
    image_path: str | None = None


class FactionIn(BaseModel):
    name: str
    description: str | None = None


class FactionPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    members: list[str] | None = None


class EventIn(BaseModel):
    # id は既存イベントの編集時に引き継ぐ(無ければ新規発行)。ID を保つことで
    # memory_compress.replaces や関係の reasons のイベント参照が編集で壊れない
    id: str | None = None
    type: str
    payload: dict[str, Any]
    source: str = "user"


class NodeIn(BaseModel):
    title: str | None = None
    beat: str
    emotional_core: str | None = None
    cast: list[str] = Field(default_factory=list)
    location: str | None = None
    story_time: str | None = None
    parent_id: str | None = None
    draft: bool = False  # True で常に draft ブランチとして挿入(提案カード用)
    detached: bool = False  # True でどこにも繋がない独立シーン(島の起点)
    events: list[EventIn] = Field(default_factory=list)


class NodePatch(BaseModel):
    title: str | None = None
    beat: str | None = None
    emotional_core: str | None = None
    cast: list[str] | None = None
    location: str | None = None
    story_time: str | None = None
    status: str | None = None


class EventsPut(BaseModel):
    events: list[EventIn]


class SettingsPut(BaseModel):
    values: dict[str, str]


# ---- health / library ----------------------------------------------

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


class LibrarySwitchIn(BaseModel):
    root: str


@app.get("/library")
async def get_library() -> dict[str, Any]:
    return {"root": store.root}


@app.post("/library/switch")
async def switch_library(body: LibrarySwitchIn) -> dict[str, Any]:
    try:
        store.switch_library(body.root)
    except OSError as e:
        raise HTTPException(400, f"ライブラリを開けません: {e}")
    try:
        store.gc_assets()
    except Exception as e:  # GC の失敗で切替を止めない
        print(f"[assets] GC に失敗: {e}")
    _voice_housekeeping()
    _schedule_audio_gc()
    _spawn_bg(_auto_backup_quietly())  # 開いたライブラリの日次チェック
    return {"root": store.root}


# ---- characters -----------------------------------------------------

@app.get("/characters")
async def list_characters() -> list[dict[str, Any]]:
    return store.list_characters()


@app.post("/characters")
async def create_character(body: CharacterIn) -> dict[str, Any]:
    return store.create_character(body.model_dump())


@app.get("/characters/{char_id}")
async def get_character(char_id: str) -> dict[str, Any]:
    char = store.get_character(char_id)
    if char is None:
        raise HTTPException(404, "character not found")
    return char


@app.patch("/characters/{char_id}")
async def update_character(char_id: str, body: CharacterPatch) -> dict[str, Any]:
    patch = body.model_dump(exclude_unset=True)
    if patch.get("voice_profile_id") and store.get_voice_profile(patch["voice_profile_id"]) is None:
        raise HTTPException(400, "voice profile not found")
    char = store.update_character(char_id, patch)
    if char is None:
        raise HTTPException(404, "character not found")
    if "voice_profile_id" in patch:
        _schedule_audio_gc()  # 前の声で作った台詞の音声は使われなくなる
    return char


@app.delete("/characters/{char_id}")
async def delete_character(char_id: str) -> dict[str, str]:
    store.delete_character(char_id)
    return {"status": "deleted"}


# ---- places ---------------------------------------------------------

@app.get("/places")
async def list_places() -> list[dict[str, Any]]:
    return store.list_places()


@app.post("/places")
async def create_place(body: PlaceIn) -> dict[str, Any]:
    return store.create_place(body.model_dump())


@app.get("/places/{place_id}")
async def get_place(place_id: str) -> dict[str, Any]:
    place = store.get_place(place_id)
    if place is None:
        raise HTTPException(404, "place not found")
    return place


@app.patch("/places/{place_id}")
async def update_place(place_id: str, body: PlacePatch) -> dict[str, Any]:
    place = store.update_place(place_id, body.model_dump(exclude_unset=True))
    if place is None:
        raise HTTPException(404, "place not found")
    return place


@app.delete("/places/{place_id}")
async def delete_place(place_id: str) -> dict[str, str]:
    store.delete_place(place_id)
    return {"status": "deleted"}


# ---- factions -------------------------------------------------------

@app.get("/factions")
async def list_factions() -> list[dict[str, Any]]:
    return store.list_factions()


@app.post("/factions")
async def create_faction(body: FactionIn) -> dict[str, Any]:
    return store.create_faction(body.model_dump())


@app.patch("/factions/{faction_id}")
async def update_faction(faction_id: str, body: FactionPatch) -> dict[str, str]:
    store.update_faction(faction_id, body.model_dump(exclude_unset=True))
    return {"status": "ok"}


@app.delete("/factions/{faction_id}")
async def delete_faction(faction_id: str) -> dict[str, str]:
    store.delete_faction(faction_id)
    return {"status": "deleted"}


# ---- timeline / nodes ----------------------------------------------

@app.get("/timeline")
async def timeline() -> list[dict[str, Any]]:
    return store.timeline()


@app.get("/graph")
async def graph() -> dict[str, Any]:
    return store.graph()


@app.post("/nodes")
async def create_node(body: NodeIn) -> dict[str, Any]:
    data = body.model_dump(exclude={"events", "parent_id", "draft", "detached"})
    events = [e.model_dump() for e in body.events]
    try:
        node = store.append_node(
            data, events, parent_id=body.parent_id, force_draft=body.draft, detached=body.detached
        )
    except KeyError as e:
        raise HTTPException(404, str(e))
    node["validation"] = store.validate(node["id"])
    return node


@app.post("/nodes/{node_id}/insert_after")
async def insert_node_after(node_id: str, body: NodeIn) -> dict[str, Any]:
    """node_id とその後続シーンの間に新しいシーンを割り込ませる。"""
    data = body.model_dump(exclude={"events", "parent_id", "draft"})
    events = [e.model_dump() for e in body.events]
    try:
        node = store.insert_node_after(node_id, data, events)
    except KeyError as e:
        raise HTTPException(404, str(e))
    node["validation"] = store.validate(node["id"])
    return node


@app.post("/nodes/{node_id}/make_canon")
async def make_canon(node_id: str) -> dict[str, Any]:
    """このノードを通る道を正史にする(先の結末をアクティブに。無ければ作る)。"""
    await snapshots.auto(store, "正史切替の前", 0)
    try:
        store.make_canon(node_id)
    except KeyError:
        raise HTTPException(404, "node not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"canon_path": store.canon_path()}


class EndingIn(BaseModel):
    title: str | None = None
    activate: bool = True


@app.post("/nodes/{node_id}/ending")
async def create_ending(node_id: str, body: EndingIn) -> dict[str, Any]:
    """このシーンの先に新しい結末を作る(docs/design/endings.md)。"""
    try:
        return store.create_ending(node_id, body.title, body.activate)
    except KeyError:
        raise HTTPException(404, "node not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/endings")
async def create_floating_ending(body: EndingIn) -> dict[str, Any]:
    """どこにも繋がない結末を作る(あとでシーンからドラッグしてつなぐ)。"""
    return store.create_ending(None, body.title, activate=False)


class AttachIn(BaseModel):
    parent_id: str
    child_id: str
    canon: bool = False  # 既定は draft で繋ぐ(正史にするのは make_canon)
    # True で「つなぎ替え」: 繋ぎ先に既に親がいれば、その親エッジを切ってから繋ぐ
    replace_parent: bool = False


@app.post("/nodes/{node_id}/detach")
async def detach_node(node_id: str) -> dict[str, Any]:
    """親エッジを切って、このシーン以下を独立した島にする。"""
    await snapshots.auto(store, "つなぎ替えの前", 60)
    try:
        detached = store.detach_node(node_id)
    except KeyError:
        raise HTTPException(404, "node not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"detached": detached, "canon_path": store.canon_path()}


@app.post("/nodes/{node_id}/normalize_chain")
async def normalize_chain(node_id: str) -> dict[str, Any]:
    """このシーン以下の char_introduce の重複を掃除し、検証結果を返す(LLM 不要)。"""
    try:
        return store.normalize_chain(node_id)
    except KeyError:
        raise HTTPException(404, "node not found")


@app.post("/edges")
async def create_edge(body: AttachIn) -> dict[str, Any]:
    """シーンを他のシーンの子として繋ぐ(replace_parent=True で既存の親から繋ぎ替え)。"""
    await snapshots.auto(store, "つなぎ替えの前", 60)
    try:
        store.attach_node(body.parent_id, body.child_id, body.canon, body.replace_parent)
    except KeyError:
        raise HTTPException(404, "node not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"canon_path": store.canon_path()}


# ---- 章グループ(docs/design/chapters.md) ---------------------------


class GroupCreateIn(BaseModel):
    title: str
    node_ids: list[str]


class GroupPatch(BaseModel):
    title: str | None = None
    color: str | None = None
    # 章カードの表紙にするシーン(null = 自動。章内で最初に挿絵があるシーンを使う)
    cover_node_id: str | None = None


@app.get("/groups")
async def list_groups() -> list[dict[str, Any]]:
    return store.list_groups()


@app.post("/groups")
async def create_group(body: GroupCreateIn) -> dict[str, Any]:
    """正史パス上の連続区間を章にする。"""
    try:
        return store.create_group(body.title, body.node_ids)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/groups/{group_id}")
async def update_group(group_id: str, body: GroupPatch) -> dict[str, Any]:
    try:
        group = store.update_group(group_id, body.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if group is None:
        raise HTTPException(404, "group not found")
    return group


@app.delete("/groups/{group_id}")
async def delete_group(group_id: str) -> dict[str, str]:
    """章を解除する(シーンはそのまま残る)。"""
    store.delete_group(group_id)
    return {"status": "deleted"}


class GroupMoveIn(BaseModel):
    after: str | None = None  # None = 先頭(「はじまり」の直後)へ


@app.post("/groups/{group_id}/move")
async def move_group(group_id: str, body: GroupMoveIn) -> list[dict[str, Any]]:
    """章を別の章の後ろへつなぎ替える(並べ替え)。"""
    await snapshots.auto(store, "章の並べ替えの前", 60)
    try:
        return store.move_group(group_id, body.after)
    except KeyError:
        raise HTTPException(404, "group not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


class DigestIn(BaseModel):
    events: list[EventIn]


@app.get("/groups/{group_id}/digest")
async def get_group_digest(group_id: str) -> dict[str, Any]:
    """章のまとめ(digest)。無ければ digest_events は null。"""
    group = store.get_group(group_id)
    if group is None:
        raise HTTPException(404, "group not found")
    return {"digest_events": group["digest_events"], "digest_stale": group["digest_stale"]}


@app.post("/groups/{group_id}/digest/generate")
async def generate_group_digest(group_id: str) -> dict[str, Any]:
    """LLM で章のまとめを生成してそのまま保存する(内容は後から編集できる)。"""
    await snapshots.auto(store, "章のまとめ更新の前", 60)
    try:
        base_url = await llama.ensure_running(store.get_settings())
        events = await generation.generate_group_digest(store, base_url, group_id)
        return store.save_group_digest(group_id, events)
    except KeyError:
        raise HTTPException(404, "group not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@app.put("/groups/{group_id}/digest")
async def put_group_digest(group_id: str, body: DigestIn) -> dict[str, Any]:
    """手直ししたまとめを保存する。内容が変わったときだけ下流(次章側)へ波及する。"""
    await snapshots.auto(store, "章のまとめ更新の前", 60)
    try:
        return store.save_group_digest(
            group_id, [e.model_dump(exclude={"source"}) for e in body.events]
        )
    except KeyError:
        raise HTTPException(404, "group not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/groups/{group_id}/digest")
async def delete_group_digest(group_id: str) -> dict[str, Any]:
    """まとめを削除する(章は残る。下流は生の状態に戻る)。"""
    await snapshots.auto(store, "章のまとめ更新の前", 60)
    try:
        return store.delete_group_digest(group_id)
    except KeyError:
        raise HTTPException(404, "group not found")


@app.post("/groups/{group_id}/route/{node_id}")
async def set_group_route(group_id: str, node_id: str) -> dict[str, Any]:
    """章の読む道を、このシーンを通る道にする(出口をその枝の端へ繋ぎ替える)。"""
    await snapshots.auto(store, "章の道の差し替えの前", 60)
    try:
        group = store.set_group_route(group_id, node_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"group": group, "groups": store.list_groups()}


@app.post("/groups/{group_id}/nodes/{node_id}")
async def add_node_to_group(group_id: str, node_id: str) -> dict[str, Any]:
    """シーンを章に入れる(章の端に隣接しているときだけ。後続の一続きも一緒に)。"""
    try:
        group = store.add_node_to_group(group_id, node_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"group": group, "groups": store.list_groups()}


@app.delete("/groups/{group_id}/nodes/{node_id}")
async def remove_node_from_group(group_id: str, node_id: str) -> dict[str, Any]:
    """シーンを章から外す(端のシーンのみ)。"""
    try:
        store.remove_node_from_group(node_id)
    except KeyError:
        raise HTTPException(404, "node not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"groups": store.list_groups()}


@app.get("/nodes/{node_id}")
async def get_node(node_id: str) -> dict[str, Any]:
    node = store.get_node(node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    return node


@app.patch("/nodes/{node_id}")
async def update_node(node_id: str, body: NodePatch) -> dict[str, Any]:
    await snapshots.auto(store, "シーン編集の前", 600)
    node = store.update_node(node_id, body.model_dump(exclude_unset=True))
    if node is None:
        raise HTTPException(404, "node not found")
    node["validation"] = store.validate(node_id)
    return node


@app.delete("/nodes/{node_id}")
async def delete_node(node_id: str) -> dict[str, str]:
    await snapshots.auto(store, "シーン削除の前", 30)
    try:
        deleted = store.delete_node(node_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not deleted:
        raise HTTPException(404, "node not found")
    _schedule_audio_gc()
    return {"status": "deleted"}


class PositionIn(BaseModel):
    x: float
    y: float


class NodePositionIn(BaseModel):
    id: str
    x: float
    y: float


class PositionsIn(BaseModel):
    positions: list[NodePositionIn]


class NodeImageIn(BaseModel):
    image_path: str | None = None


class NodeThumbIn(BaseModel):
    thumb_path: str | None = None


class NodeTargetCharsIn(BaseModel):
    # このシーンだけの目安の字数。None / 0 で共通の設定(reader_target_chars)に従う
    target_chars: int | None = None


# ---- 画像/動画アセット(装飾専用。LLM には渡さない) ------------------

ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
ALLOWED_VIDEO_EXTS = {".mp4", ".webm"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 100 * 1024 * 1024


@app.post("/assets/upload")
async def upload_asset(file: UploadFile) -> dict[str, str]:
    import uuid
    from pathlib import Path as _Path

    assets = store.assets_dir()
    if assets is None:
        raise HTTPException(500, "ライブラリが未設定です")
    ext = _Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_IMAGE_EXTS | ALLOWED_VIDEO_EXTS:
        raise HTTPException(400, f"対応していない形式です: {ext}(画像: png/jpg/gif/webp、動画: mp4/webm)")
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    limit = MAX_VIDEO_BYTES if ext in ALLOWED_VIDEO_EXTS else MAX_IMAGE_BYTES
    data = bytearray()
    while chunk := await file.read(1 << 20):
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(400, f"{limit // (1024 * 1024)}MB を超えるファイルはアップロードできません")
    # 大きい動画の書き込みでイベントループを塞がないようスレッドに逃がす
    await asyncio.to_thread((_Path(assets) / name).write_bytes, bytes(data))
    return {"path": name}


@app.get("/assets/{filename}")
async def get_asset(filename: str) -> FileResponse:
    from pathlib import Path as _Path

    assets = store.assets_dir()
    if assets is None:
        raise HTTPException(404, "not found")
    safe_name = _Path(filename).name  # パストラバーサル防止
    path = _Path(assets) / safe_name
    if not path.exists():
        raise HTTPException(404, "not found")
    # <img> の要求は Origin を送らないので CORS ミドルウェアがヘッダを付けず、その応答が
    # ブラウザにキャッシュされると、後から canvas 用に crossOrigin / fetch で読み直したとき
    # CORS 検査に落ちる(切り抜きモーダル)。同じ URL の応答は常に許可ヘッダ付きにしておく
    return FileResponse(str(path), headers={"Access-Control-Allow-Origin": "*"})


@app.post("/nodes/{node_id}/image")
async def set_node_image(node_id: str, body: NodeImageIn) -> dict[str, str]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    store.set_node_image(node_id, body.image_path)
    return {"status": "ok"}


@app.post("/nodes/{node_id}/thumb")
async def set_node_thumb(node_id: str, body: NodeThumbIn) -> dict[str, str]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    store.set_node_thumb(node_id, body.thumb_path)
    return {"status": "ok"}


# ---- 挿絵・参照画像のストック(docs/design/image-gen.md §7) ----


class MediaIn(BaseModel):
    owner_type: str  # 'node' | 'character'
    owner_id: str
    path: str  # /assets/upload または generate の戻り値
    select: bool = True  # 足した画像をそのまま現在の画像にする(ドロップ / ファイル選択の既定)
    # 生成物のとき: 生成に使ったセット(generate の戻り値をそのまま渡す)。手持ちの画像は全部 None
    prompt: str | None = None
    instructions: str | None = None
    seed: int | None = None
    ref_chars: list[str] | None = None
    workflow: str | None = None  # 生成に使ったワークフローの組(variants.json の id)


def _check_media_owner(owner_type: str, owner_id: str) -> None:
    if owner_type == "node":
        if store.get_node(owner_id) is None:
            raise HTTPException(404, "node not found")
    elif owner_type == "character":
        if store.get_character(owner_id) is None:
            raise HTTPException(404, "character not found")
    else:
        raise HTTPException(400, f"unknown owner_type: {owner_type}")


@app.get("/media/{owner_type}/{owner_id}")
async def list_media(owner_type: str, owner_id: str) -> dict[str, Any]:
    """持ち主のストック(新しい順)と、いま選択中のファイル名。"""
    _check_media_owner(owner_type, owner_id)
    return {"items": store.list_media(owner_type, owner_id), "selected": store._selected_media_path(owner_type, owner_id)}


@app.post("/media")
async def add_media(body: MediaIn) -> dict[str, Any]:
    """ストックに足す。手持ちの画像 / 動画(セットは空)と、生成ウインドウの「決定」(生成に使った
    セット付き)の両方がここを通る。select で同時に現在の画像にする。"""
    _check_media_owner(body.owner_type, body.owner_id)
    m = store.add_media(
        body.owner_type, body.owner_id, body.path,
        prompt=body.prompt, instructions=body.instructions, seed=body.seed, ref_chars=body.ref_chars,
        workflow=body.workflow,
    )
    if body.select:
        store.select_media(m["id"])
    return m


@app.post("/media/{media_id}/select")
async def select_media(media_id: str) -> dict[str, Any]:
    try:
        return store.select_media(media_id)
    except KeyError:
        raise HTTPException(404, "media not found")


@app.delete("/media/{media_id}")
async def delete_media(media_id: str) -> dict[str, Any]:
    try:
        ok = store.delete_media(media_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "media not found")
    return {"ok": True}


@app.delete("/media/{owner_type}/{owner_id}/unselected")
async def delete_unselected_media(owner_type: str, owner_id: str) -> dict[str, int]:
    """選択中以外の候補をまとめて消す。"""
    _check_media_owner(owner_type, owner_id)
    return {"deleted": store.delete_unselected_media(owner_type, owner_id)}


@app.post("/nodes/{node_id}/target_chars")
async def set_node_target_chars(node_id: str, body: NodeTargetCharsIn) -> dict[str, str]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    store.set_node_target_chars(node_id, body.target_chars)
    return {"status": "ok"}


@app.post("/nodes/{node_id}/position")
async def set_node_position(node_id: str, body: PositionIn) -> dict[str, str]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    store.set_node_position(node_id, body.x, body.y)
    return {"status": "ok"}


@app.post("/groups/{group_id}/position")
async def set_group_position(group_id: str, body: PositionIn) -> dict[str, str]:
    """章ビューでの章カードの配置を保存する(並べ替えではなく表示位置)。

    章カードは導出表示なので、位置は nodes ではなく groups に持つ
    (docs/design/chapters.md §6)。並べ替えは /groups/{id}/move。
    """
    if not store.set_group_position(group_id, body.x, body.y):
        raise HTTPException(404, "group not found")
    return {"status": "ok"}


@app.post("/layout/positions")
async def set_node_positions(body: PositionsIn) -> dict[str, int]:
    """複数ノードの配置をまとめて保存する。

    自動レイアウト(pos が NULL)のノードを、画面に出ている位置でそのまま
    固定するのに使う。以後は構造が変わってもノードが勝手に動かない。
    """
    updated = store.set_node_positions([(p.id, p.x, p.y) for p in body.positions])
    return {"updated": updated}


@app.post("/layout/reset")
async def reset_layout() -> dict[str, str]:
    store.reset_positions()
    return {"status": "ok"}


@app.put("/nodes/{node_id}/events")
async def put_events(node_id: str, body: EventsPut) -> dict[str, Any]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    await snapshots.auto(store, "イベント編集の前", 600)
    events = store.replace_events(node_id, [e.model_dump() for e in body.events])
    return {"events": events, "validation": store.validate(node_id)}


@app.get("/nodes/{node_id}/state")
async def node_state(node_id: str) -> dict[str, Any]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    try:
        return store.get_state(node_id)
    except (KeyError, TypeError, ValueError) as e:
        # 保存済みの不正イベント(必須フィールド欠落など)で fold が失敗したケース
        raise HTTPException(422, f"fold に失敗しました(不正なイベント): {type(e).__name__}: {e}")


@app.get("/nodes/{node_id}/validate")
async def node_validate(node_id: str) -> dict[str, Any]:
    return {"errors": store.validate(node_id)}


# ---- システム情報 / モデル一覧 --------------------------------------

@app.get("/system/resources")
async def system_resources() -> dict[str, Any]:
    import system_info

    return system_info.resources()


@app.get("/debug/prompts")
async def debug_prompts() -> list[dict[str, Any]]:
    return list(llm.PROMPT_LOG)


@app.get("/generation_prompt")
async def get_generation_prompt() -> dict[str, str]:
    return {
        "default": generation.DEFAULT_GENERATION_PROMPT,
        "rules": generation.GENERATION_RULES,
        "current": store.get_settings().get("generation_system_prompt", ""),
    }


@app.get("/models")
async def list_models() -> dict[str, Any]:
    import system_info
    from llama_manager import resolve_model_path

    settings = store.get_settings()
    models_dir = system_info.resolve_models_dir(settings.get("models_dir"))
    return {
        "models": system_info.list_models(settings.get("models_dir")),
        "current": resolve_model_path(settings),
        # モデルを探しているフォルダ(設定が空なら既定の models/)。設定画面と
        # モデル選択が「どこを見ているか」を出すために返す
        "models_dir": str(models_dir),
        "default_models_dir": str(system_info.DEFAULT_MODELS_DIR),
        "models_dir_exists": models_dir.exists(),
    }


# ---- LLM / 生成 -----------------------------------------------------

class GenerateBeatIn(BaseModel):
    instruction: str | None = None
    parent_id: str | None = None  # 指定時はそのノードからのブランチ生成(draft)
    # 指定時はそのノードの直後へ割り込ませる(章の中への追加。章の出口の手前に入る)
    after_id: str | None = None


@app.get("/llm/status")
async def llm_status() -> dict[str, Any]:
    settings = store.get_settings()
    base_url = settings.get("llm_base_url") or llm.DEFAULT_BASE_URL
    healthy = await llm.health(base_url)
    info = llama.status()
    # spawn 済みだがまだ応答しない = モデルの読み込み中。生成の自動ロード
    # (ensure_running)でもここが立つので、モデル選択バーが状態を映せる
    return {
        "base_url": base_url,
        "healthy": healthy,
        "loading": bool(info["spawned"]) and not healthy,
        **info,
    }


@app.post("/llm/start")
async def llm_start() -> dict[str, Any]:
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"base_url": base_url, "healthy": True, **llama.status()}


@app.post("/llm/stop")
async def llm_stop() -> dict[str, Any]:
    # taskkill の完走待ちでイベントループを塞がないようスレッドに逃がす
    await llama.stop_async()
    return {"stopped": True}


@app.post("/llm/load")
async def llm_load() -> dict[str, Any]:
    """設定中の llm_model_path でモデルを起動し直す(モデル選択からのロード)。"""
    try:
        base_url = await llama.switch(store.get_settings())
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"base_url": base_url, "healthy": True, **llama.status()}


# ---- llama.cpp の自動ダウンロード/インストール ----------------------

@app.get("/llama/releases")
async def llama_releases() -> dict[str, Any]:
    import llama_installer

    try:
        releases = await llama_installer.fetch_releases()
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"releases": releases}


@app.get("/llama/server_status")
async def llama_server_status() -> dict[str, Any]:
    import llama_installer

    # フォルダサイズの集計(rglob)と PATH 走査を含むので、イベントループを塞がない
    return await asyncio.to_thread(llama_installer.status)


class LlamaInstallIn(BaseModel):
    # フロントの variant をそのまま受け取る(asset_url / cudart_url / asset_name などを含む)
    variant: dict[str, Any]
    # CUDA ランタイム DLL を本体と一緒に落とすか(CUDA Toolkit 導入済みなら不要)
    include_cudart: bool = True
    # 本体は落とさず、既存インストールに CUDA ランタイム DLL だけ足す
    cudart_only: bool = False


@app.post("/llama/install")
async def llama_install(body: LlamaInstallIn) -> StreamingResponse:
    import json as _json
    from pathlib import Path

    import llama_installer

    try:
        dest_dir = llama_installer.dest_dir_for(body.variant.get("asset_name") or "")
    except ValueError as e:
        raise HTTPException(400, str(e))

    # 起動中のサーバのフォルダへの展開は拒否する(exe / DLL がロックされていて
    # 途中で失敗するだけなので、始めさせない。uninstall と同じガード)
    running = llama.status()
    if running.get("spawned") and running.get("server_path"):
        try:
            in_use = Path(running["server_path"]).resolve().parent == dest_dir.resolve()
        except OSError:
            in_use = False
        if in_use:
            raise HTTPException(409, "起動中の llama-server です。停止してからインストールしてください。")

    async def stream():
        try:
            if body.cudart_only:
                source = llama_installer.install_cudart(body.variant)
            else:
                source = llama_installer.install_variant(body.variant, body.include_cudart)
            async for progress in source:
                yield f"data: {_json.dumps(progress, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            # クライアント切断でキャンセル。ここでの yield は届かないので何もしない
            raise
        except Exception as e:  # noqa: BLE001
            yield f"data: {_json.dumps({'phase': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


class LlamaUninstallIn(BaseModel):
    install_dir: str


@app.post("/llama/uninstall")
async def llama_uninstall(body: LlamaUninstallIn) -> dict[str, Any]:
    """インストール済みの llama-server を 1 つ削除する(runtime/ 配下のみ)。"""
    from pathlib import Path

    import llama_installer

    running = llama.status()
    if running.get("spawned") and running.get("server_path"):
        try:
            in_use = Path(running["server_path"]).resolve().parent == Path(body.install_dir).resolve()
        except OSError:
            in_use = False
        if in_use:
            raise HTTPException(409, "起動中の llama-server です。停止してから削除してください。")

    try:
        result = await asyncio.to_thread(llama_installer.uninstall, body.install_dir)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except (RuntimeError, OSError) as e:
        raise HTTPException(500, str(e))
    return {**result, **(await asyncio.to_thread(llama_installer.status))}


# ---- ComfyUI(画像生成) ----------------------------------------------
# 設計: docs/design/image-gen.md。llama と同じく「外部起動を優先、無ければ runtime/ の
# インストールを spawn」。生成物は挿絵と同じ assets/images に置く

@app.get("/comfy/status")
async def comfy_status() -> dict[str, Any]:
    import comfy
    import comfy_installer
    import comfy_manager

    settings = store.get_settings()
    base_url = comfy_manager.resolve_base_url(settings)
    healthy = await comfy.health(base_url)
    info = comfy_mgr.status()
    return {
        **info,
        **(await asyncio.to_thread(comfy_installer.status)),
        # マネージャの base_url(未起動なら None)より、設定から解決した URL を優先して返す
        "base_url": base_url,
        "healthy": healthy,
        "loading": bool(info["spawned"]) and not healthy,
        "models_dir": comfy_manager.resolve_models_dir(settings),
        "default_models_dir": comfy_manager.DEFAULT_MODELS_DIR,
    }


@app.post("/comfy/start")
async def comfy_start() -> dict[str, Any]:
    try:
        base_url = await comfy_mgr.ensure_running(store.get_settings())
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"base_url": base_url, "healthy": True, **comfy_mgr.status()}


@app.post("/comfy/stop")
async def comfy_stop() -> dict[str, Any]:
    await comfy_mgr.stop_async()
    return {"stopped": True}


@app.get("/comfy/models")
async def comfy_models(folder: str = "checkpoints") -> dict[str, Any]:
    """起動中の ComfyUI が見つけているモデル名(チェックポイント選択用)。停止中は空。"""
    import comfy
    import comfy_manager
    import re as _re

    if not _re.fullmatch(r"[a-z_]+", folder):
        raise HTTPException(400, "不正なフォルダ名です")
    base_url = comfy_manager.resolve_base_url(store.get_settings())
    if not await comfy.health(base_url):
        return {"models": [], "healthy": False}
    try:
        return {"models": await comfy.list_models(base_url, folder), "healthy": True}
    except (RuntimeError, OSError) as e:
        raise HTTPException(502, str(e))


@app.get("/comfy/releases")
async def comfy_releases() -> dict[str, Any]:
    import comfy_installer

    try:
        releases = await comfy_installer.fetch_releases()
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"releases": releases}


class ComfyInstallIn(BaseModel):
    variant: dict[str, Any]


@app.post("/comfy/install")
async def comfy_install(body: ComfyInstallIn) -> StreamingResponse:
    import json as _json

    import comfy_installer

    if comfy_mgr.status()["spawned"]:
        raise HTTPException(409, "ComfyUI が起動中です。停止してからインストールしてください。")

    async def stream():
        try:
            async for progress in comfy_installer.install_variant(body.variant):
                yield f"data: {_json.dumps(progress, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            yield f"data: {_json.dumps({'phase': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/comfy/uninstall")
async def comfy_uninstall() -> dict[str, Any]:
    import comfy_installer

    if comfy_mgr.status()["spawned"]:
        raise HTTPException(409, "ComfyUI が起動中です。停止してから削除してください。")
    try:
        await asyncio.to_thread(comfy_installer.uninstall)
    except (RuntimeError, OSError) as e:
        raise HTTPException(500, str(e))
    return await asyncio.to_thread(comfy_installer.status)


# ---- TTS(清書の読み上げ) -----------------------------------------------
# 設計: docs/design/voice.md。ComfyUI と同じく「外部起動を優先、無ければ runtime/tts/<engine>/ を
# spawn」。エンジンの違いは tts_engines/<id>.json に閉じ込め、ここでは中身を解釈しない

def _tts_engine() -> dict[str, Any]:
    import tts

    try:
        return tts.get_engine(tts.resolve_engine_id(store.get_settings()))
    except ValueError as e:
        raise HTTPException(400, str(e))


def _audio_dir():
    from pathlib import Path as _Path

    audio = store.audio_dir()
    if audio is None:
        raise HTTPException(500, "ライブラリが未設定です")
    return _Path(audio)


@app.get("/tts/status")
async def tts_status() -> dict[str, Any]:
    import tts
    import tts_installer
    import tts_manager
    import voice

    settings = store.get_settings()
    engine = _tts_engine()
    base_url = tts.resolve_base_url(settings, engine)
    healthy = await tts.health(base_url, engine.get("health_path", "/health"))
    info = tts_mgr.status()
    spawned = bool(info["spawned"]) and info["spawned_engine"] == engine["id"]
    audio = store.audio_dir()
    from pathlib import Path as _Path

    return {
        **info,
        **(await asyncio.to_thread(tts_installer.status, engine["id"])),
        "engine": {"id": engine["id"], "label": engine.get("label") or engine["id"],
                   "description": engine.get("description"), "voice_modes": (engine.get("voice") or {}).get("modes", [])},
        "engines": [{"id": e["id"], "label": e.get("label") or e["id"]} for e in tts.list_engines()],
        "base_url": base_url,
        "healthy": healthy,
        "spawned": spawned,
        "loading": spawned and not healthy,
        # 応答しているのに自分で起動していない = 外部で起動済み(止めない)
        "external": healthy and not spawned,
        "models_dir": tts_manager.resolve_models_dir(settings),
        "default_models_dir": tts_manager.DEFAULT_MODELS_DIR,
        "cache": await asyncio.to_thread(voice.cache_status, _Path(audio) if audio else None),
    }


@app.post("/tts/start")
async def tts_start() -> dict[str, Any]:
    try:
        base_url = await tts_mgr.ensure_running(store.get_settings())
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500, str(e))
    return {"base_url": base_url, "healthy": True, **tts_mgr.status()}


@app.post("/tts/stop")
async def tts_stop() -> dict[str, Any]:
    await tts_mgr.stop_async()
    return {"stopped": True}


@app.post("/tts/install")
async def tts_install() -> StreamingResponse:
    import json as _json

    import tts_installer

    engine = _tts_engine()
    if tts_mgr.status()["spawned"]:
        raise HTTPException(409, "TTS サーバーが起動中です。停止してからインストールしてください。")

    async def stream():
        try:
            async for progress in tts_installer.install(engine):
                yield f"data: {_json.dumps(progress, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            yield f"data: {_json.dumps({'phase': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/tts/uninstall")
async def tts_uninstall() -> dict[str, Any]:
    import tts_installer

    engine = _tts_engine()
    if tts_mgr.status()["spawned"]:
        raise HTTPException(409, "TTS サーバーが起動中です。停止してから削除してください。")
    try:
        await asyncio.to_thread(tts_installer.uninstall, engine["id"])
    except (RuntimeError, OSError) as e:
        raise HTTPException(500, str(e))
    return await asyncio.to_thread(tts_installer.status, engine["id"])


def _render_or_404(render_id: str) -> dict[str, Any]:
    render = store.get_render(render_id)
    if render is None:
        raise HTTPException(404, "render not found")
    return render


@app.get("/renders/{render_id}/voice_script")
async def render_voice_script(render_id: str) -> dict[str, Any]:
    """読み上げに使う朗読台本。保存があればそれ、無ければ規則ベースで作り、同じシーンの前の清書の
    台本から同じ文の行を引き継ぐ(このときは保存しない)。"""
    import voice

    render = _render_or_404(render_id)
    return {"render_id": render_id, **voice.resolve_script(store, render)}


class VoiceScriptIn(BaseModel):
    lines: list[dict[str, Any]]


@app.put("/renders/{render_id}/voice_script")
async def save_render_voice_script(render_id: str, body: VoiceScriptIn) -> dict[str, Any]:
    """作者が直した台本を保存する。source(LLM で付けたか)は保存済みのものを引き継ぐ。"""
    import voice

    render = _render_or_404(render_id)
    try:
        lines = voice.normalize_lines(body.lines)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not lines:
        raise HTTPException(400, "読む行が 1 つもありません")
    current = store.get_voice_script(render_id)
    store.save_voice_script(render_id, render["node_id"], lines, current["source"] if current else "rule")
    _schedule_audio_gc()  # 直す前の行の音声は使われなくなる
    return {"render_id": render_id, **voice.resolve_script(store, render)}


@app.post("/renders/{render_id}/voice_script/reset")
async def reset_render_voice_script(render_id: str) -> dict[str, Any]:
    """清書から規則ベースで作り直して保存する(話者・感情・手直しを捨てる)。削除ではなく保存にするのは、
    保存が無いと前の清書の台本から引き継いでしまい、やり直しにならないため。"""
    import voice

    render = _render_or_404(render_id)
    lines = voice.build_script(render.get("prose") or "")
    store.save_voice_script(render_id, render["node_id"], lines, "rule")
    _schedule_audio_gc()
    return {"render_id": render_id, **voice.resolve_script(store, render)}


class VoiceAnnotateIn(BaseModel):
    # 画面で直しかけの台本(保存前)にそのまま付けたいときに渡す。省略時は読み上げに使う台本
    lines: list[dict[str, Any]] | None = None


@app.post("/renders/{render_id}/voice_script/annotate")
async def annotate_render_voice_script(render_id: str, body: VoiceAnnotateIn | None = None) -> dict[str, Any]:
    """LLM で台詞の話者と各行の感情・強さを付けて保存する。作者が直した行(edited)には触らない。"""
    import voice

    render = _render_or_404(render_id)
    try:
        lines = voice.normalize_lines(body.lines) if body and body.lines else voice.resolve_script(store, render)["lines"]
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not lines:
        raise HTTPException(400, "読む行が 1 つもありません")
    try:
        base_url = await llama.ensure_running(store.get_settings())
        annotated = await voice.annotate_script(store, render, lines, base_url)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    store.save_voice_script(render_id, render["node_id"], annotated, "llm")
    _schedule_audio_gc()
    # 一人称なら地の文の話者を視点人物にした形で返す(読み上げと同じ見え方)
    return {"render_id": render_id, **voice.resolve_script(store, render)}


class TtsLineIn(BaseModel):
    text: str
    kind: str | None = None
    speaker: str | None = None
    emotion: str | None = None
    intensity: float | None = None
    # この声で読む(声の試し読み用)。省略時は話者から決める(キャラの声 → 語り手の声)
    profile_id: str | None = None
    effect: str | None = None  # 効果音の行(gasp など。voice.EFFECTS)


@app.post("/tts/speak")
async def tts_speak(body: TtsLineIn) -> FileResponse:
    """台本の 1 行を合成して音声を返す。キャッシュ(assets/audio)にあれば合成しない。
    TTS サーバーが止まっていれば起動する(初回はモデルの取得で数分かかることがある)。"""
    import voice

    if not body.text.strip():
        raise HTTPException(400, "読む文字がありません")
    settings = store.get_settings()
    engine = _tts_engine()
    line = body.model_dump(exclude={"profile_id"}, exclude_none=True)
    try:
        book = voice.VoiceBook(store, settings)
        base_url = await tts_mgr.ensure_running(settings)
        path = await voice.speak(book, engine, line, base_url, _audio_dir(), body.profile_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    if path is None:
        # エンジンが鳴らせない効果音の行。フロントは鳴らさずに間だけ置く
        from fastapi.responses import Response

        return Response(status_code=204)  # type: ignore[return-value]
    media = {"wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac", "opus": "audio/ogg", "aac": "audio/aac"}
    return FileResponse(str(path), media_type=media.get(path.suffix.lstrip("."), "application/octet-stream"))


class ChatLinesIn(BaseModel):
    text: str
    char_id: str | None = None
    mode: str | None = None  # interview | roleplay(キャラモードのとき)


@app.post("/tts/chat_lines")
async def tts_chat_lines(body: ChatLinesIn) -> dict[str, Any]:
    """チャットの返答(の一部)を読み上げの行にする(docs/design/voice.md §6.1)。
    返答はストリーミングで届くので、フロントが文の切れ目ごとに呼ぶ。保存はしない。"""
    import voice

    chat_profile = (store.get_settings().get("tts_chat_profile") or "").strip() or None
    return {"lines": voice.chat_lines(body.text, body.char_id, body.mode, chat_profile)}


# ---- 読み上げの声(docs/design/voice.md §5) ----------------------------

ALLOWED_VOICE_EXTS = {".wav", ".mp3", ".flac", ".ogg"}
MAX_VOICE_BYTES = 30 * 1024 * 1024


class VoiceProfileIn(BaseModel):
    name: str | None = None
    caption: str | None = None
    seed: int | None = None
    preset: str | None = None
    params: dict[str, Any] | None = None
    ref_paths: list[str] | None = None  # 並べ替え・取り外し用(取り込みは /refs)


def _voice_profile_or_404(profile_id: str) -> dict[str, Any]:
    profile = store.get_voice_profile(profile_id)
    if profile is None:
        raise HTTPException(404, "voice profile not found")
    return profile


@app.get("/voice_profiles")
async def list_voice_profiles() -> dict[str, Any]:
    """声の一覧と、語り手・キャラへの割り当て。"""
    return {
        "profiles": store.list_voice_profiles(),
        "narrator_profile_id": (store.get_settings().get("tts_narrator_profile") or None),
        "chat_profile_id": (store.get_settings().get("tts_chat_profile") or None),
        "assignments": {c["id"]: c.get("voice_profile_id") for c in store.list_characters() if c.get("voice_profile_id")},
    }


@app.post("/voice_profiles")
async def create_voice_profile(body: VoiceProfileIn) -> dict[str, Any]:
    return store.create_voice_profile(body.model_dump(exclude_unset=True))


@app.patch("/voice_profiles/{profile_id}")
async def update_voice_profile(profile_id: str, body: VoiceProfileIn) -> dict[str, Any]:
    profile = _voice_profile_or_404(profile_id)
    patch = body.model_dump(exclude_unset=True)
    if "ref_paths" in patch:
        # 取り外しと並べ替えだけを受け付ける(知らないファイル名を足させない)
        known = set(profile["ref_paths"])
        patch["ref_paths"] = [p for p in patch["ref_paths"] or [] if p in known]
    updated = store.update_voice_profile(profile_id, patch)
    _schedule_audio_gc()  # 声を変えると、前の声で作った音声は使われなくなる
    return updated  # type: ignore[return-value]


@app.delete("/voice_profiles/{profile_id}")
async def delete_voice_profile(profile_id: str) -> dict[str, str]:
    _voice_profile_or_404(profile_id)
    store.delete_voice_profile(profile_id)
    _schedule_audio_gc()
    return {"status": "deleted"}


@app.post("/voice_profiles/{profile_id}/refs")
async def add_voice_ref(profile_id: str, file: UploadFile) -> dict[str, Any]:
    """参照音声を取り込み(ライブラリの assets/voices へ)、声の末尾に足す。"""
    import uuid
    from pathlib import Path as _Path

    profile = _voice_profile_or_404(profile_id)
    voices = store.voices_dir()
    if voices is None:
        raise HTTPException(500, "ライブラリが未設定です")
    ext = _Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_VOICE_EXTS:
        raise HTTPException(400, f"対応していない形式です: {ext or '(拡張子なし)'}(wav / mp3 / flac / ogg)")
    data = bytearray()
    while chunk := await file.read(1 << 20):
        data.extend(chunk)
        if len(data) > MAX_VOICE_BYTES:
            raise HTTPException(400, f"{MAX_VOICE_BYTES // (1024 * 1024)}MB を超える音声は取り込めません")
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    await asyncio.to_thread((_Path(voices) / name).write_bytes, bytes(data))
    updated = store.update_voice_profile(profile_id, {"ref_paths": [*profile["ref_paths"], name]})
    _schedule_audio_gc()
    return updated  # type: ignore[return-value]


class VoiceSampleIn(BaseModel):
    text: str
    kind: str | None = None  # narration | dialogue(試し読みと同じ読み方にする)


@app.post("/voice_profiles/{profile_id}/refs/from_sample")
async def add_voice_ref_from_sample(profile_id: str, body: VoiceSampleIn) -> dict[str, Any]:
    """いまの声で試し読みした音声を、その声の参照音声にする(声色を固定する。docs/design/voice.md §5)。

    試し読みと同じリクエスト(同じ文・同じ seed)を、形式だけ wav にして合成し直して取り込む。
    キャッシュの opus をそのまま使わないのは、TTS サーバーが参照音声として opus を読めるとは限らないため。"""
    import uuid
    from pathlib import Path as _Path

    import tts
    import voice

    profile = _voice_profile_or_404(profile_id)
    voices = store.voices_dir()
    if voices is None:
        raise HTTPException(500, "ライブラリが未設定です")
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "読む文字がありません")
    line = {"text": text, "kind": "dialogue" if body.kind == "dialogue" else "narration", "speaker": "narrator"}
    settings = store.get_settings()
    engine = _tts_engine()
    try:
        book = voice.VoiceBook(store, settings)
        audio = book.line_audio(engine, line, profile_id)
        if audio is None:
            raise HTTPException(400, "この文は参照音声にできません")
        _, request_body = audio
        request_body["response_format"] = "wav"
        base_url = await tts_mgr.ensure_running(settings)
        data = await tts.synthesize(base_url, request_body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    name = f"{uuid.uuid4().hex[:12]}.wav"
    await asyncio.to_thread((_Path(voices) / name).write_bytes, data)
    updated = store.update_voice_profile(profile_id, {"ref_paths": [*profile["ref_paths"], name]})
    _schedule_audio_gc()  # 声が変わるので、前の声で作った音声は使われなくなる
    return updated  # type: ignore[return-value]


@app.get("/voices/{filename}")
async def get_voice_file(filename: str) -> FileResponse:
    """参照音声の再生用。"""
    from pathlib import Path as _Path

    voices = store.voices_dir()
    path = _Path(voices) / _Path(filename).name if voices else None  # パストラバーサル防止
    if path is None or not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(str(path), headers={"Access-Control-Allow-Origin": "*"})


@app.post("/characters/{char_id}/voice_caption")
async def draft_character_voice_caption(char_id: str) -> dict[str, str]:
    """キャラの資料から声の説明の下書きを LLM で作る(保存はしない)。"""
    import voice

    char = store.get_character(char_id)
    if char is None:
        raise HTTPException(404, "character not found")
    try:
        base_url = await llama.ensure_running(store.get_settings())
        return {"caption": await voice.draft_caption(char, base_url)}
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.post("/tts/cache/clear")
async def tts_cache_clear() -> dict[str, Any]:
    import voice

    audio = _audio_dir()
    removed = await asyncio.to_thread(voice.clear_cache, audio)
    return {"removed": removed, **(await asyncio.to_thread(voice.cache_status, audio))}


class RefImagePromptIn(BaseModel):
    instructions: str | None = None  # 作者の追加指示(日本語可)。LLM に渡して英語プロンプトへ織り込む


@app.post("/characters/{char_id}/ref_image/prompt")
async def character_ref_image_prompt(char_id: str, body: RefImagePromptIn | None = None) -> StreamingResponse:
    """外見・プロフィール(+ 追加指示)から、参照画像の英語プロンプト(人物描写)を LLM でストリーミング生成する。
    SSE: {meta:{suffix}} → {delta}… → {done, prompt} / {error}。保存はしない。"""
    import image_gen

    char = store.get_character(char_id)
    if char is None:
        raise HTTPException(404, "character not found")
    instructions = body.instructions if body else None

    async def stream():
        yield image_gen._sse({"meta": {"suffix": image_gen.REF_IMAGE_SUFFIX}})
        try:
            base_url = await llama.ensure_running(store.get_settings())
        except Exception as e:
            yield image_gen._sse({"error": str(e)})
            return
        async for chunk in image_gen.stream_character_prompt(char, base_url=base_url, instructions=instructions):
            yield chunk

    return StreamingResponse(stream(), media_type="text/event-stream")


class RefImageGenerateIn(BaseModel):
    prompt: str
    seed: int | None = None
    instructions: str | None = None  # 生成に使った追加指示(プロンプト・seed と 1 セットで保存する)
    workflow: str | None = None  # workflows/variants.json の id(None = 既定)


@app.get("/comfy/workflows")
async def comfy_workflows() -> dict[str, Any]:
    """生成ウインドウで選べるワークフローの組(workflows/variants.json)。"""
    import comfy

    return {"variants": [{"id": v["id"], "label": v.get("label") or v["id"]} for v in comfy.list_variants()]}


@app.post("/characters/{char_id}/ref_image/generate")
async def character_ref_image_generate(char_id: str, body: RefImageGenerateIn) -> dict[str, Any]:
    """ComfyUI で参照画像を生成し、assets に**候補として**保存する(ストックにもキャラにも入れない)。

    採用は UI の「決定」→ POST /media(生成に使ったセット付き、select)。不採用の候補は参照が
    無いので gc_assets が回収する。使ったプロンプト・追加指示・seed はキャラの生成ウインドウの
    保存状態に 1 セットで写し(再現用)、戻り値にも含める(「決定」がそのままストックへ渡す)。"""
    import uuid
    from pathlib import Path as _Path

    import comfy
    import image_gen

    char = store.get_character(char_id)
    if char is None:
        raise HTTPException(404, "character not found")
    assets = store.assets_dir()
    if assets is None:
        raise HTTPException(500, "ライブラリが未設定です")
    if not body.prompt.strip():
        raise HTTPException(400, "プロンプトが空です")
    settings = store.get_settings()
    try:
        base_url = await comfy_mgr.ensure_running(settings)
        data, seed = await image_gen.generate_character_image(
            settings, body.prompt, comfy_base_url=base_url, seed=body.seed, variant=body.workflow
        )
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    name = f"{uuid.uuid4().hex[:12]}.png"
    await asyncio.to_thread((_Path(assets) / name).write_bytes, data)
    instructions = (body.instructions or "").strip() or None
    workflow = comfy.get_variant(body.workflow)["id"]
    store.update_character(
        char_id,
        {
            "ref_image_prompt": body.prompt, "ref_image_instructions": instructions,
            "ref_image_seed": seed, "ref_image_workflow": workflow,
        },
    )
    return {
        "image_path": name, "seed": seed, "prompt": body.prompt, "instructions": instructions,
        "ref_chars": None, "workflow": workflow,
    }


def _scene_context(node_id: str) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    """場面画像用の (node, cast のキャラ(cast 順), 実効ロケーションの場所)。"""
    node = store.get_node(node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    chars = []
    for cid in node.get("cast") or []:
        c = store.get_character(cid)
        if c:
            chars.append(c)
    place_id, _ = store.effective_location(node_id)
    place = store.get_place(place_id) if place_id else None
    return node, chars, place


class SceneImagePromptIn(BaseModel):
    # 参照画像として使うキャラ(cast 順、最大 3 人)。省略時は参照画像のあるキャラを cast 順に自動選択
    char_ids: list[str] | None = None
    instructions: str | None = None  # 作者の追加指示(日本語可)


@app.post("/nodes/{node_id}/image/prompt")
async def node_image_prompt(node_id: str, body: SceneImagePromptIn) -> StreamingResponse:
    """ビート・場所・cast から場面の英語プロンプトを LLM でストリーミング生成する(保存はしない)。
    SSE: {meta:{suffix, refs, cast}} → {delta}… → {done, prompt} / {error}。
    参照画像を渡すキャラは meta.refs に image1.. のラベルで入る。"""
    import image_gen

    node, chars, place = _scene_context(node_id)
    if body.char_ids is not None:
        refs = [c for c in chars if c["id"] in set(body.char_ids) and c.get("ref_image_path")][: image_gen.MAX_SCENE_REFS]
    else:
        refs = image_gen.select_scene_refs(chars)
    meta = {
        "suffix": image_gen.SCENE_SUFFIX,
        "refs": [{"char_id": c["id"], "name": c["name"], "label": f"image{i + 1}"} for i, c in enumerate(refs)],
        "cast": [{"char_id": c["id"], "name": c["name"], "has_ref": bool(c.get("ref_image_path"))} for c in chars],
    }

    async def stream():
        yield image_gen._sse({"meta": meta})
        try:
            base_url = await llama.ensure_running(store.get_settings())
        except Exception as e:
            yield image_gen._sse({"error": str(e)})
            return
        async for chunk in image_gen.stream_scene_prompt(
            node, chars, refs, place, base_url=base_url, instructions=body.instructions
        ):
            yield chunk

    return StreamingResponse(stream(), media_type="text/event-stream")


class SceneImageGenIn(BaseModel):
    prompt: str | None = None
    instructions: str | None = None
    seed: int | None = None
    ref_chars: list[str] | None = None


@app.post("/nodes/{node_id}/image_gen")
async def node_image_gen_save(node_id: str, body: SceneImageGenIn) -> dict[str, Any]:
    """場面の挿絵の生成ウインドウの状態を保存する(次に開いたとき復元。挿絵そのものは変えない)。"""
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    store.set_node_image_gen(
        node_id, prompt=body.prompt, instructions=body.instructions, seed=body.seed, ref_chars=body.ref_chars
    )
    return {"ok": True}


class SceneImageGenerateIn(BaseModel):
    prompt: str
    char_ids: list[str] = Field(default_factory=list)
    seed: int | None = None
    instructions: str | None = None  # 生成に使った追加指示(プロンプト・seed・参照キャラと 1 セットで保存する)
    workflow: str | None = None  # workflows/variants.json の id(None = 既定)


@app.post("/nodes/{node_id}/image/generate")
async def node_image_generate(node_id: str, body: SceneImageGenerateIn) -> dict[str, Any]:
    """場面の挿絵を ComfyUI で生成し、assets に**候補として**保存する(ストックにも挿絵にも入れない)。
    採用は UI の「決定」→ POST /media(生成に使ったセット付き、select)。不採用の候補は gc_assets が回収する。
    使ったプロンプト・追加指示・seed・参照キャラはシーンの生成ウインドウの保存状態に 1 セットで写し
    (再現用)、戻り値にも含める(「決定」がそのままストックへ渡す)。"""
    import uuid
    from pathlib import Path as _Path

    import comfy
    import image_gen

    _node, chars, _place = _scene_context(node_id)
    assets = store.assets_dir()
    if assets is None:
        raise HTTPException(500, "ライブラリが未設定です")
    if not body.prompt.strip():
        raise HTTPException(400, "プロンプトが空です")
    wanted = set(body.char_ids)
    refs = [c for c in chars if c["id"] in wanted and c.get("ref_image_path")][: image_gen.MAX_SCENE_REFS]
    ref_files: list[tuple[str, bytes]] = []
    for c in refs:
        p = _Path(assets) / _Path(c["ref_image_path"]).name
        if not p.exists():
            raise HTTPException(400, f"{c['name']} の参照画像ファイルが見つかりません")
        ref_files.append((p.name, await asyncio.to_thread(p.read_bytes)))
    settings = store.get_settings()
    try:
        base_url = await comfy_mgr.ensure_running(settings)
        data, seed = await image_gen.generate_scene_image(
            settings, body.prompt, ref_files, comfy_base_url=base_url, seed=body.seed, variant=body.workflow
        )
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    name = f"{uuid.uuid4().hex[:12]}.png"
    await asyncio.to_thread((_Path(assets) / name).write_bytes, data)
    instructions = (body.instructions or "").strip() or None
    workflow = comfy.get_variant(body.workflow)["id"]
    store.set_node_image_gen(
        node_id, prompt=body.prompt, instructions=instructions, seed=seed, ref_chars=body.char_ids, workflow=workflow
    )
    return {
        "image_path": name, "seed": seed, "prompt": body.prompt, "instructions": instructions,
        "ref_chars": body.char_ids, "workflow": workflow,
    }


def _sse_error_response(message: str) -> StreamingResponse:
    """SSE を返す前段(llama 起動など)で失敗したとき、1 件の error イベントだけを流す。

    except 節の中でジェネレータを定義して ``e`` を参照すると、ジェネレータが走る時点では
    Python が ``e`` を削除済みで NameError になる(メッセージがクライアントに届かない)。
    メッセージを先に文字列へ写して閉じ込める。
    """

    async def error_stream():
        yield generation._sse({"error": message})

    return StreamingResponse(error_stream(), media_type="text/event-stream")


@app.post("/generate/beat")
async def generate_beat(body: GenerateBeatIn) -> StreamingResponse:
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except Exception as e:
        return _sse_error_response(str(e))
    return StreamingResponse(
        generation.generate_beat_stream(
            store, base_url, body.instruction, parent_id=body.parent_id, after_id=body.after_id
        ),
        media_type="text/event-stream",
    )


class SuggestFieldIn(BaseModel):
    beat: str
    field: str  # title | emotional_core


class ProofreadIn(BaseModel):
    text: str
    preset_id: str
    context_before: str = ""
    context_after: str = ""


@app.get("/proofread/presets")
async def list_proofread_presets() -> list[dict[str, str]]:
    return generation.proofread_presets(store)


@app.post("/proofread")
async def proofread(body: ProofreadIn) -> dict[str, str]:
    if not body.text.strip():
        raise HTTPException(400, "文章が空です")
    try:
        base_url = await llama.ensure_running(store.get_settings())
        value = await generation.proofread(
            store, base_url, body.text, body.preset_id, body.context_before, body.context_after
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"value": value}


@app.post("/proofread/stream")
async def proofread_stream(body: ProofreadIn) -> StreamingResponse:
    if not body.text.strip():
        raise HTTPException(400, "文章が空です")
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except Exception as e:
        return _sse_error_response(str(e))
    return StreamingResponse(
        generation.proofread_stream(
            store, base_url, body.text, body.preset_id, body.context_before, body.context_after
        ),
        media_type="text/event-stream",
    )


@app.post("/suggest/scene_meta")
async def suggest_scene_meta(body: SuggestFieldIn) -> dict[str, str]:
    if not body.beat.strip():
        raise HTTPException(400, "シーン本文が空です")
    try:
        base_url = await llama.ensure_running(store.get_settings())
        value = await generation.suggest_field(base_url, body.beat, body.field)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"value": value}


@app.post("/nodes/{node_id}/extract_events")
async def extract_events(node_id: str) -> dict[str, Any]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    await snapshots.auto(store, "イベント作り直しの前", 60)
    try:
        base_url = await llama.ensure_running(store.get_settings())
        events = await generation.extract_events(store, base_url, node_id)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"events": events, "validation": store.validate(node_id)}


class ReextractIn(BaseModel):
    node_ids: list[str]
    include_downstream: bool = False  # 選択したノードの下流も対象にする
    keep_user_events: bool = True


@app.post("/nodes/reextract")
async def reextract_nodes(body: ReextractIn) -> StreamingResponse:
    """選択した複数シーンのイベントを抽出し直す(親から順に逐次、SSE)。"""
    if not body.node_ids:
        raise HTTPException(400, "node_ids が空です")
    await snapshots.auto(store, "イベント作り直しの前", 60)
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return StreamingResponse(
        generation.reextract_nodes(
            store, base_url, body.node_ids, body.include_downstream, body.keep_user_events
        ),
        media_type="text/event-stream",
    )


@app.post("/nodes/{node_id}/reextract_chain")
async def reextract_chain(node_id: str, keep_user_events: bool = True) -> StreamingResponse:
    """このシーン以下の部分木を、親から順にイベント抽出し直す(SSE)。
    島を繋いだ直後など、上流の状態が変わったときに使う。"""
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    await snapshots.auto(store, "イベント作り直しの前", 60)
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return StreamingResponse(
        generation.reextract_chain(store, base_url, node_id, keep_user_events),
        media_type="text/event-stream",
    )


# ---- レンダリング(鑑賞モード) --------------------------------------

class PresetIn(BaseModel):
    id: str | None = None
    name: str
    person: str = "third"
    tone: str = ""
    params: str = "{}"


class RenderIn(BaseModel):
    preset_id: str
    pov_char: str | None = None
    from_node: str | None = None
    mode: str = "to_end"  # single | to_end
    # 構造モードの一括清書用。指定するとこのシーンだけを対象にする
    # (順序は正史・深さ順に並べ替える。前のシーンの散文に接続するため)
    node_ids: list[str] | None = None
    skip_existing: bool = False  # 既に清書済み(stale でない)シーンを飛ばす
    # 1 シーンあたりの目安の字数(None / 0 なら指定なし)。プロンプトの分量指示と
    # max_tokens の両方に効く
    target_chars: int | None = None


@app.get("/presets")
async def list_presets() -> list[dict[str, Any]]:
    return store.list_presets()


@app.post("/presets")
async def upsert_preset(body: PresetIn) -> dict[str, Any]:
    try:
        return store.upsert_preset(body.model_dump())
    except PermissionError as e:
        raise HTTPException(403, str(e))


@app.delete("/presets/{preset_id}")
async def delete_preset(preset_id: str) -> dict[str, str]:
    try:
        store.delete_preset(preset_id)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"status": "deleted"}


@app.get("/renders")
async def list_renders(
    preset_id: str, pov_char: str | None = None, group_id: str | None = None
) -> list[dict[str, Any]]:
    """正史パスのシーン一覧。group_id を渡すとその章だけ(島・分岐の章でも読める)。"""
    return store.list_renders(preset_id, pov_char, group_id)


@app.get("/renders/{node_id}")
async def get_render(node_id: str, preset_id: str, pov_char: str | None = None) -> dict[str, Any]:
    """単一シーンの最新清書(構造モードの清書タブ用)。

    /renders と違って正史パスに限らないので、分岐や島のシーンでも取れる。
    """
    return {"render": store.latest_render(node_id, preset_id, pov_char or None)}


@app.post("/render")
async def render(body: RenderIn) -> StreamingResponse:
    canon = store.canon_path()
    if body.node_ids is not None:
        # 一括清書: 前のシーンの散文に接続するので、必ず時系列順に並べ替える
        node_ids = sorted(
            dict.fromkeys(body.node_ids),
            key=lambda nid: (canon.index(nid) if nid in canon else len(canon) + len(store.path_to(nid))),
        )
        if body.skip_existing:
            node_ids = [
                nid
                for nid in node_ids
                if (r := store.latest_render(nid, body.preset_id, body.pov_char)) is None or r["stale"]
            ]
        if not node_ids:
            async def empty_stream():
                yield rendering._sse({"done": True, "skipped": True})
            return StreamingResponse(empty_stream(), media_type="text/event-stream")
    else:
        if not canon:
            raise HTTPException(409, "正史パスにシーンがありません")
        start = body.from_node or canon[0]
        if start not in canon:
            raise HTTPException(404, "from_node が正史パス上にありません")
        node_ids = [start] if body.mode == "single" else canon[canon.index(start):]
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except Exception as e:
        return _sse_error_response(str(e))
    async def stream():
        try:
            async for chunk in rendering.render_stream(
                store, base_url, node_ids, body.preset_id, body.pov_char, body.target_chars
            ):
                yield chunk
        finally:
            # 上書きされた清書の読み上げ音声を消す(変わらなかった文の音声は使い回すので残る)
            _schedule_audio_gc()

    return StreamingResponse(stream(), media_type="text/event-stream")


# ---- 相談チャット ---------------------------------------------------

class ChatSendIn(BaseModel):
    chat_id: str | None = None
    anchor_node: str | None = None
    scope: str = "upto"  # upto | all
    message: str
    char_id: str | None = None  # 設定時は「キャラクターと話す」モード
    mode: str = "interview"  # interview | roleplay(char_id 設定時のみ意味を持つ)
    # 編集・再生成用。指定すると履歴をこの位置まで巻き戻してから送る
    replace_from: int | None = None


@app.get("/chats")
async def list_chats() -> list[dict[str, Any]]:
    return store.list_chats()


@app.get("/chats/{chat_id}")
async def get_chat(chat_id: str) -> dict[str, Any]:
    chat = store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(404, "chat not found")
    return chat


class ChatPatchIn(BaseModel):
    title: str | None = None


@app.patch("/chats/{chat_id}")
async def patch_chat(chat_id: str, body: ChatPatchIn) -> dict[str, Any]:
    """会話名の変更(空なら冒頭の発言を見出しに使う)。"""
    chat = store.set_chat_title(chat_id, body.title)
    if chat is None:
        raise HTTPException(404, "chat not found")
    return chat


@app.delete("/chats/{chat_id}/turn/{index}")
async def delete_chat_turn(chat_id: str, index: int, keep_user: bool = False) -> dict[str, Any]:
    """1 往復を履歴から削除する。keep_user=true なら返事だけを消す。"""
    chat = store.delete_chat_turn(chat_id, index, keep_user)
    if chat is None:
        raise HTTPException(404, "chat or message not found")
    return chat


@app.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str) -> dict[str, str]:
    store.delete_chat(chat_id)
    return {"status": "deleted"}


@app.post("/chat/send")
async def chat_send(body: ChatSendIn) -> StreamingResponse:
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except Exception as e:
        return _sse_error_response(str(e))
    anchor = body.anchor_node
    if anchor is None:
        canon = store.canon_path()
        anchor = canon[-1] if canon else None
    return StreamingResponse(
        chat_agent.chat_stream(
            store,
            base_url,
            body.chat_id,
            anchor,
            body.scope,
            body.message,
            body.char_id,
            body.mode,
            body.replace_from,
        ),
        media_type="text/event-stream",
    )


class ChatSuggestIn(BaseModel):
    chat_id: str | None = None
    anchor_node: str | None = None
    scope: str = "upto"
    char_id: str | None = None  # token_usage 用(キャラモードの新規チャット)
    mode: str = "interview"


@app.post("/chat/token_usage")
async def chat_token_usage(body: ChatSuggestIn) -> dict[str, Any]:
    """相談チャットのコンテキスト使用量。ctx_size は設定値(llama-server の
    --ctx-size に渡している値)。サーバー未起動時は文字数からの概算を返す。"""
    settings = store.get_settings()
    base_url = settings.get("llm_base_url") or llm.DEFAULT_BASE_URL
    anchor = body.anchor_node
    if anchor is None:
        canon = store.canon_path()
        anchor = canon[-1] if canon else None
    usage = await chat_agent.token_usage(
        store, base_url, body.chat_id, anchor, body.scope, body.char_id, body.mode
    )
    return {**usage, "ctx_size": int(settings.get("llm_ctx_size") or 16384)}


@app.post("/chat/suggest_questions")
async def chat_suggest_questions(body: ChatSuggestIn) -> dict[str, Any]:
    """内容ベースの質問候補。設定が無効、LLM 未起動、生成失敗のときは空を返す
    (UI 側は固定の候補を出したままにするので、失敗をエラーとして扱わない)。"""
    settings = store.get_settings()
    if settings.get("chat_dynamic_suggestions") == "0":
        return {"questions": []}
    base_url = settings.get("llm_base_url") or llm.DEFAULT_BASE_URL
    if not await llm.health(base_url):
        return {"questions": []}
    anchor = body.anchor_node
    if anchor is None:
        canon = store.canon_path()
        anchor = canon[-1] if canon else None
    try:
        questions = await chat_agent.suggest_questions(store, base_url, body.chat_id, anchor, body.scope)
    except Exception:  # noqa: BLE001
        return {"questions": []}
    return {"questions": questions}


# ---- スナップショット(バックアップ) --------------------------------

class SnapshotIn(BaseModel):
    label: str = ""


@app.get("/snapshots")
async def list_snapshots() -> dict[str, Any]:
    return {"snapshots": snapshots.list_snapshots(store)}


@app.post("/snapshots")
async def create_snapshot(body: SnapshotIn) -> dict[str, Any]:
    try:
        return await snapshots.create_async(store, body.label, kind="manual")
    except RuntimeError as e:
        raise HTTPException(400, str(e))


@app.post("/snapshots/{snap_id}/restore")
async def restore_snapshot(snap_id: str) -> dict[str, Any]:
    """スナップショットの時点に戻す。成功したらフロントはリロードする。"""
    try:
        snapshots.restore(store, snap_id)
    except KeyError:
        raise HTTPException(404, "snapshot not found")
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    _schedule_audio_gc()  # 戻した時点の清書で使う音声だけを残す(消した分は読むときに作り直す)
    return {"restored": snap_id, "root": store.root}


@app.delete("/snapshots/{snap_id}")
async def delete_snapshot(snap_id: str) -> dict[str, str]:
    if not snapshots.delete(store, snap_id):
        raise HTTPException(404, "snapshot not found")
    return {"status": "deleted"}


# ---- 外部バックアップ(zip 書き出し。docs/design/backup.md) ----------

class BackupExportIn(BaseModel):
    path: str
    include_snapshots: bool = False


class BackupConfigIn(BaseModel):
    enabled: bool | None = None
    dir: str | None = None
    keep: int | None = None
    inside: bool | None = None  # True でライブラリの中(<root>/backups/)に置く


class BackupPathIn(BaseModel):
    path: str


class BackupRestoreIn(BaseModel):
    path: str
    dest_root: str


# 自動バックアップの多重起動を防ぐ(起動直後の遅延実行とライブラリ切替が重なりうる)
_backup_lock = asyncio.Lock()


async def _write_backup(dest: str, *, include_snapshots: bool, kind: str) -> dict[str, Any]:
    """DB のコピーはループ上で、zip 書き出しはスレッドで(設計 §書き出しの実装)。"""
    root = str(store.root)  # 書き出し中のライブラリ切替で assets の出所がずれないよう控える
    db_copy = backup.prepare_db(store)
    try:
        return await asyncio.to_thread(
            backup.write_zip,
            db_copy,
            root,
            dest,
            include_snapshots=include_snapshots,
            kind=kind,
        )
    finally:
        backup.cleanup(db_copy)


async def _run_auto_backup(force: bool = False) -> dict[str, Any]:
    async with _backup_lock:
        root = store.root
        plan = backup.plan_auto(store, force=force)
        if plan is None:
            return {"skipped": True, "config": backup.get_config(store)}
        result = await _write_backup(plan["dest"], include_snapshots=False, kind="auto")
        if store.root != root:
            # zip 書き出し中にライブラリが切り替わった。settings への記録は今の
            # (別の)ライブラリに落ちてしまうので諦める(元のライブラリは次回の
            # 契機で撮り直される)。古い zip の整理だけは plan の対象で行う
            removed = backup.rotate(plan["dir"], plan["name"], plan["keep"])
        else:
            removed = backup.record_auto(store, plan, result)
    return {"skipped": False, "removed": removed, **result, "config": backup.get_config(store)}


async def _auto_backup_quietly() -> None:
    """失敗してもアプリは止めない(保存先が外付けで未接続、などが普通に起こる)。"""
    try:
        result = await _run_auto_backup()
        if not result.get("skipped"):
            print(f"[backup] 自動バックアップを保存しました: {result['path']}")
    except Exception as e:  # noqa: BLE001
        print(f"[backup] 自動バックアップに失敗: {e}")


async def _deferred_auto_backup() -> None:
    # 再利用 sidecar ではレンダラが起動直後に /library/switch を投げてくるので、
    # 先走って別のライブラリを撮らないよう少し待つ
    await asyncio.sleep(15)
    await _auto_backup_quietly()


@app.get("/backup/config")
async def get_backup_config() -> dict[str, Any]:
    config = backup.get_config(store)
    return {**config, "entries": backup.list_backups(config["dir"])}


@app.put("/backup/config")
async def put_backup_config(body: BackupConfigIn) -> dict[str, Any]:
    config = backup.set_config(
        store, enabled=body.enabled, dir=body.dir, keep=body.keep, inside=body.inside
    )
    return {**config, "entries": backup.list_backups(config["dir"])}


@app.get("/backup/suggested_name")
async def backup_suggested_name() -> dict[str, str]:
    """保存ダイアログの既定ファイル名(ライブラリ名 + 日時)。"""
    return {"name": backup.suggested_name(store)}


@app.post("/backup/export")
async def export_backup(body: BackupExportIn) -> dict[str, Any]:
    if not store.root:
        raise HTTPException(400, "ライブラリが未設定のためバックアップできません")
    try:
        return await _write_backup(
            body.path, include_snapshots=body.include_snapshots, kind="manual"
        )
    except OSError as e:
        raise HTTPException(400, f"書き出せません: {e}")


@app.post("/backup/auto")
async def run_auto_backup(force: bool = False) -> dict[str, Any]:
    if not store.root:
        raise HTTPException(400, "ライブラリが未設定のためバックアップできません")
    try:
        return await _run_auto_backup(force=force)
    except OSError as e:
        raise HTTPException(400, f"書き出せません: {e}")


@app.post("/backup/inspect")
async def inspect_backup(body: BackupPathIn) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(backup.inspect, body.path)
    except KeyError:
        raise HTTPException(404, "バックアップが見つかりません")
    except (OSError, zipfile.BadZipFile) as e:
        raise HTTPException(400, f"読めません: {e}")


@app.post("/backup/restore")
async def restore_backup(body: BackupRestoreIn) -> dict[str, Any]:
    """新しいライブラリとして展開する。切替とリロードはフロントが行う。"""
    try:
        return await asyncio.to_thread(backup.restore, body.path, body.dest_root)
    except KeyError:
        raise HTTPException(404, "バックアップが見つかりません")
    except FileExistsError as e:
        raise HTTPException(409, str(e))
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        raise HTTPException(400, f"展開できません: {e}")


# ---- settings -------------------------------------------------------

@app.get("/settings")
async def get_settings() -> dict[str, str]:
    return store.get_settings()


@app.put("/settings")
async def put_settings(body: SettingsPut) -> dict[str, str]:
    store.set_settings(body.values)
    if any(k.startswith("tts_") for k in body.values):
        _schedule_audio_gc()  # 声やエンジンを変えると、前の設定で作った音声は使われなくなる
    return store.get_settings()
