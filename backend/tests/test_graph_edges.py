"""エッジの切断・接続(島の切り出しと繋ぎ直し)"""
import pytest

import db
import embed
from store import Store


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    for i, title in enumerate(["第一話", "第二話", "第三話"]):
        s.append_node({"beat": f"出来事{i}", "cast": ["aya"], "title": title})
    return s


def test_detach_makes_island(store):
    path = store.canon_path()
    assert len(path) == 3
    assert store.detach_node(path[1]) is True
    # 正史は切った手前まで、切った先は独立した島(内部の繋がりは維持)
    assert store.canon_path() == [path[0]]
    assert store.parent_of(path[1]) is None
    assert store.parent_of(path[2]) == path[1]
    # 島は正史から外れるので draft になる
    assert store.get_node(path[1])["status"] == "draft"
    assert store.get_node(path[0])["status"] == "canon"


def test_detach_root_is_noop(store):
    assert store.detach_node(store.canon_path()[0]) is False


def test_island_folds_from_its_own_root(store):
    path = store.canon_path()
    store.detach_node(path[1])
    # 島の根は親がいないので、適用前の状態は空
    assert store.state_before(path[1])["chars"] == {}


def test_attach_reconnects_island(store):
    path = store.canon_path()
    store.detach_node(path[1])
    store.attach_node(path[0], path[1], as_canon=True)
    assert store.canon_path() == path
    assert store.get_node(path[2])["status"] == "canon"


def test_attach_rejects_multi_parent_and_cycle(store):
    path = store.canon_path()
    with pytest.raises(ValueError):  # 既に親がいる
        store.attach_node(path[0], path[2])
    store.detach_node(path[1])
    with pytest.raises(ValueError):  # 自分の下流には繋げない
        store.attach_node(path[2], path[1])
    with pytest.raises(ValueError):  # 自分自身
        store.attach_node(path[1], path[1])


def test_attach_as_draft_keeps_canon(store):
    path = store.canon_path()
    store.detach_node(path[1])
    store.attach_node(path[0], path[1], as_canon=False)
    assert store.canon_path() == [path[0]]  # 正史は伸びない
    assert store.get_node(path[1])["status"] == "draft"


def test_subtree_order_is_parent_first(store):
    path = store.canon_path()
    branch = store.append_node({"beat": "分岐", "cast": ["aya"], "title": "if"}, parent_id=path[1])
    order = store.subtree_order(path[1])
    assert order[0] == path[1]
    assert set(order) == {path[1], path[2], branch["id"]}
