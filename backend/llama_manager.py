"""llama-server.exe のライフサイクル管理(lm-graph の llamaServer.ts を Python に翻訳)。

- settings の llm_base_url が既に healthy ならそれを使う(外部起動を優先)
- そうでなければ llama_server_path + llm_model_path で spawn する
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import llm

log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent

# lm-graph のバイナリを流用(197MB あるためリポジトリにはコピーしない)。
# settings の llama_server_path で上書き可能。
DEFAULT_SERVER_PATH = r"D:\GitHub\lm-graph\bin\llama-server\b9496-win-cuda13-x64\llama-server.exe"
DEFAULT_MODEL_PATH = str(REPO_ROOT / "models" / "gemma-4-31B-it-GGUF" / "gemma-4-31B-it-Q6_K.gguf")
DEFAULT_PORT = 8080


class LlamaManager:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.base_url: str | None = None
        self.model_path: str | None = None
        # 並行リクエスト(生成 + チャット等)が同時に spawn して proc を
        # 上書きし合わないための排他。ensure_running / switch 全体に掛ける
        self._lock = asyncio.Lock()

    def status(self) -> dict:
        running = self.proc is not None and self.proc.poll() is None
        return {
            "spawned": running,
            "base_url": self.base_url,
            "model_path": self.model_path if running else None,
        }

    async def ensure_running(self, settings: dict[str, str]) -> str:
        """healthy な base_url を返す。必要なら spawn する。"""
        base_url = settings.get("llm_base_url") or f"http://127.0.0.1:{DEFAULT_PORT}"
        if await llm.health(base_url):
            self.base_url = base_url
            return base_url
        async with self._lock:
            # ロック待ちの間に別リクエストが起動を済ませていることがある
            if await llm.health(base_url):
                self.base_url = base_url
                return base_url
            if self.proc is not None and self.proc.poll() is None:
                # spawn 済みだがまだ起動中
                if await self._wait_healthy(base_url, 60):
                    return base_url
                raise RuntimeError("llama-server が応答しません(起動待ちタイムアウト)")
            return await self.start(settings)

    async def switch(self, settings: dict[str, str]) -> str:
        """現在のモデルを止めて、settings のモデルで起動し直す(モデル選択からのロード用)。"""
        async with self._lock:
            base_url = settings.get("llm_base_url") or f"http://127.0.0.1:{DEFAULT_PORT}"
            was_managed = self.proc is not None and self.proc.poll() is None
            await self.stop_async()
            if not was_managed and await llm.health(base_url):
                # 外部で起動された llama-server は当アプリからは切り替えられない
                raise RuntimeError(
                    "外部起動の llama-server が使用中のため切り替えられません。"
                    "その llama-server を停止してから再試行してください。"
                )
            # 旧プロセスのポート解放を待つ(健全応答が消えるまで)
            deadline = asyncio.get_event_loop().time() + 10
            while asyncio.get_event_loop().time() < deadline:
                if not await llm.health(base_url):
                    break
                await asyncio.sleep(0.3)
            return await self.start(settings)

    async def start(self, settings: dict[str, str]) -> str:
        # 優先度: 設定の手入力パス > runtime/ 等に自動インストール済みのもの > lm-graph 流用の既定
        import llama_installer

        server_path = settings.get("llama_server_path") or llama_installer.resolve_server_path() or DEFAULT_SERVER_PATH
        model_path = settings.get("llm_model_path") or DEFAULT_MODEL_PATH
        base_url = settings.get("llm_base_url") or f"http://127.0.0.1:{DEFAULT_PORT}"
        try:
            port = urlsplit(base_url).port or DEFAULT_PORT
        except ValueError:
            raise RuntimeError(f"llm_base_url からポートを読めません: {base_url}")
        ctx_size = int(settings.get("llm_ctx_size") or 16384)

        if not Path(server_path).exists():
            raise RuntimeError(f"llama-server が見つかりません: {server_path}")
        if not Path(model_path).exists():
            raise RuntimeError(f"モデルが見つかりません: {model_path}")

        args = [
            server_path,
            "--host", "127.0.0.1",
            "--port", str(port),
            "--model", model_path,
            "--alias", Path(model_path).stem,
            "--ctx-size", str(ctx_size),
            "--flash-attn", "on",
            "--n-gpu-layers", "999",
            "--jinja",  # tool calling(相談チャット)に必要
            # 前リクエストと共通する接頭辞(システムプロンプト+キャラ+状態)の
            # KV キャッシュを 256 トークン以上の塊で再利用する。連続清書や
            # チャットの継続ターンでプロンプト処理(prefill)を大きく削れる
            "--cache-reuse", "256",
        ]
        log.info("spawning llama-server: %s", model_path)
        self.proc = subprocess.Popen(
            args,
            cwd=str(Path(server_path).parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        self.model_path = model_path
        self.base_url = base_url
        if not await self._wait_healthy(base_url, 180):
            self.stop()
            raise RuntimeError("llama-server のヘルスチェックがタイムアウトしました(モデルロード失敗の可能性)")
        return base_url

    async def _wait_healthy(self, base_url: str, timeout_sec: float) -> bool:
        deadline = asyncio.get_event_loop().time() + timeout_sec
        while asyncio.get_event_loop().time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(f"llama-server が終了しました (exit {self.proc.returncode})")
            if await llm.health(base_url):
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
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    check=False,
                )
            except OSError:
                pass
            # taskkill が失敗してもプロセスを残さない(VRAM を掴んだ孤児を防ぐ)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    async def stop_async(self) -> None:
        """async ハンドラ用。taskkill の完走待ちでイベントループを塞がない。"""
        await asyncio.to_thread(self.stop)
