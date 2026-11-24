"""TTS エンジン(サーバー)の自動インストール(comfy_installer と同じ置き場の作法)。

設計: docs/design/voice.md §3。

- 置き場は既定で runtime/tts/<engine>/ 。設定 tts_server_dir_<engine> で別の場所を指せる
  (モデルの tts_models_dir と同じ考え方。ほかのアプリと共用する実行環境を指すため)。
  エンジン定義(tts_engines/<id>.json)の install.git を clone し、install.setup のコマンド
  (uv sync など)をその場で順に実行する
- **設定で指した外の置き場は、アプリからは消さない**(共用のフォルダを黙って消さないため)。
  アンインストールは断り、インストールは空のフォルダ(または無いフォルダ)にだけ入れる。
  外すときは設定を空に戻す(フォルダは残る)
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
from pathlib import Path
from typing import Any, AsyncIterator

from installer_common import dir_size, remove_by_rename
from tts import REPO_ROOT, fill

RUNTIME_DIR = REPO_ROOT / "runtime"
TTS_DIR = RUNTIME_DIR / "tts"
MARKER_NAME = ".story-graph-install.json"

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


SERVER_DIR_PREFIX = "tts_server_dir_"  # + エンジン ID。app_settings でアプリ単位(PC ごと)の設定にしてある


def server_dir_key(engine_id: str) -> str:
    return f"{SERVER_DIR_PREFIX}{engine_id}"


def default_install_dir(engine_id: str) -> Path:
    return TTS_DIR / engine_id


def install_dir(engine_id: str, settings: dict[str, str] | None = None) -> Path:
    """サーバー本体の置き場。設定 tts_server_dir_<engine> があればそこ、無ければ runtime/tts/<engine>/。"""
    configured = ((settings or {}).get(server_dir_key(engine_id)) or "").strip()
    return Path(configured) if configured else default_install_dir(engine_id)


def is_external(engine_id: str, settings: dict[str, str] | None = None) -> bool:
    """設定で既定以外の場所を指しているか(= アプリが中身を消してはいけない置き場)。"""
    def norm(path: Path) -> str:
        return os.path.normcase(os.path.abspath(path))

    return norm(install_dir(engine_id, settings)) != norm(default_install_dir(engine_id))


def _is_link(path: Path) -> bool:
    return path.is_symlink() or path.is_junction()


def _has_entries(path: Path) -> bool:
    try:
        return any(path.iterdir())
    except OSError:
        return path.exists()


def _read_marker(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads((path / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


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
        _size_cache[key] = dir_size(path)
    return _size_cache[key]


def status(engine_id: str, settings: dict[str, str] | None = None) -> dict[str, Any]:
    path = install_dir(engine_id, settings)
    marker = _read_marker(path) if path.is_dir() else None
    external = is_external(engine_id, settings)
    return {
        "installed": marker is not None,
        # フォルダはあるが目印が無い = 途中で失敗した(やり直しが要る)
        "incomplete": path.is_dir() and marker is None,
        "install": marker,
        "install_dir": str(path),
        "default_install_dir": str(default_install_dir(engine_id)),
        # 設定で外の場所を指している(アプリからは消さない。外すには設定を空に戻す)
        "install_external": external,
        # 外の置き場に中身がある = そこへは入れ直せない(消さないので clone できない)
        "install_blocked": external and _has_entries(path),
        "runtime_dir": str(RUNTIME_DIR),
        "size_bytes": _install_size(path, marker) if marker is not None else 0,
    }


EXTERNAL_KEEP_MESSAGE = (
    "設定で指定した置き場はアプリからは消しません(ほかのアプリと共用している場合があるため)。"
    "外すには置き場を「既定に戻す」にしてください(フォルダは残ります)。"
)


def uninstall(engine_id: str, settings: dict[str, str] | None = None) -> None:
    if is_external(engine_id, settings):
        raise RuntimeError(EXTERNAL_KEEP_MESSAGE)
    path = install_dir(engine_id, settings)
    if _is_link(path):
        # 既定の場所がリンク(Junction など)なら、リンクだけ外す。指している先の実体には触らない
        if os.name == "nt":
            os.rmdir(path)
        else:
            path.unlink()
        return
    if not path.exists():
        return
    # runtime/ 直下へ退避してから消す(残っても llama_installer.cleanup_leftovers が回収する)
    remove_by_rename(path, "削除できませんでした(TTS サーバーが起動中の可能性があります)", RUNTIME_DIR)


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

async def install(engine: dict[str, Any], settings: dict[str, str] | None = None) -> AsyncIterator[dict[str, Any]]:
    """置き場(既定は runtime/tts/<id>/)に clone してセットアップする。起動中のサーバーがあると
    フォルダを置き換えられないので、呼び出し側で先に停止しておく。
    設定で指した外の置き場は消さないので、中身があるときは入れずに断る。"""
    spec = engine.get("install") or {}
    repo = spec.get("git")
    if not repo:
        raise RuntimeError(f"{engine['id']} の定義に install.git がありません")
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git が見つかりません。Git for Windows をインストールしてから再試行してください。")

    dest = install_dir(engine["id"], settings)
    started = time.time()

    if is_external(engine["id"], settings):
        if _has_entries(dest):
            raise RuntimeError(
                f"{dest} には中身があるので、ここへはインストールしません"
                "(設定で指定した置き場は、ほかのアプリと共用している場合があるためアプリからは消しません)。"
                "入れ直すときは、空のフォルダを置き場に選ぶか、このフォルダを手で空にしてください。"
            )
        dest.parent.mkdir(parents=True, exist_ok=True)
    else:
        TTS_DIR.mkdir(parents=True, exist_ok=True)
        if dest.exists() or _is_link(dest):
            yield {"phase": "step", "label": "以前のインストールを削除しています"}
            await asyncio.to_thread(uninstall, engine["id"], settings)

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
