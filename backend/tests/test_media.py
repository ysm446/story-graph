"""挿絵・参照画像のストック(media。docs/design/image-gen.md §7)。"""

import sqlite3

import db
import pytest
from store import Store


def _store() -> Store:
    return Store(db.connect(":memory:"))


def test_add_and_select_node_media_copies_generation_set():
    store = _store()
    n = store.append_node({"beat": "b", "cast": []})
    m = store.add_media(
        "node", n["id"], "a.png", prompt="p1", instructions="i1", seed=5, ref_chars=["x"], workflow="zeniji"
    )
    assert store.get_node(n["id"])["image_path"] is None  # 足しただけでは選ばれない
    store.select_media(m["id"])
    got = store.get_node(n["id"])
    assert got["image_path"] == "a.png"
    assert got["image_prompt"] == "p1" and got["image_instructions"] == "i1" and got["image_seed"] == 5
    assert got["image_ref_chars"] == ["x"] and got["image_workflow"] == "zeniji"


def test_select_uploaded_media_keeps_generation_state():
    store = _store()
    n = store.append_node({"beat": "b", "cast": []})
    store.set_node_image_gen(n["id"], prompt="p", instructions="i", seed=1, ref_chars=None)
    m = store.add_media("node", n["id"], "drop.png")  # 手持ちの画像: セットは空
    store.select_media(m["id"])
    got = store.get_node(n["id"])
    assert got["image_path"] == "drop.png"
    assert got["image_prompt"] == "p" and got["image_seed"] == 1  # 保存状態は触らない


def test_select_character_media():
    store = _store()
    c = store.create_character({"name": "A"})
    m = store.add_media("character", c["id"], "ref.png", prompt="desc", instructions=None, seed=9, workflow="zeniji")
    store.select_media(m["id"])
    got = store.get_character(c["id"])
    assert got["ref_image_path"] == "ref.png" and got["ref_image_prompt"] == "desc" and got["ref_image_seed"] == 9
    assert got["ref_image_workflow"] == "zeniji"


def test_selected_media_cannot_be_deleted():
    store = _store()
    n = store.append_node({"beat": "b", "cast": []})
    a = store.add_media("node", n["id"], "a.png")
    b = store.add_media("node", n["id"], "b.png")
    store.select_media(a["id"])
    with pytest.raises(ValueError):
        store.delete_media(a["id"])
    assert store.delete_media(b["id"]) is True
    assert [m["id"] for m in store.list_media("node", n["id"])] == [a["id"]]
    # 画像を外せば消せる
    store.set_node_image(n["id"], None)
    assert store.delete_media(a["id"]) is True
    assert store.delete_media("nope") is False


def test_delete_unselected_keeps_current():
    store = _store()
    n = store.append_node({"beat": "b", "cast": []})
    a = store.add_media("node", n["id"], "a.png")
    store.add_media("node", n["id"], "b.png")
    store.add_media("node", n["id"], "c.png")
    store.select_media(a["id"])
    assert store.delete_unselected_media("node", n["id"]) == 2
    assert [m["path"] for m in store.list_media("node", n["id"])] == ["a.png"]
    # 何も選んでいなければ全部消える
    store.set_node_image(n["id"], None)
    assert store.delete_unselected_media("node", n["id"]) == 1


def test_video_thumb_is_mirrored_to_media_and_restored_on_reselect():
    store = _store()
    n = store.append_node({"beat": "b", "cast": []})
    v = store.add_media("node", n["id"], "v.mp4")
    other = store.add_media("node", n["id"], "o.png")
    store.select_media(v["id"])
    store.set_node_thumb(n["id"], "t.jpg")
    assert store.get_media(v["id"])["thumb_path"] == "t.jpg"
    store.select_media(other["id"])
    assert store.get_node(n["id"])["thumb_path"] is None
    store.select_media(v["id"])
    assert store.get_node(n["id"])["thumb_path"] == "t.jpg"


def test_owner_delete_removes_media():
    store = _store()
    n = store.append_node({"beat": "b", "cast": []})
    n2 = store.append_node({"beat": "b2", "cast": []}, parent_id=n["id"])
    store.add_media("node", n2["id"], "a.png")
    store.delete_node(n2["id"])
    assert store.list_media("node", n2["id"]) == []
    c = store.create_character({"name": "A"})
    store.add_media("character", c["id"], "r.png")
    store.delete_character(c["id"])
    assert store.list_media("character", c["id"]) == []


def test_media_paths_are_protected_from_gc(tmp_path):
    from pathlib import Path

    conn = db.connect(str(tmp_path / "story-graph.db"))
    store = Store(conn, root=str(tmp_path))
    assets = Path(store.assets_dir())
    n = store.append_node({"beat": "b", "cast": []})
    old = 0  # 猶予時間より前に作られたことにする
    for name in ("kept.png", "orphan.png"):
        (assets / name).write_bytes(b"x")
        import os

        os.utime(assets / name, (old, old))
    store.add_media("node", n["id"], "kept.png")  # ストックにあるだけ(未選択)でも守られる
    assert store.gc_assets() == 1
    assert (assets / "kept.png").exists() and not (assets / "orphan.png").exists()


def test_migration_registers_existing_images_as_media(tmp_path):
    """ストック導入前の DB(user_version 2)を開くと、設定済みの画像が最初の候補になる。"""
    path = tmp_path / "old.db"
    conn = db.connect(str(path))  # 最新スキーマで作ってから media だけ無かったことにする
    conn.execute("DROP INDEX IF EXISTS idx_media_owner")
    conn.execute("DROP TABLE media")
    conn.execute("PRAGMA user_version = 2")
    conn.execute(
        "INSERT INTO nodes(id, title, beat, cast, status, created_at, updated_at, image_path, image_prompt, image_seed)"
        " VALUES('n1', 't', 'b', '[]', 'draft', 'x', 'x', 'img.png', 'p', 3)"
    )
    conn.execute(
        "INSERT INTO characters(id, name, created_at, ref_image_path, ref_image_prompt)"
        " VALUES('c1', 'A', 'x', 'ref.png', 'd')"
    )
    conn.commit()
    conn.close()
    store = Store(db.connect(str(path)))
    node_media = store.list_media("node", "n1")
    assert len(node_media) == 1 and node_media[0]["path"] == "img.png" and node_media[0]["seed"] == 3
    char_media = store.list_media("character", "c1")
    assert len(char_media) == 1 and char_media[0]["path"] == "ref.png" and char_media[0]["prompt"] == "d"
    # 二度開いても増えない
    store2 = Store(db.connect(str(path)))
    assert len(store2.list_media("node", "n1")) == 1
