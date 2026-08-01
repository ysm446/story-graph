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


def test_detach_first_scene_now_allowed(store):
    """最初のシーンにも親(「はじまり」)が居るので島にできる(結末方式で変更)。
    アクティブな結末ごと切り離した場合は、はじまり側に結末が作り直される。"""
    path = store.canon_path()
    assert store.detach_node(path[0]) is True
    assert store.canon_path() == []  # 正史は空(シーンが全部島になった)
    assert store.active_ending() is not None  # 結末は常に 1 つ以上ある
    # 「はじまり」自体は切り離せない
    start = store.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()["id"]
    with pytest.raises(ValueError):
        store.detach_node(start)


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
    """draft で繋いだ枝は正史にならない(本編側にアクティブな結末がある場合)。"""
    path = store.canon_path()
    store.create_ending(path[0], "本編の結末")  # 本編側の結末をアクティブに
    assert store.canon_path() == [path[0]]
    store.detach_node(path[1])
    store.attach_node(path[0], path[1], as_canon=False)
    assert store.canon_path() == [path[0]]  # 正史は伸びない
    assert store.get_node(path[1])["status"] == "draft"


def test_reattaching_active_ending_restores_canon(store):
    """アクティブな結末ごと切り離して繋ぎ直すと、その道が正史に戻る
    (正史はアクティブな結末までの道、という定義どおり)。"""
    path = store.canon_path()
    store.detach_node(path[1])  # 結末は末尾に付いたまま島へ
    assert store.canon_path() == [path[0]]  # 浮いている間は繋がっている分だけ
    store.attach_node(path[0], path[1])
    assert store.canon_path() == path


def test_ending_edge_can_be_cut_and_reconnected(store):
    """結末のエッジも切ったり繋いだりできる(付け替えで正史の終点を動かす)。"""
    path = store.canon_path()
    ending = store.active_ending()
    assert store.parent_of(ending) == path[2]
    assert store.detach_node(ending) is True  # 結末だけ浮かせる
    assert store.parent_of(ending) is None
    assert store.canon_path() == path  # 付け替え中は繋がっている分をそのまま使う
    store.attach_node(path[1], ending)  # 第二話の先へ付け替え
    assert store.canon_path() == path[:2]  # 正史の終点が動く
    assert store.get_node(path[2])["status"] == "draft"


def test_subtree_order_is_parent_first(store):
    path = store.canon_path()
    branch = store.append_node({"beat": "分岐", "cast": ["aya"], "title": "if"}, parent_id=path[1])
    order = store.subtree_order(path[1])
    assert order[0] == path[1]
    # 部分木には末尾の結末マーカーも含まれるので、シーンだけを比べる
    scenes = [nid for nid in order if store.get_node(nid)["kind"] is None]
    assert set(scenes) == {path[1], path[2], branch["id"]}


def test_detached_node_has_no_parent(store):
    """独立シーンはどこにも繋がらず、正史も伸びない。"""
    before = store.canon_path()
    node = store.append_node({"beat": "作り置きのエピソード", "cast": ["aya"]}, detached=True)
    assert store.parent_of(node["id"]) is None
    assert store.canon_path() == before  # 正史は変わらない
    assert node["status"] == "draft"
    # 独立ノードの子として足すと、そのまま島が育つ
    child = store.append_node({"beat": "続き", "cast": ["aya"]}, parent_id=node["id"])
    assert store.subtree_order(node["id"]) == [node["id"], child["id"]]
    assert store.canon_path() == before


def test_reextract_nodes_orders_parents_first(store, monkeypatch):
    """選択順がばらばらでも、親から順に抽出される(状態の前提が壊れないように)。"""
    import asyncio
    import generation

    path = store.canon_path()
    called: list[str] = []

    async def fake_extract(store_, base_url, node_id, keep_user_events=True):
        called.append(node_id)
        return []

    monkeypatch.setattr(generation, "extract_events", fake_extract)

    async def run():
        async for _ in generation.reextract_nodes(store, "http://fake", [path[2], path[0], path[1]]):
            pass

    asyncio.run(run())
    assert called == path


def test_reextract_nodes_include_downstream(store, monkeypatch):
    import asyncio
    import generation

    path = store.canon_path()
    called: list[str] = []

    async def fake_extract(store_, base_url, node_id, keep_user_events=True):
        called.append(node_id)
        return []

    monkeypatch.setattr(generation, "extract_events", fake_extract)

    async def run():
        async for _ in generation.reextract_nodes(store, "http://fake", [path[1]], include_downstream=True):
            pass

    asyncio.run(run())
    assert called == [path[1], path[2]]  # 選択したノードとその下流だけ


def test_normalize_chain_drops_legacy_introduce(store):
    """登場は cast から導出するので、残っている char_introduce は掃除する。"""
    path = store.canon_path()
    store.replace_events(path[1], [
        {"type": "char_introduce", "payload": {"char": "aya"}},  # 古いデータ相当
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "港"}},
    ])
    result = store.normalize_chain(path[1])
    assert result["removed"] == 1
    assert [e["type"] for e in store.get_node(path[1])["events"]] == ["fact_set"]
    assert result["warnings"] == []
    # 掃除しても登場状態は cast から導出されるので変わらない
    assert "aya" in store.get_state(path[1])["chars"]


def test_normalize_chain_reports_validation_warnings(store):
    """退場済みキャラの再登場のような矛盾は、消さずに警告として返す。"""
    path = store.canon_path()
    store.replace_events(path[0], [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        {"type": "char_retire", "payload": {"char": "aya", "reason": "death"}},
    ])
    result = store.normalize_chain(path[1])
    assert any("退場済み" in e for w in result["warnings"] for e in w["errors"])
