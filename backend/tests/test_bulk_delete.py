"""選択シーン・章の一括削除と、途中失敗時の原状保持。"""
import asyncio

import httpx
import pytest

import db
import embed
import node_operations
from store import Store


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    for name in ["a", "b", "c", "d"]:
        s.append_node({"id": name, "title": name, "beat": name})
    yield s
    s.conn.close()


def test_selected_chain_and_branch_keep_successors(store):
    store.append_node({"id": "branch", "beat": "枝"})
    store.attach_node("b", "branch", replace_parent=True)
    result = node_operations.delete_many(store, ["b", "c", "b"], [])
    assert result["node_ids"] == ["b", "c"]
    assert store.parent_of("d") == "a"
    assert store.parent_of("branch") == "a"
    assert store.get_node("branch")["beat"] == "枝"


def test_chapters_include_disconnected_members_and_deduplicate(store):
    store.detach_node("c")
    group = store.create_group("章", ["b", "c"])
    empty = store.create_group("空の章", [])
    result = node_operations.delete_many(store, ["b"], [group["id"], empty["id"]])
    assert set(result["node_ids"]) == {"b", "c"}
    assert store.list_groups() == []
    assert store.get_node("a") and store.get_node("d")
    assert not any(n.get("group_id") for n in store.graph()["nodes"])
    assert not any(n["kind"] in ("chapter_in", "chapter_out") for n in store.graph()["nodes"])


def test_failure_after_chapter_removal_rolls_back_everything(store, monkeypatch):
    group = store.create_group("章", ["b", "c"])
    before = store.graph()
    original = Store.delete_node

    def fail_on_c(self, node_id):
        if node_id == "c":
            raise ValueError("削除失敗")
        return original(self, node_id)

    monkeypatch.setattr(Store, "delete_node", fail_on_c)
    with pytest.raises(ValueError, match="削除失敗"):
        node_operations.delete_many(store, ["b", "c"], [group["id"]])
    assert store.graph() == before
    assert store.get_group(group["id"]) is not None


@pytest.mark.parametrize("invalid", ["missing", "marker", "group"])
def test_invalid_target_keeps_all_scenes(store, invalid):
    before = store.graph()
    marker = next(n["id"] for n in before["nodes"] if n["kind"] == "start")
    nodes = ["a", marker if invalid == "marker" else "missing"] if invalid != "group" else ["a"]
    with pytest.raises((KeyError, ValueError)):
        node_operations.delete_many(store, nodes, ["missing"] if invalid == "group" else [])
    assert store.graph() == before


def test_api_selection_delete_and_missing_target(store, monkeypatch):
    import app as api

    async def snapshot(*args):
        pass

    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api.snapshots, "auto", snapshot)
    monkeypatch.setattr(api, "_schedule_audio_gc", lambda: None)

    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            response = await client.post("/nodes/delete-selection", json={"node_ids": ["b", "c"]})
            assert response.status_code == 200
            assert response.json()["node_ids"] == ["b", "c"]
            response = await client.post("/nodes/delete-selection", json={"node_ids": ["a", "missing"]})
            assert response.status_code == 404
            assert store.get_node("a") is not None

    asyncio.run(check())
