"""ComfyUI(Windows portable 版)の自動ダウンロード/インストール(llama_installer と同じ作法)。

- リリースは GitHub `Comfy-Org/ComfyUI/releases` から取得し、`ComfyUI_windows_portable_*.7z`
  をバリアント(nvidia / nvidia_cu126 / amd / intel)として抽出する
- 7z は Windows 同梱の bsdtar(System32\tar.exe、libarchive)で展開する。py7zr は
  portable 版が使う BCJ2 フィルタに非対応なので使えない(2GB 級なので数分かかる。スレッドに逃がす)
- 展開先は runtime/comfyui/ の 1 箇所だけ(llama と違って複数ビルドを並べない。
  portable 版は python 同梱で 5GB 級あるため)
- モデルはコピーせず、ComfyUI 標準の extra_model_paths.yaml でモデルフォルダを指す
  (docs/plan/progress.md「場面の画像生成」)
- 進捗は dict(phase 別)で yield し、app.py が SSE で配信する
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

import httpx

from llama_installer import _download, _http_client, _tmp_zip

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = REPO_ROOT / "runtime"
INSTALL_DIR = RUNTIME_DIR / "comfyui"
# インストール時に控える情報(タグ・バリアント)。version の表示に使う
MARKER_NAME = ".story-graph-install.json"

RELEASES_API = "https://api.github.com/repos/Comfy-Org/ComfyUI/releases"

# 例: ComfyUI_windows_portable_nvidia.7z / ComfyUI_windows_portable_nvidia_cu126.7z
ASSET_RE = re.compile(r"^ComfyUI_windows_portable_([a-z0-9_]+)\.7z$", re.IGNORECASE)

# extra_model_paths.yaml に列挙するフォルダ(ComfyUI の models/ 直下の標準名)。
# 存在しないサブフォルダがあっても ComfyUI は無視するだけなので全部書く
MODEL_FOLDERS = [
    "checkpoints",
    "diffusion_models",
    "unet",
    "loras",
    "vae",
    "clip",
    "text_encoders",
    "clip_vision",
    "controlnet",
    "embeddings",
    "upscale_models",
    "style_models",
    "photomaker",
    "model_patches",
    "vae_approx",
    "hypernetworks",
    "gligen",
    "configs",
    "diffusers",
    "audio_encoders",
]


def _variant_label(backend: str) -> str:
    b = backend.lower()
    if b == "nvidia":
        return "NVIDIA(最新 CUDA)"
    if b.startswith("nvidia_"):
        return f"NVIDIA({b.split('_', 1)[1]})"
    if b == "amd":
        return "AMD"
    if b == "intel":
        return "Intel"
    return backend


_RANK = {"nvidia": 0, "amd": 2, "intel": 3}


def _build_release(raw: dict[str, Any]) -> dict[str, Any] | None:
    tag = raw.get("tag_name") or raw.get("name") or ""
    variants: list[dict[str, Any]] = []
    for a in raw.get("assets") or []:
        m = ASSET_RE.match(a.get("name", ""))
        if not m:
            continue
        backend = m.group(1)
        variants.append(
            {
                "key": f"{tag}:{backend}",
                "backend": backend,
                "label": _variant_label(backend),
                "asset_name": a["name"],
                "asset_url": a["browser_download_url"],
                "size_bytes": a.get("size", 0),
            }
        )
    if not variants:
        return None
    variants.sort(key=lambda v: (_RANK.get(v["backend"].split("_")[0], 9), v["backend"]))
    return {
        "tag": tag,
        "name": raw.get("name") or tag,
        "published_at": raw.get("published_at"),
        "html_url": raw.get("html_url"),
        "variants": variants,
    }


async def fetch_releases(limit: int = 5) -> list[dict[str, Any]]:
    headers = {"User-Agent": "story-graph", "Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        res = await client.get(RELEASES_API, params={"per_page": max(1, min(limit, 20))}, headers=headers)
        if res.status_code == 403:
            raise RuntimeError("GitHub API のレート制限に達した可能性があります。しばらく待って再試行してください。")
        if res.status_code != 200:
            raise RuntimeError(f"リリース取得に失敗しました (HTTP {res.status_code})")
        data = res.json()
    releases = []
    for raw in data:
        if raw.get("draft"):
            continue
        rel = _build_release(raw)
        if rel is not None:
            releases.append(rel)
    return releases


# ---- インストール済みの検出 -----------------------------------------

def _portable_root(install_dir: Path) -> Path | None:
    """7z の中身は `ComfyUI_windows_portable/` 1 階層の下に python_embeded と ComfyUI が並ぶ。
    直下に置かれている場合(手動配置)も許す。"""
    if not install_dir.is_dir():
        return None
    candidates = [install_dir] + [p for p in install_dir.iterdir() if p.is_dir()]
    for cand in candidates:
        if (cand / "ComfyUI" / "main.py").exists() and (cand / "python_embeded" / "python.exe").exists():
            return cand
    return None


def _read_marker(root: Path) -> dict[str, Any]:
    try:
        return json.loads((root / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _comfy_version(root: Path) -> str | None:
    """ComfyUI/comfyui_version.py の `__version__ = "0.3.x"` を読む(無ければ marker のタグ)。"""
    try:
        text = (root / "ComfyUI" / "comfyui_version.py").read_text(encoding="utf-8")
        m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)['\"]", text)
        if m:
            return m.group(1)
    except OSError:
        pass
    return _read_marker(root).get("tag")


def find_install() -> dict[str, Any] | None:
    if not INSTALL_DIR.is_dir():
        return None
    root = _portable_root(INSTALL_DIR)
    if root is None:
        return None
    return {
        "dir": str(INSTALL_DIR),
        "root": str(root),
        "python": str(root / "python_embeded" / "python.exe"),
        "main": str(root / "ComfyUI" / "main.py"),
        "version": _comfy_version(root),
        "backend": _read_marker(root).get("backend"),
    }


def _dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


def status() -> dict[str, Any]:
    ins = find_install()
    return {
        "installed": ins is not None,
        "install": ins,
        "install_dir": str(INSTALL_DIR),
        "runtime_dir": str(RUNTIME_DIR),
        "size_bytes": _dir_size(INSTALL_DIR) if ins else 0,
    }


def uninstall() -> None:
    if not INSTALL_DIR.exists():
        return
    trash = INSTALL_DIR.with_name(f".removing-{uuid.uuid4().hex}")
    try:
        INSTALL_DIR.rename(trash)
    except OSError as e:
        raise RuntimeError(f"削除できませんでした(ComfyUI が起動中の可能性があります): {e}")
    shutil.rmtree(trash, ignore_errors=True)


# ---- extra_model_paths.yaml ----------------------------------------

def extra_model_paths_text(models_dir: str) -> str:
    """モデルフォルダを指す yaml。`is_default: true` で保存先(生成画像は使わない)も
    このフォルダ側になる。パスは引用符で囲み、バックスラッシュはそのまま通す
    (YAML の単引用符は逐語)。"""
    safe = models_dir.replace("'", "''")
    lines = ["story_graph:", f"  base_path: '{safe}'", "  is_default: true"]
    lines += [f"  {name}: {name}" for name in MODEL_FOLDERS]
    return "\n".join(lines) + "\n"


def write_extra_model_paths(root: Path, models_dir: str | None) -> Path:
    """ComfyUI/extra_model_paths.yaml を書く(起動のたびに書き直す。設定変更を反映するため)。
    models_dir が空なら同梱の models/ だけを使うよう、ファイルを消す。"""
    target = root / "ComfyUI" / "extra_model_paths.yaml"
    if not models_dir:
        target.unlink(missing_ok=True)
        return target
    target.write_text(extra_model_paths_text(models_dir), encoding="utf-8")
    return target


# ---- ダウンロード + 展開 --------------------------------------------

def _bsdtar() -> Path | None:
    """Windows 10 1803+ 同梱の bsdtar(libarchive)。7z の BCJ2 フィルタを展開できる
    (py7zr は BCJ2 非対応で、portable 版の 7z がまさにそれを使っている)。"""
    import os

    cand = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "tar.exe"
    return cand if cand.exists() else None


def _extract_7z(archive: Path, dest_dir: Path) -> None:
    tar = _bsdtar()
    if tar is not None:
        import subprocess

        res = subprocess.run(
            [str(tar), "-xf", str(archive), "-C", str(dest_dir)],
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        if res.returncode == 0:
            return
        err = (res.stderr or "").strip()[-500:]
        raise RuntimeError(f"7z の展開に失敗しました(bsdtar exit {res.returncode}): {err}")
    raise RuntimeError("7z を展開する tar.exe(Windows 同梱の bsdtar)が見つかりません")


async def install_from_archive(archive: Path, marker: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """ダウンロード済みの 7z を staging に展開して runtime/comfyui/ に置く(install_variant の後半)。"""
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    staging = RUNTIME_DIR / f".installing-{uuid.uuid4().hex}"
    staging.mkdir(parents=True)
    try:
        yield {"phase": "extract", "file_label": "ComfyUI(数分かかります)"}
        await asyncio.to_thread(_extract_7z, archive, staging)
        root = _portable_root(staging)
        if root is None:
            raise RuntimeError("展開後に ComfyUI/main.py と python_embeded が見つかりませんでした")
        (root / MARKER_NAME).write_text(json.dumps(marker, ensure_ascii=False), encoding="utf-8")
        await asyncio.to_thread(_swap_into_place, staging, INSTALL_DIR)
        yield {"phase": "done", "build": _comfy_version(_portable_root(INSTALL_DIR) or INSTALL_DIR), "path": str(INSTALL_DIR)}
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


async def install_variant(variant: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """portable 版をダウンロード・展開して runtime/comfyui/ に置く。

    llama_installer.install_variant と同じく staging(.installing-*)で展開し、
    完了してから置き換える。起動中の ComfyUI があると rename に失敗するので、
    呼び出し側で先に停止しておく。
    """
    asset_name = variant.get("asset_name") or ""
    m = ASSET_RE.match(asset_name)
    if not m:
        raise ValueError(f"不正なファイル名です: {asset_name}")
    archive = _tmp_zip("comfyui").with_suffix(".7z")
    marker = {"tag": variant.get("key", "").split(":")[0], "backend": m.group(1), "asset_name": asset_name}
    try:
        async with _http_client() as client:
            async for p in _download(client, variant["asset_url"], archive, "ComfyUI"):
                yield p
        async for p in install_from_archive(archive, marker):
            yield p
    finally:
        try:
            archive.unlink(missing_ok=True)
        except OSError:
            pass


def _swap_into_place(staging: Path, dest_dir: Path) -> None:
    if dest_dir.exists():
        trash = dest_dir.with_name(f".removing-{uuid.uuid4().hex}")
        try:
            dest_dir.rename(trash)
        except OSError as e:
            raise RuntimeError(f"既存のインストール先を置き換えられませんでした(ComfyUI が起動中の可能性があります): {e}")
        shutil.rmtree(trash, ignore_errors=True)
    staging.rename(dest_dir)
