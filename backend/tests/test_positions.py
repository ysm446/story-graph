import pytest

import db
from store import Store


@pytest.fixture
def store():
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    return s


def test_position_save_and_reset(store):
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    assert n1["pos_x"] is None
    store.set_node_position(n1["id"], 120.5, -40.0)
    node = store.get_node(n1["id"])
    assert (node["pos_x"], node["pos_y"]) == (120.5, -40.0)
    store.reset_positions()
    assert store.get_node(n1["id"])["pos_x"] is None


def test_set_node_positions_bulk(store):
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    n2 = store.append_node({"beat": "b2", "cast": ["aya"], "parent_id": n1["id"]})
    updated = store.set_node_positions(
        [(n1["id"], 0.0, 0.0), (n2["id"], 344.0, 56.0), ("missing", 1.0, 1.0)]
    )
    assert updated == 2  # 存在しない ID は黙って無視する
    assert (store.get_node(n1["id"])["pos_x"], store.get_node(n1["id"])["pos_y"]) == (0.0, 0.0)
    assert (store.get_node(n2["id"])["pos_x"], store.get_node(n2["id"])["pos_y"]) == (344.0, 56.0)


def test_position_does_not_dirty_state_or_renders(store):
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    store.get_state(n1["id"])  # キャッシュを温める
    preset = store.list_presets()[0]
    store.save_render(n1["id"], preset["id"], None, "本文")
    store.set_node_position(n1["id"], 10, 10)
    cached = store.conn.execute(
        "SELECT dirty FROM state_cache WHERE node_id = ?", (n1["id"],)
    ).fetchone()
    assert cached["dirty"] == 0
    assert store.latest_render(n1["id"], preset["id"], None)["stale"] == 0
