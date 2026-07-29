"""スナップショット(チェックポイント)— 保存・復元・世代管理(docs/design/snapshots.md)。"""

import pytest

import db
import snapshots
from store import Store


@pytest.fixture(autouse=True)
def _clear_throttle():
    snapshots._last_auto.clear()
    yield
    snapshots._last_auto.clear()


@pytest.fixture
def store(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    return Store(db.connect(root / "story-graph.db"), root=str(root))


def test_create_list_delete(store, tmp_path):
    assert snapshots.list_snapshots(store) == []
    snap = snapshots.create(store, "手動テスト")
    assert snap["label"] == "手動テスト"
    assert snap["kind"] == "manual"
    assert (tmp_path / "lib" / "snapshots" / f"{snap['id']}.db").exists()
    entries = snapshots.list_snapshots(store)
    assert [e["id"] for e in entries] == [snap["id"]]
    assert entries[0]["size"] > 0
    assert snapshots.delete(store, snap["id"]) is True
    assert snapshots.list_snapshots(store) == []
    assert snapshots.delete(store, "nonexistent") is False


def test_restore_roundtrip(store):
    store.create_character({"name": "アヤ", "id": "aya"})
    snap = snapshots.create(store, "アヤだけ")
    store.create_character({"name": "ケン", "id": "ken"})
    assert store.known_char_ids() == {"aya", "ken"}

    snapshots.restore(store, snap["id"])
    assert store.known_char_ids() == {"aya"}
    # 復元後も接続は使える(書き込みできる)
    store.create_character({"name": "ミオ", "id": "mio"})
    assert store.known_char_ids() == {"aya", "mio"}

    # 復元の直前の状態は「復元の前」として自動保存されている
    pre = [e for e in snapshots.list_snapshots(store) if e["label"] == "復元の前"]
    assert len(pre) == 1
    snapshots.restore(store, pre[0]["id"])
    assert store.known_char_ids() == {"aya", "ken"}


def test_restore_missing_raises(store):
    with pytest.raises(KeyError):
        snapshots.restore(store, "nonexistent")


def test_auto_throttle(store):
    snapshots.auto(store, "削除の前", 60)
    snapshots.auto(store, "削除の前", 60)  # 間隔内なのでスキップ
    assert len(snapshots.list_snapshots(store)) == 1
    # 別ラベルは独立にスロットルされる
    snapshots.auto(store, "正史切替の前", 0)
    snapshots.auto(store, "正史切替の前", 0)  # 間隔なし = 毎回
    assert len(snapshots.list_snapshots(store)) == 3


def test_auto_without_root_is_noop():
    store = Store(db.connect(":memory:"))
    snapshots.auto(store, "x", 0)  # 例外にならず何もしない
    with pytest.raises(RuntimeError):
        snapshots.create(store, "x")


def test_prune_keeps_manual(store, monkeypatch):
    monkeypatch.setattr(snapshots, "MAX_AUTO", 3)
    manual = snapshots.create(store, "手動", kind="manual")
    for i in range(5):
        snapshots.create(store, f"自動{i}", kind="auto")
    entries = snapshots.list_snapshots(store)
    autos = [e for e in entries if e["kind"] == "auto"]
    assert len(autos) == 3
    assert [e["label"] for e in autos] == ["自動4", "自動3", "自動2"]  # 新しい順に残る
    assert any(e["id"] == manual["id"] for e in entries)  # manual は残る


def test_gc_assets_protects_snapshot_references(store, tmp_path):
    """スナップショットだけが参照する画像は GC で消えない。"""
    import os
    import time

    assets = store.assets_dir()
    old = 2 * 60 * 60  # grace(1時間)を超えた古さにする
    for name in ("kept.png", "orphan.png"):
        path = tmp_path / "lib" / "assets" / "images" / name
        path.write_bytes(b"png")
        os.utime(path, (time.time() - old, time.time() - old))
    assert assets is not None
    # kept.png を参照した状態でスナップショット → 参照を外す
    store.create_place({"name": "港", "id": "port"})
    store.update_place("port", {"image_path": "kept.png"})
    snapshots.create(store, "参照あり")
    store.update_place("port", {"image_path": None})
    removed = store.gc_assets()
    assert removed == 1  # orphan.png だけが消える
    assert (tmp_path / "lib" / "assets" / "images" / "kept.png").exists()
    assert not (tmp_path / "lib" / "assets" / "images" / "orphan.png").exists()
