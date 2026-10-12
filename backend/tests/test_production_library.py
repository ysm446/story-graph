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


def test_chapter_create_rename_and_read(store):
    import production_chapters
    original = store.get_node("first")
    created = edit(store, "create_chapter", title="出発の章", node_ids=["first"])
    assert created["entity_type"] == "chapter" and created["in_id"] and created["out_id"]
    chapter_id = created["entity_id"]
    assert store.get_node("first")["group_id"] == chapter_id
    assert store.get_node("first")["beat"] == original["beat"]
    assert store.get_node("last")["group_id"] is None
    renamed = edit(store, "rename_chapter", chapter_id=chapter_id, title="旅立ち")
    assert renamed["before"]["title"] == "出発の章" and renamed["after"]["title"] == "旅立ち"
    assert production_chapters.read(store)["chapters"][0]["title"] == "旅立ち"
    with pytest.raises(ValueError, match="同名"):
        edit(store, "create_chapter", title="旅立ち", node_ids=[])


def test_chapter_add_only_requested_and_atomic_failure(store):
    chapter = edit(store, "create_chapter", title="空の章", node_ids=[])
    chapter_id = chapter["entity_id"]
    edit(store, "add_scenes_to_chapter", chapter_id=chapter_id, node_ids=["first"])
    assert store.get_node("first")["group_id"] == chapter_id
    assert store.get_node("last")["group_id"] is None
    other = edit(store, "create_chapter", title="別章", node_ids=[])
    before = store.graph()
    with pytest.raises(ValueError):
        edit(store, "add_scenes_to_chapter", chapter_id=other["entity_id"], node_ids=["last", "first"])
    assert store.graph() == before


def test_chapter_policy_rollback_and_versions(store):
    before = store.graph()
    # firstを章にすると接続先lastにも影響するため、候補全体の検証で拒否・巻き戻す。
    with pytest.raises(ValueError):
        asyncio.run(production.apply_edit(store, "fake", "create_chapter",
            {"title": "保護違反", "node_ids": ["first"], "reason": "依頼"},
            policy=ProductionPolicy(store, protected_ids=["last"])))
    assert store.graph() == before and not store.list_groups()
    created = edit(store, "create_chapter", title="章", node_ids=["first"])
    with pytest.raises(ValueError):
        asyncio.run(production.apply_edit(store, "fake", "rename_chapter",
            {"chapter_id": created["entity_id"], "title": "変更", "reason": "依頼"},
            policy=ProductionPolicy(store, protected_ids=["first"])))
    versions = production.NodeVersions(store)
    store.update_group(created["entity_id"], {"title": "手動改名"})
    with pytest.raises(production.ManualEditPending):
        versions.check(store, {"chapter_id": created["entity_id"]})


def test_chapter_cancel_and_invalid_members(store):
    def cancel():
        raise production.InstructionsPending("途中指示")
    with pytest.raises(production.InstructionsPending):
        asyncio.run(production.apply_edit(store, "fake", "create_chapter",
            {"title": "中断", "node_ids": [], "reason": "依頼"}, before_commit=cancel))
    for node_ids in (["missing"], "first", [3]):
        with pytest.raises(ValueError):
            edit(store, "create_chapter", title="不正", node_ids=node_ids)
    assert not store.list_groups()


@pytest.mark.parametrize("execute", [False, True])
def test_chapter_stream_tools_history_and_restore(store, monkeypatch, execute):
    step = 0
    async def stream(messages, **kwargs):
        nonlocal step
        names = {tool["function"]["name"] for tool in kwargs["tools"]}
        assert "read_chapters" in names
        assert ("create_chapter" in names) == execute
        step += 1
        if step == 1:
            name, args = "read_chapters", {}
        elif step == 2:
            name, args = "create_chapter", {"title": "制作した章", "node_ids": [], "reason": "依頼"}
        elif step == 3 and execute:
            name, args = "rename_chapter", {"chapter_id": store.list_groups()[0]["id"], "title": "改名した章", "reason": "改名"}
        elif step == 4 and execute:
            name, args = "add_scenes_to_chapter", {"chapter_id": store.list_groups()[0]["id"], "node_ids": ["first"], "reason": "追加"}
        else:
            yield "done", {"content": "完了"}
            return
        yield "done", {"tool_calls": [{"function": {"name": name, "arguments": json.dumps(args)}}]}
    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    async def collect():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in
                production.stream(store, "fake", None, "章を作り改名してシーンを追加", execute, lambda: None)]
    events = asyncio.run(collect())
    changes = [event["changed"] for event in events if "changed" in event]
    assert len(changes) == (3 if execute else 0)
    if execute:
        assert changes[-1]["entity_type"] == "chapter"
        assert store.list_groups()[0]["title"] == "改名した章"
        assert store.get_node("last")["group_id"] is None
        assert len([m for m in store.get_chat(events[0]["chat_id"])["messages"] if m.get("operation")]) == 3
        snapshots.restore(store, next(event["snapshot"] for event in events if "snapshot" in event)["id"])
    assert not store.list_groups()


