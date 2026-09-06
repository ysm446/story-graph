"""llama.cpp (llama-server) の自動ダウンロード/インストール(lm-graph の llamaInstaller.ts を Python 移植)。

lm-graph は Electron の main プロセス(Node)で完結していたが、story-graph は
Python バックエンドが llama を管理しているため、こちら側に移植する。
- リリースは GitHub `ggml-org/llama.cpp/releases` から取得
- Windows x64 の zip(llama-...-x64.zip)をバリアントとして抽出、CUDA 系には cudart を紐付け
  (cudart は本体と別扱い。同梱するかは呼び出し側が選べ、後から足すこともできる)
- ダウンロード → 一時 zip → runtime/<build>/ へ展開(zipfile。tar 依存なし)
- 進捗は dict(phase 別)で yield し、app.py が SSE で配信する
- 溜まったビルドは uninstall() で消せる(runtime/ 直下のものだけ。移植元の
  lm-graph などから流用しているバイナリは他プロジェクトの資産なので触らない)
"""

from __future__ import annotations

import asyncio
import functools
import os
import re
import shutil
import uuid
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
# cudart zip の中身。llama-server.exe と同居していれば CUDA Toolkit 無しでも動く
CUDART_DLL_RE = re.compile(r"^(cudart64|cublas64|cublasLt64)_(\d+)\.dll$", re.IGNORECASE)


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


def _cuda_major(text: str) -> str | None:
    """`cuda-13` `cuda13` などから CUDA のメジャーバージョンを取り出す。"""
    m = re.search(r"cuda-?(\d+)", text.lower())
    return m.group(1) if m else None


def _backend_label(backend: str, family: str) -> str:
    b = backend.lower()
    if family == "cuda":
        v = _cuda_major(b)
        return f"CUDA {v} (NVIDIA)" if v else "CUDA (NVIDIA)"
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
    v = _cuda_major(backend)
    if v:
        for c in cudarts:
            if v in c["version"]:
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
                # CUDA ランタイムを別途落とすか判断するため、メジャーバージョンを渡す
                "cuda_version": _cuda_major(backend) if family == "cuda" else None,
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


def is_removable(install_dir: str | Path) -> bool:
    """このアプリから削除してよいインストールか。

    自動インストール先である runtime/<asset名>/ だけを許す。レガシーの bin/ や
    設定で手入力した外部パスは他プロジェクトの資産なので、当アプリからは消さない。
    """
    try:
        return Path(install_dir).resolve().parent == RUNTIME_DIR.resolve()
    except OSError:
        return False


def has_cudart(install_dir: str | Path) -> bool:
    """インストール先に CUDA ランタイム DLL が同居しているか。

    展開が途中で失敗すると一部の DLL だけ残ることがあるため、システム検出と同じく
    cudart64 + cublas64 の両方が揃って初めて「ある」とみなす(揃っていなければ
    UI が再インストール(追加ダウンロード)の導線を出せる)。
    """
    kinds: set[str] = set()
    try:
        for p in Path(install_dir).iterdir():
            m = CUDART_DLL_RE.match(p.name)
            if m and p.is_file():
                kinds.add(m.group(1).lower())
    except OSError:
        return False
    return {"cudart64", "cublas64"} <= kinds


@functools.lru_cache(maxsize=1)
def system_cudart_versions() -> list[str]:
    """PATH / CUDA_PATH から見つかる CUDA ランタイムのメジャーバージョン一覧。

    llama-server.exe は DLL が同居していなくても、PATH 上に cudart64_XX.dll と
    cublas64_XX.dll があれば動く(CUDA Toolkit 導入済みの環境)。その場合は
    cudart zip(数百 MB)を落とさずに済むので、UI の既定を決めるのに使う。
    プロセス中に PATH は変わらない前提でキャッシュする。
    """
    dirs: list[Path] = []
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        dirs.append(Path(cuda_path) / "bin")
    dirs += [Path(p) for p in os.environ.get("PATH", "").split(os.pathsep) if p.strip()]

    found: dict[str, set[str]] = {}
    seen_dirs: set[str] = set()
    for d in dirs:
        key = str(d).lower()
        if key in seen_dirs:
            continue
        seen_dirs.add(key)
        try:
            entries = list(d.iterdir())
        except OSError:
            continue
        for p in entries:
            m = CUDART_DLL_RE.match(p.name)
            if m:
                found.setdefault(m.group(2), set()).add(m.group(1).lower())
    # cudart だけでは足りない(cublas も要る)ので、両方揃ったバージョンだけ返す
    return sorted(v for v, kinds in found.items() if {"cudart64", "cublas64"} <= kinds)


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
            # 削除中に落ちた残骸(.removing-*)は起動候補に混ぜない
            if not sub.is_dir() or sub.name.startswith("."):
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
        c["removable"] = is_removable(c["dir"])
        unique.append(c)
    return unique


def resolve_server_path() -> str | None:
    installs = find_server_installs()
    return installs[0]["path"] if installs else None


def _dir_size(path: Path) -> int:
    """フォルダ配下のファイルサイズ合計(消したときに空く量の表示用)。"""
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


