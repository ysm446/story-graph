"""story-graph FastAPI sidecar。

起動: .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765
      (cwd = backend/)

エンドポイントはすべて async def にしてイベントループ上で直列実行する。
ローカル単一ユーザー前提なので、これで SQLite への書き込み競合を避ける。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

import chat_agent
import db
import generation
import llm
import rendering
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


@app.on_event("startup")
async def _startup() -> None:
    # 埋め込みモデルは初回ロードが重いのでバックグラウンドで温める
    import asyncio

    import embed

    asyncio.get_event_loop().run_in_executor(None, embed.warmup)


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


class FactionIn(BaseModel):
    name: str
    description: str | None = None


class FactionPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    members: list[str] | None = None


class EventIn(BaseModel):
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
    data = body.model_dump(exclude={"events", "parent_id", "draft"})
    events = [e.model_dump() for e in body.events]
    try:
        node = store.append_node(data, events, parent_id=body.parent_id, force_draft=body.draft)
    except KeyError as e:
        raise HTTPException(404, str(e))
    node["validation"] = store.validate(node["id"])
    return node


@app.post("/nodes/{node_id}/make_canon")
async def make_canon(node_id: str) -> dict[str, Any]:
    try:
        store.make_canon(node_id)
    except KeyError:
        raise HTTPException(404, "node not found")
    return {"canon_path": store.canon_path()}


@app.get("/nodes/{node_id}")
async def get_node(node_id: str) -> dict[str, Any]:
    node = store.get_node(node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    return node


@app.patch("/nodes/{node_id}")
async def update_node(node_id: str, body: NodePatch) -> dict[str, Any]:
    node = store.update_node(node_id, body.model_dump(exclude_unset=True))
    if node is None:
        raise HTTPException(404, "node not found")
    node["validation"] = store.validate(node_id)
    return node


@app.delete("/nodes/{node_id}")
async def delete_node(node_id: str) -> dict[str, str]:
    if not store.delete_leaf_node(node_id):
        raise HTTPException(409, "子を持つノードは削除できません(先に子を削除してください)")
    return {"status": "deleted"}


class PositionIn(BaseModel):
    x: float
    y: float


class NodeImageIn(BaseModel):
    image_path: str | None = None


# ---- 画像アセット(装飾専用。LLM には渡さない) ----------------------

ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


@app.post("/assets/upload")
async def upload_asset(file: UploadFile) -> dict[str, str]:
    import uuid
    from pathlib import Path as _Path

    assets = store.assets_dir()
    if assets is None:
        raise HTTPException(500, "ライブラリが未設定です")
    ext = _Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_IMAGE_EXTS:
        raise HTTPException(400, f"対応していない画像形式です: {ext}")
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(400, "20MB を超える画像はアップロードできません")
    (_Path(assets) / name).write_bytes(data)
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


@app.post("/nodes/{node_id}/position")
async def set_node_position(node_id: str, body: PositionIn) -> dict[str, str]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    store.set_node_position(node_id, body.x, body.y)
    return {"status": "ok"}


@app.post("/layout/reset")
async def reset_layout() -> dict[str, str]:
    store.reset_positions()
    return {"status": "ok"}


@app.put("/nodes/{node_id}/events")
async def put_events(node_id: str, body: EventsPut) -> dict[str, Any]:
    if store.get_node(node_id) is None:
        raise HTTPException(404, "node not found")
    events = store.replace_events(node_id, [e.model_dump() for e in body.events])
    return {"events": events, "validation": store.validate(node_id)}


@app.get("/nodes/{node_id}/state")
async def node_state(node_id: str) -> dict[str, Any]:
    try:
        return store.get_state(node_id)
    except KeyError:
        raise HTTPException(404, "node not on canon path")
    except ValueError as e:
        raise HTTPException(422, f"fold に失敗しました(不正なイベント): {e}")


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


@app.get("/llm/status")
async def llm_status() -> dict[str, Any]:
    settings = store.get_settings()
    base_url = settings.get("llm_base_url") or llm.DEFAULT_BASE_URL
    healthy = await llm.health(base_url)
    return {"base_url": base_url, "healthy": healthy, **llama.status()}


@app.post("/llm/start")
async def llm_start() -> dict[str, Any]:
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"base_url": base_url, "healthy": True, **llama.status()}


@app.post("/llm/stop")
async def llm_stop() -> dict[str, Any]:
    llama.stop()
    return {"stopped": True}


@app.post("/generate/beat")
async def generate_beat(body: GenerateBeatIn) -> StreamingResponse:
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except RuntimeError as e:
        async def error_stream():
            yield generation._sse({"error": str(e)})
        return StreamingResponse(error_stream(), media_type="text/event-stream")
    return StreamingResponse(
        generation.generate_beat_stream(store, base_url, body.instruction, parent_id=body.parent_id),
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
    try:
        base_url = await llama.ensure_running(store.get_settings())
        events = await generation.extract_events(store, base_url, node_id)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"events": events, "validation": store.validate(node_id)}


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


class PromoteIn(BaseModel):
    selection: str


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
async def list_renders(preset_id: str, pov_char: str | None = None) -> list[dict[str, Any]]:
    return store.list_renders(preset_id, pov_char)


@app.post("/render")
async def render(body: RenderIn) -> StreamingResponse:
    canon = store.canon_path()
    if not canon:
        raise HTTPException(409, "正史パスにシーンがありません")
    start = body.from_node or canon[0]
    if start not in canon:
        raise HTTPException(404, "from_node が正史パス上にありません")
    if body.mode == "single":
        node_ids = [start]
    else:
        node_ids = canon[canon.index(start):]
    try:
        base_url = await llama.ensure_running(store.get_settings())
    except RuntimeError as e:
        async def error_stream():
            yield rendering._sse({"error": str(e)})
        return StreamingResponse(error_stream(), media_type="text/event-stream")
    return StreamingResponse(
        rendering.render_stream(store, base_url, node_ids, body.preset_id, body.pov_char),
        media_type="text/event-stream",
    )


@app.post("/nodes/{node_id}/promote_preview")
async def promote_preview(node_id: str, body: PromoteIn) -> dict[str, Any]:
    try:
        base_url = await llama.ensure_running(store.get_settings())
        return await rendering.promote_preview(store, base_url, node_id, body.selection)
    except KeyError:
        raise HTTPException(404, "node not found")
    except RuntimeError as e:
        raise HTTPException(500, str(e))


# ---- 相談チャット ---------------------------------------------------

class ChatSendIn(BaseModel):
    chat_id: str | None = None
    anchor_node: str | None = None
    scope: str = "upto"  # upto | all
    message: str


@app.get("/chats")
async def list_chats() -> list[dict[str, Any]]:
    return store.list_chats()


@app.get("/chats/{chat_id}")
async def get_chat(chat_id: str) -> dict[str, Any]:
    chat = store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(404, "chat not found")
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
        chat_agent.chat_stream(store, base_url, body.chat_id, anchor, body.scope, body.message),
        media_type="text/event-stream",
    )


# ---- settings -------------------------------------------------------

@app.get("/settings")
async def get_settings() -> dict[str, str]:
    return store.get_settings()


@app.put("/settings")
async def put_settings(body: SettingsPut) -> dict[str, str]:
    store.set_settings(body.values)
    return store.get_settings()
