"""llama.cpp (llama-server) クライアント。

httpx の非同期クライアントで通信する(FastAPI のイベントループを塞がないため)。
構造化出力は json_schema response_format(news-picker の llm.py と同方式)。
"""

from __future__ import annotations

import itertools
import json
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any

import httpx

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://127.0.0.1:8080"

# 思考モード(reasoning)は常に無効化する。処理時間を抑えるため全呼び出しに付与。
# enable_thinking は Qwen3 等の chat template が参照するキー。参照しない
# テンプレートでは単に無視されるだけなので付けても害はない。
NO_THINK_TEMPLATE_KWARGS = {"enable_thinking": False}

# プロンプトデバッグログ(直近 N 件。docs/design/system-prompts.md)
PROMPT_LOG: deque[dict[str, Any]] = deque(maxlen=30)
_log_ids = itertools.count(1)


def _log_prompt(
    label: str, messages: list[dict[str, Any]], temperature: float, max_tokens: int
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": next(_log_ids),
        "time": datetime.now(timezone.utc).isoformat(),
        "label": label,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response": None,
        "finish_reason": None,
        "usage": None,
        "error": None,
    }
    PROMPT_LOG.appendleft(entry)
    return entry


async def health(base_url: str, timeout: float = 2.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(f"{base_url}/health")
            return res.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


async def chat(
    messages: list[dict[str, Any]],
    *,
    base_url: str,
    max_tokens: int = 2048,
    temperature: float = 0.8,
    timeout: float = 600.0,
    response_json_schema: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    label: str = "chat",
) -> dict[str, Any]:
    """非ストリームの chat completion。{"content", "usage"} を返す。

    llama.cpp b98xx 系は生成出力がチャットテンプレートの期待形式に
    パースできないと 500 を返すことがある(確率的)。リトライでは
    temperature を 0.2 に倒し、出力上限を広げて引き直す(news-picker の知見)。
    """
    payload: dict[str, Any] = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "chat_template_kwargs": NO_THINK_TEMPLATE_KWARGS,
    }
    if response_json_schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "result", "schema": response_json_schema},
        }
    if tools is not None:
        payload["tools"] = tools

    entry = _log_prompt(label, messages, temperature, max_tokens)
    retries = 2
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            for attempt in range(retries + 1):
                attempt_payload = payload
                if attempt > 0:
                    attempt_payload = {
                        **payload,
                        "temperature": 0.2,
                        "max_tokens": max(max_tokens, 4096),
                    }
                res = await client.post(f"{base_url}/v1/chat/completions", json=attempt_payload)
                if res.status_code == 500 and attempt < retries:
                    body = res.text[:200]
                    if "does not match the expected" in body:
                        log.info("llama-server parse error, retrying (%d): %s", attempt + 1, body)
                        continue
                if res.status_code != 200:
                    raise RuntimeError(f"llama-server {res.status_code}: {res.text[:500]}")
                data = res.json()
                break
    except Exception as e:
        entry["error"] = str(e)
        raise

    choice = data["choices"][0]
    message = choice["message"]
    content = message.get("content") or ""
    tool_calls = message.get("tool_calls")
    entry["response"] = (
        content[:3000] if content else json.dumps(tool_calls, ensure_ascii=False)[:3000] if tool_calls else ""
    )
    entry["finish_reason"] = choice.get("finish_reason")
    entry["usage"] = data.get("usage", {})
    return {
        "content": content,
        "tool_calls": tool_calls,
        "message": message,  # tool ループで履歴に積み直す用
        "finish_reason": choice.get("finish_reason"),
        "usage": data.get("usage", {}),
    }


