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


def test_prompt_only_edit_keeps_downstream_fresh(store):
    """beat の誤字修正のようなプロンプト文面だけの編集では、
    自ノードの清書だけが古くなり、下流の状態・清書は保たれる(フェーズ A)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    store.get_state(n2["id"])  # キャッシュを温める
    store.seed_presets()
    store.save_render(n1["id"], "default-third", None, "散文1")
    store.save_render(n2["id"], "default-third", None, "散文2")
    store.update_node(n1["id"], {"beat": "b1(誤字修正)", "title": "改題"})
    assert store.latest_render(n1["id"], "default-third", None)["stale"] == 1
    assert store.latest_render(n2["id"], "default-third", None)["stale"] == 0
    cached = store.conn.execute("SELECT dirty FROM state_cache WHERE node_id = ?", (n2["id"],)).fetchone()
    assert cached["dirty"] == 0


def test_cast_edit_with_unchanged_state_keeps_downstream(store):
    """cast の並べ替えなど、再 fold しても状態が同じ編集は下流へ波及しない(early cutoff)。
    cast はプロンプトに出るので自ノードの清書だけは stale になる。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya", "ken"]})
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    store.get_state(n2["id"])
    store.seed_presets()
    store.save_render(n1["id"], "default-third", None, "散文1")
    store.save_render(n2["id"], "default-third", None, "散文2")
    store.update_node(n1["id"], {"cast": ["ken", "aya"]})  # 並べ替え(状態は不変)
    assert store.latest_render(n1["id"], "default-third", None)["stale"] == 1
    assert store.latest_render(n2["id"], "default-third", None)["stale"] == 0


def test_cast_edit_that_changes_state_stales_downstream(store):
    """cast への新キャラ追加は状態が変わるので、従来どおり下流まで波及する。"""
    _setup_chars(store)
    store.create_character({"name": "ミオ", "id": "mio"})
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    store.get_state(n2["id"])
    store.seed_presets()
    store.save_render(n2["id"], "default-third", None, "散文2")
    store.update_node(n1["id"], {"cast": ["aya", "mio"]})
    assert store.latest_render(n2["id"], "default-third", None)["stale"] == 1
    assert "mio" in store.get_state(n2["id"])["chars"]


# ---- はじまり / 結末ノード(docs/design/endings.md) ------------------


def test_story_markers_are_ensured(store):
    starts = store.conn.execute("SELECT * FROM nodes WHERE kind = 'start'").fetchall()
    endings = store.conn.execute("SELECT * FROM nodes WHERE kind = 'ending'").fetchall()
    assert len(starts) == 1 and len(endings) == 1
    assert store.active_ending() == endings[0]["id"]
    assert store.canon_path() == []  # マーカーは正史(シーン列)に混ざらない


