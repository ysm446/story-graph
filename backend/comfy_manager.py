"""ComfyUI プロセスのライフサイクル管理(llama_manager と同じ作法)。

- settings の comfy_base_url が既に応答していればそれを使う(外部起動を優先)
- そうでなければ runtime/comfyui/ の portable 版を spawn する
- 起動のたびに extra_model_paths.yaml を書き直し、settings の comfy_models_dir を反映する
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import comfy
import comfy_installer

log = logging.getLogger(__name__)

DEFAULT_PORT = 8188
DEFAULT_BASE_URL = f"http://127.0.0.1:{DEFAULT_PORT}"
# この PC のモデル置き場(ユーザー指定 2026-08-26)。settings の comfy_models_dir で上書き可能。
# 無い環境では空 = portable 同梱の models/ だけを使う
DEFAULT_MODELS_DIR = r"D:\ai-models\diffusion\comfyui"


def resolve_base_url(settings: dict[str, str]) -> str:
    return (settings.get("comfy_base_url") or "").strip() or DEFAULT_BASE_URL


def resolve_models_dir(settings: dict[str, str]) -> str:
    configured = (settings.get("comfy_models_dir") or "").strip()
    if configured:
        return configured
    return DEFAULT_MODELS_DIR if Path(DEFAULT_MODELS_DIR).is_dir() else ""


class ComfyManager:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.base_url: str | None = None
        self._lock = asyncio.Lock()

    def status(self) -> dict:
        running = self.proc is not None and self.proc.poll() is None
        return {"spawned": running, "base_url": self.base_url}

    async def ensure_running(self, settings: dict[str, str]) -> str:
        base_url = resolve_base_url(settings)
        if await comfy.health(base_url):
            self.base_url = base_url
            return base_url
        async with self._lock:
            if await comfy.health(base_url):
                self.base_url = base_url
                return base_url
            if self.proc is not None and self.proc.poll() is None:
                if await self._wait_healthy(base_url, 120):
                    return base_url
                raise RuntimeError("ComfyUI が応答しません(起動待ちタイムアウト)")
            return await self.start(settings)

    async def start(self, settings: dict[str, str]) -> str:
        ins = comfy_installer.find_install()
        if ins is None:
            raise RuntimeError(
                "ComfyUI がインストールされていません。設定 →「画像生成」からインストールするか、"
                "起動済みの ComfyUI の URL を設定してください。"
            )
        base_url = resolve_base_url(settings)
        try:
            parts = urlsplit(base_url)
            port = parts.port or DEFAULT_PORT
            host = parts.hostname or "127.0.0.1"
        except ValueError:
            raise RuntimeError(f"comfy_base_url からポートを読めません: {base_url}")
        root = Path(ins["root"])
        comfy_installer.write_extra_model_paths(root, resolve_models_dir(settings))
        args = [
            ins["python"],
            "-s",
            str(root / "ComfyUI" / "main.py"),
            "--windows-standalone-build",
            "--disable-auto-launch",
            "--listen", host,
            "--port", str(port),
        ]
        log.info("spawning ComfyUI: %s", root)
        self.proc = subprocess.Popen(
            args,
            cwd=str(root),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        self.base_url = base_url
        if not await self._wait_healthy(base_url, 180):
            self.stop()
            raise RuntimeError("ComfyUI のヘルスチェックがタイムアウトしました")
        return base_url

    async def _wait_healthy(self, base_url: str, timeout_sec: float) -> bool:
        deadline = asyncio.get_event_loop().time() + timeout_sec
        while asyncio.get_event_loop().time() < deadline:
            proc = self.proc
            if proc is None:
                raise RuntimeError("ComfyUI は停止されました")
            if proc.poll() is not None:
                raise RuntimeError(f"ComfyUI が終了しました (exit {proc.returncode})")
            if await comfy.health(base_url):
                return True
            await asyncio.sleep(1.0)
        return False

    def stop(self) -> None:
        if self.proc is None:
            return
        proc = self.proc
        self.proc = None
        if proc.poll() is None:
            try:
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)
            except OSError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    async def stop_async(self) -> None:
        await asyncio.to_thread(self.stop)