def test_setting_document_create_update_and_guards(store):
    created = edit(store, "create_setting_document", title="社会制度", body="旧制度", category="制度")
    entity_id = created["entity_id"]
    assert created["entity_type"] == "setting_document"
    assert created["after"]["status"] == "draft" and created["after"]["ai_mode"] == "search"
    updated = edit(store, "update_setting_document", id=entity_id, revision=1, body="新制度")
    assert updated["before"]["body"] == "旧制度" and updated["after"]["body"] == "新制度"
    assert updated["after"]["category"] == "制度"
    assert updated["revision"] == 2
    with pytest.raises(ValueError, match="読み直"):
        edit(store, "update_setting_document", id=entity_id, revision=1, body="古い変更")
    with pytest.raises(ValueError, match="同名"):
        edit(store, "create_setting_document", title="社会制度", body="重複")
    with pytest.raises(ValueError):
        edit(store, "update_setting_document", id=entity_id, revision=2, status="invalid")
    versions = production.NodeVersions(store)
    edit(store, "update_setting_document", id=entity_id, revision=2, ai_mode="never")
    with pytest.raises(production.ManualEditPending):
        versions.check(store, {})
    with pytest.raises(ValueError, match="参照・編集"):
        edit(store, "update_setting_document", id=entity_id, revision=3, body="非公開への変更")
    assert store.get_setting_document(entity_id)["body"] == "新制度"


def test_setting_document_tools_only_execute_and_cancel_before_commit(store):
    names = lambda execute: {tool["function"]["name"] for tool in library.tools(execute)}
    assert {"create_setting_document", "update_setting_document"} <= names(True)
    assert not {"create_setting_document", "update_setting_document"} & names(False)
    def cancel():
        raise production.InstructionsPending("途中指示")
    with pytest.raises(production.InstructionsPending):
        asyncio.run(production.apply_edit(store, "fake", "create_setting_document",
                    {"title": "中断", "body": "本文", "reason": "依頼"}, before_commit=cancel))
    assert store.list_setting_documents() == []


@pytest.mark.parametrize("execute", [False, True])
def test_setting_document_stream_and_restore(store, monkeypatch, execute):
    step = 0
    async def stream(messages, **kwargs):
        nonlocal step
        names = {tool["function"]["name"] for tool in kwargs["tools"]}
        assert ("create_setting_document" in names) == execute
        step += 1
        if step == 1:
            name, args = "create_setting_document", {"title": "制度", "body": "原文", "reason": "依頼"}
        elif step == 2 and execute:
            doc = store.list_setting_documents()[0]
            name, args = "update_setting_document", {"id": doc["id"], "revision": doc["revision"], "body": "修正した制度", "reason": "修正依頼"}
        else:
            yield "done", {"content": "完了"}
            return
        yield "done", {"tool_calls": [{"function": {"name": name, "arguments": json.dumps(args)}}]}
    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    async def collect():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in
                production.stream(store, "fake", None, "設定資料を作成して修正", execute, lambda: None)]
    events = asyncio.run(collect())
    changes = [event["changed"] for event in events if "changed" in event]
    assert len(changes) == (2 if execute else 0)
    if execute:
        assert store.list_setting_documents()[0]["body"] == "修正した制度"
        assert any(event.get("active_library", {}).get("kind") == "setting_document" for event in events)
        assert len([m for m in store.get_chat(events[0]["chat_id"])["messages"] if m.get("operation")]) == 2
        snapshot = next(event["snapshot"] for event in events if "snapshot" in event)
        snapshots.restore(store, snapshot["id"])
    assert store.list_setting_documents() == []


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
    async def continuity_ok(*args):
        pass
    monkeypatch.setattr(production.production_continuity, "check", continuity_ok)
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
        assert not any("tool_error" in event for event in events)
        assert sum("相談モード" in event.get("delta", "") for event in events) == 1
