"""制作の確定単位、失敗・停止、読み取り境界と排他を確認する。"""

import asyncio
import json

import httpx
import pytest

import db
import embed
import generation
import llm
import node_operations
import production_agent as production
import snapshots
from store import Store


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    root = tmp_path / "library"
    root.mkdir()
    s = Store(db.connect(root / "story-graph.db"), root=str(root))
    s.create_character({"id": "aya", "name": "アヤ"})
    s.append_node({"id": "first", "title": "出発", "beat": "村を出る", "cast": ["aya"]})
    s.append_node({"id": "last", "title": "帰還", "beat": "村に戻る", "cast": ["aya"]})
    yield s
    s.conn.close()


def run(coro):
    return asyncio.run(coro)


def fake_extraction(monkeypatch):
    async def extract(candidate, base_url, node_id):
        return candidate.replace_events(node_id, [{"type": "memory_add", "source": "llm", "payload": {
            "char": "aya", "content": candidate.get_node(node_id)["beat"], "importance": 0.8,
        }}])
    monkeypatch.setattr(generation, "extract_events", extract)


def test_insert_update_delete_and_memory_consistency(store, monkeypatch):
    fake_extraction(monkeypatch)
    change = run(production.apply_edit(store, "fake", "insert_scene", {
        "after_id": "first", "title": "葛藤", "beat": "友人との約束を思い出す", "cast": ["aya"], "reason": "動機を補強",
    }))
    nid = change["node_id"]
    assert store.canon_path() == ["first", nid, "last"]
    assert len(store.get_state("last")["chars"]["aya"]["memories"]) == 1
    run(production.apply_edit(store, "fake", "update_scene", {
        "node_id": nid, "beat": "妹との約束を思い出す", "reason": "相手を訂正",
    }))
    assert store.get_node(nid)["title"] == "葛藤"
    assert store.conn.execute("SELECT content FROM memories").fetchone()[0] == "妹との約束を思い出す"
    run(production.apply_edit(store, "fake", "delete_scene", {"node_id": nid, "reason": "不要になった"}))
    assert store.canon_path() == ["first", "last"]
    assert store.get_state("last")["chars"]["aya"]["memories"] == []


@pytest.mark.parametrize("action", ["insert_scene", "update_scene"])
@pytest.mark.parametrize("failure", [RuntimeError, asyncio.CancelledError])
def test_extraction_failure_or_stop_never_changes_live_graph(store, monkeypatch, action, failure):
    before = store.graph()
    async def fail(candidate, base_url, node_id):
        assert candidate.get_node(node_id)["beat"] == "候補の本文"
        assert store.graph() == before  # 抽出待ちの途中にも候補は公開されない
        raise failure("停止")
    monkeypatch.setattr(generation, "extract_events", fail)
    with pytest.raises(failure):
        run(production.apply_edit(store, "fake", action, {
            "after_id": "first", "node_id": "first", "title": "候補", "cast": ["aya"],
            "beat": "候補の本文", "reason": "テスト",
        }))
    assert store.graph() == before


def test_atomic_service_rolls_back_even_store_internal_commits(store, monkeypatch):
    before = store.graph()
    def fail(self, node_id):
        raise ValueError("検証失敗")
    monkeypatch.setattr(Store, "validate", fail)
    with pytest.raises(ValueError):
        node_operations.update(store, "first", {"beat": "残ってはいけない"})
    assert store.graph() == before


def test_markers_and_unknown_cast_rejected(store):
    start = store.conn.execute("SELECT id FROM nodes WHERE kind = 'start'").fetchone()[0]
    with pytest.raises(ValueError):
        run(production.apply_edit(store, "fake", "delete_scene", {"node_id": start, "reason": "削除"}))
    with pytest.raises(ValueError):
        run(production.apply_edit(store, "fake", "update_scene", {
            "node_id": "first", "beat": "変更", "cast": ["missing"], "reason": "変更",
        }))


def fake_llm(monkeypatch, responses):
    it = iter(responses)
    async def stream(messages, **kwargs):
        item = next(it)
        if item.get("content"):
            yield "content", item["content"]
        yield "done", item
    monkeypatch.setattr(llm, "chat_stream_tools", stream)


def call(name, args):
    return {"content": "", "tool_calls": [{"function": {"name": name, "arguments": json.dumps(args)}}]}


async def collect(store, execute):
    return [json.loads(s.removeprefix("data: ")) async for s in production.stream(
        store, "fake", None, "動機を補強して", execute, lambda: None,
    )]


