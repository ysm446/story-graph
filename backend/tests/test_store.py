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


def test_delete_only_leaf(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": []})
    n2 = store.append_node({"beat": "b2", "cast": []})
    assert store.delete_leaf_node(n1["id"]) is False
    assert store.delete_leaf_node(n2["id"]) is True
    assert store.canon_path() == [n1["id"]]


def test_branch_creation_and_state_isolation(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya") + [
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "村"}},
    ])
    n2 = store.append_node({"beat": "正史: 街へ", "cast": ["aya"]}, [
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "街"}},
    ])
    # n1 から分岐(what-if): 山へ
    b1 = store.append_node({"beat": "分岐: 山へ", "cast": ["aya"]}, [
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "山"}},
    ], parent_id=n1["id"])
    assert b1["status"] == "draft"
    assert store.canon_path() == [n1["id"], n2["id"]]
    assert store.path_to(b1["id"]) == [n1["id"], b1["id"]]
    # 状態は独立: 正史側は街、分岐側は山
    assert store.get_state(n2["id"])["chars"]["aya"]["facts"]["location"] == "街"
    assert store.get_state(b1["id"])["chars"]["aya"]["facts"]["location"] == "山"


def test_make_canon_switches_path_and_status(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya"))
    n2 = store.append_node({"beat": "旧正史", "cast": ["aya"]}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "旧正史の記憶"}},
    ])
    b1 = store.append_node({"beat": "新ルート", "cast": ["aya"]}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "新ルートの記憶"}},
    ], parent_id=n1["id"])
    store.make_canon(b1["id"])
    assert store.canon_path() == [n1["id"], b1["id"]]
    assert store.get_node(b1["id"])["status"] == "canon"
    assert store.get_node(n2["id"])["status"] == "draft"
    # story_order も付け替わる(正史から外れた記憶は -1)
    orders = {r["content"]: r["story_order"] for r in store.conn.execute("SELECT * FROM memories")}
    assert orders["新ルートの記憶"] == 1
    assert orders["旧正史の記憶"] == -1


def test_extend_from_branch_and_make_canon(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya"))
    n2 = store.append_node({"beat": "正史側", "cast": ["aya"]})
    b1 = store.append_node({"beat": "分岐", "cast": ["aya"]}, parent_id=n1["id"])
    assert b1["status"] == "draft"
    # 分岐の先に伸ばす(b1 に canon の子は居ないので、b1 の線内では延長)
    b2 = store.append_node({"beat": "分岐の続き", "cast": ["aya"]}, parent_id=b1["id"])
    assert store.path_to(b2["id"]) == [n1["id"], b1["id"], b2["id"]]
    # 正史は n1 → n2 のまま(n1 → b1 が canon でないため)
    assert store.canon_path() == [n1["id"], n2["id"]]
    store.make_canon(b2["id"])
    assert store.canon_path() == [n1["id"], b1["id"], b2["id"]]
    assert store.get_node(n2["id"])["status"] == "draft"