async def chat_stream(
    messages: list[dict[str, Any]],
    *,
    base_url: str,
    max_tokens: int = 4096,
    temperature: float = 0.9,
    timeout: float = 600.0,
    label: str = "stream",
):
    """ストリーミング chat completion。content の delta 文字列を逐次 yield する。"""
    payload: dict[str, Any] = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        "chat_template_kwargs": NO_THINK_TEMPLATE_KWARGS,
    }
    entry = _log_prompt(label, messages, temperature, max_tokens)
    collected: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", f"{base_url}/v1/chat/completions", json=payload
            ) as res:
                if res.status_code != 200:
                    body = (await res.aread()).decode("utf-8", errors="replace")
                    raise RuntimeError(f"llama-server {res.status_code}: {body[:500]}")
                buffer = ""
                async for chunk in res.aiter_text():
                    buffer += chunk
                    while "\n\n" in buffer:
                        part, buffer = buffer.split("\n\n", 1)
                        line = part.strip()
                        if not line.startswith("data: "):
                            continue
                        data = line[len("data: "):]
                        if data == "[DONE]":
                            return
                        obj = json.loads(data)
                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta", {}).get("content")
                        if delta:
                            collected.append(delta)
                            yield delta
    except Exception as e:
        entry["error"] = str(e)
        raise
    finally:
        entry["response"] = "".join(collected)[:3000]


async def chat_stream_tools(
    messages: list[dict[str, Any]],
    *,
    base_url: str,
    max_tokens: int = 2048,
    temperature: float = 0.8,
    timeout: float = 600.0,
    tools: list[dict[str, Any]] | None = None,
    label: str = "stream",
):
    """tools 対応のストリーミング chat completion(news-picker の方式を移植)。

    yield するイベント:
      ("content", str) — 本文のデルタ
      ("done", dict)   — 最後に1回。chat() と同じ形の集約結果
    tool_calls はデルタを index ごとに組み立てて done に含める。
    """
    payload: dict[str, Any] = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        "chat_template_kwargs": NO_THINK_TEMPLATE_KWARGS,
    }
    if tools is not None:
        payload["tools"] = tools

    entry = _log_prompt(label, messages, temperature, max_tokens)
    content_parts: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", f"{base_url}/v1/chat/completions", json=payload
            ) as res:
                if res.status_code != 200:
                    body = (await res.aread()).decode("utf-8", errors="replace")
                    raise RuntimeError(f"llama-server {res.status_code}: {body[:500]}")
                buffer = ""
                async for chunk in res.aiter_text():
                    buffer += chunk
                    while "\n\n" in buffer:
                        part, buffer = buffer.split("\n\n", 1)
                        line = part.strip()
                        if not line.startswith("data: "):
                            continue
                        data = line[len("data: "):]
                        if data == "[DONE]":
                            buffer = ""
                            break
                        obj = json.loads(data)
                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        if delta.get("content"):
                            content_parts.append(delta["content"])
                            yield ("content", delta["content"])
                        for tc in delta.get("tool_calls") or []:
                            index = tc.get("index", 0)
                            slot = tool_calls.setdefault(
                                index,
                                {"id": None, "type": "function", "function": {"name": "", "arguments": ""}},
                            )
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            function = tc.get("function") or {}
                            if function.get("name"):
                                slot["function"]["name"] += function["name"]
                            if function.get("arguments"):
                                slot["function"]["arguments"] += function["arguments"]
    except Exception as e:
        entry["error"] = str(e)
        raise

    calls = [tool_calls[i] for i in sorted(tool_calls)] or None
    content = "".join(content_parts)
    message: dict[str, Any] = {"role": "assistant", "content": content or None}
    if calls:
        message["tool_calls"] = calls
    entry["response"] = (
        content[:3000] if content else json.dumps(calls, ensure_ascii=False)[:3000] if calls else ""
    )
    yield (
        "done",
        {
            "content": content,
            "tool_calls": calls,
            "message": message,  # tool ループで履歴に積み直す用
        },
    )


async def chat_json(
    messages: list[dict[str, Any]],
    *,
    base_url: str,
    schema: dict[str, Any],
    max_tokens: int = 2048,
    temperature: float = 0.8,
    label: str = "json",
) -> dict[str, Any]:
    """構造化出力を要求し、パース済み dict を返す。"""
    result = await chat(
        messages,
        base_url=base_url,
        max_tokens=max_tokens,
        temperature=temperature,
        response_json_schema=schema,
        label=label,
    )
    if result["finish_reason"] == "length":
        raise RuntimeError(
            f"構造化出力が max_tokens({max_tokens}) で打ち切られました。"
            f" 末尾: …{result['content'][-200:]}"
        )
    try:
        return json.loads(result["content"])
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"構造化出力の JSON パースに失敗(finish={result['finish_reason']}):"
            f" {result['content'][:300]}"
        ) from e
