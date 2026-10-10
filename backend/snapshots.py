"""スナップショット(チェックポイント)— ライブラリ全体の保存と復元。

undo の代わりに「時点に戻す」を提供する(設計: docs/design/snapshots.md)。
データ全体が 1 つの SQLite ファイルなので、VACUUM INTO で丸ごと複製し、
復元はファイル差し替え + 再接続で行う。

- <root>/snapshots/<id>.db + index.json(メタデータ)
- kind: auto(危険な操作の前の自動保存)| manual(ユーザーの手動保存)
- auto は直近 MAX_AUTO 件まで。manual は無期限(UI から削除)
"""

from __future__ import annotations

import asyncio
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


def _reserve_path(root: str) -> tuple[str, Path]:
    """保存先のファイル名(id とパス)を決める。"""
    sdir = _snapshot_dir(root)
    sdir.mkdir(parents=True, exist_ok=True)
    base = datetime.now().strftime("%Y%m%d-%H%M%S")
    snap_id = base
    n = 1
    while _snapshot_path(root, snap_id).exists():
        n += 1
        snap_id = f"{base}-{n}"
    path = _snapshot_path(root, snap_id)
    # 空ファイルを先に置いて ID を確保する(create_async はスレッドで VACUUM するため、
    # 同じ秒に 2 件走ると同じ ID を選んでしまう)。VACUUM INTO は空の既存ファイルを受け付ける
    path.touch()
    return snap_id, path


def _register(root: str, snap_id: str, label: str, kind: str, path: Path) -> dict[str, Any]:
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


def create(store: Store, label: str, kind: str = "manual") -> dict[str, Any]:
    """現在の DB を snapshots/ に複製し、index に登録して返す(同期版)。

    restore の「復元の前」とテストが使う。API ハンドラからは、イベントループを
    塞がない create_async / auto を使うこと。
    """
    root = store.root
    if not root:
        raise RuntimeError("ライブラリが未設定のためスナップショットを保存できません")
    snap_id, path = _reserve_path(root)
    # VACUUM は進行中のトランザクションがあると失敗するので先に確定する
    store.conn.commit()
    try:
        store.conn.execute("VACUUM INTO ?", (str(path),))
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return _register(root, snap_id, label, kind, path)


def _vacuum_ro(db_path: Path, dest: Path) -> None:
    """読み取り専用の別接続で VACUUM INTO する(ワーカースレッド用)。

    書き込みは store.conn でループ上に直列、という前提を崩さないための読み取り接続。
    WAL なのでループ側の読み書きと並行しても、コピーは開始時点の一貫した姿になる。
    vec0(sqlite-vec)の仮想テーブルは VACUUM がスキーマを作り直すときに
    モジュールが要るので、この接続にもロードする。
    """
    conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    try:
        db_mod._try_load_vec(conn)
        conn.execute("VACUUM INTO ?", (str(dest),))
    finally:
        conn.close()


async def create_async(store: Store, label: str, kind: str = "manual") -> dict[str, Any]:
    """create の非同期版。DB 丸ごとのコピー(数十 MB で 100〜500ms)をスレッドに
    逃がし、コピー中も他の API(ステータスポーリングや SSE)を止めない。
    呼び出し元のハンドラ自身は await で完了を待つので、「操作の前の保存」という
    意味は同期版と変わらない。"""
    root = store.root
    if not root:
        raise RuntimeError("ライブラリが未設定のためスナップショットを保存できません")
    snap_id, path = _reserve_path(root)
    store.conn.commit()  # コミット済みの姿をコピーする(commit はループ上で)
    try:
        await asyncio.to_thread(_vacuum_ro, Path(root) / "story-graph.db", path)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return _register(root, snap_id, label, kind, path)


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


async def auto(store: Store, label: str, min_interval_sec: float = 60.0) -> None:
    """危険な操作の前の自動保存。失敗しても操作は止めない。

    同じ契機(label)の連打で埋まらないよう最短間隔を持つ。複数シーンの
    一括削除のような「API 連打」の実装では、最初の 1 回だけ保存される。
    コピーはスレッドで行う(create_async)。await が返るまで操作は始まらないので、
    「操作の前の保存」であることは変わらない。
    """
    # 制作開始時の保存を使う。手動編集への切替中も余分な自動保存は作らない。
    import production_agent
    if production_agent.gate.active:
        return
    root = store.root
    if not root:
        return
    key = (root, label)
    now = time.monotonic()
    if min_interval_sec > 0 and now - _last_auto.get(key, float("-inf")) < min_interval_sec:
        return
    try:
        await create_async(store, label, kind="auto")
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
    _snapshot_path(root, snap_id).unlink(missing_ok=True)
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
    db_path = Path(root) / "story-graph.db"
    tmp = db_path.with_name(db_path.name + ".restoring")
    # 「復元の前」の自動保存が _prune を走らせ、復元対象(最古の auto)自身を
    # 消すことがある。先に複製を確保してから自動保存する
    shutil.copyfile(src, tmp)
    try:
        create(store, "復元の前", kind="auto")
        store.conn.commit()
        store.conn.close()
        try:
            # クローズで WAL はチェックポイント済みのはずだが、残骸があれば消す
            for suffix in ("-wal", "-shm"):
                Path(str(db_path) + suffix).unlink(missing_ok=True)
            os.replace(tmp, db_path)
        finally:
            store.conn = db_mod.connect(db_path)
    finally:
        tmp.unlink(missing_ok=True)  # os.replace 済みなら存在しない


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
