"""手動編集と制作ツールが共用する、シーンの書き込みと検証。

LLM待機中はここを呼ばない。同期の短い適用区間だけを一つのトランザクションにする。
Store内部のcommit(get_stateを含む)はこの区間だけ保留する。
スナップショットは呼び出し側が操作／作業の開始時に保存し、音声GCは削除後に予約する。
"""

from contextlib import contextmanager
from copy import copy
from typing import Any

from store import Store


class _DeferredCommit:
    def __init__(self, conn):
        self.conn = conn

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def commit(self):
        pass


@contextmanager
def atomic_store(store: Store):
    # 元のStoreは差し替えず、同期処理専用の浅いコピーに接続のラッパーを渡す。
    tx = copy(store)
    tx.conn = _DeferredCommit(store.conn)
    store.conn.execute("SAVEPOINT node_operation")
    try:
        yield tx
    except BaseException:
        store.conn.execute("ROLLBACK TO node_operation")
        store.conn.execute("RELEASE node_operation")
        raise
    else:
        store.conn.execute("RELEASE node_operation")


def insert(store: Store, after_id: str, data: dict[str, Any], events=None, *, source="user"):
    with atomic_store(store) as tx:
        node = tx.insert_node_after(after_id, data, events, source=source)
        node["validation"] = tx.validate(node["id"])
    return node


def update(store: Store, node_id: str, data: dict[str, Any], events=None):
    with atomic_store(store) as tx:
        node = tx.update_node(node_id, data)
        if node is None:
            raise KeyError(f"node not found: {node_id}")
        if events is not None:
            tx.replace_events(node_id, events, source="llm")
        node = tx.get_node(node_id)
        node["validation"] = tx.validate(node_id)
    return node


def delete(store: Store, node_id: str):
    with atomic_store(store) as tx:
        if not tx.delete_node(node_id):
            raise KeyError(f"node not found: {node_id}")


def _check_connections(graph):
    """親は1つ、循環なし、章への出入りはマーカー経由。"""
    nodes = {n["id"]: n for n in graph["nodes"]}
    parents = {}
    for edge in graph["edges"]:
        parent, child = edge["from_node"], edge["to_node"]
        if child in parents:
            raise ValueError(f"多重親になります: {child}")
        parents[child] = parent
        a, b = nodes[parent], nodes[child]
        if a["kind"] == "ending" or b["kind"] == "start":
            raise ValueError("はじまり・結末の接続方向が不正です")
        if a.get("group_id") != b.get("group_id"):
            if a.get("group_id") and a["kind"] != "chapter_out":
                raise ValueError("章の外への接続は出口を通る必要があります")
            if b.get("group_id") and b["kind"] != "chapter_in":
                raise ValueError("章の中への接続は入口を通る必要があります")
    done = set()
    for node_id in nodes:
        path = set()
        current = node_id
        while current is not None and current not in done:
            if current in path:
                raise ValueError("循環する接続は作れません")
            path.add(current)
            current = parents.get(current)
        done.update(path)


def reconnect(store: Store, node_id: str, parent_id: str, mode: str):
    """本文とイベントを保持した移動。途中の切断状態を公開せず、まとめて確定する。"""
    import uuid
    with atomic_store(store) as tx:
        node, parent = tx.get_node(node_id), tx.get_node(parent_id)
        if node is None or parent is None:
            raise ValueError("移動するシーンまたは移動先がありません")
        if node["kind"] is not None:
            raise ValueError("はじまり・結末・章の境界は移動できません")
        if parent["kind"] == "ending" or node_id == parent_id:
            raise ValueError("自分自身や結末の直後へは移動できません")
        if mode not in ("scene", "branch"):
            raise ValueError("modeはscene（1シーン）かbranch（枝ごと）を指定してください")
        before = tx.graph()
        ending = tx.active_ending()
        ending_was_rooted = ending is not None and tx._ending_is_rooted(ending)
        old_parent = tx.parent_of(node_id)
        if old_parent == parent_id:
            raise ValueError("すでに指定したシーンの直後です")
        if mode == "branch":
            tx.attach_node(parent_id, node_id, replace_parent=True)
        else:
            # 元の場所は子を親へつなぎ直し、シーン自体だけを取り出す。
            tx.conn.execute("DELETE FROM edges WHERE to_node = ?", (node_id,))
            if old_parent is None:
                tx.conn.execute("DELETE FROM edges WHERE from_node = ?", (node_id,))
            else:
                tx.conn.execute("UPDATE edges SET from_node = ? WHERE from_node = ?", (old_parent, node_id))
            children = list(tx.conn.execute("SELECT * FROM edges WHERE from_node = ?", (parent_id,)))
            next_edge = next((e for e in children if e["is_canon"]), None)
            if next_edge is None and len(children) == 1:
                next_edge = children[0]
            if next_edge is None and len(children) > 1:
                raise ValueError("移動先に複数の枝があります。挿入する経路が一意に決まりません")
            if next_edge is not None:
                tx.conn.execute("UPDATE edges SET from_node = ? WHERE id = ?", (node_id, next_edge["id"]))
            tx.conn.execute("INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,?)",
                            (uuid.uuid4().hex[:12], parent_id, node_id, next_edge["is_canon"] if next_edge else 0))
            group_id = None if parent["kind"] == "chapter_out" else parent["group_id"]
            tx.conn.execute("UPDATE nodes SET group_id = ? WHERE id = ?", (group_id, node_id))
        after = tx.graph()
        _check_connections(after)
        if ending_was_rooted and not tx._ending_is_rooted(ending):
            raise ValueError("正史の結末がはじまりから切り離される移動はできません")
        if {n["id"] for n in before["nodes"]} != {n["id"] for n in after["nodes"]}:
            raise ValueError("つなぎ替えでシーンや結末を増減できません")
        edge_set = lambda g: {(e["from_node"], e["to_node"]) for e in g["edges"]}
        changed = edge_set(before) ^ edge_set(after)
        if not changed:
            raise ValueError("接続は変更されていません")
        # 親が変わった地点から下流を再計算し、旧章・新章のまとめも古くする。
        affected = {node_id} | {n for e in changed for n in e}
        groups = {n["group_id"] for g in (before, after) for n in g["nodes"] if n["id"] in affected and n["group_id"]}
        for group_id in groups:
            tx._mark_group_digest_stale(group_id)
        for nid in affected:
            tx.mark_dirty_downstream(nid, commit=False)
        tx._resync_canon()
        tx._resync_memory_orders(commit=False)
        _check_connections(tx.graph())
        layout_ids = tx.subtree_order(node_id) if mode == "branch" else [node_id]
        tx.conn.executemany("UPDATE nodes SET pos_x = NULL, pos_y = NULL WHERE id = ?", [(nid,) for nid in layout_ids])
        return {"old_parent_id": old_parent, "parent_id": tx.parent_of(node_id), "mode": mode,
                "affected_ids": sorted(affected),
                "old_parent_title": (tx.get_node(old_parent) or {}).get("title") if old_parent else None,
                "parent_title": tx.get_node(tx.parent_of(node_id)).get("title")}
