"""コピー時のシーンと内部接続を、別IDの独立した枝として貼り付ける。章の複製もここ。"""

import json
from datetime import datetime, timezone
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
    elapsed_unit: str | None = None
    elapsed_count: int | None = None
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
            data = n.model_dump(include={"title", "beat", "emotional_core", "cast", "location", "elapsed_unit", "elapsed_count"})
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


def _insert_row(conn, table: str, row: dict[str, Any]) -> None:
    cols = list(row)
    names = ",".join('"' + c + '"' for c in cols)  # cast は SQL のキーワードなので引用する
    conn.execute(
        f"INSERT INTO {table}({names}) VALUES({','.join('?' for _ in cols)})",
        [row[c] for c in cols],
    )


def duplicate_group(store, group_id: str, title: str, x: float | None = None, y: float | None = None):
    """章を丸ごと複製し、元の章と同じ親から生える別の章にする(docs/design/chapters.md「章の複製」)。

    写すのは章のシーン(分岐・島を含む)・入口 / 出口・中のつながり・イベント・清書・
    挿絵のストック・章のまとめ。入口は元の章の入口と同じ親につなぐので、前の章までの
    状態がそのまま流れ込む。出口の先(後ろの章)にはつながない。音声台本は写さない。
    挿絵のファイルは共有する(参照が残る限り gc_assets は消さない)。
    """
    title = (title or "").strip()
    if not title:
        raise ValueError("章の名前を入力してください")
    with atomic_store(store) as tx:
        group = tx.get_group(group_id)
        if group is None:
            raise KeyError(f"group not found: {group_id}")
        if not group["in_id"] or not group["out_id"]:
            raise ValueError("入口 / 出口の無い章は複製できません")
        rows = [dict(r) for r in tx.conn.execute(
            "SELECT * FROM nodes WHERE group_id = ? ORDER BY created_at", (group_id,))]
        ids = {r["id"]: uuid4().hex[:12] for r in rows}
        source_events = {
            nid: [dict(e) for e in tx.conn.execute(
                "SELECT id, type, source, payload FROM events WHERE node_id = ? ORDER BY seq", (nid,))]
            for nid in ids
        }
        event_ids = {e["id"]: uuid4().hex[:12] for events in source_events.values() for e in events}
        new_group = uuid4().hex[:12]
        now = datetime.now(timezone.utc).isoformat()
        original = tx.conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
        tx.conn.execute(
            "INSERT INTO groups(id, title, color, created_at, pos_x, pos_y, cover_node_id) VALUES(?,?,?,?,?,?,?)",
            (new_group, title, original["color"], now, x, y, ids.get(original["cover_node_id"])),
        )
        markers = {"chapter_in": f"{title} 入口", "chapter_out": f"{title} 出口"}
        for row in rows:
            _insert_row(tx.conn, "nodes", {
                **row,
                "id": ids[row["id"]],
                "group_id": new_group,
                "title": markers.get(row["kind"], row["title"]),
                "created_at": now,
                "updated_at": now,
            })
        # 章の中のつながりだけを写す。出口の先・章の外へ出る線は写さない
        for edge in tx.conn.execute("SELECT from_node, to_node FROM edges").fetchall():
            if edge["from_node"] in ids and edge["to_node"] in ids:
                tx.conn.execute("INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,0)",
                                (uuid4().hex[:12], ids[edge["from_node"]], ids[edge["to_node"]]))
        parent = tx.parent_of(group["in_id"])
        if parent is not None:
            tx.conn.execute("INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,0)",
                            (uuid4().hex[:12], parent, ids[group["in_id"]]))
        _check_connections(tx.graph())
        tx._resync_canon()

        def remap(events):
            result = []
            for event in events:
                data = {**event, "id": event_ids.get(event["id"]) or uuid4().hex[:12]}
                data["payload"] = dict(data["payload"])
                if data["type"] == "memory_compress":
                    # 章の中の記憶は複製した記憶へ。前の章の記憶は同じ親を通るので共有のまま
                    data["payload"]["replaces"] = [event_ids.get(eid, eid) for eid in data["payload"].get("replaces", [])]
                result.append(data)
            return result

        for nid, events in source_events.items():
            if events:
                tx.replace_events(ids[nid], remap(
                    [{**e, "payload": json.loads(e["payload"])} for e in events]))
        for render in tx.conn.execute(
                f"SELECT * FROM renders WHERE node_id IN ({','.join('?' for _ in ids)})", list(ids)).fetchall():
            _insert_row(tx.conn, "renders", {**dict(render), "id": uuid4().hex[:12], "node_id": ids[render["node_id"]]})
        for media in tx.conn.execute(
                f"SELECT * FROM media WHERE owner_type = 'node' AND owner_id IN ({','.join('?' for _ in ids)})",
                list(ids)).fetchall():
            _insert_row(tx.conn, "media", {**dict(media), "id": uuid4().hex[:12], "owner_id": ids[media["owner_id"]]})
        # まとめは中身が同じなので古い扱いにはしない(元の章の状態を引き継ぐ)
        if original["digest_events"]:
            digest = remap(json.loads(original["digest_events"]))
            tx.conn.execute("UPDATE groups SET digest_events = ?, digest_stale = ? WHERE id = ?",
                            (json.dumps(digest, ensure_ascii=False), original["digest_stale"], new_group))
            tx._sync_digest_memories(tx.get_group(new_group), [], digest)
        tx._resync_memory_orders(commit=False)
        return tx.get_group(new_group)
