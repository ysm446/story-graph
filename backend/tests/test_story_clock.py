"""前のシーンからの経過(story_clock)と、それを使う清書・会話・制作の受け渡しを確認する。"""

import asyncio

import pytest

import chat_agent
import db
import embed
import generation
import production_agent as production
import rendering
import story_clock
from store import Store


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    root = tmp_path / "library"
    root.mkdir()
    s = Store(db.connect(root / "story-graph.db"), root=str(root))
    s.create_character({"id": "aya", "name": "アヤ"})
    yield s
    s.conn.close()


def memory(text):
    return {"type": "memory_add", "payload": {"char": "aya", "content": text, "emotion": 0.0, "importance": 0.5}}


def test_normalize_and_label():
    assert story_clock.normalize(None, 3) == (None, None)
    assert story_clock.normalize("immediate", 3) == ("immediate", None)
    assert story_clock.normalize("day", None) == ("day", 1)
    assert story_clock.label("week", 2) == "2週間後"
    assert story_clock.label("same_day", None) == "同じ日"
    assert story_clock.label(None, None) is None
    for unit, count in (("hour", 1), ("day", 0), ("day", True), ("day", "3")):
        with pytest.raises(ValueError):
            story_clock.normalize(unit, count)


def test_points_break_at_unset_and_ago():
    steps = [(None, None), ("immediate", None), ("day", 3), (None, None), ("year", 2)]
    points = story_clock.points(steps)
    assert points == [(0, 0), (0, 0), (0, 3), (1, 0), (1, 730)]
    assert story_clock.ago(points[0], points[2]) == "3日前"
    assert story_clock.ago(points[2], points[2]) == "今日"
    assert story_clock.ago(points[3], points[4]) == "約2年前"
    # 未設定をまたぐ距離は分からない
    assert story_clock.ago(points[2], points[4]) is None


def test_store_keeps_elapsed_and_marks_render_stale(store):
    store.append_node({"id": "a", "beat": "一", "cast": ["aya"]})
    node = store.append_node({"id": "b", "beat": "二", "cast": ["aya"], "elapsed_unit": "day", "elapsed_count": 5})
    assert (node["elapsed_unit"], node["elapsed_count"]) == ("day", 5)
    preset = store.list_presets()[0]["id"]
    store.save_render("b", preset, None, "本文")
    # 単位を数を持たないものへ変えると、数は持ち越さない
    node = store.update_node("b", {"elapsed_unit": "same_day"})
    assert (node["elapsed_unit"], node["elapsed_count"]) == ("same_day", None)
    assert store.latest_render("b", preset, None)["stale"] == 1
    node = store.update_node("b", {"elapsed_unit": None})
    assert (node["elapsed_unit"], node["elapsed_count"]) == (None, None)
    with pytest.raises(ValueError):
        store.update_node("b", {"elapsed_unit": "hour"})


def render_prompt(store, node_id):
    preset = store.list_presets()[0]
    return rendering.build_render_messages(store, store.get_node(node_id), preset, None, "前の末尾")[1]["content"]


def test_render_prompt_tells_elapsed(store):
    store.append_node({"id": "a", "beat": "一", "cast": ["aya"]})
    store.append_node({"id": "b", "beat": "二", "cast": ["aya"]})
    assert "前のシーンからの経過" not in render_prompt(store, "a")
    # 未設定で章も変わっていなければ、従来どおり続きとして書く
    text = render_prompt(store, "b")
    assert "前のシーンからの経過: 未設定" in text and "(この続きから書く)" in text
    store.update_node("b", {"elapsed_unit": "day", "elapsed_count": 3})
    text = render_prompt(store, "b")
    assert "前のシーンからの経過: 3日後" in text and "(この続きから書く)" not in text
    store.update_node("b", {"elapsed_unit": "immediate"})
    assert "(この続きから書く)" in render_prompt(store, "b")


def test_render_prompt_does_not_assume_continuation_across_chapters(store):
    store.append_node({"id": "a", "beat": "一", "cast": ["aya"]})
    store.append_node({"id": "b", "beat": "二", "cast": ["aya"]})
    group = store.create_group("第二章", ["b"])
    assert store.get_node("b")["group_id"] == group["id"]
    text = render_prompt(store, "b")
    assert "章が変わっている" in text and "(この続きから書く)" not in text


