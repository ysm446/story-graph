"""llama.cpp (llama-server) クライアント。

httpx の非同期クライアントで通信する(FastAPI のイベントループを塞がないため)。
構造化出力は json_schema response_format(news-picker の llm.py と同方式)。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://127.0.0.1:8080"


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
    }
    if response_json_schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "result", "schema": response_json_schema},
        }

    retries = 2
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

    choice = data["choices"][0]
    return {
        "content": choice["message"].get("content") or "",
        "finish_reason": choice.get("finish_reason"),
        "usage": data.get("usage", {}),
    }


async def chat_json(
    messages: list[dict[str, Any]],
    *,
    base_url: str,
    schema: dict[str, Any],
    max_tokens: int = 2048,
    temperature: float = 0.8,
) -> dict[str, Any]:
    """構造化出力を要求し、パース済み dict を返す。"""
    result = await chat(
        messages,
        base_url=base_url,
        max_tokens=max_tokens,
        temperature=temperature,
        response_json_schema=schema,
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
