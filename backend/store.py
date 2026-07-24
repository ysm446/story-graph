"""ストア層 — CRUD、タイムライン、state_cache、dirty 伝播。

真実は events テーブル。state_cache / memories は導出物で、いつでも再構築できる。
Phase 1 は単線タイムライン(分岐なし)のみを扱うが、edges の構造自体は DAG。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

import fold as fold_mod
from validation import validate_node


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    # ---- characters -------------------------------------------------

    def list_characters(self) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM characters ORDER BY created_at").fetchall()
        return [dict(r) for r in rows]

    def get_character(self, char_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone()
        return dict(row) if row else None

    def create_character(self, data: dict[str, Any]) -> dict[str, Any]:
        char_id = data.get("id") or _new_id()
        self.conn.execute(
            """INSERT INTO characters(id, name, profile, appearance, voice, color, created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (
                char_id,
                data["name"],
                data.get("profile"),
                data.get("appearance"),
                data.get("voice"),
                data.get("color"),
                _now(),
            ),
        )
        self.conn.commit()
        return self.get_character(char_id)  # type: ignore[return-value]

    def update_character(self, char_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        fields = ["name", "profile", "appearance", "voice", "color", "graph_x", "graph_y"]
        updates = {k: data[k] for k in fields if k in data}
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            self.conn.execute(
                f"UPDATE characters SET {sets} WHERE id = ?", (*updates.values(), char_id)
            )
            self.conn.commit()
        return self.get_character(char_id)

    def delete_character(self, char_id: str) -> None:
        self.conn.execute("DELETE FROM characters WHERE id = ?", (char_id,))
        self.conn.execute("DELETE FROM faction_members WHERE char_id = ?", (char_id,))
        self.conn.commit()

    def known_char_ids(self) -> set[str]:
        return {r["id"] for r in self.conn.execute("SELECT id FROM characters")}

    # ---- factions ---------------------------------------------------

    def list_factions(self) -> list[dict[str, Any]]:
        factions = [dict(r) for r in self.conn.execute("SELECT * FROM factions ORDER BY name")]
        for f in factions:
            f["members"] = [
                r["char_id"]
                for r in self.conn.execute(
                    "SELECT char_id FROM faction_members WHERE faction_id = ?", (f["id"],)
                )
            ]
        return factions

    def create_faction(self, data: dict[str, Any]) -> dict[str, Any]:
        faction_id = data.get("id") or _new_id()
        self.conn.execute(
            "INSERT INTO factions(id, name, description) VALUES(?,?,?)",
            (faction_id, data["name"], data.get("description")),
        )
        self.conn.commit()
        return {"id": faction_id, "name": data["name"], "description": data.get("description"), "members": []}

    def update_faction(self, faction_id: str, data: dict[str, Any]) -> None:
        if "name" in data or "description" in data:
            row = self.conn.execute("SELECT * FROM factions WHERE id = ?", (faction_id,)).fetchone()
            if not row:
                return
            self.conn.execute(
                "UPDATE factions SET name = ?, description = ? WHERE id = ?",
                (data.get("name", row["name"]), data.get("description", row["description"]), faction_id),
            )
        if "members" in data:
            self.conn.execute("DELETE FROM faction_members WHERE faction_id = ?", (faction_id,))
            self.conn.executemany(
                "INSERT OR IGNORE INTO faction_members(char_id, faction_id) VALUES(?,?)",
                [(char_id, faction_id) for char_id in data["members"]],
            )
        self.conn.commit()

    def delete_faction(self, faction_id: str) -> None:
        self.conn.execute("DELETE FROM factions WHERE id = ?", (faction_id,))
        self.conn.execute("DELETE FROM faction_members WHERE faction_id = ?", (faction_id,))
        self.conn.commit()

    # ---- nodes / timeline -------------------------------------------

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if not row:
            return None
        node = dict(row)
        node["cast"] = json.loads(node["cast"])
        node["events"] = self.list_events(node_id)
        return node

    def canon_path(self) -> list[str]:
        """ルートから正史パスのノード ID 列を返す。Phase 1 では全体で単線。"""
        rows = self.conn.execute("SELECT from_node, to_node FROM edges WHERE is_canon = 1").fetchall()
        children = {r["from_node"]: r["to_node"] for r in rows}
        has_parent = {r["to_node"] for r in rows}
        all_ids = {r["id"] for r in self.conn.execute("SELECT id FROM nodes")}
        roots = [nid for nid in all_ids if nid not in has_parent]
        if not roots:
            return []
        # 正史の根はエッジ順で一意のはず。複数あれば作成順の最初を採る
        root = roots[0]
        if len(roots) > 1:
            ordered = self.conn.execute(
                "SELECT id FROM nodes WHERE id IN ({}) ORDER BY created_at".format(
                    ",".join("?" * len(roots))
                ),
                roots,
            ).fetchall()
            root = ordered[0]["id"]
        path = [root]
        seen = {root}
        while path[-1] in children:
            nxt = children[path[-1]]
            if nxt in seen:
                break  # 循環防御
            path.append(nxt)
            seen.add(nxt)
        return path

    def timeline(self) -> list[dict[str, Any]]:
        return [self.get_node(nid) for nid in self.canon_path()]  # type: ignore[misc]

    def append_node(self, data: dict[str, Any], events: list[dict[str, Any]] | None = None,
                    source: str = "user") -> dict[str, Any]:
        """正史タイムラインの末尾にノードを追加する。"""
        path = self.canon_path()
        node_id = data.get("id") or _new_id()
        now = _now()
        self.conn.execute(
            """INSERT INTO nodes(id, title, beat, emotional_core, cast, location, story_time,
                                 status, created_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                node_id,
                data.get("title"),
                data["beat"],
                data.get("emotional_core"),
                json.dumps(data.get("cast", []), ensure_ascii=False),
                data.get("location"),
                data.get("story_time"),
                data.get("status", "canon"),
                now,
                now,
            ),
        )
        if path:
            self.conn.execute(
                "INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,1)",
                (_new_id(), path[-1], node_id),
            )
        if events:
            self.replace_events(node_id, events, source=source, commit=False)
        self.conn.commit()
        return self.get_node(node_id)  # type: ignore[return-value]

    def update_node(self, node_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if not row:
            return None
        current = dict(row)
        cast = data.get("cast")
        self.conn.execute(
            """UPDATE nodes SET title = ?, beat = ?, emotional_core = ?, cast = ?,
               location = ?, story_time = ?, status = ?, updated_at = ? WHERE id = ?""",
            (
                data.get("title", current["title"]),
                data.get("beat", current["beat"]),
                data.get("emotional_core", current["emotional_core"]),
                json.dumps(cast, ensure_ascii=False) if cast is not None else current["cast"],
                data.get("location", current["location"]),
                data.get("story_time", current["story_time"]),
                data.get("status", current["status"]),
                _now(),
                node_id,
            ),
        )
        self.mark_dirty_downstream(node_id, commit=False)
        self.conn.commit()
        return self.get_node(node_id)

    def delete_tail_node(self, node_id: str) -> bool:
        """Phase 1: 末尾ノードのみ削除可(単線を保つため)。"""
        path = self.canon_path()
        if not path or path[-1] != node_id:
            return False
        self.conn.execute("DELETE FROM edges WHERE to_node = ?", (node_id,))
        self.conn.execute("DELETE FROM events WHERE node_id = ?", (node_id,))
        self.conn.execute(
            "DELETE FROM memories WHERE event_id IN (SELECT id FROM events WHERE node_id = ?)",
            (node_id,),
        )
        self.conn.execute("DELETE FROM state_cache WHERE node_id = ?", (node_id,))
        self.conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        self.conn.commit()
        return True

    # ---- events -----------------------------------------------------

    def list_events(self, node_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM events WHERE node_id = ? ORDER BY seq", (node_id,)
        ).fetchall()
        events = []
        for r in rows:
            e = dict(r)
            e["payload"] = json.loads(e["payload"])
            events.append(e)
        return events

    def replace_events(self, node_id: str, events: list[dict[str, Any]],
                       source: str = "user", commit: bool = True) -> list[dict[str, Any]]:
        """ノードのイベント列を置換する。events の要素は {type, payload, source?}。"""
        self.conn.execute(
            "DELETE FROM memories WHERE event_id IN (SELECT id FROM events WHERE node_id = ?)",
            (node_id,),
        )
        self.conn.execute("DELETE FROM events WHERE node_id = ?", (node_id,))
        now = _now()
        for seq, event in enumerate(events):
            event_id = event.get("id") or _new_id()
            self.conn.execute(
                "INSERT INTO events(id, node_id, seq, type, source, payload, created_at) VALUES(?,?,?,?,?,?,?)",
                (
                    event_id,
                    node_id,
                    seq,
                    event["type"],
                    event.get("source", source),
                    json.dumps(event["payload"], ensure_ascii=False),
                    now,
                ),
            )
        self._sync_memories(node_id, commit=False)
        self.mark_dirty_downstream(node_id, commit=False)
        if commit:
            self.conn.commit()
        return self.list_events(node_id)

    def _sync_memories(self, node_id: str, commit: bool = True) -> None:
        """memory_add イベントから memories 行を再構築する(導出物)。"""
        path = self.canon_path()
        story_order = path.index(node_id) if node_id in path else -1
        for event in self.list_events(node_id):
            if event["type"] != "memory_add":
                continue
            p = event["payload"]
            self.conn.execute(
                """INSERT OR REPLACE INTO memories(id, event_id, char_id, content, emotion, importance, story_order)
                   VALUES(?,?,?,?,?,?,?)""",
                (
                    event["id"],
                    event["id"],
                    p["char"],
                    p["content"],
                    p.get("emotion"),
                    p.get("importance"),
                    story_order,
                ),
            )
        if commit:
            self.conn.commit()

    # ---- state cache / fold -----------------------------------------

    def mark_dirty_downstream(self, node_id: str, commit: bool = True) -> None:
        """node_id 自身と下流全ノードの state_cache を dirty 化する。"""
        dirty = {node_id}
        frontier = [node_id]
        children: dict[str, list[str]] = {}
        for r in self.conn.execute("SELECT from_node, to_node FROM edges"):
            children.setdefault(r["from_node"], []).append(r["to_node"])
        while frontier:
            current = frontier.pop()
            for child in children.get(current, []):
                if child not in dirty:
                    dirty.add(child)
                    frontier.append(child)
        self.conn.executemany(
            "UPDATE state_cache SET dirty = 1 WHERE node_id = ?", [(n,) for n in dirty]
        )
        if commit:
            self.conn.commit()

    def get_state(self, node_id: str) -> dict[str, Any]:
        """正史パス順に fold し、途中経過は state_cache に保存する(遅延再計算)。"""
        path = self.canon_path()
        if node_id not in path:
            raise KeyError(f"node not on canon path: {node_id}")
        state = fold_mod.empty_state()
        parent_hash = fold_mod.state_hash(state)
        for nid in path:
            events = self.list_events(nid)
            ihash = fold_mod.input_hash(parent_hash, fold_mod.events_hash(events))
            cached = self.conn.execute(
                "SELECT state, input_hash, dirty FROM state_cache WHERE node_id = ?", (nid,)
            ).fetchone()
            if cached and not cached["dirty"] and cached["input_hash"] == ihash:
                state = json.loads(cached["state"])
            else:
                state = fold_mod.fold(state, events)
                self.conn.execute(
                    "INSERT OR REPLACE INTO state_cache(node_id, state, input_hash, dirty) VALUES(?,?,?,0)",
                    (nid, fold_mod.canonical_json(state), ihash),
                )
            parent_hash = fold_mod.state_hash(state)
            if nid == node_id:
                break
        self.conn.commit()
        return state

    def state_before(self, node_id: str) -> dict[str, Any]:
        """ノード適用前(正史上の親まで)の状態。検証・生成コンテキストに使う。"""
        path = self.canon_path()
        if node_id not in path:
            raise KeyError(f"node not on canon path: {node_id}")
        idx = path.index(node_id)
        if idx == 0:
            return fold_mod.empty_state()
        return self.get_state(path[idx - 1])

    def validate(self, node_id: str) -> list[str]:
        node = self.get_node(node_id)
        if node is None:
            return [f"node not found: {node_id}"]
        return validate_node(
            self.state_before(node_id), node["cast"], node["events"], self.known_char_ids()
        )

    # ---- settings ---------------------------------------------------

    def get_settings(self) -> dict[str, str]:
        return {r["key"]: r["value"] for r in self.conn.execute("SELECT * FROM settings")}

    def set_settings(self, values: dict[str, str]) -> None:
        self.conn.executemany(
            "INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", list(values.items())
        )
        self.conn.commit()
