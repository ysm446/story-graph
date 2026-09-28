"""TTS サーバーのライフサイクル管理(comfy_manager と同じ作法)。

- settings の tts_base_url(空ならエンジン定義の default_port)が既に応答していればそれを使う
  (外部起動を優先。その場合は止めない)
- そうでなければ runtime/tts/<engine>/ から、エンジン定義の launch で spawn する
- 停止はプロセスごと止める(モデルだけ外す API はエンジンによって有無が違うので当てにしない)
- サーバーの出力は runtime/tts/<engine>/story-graph-server.log に書く(初回のモデル取得や
  起動失敗の理由を後から読めるように)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import tts
import tts_installer

log = logging.getLogger(__name__)

# この PC の TTS モデル置き場(ユーザー指定 2026-09-28)。settings の tts_models_dir で上書き可能。
# 無い環境では空 = 各エンジンの既定のキャッシュ(HF なら ~/.cache/huggingface)を使う
DEFAULT_MODELS_DIR = r"D:\ai-models\tts"
LOG_NAME = "story-graph-server.log"


def resolve_models_dir(settings: dict[str, str]) -> str:
    configured = (settings.get("tts_models_dir") or "").strip()
    if configured:
        return configured
    return DEFAULT_MODELS_DIR if Path(DEFAULT_MODELS_DIR).is_dir() else ""


def launch_spec(engine: dict[str, Any], settings: dict[str, str], uv: str | None) -> tuple[list[str], dict[str, str]]:
    """エンジン定義の launch を埋めて (コマンド, 追加の環境変数) を返す。"""
    base_url = tts.resolve_base_url(settings, engine)
    try:
        parts = urlsplit(base_url)
        port = parts.port or engine.get("default_port", 8088)
        host = parts.hostname or "127.0.0.1"
    except ValueError:
        raise RuntimeError(f"tts_base_url からポートを読めません: {base_url}")
    models_dir = resolve_models_dir(settings)
    values = {
        "uv": uv,
        "host": host,
        "port": port,
        "install_dir": str(tts_installer.install_dir(engine["id"])),
        "models_dir": models_dir.replace("\\", "/") if models_dir else "",
    }
    spec = engine.get("launch") or {}
    cmd = tts.fill(spec.get("cmd") or [], values) or []
    if not cmd:
        raise RuntimeError(f"{engine['id']} の定義に launch.cmd がありません")
    env = tts.fill(spec.get("env") or {}, values) or {}
    return [str(a) for a in cmd], {k: str(v) for k, v in env.items()}


class TtsManager:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.engine_id: str | None = None
        self.base_url: str | None = None
        self._log_file = None
        self._lock = asyncio.Lock()

    def status(self) -> dict[str, Any]:
        running = self.proc is not None and self.proc.poll() is None
        return {"spawned": running, "spawned_engine": self.engine_id if running else None}

    async def ensure_running(self, settings: dict[str, str]) -> str:
        engine = tts.get_engine(tts.resolve_engine_id(settings))
        base_url = tts.resolve_base_url(settings, engine)
        health_path = engine.get("health_path", "/health")
        if await tts.health(base_url, health_path):
            return base_url
        async with self._lock:
            if await tts.health(base_url, health_path):
                return base_url
            if self.proc is not None and self.proc.poll() is None:
                if self.engine_id == engine["id"]:
                    if await self._wait_healthy(base_url, health_path, engine.get("startup_timeout_sec", 600)):
                        return base_url
                    raise RuntimeError("TTS サーバーが応答しません(起動待ちタイムアウト)")
                await self.stop_async()  # 別のエンジンが動いていたら入れ替える
            return await self._start(engine, settings)

    async def _start(self, engine: dict[str, Any], settings: dict[str, str]) -> str:
        if not tts_installer.status(engine["id"])["installed"]:
            raise RuntimeError(
                f"{engine.get('label', engine['id'])} がインストールされていません。"
                "設定 →「音声読み上げ」からインストールするか、起動済みの TTS サーバーの URL を設定してください。"
            )
        uv = tts_installer.find_uv()
        if uv is None and "{uv}" in json.dumps((engine.get("launch") or {}).get("cmd") or []):
            raise RuntimeError("uv が見つかりません。設定 →「音声読み上げ」からインストールし直してください。")
        cmd, extra_env = launch_spec(engine, settings, uv)
        cwd = tts_installer.install_dir(engine["id"])
        base_url = tts.resolve_base_url(settings, engine)
        env = {**os.environ, "PYTHONUTF8": "1", "UV_PYTHON_PREFERENCE": "only-managed", **extra_env}
        log.info("spawning TTS server (%s): %s", engine["id"], cmd)
        self._close_log()
        self._log_file = open(cwd / LOG_NAME, "wb")  # noqa: SIM115 — プロセスの寿命と同じだけ開いておく
        self.proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=self._log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        self.engine_id = engine["id"]
        self.base_url = base_url
        timeout = engine.get("startup_timeout_sec", 600)
        if not await self._wait_healthy(base_url, engine.get("health_path", "/health"), timeout):
            await self.stop_async()
            raise RuntimeError(f"TTS サーバーのヘルスチェックがタイムアウトしました({timeout} 秒)。ログ: {cwd / LOG_NAME}")
        return base_url

    async def _wait_healthy(self, base_url: str, path: str, timeout_sec: float) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_sec
        while loop.time() < deadline:
            proc = self.proc
            if proc is None:
                raise RuntimeError("TTS サーバーは停止されました")
            if proc.poll() is not None:
                log_path = tts_installer.install_dir(self.engine_id or "") / LOG_NAME
                raise RuntimeError(f"TTS サーバーが終了しました (exit {proc.returncode})。ログ: {log_path}")
            if await tts.health(base_url, path):
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
        self._close_log()

    async def stop_async(self) -> None:
        await asyncio.to_thread(self.stop)

    def _close_log(self) -> None:
        if self._log_file is not None:
            try:
                self._log_file.close()
            except OSError:
                pass
            self._log_file = None
