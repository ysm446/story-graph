import pytest

import db
from store import Store


@pytest.fixture
def store():
    return Store(db.connect(":memory:"))


def test_builtin_presets_are_flagged(store):
    presets = store.list_presets()
    assert {p["id"] for p in presets if p["builtin"]} == {"default-third", "default-first"}


def test_builtin_presets_cannot_be_edited_or_deleted(store):
    store.list_presets()  # seed
    with pytest.raises(PermissionError):
        store.upsert_preset({"id": "default-third", "name": "改変", "tone": "x"})
    with pytest.raises(PermissionError):
        store.delete_preset("default-first")
    assert len(store.list_presets()) == 2


def test_custom_presets_can_be_edited_and_deleted(store):
    created = store.upsert_preset({"name": "ハードボイルド", "person": "third", "tone": "乾いた文体。"})
    assert created["builtin"] is False
    updated = store.upsert_preset({"id": created["id"], "name": "ハードボイルド改", "person": "third", "tone": "更に乾いた文体。"})
    assert updated["name"] == "ハードボイルド改"
    store.delete_preset(created["id"])
    assert all(p["id"] != created["id"] for p in store.list_presets())