def status() -> dict[str, Any]:
    """一覧 + 各インストールの占有サイズ。

    サイズは毎回数え直す(rglob)。1 インストールあたり数十ファイルなので安く、
    resolve_server_path()(生成のたびに走る)からは呼ばないので影響しない。
    """
    installs = find_server_installs()
    for c in installs:
        c["size_bytes"] = _dir_size(Path(c["dir"]))
        c["cuda_version"] = _cuda_major(Path(c["dir"]).name)
        c["is_cuda"] = c["cuda_version"] is not None
        # CUDA ビルドなのに DLL が無い場合は、システム側の CUDA ランタイム頼りになる
        c["has_cudart"] = has_cudart(c["dir"]) if c["is_cuda"] else False
    best = installs[0] if installs else None
    return {
        "installed": best is not None,
        "build": best["build"] if best else None,
        "path": best["path"] if best else None,
        "install_dir": best["dir"] if best else None,
        "runtime_dir": str(RUNTIME_DIR),
        "installs": installs,
        "total_size_bytes": sum(c["size_bytes"] for c in installs),
        "system_cudart": system_cudart_versions(),
    }


def uninstall(install_dir: str) -> dict[str, Any]:
    """インストール済みのビルドを 1 つ削除する。

    先に別名へ rename してから消す。使用中(exe をロック中)なら rename の時点で
    失敗するので、DLL だけ消えた壊れたフォルダを残さずに済む。
    """
    target = Path(install_dir)
    if not target.is_dir():
        raise ValueError(f"フォルダが見つかりません: {install_dir}")
    if not is_removable(target):
        raise ValueError(
            f"自動インストール先(runtime/)の外にあるため削除できません: {install_dir}"
        )
    if not (target / "llama-server.exe").exists():
        raise ValueError(f"llama-server.exe が無いフォルダは削除しません: {install_dir}")

    freed = _dir_size(target)
    trash = target.with_name(f".removing-{uuid.uuid4().hex}")
    try:
        target.rename(trash)
    except OSError as e:
        raise RuntimeError(
            f"削除できませんでした(このサーバを使用中の可能性があります): {install_dir} — {e}"
        )
    shutil.rmtree(trash, ignore_errors=True)
    if trash.exists():
        # AV やインデクサが掴んでいて消し切れなかったぶんは「空いた量」から引く
        # (残骸は次回起動時の cleanup_leftovers が回収する)
        freed -= _dir_size(trash)
    return {"removed_dir": str(target), "freed_bytes": max(freed, 0)}


def cleanup_leftovers() -> None:
    """削除・インストールの失敗で残った隠しフォルダ(.removing-* / .installing-*)を回収する。

    起動時に一度呼ぶ。掴まれていて消せないものは ignore_errors で次回へ持ち越す。
    """
    if not RUNTIME_DIR.is_dir():
        return
    for sub in RUNTIME_DIR.iterdir():
        if sub.is_dir() and (
            sub.name.startswith(".removing-") or sub.name.startswith(".installing-")
        ):
            shutil.rmtree(sub, ignore_errors=True)


# ---- ダウンロード + 展開 --------------------------------------------

async def _download(
    client: httpx.AsyncClient, url: str, dest: Path, label: str
) -> AsyncIterator[dict[str, Any]]:
    check_download_url(url)
    received = 0
    last_percent = -1
    last_emit = 0
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
                # 64KB ごとに全部流すと SSE が数万件になるので、% が動いたときだけ
                # (サイズ不明なら 4MB ごとに)送る
                if percent is not None:
                    if percent == last_percent:
                        continue
                    last_percent = percent
                else:
                    if received - last_emit < (1 << 22):
                        continue
                    last_emit = received
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


def dest_dir_for(asset_name: str) -> Path:
    """asset 名から展開先(runtime/<asset名>/)を決める。

    asset_name はフロント経由で届く外部入力なので、パス区切りや `..` を含む名前は
    拒否する(runtime/ の外への展開・削除を防ぐ)。正規の asset 名は
    `llama-b9496-bin-win-cuda-13-x64.zip` のような英数字とハイフンのみ。
    """
    name = re.sub(r"\.zip$", "", asset_name, flags=re.IGNORECASE)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) or ".." in name:
        raise ValueError(f"不正なファイル名です: {asset_name}")
    # llama.cpp のリリース資産の形に限定する。任意の名前を許すと runtime/comfyui など
    # 他のインストール先を _swap_into_place で消せてしまう
    if not LLAMA_ASSET_RE.match(asset_name):
        raise ValueError(f"llama.cpp のリリース資産ではありません: {asset_name}")
    return RUNTIME_DIR / name


