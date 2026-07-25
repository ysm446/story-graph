import asyncio
import json

import pytest

import chat_agent
import db
import embed
import llm as llm_mod
from store import Store


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.create_character({"name": "ケン", "id": "ken"})
    s.append_node({"beat": "出会い", "cast": ["aya", "ken"], "title": "第一話"}, [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        {"type": "char_introduce", "payload": {"char": "ken"}},
        {"type": "memory_add", "payload": {"char": "aya", "content": "石橋でケンの裏切りを知った", "importance": 0.9}},
    ])
    s.append_node({"beat": "対峙", "cast": ["aya", "ken"], "title": "第二話"})
    s.append_node({"beat": "決着", "cast": ["aya", "ken"], "title": "第三話"})
    return s


def collect_sse(agen):
    async def run():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in agen]

    return asyncio.run(run())


def _tool_call(name, args, call_id="tc1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def _fake_stream(results):
    """chat_stream_tools のモック。呼び出しごとに results を順に消費し、
    content をデルタとして流してから done を返す async generator を作る。"""
    calls = {"n": 0}

    def fake(messages, **kwargs):
        result = results[min(calls["n"], len(results) - 1)]
        calls["n"] += 1

        async def gen():
            if result.get("content"):
                yield ("content", result["content"])
            yield ("done", result)

        return gen()

    return fake


def test_scope_upto_limits_beats(store):
    anchor = store.canon_path()[1]  # 第二話まで
    path = chat_agent._visible_path(store, anchor, "upto")
    result = chat_agent._tool_get_beats(store, path, {})
    assert result["total"] == 2
    assert [b["title"] for b in result["beats"]] == ["第一話", "第二話"]
    # all なら全件
    all_path = chat_agent._visible_path(store, anchor, "all")
    assert chat_agent._tool_get_beats(store, all_path, {})["total"] == 3


def test_tool_loop_and_persistence(store, monkeypatch):
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([
            {
                "content": "",
                "tool_calls": [_tool_call("get_beats", {"from_index": 1, "to_index": 2})],
                "message": {"role": "assistant", "content": None,
                            "tool_calls": [_tool_call("get_beats", {"from_index": 1, "to_index": 2})]},
            },
            {"content": "第二話まで確認しました。", "tool_calls": None,
             "message": {"role": "assistant", "content": "第二話まで確認しました。"}},
        ]),
    )
    anchor = store.canon_path()[1]
    events = collect_sse(chat_agent.chat_stream(store, "http://fake", None, anchor, "upto", "状況を教えて"))
    assert any("tool_call" in e for e in events)
    # 回答はデルタとしてもストリームされる
    assert "".join(e["delta"] for e in events if "delta" in e) == "第二話まで確認しました。"
    final = events[-1]
    assert final["answer"] == "第二話まで確認しました。"
    # 永続化: 履歴に user / assistant(tool_calls) / tool / assistant が残る
    chat = store.get_chat(final["chat_id"])
    roles = [m["role"] for m in chat["messages"]]
    assert roles == ["user", "assistant", "tool", "assistant"]
    assert chat["anchor_node"] == anchor
    assert chat["scope"] == "upto"


def test_proposals_are_emitted(store, monkeypatch):
    proposals = [
        {"title": "決裂", "beat": "アヤはケンを追放する。", "cast": ["aya", "ken"]},
        {"title": "和解", "beat": "アヤはケンを赦す。", "cast": ["aya", "ken"]},
    ]
    tc = _tool_call("propose_beats", {"proposals": proposals})
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([
            {"content": "", "tool_calls": [tc],
             "message": {"role": "assistant", "content": None, "tool_calls": [tc]}},
            {"content": "2案あります。", "tool_calls": None,
             "message": {"role": "assistant", "content": "2案あります。"}},
        ]),
    )
    events = collect_sse(chat_agent.chat_stream(store, "http://fake", None, None, "upto", "この先を提案して"))
    emitted = next(e["proposals"] for e in events if "proposals" in e)
    assert [p["title"] for p in emitted] == ["決裂", "和解"]


def test_search_memories_tool_scope(store):
    path = chat_agent._visible_path(store, store.canon_path()[-1], "upto")
    result = chat_agent._tool_search_memories(store, path, "upto", {"query": "裏切り"})
    assert any("裏切り" in m["content"] for m in result["memories"])


def test_force_draft_insertion(store):
    tail = store.canon_path()[-1]
    node = store.append_node(
        {"beat": "提案から挿入", "cast": ["aya"], "title": "if 案"},
        parent_id=tail, force_draft=True,
    )
    assert node["status"] == "draft"
    # 正史は変わらない
    assert store.canon_path()[-1] == tail


def test_usage_text_includes_system_tools_and_history(store):
    path = store.canon_path()
    chat = store.create_chat(path[-1], "upto")
    tc = _tool_call("get_state", {})
    store.save_chat_messages(
        chat["id"],
        [
            {"role": "user", "content": "アヤの状態は?"},
            {"role": "assistant", "content": None, "tool_calls": [tc]},
            {"role": "tool", "tool_call_id": "tc1", "content": '{"chars": {}}'},
            {"role": "assistant", "content": "落ち着いています。"},
        ],
    )
    text = chat_agent._usage_text(store, store.get_chat(chat["id"]), path, "upto")
    assert "あなたは物語作りの相談相手です" in text  # システムプロンプト
    assert "search_memories" in text  # ツール定義
    assert "アヤの状態は?" in text  # ユーザー発言
    assert "get_state({})" in text  # tool_calls
    assert "落ち着いています。" in text  # 回答


def test_token_usage_falls_back_to_estimate_when_server_down(store, monkeypatch):
    async def unavailable(text, *, base_url, timeout=10.0):
        return None

    monkeypatch.setattr(llm_mod, "count_tokens", unavailable)
    usage = asyncio.run(chat_agent.token_usage(store, "http://fake", None, store.canon_path()[-1], "upto"))
    assert usage["estimated"] is True
    assert usage["token_count"] > 0


def test_token_usage_uses_tokenizer_when_available(store, monkeypatch):
    async def counted(text, *, base_url, timeout=10.0):
        return 1234

    monkeypatch.setattr(llm_mod, "count_tokens", counted)
    usage = asyncio.run(chat_agent.token_usage(store, "http://fake", None, store.canon_path()[-1], "upto"))
    assert usage == {"token_count": 1234, "estimated": False}
