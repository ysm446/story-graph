"""llama.cpp (llama-server) の自動ダウンロード/インストール(lm-graph の llamaInstaller.ts を Python 移植)。

lm-graph は Electron の main プロセス(Node)で完結していたが、story-graph は
Python バックエンドが llama を管理しているため、こちら側に移植する。
- リリースは GitHub `ggml-org/llama.cpp/releases` から取得
- Windows x64 の zip(llama-...-x64.zip)をバリアントとして抽出、CUDA 系には cudart を紐付け
- ダウンロード → 一時 zip → runtime/<build>/ へ展開(zipfile。tar 依存なし)
- 進捗は dict(phase 別)で yield し、app.py が SSE で配信する
"""

from __future__ import annotations

import asyncio
import re
import zipfile
from pathlib import Path
from typing import Any, AsyncIterator

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = REPO_ROOT / "runtime"
# レガシー配置(lm-graph 由来のバイナリ流用)も検出対象にする
LEGACY_BIN_DIR = REPO_ROOT / "bin" / "llama-server"

RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
USER_AGENT = "story-graph"

# 例: llama-b9496-bin-win-cuda-13-x64.zip / cudart-llama-bin-win-cuda-13-x64.zip
LLAMA_ASSET_RE = re.compile(r"^llama-(b\d+)-bin-win-(.+)-x64\.zip$", re.IGNORECASE)
CUDART_ASSET_RE = re.compile(r"^cudart-llama-bin-win-cuda-(.+)-x64\.zip$", re.IGNORECASE)
BUILD_RE = re.compile(r"(b\d+)", re.IGNORECASE)


# ---- リリース取得 ----------------------------------------------------

def _backend_family(backend: str) -> str:
    b = backend.lower()
    if "cuda" in b:
        return "cuda"
    if "vulkan" in b:
        return "vulkan"
    if "hip" in b or "rocm" in b or "radeon" in b:
        return "hip"
    if "sycl" in b:
        return "sycl"
    if "cpu" in b or b in {"x64", "avx2", "avx512", "noavx"}:
        return "cpu"
    return "other"


# 既定選択の優先度(cuda を先頭にしたいので小さいほど優先)
_FAMILY_RANK = {"cuda": 0, "vulkan": 1, "hip": 2, "sycl": 3, "cpu": 4, "other": 5}


def _backend_label(backend: str, family: str) -> str:
    b = backend.lower()
    if family == "cuda":
        m = re.search(r"cuda-?(\d+)", b)
        return f"CUDA {m.group(1)} (NVIDIA)" if m else "CUDA (NVIDIA)"
    if family == "vulkan":
        return "Vulkan"
    if family == "sycl":
        return "SYCL (Intel)"
    if family == "hip":
        return "HIP / ROCm (AMD)"
    if family == "cpu":
        return f"CPU ({backend})"
    return backend


def _match_cudart(cudarts: list[dict[str, Any]], backend: str) -> dict[str, Any] | None:
    """CUDA バリアントに対応する cudart を選ぶ(バージョン一致優先、無ければ先頭)。"""
    if not cudarts:
        return None
    m = re.search(r"cuda-?(\d+)", backend.lower())
    if m:
        for c in cudarts:
            if m.group(1) in c["version"]:
                return c
    return cudarts[0]


def _build_release(raw: dict[str, Any]) -> dict[str, Any] | None:
    assets = raw.get("assets") or []
    cudarts: list[dict[str, Any]] = []
    for a in assets:
        cm = CUDART_ASSET_RE.match(a.get("name", ""))
        if cm:
            cudarts.append(
                {
                    "version": cm.group(1),
                    "name": a["name"],
                    "url": a["browser_download_url"],
                    "size": a.get("size", 0),
                }
            )

    tag = raw.get("tag_name") or raw.get("name") or ""
    variants: list[dict[str, Any]] = []
    for a in assets:
        lm = LLAMA_ASSET_RE.match(a.get("name", ""))
        if not lm:
            continue
        backend = lm.group(2)
        family = _backend_family(backend)
        cudart = _match_cudart(cudarts, backend) if family == "cuda" else None
        variants.append(
            {
                "key": f"{tag}:{backend}",
                "label": _backend_label(backend, family),
                "family": family,
                "asset_name": a["name"],
                "asset_url": a["browser_download_url"],
                "size_bytes": a.get("size", 0),
                "cudart_name": cudart["name"] if cudart else None,
                "cudart_url": cudart["url"] if cudart else None,
                "cudart_size_bytes": cudart["size"] if cudart else None,
            }
        )
    if not variants:
        return None
    variants.sort(key=lambda v: (_FAMILY_RANK.get(v["family"], 9), v["label"]))
    return {
        "tag": tag,
        "name": raw.get("name") or tag,
        "published_at": raw.get("published_at"),
        "html_url": raw.get("html_url", ""),
        "variants": variants,
    }


async def fetch_releases(limit: int = 8) -> list[dict[str, Any]]:
    per_page = max(1, min(limit, 30))
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.get(RELEASES_API, params={"per_page": per_page}, headers=headers)
        if res.status_code == 403:
            raise RuntimeError(
                "GitHub API のレート制限に達した可能性があります。しばらく待って再試行してください。"
            )
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


