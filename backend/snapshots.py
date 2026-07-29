"""スナップショット(チェックポイント)— ライブラリ全体の保存と復元。

undo の代わりに「時点に戻す」を提供する(設計: docs/design/snapshots.md)。
データ全体が 1 つの SQLite ファイルなので、VACUUM INTO で丸ごと複製し、
復元はファイル差し替え + 再接続で行う。

- <root>/snapshots/<id>.db + index.json(メタデータ)
- kind: auto(危険な操作の前の自動保存)| manual(ユーザーの手動保存)
- auto は直近 MAX_AUTO 件まで。manual は無期限(UI から削除)
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

import db as db_mod

if TYPE_CHECKING:  # store は gc_assets からこちらを呼ぶので、実行時 import は循環する
    from store import Store

MAX_AUTO = 30

# 契機ごとの最終実行時刻(スロットル用。プロセス内でよい)
_last_auto: dict[tuple[str, str], float] = {}


def _snapshot_dir(root: str) -> Path:
    return Path(root) / "snapshots"


def _index_path(root: str) -> Path:
    return _snapshot_dir(root) / "index.json"


def _load_index(root: str) -> list[dict[str, Any]]:
    try:
        raw = json.loads(_index_path(root).read_text(encoding="utf-8"))
        return [e for e in raw if isinstance(e, dict) and e.get("id")]
    except (OSError, ValueError):
        return []


def _save_index(root: str, entries: list[dict[str, Any]]) -> None:
    _snapshot_dir(root).mkdir(parents=True, exist_ok=True)
    _index_path(root).write_text(
        json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _snapshot_path(root: str, snap_id: str) -> Path:
    return _snapshot_dir(root) / f"{snap_id}.db"


def list_snapshots(store: Store) -> list[dict[str, Any]]:
    """新しい順の一覧。ファイルが消えているエントリは除く(index も掃除する)。"""
    root = store.root
    if not root:
        return []
    entries = _load_index(root)
    alive = []
    for e in entries:
        path = _snapshot_path(root, e["id"])
        if not path.exists():
            continue
        alive.append({**e, "size": path.stat().st_size})
    if len(alive) != len(entries):
        _save_index(root, [{k: v for k, v in e.items() if k != "size"} for e in alive])
    return sorted(alive, key=lambda e: e["created_at"], reverse=True)


def create(store: Store, label: str, kind: str = "manual") -> dict[str, Any]:
    """現在の DB を snapshots/ に複製し、index に登録して返す。"""
    root = store.root
    if not root:
        raise RuntimeError("ライブラリが未設定のためスナップショットを保存できません")
    sdir = _snapshot_dir(root)
    sdir.mkdir(parents=True, exist_ok=True)
    base = datetime.now().strftime("%Y%m%d-%H%M%S")
    snap_id = base
    n = 1
    while _snapshot_path(root, snap_id).exists():
        n += 1
        snap_id = f"{base}-{n}"
    path = _snapshot_path(root, snap_id)
    # VACUUM は進行中のトランザクションがあると失敗するので先に確定する
    store.conn.commit()
    store.conn.execute("VACUUM INTO ?", (str(path),))
    entry = {
        "id": snap_id,
        "label": (label or "").strip() or "(名前なし)",
        "kind": kind if kind in ("auto", "manual") else "manual",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    entries = _load_index(root)
    entries.append(entry)
    entries = _prune(root, entries)
    _save_index(root, entries)
    return {**entry, "size": path.stat().st_size}


def _prune(root: str, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """auto を新しい順に MAX_AUTO 件まで残す(manual は触らない)。"""
    autos = [e for e in entries if e.get("kind") == "auto"]
    if len(autos) <= MAX_AUTO:
        return entries
    autos.sort(key=lambda e: e["created_at"], reverse=True)
    drop_ids = {e["id"] for e in autos[MAX_AUTO:]}
    for snap_id in drop_ids:
        try:
            _snapshot_path(root, snap_id).unlink(missing_ok=True)
        except OSError:
            pass
    return [e for e in entries if e["id"] not in drop_ids]


def auto(store: Store, label: str, min_interval_sec: float = 60.0) -> None:
    """危険な操作の前の自動保存。失敗しても操作は止めない。

    同じ契機(label)の連打で埋まらないよう最短間隔を持つ。複数シーンの
    一括削除のような「API 連打」の実装では、最初の 1 回だけ保存される。
    """
    root = store.root
    if not root:
        return
    key = (root, label)
    now = time.monotonic()
    if min_interval_sec > 0 and now - _last_auto.get(key, float("-inf")) < min_interval_sec:
        return
    try:
        create(store, label, kind="auto")
        _last_auto[key] = now
    except Exception as e:  # noqa: BLE001
        print(f"[snapshots] 自動スナップショットに失敗: {e}")


def delete(store: Store, snap_id: str) -> bool:
    root = store.root
    if not root:
        return False
    entries = _load_index(root)
    if not any(e["id"] == snap_id for e in entries):
        return False
    try:
        _snapshot_path(root, snap_id).unlink(missing_ok=True)
    except OSError:
        pass
    _save_index(root, [e for e in entries if e["id"] != snap_id])
    return True


def restore(store: Store, snap_id: str) -> None:
    """スナップショットの時点に戻す。

    復元自体を取り消せるよう、先に「復元の前」を自動保存する。
    DB ファイルを差し替えるため一度接続を閉じる。コピーに失敗しても
    finally で必ず再接続する(差し替え前なら現状のまま動き続ける)。
    """
    root = store.root
    if not root:
        raise RuntimeError("ライブラリが未設定のため復元できません")
    src = _snapshot_path(root, snap_id)
    if not src.exists():
        raise KeyError(f"snapshot not found: {snap_id}")
    create(store, "復元の前", kind="auto")
    db_path = Path(root) / "story-graph.db"
    store.conn.commit()
    store.conn.close()
    try:
        # クローズで WAL はチェックポイント済みのはずだが、残骸があれば消す
        for suffix in ("-wal", "-shm"):
            Path(str(db_path) + suffix).unlink(missing_ok=True)
        tmp = db_path.with_name(db_path.name + ".restoring")
        shutil.copyfile(src, tmp)
        os.replace(tmp, db_path)
    finally:
        store.conn = db_mod.connect(db_path)


def collect_asset_references(root: str, sqls: tuple[str, ...]) -> set[str]:
    """スナップショット DB が参照する画像ファイル名を集める(gc_assets 用)。

    古いスナップショットに戻したとき挿絵が消えないよう、参照中のファイルは
    回収対象から守る。読めないスナップショットは黙って飛ばす。
    """
    referenced: set[str] = set()
    sdir = _snapshot_dir(root)
    if not sdir.exists():
        return referenced
    for f in sdir.glob("*.db"):
        try:
            conn = sqlite3.connect(f"file:{f.as_posix()}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            try:
                for sql in sqls:
                    try:
                        for row in conn.execute(sql).fetchall():
                            if row[0]:
                                referenced.add(Path(row[0]).name)
                    except sqlite3.Error:
                        continue  # 古いスキーマで列が無い等
            finally:
                conn.close()
        except sqlite3.Error:
            continue
    return referenced
