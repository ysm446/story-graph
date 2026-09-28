"""TTS エンジン(サーバー)の自動インストール(comfy_installer と同じ置き場の作法)。

設計: docs/design/voice.md §3。

- 置き場は runtime/tts/<engine>/ 。エンジン定義(tts_engines/<id>.json)の install.git を
  clone し、install.setup のコマンド(uv sync など)をその場で順に実行する
- **clone 先で直接セットアップする**(staging で作ってから rename しない)。uv sync は
  プロジェクト自身を editable で入れ、.pth に絶対パスを書くので、作った後に動かすと壊れるため
- セットアップが最後まで通ったら目印(MARKER_NAME)を書く。目印が無いフォルダは
  「途中で失敗した残り」として、次のインストールで消してからやり直す
- 依存はエンジンごとに自分の .venv(uv が作る)に入る。アプリの .venv には入れない
- uv が PATH に無ければ、アプリの .venv に pip で入れてから使う
- 進捗は dict(phase 別)で yield し、app.py が SSE で配信する
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

from tts import REPO_ROOT, fill

RUNTIME_DIR = REPO_ROOT / "runtime"
TTS_DIR = RUNTIME_DIR / "tts"
MARKER_NAME = ".story-graph-install.json"

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


def install_dir(engine_id: str) -> Path:
    return TTS_DIR / engine_id


def _read_marker(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads((path / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                total += p.stat().st_size
        except OSError:
            continue
    return total


# フォルダ容量の覚え。PyTorch 込みの .venv は数万ファイルあり、数えるのに数秒かかる。
# 右上のバーが数秒ごとに status を呼ぶので、インストール 1 回(目印の更新時刻)につき 1 回だけ数える
_size_cache: dict[tuple[str, str], int] = {}


def _install_size(path: Path, marker: dict[str, Any]) -> int:
    try:
        stamp = str((path / MARKER_NAME).stat().st_mtime_ns)
    except OSError:
        stamp = str(marker.get("installed_at"))
    key = (str(path), stamp)
    if key not in _size_cache:
        _size_cache[key] = _dir_size(path)
    return _size_cache[key]


def status(engine_id: str) -> dict[str, Any]:
    path = install_dir(engine_id)
    marker = _read_marker(path) if path.is_dir() else None
    return {
        "installed": marker is not None,
        # フォルダはあるが目印が無い = 途中で失敗した(やり直しが要る)
        "incomplete": path.is_dir() and marker is None,
        "install": marker,
        "install_dir": str(path),
        "runtime_dir": str(RUNTIME_DIR),
        "size_bytes": _install_size(path, marker) if marker is not None else 0,
    }


def uninstall(engine_id: str) -> None:
    path = install_dir(engine_id)
    if not path.exists():
        return
    # runtime/ 直下へ退避してから消す(残っても llama_installer.cleanup_leftovers が回収する)
    trash = RUNTIME_DIR / f".removing-{uuid.uuid4().hex}"
    try:
        path.rename(trash)
    except OSError as e:
        raise RuntimeError(f"削除できませんでした(TTS サーバーが起動中の可能性があります): {e}")
    shutil.rmtree(trash, ignore_errors=True)


# ---- uv -----------------------------------------------------------------

def find_uv() -> str | None:
    """PATH の uv → アプリの .venv に入れた uv の順に探す。"""
    found = shutil.which("uv")
    if found:
        return found
    scripts = Path(sys.executable).parent
    for name in ("uv.exe", "uv"):
        cand = scripts / name
        if cand.exists():
            return str(cand)
    return None


# ---- 外部コマンドを 1 行ずつ流す -------------------------------------------

async def run_streaming(
    cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None
) -> AsyncIterator[str]:
    """コマンドを実行し、出力(stdout + stderr)を 1 行ずつ yield する。非 0 終了は RuntimeError。

    Windows の uvicorn はイベントループが subprocess を扱えないことがあるので、
    プロセスはスレッドで読み、行を asyncio.Queue に渡す。途中で中止(CancelledError)されたら
    プロセスツリーごと止める。
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=_NO_WINDOW,
    )

    def pump() -> None:
        assert proc.stdout is not None
        for raw in iter(proc.stdout.readline, b""):
            text = raw.decode("utf-8", errors="replace").rstrip()
            if text:
                loop.call_soon_threadsafe(queue.put_nowait, text)
        proc.wait()
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=pump, daemon=True).start()
    tail: list[str] = []
    try:
        while True:
            line = await queue.get()
            if line is None:
                break
            tail = (tail + [line])[-15:]
            yield line
    except BaseException:
        _kill_tree(proc)
        raise
    if proc.returncode != 0:
        detail = "\n".join(tail[-6:])
        raise RuntimeError(f"{Path(cmd[0]).name} が失敗しました(exit {proc.returncode}):\n{detail}")


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)
    except OSError:
        proc.kill()


