"""まとめて更新の対象の数え方(docs/design/bulk-update.md §3)。"""
import pytest

import bulk_update
import db
from store import Store


def memory(content):
    return {"type": "memory_add", "payload": {"char": "aya", "content": content, "importance": 0.5}}


@pytest.fixture
def store():
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.append_node({"id": "a", "beat": "一", "cast": ["aya"], "title": "第一話"}, [memory("石橋で誓った")])
    s.append_node({"id": "b", "beat": "二", "cast": ["aya"], "title": "第二話"}, [memory("ケンと別れた")])
    s.append_node({"id": "c", "beat": "三", "cast": ["aya"], "title": ""}, [memory("港で船を待った")])
    return s


def preset_id(store):
    return store.list_presets()[0]["id"]


def ids(items):
    return [i["id"] for i in items]


def missing(plan):
    return [r["id"] for r in plan["renders"] if r["status"] == "missing"]


def stale(plan):
    return [r["id"] for r in plan["renders"] if r["status"] == "stale"]


def add_digest(store, title, node_ids):
    group = store.create_group(title, node_ids)
    replaced = [e["id"] for nid in node_ids for e in store.list_events(nid) if e["type"] == "memory_add"]
    store.save_group_digest(group["id"], [{"type": "memory_compress", "payload": {
        "char": "aya", "replaces": replaced, "summary": "まとめ", "importance": 0.8}}])
    return group["id"]


def test_renders_missing_and_stale_in_story_order(store):
    plan = bulk_update.plan(store)
    assert plan["preset"]["id"] == preset_id(store) and plan["pov"] is None
    assert missing(plan) == ["a", "b", "c"]
    assert plan["renders"][2] == {"id": "c", "title": "(無題)", "status": "missing"}
    assert plan["digests"] == []

    store.save_render("a", preset_id(store), None, "清書一")
    store.save_render("c", preset_id(store), None, "清書三")
    plan = bulk_update.plan(store)
    assert missing(plan) == ["b"] and stale(plan) == []

    store.update_node("c", {"beat": "三を書き替えた"})
    store.update_node("a", {"beat": "一を書き替えた"})
    plan = bulk_update.plan(store)
    assert stale(plan) == ["a", "c"]  # 直した順ではなく物語の順
    # 清書し直すと対象から外れる(古い行が残っていても、見るのは最新だけ)
    store.save_render("a", preset_id(store), None, "清書一の二")
    assert stale(bulk_update.plan(store)) == ["c"]


def test_empty_scenes_and_markers_are_skipped(store):
    store.append_node({"id": "d", "beat": "  \n", "cast": []})
    plan = bulk_update.plan(store, include_branches=True)
    assert missing(plan) == ["a", "b", "c"]
    kinds = {r["id"] for r in store.conn.execute("SELECT id FROM nodes WHERE kind IS NOT NULL")}
    assert kinds and not kinds & set(missing(plan))


def test_counts_only_the_selected_style(store):
    base = preset_id(store)  # 組み込みを先に並べてから足す(先頭 = 既定のプリセットのまま)
    other = store.upsert_preset({"name": "別の文体", "person": "third", "tone": "乾いた文体"})
    store.save_render("a", base, None, "清書一")
    store.save_render("b", base, "aya", "アヤの視点")
    assert missing(bulk_update.plan(store)) == ["b", "c"]

    store.set_settings({"reader_pov_char": "aya"})
    plan = bulk_update.plan(store)
    assert plan["pov"] == {"id": "aya", "name": "アヤ"}
    assert missing(plan) == ["a", "c"]

    store.set_settings({"reader_preset_id": other["id"], "reader_pov_char": "", "reader_target_chars": "1200"})
    plan = bulk_update.plan(store)
    assert plan["preset"] == {"id": other["id"], "name": "別の文体"} and plan["target_chars"] == 1200
    assert missing(plan) == ["a", "b", "c"]

    # 消えたプリセット・キャラクターを指す設定は、画面と同じく先頭のプリセット・視点なしに戻す
    store.set_settings({"reader_preset_id": "gone", "reader_pov_char": "nobody", "reader_target_chars": "x"})
    plan = bulk_update.plan(store)
    assert plan["preset"]["id"] == preset_id(store) and plan["pov"] is None and plan["target_chars"] == 0