def test_character_memories_are_dated_only_when_elapsed_is_set(store):
    store.append_node({"id": "a", "beat": "一", "cast": ["aya"]}, [memory("街を出た")])
    store.append_node({"id": "b", "beat": "二", "cast": ["aya"]}, [memory("手紙が届いた")])
    store.append_node({"id": "c", "beat": "三", "cast": ["aya"]}, [memory("駅で再会した")])
    path = store.canon_path()
    plain = chat_agent.build_character_system(store, path, "aya", "interview")
    assert "when" not in chat_agent._tool_search_memories(store, path, "upto", {"query": "街を出た", "char_id": "aya"})["memories"][0]
    assert "- 街を出た" in plain and "日前" not in plain and "今日" not in plain
    store.update_node("b", {"elapsed_unit": "year", "elapsed_count": 2})
    store.update_node("c", {"elapsed_unit": "day", "elapsed_count": 3})
    text = chat_agent.build_character_system(store, path, "aya", "interview")
    assert "- (約2年前)街を出た" in text
    assert "- (3日前)手紙が届いた" in text
    assert "- (今日)駅で再会した" in text
    # recall(記憶の検索)の結果にも、同じ基準の距離が付く
    recall = lambda query: chat_agent._tool_search_memories(store, path, "upto", {"query": query, "char_id": "aya"})["memories"]
    assert [(m["content"], m.get("when")) for m in recall("手紙が届いた")] == [("手紙が届いた", "3日前")]
    assert recall("街を出た")[0]["when"] == "約2年前"
    # 途中に未設定があると、その前の記憶は時期が分からない
    store.update_node("c", {"elapsed_unit": None})
    store.append_node({"id": "d", "beat": "四", "cast": ["aya"], "elapsed_unit": "same_day"}, [memory("話し込んだ")])
    text = chat_agent.build_character_system(store, store.canon_path(), "aya", "interview")
    assert "- 街を出た" in text and "- (今日)駅で再会した" in text
    found = chat_agent._tool_search_memories(store, store.canon_path(), "upto", {"query": "街を出た", "char_id": "aya"})["memories"]
    assert found[0]["content"] == "街を出た" and "when" not in found[0]


def test_tools_and_generation_carry_elapsed(store, monkeypatch):
    store.append_node({"id": "a", "title": "出発", "beat": "村を出る。", "cast": ["aya"]})
    store.append_node({"id": "b", "title": "帰還", "beat": "村に戻る。", "cast": ["aya"], "elapsed_unit": "month", "elapsed_count": 2})
    beats = chat_agent._tool_get_beats(store, store.canon_path(), {})["beats"]
    assert [b["elapsed"] for b in beats] == [None, "2か月後"]
    assert "前のシーンから2か月後" in generation._format_recent_beats(store, store.canon_path())
    schema = generation.beat_schema(["aya"])
    assert schema["properties"]["elapsed_unit"]["enum"] == list(story_clock.UNITS)
    assert "elapsed_unit" not in schema["required"]
    assert generation._elapsed_from({"elapsed_unit": "week", "elapsed_count": 0}) == {"elapsed_unit": None, "elapsed_count": None}

    async def no_events(*args, **kwargs):
        pass
    monkeypatch.setattr(generation, "extract_events", no_events)
    monkeypatch.setattr(production.production_continuity, "check", no_events)
    asyncio.run(production.apply_edit(store, "fake", "insert_scene", {
        "after_id": "b", "title": "再訪", "beat": "三年ぶりに村を訪ねる。", "cast": ["aya"],
        "elapsed_unit": "year", "elapsed_count": 3, "reason": "続き"}))
    added = store.get_node(store.canon_path()[-1])
    assert (added["elapsed_unit"], added["elapsed_count"]) == ("year", 3)
    # 経過だけを変える編集は「反映済み」として弾かない。unset で未設定へ戻す
    asyncio.run(production.apply_edit(store, "fake", "update_scene", {
        "node_id": added["id"], "beat": added["beat"], "elapsed_unit": "unset", "reason": "経過を外す"}))
    assert store.get_node(added["id"])["elapsed_unit"] is None
    with pytest.raises(ValueError):
        asyncio.run(production.apply_edit(store, "fake", "update_scene", {
            "node_id": added["id"], "beat": added["beat"], "elapsed_count": 2, "reason": "数だけ"}))