def test_append_keeps_ending_at_tail(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    assert n1["status"] == "canon"  # 「はじまり」直後の挿入でも正史扱い
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    assert store.canon_path() == [n1["id"], n2["id"]]
    ending = store.active_ending()
    assert store.parent_of(ending) == n2["id"]  # 結末は常に末尾に居続ける
    start = store.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()["id"]
    assert store.parent_of(n1["id"]) == start  # 最初のシーンは「はじまり」の子


def test_multiple_endings_switch(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    b1 = store.append_node({"beat": "別ルート", "cast": ["aya"]}, parent_id=n1["id"])
    alt = store.create_ending(b1["id"], "バッドエンド")
    assert store.active_ending() == alt["id"]
    assert store.canon_path() == [n1["id"], b1["id"]]  # 正史は結末からの逆引きで切り替わる
    assert store.get_node(n2["id"])["status"] == "draft"
    store.make_canon(n2["id"])  # 元のルートへ戻す(n2 の先の結末がアクティブになる)
    assert store.canon_path() == [n1["id"], n2["id"]]
    assert store.get_node(b1["id"])["status"] == "draft"
    assert store.get_node(alt["id"])["title"] == "バッドエンド"


def test_marker_guards(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    start = store.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()["id"]
    ending = store.active_ending()
    with pytest.raises(ValueError):
        store.delete_node(start)  # はじまりは削除不可
    with pytest.raises(ValueError):
        store.delete_node(ending)  # 最後の結末は削除不可
    with pytest.raises(ValueError):
        store.append_node({"beat": "x", "cast": []}, parent_id=ending)  # 結末の先は不可
    alt = store.create_ending(n1["id"], "別エンド", activate=False)
    assert store.delete_node(alt["id"]) is True  # 複数あれば余分は消せる


def test_deleting_active_ending_switches_to_another(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    first = store.active_ending()
    alt = store.create_ending(n1["id"], "別エンド", activate=True)
    assert store.active_ending() == alt["id"]
    store.delete_node(alt["id"])
    assert store.active_ending() == first  # 残った結末へ自動で切り替わる
    assert store.canon_path() == [n1["id"]]


# ---- 章グループ(docs/design/chapters.md) ---------------------------


def _three_scenes(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    n3 = store.append_node({"beat": "b3", "cast": ["aya"]})
    return n1, n2, n3


def test_group_create_and_list(store):
    n1, n2, n3 = _three_scenes(store)
    g = store.create_group("第一章", [n2["id"], n1["id"]])  # 順不同でも正史順に整う
    assert g["title"] == "第一章"
    assert g["node_ids"] == [n1["id"], n2["id"]]
    assert store.get_node(n1["id"])["group_id"] == g["id"]
    assert store.get_node(n3["id"])["group_id"] is None
    groups = store.list_groups()
    assert [x["id"] for x in groups] == [g["id"]]


def test_group_requires_connected_chain(store):
    n1, n2, n3 = _three_scenes(store)
    with pytest.raises(ValueError):
        store.create_group("飛び章", [n1["id"], n3["id"]])  # n2 を飛ばした(鎖でない)
    # 分岐・島でも章にできる(2026-08-01 一般化。正史かどうかは問わない)
    branch = store.append_node({"beat": "if", "cast": ["aya"]}, parent_id=n1["id"], force_draft=True)
    bg = store.create_group("分岐章", [branch["id"]])
    assert bg["on_canon"] is False
    g1 = store.create_group("第一章", [n1["id"], n2["id"]])
    assert g1["on_canon"] is True
    with pytest.raises(ValueError):
        store.create_group("重複章", [n2["id"], n3["id"]])  # 他章のノードを含む
    # 一覧は正史ルート上の章が先、島・分岐の章が後ろ
    assert [g["id"] for g in store.list_groups()] == [g1["id"], bg["id"]]


def test_island_chapter_connect_flow(store):
    """島で章を作って編集し、あとで正史につなぐ流れ(2026-08-01 一般化の目的)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    i1 = store.append_node({"beat": "島1", "cast": ["aya"]}, detached=True)
    i2 = store.append_node({"beat": "島2", "cast": ["aya"]}, parent_id=i1["id"])
    g = store.create_group("作り置きの章", [i2["id"], i1["id"]])  # 順不同でも鎖順に整う
    assert g["node_ids"] == [i1["id"], i2["id"]]
    assert g["on_canon"] is False and g["warning"] is None
    with pytest.raises(ValueError):
        store.move_group(g["id"], None)  # 島の章は並べ替え対象外
    store.attach_node(n1["id"], i1["id"])
    store.make_canon(i2["id"])
    entry = next(x for x in store.list_groups() if x["id"] == g["id"])
    assert entry["on_canon"] is True
    assert store.canon_path() == [n1["id"], i1["id"], i2["id"]]


def test_group_dissolve_and_remove_edge_only(store):
    n1, n2, n3 = _three_scenes(store)
    g = store.create_group("第一章", [n1["id"], n2["id"], n3["id"]])
    with pytest.raises(ValueError):
        store.remove_node_from_group(n2["id"])  # 途中は外せない(章が分断される)
    store.remove_node_from_group(n3["id"])  # 端は外せる
    assert store.list_groups()[0]["node_ids"] == [n1["id"], n2["id"]]
    store.delete_group(g["id"])
    assert store.list_groups() == []
    assert store.get_node(n1["id"])["group_id"] is None  # シーンは残る


def test_group_insert_inherits_when_inside(store):
    n1, n2, n3 = _three_scenes(store)
    g = store.create_group("第一章", [n1["id"], n2["id"]])
    mid = store.insert_node_after(n1["id"], {"beat": "間", "cast": ["aya"]})
    assert store.get_node(mid["id"])["group_id"] == g["id"]  # 章の真ん中 → 引き継ぐ
    tail = store.insert_node_after(n2["id"], {"beat": "章の後", "cast": ["aya"]})
    assert store.get_node(tail["id"])["group_id"] is None  # 章末尾の後 → 未分類
    # 章は連続のまま保たれている
    assert store.list_groups()[0]["node_ids"] == [n1["id"], mid["id"], n2["id"]]


def test_event_ids_preserved_on_replace(store):
    """id 付きで置換すればイベント ID が引き継がれる(参照が壊れない)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "記憶1", "importance": 0.5}},
    ])
    old_id = n1["events"][0]["id"]
    events = store.list_events(n1["id"])
    events[0]["payload"] = {**events[0]["payload"], "content": "記憶1(修正)"}
    new_events = store.replace_events(n1["id"], [
        {"id": e["id"], "type": e["type"], "payload": e["payload"], "source": e["source"]} for e in events
    ])
    assert new_events[0]["id"] == old_id
    assert new_events[0]["payload"]["content"] == "記憶1(修正)"


def _chapter_with_digest(store):
    """第一章(2 シーン + 記憶)+ 後続 1 シーンと、保存済みまとめを用意する。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "石橋で誓った", "importance": 0.8}},
    ])
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "ケンと決別した", "importance": 0.9}},
    ])
    n3 = store.append_node({"beat": "b3", "cast": ["aya"]})
    g = store.create_group("第一章", [n1["id"], n2["id"]])
    mem_ids = [e["id"] for nid in (n1["id"], n2["id"]) for e in store.list_events(nid) if e["type"] == "memory_add"]
    g = store.save_group_digest(g["id"], [
        {"type": "memory_compress",
         "payload": {"char": "aya", "replaces": mem_ids, "summary": "第一章で誓いと決別を経た", "importance": 0.9}},
    ])
    return n1, n2, n3, g


def test_digest_applies_at_chapter_boundary(store):
    n1, n2, n3, g = _chapter_with_digest(store)
    digest_id = g["digest_events"][0]["id"]
    # 章の中(末尾)は生の記憶のまま
    s2 = store.get_state(n2["id"])
    assert len(s2["chars"]["aya"]["memories"]) == 2
    # 境界の先では要約 1 件に置き換わる
    s3 = store.get_state(n3["id"])
    assert s3["chars"]["aya"]["memories"] == [digest_id]
    # まとめは memories 行にもなる(検索・表示用)
    row = store.conn.execute("SELECT content FROM memories WHERE id = ?", (digest_id,)).fetchone()
    assert row["content"] == "第一章で誓いと決別を経た"


def test_digest_isolates_in_chapter_edit(store):
    """まとめ済みの章の中で記憶の文面だけ直しても(ID 引き継ぎ)、章の外へは波及しない。"""
    n1, n2, n3, g = _chapter_with_digest(store)
    store.seed_presets()
    for nid in (n1["id"], n2["id"], n3["id"]):
        store.save_render(nid, "default-third", None, f"散文-{nid}")
    events = store.list_events(n1["id"])
    events[0]["payload"] = {**events[0]["payload"], "content": "石橋で誓った(修正)"}
    store.replace_events(n1["id"], [
        {"id": e["id"], "type": e["type"], "payload": e["payload"], "source": e["source"]} for e in events
    ])
    # 章内の清書は stale、章の外(次章側)は保たれる
    assert store.latest_render(n1["id"], "default-third", None)["stale"] == 1
    assert store.latest_render(n2["id"], "default-third", None)["stale"] == 1
    assert store.latest_render(n3["id"], "default-third", None)["stale"] == 0
    # まとめには「要更新」が立つ
    assert store.get_group(g["id"])["digest_stale"] == 1


def test_digest_update_propagates_only_when_changed(store):
    n1, n2, n3, g = _chapter_with_digest(store)
    store.seed_presets()
    store.save_render(n3["id"], "default-third", None, "散文3")
    # 同じ内容で保存し直しても波及しない
    store.save_group_digest(g["id"], g["digest_events"])
    assert store.latest_render(n3["id"], "default-third", None)["stale"] == 0
    # 内容を変えると境界の先だけ波及する
    changed = [{**g["digest_events"][0],
                "payload": {**g["digest_events"][0]["payload"], "summary": "書き直したまとめ"}}]
    store.save_group_digest(g["id"], changed)
    assert store.latest_render(n3["id"], "default-third", None)["stale"] == 1
    assert store.get_state(n3["id"])["chars"]["aya"]["memories"] == [g["digest_events"][0]["id"]]


def test_digest_delete_restores_raw_state(store):
    n1, n2, n3, g = _chapter_with_digest(store)
    assert len(store.get_state(n3["id"])["chars"]["aya"]["memories"]) == 1
    store.delete_group_digest(g["id"])
    assert len(store.get_state(n3["id"])["chars"]["aya"]["memories"]) == 2  # 生に戻る
    assert store.get_group(g["id"])["digest_events"] is None


def test_move_group_reorders_chapters(store):
    """章の並べ替え: つなぎ替えがアトミックに行われ、章ラベルと分岐が保たれる。"""
    _setup_chars(store)
    scenes = [store.append_node({"beat": f"b{i}", "cast": ["aya"], "title": f"s{i}"}) for i in range(4)]
    ids = [n["id"] for n in scenes]
    g1 = store.create_group("第一章", ids[0:2])
    g2 = store.create_group("第二章", ids[2:4])
    branch = store.append_node({"beat": "分岐", "cast": ["aya"]}, parent_id=ids[1])
    # 第一章を第二章の後ろへ
    store.move_group(g1["id"], g2["id"])
    assert store.canon_path() == [ids[2], ids[3], ids[0], ids[1]]
    groups = store.list_groups()
    assert [g["title"] for g in groups] == ["第二章", "第一章"]
    assert groups[1]["node_ids"] == ids[0:2]  # 章ラベルは保たれる
    assert store.parent_of(branch["id"]) == ids[1]  # 分岐は章と一緒に移動
    ending = store.active_ending()
    assert store.parent_of(ending) == ids[1]  # 結末は新しい末尾に付く
    # 先頭(はじまりの直後)へ戻す
    store.move_group(g1["id"], None)
    assert store.canon_path() == [ids[0], ids[1], ids[2], ids[3]]


def test_move_group_marks_digests_stale(store):
    _setup_chars(store)
    scenes = [store.append_node({"beat": f"b{i}", "cast": ["aya"], "title": f"s{i}"}) for i in range(4)]
    ids = [n["id"] for n in scenes]
    g1 = store.create_group("第一章", ids[0:2])
    g2 = store.create_group("第二章", ids[2:4])
    store.save_group_digest(g1["id"], [
        {"type": "memory_compress", "payload": {"char": "aya", "replaces": [], "summary": "一章まとめ", "importance": 0.5}},
    ])
    store.save_group_digest(g2["id"], [
        {"type": "memory_compress", "payload": {"char": "aya", "replaces": [], "summary": "二章まとめ", "importance": 0.5}},
    ])
    store.move_group(g2["id"], None)  # 第二章を先頭へ
    # 前提(上流の文脈)が変わるので両方の章に要更新が立つ
    assert all(g["digest_stale"] == 1 for g in store.list_groups())


def test_group_label_survives_detach(store):
    """切り離しで章ラベルは消えない(2026-08-01 変更。以前は自動で解除していた)。
    鎖が途切れている間は警告バッジで知らせ、つなぎ直せば章がそのまま戻る。"""
    n1, n2, n3 = _three_scenes(store)
    g = store.create_group("第一章", [n1["id"], n2["id"], n3["id"]])
    store.detach_node(n3["id"])  # n3 は島になる(鎖が途切れる)
    assert store.get_node(n3["id"])["group_id"] == g["id"]  # ラベルは残る
    entry = next(x for x in store.list_groups() if x["id"] == g["id"])
    assert entry["warning"] is not None  # 警告バッジ
    # つなぎ直して正史に戻すと、章が元どおり復活して警告も消える
    store.attach_node(n2["id"], n3["id"])
    store.make_canon(n3["id"])
    entry = next(x for x in store.list_groups() if x["id"] == g["id"])
    assert entry["node_ids"] == [n1["id"], n2["id"], n3["id"]]
    assert entry["warning"] is None
    assert entry["on_canon"] is True


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


def test_cast_derives_introduction(store):
    """登場は cast から導出する(char_introduce イベントは作らない)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "初登場", "cast": ["aya", "ken"]})
    assert n1["events"] == []  # 余計なイベントは作らない
    assert set(store.get_state(n1["id"])["chars"]) == {"aya", "ken"}
    assert store.validate(n1["id"]) == []
    # cast を編集すれば、そのシーン以降の状態にも即座に現れる
    store.create_character({"name": "ミオ", "id": "mio"})
    n2 = store.append_node({"beat": "続き", "cast": ["aya"]})
    assert "mio" not in store.get_state(n2["id"])["chars"]
    store.update_node(n2["id"], {"cast": ["aya", "mio"]})
    assert "mio" in store.get_state(n2["id"])["chars"]
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


