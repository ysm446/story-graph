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


# チャット履歴で「1 往復の始まり」と見なすメッセージ。ツール上限に達したときの
# 内部指示も user ロールで積まれるので、それは区切りに数えない
TOOL_LIMIT_MARKER = "(これ以上ツールは使えません"

# 画像・動画アセットを参照する列(gc_assets とスナップショットの参照保護で共用)
ASSET_REF_SQLS = (
    "SELECT image_path FROM nodes WHERE image_path IS NOT NULL",
    "SELECT thumb_path FROM nodes WHERE thumb_path IS NOT NULL",
    "SELECT portrait_path FROM characters WHERE portrait_path IS NOT NULL",
    "SELECT portrait_source_path FROM characters WHERE portrait_source_path IS NOT NULL",
    "SELECT image_path FROM places WHERE image_path IS NOT NULL",
)


def _is_turn_start(message: dict[str, Any]) -> bool:
    if message.get("role") != "user":
        return False
    content = message.get("content")
    return not (isinstance(content, str) and content.startswith(TOOL_LIMIT_MARKER))


class Store:
    """DB への唯一の窓口。

    ライブラリ = ストーリーごとのフォルダ(中に story-graph.db)。
    switch_library で接続を差し替える(lm-chat の openLibrary と同じ
    インスタンス再利用方式。API ハンドラが握る参照を保つため)。
    """

    def __init__(self, conn: sqlite3.Connection, root: str | None = None):
        self.conn = conn
        self.root = root
        self.ensure_story_markers()

    def switch_library(self, root: str) -> None:
        from pathlib import Path

        db_path = Path(root) / "story-graph.db"
        new_conn = db_mod.connect(db_path)
        old_conn = self.conn
        self.conn = new_conn
        self.root = str(root)
        old_conn.close()
        self.ensure_story_markers()

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
        fields = ["name", "profile", "appearance", "voice", "color", "graph_x", "graph_y",
                  "portrait_path", "portrait_source_path", "portrait_crop"]
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

    # ---- places -----------------------------------------------------
    # 場所は characters と同型の登録制エンティティ(docs/design/places.md)。
    # ノードは 1 つだけ参照し、空欄なら親から引き継ぐ(effective_location)。

    def list_places(self) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM places ORDER BY created_at").fetchall()
        return [dict(r) for r in rows]

    def get_place(self, place_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM places WHERE id = ?", (place_id,)).fetchone()
        return dict(row) if row else None

    def create_place(self, data: dict[str, Any]) -> dict[str, Any]:
        place_id = data.get("id") or _new_id()
        self.conn.execute(
            """INSERT INTO places(id, name, description, atmosphere, color, created_at)
               VALUES(?,?,?,?,?,?)""",
            (
                place_id,
                data["name"],
                data.get("description"),
                data.get("atmosphere"),
                data.get("color"),
                _now(),
            ),
        )
        self.conn.commit()
        return self.get_place(place_id)  # type: ignore[return-value]

    def update_place(self, place_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        fields = ["name", "description", "atmosphere", "color", "image_path"]
        updates = {k: data[k] for k in fields if k in data}
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            self.conn.execute(
                f"UPDATE places SET {sets} WHERE id = ?", (*updates.values(), place_id)
            )
            # 名前・説明・雰囲気は清書プロンプトに載るので、既存の清書を stale にする
            if {"name", "description", "atmosphere"} & updates.keys():
                self.conn.executemany(
                    "UPDATE renders SET stale = 1 WHERE node_id = ?",
                    [(n,) for n in self._nodes_using_place(place_id)],
                )
            self.conn.commit()
        return self.get_place(place_id)

    def _nodes_using_place(self, place_id: str) -> list[str]:
        """実効ロケーションがこの場所になるノード(直接参照 + 空欄で引き継ぐ子孫)。"""
        direct = [
            r["id"] for r in self.conn.execute("SELECT id FROM nodes WHERE location = ?", (place_id,))
        ]
        children: dict[str, list[str]] = {}
        for r in self.conn.execute("SELECT from_node, to_node FROM edges"):
            children.setdefault(r["from_node"], []).append(r["to_node"])
        locations = {
            r["id"]: r["location"] for r in self.conn.execute("SELECT id, location FROM nodes")
        }
        affected = list(direct)
        seen = set(direct)
        frontier = list(direct)
        while frontier:
            current = frontier.pop()
            for child in children.get(current, []):
                if child in seen or locations.get(child):
                    continue  # 自分の場所を持つ子から先は引き継がない
                seen.add(child)
                affected.append(child)
                frontier.append(child)
        return affected

    def delete_place(self, place_id: str) -> None:
        """場所を削除する。参照していたノードは「引き継ぐ」状態(空欄)に戻る。

        location は state に影響しない(Step 0 時点)ので dirty 化はしないが、
        清書プロンプトには載るので renders は stale にする。
        """
        node_ids = self._nodes_using_place(place_id)
        self.conn.execute("UPDATE nodes SET location = NULL WHERE location = ?", (place_id,))
        self.conn.execute("DELETE FROM places WHERE id = ?", (place_id,))
        self.conn.executemany(
            "UPDATE renders SET stale = 1 WHERE node_id = ?", [(n,) for n in node_ids]
        )
        self.conn.commit()

    def known_place_ids(self) -> set[str]:
        return {r["id"] for r in self.conn.execute("SELECT id FROM places")}

    def place_name(self, place_id: str | None) -> str | None:
        """表示・プロンプト用の名前。未登録 ID はそのまま返す(移行漏れの保険)。"""
        if not place_id:
            return None
        row = self.conn.execute("SELECT name FROM places WHERE id = ?", (place_id,)).fetchone()
        return row["name"] if row else place_id

    def effective_location(self, node_id: str) -> tuple[str | None, bool]:
        """(place_id, 継承かどうか)を返す。

        自ノードに値があれば (それ, False)。空欄なら親を遡り、最初に見つかった
        値を (それ, True) で返す。島の根まで遡って無ければ (None, False)。
        「場所が変わらない限り書かない」という書き方を許すための実効ロケーション。
        """
        row = self.conn.execute("SELECT location FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if row is None:
            return (None, False)
        if row["location"]:
            return (row["location"], False)
        current = node_id
        seen = {node_id}
        while True:
            parent = self.parent_of(current)
            if parent is None or parent in seen:
                return (None, False)
            seen.add(parent)
            prow = self.conn.execute(
                "SELECT location FROM nodes WHERE id = ?", (parent,)
            ).fetchone()
            if prow is not None and prow["location"]:
                return (prow["location"], True)
            current = parent

    def location_context(self, node_id: str) -> dict[str, Any] | None:
        """プロンプト用: 実効ロケーションの場所レコード + 継承フラグ。"""
        place_id, inherited = self.effective_location(node_id)
        if not place_id:
            return None
        place = self.get_place(place_id) or {"id": place_id, "name": place_id,
                                             "description": None, "atmosphere": None}
        return {**place, "inherited": inherited}

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

    # ---- はじまり / 結末マーカー(docs/design/endings.md) ------------
    #
    # 正史 = アクティブな結末ノードから根へさかのぼった道(マーカーは含めない)。
    # edges.is_canon / nodes.status はこの導出のキャッシュに格下げされた
    # (_resync_canon が貼り直す)。不変条件: はじまりは常に 1 つ(削除不可)、
    # 結末は常に 1 つ以上(最後の 1 つは削除不可)。

    def _node_kind(self, node_id: str) -> str | None:
        row = self.conn.execute("SELECT kind FROM nodes WHERE id = ?", (node_id,)).fetchone()
        return row["kind"] if row else None

    def active_ending(self) -> str | None:
        """アクティブな結末ノードの ID。設定が欠けている・死んでいるときは自動補正。"""
        eid = self.get_settings().get("active_ending")
        if eid and self._node_kind(eid) == "ending":
            return eid
        row = self.conn.execute(
            "SELECT id FROM nodes WHERE kind = 'ending' ORDER BY created_at"
        ).fetchone()
        if row:
            self.set_settings({"active_ending": row["id"]})
            return row["id"]
        return None

    def ensure_story_markers(self) -> None:
        """はじまり / 結末ノードを保証する(接続時に一度。無停止移行)。

        既存ライブラリでは、旧方式(is_canon エッジ辿り)の正史の根の親に
        「はじまり」を、末尾の子に「結末」を自動でつなぐ。"""
        try:
            has_kind = self.conn.execute("SELECT kind FROM nodes LIMIT 1")
            has_kind.fetchone()
        except sqlite3.OperationalError:
            return  # kind 列の無い接続(スキーマ未初期化)では何もしない
        legacy = self._legacy_canon_path()
        now = _now()
        start = self.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()
        if start is None:
            start_id = _new_id()
            self.conn.execute(
                "INSERT INTO nodes(id, title, beat, cast, status, kind, created_at, updated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (start_id, "はじまり", "", "[]", "canon", "start", now, now),
            )
            if legacy:
                self.conn.execute(
                    "INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,1)",
                    (_new_id(), start_id, legacy[0], ),
                )
        else:
            start_id = start["id"]
        endings = [r["id"] for r in self.conn.execute("SELECT id FROM nodes WHERE kind = 'ending'")]
        if not endings:
            ending_id = _new_id()
            self.conn.execute(
                "INSERT INTO nodes(id, title, beat, cast, status, kind, created_at, updated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (ending_id, "結末", "", "[]", "canon", "ending", now, now),
            )
            tail = legacy[-1] if legacy else start_id
            self.conn.execute(
                "INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,1)",
                (_new_id(), tail, ending_id),
            )
            endings = [ending_id]
        if self.get_settings().get("active_ending") not in endings:
            self.set_settings({"active_ending": endings[0]})
        self._resync_canon()
        self.conn.commit()

    def _resync_canon(self) -> None:
        """edges.is_canon / nodes.status をアクティブ結末からの導出で貼り直す。
        commit は呼び出し側。"""
        ending = self.active_ending()
        if ending is None:
            return
        chain = self.path_to(ending)  # はじまり〜結末のマーカー込みチェーン
        chain_set = set(chain)
        pairs = set(zip(chain, chain[1:]))
        for e in self.conn.execute("SELECT id, from_node, to_node, is_canon FROM edges").fetchall():
            flag = 1 if (e["from_node"], e["to_node"]) in pairs else 0
            if flag != e["is_canon"]:
                self.conn.execute("UPDATE edges SET is_canon = ? WHERE id = ?", (flag, e["id"]))
        for row in self.conn.execute("SELECT id, status FROM nodes").fetchall():
            status = "canon" if row["id"] in chain_set else "draft"
            if status != row["status"]:
                self.conn.execute("UPDATE nodes SET status = ? WHERE id = ?", (status, row["id"]))

    def _ensure_active_ending_rooted(self) -> None:
        """切り離しなどでアクティブな結末が「はじまり」から辿れなくなったら、
        はじまり側の結末へ切り替える(無ければ正史連鎖の末端に作る)。commit は呼び出し側。"""
        start = self.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()
        ending = self.active_ending()
        if start is None or ending is None:
            return
        if self.path_to(ending)[0] == start["id"]:
            return
        for r in self.conn.execute("SELECT id FROM nodes WHERE kind = 'ending' ORDER BY created_at"):
            if self.path_to(r["id"])[0] == start["id"]:
                self.set_settings({"active_ending": r["id"]})
                return
        # はじまりの木に結末が無くなった: canon 連鎖の末端に作って正史を守る
        current = start["id"]
        while True:
            row = self.conn.execute(
                "SELECT to_node FROM edges WHERE from_node = ? AND is_canon = 1", (current,)
            ).fetchone()
            if row is None:
                break
            current = row["to_node"]
        self.set_settings({"active_ending": self._insert_ending(current, "結末")})

    def canon_path(self) -> list[str]:
        """正史パスのシーン ID 列(アクティブな結末から根へさかのぼる。マーカーは除く)。"""
        ending = self.active_ending()
        if ending is None:
            # 移行前(結末なし)の互換: 旧方式で辿る
            return [nid for nid in self._legacy_canon_path() if self._node_kind(nid) is None]
        kinds = {r["id"]: r["kind"] for r in self.conn.execute("SELECT id, kind FROM nodes")}
        return [nid for nid in self.path_to(ending) if kinds.get(nid) is None]

    def _legacy_canon_path(self) -> list[str]:
        """旧方式の正史導出(canon エッジ辿り)。移行時と結末なしの互換にだけ使う。"""
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
        # 構造モードは操作のたびにここを引くので、ノードごとの get_node
        # (SELECT×2 の N+1)ではなく全ノード+全イベントの 2 クエリで組み立てる
        nodes = [dict(r) for r in self.conn.execute("SELECT * FROM nodes ORDER BY created_at")]
        events_by_node: dict[str, list[dict[str, Any]]] = {}
        for r in self.conn.execute("SELECT * FROM events ORDER BY node_id, seq"):
            e = dict(r)
            e["payload"] = json.loads(e["payload"])
            events_by_node.setdefault(e["node_id"], []).append(e)
        for node in nodes:
            node["cast"] = json.loads(node["cast"])
            node["events"] = events_by_node.get(node["id"], [])
        edges = [dict(r) for r in self.conn.execute("SELECT * FROM edges")]
        return {"nodes": nodes, "edges": edges}

    def append_node(self, data: dict[str, Any], events: list[dict[str, Any]] | None = None,
                    source: str = "user", parent_id: str | None = None,
                    force_draft: bool = False, detached: bool = False) -> dict[str, Any]:
        """ノードを追加する。

        - parent_id なし: 正史タイムラインの末尾に canon として追加
        - parent_id あり: その子として追加。親に canon の子が居なければ延長(canon)、
          居れば分岐(draft)
        - force_draft: 常に draft ブランチとして追加(チャットの提案カード用)
        - detached: どこにも繋がない独立ノード(島の起点。エピソードの作り置き用)
        """
        canon = self.canon_path()
        if parent_id is not None and self._node_kind(parent_id) == "ending":
            raise ValueError("結末の先にはつなげません")
        if detached:
            parent_id = None
            as_canon = False
            on_canon_path = False
        elif parent_id is None and not force_draft:
            # 正史末尾への追加 = アクティブな結末の直前に挿す(結末は末尾に居続ける)
            ending = self.active_ending()
            ending_parent = self.parent_of(ending) if ending else None
            if ending_parent is not None:
                return self.insert_node_after(ending_parent, data, events, source=source)
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
        self.conn.commit()
        return self.get_node(node_id)  # type: ignore[return-value]

    def insert_node_after(self, parent_id: str, data: dict[str, Any],
                          events: list[dict[str, Any]] | None = None,
                          source: str = "user") -> dict[str, Any]:
        """parent_id の直後にノードを割り込ませる。

        parent から出ている連鎖エッジ(is_canon=1 の子)があれば、新ノードを間に
        挟んで付け替える(parent → 新 → 旧子)。無ければ末尾追加と同じ扱い。
        分岐(is_canon=0)の子エッジは parent に付いたまま動かさない。
        挿入で下流の正史順・状態が変わるため、state_cache と memories を再同期する。
        """
        if self.get_node(parent_id) is None:
            raise KeyError(f"parent not found: {parent_id}")
        if self._node_kind(parent_id) == "ending":
            raise ValueError("結末の先にはつなげません")
        chain_edge = self.conn.execute(
            "SELECT id, to_node FROM edges WHERE from_node = ? AND is_canon = 1", (parent_id,)
        ).fetchone()
        if chain_edge is None:
            # 後続が無いので通常の追加と同じ
            return self.append_node(data, events, source=source, parent_id=parent_id)

        node_id = data.get("id") or _new_id()
        now = _now()
        # 正史チェーン上か(status 用)。canon_path はシーンだけなので、
        # 「はじまり」の直後への挿入も拾えるようマーカー込みのチェーンで見る
        ending = self.active_ending()
        chain = set(self.path_to(ending)) if ending else set(self.canon_path())
        on_canon_path = parent_id in chain
        # 章の真ん中(前後が同じ章)への挿入は、その章を引き継ぐ
        # (引き継がないと章が正史上で分断されて警告バッジが付く)
        neighbors = self.conn.execute(
            "SELECT id, group_id FROM nodes WHERE id IN (?, ?)",
            (parent_id, chain_edge["to_node"]),
        ).fetchall()
        neighbor_groups = {r["id"]: r["group_id"] for r in neighbors}
        parent_group = neighbor_groups.get(parent_id)
        group_id = parent_group if parent_group and parent_group == neighbor_groups.get(chain_edge["to_node"]) else None
        self.conn.execute(
            """INSERT INTO nodes(id, title, beat, emotional_core, cast, location, story_time,
                                 status, group_id, created_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                node_id,
                data.get("title"),
                data["beat"],
                data.get("emotional_core"),
                json.dumps(data.get("cast", []), ensure_ascii=False),
                data.get("location"),
                data.get("story_time"),
                "canon" if on_canon_path else "draft",
                group_id,
                now,
                now,
            ),
        )
        # 旧子への連鎖エッジを新ノード発に付け替え、parent → 新 を連鎖(canon)で張る
        self.conn.execute("UPDATE edges SET from_node = ? WHERE id = ?", (node_id, chain_edge["id"]))
        self.conn.execute(
            "INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,1)",
            (_new_id(), parent_id, node_id),
        )
        if events:
            self.replace_events(node_id, events, source=source, commit=False)
        self.mark_dirty_downstream(node_id, commit=False)
        if group_id:
            self._mark_digest_stale(node_id)  # 章の中に増えたシーンはまとめの材料が変わる
        self._resync_memory_orders(commit=False)
        self.conn.commit()
        return self.get_node(node_id)  # type: ignore[return-value]

    def subtree_order(self, node_id: str) -> list[str]:
        """node_id を根とする部分木を、親が先に来る順で返す(再抽出の実行順)。"""
        rows = self.conn.execute("SELECT from_node, to_node FROM edges").fetchall()
        children: dict[str, list[str]] = {}
        for r in rows:
            children.setdefault(r["from_node"], []).append(r["to_node"])
        order: list[str] = []
        seen = {node_id}
        queue = [node_id]
        while queue:
            current = queue.pop(0)
            order.append(current)
            for child in children.get(current, []):
                if child not in seen:  # 壊れたデータでも無限ループしない
                    seen.add(child)
                    queue.append(child)
        return order

    def normalize_chain(self, node_id: str) -> dict[str, Any]:
        """node_id 以下を整える(LLM 不要): 不要になった char_introduce を掃除し、
        検証結果を返す。

        登場は cast から導出するようになったので(fold 参照)char_introduce は
        すべて冗長。古いデータや手動追加分が残っていると一覧のノイズになるため、
        ここで落とす。退場(char_retire)は作者の判断なので触らない。
        """
        if self.get_node(node_id) is None:
            raise KeyError(f"node not found: {node_id}")
        removed = 0
        changed: list[str] = []
        warnings: list[dict[str, Any]] = []
        for nid in self.subtree_order(node_id):
            node = self.get_node(nid)
            if node is None:
                continue
            kept = [e for e in node["events"] if e["type"] != "char_introduce"]
            if len(kept) != len(node["events"]):
                removed += len(node["events"]) - len(kept)
                changed.append(nid)
                self.replace_events(
                    nid,
                    # id を引き継ぐ(掃除で残るイベントの参照を壊さない)
                    [{"id": e["id"], "type": e["type"], "payload": e["payload"], "source": e["source"]} for e in kept],
                )
            errors = self.validate(nid)
            if errors:
                warnings.append({"node_id": nid, "title": node["title"] or "(無題)", "errors": errors})
        return {"removed": removed, "changed_nodes": changed, "warnings": warnings}

    def detach_node(self, node_id: str) -> bool:
        """親エッジを切り、node_id 以下を独立した島にする(構造はそのまま)。

        繋ぎ直すまで、この島は自分の根から fold される(= 上流の状態を引き継が
        ない)。正史から外れるので status / story_order も貼り直す。
        """
        if self.get_node(node_id) is None:
            raise KeyError(f"node not found: {node_id}")
        if self._node_kind(node_id) is not None:
            raise ValueError("「はじまり」や結末は切り離せません")
        cur = self.conn.execute("DELETE FROM edges WHERE to_node = ?", (node_id,))
        if cur.rowcount == 0:
            return False  # 既に根
        self.mark_dirty_downstream(node_id, commit=False)
        # アクティブな結末ごと切り離した場合は、はじまり側の結末へ切り替える
        self._ensure_active_ending_rooted()
        self._resync_canon()
        self._resync_memory_orders(commit=False)
        self.conn.commit()
        return True

    def attach_node(self, parent_id: str, child_id: str, as_canon: bool = False) -> None:
        """島の根 child_id を parent_id の子として繋ぐ。

        多重親と循環を作らないように、child_id は根であること、parent_id が
        child_id の子孫でないことを確認する。既定は draft(正史にするのは
        make_canon の役目)。
        """
        if self.get_node(parent_id) is None:
            raise KeyError(f"node not found: {parent_id}")
        if self.get_node(child_id) is None:
            raise KeyError(f"node not found: {child_id}")
        if parent_id == child_id:
            raise ValueError("自分自身には繋げません")
        if self._node_kind(parent_id) == "ending":
            raise ValueError("結末の先にはつなげません")
        if self._node_kind(child_id) is not None:
            raise ValueError("「はじまり」や結末はつなぎ替えの対象になりません")
        if self.parent_of(child_id) is not None:
            raise ValueError("繋ぎ先のシーンには既に親がいます(先に切り離してください)")
        if parent_id in self.subtree_order(child_id):
            raise ValueError("自分の下流には繋げません(循環になります)")
        self.conn.execute(
            "INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,0)",
            (_new_id(), parent_id, child_id),
        )
        self.mark_dirty_downstream(child_id, commit=False)
        self._resync_memory_orders(commit=False)
        if as_canon:
            # 正史へ = 繋いだ枝の先の結末をアクティブにする(無ければ末端に作る)
            self.conn.commit()
            self.make_canon(child_id)
            return
        self._resync_canon()
        self.conn.commit()

    def make_canon(self, node_id: str) -> None:
        """node_id を通る道を正史にする(結末方式。docs/design/endings.md §3)。

        node_id の先の canon 連鎖を辿って結末を探し、あればそれをアクティブに、
        無ければ連鎖の末端に結末を作ってアクティブにする。is_canon / status は
        導出キャッシュとして貼り直し、story_order・章も再同期する。
        """
        if self.get_node(node_id) is None:
            raise KeyError(f"node not found: {node_id}")
        if self._node_kind(node_id) == "start":
            raise ValueError("「はじまり」は正史の切替対象になりません")
        current = node_id
        target: str | None = None
        seen = {current}
        while target is None:
            if self._node_kind(current) == "ending":
                target = current
                break
            children = self.conn.execute(
                "SELECT to_node, is_canon FROM edges WHERE from_node = ?", (current,)
            ).fetchall()
            ending_child = next((c["to_node"] for c in children if self._node_kind(c["to_node"]) == "ending"), None)
            if ending_child is not None:
                target = ending_child
                break
            # 既存の canon 継続を優先して末端まで辿る(従来の「切替先の先の正史は
            # 有効なまま」の挙動を引き継ぐ)。フラグが無くても一本道なら辿る
            # (島は resync で内部フラグが落ちていることがある)
            canon_child = next((c["to_node"] for c in children if c["is_canon"]), None)
            if canon_child is None and len(children) == 1:
                canon_child = children[0]["to_node"]
            if canon_child is None or canon_child in seen:
                # 連鎖の終わり(または分岐点でどちらとも決められない): ここに結末を作る
                target = self._insert_ending(current, "結末")
                break
            seen.add(canon_child)
            current = canon_child
        self.set_settings({"active_ending": target})
        self._resync_canon()
        self._resync_memory_orders(commit=False)
        self.conn.commit()

    def _insert_ending(self, parent_id: str, title: str) -> str:
        """parent_id の子として結末ノードを作る(アクティブ化は呼び出し側)。"""
        now = _now()
        ending_id = _new_id()
        self.conn.execute(
            "INSERT INTO nodes(id, title, beat, cast, status, kind, created_at, updated_at)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (ending_id, title, "", "[]", "draft", "ending", now, now),
        )
        self.conn.execute(
            "INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,0)",
            (_new_id(), parent_id, ending_id),
        )
        return ending_id

    def create_ending(self, parent_id: str, title: str | None = None,
                      activate: bool = True) -> dict[str, Any]:
        """シーンの先に新しい結末を作る(複数エンディングの入口)。"""
        if self.get_node(parent_id) is None:
            raise KeyError(f"node not found: {parent_id}")
        if self._node_kind(parent_id) is not None:
            raise ValueError("結末はシーンの先につないでください")
        ending_id = self._insert_ending(parent_id, (title or "").strip() or "結末")
        if activate:
            self.set_settings({"active_ending": ending_id})
            self._resync_canon()
            self._resync_memory_orders(commit=False)
        self.conn.commit()
        return self.get_node(ending_id)  # type: ignore[return-value]

    # 状態(fold)に効くノードフィールドは cast のみ(fold の入力は
    # parent_state / events / cast)。下記はプロンプト文面にしか効かないので、
    # 編集しても自ノードの清書が古くなるだけで、下流の状態・清書には影響しない。
    # status / target_chars はどちらにも効かない(status は canon 導出の表示、
    # target_chars は set_node_target_chars と同じ扱い)
    _PROMPT_ONLY_FIELDS = ("title", "beat", "emotional_core", "location", "story_time")

    def update_node(self, node_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if not row:
            return None
        current = dict(row)
        cast = data.get("cast")
        new_cast = json.dumps(cast, ensure_ascii=False) if cast is not None else current["cast"]
        cast_changed = new_cast != current["cast"]
        prompt_changed = any(
            data.get(f, current[f]) != current[f] for f in self._PROMPT_ONLY_FIELDS
        )
        # cast は状態に効くので、編集前の状態ハッシュを控えて early cutoff の比較に使う
        old_hash = fold_mod.state_hash(self.get_state(node_id)) if cast_changed else None
        self.conn.execute(
            """UPDATE nodes SET title = ?, beat = ?, emotional_core = ?, cast = ?,
               location = ?, story_time = ?, status = ?, target_chars = ?, updated_at = ?
               WHERE id = ?""",
            (
                data.get("title", current["title"]),
                data.get("beat", current["beat"]),
                data.get("emotional_core", current["emotional_core"]),
                new_cast,
                data.get("location", current["location"]),
                data.get("story_time", current["story_time"]),
                data.get("status", current["status"]),
                data.get("target_chars", current["target_chars"]),
                _now(),
                node_id,
            ),
        )
        if cast_changed:
            # 再 fold して状態が実際に変わったときだけ下流へ波及させる(early cutoff。
            # docs/design/chapters.md フェーズ A)。並べ替えや登場済みキャラの追加は
            # 状態が同じなので下流の清書を保てる。cast はプロンプトにも出るので
            # 自ノードの清書は常に stale
            new_hash = fold_mod.state_hash(self.get_state(node_id))
            if new_hash == old_hash:
                self.conn.execute("UPDATE renders SET stale = 1 WHERE node_id = ?", (node_id,))
            else:
                self.mark_dirty_downstream(node_id, commit=False)
            self._mark_digest_stale(node_id)
        elif prompt_changed:
            # 状態は変わらない。下流の清書は状態と直前散文にしか依存しないので保ち、
            # 自ノードの清書だけ古くなる(beat の誤字修正で全編 stale を防ぐ)
            self.conn.execute("UPDATE renders SET stale = 1 WHERE node_id = ?", (node_id,))
            # beat はまとめの生成材料なので、章のまとめには「要更新」を立てる
            self._mark_digest_stale(node_id)
        self.conn.commit()
        return self.get_node(node_id)

    def set_node_image(self, node_id: str, image_path: str | None) -> None:
        """シーン挿絵(装飾専用)。state に影響しないので dirty 化しない。

        差し替え・取り外しでサムネイルは意味を失うので同時に落とす(古いファイルは
        参照が外れるので gc_assets が回収する)。動画なら次の描画で作り直される。
        """
        self.conn.execute(
            "UPDATE nodes SET image_path = ?, thumb_path = NULL WHERE id = ?", (image_path, node_id)
        )
        self.conn.commit()

    def set_node_target_chars(self, node_id: str, target_chars: int | None) -> None:
        """このシーンだけの目安の字数(None / 0 = 共通の設定に従う)。

        清書のプロンプトにしか効かず state は変わらないので dirty 化しない。
        既存の清書も stale にしない(作り直すかどうかは作者が決める)。
        """
        value = int(target_chars) if target_chars else None
        self.conn.execute("UPDATE nodes SET target_chars = ? WHERE id = ?", (value, node_id))
        self.conn.commit()

    def set_node_thumb(self, node_id: str, thumb_path: str | None) -> None:
        """動画挿絵のサムネイル。構造モードのカードが動画をデコードしないために持つ。"""
        self.conn.execute(
            "UPDATE nodes SET thumb_path = ? WHERE id = ?", (thumb_path, node_id)
        )
        self.conn.commit()

    def assets_dir(self) -> str | None:
        """現在のライブラリの画像フォルダ(assets/images)。"""
        if not self.root:
            return None
        from pathlib import Path

        path = Path(self.root) / "assets" / "images"
        path.mkdir(parents=True, exist_ok=True)
        return str(path)

    def gc_assets(self) -> int:
        """assets/images 内の未参照ファイルを削除し、削除数を返す。

        挿絵・プロフィール画像の差し替え/取り外し/ノード・キャラ削除では
        DB の参照が外れるだけでファイルが残る。ブランチ複製などで同じファイルを
        複数レコードが参照し得るため、その場削除ではなくライブラリを開いた
        タイミングの GC でまとめて回収する。アップロード直後の未参照ウィンドウを
        守るため、直近1時間以内に作られたファイルは対象外にする。
        """
        import time
        from pathlib import Path

        assets = self.assets_dir()
        if assets is None:
            return 0
        referenced: set[str] = set()
        for sql in ASSET_REF_SQLS:
            for row in self.conn.execute(sql).fetchall():
                value = row[0]
                if value:
                    referenced.add(Path(value).name)
        # スナップショットが参照するファイルも守る(復元後に挿絵が消えないように)
        if self.root:
            import snapshots

            referenced |= snapshots.collect_asset_references(self.root, ASSET_REF_SQLS)
        removed = 0
        grace_limit = time.time() - 3600
        for f in Path(assets).iterdir():
            if not f.is_file() or f.name in referenced:
                continue
            try:
                if f.stat().st_mtime > grace_limit:
                    continue
                f.unlink()
                removed += 1
            except OSError:
                pass  # 使用中などで消せなくても致命的ではないので続行
        return removed

    def set_node_position(self, node_id: str, x: float | None, y: float | None) -> None:
        """キャンバス上の手動配置を保存する(state には影響しないので dirty 化しない)。"""
        self.conn.execute(
            "UPDATE nodes SET pos_x = ?, pos_y = ? WHERE id = ?", (x, y, node_id)
        )
        self.conn.commit()

    def set_node_positions(self, positions: list[tuple[str, float, float]]) -> int:
        """複数ノードの手動配置をまとめて保存する(1 トランザクション)。

        自動レイアウトのノードを「いま見えている位置」で固定するのに使う。
        存在しない ID は黙って無視する(戻り値は実際に更新した件数)。
        """
        updated = 0
        for node_id, x, y in positions:
            cur = self.conn.execute(
                "UPDATE nodes SET pos_x = ?, pos_y = ? WHERE id = ?", (x, y, node_id)
            )
            updated += cur.rowcount
        self.conn.commit()
        return updated

    def reset_positions(self) -> None:
        self.conn.execute("UPDATE nodes SET pos_x = NULL, pos_y = NULL")
        self.conn.commit()

    def delete_node(self, node_id: str) -> bool:
        """ノードを抜き取って削除する(親 → 子を直結し、そのシーンだけを消す)。

        - 途中のノードでも削除可。子はすべて親に付け替える(分岐構造は保つ)
        - 削除ノードが連鎖(canon)の子を持っていれば、そのエッジの is_canon を
          保ったまま親に付け替えるので正史はそのまま繋がる
        - 根を削除した場合、子はそれぞれ新しい根になる
        削除で下流の状態と正史順が変わるため、state_cache と memories を再同期する。
        """
        kind = self._node_kind(node_id)
        if kind == "start":
            raise ValueError("「はじまり」は削除できません")
        if kind == "ending":
            others = [
                r["id"]
                for r in self.conn.execute("SELECT id FROM nodes WHERE kind = 'ending' AND id != ?", (node_id,))
            ]
            if not others:
                raise ValueError("最後の結末は削除できません")
        if self.get_node(node_id) is None:
            return False
        self._mark_digest_stale(node_id)  # 章のメンバーを消すならまとめの材料が変わる(削除前に)
        parent_id = self.parent_of(node_id)
        parent_edge = self.conn.execute(
            "SELECT is_canon FROM edges WHERE to_node = ?", (node_id,)
        ).fetchone()
        child_ids = [
            r["to_node"]
            for r in self.conn.execute("SELECT to_node FROM edges WHERE from_node = ?", (node_id,))
        ]
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
        if parent_id is not None:
            if parent_edge and parent_edge["is_canon"]:
                # 連鎖の途中を抜く: 子エッジの is_canon をそのまま引き継いで正史を繋ぐ
                self.conn.execute(
                    "UPDATE edges SET from_node = ? WHERE from_node = ?", (parent_id, node_id)
                )
            else:
                # 分岐の根を抜く: 親には別の canon の子がいるので、付け替えエッジを
                # canon のまま持ち込むと正史が二重になる。draft に落として付け替える
                self.conn.execute(
                    "UPDATE edges SET from_node = ?, is_canon = 0 WHERE from_node = ?",
                    (parent_id, node_id),
                )
        else:
            # 根の削除: 子は根になるので親エッジを落とす
            self.conn.execute("DELETE FROM edges WHERE from_node = ?", (node_id,))
        self.conn.execute("DELETE FROM edges WHERE to_node = ?", (node_id,))
        self.conn.execute("DELETE FROM events WHERE node_id = ?", (node_id,))
        self.conn.execute("DELETE FROM state_cache WHERE node_id = ?", (node_id,))
        self.conn.execute("DELETE FROM renders WHERE node_id = ?", (node_id,))
        self.conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        for child_id in child_ids:
            self.mark_dirty_downstream(child_id, commit=False)
        # 消したのがアクティブな結末なら別の結末へ切り替わる(active_ending が自動補正)。
        # is_canon / status は導出キャッシュなので、繋ぎ替え後の正史で貼り直す
        self._ensure_active_ending_rooted()
        self._resync_canon()
        self._resync_memory_orders(commit=False)
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
        """ノードのイベント列を置換する。events の要素は {id?, type, payload, source?}。
        id を渡すと引き継ぐ(memory_compress.replaces / reasons の参照を壊さない)。"""
        # 章境界の cutoff 用に、編集前の章末尾の状態ハッシュを控える
        boundary = self._digest_boundary_for(node_id)
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
        self._mark_digest_stale(node_id)
        # 章境界の early cutoff: まとめ済みの章の中の編集で、章末尾の状態が
        # 変わらないなら(記憶の文面修正など。ID 引き継ぎが前提)、境界の先の
        # 入力は凍結された digest ごと変わらないので、清書の stale を章内に閉じる
        if boundary is not None and fold_mod.state_hash(self.get_state(boundary[0])) == boundary[1]:
            self._stale_renders_within_group(node_id)
        else:
            self.mark_dirty_downstream(node_id, commit=False)
        if commit:
            self.conn.commit()
        return self.list_events(node_id)

    def _sync_memories(self, node_id: str, commit: bool = True) -> None:
        """memory_add / memory_compress イベントから memories 行を再構築する(導出物)。

        story_order は正史パス上の位置。分岐ノードは -1(時間減衰では「現在」扱い)。
        memory_compress も行にする: fold が要約のイベント ID を state の memories に
        積むので、行が無いと圧縮後の記憶が検索から消えてしまう。
        必須フィールドを欠く payload は落とす(validation が警告する。ここで
        KeyError にすると置換の途中で止まり半端な書き込みが残る)。
        """
        path = self.canon_path()
        story_order = path.index(node_id) if node_id in path else -1
        for event in self.list_events(node_id):
            if event["type"] not in ("memory_add", "memory_compress"):
                continue
            p = event["payload"]
            content = p.get("content") if event["type"] == "memory_add" else p.get("summary")
            if not p.get("char") or not content:
                continue
            self.conn.execute(
                """INSERT OR REPLACE INTO memories(id, event_id, char_id, content, emotion, importance, story_order)
                   VALUES(?,?,?,?,?,?,?)""",
                (
                    event["id"],
                    event["id"],
                    p["char"],
                    content,
                    p.get("emotion"),
                    p.get("importance"),
                    story_order,
                ),
            )
            self._index_memory(event["id"], content)
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
            # vec0 仮想テーブルは版によって UPSERT 非対応なので DELETE → INSERT にする
            self.conn.execute("DELETE FROM memories_vec WHERE memory_id = ?", (memory_id,))
            self.conn.execute(
                "INSERT INTO memories_vec(memory_id, embedding) VALUES(?,?)",
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

    # ---- 章グループ(docs/design/chapters.md) -----------------------
    #
    # 章は「正史パス上の連続区間」へのラベル。実体ノードではなく、状態(fold)にも
    # 影響しないので、章の操作では dirty / stale を立てない。章ビューは表示のための
    # 導出で、真実はシーンノード + エッジ + nodes.group_id のまま。

    def list_groups(self) -> list[dict[str, Any]]:
        """章の一覧を返す(正史ルート上の章 → 島・分岐の章の順)。node_ids は鎖の順。

        章は「親子で一続きにつながったシーンの列」で、正史・分岐・島のどこにでも
        作れる(2026-08-01 一般化。on_canon で区別)。章ラベル(nodes.group_id)は
        切り離しや正史切替で**自動では消さない**。鎖が途切れている章は warning を
        付けて返し、UI がバッジで知らせる。つなぎ直せば章はそのまま復活する。
        """
        path = self.canon_path()
        order = {nid: i for i, nid in enumerate(path)}
        members: dict[str, list[str]] = {}
        for row in self.conn.execute("SELECT id, group_id FROM nodes WHERE group_id IS NOT NULL"):
            members.setdefault(row["group_id"], []).append(row["id"])
        result = []
        for gi, row in enumerate(self.conn.execute("SELECT * FROM groups ORDER BY created_at").fetchall()):
            all_ids = members.get(row["id"], [])
            if not all_ids:
                continue  # ラベルを持つノードが無い章は出さない(解除済み)
            # 鎖(親子)の順に並べる。深さ = ルートからの距離
            ordered = sorted(all_ids, key=lambda n: len(self.path_to(n)))
            warning: str | None = None
            for prev, cur in zip(ordered, ordered[1:]):
                if self.parent_of(cur) != prev:
                    warning = "章のシーンが一続きにつながっていません(つなぎ直すと直ります)"
                    break
            on_canon = all(n in order for n in ordered)
            result.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "color": row["color"],
                    "digest_stale": row["digest_stale"],
                    "has_digest": bool(row["digest_events"]),
                    "warning": warning,
                    "on_canon": on_canon,
                    "node_ids": ordered,
                    "_created": gi,
                }
            )
        # 正史ルート上の章は正史位置順、島・分岐の章はその後ろに作成順
        result.sort(key=lambda g: (0, order.get(g["node_ids"][0], 0)) if g["on_canon"] else (1, g["_created"]))
        for g in result:
            del g["_created"]
        return result

    def create_group(self, title: str, node_ids: list[str]) -> dict[str, Any]:
        """親子で一続きにつながったシーンの列を章にする(正史・分岐・島のどこでも可)。"""
        title = (title or "").strip()
        if not title:
            raise ValueError("章の名前を入力してください")
        if not node_ids:
            raise ValueError("章に入れるシーンがありません")
        unique_ids = list(dict.fromkeys(node_ids))
        for n in unique_ids:
            if self.get_node(n) is None:
                raise ValueError("存在しないシーンが含まれています")
            if self._node_kind(n) is not None:
                raise ValueError("はじまり / 結末は章に入れられません")
        # 鎖の検証: 深さ順に並べ、各シーンの親が直前のシーンであること
        ordered = sorted(unique_ids, key=lambda n: len(self.path_to(n)))
        for prev, cur in zip(ordered, ordered[1:]):
            if self.parent_of(cur) != prev:
                raise ValueError("章は親子で一続きにつながったシーンの並びにしてください")
        placeholders = ",".join("?" for _ in unique_ids)
        taken = self.conn.execute(
            f"SELECT id FROM nodes WHERE id IN ({placeholders}) AND group_id IS NOT NULL",
            unique_ids,
        ).fetchall()
        if taken:
            raise ValueError("既に別の章に属すシーンがあります(先に章から外してください)")
        group_id = _new_id()
        self.conn.execute(
            "INSERT INTO groups(id, title, color, created_at) VALUES(?,?,?,?)",
            (group_id, title, None, _now()),
        )
        self.conn.executemany(
            "UPDATE nodes SET group_id = ? WHERE id = ?", [(group_id, n) for n in ordered]
        )
        self.conn.commit()
        return next(g for g in self.list_groups() if g["id"] == group_id)

    def update_group(self, group_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
        if row is None:
            return None
        title = data.get("title", row["title"])
        if isinstance(title, str):
            title = title.strip() or row["title"]
        self.conn.execute(
            "UPDATE groups SET title = ?, color = ? WHERE id = ?",
            (title, data.get("color", row["color"]), group_id),
        )
        self.conn.commit()
        return next((g for g in self.list_groups() if g["id"] == group_id), None)

    def delete_group(self, group_id: str) -> None:
        """章を解除する(シーン自体はそのまま残る)。"""
        self.conn.execute("UPDATE nodes SET group_id = NULL WHERE group_id = ?", (group_id,))
        self.conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        self.conn.commit()

    def remove_node_from_group(self, node_id: str) -> None:
        """シーンを章から外す。途中を外すと章が非連続になるので、端(先頭か末尾)のみ。"""
        node = self.get_node(node_id)
        if node is None:
            raise KeyError(f"node not found: {node_id}")
        group_id = node.get("group_id")
        if not group_id:
            return
        group = next((g for g in self.list_groups() if g["id"] == group_id), None)
        if group and node_id not in (group["node_ids"][0], group["node_ids"][-1]):
            raise ValueError("章の途中のシーンは外せません(章が分断されます)。端から外してください")
        self.conn.execute("UPDATE nodes SET group_id = NULL WHERE id = ?", (node_id,))
        self.conn.commit()

    def move_group(self, group_id: str, after_group_id: str | None) -> list[dict[str, Any]]:
        """章(正史上の連続区間)を別の章の後ろへつなぎ替える(docs/design/chapters.md §8)。

        after_group_id=None は先頭(「はじまり」の直後)へ。章のシーンから生える
        分岐は一緒に移動する。並べ替えで前提(上流の文脈)が変わる章のまとめには
        「要更新」を立て、下流の状態・清書は stale にする。
        """
        groups = self.list_groups()
        me = next((g for g in groups if g["id"] == group_id), None)
        if me is None:
            raise KeyError(f"group not found: {group_id}")
        if after_group_id == group_id:
            raise ValueError("自分自身の後ろへは動かせません")
        if after_group_id is None:
            start = self.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()
            if start is None:
                raise ValueError("「はじまり」が見つかりません")
            anchor = start["id"]
        else:
            target = next((g for g in groups if g["id"] == after_group_id), None)
            if target is None:
                raise KeyError(f"group not found: {after_group_id}")
            if not target.get("on_canon"):
                raise ValueError("移動先は正史ルート上の章にしてください")
            anchor = target["node_ids"][-1]
        if me.get("warning"):
            raise ValueError(f"並べ替えできません: {me['warning']}")
        if not me.get("on_canon"):
            raise ValueError("並べ替えできるのは正史ルート上の章だけです(島・分岐の章は位置を動かすだけで足ります)")
        a_first, a_last = me["node_ids"][0], me["node_ids"][-1]
        if self.parent_of(a_first) == anchor:
            return groups  # 既にその位置
        # スプライス: (p → A → c) と (anchor → d) を (p → c) と (anchor → A → d) に
        e_in = self.conn.execute("SELECT id, from_node FROM edges WHERE to_node = ?", (a_first,)).fetchone()
        e_out = self.conn.execute(
            "SELECT id, to_node FROM edges WHERE from_node = ? AND is_canon = 1", (a_last,)
        ).fetchone()
        e_anchor = self.conn.execute(
            "SELECT id, to_node FROM edges WHERE from_node = ? AND is_canon = 1", (anchor,)
        ).fetchone()
        if e_in is None or e_out is None or e_anchor is None:
            raise ValueError("章のつなぎ替えに必要なエッジが見つかりません(正史が壊れている可能性)")
        successor = e_out["to_node"]
        self.conn.execute("UPDATE edges SET from_node = ? WHERE id = ?", (e_in["from_node"], e_out["id"]))
        self.conn.execute(
            "UPDATE edges SET from_node = ?, to_node = ?, is_canon = 1 WHERE id = ?",
            (anchor, a_first, e_in["id"]),
        )
        self.conn.execute("UPDATE edges SET from_node = ? WHERE id = ?", (a_last, e_anchor["id"]))
        # 前提(上流の文脈)が変わった位置から後ろの章のまとめに「要更新」を立てる
        new_canon = self.canon_path()
        order = {nid: i for i, nid in enumerate(new_canon)}
        affected_from = order.get(a_first, 0)
        if successor in order:
            affected_from = min(affected_from, order[successor])
        for g in self.list_groups():
            if order.get(g["node_ids"][0], 0) >= affected_from:
                self.conn.execute(
                    "UPDATE groups SET digest_stale = 1 WHERE id = ? AND digest_events IS NOT NULL",
                    (g["id"],),
                )
        self.mark_dirty_downstream(a_first, commit=False)
        if self._node_kind(successor) is None:
            self.mark_dirty_downstream(successor, commit=False)
        self._resync_canon()
        self._resync_memory_orders(commit=False)
        self.conn.commit()
        return self.list_groups()

    # ---- 章じまいのまとめ(digest。docs/design/chapters.md §3-4) -----
    #
    # digest は章末尾の「境界」で適用される memory_compress / fact_set のイベント列。
    # ノードの events とは別に groups.digest_events に持つ(「イベント作り直し」で
    # 消えないように)。fold へは get_state が章境界で合流させる。

    def get_group(self, group_id: str) -> dict[str, Any] | None:
        """list_groups のエントリ + digest_events(パース済み。無ければ None)。"""
        entry = next((g for g in self.list_groups() if g["id"] == group_id), None)
        if entry is None:
            return None
        row = self.conn.execute("SELECT digest_events FROM groups WHERE id = ?", (group_id,)).fetchone()
        entry["digest_events"] = json.loads(row["digest_events"]) if row and row["digest_events"] else None
        return entry

    def _digest_by_tail(self) -> dict[str, list[dict[str, Any]]]:
        """章末尾ノード ID → digest イベント列。get_state が章境界で適用する。"""
        rows = self.conn.execute(
            "SELECT id, digest_events FROM groups WHERE digest_events IS NOT NULL"
        ).fetchall()
        if not rows:
            return {}
        digests = {r["id"]: json.loads(r["digest_events"]) for r in rows}
        result: dict[str, list[dict[str, Any]]] = {}
        for g in self.list_groups():
            if g["id"] in digests and g["node_ids"]:
                result[g["node_ids"][-1]] = digests[g["id"]]
        return result

    def _mark_digest_stale(self, node_id: str) -> None:
        """章のメンバーが編集されたとき、その章のまとめに「要更新」を立てる
        (まとめが作られている章のみ)。commit は呼び出し側。"""
        row = self.conn.execute("SELECT group_id FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if row and row["group_id"]:
            self.conn.execute(
                "UPDATE groups SET digest_stale = 1 WHERE id = ? AND digest_events IS NOT NULL",
                (row["group_id"],),
            )

    def _digest_boundary_for(self, node_id: str) -> tuple[str, str] | None:
        """node_id が「まとめ済みの章」のメンバーなら(章末尾ノード, 現在の末尾状態ハッシュ)。
        編集の前に控えておき、編集後のハッシュと比較する(章境界の early cutoff)。"""
        node_row = self.conn.execute("SELECT group_id FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if not node_row or not node_row["group_id"]:
            return None
        group = self.get_group(node_row["group_id"])
        if not group or not group.get("digest_events") or not group["node_ids"]:
            return None
        tail = group["node_ids"][-1]
        try:
            return tail, fold_mod.state_hash(self.get_state(tail))
        except KeyError:
            return None

    def _stale_renders_within_group(self, node_id: str) -> None:
        """章内に閉じた編集の清書 stale(編集シーンから章末尾まで)。commit は呼び出し側。"""
        row = self.conn.execute("SELECT group_id FROM nodes WHERE id = ?", (node_id,)).fetchone()
        group = self.get_group(row["group_id"]) if row and row["group_id"] else None
        if group is None:
            return
        ids = group["node_ids"]
        start = ids.index(node_id) if node_id in ids else 0
        self.conn.executemany(
            "UPDATE renders SET stale = 1 WHERE node_id = ?", [(n,) for n in ids[start:]]
        )

    def save_group_digest(self, group_id: str, events: list[dict[str, Any]]) -> dict[str, Any]:
        """章のまとめを保存する。内容が実際に変わったときだけ下流(次章側)へ波及する。"""
        group = self.get_group(group_id)
        if group is None:
            raise KeyError(f"group not found: {group_id}")
        prepared: list[dict[str, Any]] = []
        for e in events:
            if e.get("type") not in ("memory_compress", "fact_set"):
                raise ValueError(f"まとめに使えるイベント型ではありません: {e.get('type')}")
            prepared.append({"id": e.get("id") or _new_id(), "type": e["type"], "payload": e["payload"]})
        old = group.get("digest_events") or []
        changed = fold_mod.canonical_json(prepared) != fold_mod.canonical_json(old)
        self.conn.execute(
            "UPDATE groups SET digest_events = ?, digest_stale = 0 WHERE id = ?",
            (json.dumps(prepared, ensure_ascii=False) if prepared else None, group_id),
        )
        self._sync_digest_memories(group, old, prepared)
        if changed:
            self._propagate_from_boundary(group)
        self.conn.commit()
        return self.get_group(group_id)  # type: ignore[return-value]

    def delete_group_digest(self, group_id: str) -> dict[str, Any]:
        """まとめを削除する(章は残る)。下流は生の状態に戻るので波及する。"""
        group = self.get_group(group_id)
        if group is None:
            raise KeyError(f"group not found: {group_id}")
        old = group.get("digest_events") or []
        if old:
            self.conn.execute(
                "UPDATE groups SET digest_events = NULL, digest_stale = 0 WHERE id = ?", (group_id,)
            )
            self._sync_digest_memories(group, old, [])
            self._propagate_from_boundary(group)
            self.conn.commit()
        return self.get_group(group_id)  # type: ignore[return-value]

    def _sync_digest_memories(
        self,
        group: dict[str, Any],
        old_events: list[dict[str, Any]],
        new_events: list[dict[str, Any]],
    ) -> None:
        """digest の memory_compress を memories 行 + 索引に同期する(検索・表示用)。
        digest はノードの events に居ないので _sync_memories とは別に面倒を見る。"""
        old_ids = [e["id"] for e in old_events if e.get("type") == "memory_compress"]
        if old_ids:
            self.conn.executemany("DELETE FROM memories WHERE id = ?", [(i,) for i in old_ids])
            self._remove_memory_index(old_ids)
        path = self.canon_path()
        tail = group["node_ids"][-1] if group["node_ids"] else None
        story_order = path.index(tail) if tail in path else -1
        for e in new_events:
            if e.get("type") != "memory_compress":
                continue
            p = e["payload"]
            if not p.get("char") or not p.get("summary"):
                continue
            self.conn.execute(
                """INSERT OR REPLACE INTO memories(id, event_id, char_id, content, emotion, importance, story_order)
                   VALUES(?,?,?,?,?,?,?)""",
                (e["id"], e["id"], p["char"], p["summary"], p.get("emotion"), p.get("importance"), story_order),
            )
            self._index_memory(e["id"], p["summary"])

    def _propagate_from_boundary(self, group: dict[str, Any]) -> None:
        """まとめの変更を、章の次のノード(境界の先)から下流へ波及させる。
        章の中は生の状態のままなので触らない。commit は呼び出し側。"""
        if not group["node_ids"]:
            return
        tail = group["node_ids"][-1]
        path = self.canon_path()
        if tail in path:
            idx = path.index(tail)
            if idx + 1 < len(path):
                self.mark_dirty_downstream(path[idx + 1], commit=False)
        # 章末尾から生える分岐(draft)にも digest は効くので、そちらへも波及させる
        for row in self.conn.execute(
            "SELECT to_node FROM edges WHERE from_node = ? AND is_canon = 0", (tail,)
        ):
            self.mark_dirty_downstream(row["to_node"], commit=False)

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
        digests = self._digest_by_tail()
        state = fold_mod.empty_state()
        parent_hash = fold_mod.state_hash(state)
        prev: str | None = None
        for nid in path:
            events = self.list_events(nid)
            # 章境界: 直前のノードが「まとめ済みの章」の末尾なら、その章のまとめ
            # (digest)をこのノードのイベントの前に合流させる。章の中は生のまま、
            # 境界の先から記憶が要約に置き換わる(docs/design/chapters.md §4)。
            # events_hash に含まれるので、まとめが変われば下流は自然に再 fold される
            digest = digests.get(prev) if prev is not None else None
            if digest:
                events = [*digest, *events]
            node = self.get_node(nid)
            cast = node["cast"] if node else []
            ihash = fold_mod.input_hash(parent_hash, fold_mod.events_hash(events), cast)
            cached = self.conn.execute(
                "SELECT state, input_hash, dirty FROM state_cache WHERE node_id = ?", (nid,)
            ).fetchone()
            if cached and not cached["dirty"] and cached["input_hash"] == ihash:
                state = json.loads(cached["state"])
            else:
                state = fold_mod.fold(state, events, cast)
                self.conn.execute(
                    "INSERT OR REPLACE INTO state_cache(node_id, state, input_hash, dirty) VALUES(?,?,?,0)",
                    (nid, fold_mod.canonical_json(state), ihash),
                )
            parent_hash = fold_mod.state_hash(state)
            prev = nid
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

    @staticmethod
    def _render_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        """renders の行を dict にする。meta / prompt_messages(JSON 文字列)は
        オブジェクトに戻して返す(API からそのままフロントへ渡すため)。"""
        if row is None:
            return None
        render = dict(row)
        for key in ("meta", "prompt_messages"):
            if render.get(key):
                try:
                    render[key] = json.loads(render[key])
                except (TypeError, json.JSONDecodeError):
                    render[key] = None
        return render

    def latest_render(self, node_id: str, preset_id: str, pov_char: str | None) -> dict[str, Any] | None:
        row = self.conn.execute(
            """SELECT * FROM renders WHERE node_id = ? AND preset_id = ? AND pov_char IS ?
               ORDER BY created_at DESC LIMIT 1""",
            (node_id, preset_id, pov_char),
        ).fetchone()
        return self._render_row(row)

    def save_render(
        self,
        node_id: str,
        preset_id: str,
        pov_char: str | None,
        prose: str,
        meta: dict[str, Any] | None = None,
        prompt_messages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        render_id = _new_id()
        self.conn.execute(
            "INSERT INTO renders(id, node_id, preset_id, pov_char, prose, stale, created_at, meta, prompt_messages)"
            " VALUES(?,?,?,?,?,0,?,?,?)",
            (
                render_id,
                node_id,
                preset_id,
                pov_char,
                prose,
                _now(),
                json.dumps(meta, ensure_ascii=False) if meta else None,
                json.dumps(prompt_messages, ensure_ascii=False) if prompt_messages else None,
            ),
        )
        self.conn.commit()
        return self._render_row(self.conn.execute("SELECT * FROM renders WHERE id = ?", (render_id,)).fetchone())

    def list_renders(self, preset_id: str, pov_char: str | None) -> list[dict[str, Any]]:
        """正史パス順に各ノードの最新レンダーを返す(無ければ render: None)。"""
        result = []
        for nid in self.canon_path():
            node = self.get_node(nid)
            result.append({"node": node, "render": self.latest_render(nid, preset_id, pov_char)})
        return result

    # ---- 相談チャット -----------------------------------------------

    def create_chat(
        self,
        anchor_node: str | None,
        scope: str,
        char_id: str | None = None,
        mode: str | None = None,
    ) -> dict[str, Any]:
        chat_id = _new_id()
        now = _now()
        self.conn.execute(
            "INSERT INTO chats(id, anchor_node, scope, char_id, mode, messages, created_at, updated_at)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (chat_id, anchor_node, scope, char_id, mode, "[]", now, now),
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
            char = self.get_character(row["char_id"]) if row["char_id"] else None
            chats.append(
                {
                    "id": row["id"],
                    "anchor_node": row["anchor_node"],
                    "anchor_title": anchor["title"] if anchor else None,
                    "scope": row["scope"],
                    "char_id": row["char_id"],
                    "char_name": char["name"] if char else None,
                    "mode": row["mode"],
                    "title": row["title"],
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

    def delete_chat_turn(self, chat_id: str, index: int, keep_user: bool) -> dict[str, Any] | None:
        """1 往復(user 発言 + それに続く assistant / tool)を履歴から取り除く。

        keep_user=True なら user 発言は残し、返事だけを消す(再生成の下準備)。
        index は user 発言の位置。ツール上限の内部指示(user ロール)は往復の
        区切りとして扱わない。
        """
        chat = self.get_chat(chat_id)
        if chat is None:
            return None
        messages = list(chat["messages"])
        if not (0 <= index < len(messages)) or messages[index].get("role") != "user":
            return None
        end = index + 1
        while end < len(messages) and not _is_turn_start(messages[end]):
            end += 1
        head = messages[: index + 1] if keep_user else messages[:index]
        self.save_chat_messages(chat_id, head + messages[end:])
        return self.get_chat(chat_id)

    def set_chat_title(self, chat_id: str, title: str | None) -> dict[str, Any] | None:
        """会話名を設定する(空文字は NULL = 冒頭の発言を見出しに使う)。"""
        cleaned = (title or "").strip() or None
        self.conn.execute("UPDATE chats SET title = ? WHERE id = ?", (cleaned, chat_id))
        self.conn.commit()
        return self.get_chat(chat_id)

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
