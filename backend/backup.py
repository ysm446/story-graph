"""外部バックアップ(zip 書き出し)— ライブラリをフォルダの外へ丸ごと持ち出す。

設計: docs/design/backup.md

スナップショット(snapshots.py)が「操作ミスからの復帰」をライブラリの中で担うのに対し、
こちらは **フォルダ消失・ディスク障害・PC 乗り換え** に備える。中身は
story-graph.db(VACUUM INTO の整合コピー)+ assets/ で、復元は
「新しいライブラリとして展開して開く」。

イベントループを塞がないよう、SQLite に触る prepare_db()(ループ上)と
ファイルを読み書きする write_zip()(to_thread)に分けてある。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from store import Store

FORMAT = 1
DB_NAME = "story-graph.db"
MANIFEST_NAME = "backup.json"
DEFAULT_KEEP = 5
INTERVAL_HOURS = 24
AUTO_MARK = "-auto-"  # 自動バックアップだけに入る印(ローテーションの対象を絞る)
INSIDE_DIR = "backups"  # 「ライブラリの中に置く」ときの場所(<root>/backups/)

# 既に圧縮済みの形式は無圧縮格納にする(deflate しても縮まず、書き出しだけ遅くなる)
STORED_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp",
    ".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".zip",
}


# ---- 設定 ------------------------------------------------------------

def _documents_dir() -> Path:
    home = Path.home()
    docs = home / "Documents"
    return docs if docs.is_dir() else home


def safe_name(name: str) -> str:
    """ファイル名に使える形にする(Windows で禁止された文字を潰す)。"""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (name or "").strip())
    return cleaned.rstrip(". ") or "library"


def library_name(root: str | None) -> str:
    return safe_name(Path(root).name) if root else "story-graph"


def default_dir(root: str | None) -> str:
    """外に置くときの既定の保存先(ドキュメント配下)。"""
    return str(_documents_dir() / "story-graph-backups" / library_name(root))


def inside_dir(root: str | None) -> str:
    """ライブラリの中に置くときの保存先(<root>/backups/)。

    zip に入れるのは story-graph.db と assets/(+任意で snapshots/)だけなので、
    ここに置いても次の zip が前の zip を飲み込む再帰は起きない。
    """
    return str(Path(root) / INSIDE_DIR) if root else default_dir(root)


def get_config(store: Store) -> dict[str, Any]:
    settings = store.get_settings()
    try:
        keep = int(settings.get("backup_keep") or DEFAULT_KEEP)
    except ValueError:
        keep = DEFAULT_KEEP
    # 既定はライブラリの中。外に置くのは作者が明示的に選んだときだけ
    inside = (settings.get("backup_inside") or "1") == "1"
    # 外に置くときのパスは inside でも保持しておく(戻したときに選び直さなくてよい)
    outside = (settings.get("backup_dir") or "").strip() or default_dir(store.root)
    return {
        # 既定は無効。作者が保存先を確かめてから始める
        "enabled": settings.get("backup_auto") == "1",
        "inside": inside,
        "dir": inside_dir(store.root) if inside else outside,
        "outside_dir": outside,
        "keep": max(1, min(keep, 99)),
        "last_at": settings.get("backup_last_at") or None,
        "last_path": settings.get("backup_last_path") or None,
        "library_name": library_name(store.root),
    }


def set_config(
    store: Store,
    *,
    enabled: bool | None = None,
    dir: str | None = None,
    keep: int | None = None,
    inside: bool | None = None,
) -> dict[str, Any]:
    values: dict[str, str] = {}
    if enabled is not None:
        values["backup_auto"] = "1" if enabled else "0"
    if dir is not None:
        values["backup_dir"] = dir.strip()
        if inside is None:
            inside = False  # フォルダを選んだ = 外に置く、という意思表示
    if inside is not None:
        values["backup_inside"] = "1" if inside else "0"
    if keep is not None:
        values["backup_keep"] = str(max(1, min(int(keep), 99)))
    if values:
        store.set_settings(values)
    return get_config(store)


# ---- 書き出し --------------------------------------------------------

def stamp(now: datetime | None = None) -> str:
    return (now or datetime.now()).strftime("%Y%m%d-%H%M%S")


def suggested_name(store: Store, auto: bool = False) -> str:
    mark = AUTO_MARK if auto else "-"
    return f"{library_name(store.root)}{mark}{stamp()}.zip"


def prepare_db(store: Store) -> Path:
    """VACUUM INTO で DB の整合コピーを一時フォルダに作る(イベントループ上で呼ぶ)。

    返すのはコピー先のパス。呼び出し側は使い終わったら cleanup() すること。
    """
    if not store.root:
        raise RuntimeError("ライブラリが未設定のためバックアップできません")
    tmp_dir = Path(tempfile.mkdtemp(prefix="story-graph-backup-"))
    dest = tmp_dir / DB_NAME
    store.conn.commit()  # VACUUM は進行中のトランザクションがあると失敗する
    store.conn.execute("VACUUM INTO ?", (str(dest),))
    return dest


def cleanup(db_copy: Path | str) -> None:
    shutil.rmtree(Path(db_copy).parent, ignore_errors=True)


def _compress_type(path: Path) -> int:
    return (
        zipfile.ZIP_STORED
        if path.suffix.lower() in STORED_SUFFIXES
        else zipfile.ZIP_DEFLATED
    )


def _collect(root: Path, sub: str) -> list[tuple[Path, str]]:
    """<root>/<sub> 以下のファイルを (実パス, zip 内の相対パス) で集める。"""
    base = root / sub
    if not base.is_dir():
        return []
    items: list[tuple[Path, str]] = []
    for path in sorted(base.rglob("*")):
        if path.is_file():
            items.append((path, path.relative_to(root).as_posix()))
    return items


def write_zip(
    db_copy: Path | str,
    root: str,
    dest: str,
    *,
    include_snapshots: bool = False,
    kind: str = "manual",
) -> dict[str, Any]:
    """zip を書く(SQLite には触らないのでスレッドで実行できる)。

    途中で失敗した zip を残さないよう <dest>.part に書いてから置き換える。
    """
    db_copy = Path(db_copy)
    root_path = Path(root)
    dest_path = Path(dest)
    if dest_path.suffix.lower() != ".zip":
        # with_suffix は "my.story backup" の "." 以降を落とすので単純に足す
        dest_path = dest_path.with_name(dest_path.name + ".zip")
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    assets = _collect(root_path, "assets")
    snaps = _collect(root_path, "snapshots") if include_snapshots else []
    manifest = {
        "format": FORMAT,
        "kind": kind,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "library_name": library_name(root),
        "db_size": db_copy.stat().st_size,
        "assets": len(assets),
        "includes_snapshots": bool(snaps),
    }

    part = dest_path.with_name(dest_path.name + ".part")
    try:
        with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
            zf.write(db_copy, DB_NAME)
            for path, arcname in assets + snaps:
                try:
                    zf.write(path, arcname, compress_type=_compress_type(path))
                except OSError:
                    continue  # 書き出し中に消えたファイルは飛ばす
        os.replace(part, dest_path)
    except BaseException:
        Path(part).unlink(missing_ok=True)
        raise
    return {**manifest, "path": str(dest_path), "size": dest_path.stat().st_size}


def export_zip(
    store: Store, dest: str, *, include_snapshots: bool = False, kind: str = "manual"
) -> dict[str, Any]:
    """同期版(テストと CLI 用)。API は prepare_db + to_thread(write_zip) を使う。"""
    db_copy = prepare_db(store)
    try:
        return write_zip(
            db_copy, str(store.root), dest, include_snapshots=include_snapshots, kind=kind
        )
    finally:
        cleanup(db_copy)


# ---- 自動バックアップ ------------------------------------------------

def _has_content(store: Store) -> bool:
    """シーンが 1 つも無いライブラリは撮らない(空フォルダを開いただけで増えない)。"""
    try:
        row = store.conn.execute("SELECT COUNT(*) FROM nodes WHERE kind IS NULL").fetchone()
    except Exception:  # noqa: BLE001  スキーマ未初期化などは「中身なし」扱い
        return False
    return bool(row and row[0])


def plan_auto(store: Store, force: bool = False) -> dict[str, Any] | None:
    """自動バックアップを実行すべきなら計画を返す。要らなければ None。"""
    if not store.root:
        return None
    config = get_config(store)
    if not force:
        if not config["enabled"] or not _has_content(store):
            return None
        last = config["last_at"]
        if last:
            try:
                when = datetime.fromisoformat(last)
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) - when < timedelta(hours=INTERVAL_HOURS):
                    return None
            except ValueError:
                pass  # 壊れた値は「取ったことがない」扱い
    name = config["library_name"]
    filename = f"{name}{AUTO_MARK}{stamp()}.zip"
    return {
        "dir": config["dir"],
        "dest": str(Path(config["dir"]) / filename),
        "keep": config["keep"],
        "name": name,
    }


def rotate(directory: str, name: str, keep: int) -> list[str]:
    """自動バックアップを新しい順に keep 個だけ残す。消したファイル名を返す。

    手動書き出しを巻き込まないよう <name>-auto-*.zip だけを見る。
    """
    base = Path(directory)
    if not base.is_dir():
        return []
    files = sorted(
        (f for f in base.glob(f"{name}{AUTO_MARK}*.zip") if f.is_file()),
        key=lambda f: f.name,
        reverse=True,
    )
    removed: list[str] = []
    for f in files[max(1, keep):]:
        try:
            f.unlink()
            removed.append(f.name)
        except OSError:
            continue
    return removed


def record_auto(store: Store, plan: dict[str, Any], result: dict[str, Any]) -> list[str]:
    """実行時刻を settings に記録し、古い自動バックアップを整理する。"""
    store.set_settings(
        {
            "backup_last_at": datetime.now(timezone.utc).isoformat(),
            "backup_last_path": result["path"],
        }
    )
    # 名前は plan のものを使う(実行中にライブラリが切り替わっても対象を取り違えない)
    return rotate(plan["dir"], plan.get("name") or library_name(store.root), plan["keep"])


def list_backups(directory: str, limit: int = 20) -> list[dict[str, Any]]:
    """保存先にある zip の一覧(新しい順)。"""
    base = Path(directory)
    if not base.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for f in base.glob("*.zip"):
        try:
            st = f.stat()
        except OSError:
            continue
        items.append(
            {
                "name": f.name,
                "path": str(f),
                "size": st.st_size,
                "modified_at": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "kind": "auto" if AUTO_MARK in f.name else "manual",
            }
        )
    items.sort(key=lambda e: e["modified_at"], reverse=True)
    return items[:limit]


# ---- 復元 ------------------------------------------------------------

def _safe_members(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    """zip slip 対策。絶対パス・.. を含むエントリは捨てる。"""
    members: list[zipfile.ZipInfo] = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or ".." in name.split("/") or (len(name) > 1 and name[1] == ":"):
            continue
        members.append(info)
    return members


def inspect(zip_path: str) -> dict[str, Any]:
    """zip の中身を確認する(復元前の表示用)。"""
    path = Path(zip_path)
    if not path.is_file():
        raise KeyError(f"backup not found: {zip_path}")
    with zipfile.ZipFile(path) as zf:
        names = {i.filename.replace("\\", "/") for i in _safe_members(zf)}
        manifest: dict[str, Any] = {}
        if MANIFEST_NAME in names:
            try:
                manifest = json.loads(zf.read(MANIFEST_NAME).decode("utf-8"))
            except (ValueError, KeyError, UnicodeDecodeError):
                manifest = {}
        assets = sum(1 for n in names if n.startswith("assets/"))
        snaps = sum(1 for n in names if n.startswith("snapshots/"))
    return {
        "path": str(path),
        "size": path.stat().st_size,
        "has_db": DB_NAME in names,
        "assets": assets,
        "snapshots": snaps,
        "created_at": manifest.get("created_at"),
        "library_name": manifest.get("library_name"),
        "kind": manifest.get("kind"),
        "format": manifest.get("format"),
    }


def restore(zip_path: str, dest_root: str) -> dict[str, Any]:
    """新しいライブラリとして展開する(既存のライブラリは上書きしない)。"""
    info = inspect(zip_path)
    if not info["has_db"]:
        raise ValueError(f"{DB_NAME} が入っていません(story-graph のバックアップではありません)")
    dest = Path(dest_root)
    if (dest / DB_NAME).exists():
        raise FileExistsError("展開先に既にライブラリがあります。空のフォルダを選んでください")
    dest.mkdir(parents=True, exist_ok=True)
    extracted = 0
    with zipfile.ZipFile(zip_path) as zf:
        for member in _safe_members(zf):
            name = member.filename.replace("\\", "/")
            if name == MANIFEST_NAME:
                continue  # zip 自体のメタデータなのでライブラリには持ち込まない
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            extracted += 1
    return {"root": str(dest), "extracted": extracted}
