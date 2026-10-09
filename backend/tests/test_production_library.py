"""制作の資料庫操作、参照保護、シーンへの利用、相談時の書込拒否。"""
import asyncio
import json

import pytest

import db
import embed
import generation
import llm
import production_agent as production
import production_library as library
import snapshots
from production_policy import ProductionPolicy
from store import Store


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    root = tmp_path / "library"
    root.mkdir()
    s = Store(db.connect(root / "story-graph.db"), root=str(root))
    s.create_character({"id": "aya", "name": "アヤ", "profile": "旅人", "appearance": "黒髪"})
    s.create_place({"id": "port", "name": "港", "description": "古い港"})
    s.append_node({"id": "first", "beat": "出発", "cast": ["aya"], "location": "port"})
    s.append_node({"id": "last", "beat": "到着", "cast": ["aya"]})
    yield s
    s.conn.close()


def edit(store, tool_name, **args):
    return asyncio.run(production.apply_edit(store, "fake", tool_name, {"reason": "作者の依頼", **args}))


def test_place_description_tool_alias_is_visible_and_saved(store):
    definitions = {tool["function"]["name"]: tool["function"] for tool in library.tools(True)}
    for name in ("create_place", "update_place"):
        fields = definitions[name]["parameters"]["properties"]
        assert "place_description" in fields
        assert not {"description", "type", "properties", "required", "nullable"}.intersection(fields)
    created = edit(store, "create_place", name="小屋", place_description="木造", atmosphere="静か")
    place_id = created["entity_id"]
    assert store.get_place(place_id)["description"] == "木造"
    updated = edit(store, "update_place", id=place_id, place_description="石造")
    assert updated["before"]["description"] == "木造"
    assert updated["after"]["description"] == "石造"
    assert library.read(store, {"kind": "place", "id": place_id})["item"]["description"] == "石造"
    assert store.get_place(place_id)["atmosphere"] == "静か"
    with pytest.raises(ValueError, match="二重"):
        edit(store, "update_place", id=place_id, description="木造", place_description="鉄骨")
    assert store.get_place(place_id)["description"] == "石造"


@pytest.mark.parametrize("kind,field", [("character", "profile"), ("place", "description")])
def test_create_read_update_delete_preserves_unspecified_fields(store, kind, field):
    created = edit(store, "create_" + kind, name="新規", reading="しんき", **{field: "設定"})
    entity_id = created["entity_id"]
    detail = library.read(store, {"kind": kind, "id": entity_id})
    assert detail["item"]["reading"] == "しんき"
    assert "portrait_path" not in detail["item"]
    updated = edit(store, "update_" + kind, id=entity_id, name="変更後")
    assert updated["before"]["name"] == "新規"
    assert updated["after"][field] == "設定"
    edit(store, "delete_" + kind, id=entity_id)
    assert getattr(store, "get_" + kind)(entity_id) is None


@pytest.mark.parametrize("kind,entity_id", [("character", "aya"), ("place", "port")])
def test_used_resource_cannot_be_deleted(store, kind, entity_id):
    before = store.graph()
    with pytest.raises(ValueError, match="使用中"):
        edit(store, "delete_" + kind, id=entity_id)
    assert store.graph() == before
    assert getattr(store, "get_" + kind)(entity_id)


@pytest.mark.parametrize("action,args", [
    ("create_character", {"name": "アヤ"}),
    ("create_place", {"name": "港"}),
    ("create_character", {"name": "  "}),
    ("update_character", {"id": "aya", "portrait_path": "unsafe"}),
    ("update_place", {"id": "port", "name": None}),
    ("create_place", {"name": "島", "color": "url(x)"}),
    ("update_character", {"id": "unknown", "profile": "不明"}),
])
def test_invalid_or_duplicate_changes_are_rejected(store, action, args):
    before = (store.list_characters(), store.list_places())
    with pytest.raises(ValueError):
        edit(store, action, **args)
    assert (store.list_characters(), store.list_places()) == before


@pytest.mark.parametrize("kind,entity_id,field", [("character", "aya", "profile"), ("place", "port", "description")])
@pytest.mark.parametrize("policy_args", [{"protected_ids": ["last"]}, {"allowed_ids": ["first"]}])
def test_referenced_protected_or_outside_scenes_block_global_edits(store, kind, entity_id, field, policy_args):
    policy = ProductionPolicy(store, **policy_args)
    with pytest.raises(ValueError, match="保護|範囲外"):
        asyncio.run(production.apply_edit(store, "fake", "update_" + kind,
            {"id": entity_id, field: "変更", "reason": "依頼"}, policy=policy))


