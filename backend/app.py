"""story-graph FastAPI sidecar。

起動: .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765
      (cwd = backend/)

エンドポイントはすべて async def にしてイベントループ上で直列実行する。
ローカル単一ユーザー前提なので、これで SQLite への書き込み競合を避ける。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import db
import generation
import llm
from llama_manager import LlamaManager
from store import Store

app = FastAPI(title="story-graph backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # localhost の Electron レンダラのみが相手
    allow_methods=["*"],
    allow_headers=["*"],
)

_db_path = os.environ.get("STORY_GRAPH_DB")
store = Store(db.connect(_db_path))
llama = LlamaManager()


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
    status: str = "canon"
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


# ---- health ---------------------------------------------------------

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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


@app.post("/nodes")
async def create_node(body: NodeIn) -> dict[str, Any]:
    data = body.model_dump(exclude={"events"})
    events = [e.model_dump() for e in body.events]
    node = store.append_node(data, events)
    node["validation"] = store.validate(node["id"])
    return node


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
    if not store.delete_tail_node(node_id):
        raise HTTPException(409, "Phase 1 では末尾ノードのみ削除できます")
    return {"status": "deleted"}


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


# ---- LLM / 生成 -----------------------------------------------------

class GenerateBeatIn(BaseModel):
    instruction: str | None = None


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
        generation.generate_beat_stream(store, base_url, body.instruction),
        media_type="text/event-stream",
    )


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


# ---- settings -------------------------------------------------------

@app.get("/settings")
async def get_settings() -> dict[str, str]:
    return store.get_settings()


@app.put("/settings")
async def put_settings(body: SettingsPut) -> dict[str, str]:
    store.set_settings(body.values)
    return store.get_settings()