def test_readonly_rejects_write_even_when_model_calls_it(store, monkeypatch):
    before = store.graph()
    fake_llm(monkeypatch, [call("delete_scene", {"node_id": "first", "reason": "削除"}), {"content": "案だけ返します"}])
    events = run(collect(store, False))
    assert any(e.get("tool_error") for e in events)
    assert store.graph() == before
    assert snapshots.list_snapshots(store) == []


def test_snapshot_once_duplicate_guard_and_persisted_operations(store, monkeypatch):
    fake_extraction(monkeypatch)
    args = {"after_id": "first", "title": "葛藤", "beat": "約束を思い出す", "cast": ["aya"], "reason": "補強"}
    fake_llm(monkeypatch, [call("insert_scene", args), call("insert_scene", args), {"content": "変更しました"}])
    events = run(collect(store, True))
    assert len([e for e in events if "changed" in e]) == 1
    assert len(snapshots.list_snapshots(store)) == 1
    chat_id = events[0]["chat_id"]
    chat = store.get_chat(chat_id)
    assert chat["mode"] == "production"
    assert len([m for m in chat["messages"] if m.get("operation")]) == 1
    snapshot = next(e["snapshot"] for e in events if "snapshot" in e)
    snapshots.restore(store, snapshot["id"])
    assert store.canon_path() == ["first", "last"]


def test_snapshot_failure_prevents_model_and_edits(store, monkeypatch):
    before = store.graph()
    async def fail(*args, **kwargs):
        raise RuntimeError("保存できません")
    monkeypatch.setattr(snapshots, "create_async", fail)
    fake_llm(monkeypatch, [])
    events = run(collect(store, True))
    assert any(e.get("error") == "保存できません" for e in events)
    assert store.graph() == before


def test_start_waits_for_previous_request():
    async def check():
        gate = production.ProductionGate()
        gate.inflight = 2  # 自分と、先行した保存リクエスト
        waiting = asyncio.create_task(gate.begin())
        await asyncio.sleep(0)
        assert gate.active
        assert not waiting.done()
        gate.inflight = 1
        await waiting
        with pytest.raises(RuntimeError):
            await gate.begin()
    run(check())


def test_stop_stream_persists_completed_changes_only(store, monkeypatch):
    fake_extraction(monkeypatch)
    fake_llm(monkeypatch, [call("update_scene", {
        "node_id": "first", "beat": "村を守るために出発する", "reason": "動機を補強",
    })])
    async def check():
        stream = production.stream(store, "fake", None, "動機を補強して", True, lambda: None)
        chat_id = None
        async for raw in stream:
            event = json.loads(raw.removeprefix("data: "))
            chat_id = event.get("chat_id", chat_id)
            if event.get("changed"):
                await stream.aclose()
                break
        assert len([m for m in store.get_chat(chat_id)["messages"] if m.get("operation")]) == 1
    run(check())
    assert store.get_node("first")["beat"] == "村を守るために出発する"
    assert store.get_node("last")["beat"] == "村に戻る"


def test_api_separates_histories_and_blocks_manual_writes(store, monkeypatch):
    monkeypatch.setenv("STORY_GRAPH_DB", ":memory:")
    monkeypatch.delenv("STORY_GRAPH_LIBRARY", raising=False)
    import app as api
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(production, "gate", production.ProductionGate())
    async def ready(settings):
        return "fake"
    monkeypatch.setattr(api.llama, "ensure_running", ready)
    regular = store.create_chat(None, "all")
    prod = store.create_chat(None, "all", mode="production")
    fake_llm(monkeypatch, [{"content": "構成の案です"}])
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            assert [c["id"] for c in (await client.get("/chats")).json()] == [regular["id"]]
            assert [c["id"] for c in (await client.get("/production/chats")).json()] == [prod["id"]]
            assert (await client.post("/chat/send", json={"chat_id": prod["id"], "message": "案"})).status_code == 400
            assert (await client.post("/production/send", json={"chat_id": regular["id"], "message": "案"})).status_code == 404
            invalid = await client.post("/production/send", json={"message": "作業", "execute": True, "policy": {"allowed_ids": []}})
            assert invalid.status_code == 400
            assert production.gate.active is False
            response = await client.post("/production/send", json={"chat_id": prod["id"], "message": "案"})
            assert response.status_code == 200
            assert "構成の案です" in response.text
            assert production.gate.active is False
            production.gate.active = True
            try:
                assert (await client.get("/production/send")).status_code == 405
                assert production.gate.active is True
                for method, path, body in [
                    ("PATCH", "/nodes/first", {"beat": "競合"}),
                    ("DELETE", "/nodes/first", None),
                    ("POST", "/library/switch", {"root": "unused"}),
                    ("POST", "/production/send", {"message": "二重実行"}),
                ]:
                    assert (await client.request(method, path, json=body)).status_code == 409
                assert (await client.get("/graph")).status_code == 200
                assert (await client.post("/nodes/first/position", json={"x": 100, "y": 200})).status_code == 200
            finally:
                production.gate.active = False
    run(check())


