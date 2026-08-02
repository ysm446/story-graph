"""story-graph FastAPI sidecar。

起動: .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765
      (cwd = backend/)

エンドポイントはすべて async def にしてイベントループ上で直列実行する。
ローカル単一ユーザー前提なので、これで SQLite への書き込み競合を避ける。
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

import chat_agent
import db
import generation
import llm
import rendering
import snapshots
from llama_manager import LlamaManager
from store import Store

app = FastAPI(title="story-graph backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # localhost の Electron レンダラのみが相手
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


# 書き込みメソッドの途中で例外が出ると、共有コネクションに半端な変更が残り、
# 次のリクエストの commit で意図せず確定してしまう。エラー応答時は必ず捨てる。
def _rollback_pending() -> None:
    try:
        store.conn.rollback()
    except Exception:  # noqa: BLE001
        pass


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
        removed = store.gc_assets()
        if removed:
            print(f"[assets] 未参照ファイルを {removed} 件削除しました")
    except Exception as e:  # GC の失敗で起動を止めない
        print(f"[assets] GC に失敗: {e}")


@app.on_event("shutdown")
def _shutdown() -> None:
    llama.stop()


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
    char = store.update_character(char_id, body.model_dump(exclude_unset=True))
    if char is None:
        raise HTTPException(404, "character not found")
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
    snapshots.auto(store, "正史切替の前", 0)
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
    snapshots.auto(store, "つなぎ替えの前", 60)
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
    snapshots.auto(store, "つなぎ替えの前", 60)
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
    snapshots.auto(store, "章の並べ替えの前", 60)
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
    snapshots.auto(store, "章のまとめ更新の前", 60)
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
    snapshots.auto(store, "章のまとめ更新の前", 60)
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
    snapshots.auto(store, "章のまとめ更新の前", 60)
    try:
        return store.delete_group_digest(group_id)
    except KeyError:
        raise HTTPException(404, "group not found")


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
    snapshots.auto(store, "シーン編集の前", 600)
    node = store.update_node(node_id, body.model_dump(exclude_unset=True))
    if node is None:
        raise HTTPException(404, "node not found")
    node["validation"] = store.validate(node_id)
    return node


@app.delete("/nodes/{node_id}")
async def delete_node(node_id: str) -> dict[str, str]:
    snapshots.auto(store, "シーン削除の前", 30)
    try:
        deleted = store.delete_node(node_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not deleted:
        raise HTTPException(404, "node not found")
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
    return FileResponse(str(path))


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
    snapshots.auto(store, "イベント編集の前", 600)
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
    from llama_manager import DEFAULT_MODEL_PATH

    settings = store.get_settings()
    return {
        "models": system_info.list_models(),
        "current": settings.get("llm_model_path") or DEFAULT_MODEL_PATH,
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

    return llama_installer.status()


class LlamaInstallIn(BaseModel):
    # フロントの variant をそのまま受け取る(asset_url / cudart_url / asset_name などを含む)
    variant: dict[str, Any]


@app.post("/llama/install")
async def llama_install(body: LlamaInstallIn) -> StreamingResponse:
    import json as _json

    import llama_installer

    async def stream():
        try:
            async for progress in llama_installer.install_variant(body.variant):
                yield f"data: {_json.dumps(progress, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            # クライアント切断でキャンセル。ここでの yield は届かないので何もしない
            raise
        except Exception as e:  # noqa: BLE001
            yield f"data: {_json.dumps({'phase': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/generate/beat")
async def generate_beat(body: GenerateBeatIn) -> StreamingResponse:
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except RuntimeError as e:
        async def error_stream():
            yield generation._sse({"error": str(e)})
        return StreamingResponse(error_stream(), media_type="text/event-stream")
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
    except RuntimeError as e:
        async def error_stream():
            yield generation._sse({"error": str(e)})
        return StreamingResponse(error_stream(), media_type="text/event-stream")
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
    snapshots.auto(store, "イベント作り直しの前", 60)
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
    snapshots.auto(store, "イベント作り直しの前", 60)
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
    snapshots.auto(store, "イベント作り直しの前", 60)
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
    except RuntimeError as e:
        async def error_stream():
            yield rendering._sse({"error": str(e)})
        return StreamingResponse(error_stream(), media_type="text/event-stream")
    return StreamingResponse(
        rendering.render_stream(
            store, base_url, node_ids, body.preset_id, body.pov_char, body.target_chars
        ),
        media_type="text/event-stream",
    )


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
    except RuntimeError as e:
        async def error_stream():
            yield chat_agent._sse({"error": str(e)})
        return StreamingResponse(error_stream(), media_type="text/event-stream")
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
        return snapshots.create(store, body.label, kind="manual")
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
    return {"restored": snap_id, "root": store.root}


@app.delete("/snapshots/{snap_id}")
async def delete_snapshot(snap_id: str) -> dict[str, str]:
    if not snapshots.delete(store, snap_id):
        raise HTTPException(404, "snapshot not found")
    return {"status": "deleted"}


# ---- settings -------------------------------------------------------

@app.get("/settings")
async def get_settings() -> dict[str, str]:
    return store.get_settings()


@app.put("/settings")
async def put_settings(body: SettingsPut) -> dict[str, str]:
    store.set_settings(body.values)
    return store.get_settings()
