import asyncio
import json

import pytest

import db
import generation
import llm as llm_mod
from store import Store


@pytest.fixture
def store():
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.create_character({"name": "ケン", "id": "ken"})
    return s


def collect_sse(agen):
    async def run():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in agen]

    return asyncio.run(run())


def _valid_result():
    return {
        "title": "出会い",
        "beat": "アヤとケンが市場で出会う。",
        "emotional_core": "好奇心",
        "cast": ["aya", "ken"],
        "location": "市場",
        "events": [
            {"type": "char_introduce", "payload": {"char": "aya"}},
            {"type": "char_introduce", "payload": {"char": "ken"}},
            {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": 0.2, "reason": "第一印象"}},
        ],
    }


def test_beat_schema_embeds_char_enum():
    schema = generation.beat_schema(["aya", "ken"])
    assert schema["properties"]["cast"]["items"]["enum"] == ["aya", "ken"]
    event_types = [
        s["properties"]["type"]["const"]
        for s in schema["properties"]["events"]["items"]["anyOf"]
    ]
    # LLM が発行できるのは 5 種のみ(manual_override 等は含まない)
    assert set(event_types) == {
        "memory_add", "relationship_update", "fact_set", "char_introduce", "char_retire"
    }


def test_generate_beat_appends_node(store, monkeypatch):
    async def fake_chat_json(messages, **kwargs):
        return _valid_result()

    monkeypatch.setattr(llm_mod, "chat_json", fake_chat_json)
    events = collect_sse(generation.generate_beat_stream(store, "http://fake", None))
    done = events[-1]
    assert done["done"] is True
    assert done["validation"] == []
    assert store.canon_path() == [done["node"]["id"]]
    assert done["node"]["events"][0]["source"] == "llm"


def test_generate_beat_retries_on_validation_error(store, monkeypatch):
    bad = _valid_result()
    bad["cast"] = ["aya", "ken"]
    bad["events"] = [{"type": "char_introduce", "payload": {"char": "aya"}}]  # ken 未登場のまま cast 入り

    calls = {"n": 0}

    async def fake_chat_json(messages, **kwargs):
        calls["n"] += 1
        return bad if calls["n"] == 1 else _valid_result()

    monkeypatch.setattr(llm_mod, "chat_json", fake_chat_json)
    events = collect_sse(generation.generate_beat_stream(store, "http://fake", None))
    stages = [e.get("stage") for e in events if "stage" in e]
    assert "retry" in stages
    assert calls["n"] == 2
    assert events[-1]["validation"] == []


def test_generation_system_prompt_is_editable(store):
    default_prompt = generation.generation_system_prompt(store)
    assert default_prompt.startswith("あなたは物語のビート")
    assert "出力は必ず指定の JSON 形式" in default_prompt  # ルールは常に付く
    store.set_settings({"generation_system_prompt": "あなたはミステリー専門の構成作家です。"})
    custom = generation.generation_system_prompt(store)
    assert custom.startswith("あなたはミステリー専門の構成作家です。")
    assert "出力は必ず指定の JSON 形式" in custom


def test_generate_beat_requires_characters(monkeypatch):
    empty = Store(db.connect(":memory:"))
    events = collect_sse(generation.generate_beat_stream(empty, "http://fake", None))
    assert "error" in events[-1]


def test_suggest_field(monkeypatch):
    async def fake_chat_json(messages, **kwargs):
        assert "タイトル" in messages[0]["content"]
        assert messages[1]["content"] == "アヤは橋でケンの裏切りを知る。"
        return {"value": "石橋の告白"}

    monkeypatch.setattr(llm_mod, "chat_json", fake_chat_json)
    value = asyncio.run(generation.suggest_field("http://fake", "アヤは橋でケンの裏切りを知る。", "title"))
    assert value == "石橋の告白"
    with pytest.raises(ValueError):
        asyncio.run(generation.suggest_field("http://fake", "x", "nonsense"))


def test_extract_events_replaces(store, monkeypatch):
    node = store.append_node({"beat": "アヤが村を出る", "cast": ["aya"]}, [
        {"type": "char_introduce", "payload": {"char": "aya"}},
    ])

    async def fake_chat_json(messages, **kwargs):
        return {
            "events": [
                {"type": "char_introduce", "payload": {"char": "aya"}},
                {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "街道"}},
            ]
        }

    monkeypatch.setattr(llm_mod, "chat_json", fake_chat_json)
    events = asyncio.run(generation.extract_events(store, "http://fake", node["id"]))
    assert len(events) == 2
    assert events[1]["payload"]["key"] == "location"
    state = store.get_state(node["id"])
    assert state["chars"]["aya"]["facts"]["location"] == "街道"


def test_extract_events_restores_missing_introduce(store, monkeypatch):
    node = store.append_node({"beat": "初登場シーン", "cast": ["aya"]})  # 自動付与で intro あり

    async def fake_chat_json(messages, **kwargs):
        # LLM が char_introduce を出し忘れたケース
        return {
            "events": [
                {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "goal", "value": "旅立ち"}},
            ]
        }

    monkeypatch.setattr(llm_mod, "chat_json", fake_chat_json)
    events = asyncio.run(generation.extract_events(store, "http://fake", node["id"]))
    types = [e["type"] for e in events]
    assert types[0] == "char_introduce"  # 自動補完される
    assert store.validate(node["id"]) == []
