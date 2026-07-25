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


def test_insert_node_after_splices_into_canon(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "出会い", "cast": ["aya", "ken"]}, _intro_events("aya", "ken"))
    n3 = store.append_node({"beat": "決着", "cast": ["aya", "ken"]})
    # n1 と n3 の間に割り込ませる
    n2 = store.insert_node_after(n1["id"], {"beat": "同じ頃、村では", "cast": ["aya"]})
    assert store.canon_path() == [n1["id"], n2["id"], n3["id"]]
    assert n2["status"] == "canon"
    # 下流の状態は挿入シーンのイベントを含んで再計算される
    n2b = store.insert_node_after(n1["id"], {"beat": "評価の変化", "cast": ["aya", "ken"]},
                                  [{"type": "relationship_update",
                                    "payload": {"char": "aya", "target": "ken", "delta": 0.4, "reason": "再会"}}])
    assert store.canon_path() == [n1["id"], n2b["id"], n2["id"], n3["id"]]
    s3 = store.get_state(n3["id"])
    assert s3["chars"]["aya"]["relationships"]["ken"]["score"] == pytest.approx(0.4)


def test_insert_node_after_tail_appends(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "出会い", "cast": ["aya"]}, _intro_events("aya"))
    # 後続が無い末尾への挿入は通常の追加と同じ
    n2 = store.insert_node_after(n1["id"], {"beat": "続き", "cast": ["aya"]})
    assert store.canon_path() == [n1["id"], n2["id"]]


def test_insert_node_after_keeps_branches_on_parent(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "出会い", "cast": ["aya"]}, _intro_events("aya"))
    n2 = store.append_node({"beat": "続き", "cast": ["aya"]})
    branch = store.append_node({"beat": "if 展開", "cast": ["aya"]}, parent_id=n1["id"], force_draft=True)
    mid = store.insert_node_after(n1["id"], {"beat": "間のシーン", "cast": ["aya"]})
    assert store.canon_path() == [n1["id"], mid["id"], n2["id"]]
    # 分岐エッジは n1 に付いたまま(挿入ノードの下に移動しない)
    row = store.conn.execute(
        "SELECT from_node FROM edges WHERE to_node = ?", (branch["id"],)
    ).fetchone()
    assert row["from_node"] == n1["id"]


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


def test_cast_auto_introduces_new_chars(store):
    _setup_chars(store)
    # イベントなしで cast だけ指定 → char_introduce が自動追加され警告なし
    n1 = store.append_node({"beat": "初登場", "cast": ["aya", "ken"]})
    types = [e["type"] for e in n1["events"]]
    assert types == ["char_introduce", "char_introduce"]
    assert store.validate(n1["id"]) == []
    # cast 追加の編集でも自動付与される
    store.create_character({"name": "ミオ", "id": "mio"})
    n2 = store.append_node({"beat": "続き", "cast": ["aya"]})
    updated = store.update_node(n2["id"], {"cast": ["aya", "mio"]})
    intro_chars = [e["payload"]["char"] for e in updated["events"] if e["type"] == "char_introduce"]
    assert intro_chars == ["mio"]  # aya は登場済みなので追加されない
    assert store.validate(n2["id"]) == []


def test_cast_does_not_resurrect_retired(store):
    _setup_chars(store)
    store.append_node({"beat": "b1", "cast": ["aya", "ken"]})
    store.append_node({"beat": "ケン死亡", "cast": ["aya", "ken"]}, [
        {"type": "char_retire", "payload": {"char": "ken", "reason": "death"}},
    ])
    n3 = store.append_node({"beat": "その後", "cast": ["aya", "ken"]})
    # 退場済みキャラには char_introduce を自動追加しない(警告に任せる)
    assert [e for e in n3["events"] if e["type"] == "char_introduce"] == []
    assert any("退場済み" in v for v in store.validate(n3["id"]))


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


def test_delete_leaf_and_missing(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": []})
    n2 = store.append_node({"beat": "b2", "cast": []})
    assert store.delete_node(n2["id"]) is True
    assert store.canon_path() == [n1["id"]]
    assert store.delete_node("nonexistent") is False


def test_delete_middle_node_splices_out(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "出会い", "cast": ["aya", "ken"]}, _intro_events("aya", "ken"))
    n2 = store.append_node({"beat": "誤解", "cast": ["aya", "ken"]}, [
        {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": -0.6, "reason": "誤解"}},
    ])
    n3 = store.append_node({"beat": "決着", "cast": ["aya", "ken"]})
    # 途中の n2 を抜き取ると n1 → n3 が直結する
    assert store.delete_node(n2["id"]) is True
    assert store.canon_path() == [n1["id"], n3["id"]]
    # 抜いたシーンのイベントは下流の状態から消える
    s3 = store.get_state(n3["id"])
    assert "ken" not in s3["chars"]["aya"]["relationships"]


def test_delete_fork_node_reattaches_all_children(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya"))
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    n3 = store.append_node({"beat": "b3", "cast": ["aya"]})
    branch = store.append_node({"beat": "if 展開", "cast": ["aya"]}, parent_id=n2["id"], force_draft=True)
    # 分岐点 n2 を抜くと、連鎖の子(n3)も分岐の子(branch)も n1 に付け替わる
    assert store.delete_node(n2["id"]) is True
    assert store.canon_path() == [n1["id"], n3["id"]]
    assert store.parent_of(branch["id"]) == n1["id"]
    assert store.get_node(branch["id"])["status"] == "draft"


def test_delete_root_makes_children_roots(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya"))
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    assert store.delete_node(n1["id"]) is True
    assert store.parent_of(n2["id"]) is None
    assert store.canon_path() == [n2["id"]]


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
