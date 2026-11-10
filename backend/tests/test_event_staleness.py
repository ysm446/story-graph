"""イベントの古さの印(docs/design/event-staleness.md)。"""
import pytest

import db
from store import Store

MEMORY = {"type": "memory_add", "payload": {"char": "aya", "content": "石橋で出会った", "importance": 0.5}}


@pytest.fixture
def store():
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.create_character({"name": "ケン", "id": "ken"})
    place = s.create_place({"name": "石橋"})
    s.place_id = place["id"]
    s.append_node({"id": "a", "beat": "二人が出会う。", "cast": ["aya", "ken"], "title": "第一話"}, [MEMORY])
    s.append_node({"id": "b", "beat": "二人が別れる。", "cast": ["aya"], "title": "第二話"}, [MEMORY])
    return s


def status(store, node_id):
    return store.get_node(node_id)["events_status"]


def test_fresh_after_writing_events(store):
    assert status(store, "a") is None
    assert "events_basis" not in store.get_node("a")  # 指紋そのものは外へ出さない
    store.update_node("a", {"beat": "二人が橋で出会う。"})
    assert status(store, "a") == "stale"
    # 手での保存(抽出も同じ replace_events を通る)で最新に戻る。0 件で保存しても最新
    store.replace_events("a", [MEMORY])
    assert status(store, "a") is None
    store.update_node("a", {"beat": "二人が橋で出会い、話す。"})
    store.replace_events("a", [])
    assert status(store, "a") is None


def test_only_extraction_inputs_make_it_stale(store):
    store.update_node("a", {"title": "改題", "emotional_core": "不安", "elapsed_unit": "day", "elapsed_count": 2,
                            "target_chars": 800})
    assert status(store, "a") is None
    store.update_node("a", {"cast": ["aya"]})
    assert status(store, "a") == "stale"
    store.update_node("a", {"cast": ["ken", "aya"]})  # 元の顔ぶれに戻す(並びは違う)
    assert status(store, "a") is None
    store.update_node("a", {"location": store.place_id})
    assert status(store, "a") == "stale"
    store.update_node("a", {"location": None})
    assert status(store, "a") is None


def test_reverting_or_whitespace_does_not_count(store):
    store.update_node("a", {"beat": "書き替えた。"})
    assert status(store, "a") == "stale"
    store.update_node("a", {"beat": "二人が出会う。"})
    assert status(store, "a") is None
    store.update_node("a", {"beat": "\r\n  二人が出会う。\n\n"})
    assert status(store, "a") is None
    assert db.events_fingerprint("一行目\r\n二行目", [], None) == db.events_fingerprint("一行目\n二行目", "[]", "")


def test_missing_when_never_written(store):
    store.append_node({"id": "c", "beat": "本文だけ書いた。", "cast": ["aya"]})
    store.append_node({"id": "d", "beat": "", "cast": []})
    assert status(store, "c") == "missing"
    assert status(store, "d") is None  # 本文が空なら抽出するものが無い
    store.update_node("d", {"beat": "あとから書いた。"})
    assert status(store, "d") == "missing"
    by_id = {n["id"]: n for n in store.graph()["nodes"]}
    assert (by_id["a"]["events_status"], by_id["c"]["events_status"]) == (None, "missing")
    assert "events_basis" not in by_id["a"]


def test_confirm_clears_the_mark_without_touching_the_story(store):
    from fold import state_hash

    store.save_render("b", "p", None, "清書", {})
    store.update_node("a", {"beat": "二人が橋で出会う。"})
    events = store.list_events("a")
    before = state_hash(store.get_state("b"))
    stale_before = store.conn.execute("SELECT stale FROM renders WHERE node_id = 'b'").fetchone()[0]

    node = store.confirm_events("a")
    assert node["events_status"] is None
    assert store.list_events("a") == events
    assert state_hash(store.get_state("b")) == before
    assert store.conn.execute("SELECT stale FROM renders WHERE node_id = 'b'").fetchone()[0] == stale_before
    # 未作成も同じ操作で消せる
    store.append_node({"id": "c", "beat": "本文だけ。", "cast": []})
    assert store.confirm_events("c")["events_status"] is None
    assert store.confirm_events("no-such-node") is None


def test_upstream_edit_does_not_spread(store):
    store.update_node("a", {"beat": "まったく別の出会い方をする。"})
    assert status(store, "a") == "stale"
    assert status(store, "b") is None


def test_maintenance_rewrite_keeps_the_mark(store):
    store.replace_events("a", [{"type": "char_introduce", "payload": {"char": "aya"}}, MEMORY])
    store.update_node("a", {"beat": "書き替えた。"})
    result = store.normalize_chain("a")  # 登場イベントの掃除。本文とは突き合わせていない
    assert result["removed"] == 1
    assert status(store, "a") == "stale"


def test_markers_are_never_marked(store):
    for node in store.graph()["nodes"]:
        if node["kind"]:
            assert node["events_status"] is None


def test_migration_starts_existing_scenes_as_fresh(tmp_path):
    path = tmp_path / "story-graph.db"
    s = Store(db.connect(path))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.append_node({"id": "a", "beat": "イベントのあるシーン。", "cast": ["aya"]}, [MEMORY])
    s.append_node({"id": "b", "beat": "イベントの無いシーン。", "cast": ["aya"]})
    # 列を足す前のライブラリを再現する(指紋なし・版 4)
    s.conn.execute("UPDATE nodes SET events_basis = NULL")
    s.conn.execute("PRAGMA user_version = 4")
    s.conn.commit()
    s.conn.close()

    for _ in range(2):  # 2 回開いても変わらない
        s = Store(db.connect(path))
        assert status(s, "a") is None
        assert status(s, "b") == "missing"
        assert s.conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
        s.update_node("a", {"beat": "書き替えた。"})
        assert status(s, "a") == "stale"
        s.update_node("a", {"beat": "イベントのあるシーン。"})
        s.conn.close()