def test_delete_first_scene_splices_to_start(store):
    """最初のシーンを消すと、次のシーンが「はじまり」に直結して正史が繋がる
    (結末方式で変更。以前は子が根になっていた)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya"))
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]})
    assert store.delete_node(n1["id"]) is True
    start = store.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()["id"]
    assert store.parent_of(n2["id"]) == start
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
    # path_to は「はじまり」マーカーを含む生のチェーンを返す
    assert store.path_to(b1["id"])[1:] == [n1["id"], b1["id"]]
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
    assert store.path_to(b2["id"])[1:] == [n1["id"], b1["id"], b2["id"]]
    # 正史は n1 → n2 のまま(n1 → b1 が canon でないため)
    assert store.canon_path() == [n1["id"], n2["id"]]
    store.make_canon(b2["id"])
    assert store.canon_path() == [n1["id"], b1["id"], b2["id"]]
    assert store.get_node(n2["id"])["status"] == "draft"


def test_delete_branch_root_does_not_duplicate_canon(store):
    """分岐の根を削除しても、付け替えエッジが正史を二重にしない。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, _intro_events("aya"))
    n2 = store.append_node({"beat": "正史の続き", "cast": ["aya"]})
    b1 = store.append_node({"beat": "分岐", "cast": ["aya"]}, parent_id=n1["id"])
    # 分岐の延長は(b1 の線内では)canon エッジになる
    b2 = store.append_node({"beat": "分岐の続き", "cast": ["aya"]}, parent_id=b1["id"])
    assert store.delete_node(b1["id"]) is True
    # b2 は n1 に付け替わるが draft のまま。正史は n1 → n2 で変わらない
    assert store.parent_of(b2["id"]) == n1["id"]
    canon_children = store.conn.execute(
        "SELECT COUNT(*) FROM edges WHERE from_node = ? AND is_canon = 1", (n1["id"],)
    ).fetchone()[0]
    assert canon_children == 1
    assert store.canon_path() == [n1["id"], n2["id"]]
    assert store.get_node(b2["id"])["status"] == "draft"