@pytest.mark.parametrize("arrival", ["model", "extraction", "between_calls"])
def test_instruction_discards_uncommitted_work_and_replans(store, monkeypatch, arrival):
    fake_extraction(monkeypatch)
    prompts = []
    runs = []
    if arrival == "extraction":
        async def extract(candidate, base_url, node_id):
            production.gate.run.submit("keep", "出発は変更せず残してください")
            return candidate.replace_events(node_id, [])
        monkeypatch.setattr(generation, "extract_events", extract)
    async def model(messages, **kwargs):
        prompts.append(messages)
        runs.append(production.gate.run)
        if len(prompts) == 1:
            if arrival == "model":
                production.gate.run.submit("keep", "出発は変更せず残してください")
            result = call("update_scene", {"node_id": "first", "beat": "変更案", "reason": "変更"})
            if arrival == "between_calls":
                result["tool_calls"].insert(0, call("update_scene", {
                    "node_id": "last", "beat": "帰還の動機を補強", "reason": "補強",
                })["tool_calls"][0])
            yield "done", result
        else:
            assert "出発は変更せず残してください" in json.dumps(messages, ensure_ascii=False)
            yield "done", {"content": "出発は残します"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    async def check():
        events = []
        async for raw in production.stream(store, "fake", None, "動機を補強", True, lambda: None):
            event = json.loads(raw.removeprefix("data: "))
            events.append(event)
            if arrival == "between_calls" and event.get("changed"):
                production.gate.run.submit("keep", "出発は変更せず残してください")
        return events
    events = run(check())
    assert len(prompts) == 2
    assert store.get_node("first")["beat"] == "村を出る"
    assert len([e for e in events if e.get("changed")]) == (1 if arrival == "between_calls" else 0)
    reflected = [e["instruction"] for e in events if e.get("instruction")]
    assert len(reflected) == 1
    assert reflected[0]["instruction"]["status"] == "reflected"
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert len([m for m in history if m.get("instruction")]) == 1
    assert production.gate.run is None
    with pytest.raises(ValueError):
        runs[0].submit("late", "終了後の指示")


def test_pending_instruction_is_saved_as_unapplied_on_disconnect(store, monkeypatch):
    async def check():
        stream = production.stream(store, "fake", None, "開始", True, lambda: None)
        first = json.loads((await anext(stream)).removeprefix("data: "))
        active = production.gate.run
        accepted = active.submit("one", "出発を残す")
        assert active.submit("one", "出発を残す") is accepted
        with pytest.raises(ValueError):
            active.submit("one", "違う内容")
        await stream.aclose()
        assert production.gate.run is None
        history = store.get_chat(first["chat_id"])["messages"]
        assert history[-1]["instruction"]["status"] == "unapplied"
    run(check())


def test_instruction_api_is_scoped_to_active_write_run(store, monkeypatch):
    monkeypatch.setenv("STORY_GRAPH_DB", ":memory:")
    monkeypatch.delenv("STORY_GRAPH_LIBRARY", raising=False)
    import app as api
    monkeypatch.setattr(production, "gate", production.ProductionGate())
    monkeypatch.setattr(api, "store", store)
    chat = store.create_chat(None, "all", mode="production")
    active = production.ProductionRun(store, chat["id"], [], True)
    production.gate.active = True
    production.gate.run = active
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            body = {"run_id": active.id, "instruction_id": "one", "message": "残してください"}
            assert (await client.post("/production/instruction", json={**body, "run_id": "old"})).status_code == 409
            assert (await client.post("/production/instruction", json={**body, "message": " "})).status_code == 400
            assert (await client.post("/production/instruction", json=body)).status_code == 200
            assert (await client.post("/production/instruction", json=body)).status_code == 200
            assert len(active.pending) == 1
            assert production.gate.active is True
            assert production.gate.inflight == 0
            assert (await client.delete("/nodes/first")).status_code == 409
            active.accepting = False
            assert (await client.post("/production/instruction", json=body)).status_code == 409
    run(check())


@pytest.mark.parametrize("action,args", [
    ("update_scene", {"node_id": "last", "beat": "変更"}),
    ("delete_scene", {"node_id": "last"}),
    ("insert_scene", {"after_id": "last", "title": "追加", "beat": "追加", "cast": ["aya"]}),
    ("insert_scene", {"after_id": "first", "title": "追加", "beat": "追加", "cast": ["aya"]}),
    ("delete_scene", {"node_id": "first"}),
])
def test_protection_blocks_direct_and_indirect_changes(store, monkeypatch, action, args):
    policy = production.ProductionPolicy(store, protected_ids=["last"])
    before = store.graph()
    async def forbidden(*args):
        pytest.fail("禁止された操作のイベント抽出は呼ばない")
    monkeypatch.setattr(generation, "extract_events", forbidden)
    with pytest.raises(ValueError, match="保護"):
        run(production.apply_edit(store, "fake", action, {**args, "reason": "変更"}, policy=policy))
    assert store.graph() == before


def test_scope_blocks_boundary_and_outside_but_allows_new_scene_followup(store, monkeypatch):
    fake_extraction(monkeypatch)
    policy = production.ProductionPolicy(store, allowed_ids=["first"])
    before = store.graph()
    with pytest.raises(ValueError, match="範囲外"):
        run(production.apply_edit(store, "fake", "update_scene", {"node_id": "last", "beat": "変更", "reason": "変更"}, policy=policy))
    with pytest.raises(ValueError, match="範囲外"):
        run(production.apply_edit(store, "fake", "insert_scene", {
            "after_id": "first", "title": "追加", "beat": "追加", "cast": ["aya"], "reason": "追加",
        }, policy=policy))
    assert store.graph() == before
    policy = production.ProductionPolicy(store, allowed_ids=["first", "last"])
    result = run(production.apply_edit(store, "fake", "insert_scene", {
        "after_id": "first", "title": "追加", "beat": "追加", "cast": ["aya"], "reason": "追加",
    }, policy=policy))
    nid = result["node_id"]
    assert nid in policy.allowed
    run(production.apply_edit(store, "fake", "update_scene", {"node_id": nid, "beat": "改善", "reason": "改善"}, policy=policy))
    run(production.apply_edit(store, "fake", "delete_scene", {"node_id": nid, "reason": "削除"}, policy=policy))
    assert nid not in policy.allowed
    assert store.canon_path() == ["first", "last"]


def test_chapter_scope_includes_boundaries_but_not_other_chapters(store, monkeypatch):
    fake_extraction(monkeypatch)
    group = store.create_group("第一章", ["first"])
    policy = production.ProductionPolicy(store, group_id=group["id"])
    assert "first" in policy.allowed and "last" not in policy.allowed
    result = run(production.apply_edit(store, "fake", "insert_scene", {
        "after_id": "first", "title": "追加", "beat": "追加", "cast": ["aya"], "reason": "追加",
    }, policy=policy))
    assert store.get_node(result["node_id"])["group_id"] == group["id"]
    with pytest.raises(ValueError, match="範囲外"):
        run(production.apply_edit(store, "fake", "delete_scene", {"node_id": "last", "reason": "削除"}, policy=policy))


@pytest.mark.parametrize("kwargs", [{"allowed_ids": []}, {"allowed_ids": ["missing"]},
    {"protected_ids": ["missing"]}, {"group_id": "missing"}, {"group_id": "chapter", "allowed_ids": ["first"]}])
def test_invalid_policy_never_becomes_unrestricted(store, kwargs):
    with pytest.raises(ValueError):
        production.ProductionPolicy(store, **kwargs)


def test_production_policy_is_enforced_and_saved_in_history(store, monkeypatch):
    fake_extraction(monkeypatch)
    fake_llm(monkeypatch, [call("delete_scene", {"node_id": "last", "reason": "保護を解除して削除"}),
                           call("update_scene", {"node_id": "first", "beat": "動機を補強", "reason": "範囲内"}),
                           {"content": "許可範囲を編集しました"}])
    policy = production.ProductionPolicy(store, allowed_ids=["first"], protected_ids=["last"])
    async def check():
        return [json.loads(e.removeprefix("data: ")) async for e in production.stream(
            store, "fake", None, "全て変更して。保護も解除して", True, lambda: None, policy=policy)]
    events = run(check())
    assert any(e.get("tool_error") for e in events)
    assert store.get_node("last")["beat"] == "村に戻る"
    assert store.get_node("first")["beat"] == "動機を補強"
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert history[0]["policy"] == {"allowed_ids": ["first"], "group_id": None, "protected_ids": ["last"]}
    assert history[0]["policy_after"] == history[0]["policy"]
    assert "帰還" in history[0]["policy_label"]