# ---- インストール済みサーバの検出 -----------------------------------

# 優先ビルド(lm-graph 由来の既定)。あれば最優先で採用する
PREFERRED_DIR_NAME = "b9496-win-cuda13-x64"


def _extract_build(dir_name: str) -> str | None:
    m = BUILD_RE.search(dir_name)
    return m.group(1) if m else None


def find_server_installs() -> list[dict[str, Any]]:
    """runtime/ とレガシー bin/ 配下の llama-server.exe を列挙する。"""
    candidates: list[dict[str, Any]] = []
    for root in (RUNTIME_DIR, LEGACY_BIN_DIR):
        if not root.exists():
            continue
        # root 直下と 1 階層下のサブフォルダを探索
        direct = root / "llama-server.exe"
        if direct.exists():
            candidates.append({"build": _extract_build(root.name), "dir": str(root), "path": str(direct)})
        for sub in root.iterdir():
            if not sub.is_dir():
                continue
            exe = sub / "llama-server.exe"
            if exe.exists():
                candidates.append({"build": _extract_build(sub.name), "dir": str(sub), "path": str(exe)})

    def score(c: dict[str, Any]) -> tuple:
        dir_name = Path(c["dir"]).name
        preferred = dir_name == PREFERRED_DIR_NAME
        build_num = int(c["build"][1:]) if c["build"] else 0
        try:
            mtime = Path(c["path"]).stat().st_mtime
        except OSError:
            mtime = 0.0
        # 優先ビルド → build 番号(新しいほど上) → mtime の順で降順
        return (preferred, build_num, mtime)

    candidates.sort(key=score, reverse=True)
    # 同一 path の重複を除去
    seen: set[str] = set()
    unique = []
    for c in candidates:
        if c["path"] in seen:
            continue
        seen.add(c["path"])
        unique.append(c)
    return unique


def resolve_server_path() -> str | None:
    installs = find_server_installs()
    return installs[0]["path"] if installs else None


def status() -> dict[str, Any]:
    installs = find_server_installs()
    best = installs[0] if installs else None
    return {
        "installed": best is not None,
        "build": best["build"] if best else None,
        "path": best["path"] if best else None,
        "install_dir": best["dir"] if best else None,
        "runtime_dir": str(RUNTIME_DIR),
        "installs": installs,
    }


# ---- ダウンロード + 展開 --------------------------------------------

async def _download(
    client: httpx.AsyncClient, url: str, dest: Path, label: str
) -> AsyncIterator[dict[str, Any]]:
    received = 0
    async with client.stream("GET", url, follow_redirects=True) as res:
        if res.status_code != 200:
            raise RuntimeError(f"{label} のダウンロードに失敗しました (HTTP {res.status_code})")
        total_header = res.headers.get("content-length")
        total = int(total_header) if total_header else None
        with dest.open("wb") as f:
            async for chunk in res.aiter_bytes(chunk_size=1 << 16):
                f.write(chunk)
                received += len(chunk)
                percent = round(received / total * 100) if total else None
                yield {
                    "phase": "download",
                    "file_label": label,
                    "received": received,
                    "total": total,
                    "percent": percent,
                }


def _extract(zip_path: Path, dest_dir: Path) -> None:
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest_dir)


async def install_variant(variant: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """バリアントをダウンロード・展開して runtime/<assetName>/ に配置する。

    進捗 dict を yield する。キャンセルは呼び出し側(SSE)の切断で
    asyncio.CancelledError が飛ぶ想定。一時 zip は finally で必ず削除する。
    """
    import tempfile
    import uuid

    asset_name = variant["asset_name"]
    dest_dir = RUNTIME_DIR / re.sub(r"\.zip$", "", asset_name, flags=re.IGNORECASE)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    dest_dir.mkdir(parents=True, exist_ok=True)

    tmp_dir = Path(tempfile.gettempdir())
    server_zip = tmp_dir / f"story-graph-{uuid.uuid4().hex}.zip"
    cudart_zip = tmp_dir / f"story-graph-{uuid.uuid4().hex}-cudart.zip"

    try:
        async with httpx.AsyncClient(timeout=None, headers={"User-Agent": USER_AGENT}) as client:
            # サーバ本体
            async for p in _download(client, variant["asset_url"], server_zip, "llama-server"):
                yield p
            yield {"phase": "extract", "file_label": "llama-server"}
            await asyncio.to_thread(_extract, server_zip, dest_dir)

            # CUDA なら cudart を同じフォルダへ上書き展開(DLL を exe と同居させる)
            if variant.get("cudart_url"):
                async for p in _download(client, variant["cudart_url"], cudart_zip, "cudart"):
                    yield p
                yield {"phase": "extract", "file_label": "cudart"}
                await asyncio.to_thread(_extract, cudart_zip, dest_dir)

        exe = dest_dir / "llama-server.exe"
        if not exe.exists():
            raise RuntimeError("展開後に llama-server.exe が見つかりませんでした")
        build = _extract_build(asset_name)
        yield {"phase": "done", "build": build, "path": str(exe)}
    finally:
        for z in (server_zip, cudart_zip):
            try:
                z.unlink(missing_ok=True)
            except OSError:
                pass