def test_memory_compress_materializes_memory_row(store):
    """memory_compress の要約も memories 行になる(検索から消えない)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "村が焼けた", "importance": 1.0}},
        {"type": "memory_add", "payload": {"char": "aya", "content": "ケンと出会った", "importance": 0.5}},
    ])
    ids = [e["id"] for e in store.get_node(n1["id"])["events"]]
    n2 = store.append_node({"beat": "b2", "cast": ["aya"]}, [
        {"type": "memory_compress", "payload": {"char": "aya", "summary": "故郷を失いケンと旅している", "replaces": ids}},
    ])
    compress_id = store.get_node(n2["id"])["events"][0]["id"]
    row = store.conn.execute("SELECT * FROM memories WHERE id = ?", (compress_id,)).fetchone()
    assert row is not None
    assert row["content"] == "故郷を失いケンと旅している"
    # state 側は要約だけを参照している
    memories = store.get_state(n2["id"])["chars"]["aya"]["memories"]
    assert memories == [compress_id]


def test_replace_events_tolerates_malformed_memory_payload(store):
    """必須フィールドを欠く memory_add で置換が途中で壊れない(行は作らない)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    store.replace_events(n1["id"], [
        {"type": "memory_add", "payload": {"content": "char が無い"}},
        {"type": "memory_add", "payload": {"char": "aya", "content": "正常な記憶"}},
    ])
    rows = store.conn.execute("SELECT content FROM memories").fetchall()
    assert [r["content"] for r in rows] == ["正常な記憶"]


def test_delete_node_removes_renders(store):
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]})
    store.seed_presets()
    store.save_render(n1["id"], "default-third", None, "散文")
    store.delete_node(n1["id"])
    rows = store.conn.execute("SELECT * FROM renders WHERE node_id = ?", (n1["id"],)).fetchall()
    assert rows == []


def test_graph_matches_get_node_shape(store):
    """graph() の一括組み立てが get_node のノード形と一致し続けること(N+1 解消の回帰)。"""
    _setup_chars(store)
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "記憶1", "importance": 0.5}},
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "goal", "value": "旅"}},
    ])
    store.append_node({"beat": "b2", "cast": ["aya", "ken"]})
    graph = store.graph()
    # graph にははじまり / 結末マーカーも含まれるので、シーンだけを正史と比べる
    assert [n["id"] for n in graph["nodes"] if not n["kind"]] == store.canon_path()
    for node in graph["nodes"]:
        assert node == store.get_node(node["id"])
    n1_in_graph = next(n for n in graph["nodes"] if n["id"] == n1["id"])
    assert n1_in_graph["events"] == store.list_events(n1["id"])
