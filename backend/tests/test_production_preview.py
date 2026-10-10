import json

import pytest

from production_preview import partial_fields


@pytest.mark.parametrize("text", ["日本語の本文", '段落\n次の行「引用」', 'a"b\\c', "絵文字😀"])
@pytest.mark.parametrize("ascii_only", [True, False])
def test_every_fragment_is_a_decoded_prefix(text, ascii_only):
    raw = json.dumps({"node_id": "first", "beat": text}, ensure_ascii=ascii_only)
    for end in range(1, len(raw) + 1):
        parsed = partial_fields(raw[:end])
        if "beat" in parsed:
            assert text.startswith(parsed["beat"])
            parsed["beat"].encode("utf-8")
    assert partial_fields(raw)["beat"] == text


def test_nested_and_quoted_keys_are_not_used_as_target():
    raw = json.dumps({"reason": '\"node_id\":\"wrong\"', "other": {"node_id": "wrong"}, "node_id": "first", "beat": "本文"})
    assert partial_fields(raw)["node_id"] == "first"
    assert partial_fields('{"node_id":"fir') == {}
    assert partial_fields('{"node_id":"first","beat":null}')["beat"] is None


@pytest.mark.parametrize("enabled", [True, False])
def test_llm_progress_is_opt_in_and_keeps_final_calls(monkeypatch, enabled):
    import asyncio
    import llm
    chunks = [
        {"tool_calls": [{"index": 0, "id": "call", "function": {"name": "update_", "arguments": '{"node_id":"first",'}}]},
        {"tool_calls": [{"index": 0, "function": {"name": "scene", "arguments": '\"beat\":\"本文\"}'}}]},
    ]
    class Response:
        status_code = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def aiter_text(self):
            for delta in chunks:
                yield "data: " + json.dumps({"choices": [{"delta": delta}]}) + "\n\n"
            yield "data: [DONE]\n\n"
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def stream(self, *args, **kwargs): return Response()
    monkeypatch.setattr(llm.httpx, "AsyncClient", Client)
    async def collect():
        return [item async for item in llm.chat_stream_tools([], base_url="fake", emit_tool_progress=enabled)]
    events = asyncio.run(collect())
    progress = [value for kind, value in events if kind == "tool_progress"]
    assert len(progress) == (2 if enabled else 0)
    if enabled:
        assert progress[0]["function"]["name"] == "update_"
    kind, final = events[-1]
    assert kind == "done"
    assert final["tool_calls"][0]["function"] == {"name": "update_scene", "arguments": '{"node_id":"first","beat":"本文"}'}