# ---- インストール --------------------------------------------------------

async def install(engine: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """runtime/tts/<id>/ に clone してセットアップする。起動中のサーバーがあると
    フォルダを置き換えられないので、呼び出し側で先に停止しておく。"""
    spec = engine.get("install") or {}
    repo = spec.get("git")
    if not repo:
        raise RuntimeError(f"{engine['id']} の定義に install.git がありません")
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git が見つかりません。Git for Windows をインストールしてから再試行してください。")

    dest = install_dir(engine["id"])
    TTS_DIR.mkdir(parents=True, exist_ok=True)
    started = time.time()

    if dest.exists():
        yield {"phase": "step", "label": "以前のインストールを削除しています"}
        await asyncio.to_thread(uninstall, engine["id"])

    uv = find_uv()
    if uv is None:
        yield {"phase": "step", "label": "uv をインストールしています(アプリの .venv に pip で入れます)"}
        async for line in run_streaming([sys.executable, "-m", "pip", "install", "uv"]):
            yield {"phase": "log", "line": line}
        uv = find_uv()
        if uv is None:
            raise RuntimeError("uv をインストールしましたが見つかりません")

    yield {"phase": "step", "label": f"{repo} を取得しています"}
    cmd = [git, "clone", "--depth", "1"]
    if spec.get("ref"):
        cmd += ["--branch", spec["ref"]]
    async for line in run_streaming(cmd + [repo, str(dest)]):
        yield {"phase": "log", "line": line}

    values = {"uv": uv, "install_dir": str(dest)}
    # uv は既定だと PC にある任意の Python(ほかのアプリが同梱しているものまで)を拾う。
    # その Python を消されると TTS の環境ごと壊れるので、uv 自身が取得・管理する Python に限る
    env = {**os.environ, "PYTHONUTF8": "1", "UV_PYTHON_PREFERENCE": "only-managed"}
    for step in spec.get("setup") or []:
        filled = fill(step, values) or []
        yield {"phase": "step", "label": " ".join([Path(filled[0]).stem, *filled[1:]]) + "(数分かかります)"}
        async for line in run_streaming([str(a) for a in filled], cwd=dest, env=env):
            yield {"phase": "log", "line": line}

    marker = {
        "engine": engine["id"],
        "repo": repo,
        "ref": spec.get("ref"),
        "commit": await asyncio.to_thread(_git_head, git, dest),
        "installed_at": time.strftime("%Y-%m-%d %H:%M"),
    }
    (dest / MARKER_NAME).write_text(json.dumps(marker, ensure_ascii=False), encoding="utf-8")
    yield {"phase": "done", "path": str(dest), "seconds": round(time.time() - started)}


def _git_head(git: str, path: Path) -> str | None:
    try:
        res = subprocess.run(
            [git, "rev-parse", "--short", "HEAD"], cwd=str(path), capture_output=True, text=True, creationflags=_NO_WINDOW
        )
        return res.stdout.strip() or None
    except OSError:
        return None
