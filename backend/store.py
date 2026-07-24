"""ストア層 — CRUD、タイムライン、state_cache、dirty 伝播。

真実は events テーブル。state_cache / memories は導出物で、いつでも再構築できる。
Phase 1 は単線タイムライン(分岐なし)のみを扱うが、edges の構造自体は DAG。
"""

from __future__ import annotations

import json
import sqlite3
import struct
import uuid
from datetime import datetime, timezone
from typing import Any

import db as db_mod
import embed
import fold as fold_mod
from validation import validate_node


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    """DB への唯一の窓口。

    ライブラリ = ストーリーごとのフォルダ(中に story-graph.db)。
    switch_library で接続を差し替える(lm-chat の openLibrary と同じ
    インスタンス再利用方式。API ハンドラが握る参照を保つため)。
    """

    def __init__(self, conn: sqlite3.Connection, root: str | None = None):
        self.conn = conn
        self.root = root

    def switch_library(self, root: str) -> None:
        from pathlib import Path

        db_path = Path(root) / "story-graph.db"
        new_conn = db_mod.connect(db_path)
        old_conn = self.conn
        self.conn = new_conn
        self.root = str(root)
        old_conn.close()

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
        """ルートから正史パスのノード ID 列を返す(canon エッジを辿る)。"""
        rows = self.conn.execute("SELECT from_node, to_node FROM edges WHERE is_canon = 1").fetchall()
        children = {r["from_node"]: r["to_node"] for r in rows}
        # ルート判定は全エッジで行う(非 canon の子をルート扱いしないため)
        has_parent = {r["to_node"] for r in self.conn.execute("SELECT to_node FROM edges")}
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

    def parent_of(self, node_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT from_node FROM edges WHERE to_node = ?", (node_id,)
        ).fetchone()
        return row["from_node"] if row else None

    def path_to(self, node_id: str) -> list[str]:
        """ルートから node_id までのパス(親エッジを遡る。分岐ノードでも有効)。"""
        path = [node_id]
        seen = {node_id}
        current = node_id
        while True:
            parent = self.parent_of(current)
            if parent is None or parent in seen:
                break
            path.append(parent)
            seen.add(parent)
            current = parent
        return list(reversed(path))

    def graph(self) -> dict[str, Any]:
        node_ids = [r["id"] for r in self.conn.execute("SELECT id FROM nodes ORDER BY created_at")]
        edges = [dict(r) for r in self.conn.execute("SELECT * FROM edges")]
        return {"nodes": [self.get_node(nid) for nid in node_ids], "edges": edges}

    def append_node(self, data: dict[str, Any], events: list[dict[str, Any]] | None = None,
                    source: str = "user", parent_id: str | None = None,
                    force_draft: bool = False) -> dict[str, Any]:
        """ノードを追加する。

        - parent_id なし: 正史タイムラインの末尾に canon として追加
        - parent_id あり: その子として追加。親に canon の子が居なければ延長(canon)、
          居れば分岐(draft)
        - force_draft: 常に draft ブランチとして追加(チャットの提案カード用)
        """
        canon = self.canon_path()
        if parent_id is None and not force_draft:
            parent_id = canon[-1] if canon else None
            as_canon = True
            on_canon_path = True
        else:
            if parent_id is None:
                parent_id = canon[-1] if canon else None
            if parent_id is not None and self.get_node(parent_id) is None:
                raise KeyError(f"parent not found: {parent_id}")
            has_canon_child = self.conn.execute(
                "SELECT 1 FROM edges WHERE from_node = ? AND is_canon = 1", (parent_id,)
            ).fetchone() if parent_id else None
            as_canon = has_canon_child is None and not force_draft
            # status は「正史パス上か」の導出値。draft 枝の延長は canon エッジでも draft
            on_canon_path = as_canon and (parent_id in canon if parent_id else True)
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
                "canon" if on_canon_path else "draft",
                now,
                now,
            ),
        )
        if parent_id:
            self.conn.execute(
                "INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,?)",
                (_new_id(), parent_id, node_id, 1 if as_canon else 0),
            )
        if events:
            self.replace_events(node_id, events, source=source, commit=False)
        self._ensure_cast_introduced(node_id, commit=False)
        self.conn.commit()
        return self.get_node(node_id)  # type: ignore[return-value]

    def _ensure_cast_introduced(self, node_id: str, commit: bool = True) -> None:
        """cast のキャラがパス上で未登場なら char_introduce を自動追加する。

        物語に一度も現れていないキャラのみが対象。退場済み(char_retire 済み)の
        キャラには追加しない(意図しない「蘇生」を防ぎ、検証警告に任せる)。
        """
        node = self.get_node(node_id)
        if node is None or not node["cast"]:
            return
        state_before = self.state_before(node_id)
        known = self.known_char_ids()
        introduced_here = {
            e["payload"].get("char") for e in node["events"] if e["type"] == "char_introduce"
        }
        missing = [
            c
            for c in node["cast"]
            if c in known and c not in state_before["chars"] and c not in introduced_here
        ]
        if not missing:
            return
        current = [
            {"type": e["type"], "payload": e["payload"], "source": e["source"]}
            for e in node["events"]
        ]
        intros = [
            {"type": "char_introduce", "payload": {"char": c}, "source": "user"} for c in missing
        ]
        self.replace_events(node_id, intros + current, commit=commit)

    def make_canon(self, node_id: str) -> None:
        """node_id までのパスを正史にする(各分岐点で canon エッジを付け替え)。

        status は「正史パス上なら canon、外れたら draft」の導出値として全ノードを更新する。
        正史が変わると story_order が変わるため memories も再同期する。
        """
        if self.get_node(node_id) is None:
            raise KeyError(f"node not found: {node_id}")
        path = self.path_to(node_id)
        for parent, child in zip(path, path[1:]):
            self.conn.execute(
                "UPDATE edges SET is_canon = CASE WHEN to_node = ? THEN 1 ELSE 0 END"
                " WHERE from_node = ?",
                (child, parent),
            )
        # 切替先の canon 末尾から先に既存の canon 継続があれば辿って有効なままにする
        canon = set(self.canon_path())
        for row in self.conn.execute("SELECT id FROM nodes"):
            self.conn.execute(
                "UPDATE nodes SET status = ? WHERE id = ?",
                ("canon" if row["id"] in canon else "draft", row["id"]),
            )
        self._resync_memory_orders(commit=False)
        self.conn.commit()

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
        if cast is not None:
            self._ensure_cast_introduced(node_id, commit=False)
        self.mark_dirty_downstream(node_id, commit=False)
        self.conn.commit()
        return self.get_node(node_id)

    def set_node_position(self, node_id: str, x: float | None, y: float | None) -> None:
        """キャンバス上の手動配置を保存する(state には影響しないので dirty 化しない)。"""
        self.conn.execute(
            "UPDATE nodes SET pos_x = ?, pos_y = ? WHERE id = ?", (x, y, node_id)
        )
        self.conn.commit()

    def reset_positions(self) -> None:
        self.conn.execute("UPDATE nodes SET pos_x = NULL, pos_y = NULL")
        self.conn.commit()

    def delete_leaf_node(self, node_id: str) -> bool:
        """リーフ(子を持たない)ノードのみ削除可。"""
        has_child = self.conn.execute(
            "SELECT 1 FROM edges WHERE from_node = ?", (node_id,)
        ).fetchone()
        if has_child:
            return False
        old_memory_ids = [
            r["id"]
            for r in self.conn.execute(
                "SELECT id FROM memories WHERE event_id IN (SELECT id FROM events WHERE node_id = ?)",
                (node_id,),
            )
        ]
        self._remove_memory_index(old_memory_ids)
        self.conn.execute(
            "DELETE FROM memories WHERE event_id IN (SELECT id FROM events WHERE node_id = ?)",
            (node_id,),
        )
        self.conn.execute("DELETE FROM edges WHERE to_node = ?", (node_id,))
        self.conn.execute("DELETE FROM events WHERE node_id = ?", (node_id,))
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
        old_memory_ids = [
            r["id"]
            for r in self.conn.execute(
                "SELECT id FROM memories WHERE event_id IN (SELECT id FROM events WHERE node_id = ?)",
                (node_id,),
            )
        ]
        self._remove_memory_index(old_memory_ids)
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
        """memory_add イベントから memories 行を再構築する(導出物)。

        story_order は正史パス上の位置。分岐ノードは -1(時間減衰では「現在」扱い)。
        """
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
            self._index_memory(event["id"], p["content"])
        if commit:
            self.conn.commit()

    def _index_memory(self, memory_id: str, content: str) -> None:
        """FTS / ベクトル索引を更新する。埋め込みはモデルがロード済みの時のみ
        (未ロード分は検索時の ensure_vectors が自己修復する)。"""
        self.conn.execute("DELETE FROM memories_fts WHERE id = ?", (memory_id,))
        self.conn.execute(
            "INSERT INTO memories_fts(id, content) VALUES(?,?)", (memory_id, content)
        )
        if db_mod.has_vec(self.conn) and embed.is_ready():
            vector = embed.embed_document(content)
            self.conn.execute(
                "INSERT OR REPLACE INTO memories_vec(memory_id, embedding) VALUES(?,?)",
                (memory_id, struct.pack(f"{len(vector)}f", *vector)),
            )

    def _remove_memory_index(self, memory_ids: list[str]) -> None:
        for memory_id in memory_ids:
            self.conn.execute("DELETE FROM memories_fts WHERE id = ?", (memory_id,))
            if db_mod.has_vec(self.conn):
                self.conn.execute(
                    "DELETE FROM memories_vec WHERE memory_id = ?", (memory_id,)
                )

    def _resync_memory_orders(self, commit: bool = True) -> None:
        """正史切替後に全 memories の story_order を再計算する。"""
        path = self.canon_path()
        order = {nid: i for i, nid in enumerate(path)}
        rows = self.conn.execute(
            "SELECT m.id, e.node_id FROM memories m JOIN events e ON m.event_id = e.id"
        ).fetchall()
        for r in rows:
            self.conn.execute(
                "UPDATE memories SET story_order = ? WHERE id = ?",
                (order.get(r["node_id"], -1), r["id"]),
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
        # 上流のビート/イベント変更でレンダー結果も陳腐化する(spec §7 部分レンダー)
        self.conn.executemany(
            "UPDATE renders SET stale = 1 WHERE node_id = ?", [(n,) for n in dirty]
        )
        if commit:
            self.conn.commit()

    def get_state(self, node_id: str) -> dict[str, Any]:
        """ルートからのパス順に fold し、途中経過は state_cache に保存する(遅延再計算)。

        分岐ノードは分岐点までの state を共有し、以降は独立に fold される(spec §5)。
        """
        if self.get_node(node_id) is None:
            raise KeyError(f"node not found: {node_id}")
        path = self.path_to(node_id)
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
        """ノード適用前(パス上の親まで)の状態。検証・生成コンテキストに使う。"""
        parent = self.parent_of(node_id)
        if parent is None:
            return fold_mod.empty_state()
        return self.get_state(parent)

    def validate(self, node_id: str) -> list[str]:
        node = self.get_node(node_id)
        if node is None:
            return [f"node not found: {node_id}"]
        return validate_node(
            self.state_before(node_id), node["cast"], node["events"], self.known_char_ids()
        )

    # ---- style presets ----------------------------------------------

    # tone カラムにはシステムプロンプト全文を格納する(人称指定と厳守事項は
    # レンダリング時に自動で末尾追加される。rendering.build_render_messages 参照)
    DEFAULT_PRESETS = [
        ("default-third", "三人称・標準", "third",
         "あなたはプロの小説家です。与えられたシーン(出来事の仕様書)を、一つの完成された場面として散文に仕上げます。\n"
         "背景や空気感の描写、人物の仕草と表情、会話の間を丁寧に肉付けしてください。\n"
         "自然で読みやすい三人称の地の文。抑制の効いた描写と会話のバランスを取り、説明しすぎないこと。", "{}"),
        ("default-first", "一人称・内省", "first",
         "あなたはプロの小説家です。与えられたシーン(出来事の仕様書)を、POVキャラクターの一人称で散文に仕上げます。\n"
         "内面の声を重視し、感情の機微と身体感覚を丁寧に描いてください。\n"
         "見たもの・聞いたことを、そのキャラクターの解釈と語り口を通して描写すること。", "{}"),
    ]

    # 旧版のデフォルト文言(未編集ならフルプロンプト版へ差し替えるための照合用)
    _OLD_DEFAULT_TONES = {
        "default-third": "自然で読みやすい三人称の地の文。抑制の効いた描写と会話のバランスを取り、説明しすぎない。",
        "default-first": "POVキャラクターの一人称。内面の声を重視し、感情の機微と身体感覚を丁寧に描く。",
    }

    def seed_presets(self) -> None:
        count = self.conn.execute("SELECT COUNT(*) FROM style_presets").fetchone()[0]
        if count:
            # 旧デフォルト文言のまま(ユーザー未編集)ならフルプロンプト版に更新する
            for preset_id, name, person, tone, params in self.DEFAULT_PRESETS:
                old_tone = self._OLD_DEFAULT_TONES.get(preset_id)
                if old_tone is None:
                    continue
                self.conn.execute(
                    "UPDATE style_presets SET tone = ? WHERE id = ? AND tone = ?",
                    (tone, preset_id, old_tone),
                )
            self.conn.commit()
            return
        self.conn.executemany(
            "INSERT INTO style_presets(id, name, person, tone, params) VALUES(?,?,?,?,?)",
            self.DEFAULT_PRESETS,
        )
        self.conn.commit()

    BUILTIN_PRESET_IDS = frozenset({"default-third", "default-first"})

    def list_presets(self) -> list[dict[str, Any]]:
        self.seed_presets()
        presets = [dict(r) for r in self.conn.execute("SELECT * FROM style_presets ORDER BY rowid")]
        for p in presets:
            p["builtin"] = p["id"] in self.BUILTIN_PRESET_IDS
        return presets

    def get_preset(self, preset_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM style_presets WHERE id = ?", (preset_id,)).fetchone()
        if row is None:
            return None
        preset = dict(row)
        preset["builtin"] = preset["id"] in self.BUILTIN_PRESET_IDS
        return preset

    def upsert_preset(self, data: dict[str, Any]) -> dict[str, Any]:
        preset_id = data.get("id") or _new_id()
        if preset_id in self.BUILTIN_PRESET_IDS:
            raise PermissionError("組み込みプリセットは編集できません(複製して新規作成してください)")
        self.conn.execute(
            "INSERT OR REPLACE INTO style_presets(id, name, person, tone, params) VALUES(?,?,?,?,?)",
            (preset_id, data["name"], data.get("person", "third"), data.get("tone", ""),
             data.get("params", "{}")),
        )
        self.conn.commit()
        return self.get_preset(preset_id)  # type: ignore[return-value]

    def delete_preset(self, preset_id: str) -> None:
        if preset_id in self.BUILTIN_PRESET_IDS:
            raise PermissionError("組み込みプリセットは削除できません")
        self.conn.execute("DELETE FROM style_presets WHERE id = ?", (preset_id,))
        self.conn.commit()

    # ---- renders ----------------------------------------------------

    def latest_render(self, node_id: str, preset_id: str, pov_char: str | None) -> dict[str, Any] | None:
        row = self.conn.execute(
            """SELECT * FROM renders WHERE node_id = ? AND preset_id = ? AND pov_char IS ?
               ORDER BY created_at DESC LIMIT 1""",
            (node_id, preset_id, pov_char),
        ).fetchone()
        return dict(row) if row else None

    def save_render(self, node_id: str, preset_id: str, pov_char: str | None, prose: str) -> dict[str, Any]:
        render_id = _new_id()
        self.conn.execute(
            "INSERT INTO renders(id, node_id, preset_id, pov_char, prose, stale, created_at) VALUES(?,?,?,?,?,0,?)",
            (render_id, node_id, preset_id, pov_char, prose, _now()),
        )
        self.conn.commit()
        return dict(self.conn.execute("SELECT * FROM renders WHERE id = ?", (render_id,)).fetchone())

    def list_renders(self, preset_id: str, pov_char: str | None) -> list[dict[str, Any]]:
        """正史パス順に各ノードの最新レンダーを返す(無ければ render: None)。"""
        result = []
        for nid in self.canon_path():
            node = self.get_node(nid)
            result.append({"node": node, "render": self.latest_render(nid, preset_id, pov_char)})
        return result

    # ---- 相談チャット -----------------------------------------------

    def create_chat(self, anchor_node: str | None, scope: str) -> dict[str, Any]:
        chat_id = _new_id()
        now = _now()
        self.conn.execute(
            "INSERT INTO chats(id, anchor_node, scope, messages, created_at, updated_at) VALUES(?,?,?,?,?,?)",
            (chat_id, anchor_node, scope, "[]", now, now),
        )
        self.conn.commit()
        return self.get_chat(chat_id)  # type: ignore[return-value]

    def get_chat(self, chat_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if row is None:
            return None
        chat = dict(row)
        chat["messages"] = json.loads(chat["messages"])
        return chat

    def list_chats(self) -> list[dict[str, Any]]:
        """履歴一覧(新しい順)。最初のユーザー発言をスニペットとして返す。"""
        chats = []
        for row in self.conn.execute("SELECT * FROM chats ORDER BY updated_at DESC"):
            messages = json.loads(row["messages"])
            first_user = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
            anchor = self.get_node(row["anchor_node"]) if row["anchor_node"] else None
            chats.append(
                {
                    "id": row["id"],
                    "anchor_node": row["anchor_node"],
                    "anchor_title": anchor["title"] if anchor else None,
                    "scope": row["scope"],
                    "snippet": first_user[:60],
                    "updated_at": row["updated_at"],
                }
            )
        return chats

    def save_chat_messages(self, chat_id: str, messages: list[dict[str, Any]]) -> None:
        self.conn.execute(
            "UPDATE chats SET messages = ?, updated_at = ? WHERE id = ?",
            (json.dumps(messages, ensure_ascii=False), _now(), chat_id),
        )
        self.conn.commit()

    def delete_chat(self, chat_id: str) -> None:
        self.conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
        self.conn.commit()

    # ---- settings ---------------------------------------------------

    def get_settings(self) -> dict[str, str]:
        return {r["key"]: r["value"] for r in self.conn.execute("SELECT * FROM settings")}

    def set_settings(self, values: dict[str, str]) -> None:
        self.conn.executemany(
            "INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", list(values.items())
        )
        self.conn.commit()
