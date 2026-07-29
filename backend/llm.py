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


def _extract_stats(chunk: dict[str, Any], choice: dict[str, Any]) -> dict[str, Any]:
    """ストリーム最終チャンクから生成統計を取り出す(lm-chat と同じ読み方)。

    timings は llama.cpp の拡張フィールド。無いサーバーでは usage で代替し、
    速度が取れない場合は None のままにする(UI 側で省略される)。
    """
    usage = chunk.get("usage") or {}
    timings = chunk.get("timings") or {}
    tokens = timings.get("predicted_n") or usage.get("completion_tokens")
    elapsed_ms = timings.get("predicted_ms")
    per_sec = timings.get("predicted_per_second")
    if per_sec is None and tokens and elapsed_ms:
        per_sec = tokens / (elapsed_ms / 1000.0)
    return {
        "tokens": tokens,
        "prompt_tokens": timings.get("prompt_n") or usage.get("prompt_tokens"),
        "tokens_per_sec": per_sec,
        "elapsed_sec": (elapsed_ms / 1000.0) if elapsed_ms is not None else None,
        "finish_reason": choice.get("finish_reason"),
    }


async def count_tokens(text: str, *, base_url: str, timeout: float = 10.0) -> int | None:
    """llama-server の /tokenize でトークン数を数える(lm-chat と同方式)。
    サーバーが応答しないときは None(呼び出し側で概算に落とす)。"""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(f"{base_url}/tokenize", json={"content": text})
            res.raise_for_status()
            return len(res.json().get("tokens", []))
    except (httpx.HTTPError, OSError, ValueError):
        return None


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

    try:
        choice = data["choices"][0]
        message = choice["message"]
    except (KeyError, IndexError, TypeError) as e:
        entry["error"] = f"応答形式が不正: {str(data)[:200]}"
        raise RuntimeError(entry["error"]) from e
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
                        # ストリーム開始後のエラーは HTTP 200 のまま error オブジェクトで
                        # 届く(ctx 溢れ等)。捨てると途切れた出力が成功扱いになる
                        if obj.get("error"):
                            raise RuntimeError(
                                f"llama-server ストリームエラー: {json.dumps(obj['error'], ensure_ascii=False)[:300]}"
                            )
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
    stats: dict[str, Any] = {}
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
                        if obj.get("error"):
                            raise RuntimeError(
                                f"llama-server ストリームエラー: {json.dumps(obj['error'], ensure_ascii=False)[:300]}"
                            )
                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        # 生成統計は finish_reason を持つ最終チャンクに入る
                        # (timings は llama.cpp の拡張。usage は OAI 互換)
                        if choices[0].get("finish_reason"):
                            stats = _extract_stats(obj, choices[0])
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
    if stats:
        entry["usage"] = {"prompt_tokens": stats.get("prompt_tokens"), "completion_tokens": stats.get("tokens")}
        entry["finish_reason"] = stats.get("finish_reason")
    yield (
        "done",
        {
            "content": content,
            "tool_calls": calls,
            "message": message,  # tool ループで履歴に積み直す用
            "stats": stats,  # トークン数 / 速度 / 所要時間 / finish_reason
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
