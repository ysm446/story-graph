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
