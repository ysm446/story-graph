import os
import time
from pathlib import Path

import db
from store import Store


def test_switch_library_opens_new_db(tmp_path):
    store = Store(db.connect(":memory:"))
    store.create_character({"name": "アヤ"})
    assert len(store.list_characters()) == 1

    lib_a = tmp_path / "story-a"
    lib_a.mkdir()
    store.switch_library(str(lib_a))
    assert store.root == str(lib_a)
    assert store.list_characters() == []  # 新しい空の DB
    assert (lib_a / "story-graph.db").exists()

    store.create_character({"name": "ケン"})

    lib_b = tmp_path / "story-b"
    lib_b.mkdir()
    store.switch_library(str(lib_b))
    assert store.list_characters() == []

    # 戻ればデータが残っている(ストーリーごとに独立)
    store.switch_library(str(lib_a))
    assert [c["name"] for c in store.list_characters()] == ["ケン"]


def test_gc_assets_removes_orphans(tmp_path):
    lib = tmp_path / "story"
    lib.mkdir()
    store = Store(db.connect(":memory:"), root=str(lib))
    assets = Path(store.assets_dir())

    (assets / "kept.png").write_bytes(b"x")
    (assets / "orphan.png").write_bytes(b"x")
    (assets / "fresh.png").write_bytes(b"x")
    # 猶予期間(1時間)を超えた古いファイルにする
    old = time.time() - 7200
    os.utime(assets / "kept.png", (old, old))
    os.utime(assets / "orphan.png", (old, old))

    char = store.create_character({"name": "アヤ"})
    store.update_character(char["id"], {"portrait_path": "kept.png"})

    assert store.gc_assets() == 1
    assert (assets / "kept.png").exists()  # 参照中は残る
    assert not (assets / "orphan.png").exists()  # 未参照の古いファイルは削除
    assert (assets / "fresh.png").exists()  # 直近1時間以内は未参照でも保護
