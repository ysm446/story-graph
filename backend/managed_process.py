"""子プロセスとして起動するローカルサーバー(llama-server / ComfyUI / TTS)の共通部品。

各マネージャー(llama_manager / comfy_manager / tts_manager)は、起動コマンドと待ち時間だけを持つ。
"""
from __future__ import annotations

import asyncio
import subprocess
from typing import Awaitable, Callable

import httpx

# Windows でコンソール窓を出さずに起動する
NO_WINDOW = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


async def http_ok(url: str, timeout: float = 2.0) -> bool:
    """url が 200 を返すか。接続だけは短く待つ。

    Windows では閉じた localhost のポートへの接続が「拒否」になるまで約 2 秒かかり、右上のバーが
    数秒ごとに呼ぶ /llm/status・/comfy/status・/tts/status がその分だけ遅くなる(動いていれば数 ms で繋がる)。
    """
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=0.5)) as client:
            res = await client.get(url)
            return res.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


def kill_tree(proc: subprocess.Popen) -> None:
    """プロセスを子ごと止めて終了を待つ。taskkill が失敗してもプロセスを残さない(VRAM を掴んだ孤児を防ぐ)。"""
    if proc.poll() is not None:
        return
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)
    except OSError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


async def wait_healthy(
    get_proc: Callable[[], subprocess.Popen | None],
    is_healthy: Callable[[], Awaitable[bool]],
    timeout_sec: float,
    name: str,
    exit_note: str = "",
) -> bool:
    """起動したプロセスが応答するまで 1 秒ごとに確かめる。時間切れなら False。

    待っている間に stop() でプロセスが手放された・プロセスが終了した場合は RuntimeError
    (exit_note は終了時のメッセージの後ろに添える。ログの場所など)。
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_sec
    while loop.time() < deadline:
        proc = get_proc()
        if proc is None:
            raise RuntimeError(f"{name} は停止されました")
        if proc.poll() is not None:
            raise RuntimeError(f"{name} が終了しました (exit {proc.returncode}){exit_note}")
        if await is_healthy():
            return True
        await asyncio.sleep(1.0)
    return False
