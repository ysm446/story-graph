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