def test_suggest_setting_reads_text_and_refuses_to_guess(store, monkeypatch):
    import llm

    store.append_node({"id": "a", "title": "出発", "beat": "アヤは村を出た。", "cast": ["aya"]})
    store.append_node({"id": "b", "title": "帰還", "beat": "保存済みの本文。", "cast": ["aya"]})
    place = store.create_place({"name": "港"})
    answers = []

    async def fake_chat_json(messages, **kwargs):
        answers.append((messages[1]["content"], kwargs["schema"]))
        return reply

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    suggest = lambda node, field, beat="三日後の朝、アヤは港に戻った。": asyncio.run(
        generation.suggest_scene_setting(store, "http://fake", node, beat, field))

    reply = {"evidence": "三日後の朝", "elapsed_unit": "day", "elapsed_count": 3}
    result = suggest("b", "elapsed")
    assert (result["found"], result["elapsed_unit"], result["elapsed_count"], result["label"]) == (True, "day", 3, "3日後")
    # 前のシーンの本文と、画面から渡した(未保存の)本文で判断する
    assert "アヤは村を出た。" in answers[-1][0] and "三日後の朝" in answers[-1][0] and "保存済みの本文" not in answers[-1][0]
    # 分からない / 根拠が無いものは値を出さない(推測で「直後」にしない)
    reply = {"evidence": "", "elapsed_unit": "unknown", "elapsed_count": 1}
    assert suggest("b", "elapsed") == {"found": False, "evidence": "", "elapsed_unit": None, "elapsed_count": None, "label": None}
    reply = {"evidence": "", "elapsed_unit": "immediate", "elapsed_count": 1}
    assert suggest("b", "elapsed")["found"] is False
    reply = {"evidence": "数日後", "elapsed_unit": "day", "elapsed_count": 0}
    assert suggest("b", "elapsed")["elapsed_count"] == 1
    with pytest.raises(ValueError):
        suggest("a", "elapsed")  # 最初のシーンには前のシーンが無い

    reply = {"evidence": "港に戻った", "location": place["id"]}
    result = suggest("b", "location")
    assert (result["found"], result["location"], result["label"]) == (True, place["id"], "港")
    assert answers[-1][1]["properties"]["location"]["enum"] == [place["id"], "unknown"]
    reply = {"evidence": "どこか", "location": "unknown"}
    assert suggest("b", "location")["location"] is None
    store.delete_place(place["id"])
    with pytest.raises(ValueError):
        suggest("b", "location")  # 場所が1つも登録されていない


def test_chapter_digest_memory_is_dated_by_the_chapters_last_scene(store):
    """章のまとめの要約記憶はシーンに属さないが、章の最後のシーンの時点として時期を付ける。"""
    n1 = store.append_node({"beat": "一", "cast": ["aya"]}, [memory("石橋で誓った")])
    n2 = store.append_node({"beat": "二", "cast": ["aya"], "elapsed_unit": "day", "elapsed_count": 2}, [memory("ケンと決別した")])
    n3 = store.append_node({"beat": "三", "cast": ["aya"], "elapsed_unit": "month", "elapsed_count": 3}, [memory("港で船を待った")])
    group = store.create_group("第一章", [n1["id"], n2["id"]])
    replaced = [e["id"] for nid in (n1["id"], n2["id"]) for e in store.list_events(nid) if e["type"] == "memory_add"]
    store.save_group_digest(group["id"], [{"type": "memory_compress", "payload": {
        "char": "aya", "replaces": replaced, "summary": "第一章で誓いと決別を経た", "importance": 0.9}}])
    path = store.canon_path()
    text = chat_agent.build_character_system(store, path, "aya", "interview")
    # 章の最後のシーン(二)は、いま(三)の3か月前
    assert "- (約3か月前)第一章で誓いと決別を経た" in text and "- (今日)港で船を待った" in text
    found = chat_agent._tool_search_memories(store, path, "upto", {"query": "誓いと決別", "char_id": "aya"})["memories"]
    assert (found[0]["content"], found[0]["when"], found[0]["node_id"]) == ("第一章で誓いと決別を経た", "約3か月前", None)
    # 次の章の先頭が未設定なら、章のまとめの時期も分からない
    store.update_node(n3["id"], {"elapsed_unit": None})
    assert "- 第一章で誓いと決別を経た" in chat_agent.build_character_system(store, path, "aya", "interview")