# ダウンロード元として許すホスト。variant はフロント経由で届く外部入力なので、
# GitHub のリリース配信以外の URL から実行ファイルを落として runtime/ に置かない
ALLOWED_DOWNLOAD_HOSTS = frozenset(
    {"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}
)


def check_download_url(url: str) -> None:
    from urllib.parse import urlparse

    parsed = urlparse(url or "")
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_DOWNLOAD_HOSTS:
        raise ValueError(f"許可されていないダウンロード元です: {url}")


def _tmp_zip(suffix: str) -> Path:
    import tempfile

    return Path(tempfile.gettempdir()) / f"story-graph-{uuid.uuid4().hex}-{suffix}.zip"


def _http_client() -> httpx.AsyncClient:
    # 総時間は無制限(巨大 zip)だが、無通信ストールでは read タイムアウトで切る
    timeout = httpx.Timeout(30.0, read=120.0)
    return httpx.AsyncClient(timeout=timeout, headers={"User-Agent": USER_AGENT})


async def _fetch_and_extract(
    client: httpx.AsyncClient, url: str, tmp_zip: Path, label: str, dest_dir: Path
) -> AsyncIterator[dict[str, Any]]:
    async for p in _download(client, url, tmp_zip, label):
        yield p
    yield {"phase": "extract", "file_label": label}
    await asyncio.to_thread(_extract, tmp_zip, dest_dir)


def _swap_into_place(staging: Path, dest_dir: Path) -> None:
    """展開の済んだ staging を dest_dir へ置き換える。

    既存の dest_dir は先に rename で退かす。使用中(exe をロック中)なら rename の
    時点で失敗し、既存インストールは無傷のまま残る。
    """
    if dest_dir.exists():
        trash = dest_dir.with_name(f".removing-{uuid.uuid4().hex}")
        try:
            dest_dir.rename(trash)
        except OSError as e:
            raise RuntimeError(
                f"既存のインストール先を置き換えられませんでした"
                f"(このサーバを使用中の可能性があります): {dest_dir} — {e}"
            )
        shutil.rmtree(trash, ignore_errors=True)
    staging.rename(dest_dir)


async def install_variant(
    variant: dict[str, Any], include_cudart: bool = True
) -> AsyncIterator[dict[str, Any]]:
    """バリアントをダウンロード・展開して runtime/<assetName>/ に配置する。

    include_cudart=False なら CUDA ランタイム DLL は落とさない(CUDA Toolkit が
    入っていれば PATH 側の DLL で動くため、数百 MB を節約できる)。後から
    install_cudart() で足せる。

    展開は隠しフォルダ(.installing-*)で行い、完了してから dest_dir と置き換える。
    こうすると失敗・キャンセルで消すのは staging だけで、同じバリアントを
    入れ直すときに既存の(動いている)インストールを巻き込まない。
    find_server_installs はドットフォルダを見ないので、展開途中の exe が
    起動候補に混ざることもない。

    進捗 dict を yield する。キャンセルは呼び出し側(SSE)の切断で
    asyncio.CancelledError が飛ぶ想定。一時 zip は finally で必ず削除する。
    """
    asset_name = variant["asset_name"]
    dest_dir = dest_dir_for(asset_name)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    staging = RUNTIME_DIR / f".installing-{uuid.uuid4().hex}"
    staging.mkdir(parents=True)

    server_zip = _tmp_zip("server")
    cudart_zip = _tmp_zip("cudart")

    try:
        async with _http_client() as client:
            # サーバ本体
            async for p in _fetch_and_extract(
                client, variant["asset_url"], server_zip, "llama-server", staging
            ):
                yield p

            # CUDA ランタイムを同梱するときだけ、同じフォルダへ上書き展開する
            if include_cudart and variant.get("cudart_url"):
                async for p in _fetch_and_extract(
                    client, variant["cudart_url"], cudart_zip, "cudart", staging
                ):
                    yield p

        if not (staging / "llama-server.exe").exists():
            raise RuntimeError("展開後に llama-server.exe が見つかりませんでした")
        await asyncio.to_thread(_swap_into_place, staging, dest_dir)
        build = _extract_build(asset_name)
        yield {"phase": "done", "build": build, "path": str(dest_dir / "llama-server.exe")}
    except BaseException:
        # 失敗・キャンセルの後始末は staging のみ(置き換え済みなら何もしない)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        for z in (server_zip, cudart_zip):
            try:
                z.unlink(missing_ok=True)
            except OSError:
                pass


async def install_cudart(variant: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """既にある同ビルドのインストール先へ、CUDA ランタイム DLL だけ後から足す。

    本体は落とし直さない。失敗しても展開先は消さない(本体は無事なので、消すと
    動いていたサーバまで失う)。
    """
    if not variant.get("cudart_url"):
        raise RuntimeError("このバリアントに CUDA ランタイムはありません")

    dest_dir = dest_dir_for(variant["asset_name"])
    exe = dest_dir / "llama-server.exe"
    if not exe.exists():
        raise RuntimeError("先に llama.cpp 本体をインストールしてください")

    cudart_zip = _tmp_zip("cudart")
    try:
        async with _http_client() as client:
            async for p in _fetch_and_extract(
                client, variant["cudart_url"], cudart_zip, "cudart", dest_dir
            ):
                yield p
        yield {"phase": "done", "build": _extract_build(variant["asset_name"]), "path": str(exe)}
    finally:
        try:
            cudart_zip.unlink(missing_ok=True)
        except OSError:
            pass
