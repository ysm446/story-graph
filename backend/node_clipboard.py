"""コピー時のシーンと内部接続を、別IDの独立した枝として貼り付ける。"""

from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, FiniteFloat

from node_operations import atomic_store, _check_connections


class CopiedEvent(BaseModel):
    id: str
    type: str
    source: Literal["user", "llm"] = "user"
    payload: dict[str, Any]


class CopiedNode(BaseModel):
    id: str
    kind: None = None  # はじまり・結末・章境界は複製しない
    title: str | None = None
    beat: str
    emotional_core: str | None = None
    cast: list[str] = Field(default_factory=list)
    location: str | None = None
    story_time: str | None = None
    events: list[CopiedEvent] = Field(default_factory=list)
    pos_x: FiniteFloat = 0
    pos_y: FiniteFloat = 0
    image_path: str | None = None
    thumb_path: str | None = None
    target_chars: int | None = None


class CopiedEdge(BaseModel):
    from_node: str
    to_node: str


class PasteIn(BaseModel):
    library_root: str | None
    nodes: list[CopiedNode] = Field(min_length=1)
    edges: list[CopiedEdge] = Field(default_factory=list)
    group_id: str | None = None
    x: FiniteFloat
    y: FiniteFloat


def paste(store, body: PasteIn):
    if body.library_root != store.root:
        raise ValueError("コピー元と同じライブラリで貼り付けてください")
    ids = {n.id: uuid4().hex[:12] for n in body.nodes}
    event_ids = {e.id: uuid4().hex[:12] for n in body.nodes for e in n.events}
    if len(ids) != len(body.nodes) or len(event_ids) != sum(len(n.events) for n in body.nodes):
        raise ValueError("コピー内容に重複したIDがあります")
    if any(e.from_node not in ids or e.to_node not in ids for e in body.edges):
        raise ValueError("コピー範囲外への接続は貼り付けられません")
    with atomic_store(store) as tx:
        if body.group_id and tx.get_group(body.group_id) is None:
            raise KeyError("貼り付け先の章が見つかりません")
        for n in body.nodes:
            if any(tx.get_character(cid) is None for cid in n.cast):
                raise ValueError("コピーしたシーンの登場人物が削除されています")
            if n.location and tx.get_place(n.location) is None:
                raise ValueError("コピーしたシーンの場所が削除されています")
            data = n.model_dump(include={"title", "beat", "emotional_core", "cast", "location", "story_time"})
            tx.append_node({**data, "id": ids[n.id]}, detached=True)
            tx.conn.execute(
                "UPDATE nodes SET group_id=?, pos_x=?, pos_y=?, image_path=?, thumb_path=?, target_chars=? WHERE id=?",
                (body.group_id, body.x + n.pos_x, body.y + n.pos_y, n.image_path, n.thumb_path, n.target_chars, ids[n.id]))
        for edge in body.edges:
            tx.conn.execute("INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,0)",
                            (uuid4().hex[:12], ids[edge.from_node], ids[edge.to_node]))
        _check_connections(tx.graph())
        for n in body.nodes:
            events = []
            for event in n.events:
                data = event.model_dump()
                data["id"] = event_ids[event.id]
                if event.type == "memory_compress":
                    # 元ルートの記憶を消さず、コピー範囲の記憶だけを参照する。
                    data["payload"]["replaces"] = [event_ids[eid] for eid in event.payload.get("replaces", []) if eid in event_ids]
                events.append(data)
            tx.replace_events(ids[n.id], events)
        tx._resync_canon()
        tx._resync_memory_orders(commit=False)
        if body.group_id:
            tx._mark_group_digest_stale(body.group_id)
    return {"node_ids": list(ids.values())}
