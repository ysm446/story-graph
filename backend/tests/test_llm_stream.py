"""llm のストリーム読み取り(chat_stream / chat_stream_tools が共有する _stream_chunks)"""
import asyncio
import json

import httpx
import pytest

import llm


def _serve(monkeypatch, chunks: list[dict]) -> None:
    body = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=body.encode("utf-8")))
    real = httpx.AsyncClient
    monkeypatch.setattr(llm.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw))


def test_chat_stream_yields_deltas_and_stats(monkeypatch):
    _serve(monkeypatch, [
        {"choices": [{"delta": {"content": "こん"}}]},
        {"choices": [{"delta": None}]},  # delta が null のチャンクで落ちない
        {"choices": [{"delta": {"content": "にちは"}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"completion_tokens": 3, "prompt_tokens": 9}},
    ])
    stats: dict = {}

    async def run() -> list[str]:
        return [d async for d in llm.chat_stream([{"role": "user", "content": "hi"}], base_url="http://x", stats_out=stats)]

    assert "".join(asyncio.run(run())) == "こんにちは"
    assert stats["tokens"] == 3
    assert stats["finish_reason"] == "stop"


def test_chat_stream_tools_assembles_tool_call_fragments(monkeypatch):
    _serve(monkeypatch, [
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "get_", "arguments": '{"q"'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "beats", "arguments": ': "x"}'}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ])

    async def run() -> dict:
        async for kind, value in llm.chat_stream_tools([{"role": "user", "content": "hi"}], base_url="http://x"):
            if kind == "done":
                return value
        raise AssertionError("done が来ない")

    done = asyncio.run(run())
    assert done["tool_calls"] == [
        {"id": "c1", "type": "function", "function": {"name": "get_beats", "arguments": '{"q": "x"}'}}
    ]
    assert done["message"]["tool_calls"] == done["tool_calls"]


def test_stream_error_object_raises(monkeypatch):
    _serve(monkeypatch, [{"error": {"message": "context overflow"}}])

    async def run() -> None:
        async for _ in llm.chat_stream([{"role": "user", "content": "hi"}], base_url="http://x"):
            pass

    with pytest.raises(RuntimeError, match="ストリームエラー"):
        asyncio.run(run())