def test_branches_only_when_asked(store):
    store.append_node({"id": "x", "beat": "分岐", "cast": ["aya"], "title": "もしも"}, parent_id="a")
    store.append_node({"id": "y", "beat": "分岐の先", "cast": ["aya"]}, parent_id="x")
    store.append_node({"id": "island", "beat": "島", "cast": []}, detached=True)
    assert missing(bulk_update.plan(store)) == ["a", "b", "c"]
    plan = bulk_update.plan(store, include_branches=True)
    got = missing(plan)
    assert got[:3] == ["a", "b", "c"] and set(got[3:]) == {"x", "y", "island"}
    assert got.index("x") < got.index("y")  # 親が先(前の清書につなげるため)


def test_digests_only_stale_ones_that_exist(store):
    first = add_digest(store, "第一章", ["a", "b"])
    store.create_group("まとめの無い章", ["c"])
    assert bulk_update.plan(store)["digests"] == []
    store.update_node("b", {"beat": "二を書き替えた"})
    assert bulk_update.plan(store)["digests"] == [{"id": first, "title": "第一章"}]
    # まとめを保存し直すと外れる
    store.save_group_digest(first, [{"type": "memory_compress", "payload": {
        "char": "aya", "replaces": [], "summary": "まとめ直し", "importance": 0.8}}])
    assert bulk_update.plan(store)["digests"] == []


def test_off_canon_chapter_digest_needs_branches(store):
    store.append_node({"id": "x", "beat": "分岐", "cast": ["aya"]}, [memory("別の道を選んだ")], parent_id="a")
    side = add_digest(store, "分岐の章", ["x"])
    store.update_node("x", {"beat": "分岐を書き替えた"})
    assert bulk_update.plan(store)["digests"] == []
    assert ids(bulk_update.plan(store, include_branches=True)["digests"]) == [side]


def scripts(plan, status):
    return [s["id"] for s in plan["scripts"] if s["status"] == status]


def test_scripts_missing_then_stale_after_rerender(store):
    pid = preset_id(store)
    assert bulk_update.plan(store)["scripts"] == []  # 清書が無ければ台本も拾わない

    ra = store.save_render("a", pid, None, "「行こう」とアヤは言った。")
    store.save_render("b", pid, None, "")  # 本文が空の清書は拾わない
    rc = store.save_render("c", pid, None, "港で船を待った。")
    plan = bulk_update.plan(store)
    assert scripts(plan, "missing") == ["a", "c"] and scripts(plan, "stale") == []
    assert plan["scripts"][0] == {"id": "a", "title": "第一話", "render_id": ra["id"], "status": "missing"}

    # LLM で付けたものは拾わない。規則ベースで保存しただけ(手直し)なら拾う
    store.save_voice_script(ra["id"], "a", [], "llm")
    store.save_voice_script(rc["id"], "c", [], "rule")
    plan = bulk_update.plan(store)
    assert scripts(plan, "missing") == ["c"] and scripts(plan, "stale") == []

    # 清書を作り直すと、新しい清書の台本は「要更新」になる(古い清書の台本は相手にしない)
    ra2 = store.save_render("a", pid, None, "「行こう」とアヤは言った。港へ。")
    plan = bulk_update.plan(store)
    assert scripts(plan, "stale") == ["a"]
    assert next(s for s in plan["scripts"] if s["id"] == "a")["render_id"] == ra2["id"]


def test_scripts_count_only_the_selected_style(store):
    pid = preset_id(store)
    ra = store.save_render("a", pid, None, "清書一")
    store.save_voice_script(ra["id"], "a", [], "llm")
    # 別の視点の清書に付けた台本は、いまの組(視点なし)の数え方に関わらない
    rb = store.save_render("b", pid, "aya", "清書二")
    store.save_voice_script(rb["id"], "b", [], "llm")
    store.save_render("b", pid, None, "清書二")
    plan = bulk_update.plan(store)
    assert scripts(plan, "missing") == ["b"] and scripts(plan, "stale") == []
