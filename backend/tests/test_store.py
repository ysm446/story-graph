import pytest

import db
from store import Store


@pytest.fixture
def store():
    return Store(db.connect(":memory:"))


def _setup_chars(store):
    aya = store.create_character({"name": "アヤ", "id": "aya"})
    ken = store.create_character({"name": "ケン", "id": "ken"})
    return aya, ken


def _intro_events(*chars):
    return [{"type": "char_introduce", "payload": {"char": c}} for c in chars]


def test_character_crud(store):
    char = store.create_character({"name": "アヤ", "profile": "勝気"})
    assert store.get_character(char["id"])["name"] == "アヤ"
    store.update_character(char["id"], {"voice": "俺っ子"})
    assert store.get_character(char["id"])["voice"] == "俺っ子"
    store.delete_character(char["id"])
    assert store.get_character(char["id"]) is None


def test_timeline_is_single_line(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "出会い", "cast": ["aya", "ken"]}, _intro_events("aya", "ken"))
    n2 = store.append_node({"beat": "橋での対峙", "cast": ["aya", "ken"]})
    path = store.canon_path()
    assert path == [n1["id"], n2["id"]]


def test_state_folds_along_path(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "出会い", "cast": ["aya", "ken"]}, _intro_events("aya", "ken") + [
        {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": 0.4, "reason": "第一印象"}},
    ])
    n2 = store.append_node({"beat": "裏切り", "cast": ["aya", "ken"]}, [
        {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": -0.9, "reason": "裏切り"}},
    ])
    s1 = store.get_state(n1["id"])
    s2 = store.get_state(n2["id"])
    assert s1["chars"]["aya"]["relationships"]["ken"]["score"] == pytest.approx(0.4)
    assert s2["chars"]["aya"]["relationships"]["ken"]["score"] == pytest.approx(-0.5)


def test_state_cache_dirty_propagation(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya") + [
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "村"}},
    ])
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    store.get_state(n2["id"])  # キャッシュを温める
    cached = store.conn.execute("SELECT dirty FROM state_cache WHERE node_id = ?", (n2["id"],)).fetchone()
    assert cached["dirty"] == 0
    # 上流のイベントを書き換えると下流が dirty になり、再fold で新しい値が出る
    store.replace_events(n1["id"], _intro_events("aya") + [
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "城"}},
    ])
    cached = store.conn.execute("SELECT dirty FROM state_cache WHERE node_id = ?", (n2["id"],)).fetchone()
    assert cached["dirty"] == 1
    assert store.get_state(n2["id"])["chars"]["aya"]["facts"]["location"] == "城"


def test_validation_rejects_retired_and_unintroduced(store):
    _setup_chars(store)
    store.append_node({"beat": "b1", "cast": ["aya", "ken"]}, _intro_events("aya", "ken"))
    store.append_node({"beat": "ケン死亡", "cast": ["aya", "ken"]}, [
        {"type": "char_retire", "payload": {"char": "ken", "reason": "death"}},
    ])
    n3 = store.append_node({"beat": "亡霊のように登場", "cast": ["ken", "mob"]})
    errors = store.validate(n3["id"])
    assert any("退場済み" in e for e in errors)
    assert any("未登録" in e for e in errors)


def test_validation_allows_introduce_in_same_node(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "初登場", "cast": ["aya"]}, _intro_events("aya"))
    assert store.validate(n1["id"]) == []


def test_memories_index_rebuilt_from_events(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya") + [
        {"type": "memory_add", "payload": {"char": "aya", "content": "村が焼けた", "emotion": -0.9, "importance": 1.0, "refs": []}},
    ])
    rows = store.conn.execute("SELECT * FROM memories WHERE char_id = 'aya'").fetchall()
    assert len(rows) == 1
    assert rows[0]["content"] == "村が焼けた"
    assert rows[0]["story_order"] == 0
    # イベント置換で行も置き換わる
    store.replace_events(n1["id"], _intro_events("aya"))
    rows = store.conn.execute("SELECT * FROM memories WHERE char_id = 'aya'").fetchall()
    assert rows == []


def test_delete_only_tail(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": []})
    n2 = store.append_node({"beat": "b2", "cast": []})
    assert store.delete_tail_node(n1["id"]) is False
    assert store.delete_tail_node(n2["id"]) is True
    assert store.canon_path() == [n1["id"]]