def test_digest_and_event_only_references_block_deletion(store):
    store.create_character({"id": "ghost", "name": "記憶の人物"})
    group = store.create_group("章", ["first"])
    digest = [{"type": "memory_add", "payload": {"char": "ghost", "content": "思い出"}}]
    store.conn.execute("UPDATE groups SET digest_events = ? WHERE id = ?", (json.dumps(digest), group["id"]))
    store.conn.commit()
    with pytest.raises(ValueError, match="章のまとめ"):
        edit(store, "delete_character", id="ghost")
    store.create_place({"id": "bridge", "name": "橋"})
    store.replace_events("first", [{"type": "fact_set", "payload": {"scope": "place", "place": "bridge", "key": "状態", "value": "壊れた"}}])
    with pytest.raises(ValueError, match="first"):
        edit(store, "delete_place", id="bridge")


def test_new_records_can_be_used_in_scene_and_existing_settings_preserved(store, monkeypatch):
    async def extract(candidate, base_url, node_id):
        candidate.replace_events(node_id, [])
    monkeypatch.setattr(generation, "extract_events", extract)
    char = edit(store, "create_character", name="リオ")["entity_id"]
    place = edit(store, "create_place", name="広場")["entity_id"]
    result = edit(store, "insert_scene", after_id="first", title="出会い", beat="リオと出会う", cast=[char], location=place)
    node = store.get_node(result["node_id"])
    assert node["cast"] == [char] and node["location"] == place
    edit(store, "update_scene", node_id=node["id"], beat=node["beat"], location=None)
    assert store.get_node(node["id"])["location"] is None
    assert store.get_character("aya")["appearance"] == "黒髪"
    with pytest.raises(ValueError, match="場所ID"):
        edit(store, "update_scene", node_id="first", beat="本文", location="unknown")


def test_concurrent_library_update_and_pending_instruction_prevent_write(store):
    versions = production.NodeVersions(store)
    store.update_character("aya", {"profile": "手動の設定"})
    with pytest.raises(production.ManualEditPending):
        asyncio.run(production.apply_edit(store, "fake", "update_character",
            {"id": "aya", "profile": "古い案", "reason": "依頼"}, versions=versions))
    def stop():
        raise production.InstructionsPending("停止")
    with pytest.raises(production.InstructionsPending):
        asyncio.run(production.apply_edit(store, "fake", "create_place",
            {"name": "作らない場所", "reason": "依頼"}, before_commit=stop))
    assert len(store.list_places()) == 1


def test_failure_rolls_back_create_and_followup_field_update(store, monkeypatch):
    def fail(*args):
        raise RuntimeError("失敗")
    monkeypatch.setattr(Store, "update_character", fail)
    with pytest.raises(RuntimeError):
        edit(store, "create_character", name="残さない", reading="のこさない")
    assert len(store.list_characters()) == 1


@pytest.mark.parametrize("execute", [False, True])
def test_stream_permissions_history_and_snapshot(store, monkeypatch, execute):
    calls = iter([
        ("read_library", {"kind": "character", "id": "aya"}),
        ("create_character", {"name": "リオ", "profile": "友人", "reason": "依頼"}),
        ("create_place", {"name": "広場", "reason": "依頼"}),
    ])
    async def stream(messages, **kwargs):
        names = {tool["function"]["name"] for tool in kwargs["tools"]}
        assert "read_library" in names
        assert ("create_character" in names) == execute
        action = next(calls, None)
        if action:
            name, args = action
            yield "done", {"tool_calls": [{"function": {"name": name, "arguments": json.dumps(args)}}]}
        else:
            yield "done", {"content": "完了"}
    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    async def collect():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in
                production.stream(store, "fake", None, "人物と場所を登録", execute, lambda: None)]
    events = asyncio.run(collect())
    changed = [event["changed"] for event in events if "changed" in event]
    assert len(changed) == (2 if execute else 0)
    assert len(store.list_characters()) == (2 if execute else 1)
    if execute:
        chat = store.get_chat(events[0]["chat_id"])
        assert len([m for m in chat["messages"] if m.get("operation")]) == 2
        assert changed[0]["entity_type"] == "character" and "node_id" not in changed[0]
        snap = next(event["snapshot"] for event in events if "snapshot" in event)
        snapshots.restore(store, snap["id"])
        assert len(store.list_characters()) == 1 and len(store.list_places()) == 1
    else:
        assert len([event for event in events if "tool_error" in event]) == 2
