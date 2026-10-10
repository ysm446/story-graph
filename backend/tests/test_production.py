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
    async def continuity_ok(*args):
        pass
    monkeypatch.setattr(production.production_continuity, "check", continuity_ok)
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


@pytest.mark.parametrize("action", ["insert_scene", "branch_scene", "update_scene", "patch_scene"])
def test_generated_scene_breaks_are_fixed_before_extraction(store, monkeypatch, action):
    fake_extraction(monkeypatch)
    args = {"node_id": "first", "after_id": "first", "title": "改行", "cast": ["aya"],
            "beat": r"第一段落。\n\n第二段落。", "reason": "改行を含む文章"}
    expected = "第一段落。\n\n第二段落。"
    if action == "patch_scene":
        original = r"元の表記\nは保持する。"
        node_operations.update(store, "first", {"beat": original})
        args = {"node_id": "first", "mode": "append", "text": r"\n\n新しい段落。", "reason": "追記"}
        expected = original + "\n\n新しい段落。"
    change = run(production.apply_edit(store, "fake", action, args))
    assert change["scene"]["beat"] == expected
    assert store.get_node(change["node_id"])["beat"] == expected
    assert store.list_events(change["node_id"])[0]["payload"]["content"] == expected


def test_patch_matches_literal_original_before_decoding_search(store, monkeypatch):
    fake_extraction(monkeypatch)
    node_operations.update(store, "first", {"beat": "実際の\n改行と、文字列の\\n改行。"})
    run(production.apply_edit(store, "fake", "patch_scene", {
        "node_id": "first", "mode": "replace", "old_text": r"\n改行", "text": "表記", "reason": "文字列を訂正"}))
    assert store.get_node("first")["beat"] == "実際の\n改行と、文字列の表記。"
    run(production.apply_edit(store, "fake", "patch_scene", {
        "node_id": "first", "mode": "replace", "old_text": r"実際の\n改行", "text": "段落", "reason": "実改行を含む箇所"}))
    assert store.get_node("first")["beat"] == "段落と、文字列の表記。"


@pytest.mark.parametrize("patch,expected", [
    ({"mode": "append", "text": "\n約束を守る。"}, "村を出る\n約束を守る。"),
    ({"mode": "replace", "old_text": "村", "text": "町"}, "町を出る"),
    ({"mode": "replace", "old_text": "村を", "text": ""}, "出る"),
])
def test_patch_preserves_other_fields_and_reextracts_events(store, monkeypatch, patch, expected):
    fake_extraction(monkeypatch)
    before = store.graph()
    change = run(production.apply_edit(store, "fake", "patch_scene", {
        "node_id": "first", "reason": "指定箇所だけ変更", **patch}))
    assert change["action"] == "update_scene"  # 既存の履歴表示・再取得・追従を使う
    assert change["scene"]["beat"] == expected
    assert store.get_node("first")["title"] == "出発"
    assert store.get_node("first")["cast"] == ["aya"]
    assert store.graph()["edges"] == before["edges"]
    assert store.get_node("last")["beat"] == "村に戻る"
    assert store.conn.execute("SELECT content FROM memories").fetchone()[0] == expected


@pytest.mark.parametrize("patch", [
    {"mode": "replace", "old_text": "不存在", "text": "変更"},
    {"mode": "replace", "old_text": "", "text": "変更"},
    {"mode": "replace", "old_text": "村を出る", "text": ""},
    {"mode": "replace", "old_text": "村", "text": "村"},
    {"mode": "append", "text": "出る"},
    {"mode": "append", "text": " "},
    {"mode": "append", "text": "追加", "old_text": "村"},
    {"mode": "append", "text": "追加", "cast": []},
    {"mode": "append", "text": None},
    {"mode": "unknown", "text": "追加"},
])
def test_invalid_patch_leaves_graph_unchanged(store, patch):
    before = store.graph()
    with pytest.raises(ValueError):
        run(production.apply_edit(store, "fake", "patch_scene", {
            "node_id": "first", "reason": "修正", **patch}))
    assert store.graph() == before


@pytest.mark.parametrize("beat,old", [("村で会い、村を出る", "村"), ("あああ", "ああ")])
def test_ambiguous_patch_requires_unique_source(store, beat, old):
    node_operations.update(store, "first", {"beat": beat})
    with pytest.raises(ValueError, match="1か所"):
        run(production.apply_edit(store, "fake", "patch_scene", {
            "node_id": "first", "mode": "replace", "old_text": old, "text": "町", "reason": "訂正"}))
    assert store.get_node("first")["beat"] == beat


@pytest.mark.parametrize("failure", [RuntimeError, asyncio.CancelledError, production.ManualEditPending])
def test_patch_failure_does_not_publish_candidate(store, monkeypatch, failure):
    before = store.graph()
    async def fail(candidate, base_url, node_id):
        assert candidate.get_node(node_id)["beat"] == "村を出る。約束を守る"
        raise failure("停止")
    monkeypatch.setattr(generation, "extract_events", fail)
    with pytest.raises(failure):
        run(production.apply_edit(store, "fake", "patch_scene", {
            "node_id": "first", "mode": "append", "text": "。約束を守る", "reason": "追記"}))
    assert store.graph() == before


def test_patch_protection_and_concurrent_manual_edit(store, monkeypatch):
    args = {"node_id": "first", "mode": "append", "text": "。約束を守る", "reason": "追記"}
    with pytest.raises(ValueError, match="保護"):
        run(production.apply_edit(store, "fake", "patch_scene", args,
            policy=production.ProductionPolicy(store, protected_ids=["first"])))
    async def manual(candidate, base_url, node_id):
        node_operations.update(store, node_id, {"beat": "作者の修正"})
    monkeypatch.setattr(generation, "extract_events", manual)
    with pytest.raises(production.ManualEditPending):
        run(production.apply_edit(store, "fake", "patch_scene", args))
    assert store.get_node("first")["beat"] == "作者の修正"


@pytest.mark.parametrize("action", ["insert_scene", "branch_scene", "update_scene"])
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


def test_branch_and_extension_preserve_canon_connections_and_memories(store, monkeypatch):
    fake_extraction(monkeypatch)
    before = store.graph()
    ending = store.active_ending()
    policy = production.ProductionPolicy(store, allowed_ids=["first"], protected_ids=["last"])
    branch = run(production.apply_edit(store, "fake", "branch_scene", {
        "after_id": "first", "title": "別の道", "beat": "森へ進む", "cast": ["aya"], "reason": "分岐を作る",
    }, policy=policy))["node_id"]
    child = run(production.apply_edit(store, "fake", "insert_scene", {
        "after_id": branch, "title": "森の奥", "beat": "小屋に着く", "cast": ["aya"], "reason": "枝の続きを作る",
    }, policy=policy))["node_id"]
    assert store.parent_of(branch) == "first"
    assert store.parent_of(child) == branch
    assert store.canon_path() == ["first", "last"]
    assert store.active_ending() == ending
    assert all(edge in store.graph()["edges"] for edge in before["edges"])
    assert all(store.get_node(n["id"])["beat"] == n["beat"] for n in before["nodes"])
    assert store.get_node(branch)["status"] == store.get_node(child)["status"] == "draft"
    assert store.get_state("last")["chars"].get("aya", {}).get("memories", []) == []
    assert len(store.get_state(child)["chars"]["aya"]["memories"]) == 2
    assert branch in policy.allowed and child in policy.allowed


def test_branch_in_chapter_and_multiple_sibling_routes(store, monkeypatch):
    fake_extraction(monkeypatch)
    group = store.create_group("章", ["first", "last"])
    policy = production.ProductionPolicy(store, group_id=group["id"])
    before = store.graph()
    ids = [run(production.apply_edit(store, "fake", "branch_scene", {
        "after_id": "first", "title": f"枝{i}", "beat": f"別の道{i}", "cast": ["aya"], "reason": "分岐",
    }, policy=policy))["node_id"] for i in range(2)]
    assert all(store.get_node(nid)["group_id"] == group["id"] for nid in ids)
    assert all(store.parent_of(nid) == "first" for nid in ids)
    assert all(edge in store.graph()["edges"] for edge in before["edges"])
    assert store.canon_path() == ["first", "last"]


@pytest.mark.parametrize("origin", ["protected", "outside", "ending", "missing"])
def test_invalid_branch_does_not_change_graph(store, monkeypatch, origin):
    fake_extraction(monkeypatch)
    policy = production.ProductionPolicy(store, protected_ids=["first"]) if origin == "protected" else (
        production.ProductionPolicy(store, allowed_ids=["last"]) if origin == "outside" else None)
    after_id = store.active_ending() if origin == "ending" else "missing" if origin == "missing" else "first"
    before = store.graph()
    with pytest.raises((ValueError, KeyError)):
        run(production.apply_edit(store, "fake", "branch_scene", {
            "after_id": after_id, "title": "枝", "beat": "別の道", "cast": ["aya"], "reason": "分岐",
        }, policy=policy))
    assert store.graph() == before


def fake_llm(monkeypatch, responses):
    it = iter(responses)
    async def stream(messages, **kwargs):
        item = next(it)
        if item.get("content"):
            yield "content", item["content"]
        yield "done", item
    monkeypatch.setattr(llm, "chat_stream_tools", stream)


def test_production_usage_includes_actual_context_and_step_results(store, monkeypatch):
    captured = []
    async def count(text, **kwargs):
        captured.append(text)
        return 1234
    monkeypatch.setattr(llm, "count_tokens", count)
    history = [{"role": "user", "content": "構成を相談"}]
    messages = production.build_messages(store, history, "構成を相談", True,
        production.ProductionPolicy(store), None, [{"action": "branch_scene", "title": "別ルート"}],
        [{"tool": "read_library", "result": "取得した設定"}])
    usage = run(production.context_usage(store, "fake", messages, True))
    assert usage["token_count"] == 1234 and usage["estimated"] is False
    assert all(value in captured[0] for value in ["出発", "構成を相談", "別ルート", "取得した設定", "create_character"])
    async def unavailable(*args, **kwargs):
        return None
    monkeypatch.setattr(llm, "count_tokens", unavailable)
    fallback = run(production.context_usage(store, "fake", messages, True))
    assert fallback["estimated"] is True and fallback["token_count"] == len(captured[0]) // 2


def test_production_usage_preview_is_read_only_and_separates_modes(store, monkeypatch):
    import app as api
    monkeypatch.setattr(api, "store", store)
    async def count(text, **kwargs):
        return len(text)
    monkeypatch.setattr(llm, "count_tokens", count)
    prod = store.create_chat(None, "all", mode="production")
    store.save_chat_messages(prod["id"], [{"role": "user", "content": "過去の相談"}])
    before = store.get_chat(prod["id"])
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            body = {"chat_id": prod["id"], "message": "次の依頼"}
            consult = await client.post("/production/token_usage", json=body)
            execute = await client.post("/production/token_usage", json={**body, "execute": True})
            assert consult.status_code == execute.status_code == 200
            assert execute.json()["token_count"] > consult.json()["token_count"]
            invalid = await client.post("/production/token_usage", json={"chat_id": "missing"})
            assert invalid.status_code == 404
    run(check())
    assert store.get_chat(prod["id"]) == before


def test_production_stream_reports_context_usage(store, monkeypatch):
    async def count(text, **kwargs):
        return 2345
    monkeypatch.setattr(llm, "count_tokens", count)
    fake_llm(monkeypatch, [{"content": "回答"}])
    events = run(collect(store, False))
    assert next(e["usage"] for e in events if "usage" in e)["token_count"] == 2345


def test_production_prompt_does_not_inherit_proposal_only_role(store):
    policy = production.ProductionPolicy(store)
    for execute in (False, True):
        messages = production.build_messages(store, [], "枝を膨らませて", execute, policy, None, [], [])
        system = messages[0]["content"]
        assert ("提案用のツールは使わない" in system) == (not execute)
        assert ("ツールで実際に編集する" in system) == execute
        if execute:
            assert "相談・提案・確認だけを求めた場合は編集しない" in system


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
    assert any("制作を実行" in e.get("delta", "") for e in events)
    assert not any(e.get("tool_error") for e in events)
    assert store.graph() == before
    assert snapshots.list_snapshots(store) == []


@pytest.mark.parametrize("tool", ["insert_scene", "patch_scene", "delete_character", "update_work_memory"])
def test_consult_write_attempt_ends_once_and_saves_guidance(store, monkeypatch, tool):
    before = store.graph()
    calls = []
    async def model(messages, **kwargs):
        calls.append(messages)
        assert len(calls) == 1
        # 引数が壊れていても書き込み試行を再試行させない。
        yield "done", {"tool_calls": [{"function": {"name": tool, "arguments": "invalid"}}]}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = run(collect(store, False))
    assert len(calls) == 1 and events[-1].get("done")
    system = calls[0][0]["content"]
    assert "update_work_memory" not in system and "patch_scene" not in system
    assert "次の入力を待って" in system
    assert not any(e.get("active_node") or e.get("changed") or e.get("tool_error") for e in events)
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert "現在は相談モード" in history[-1]["content"]
    assert "上限" not in history[-1]["content"]
    assert store.graph() == before and production.gate.run is None


def test_consult_repeated_read_stops_without_exhausting_steps(store, monkeypatch):
    fake_llm(monkeypatch, [call("get_beats", {"node_ids": ["first"]})] * 2)
    events = run(collect(store, False))
    assert events[-1].get("done")
    assert sum(e.get("stage") == production.TOOL_LABELS["get_beats"] for e in events) == 1
    assert any("いったん停止" in e.get("delta", "") for e in events)
    assert "いったん停止" in store.get_chat(events[0]["chat_id"])["messages"][-1]["content"]


def test_consult_distinct_reads_can_answer_normally(store, monkeypatch):
    fake_llm(monkeypatch, [call("get_beats", {"node_ids": ["first"]}),
        call("get_beats", {"node_ids": ["last"]}), {"content": "出発から帰還につながっています。"}])
    events = run(collect(store, False))
    assert events[-1].get("done")
    assert any(e.get("delta") == "出発から帰還につながっています。" for e in events)
    assert not any("いったん停止" in e.get("delta", "") for e in events)


def test_consult_proposal_survives_until_explicit_execution(store, monkeypatch):
    fake_extraction(monkeypatch)
    before = store.graph()
    proposal = '出発(first)の末尾に「。約束を守る」を追記する案です。未実施です。この案でよければ「制作を実行」に切り替えて「この案で進めて」と送ってください。'
    fake_llm(monkeypatch, [call("get_beats", {"node_ids": ["first"]}), {"content": proposal}])
    events = run(collect(store, False))
    chat_id = events[0]["chat_id"]
    assert store.graph() == before and snapshots.list_snapshots(store) == []
    assert store.get_chat(chat_id)["messages"][-1]["content"] == proposal

    async def send(execute):
        return [json.loads(s.removeprefix("data: ")) async for s in production.stream(
            store, "fake", chat_id, "この案で進めて", execute, lambda: None)]

    # 相談のまま了承しても、モデルの書き込みは通さない。
    patch = call("patch_scene", {"node_id": "first", "mode": "append", "text": "。約束を守る", "reason": "合意した案を反映"})
    fake_llm(monkeypatch, [patch])
    events = run(send(False))
    assert store.graph() == before and not any(e.get("changed") for e in events)
    assert snapshots.list_snapshots(store) == []

    replies = iter([patch, {"content": "追記しました。"}])
    async def model(messages, **kwargs):
        assert {"role": "assistant", "content": proposal} in messages
        assert "直前の会話で提示した変更案" in messages[0]["content"]
        yield "done", next(replies)
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = run(send(True))
    assert sum(bool(e.get("changed")) for e in events) == 1
    assert store.get_node("first")["beat"] == "村を出る。約束を守る"
    assert store.get_node("last")["beat"] == "村に戻る"
    assert store.graph()["edges"] == before["edges"]
    assert len(snapshots.list_snapshots(store)) == 1


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


@pytest.mark.parametrize("execute", [False, True])
def test_patch_stream_respects_mode_and_uses_existing_edit_history(store, monkeypatch, execute):
    fake_extraction(monkeypatch)
    fake_llm(monkeypatch, [call("patch_scene", {
        "node_id": "first", "mode": "append", "text": "。約束を守る", "reason": "追記",
    }), {"content": "終了"}])
    events = run(collect(store, execute))
    changes = [e["changed"] for e in events if "changed" in e]
    assert ("patch_scene" in {t["function"]["name"] for t in production.tools(execute)}) == execute
    assert len(changes) == int(execute)
    if execute:
        assert changes[0]["action"] == "update_scene"
        chat_id = next(e["chat_id"] for e in events if "chat_id" in e)
        operations = [m["operation"] for m in store.get_chat(chat_id)["messages"] if "operation" in m]
        assert operations == changes
    assert store.get_node("first")["beat"] == ("村を出る。約束を守る" if execute else "村を出る")


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
        messages = store.get_chat(chat_id)["messages"]
        assert len([m for m in messages if m.get("operation")]) == 1
        # yieldで止まった生成器の後始末(GeneratorExit)でも、停止の記録と終了処理を残す。
        assert messages[-1]["content"].startswith("作業を停止しました")
        assert messages[0].get("policy_after") == {"allowed_ids": None, "group_id": None, "protected_ids": []}
        assert production.gate.run is None
    run(check())
    assert store.get_node("first")["beat"] == "村を守るために出発する"
    assert store.get_node("last")["beat"] == "村に戻る"
    assert production.production_memory.read(store)["checkpoint"]["status"] == "interrupted"


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
        assert next(m for m in history if m.get("instruction"))["instruction"]["status"] == "unapplied"
        assert history[-1]["content"].startswith("作業を停止しました")
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



def reconnect_args(node_id="first", parent_id="last", mode="scene"):
    return {"node_id": node_id, "parent_id": parent_id, "mode": mode, "reason": "順序を再構成"}


def test_reconnect_scene_preserves_events_and_recomputes_state(store, monkeypatch):
    async def forbidden(*args):
        pytest.fail("接続変更では本文のイベントを再抽出しない")
    monkeypatch.setattr(generation, "extract_events", forbidden)
    store.replace_events("first", [{"type": "memory_add", "payload": {"char": "aya", "content": "出発の記憶", "importance": 0.8}}])
    events = store.list_events("first")
    assert store.get_state("last")["chars"]["aya"]["memories"]
    ending = store.active_ending()
    result = run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args()))
    assert store.canon_path() == ["last", "first"]
    assert store.active_ending() == ending
    assert store.list_events("first") == events
    assert store.get_node("first")["beat"] == "村を出る"
    assert not store.get_state("last")["chars"]["aya"]["memories"]
    assert store.get_state("first")["chars"]["aya"]["memories"]
    assert result["connection"]["parent_id"] == "last"
    # 前方への移動も同じ処理で戻せる。
    start = next(n["id"] for n in store.graph()["nodes"] if n["kind"] == "start")
    run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args(parent_id=start)))
    assert store.canon_path() == ["first", "last"]


def test_reconnect_branch_keeps_descendants_and_target_children(store):
    store.append_node({"id": "branch", "beat": "別の道", "cast": ["aya"]}, parent_id="first", force_draft=True)
    store.append_node({"id": "child", "beat": "枝の続き", "cast": ["aya"]}, parent_id="branch", force_draft=True)
    ending = store.active_ending()
    run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args("branch", "last", "branch")))
    assert store.parent_of("child") == "branch"
    assert store.parent_of("branch") == "last"
    assert store.parent_of(ending) == "last"
    assert store.canon_path() == ["first", "last"]


@pytest.mark.parametrize("mode", ["scene", "branch"])
def test_reconnect_protected_neighbor_or_scope_cannot_change(store, mode):
    before = store.graph()
    for policy in [production.ProductionPolicy(store, protected_ids=["last"]),
                   production.ProductionPolicy(store, allowed_ids=["first"])]:
        with pytest.raises(ValueError):
            run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args(mode=mode), policy=policy))
        assert store.graph() == before


@pytest.mark.parametrize("parent,mode", [("first", "scene"), ("last", "branch"), ("missing", "scene"), ("last", "unknown")])
def test_reconnect_invalid_or_cyclic_is_atomic(store, parent, mode):
    before = store.graph()
    with pytest.raises(ValueError):
        run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args(parent_id=parent, mode=mode)))
    assert store.graph() == before


def test_reconnect_across_chapters_preserves_boundaries(store):
    g1 = store.create_group("第一章", ["first"])
    g2 = store.create_group("第二章", ["last"])
    run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args()))
    assert store.get_node("first")["group_id"] == g2["id"]
    assert store.canon_path() == ["last", "first"]
    node_operations._check_connections(store.graph())
    assert store.get_group(g1["id"])["warning"] is None
    assert store.get_group(g2["id"])["warning"] is None


def test_reconnect_rolls_back_final_validation_failure(store, monkeypatch):
    before = store.graph()
    def fail(graph):
        raise ValueError("検証失敗")
    monkeypatch.setattr(node_operations, "_check_connections", fail)
    with pytest.raises(ValueError):
        node_operations.reconnect(store, "first", "last", "scene")
    assert store.graph() == before


def test_reconnect_rejects_markers_and_ending_destination(store):
    ending = store.active_ending()
    before = store.graph()
    for args in [reconnect_args(node_id=ending), reconnect_args(parent_id=ending)]:
        with pytest.raises(ValueError):
            run(production.apply_edit(store, "fake", "reconnect_scene", args))
    assert store.graph() == before


def test_reconnect_stream_records_change_and_is_not_available_in_consultation(store, monkeypatch):
    fake_llm(monkeypatch, [call("reconnect_scene", reconnect_args()), {"content": "順序を変更しました"}])
    before = store.graph()
    assert any("相談モード" in e.get("delta", "") for e in run(collect(store, False)))
    assert store.graph() == before
    fake_llm(monkeypatch, [call("reconnect_scene", reconnect_args()), {"content": "順序を変更しました"}])
    events = run(collect(store, True))
    assert any(e.get("changed", {}).get("connection", {}).get("mode") == "scene" for e in events)
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert any(m.get("operation", {}).get("action") == "reconnect_scene" for m in history)



def test_reconnect_scene_leaves_original_branches_at_old_location(store):
    store.append_node({"id": "side", "beat": "分岐", "cast": ["aya"]}, parent_id="first", force_draft=True)
    start = store.parent_of("first")
    run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args()))
    assert store.parent_of("side") == start
    assert store.canon_path() == ["last", "first"]


def test_reconnect_stops_before_commit_and_keeps_graph(store):
    before = store.graph()
    def stop():
        raise production.InstructionsPending("途中指示")
    with pytest.raises(production.InstructionsPending):
        run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args(), before_commit=stop))
    assert store.graph() == before


def test_reconnect_rejects_new_event_validation_errors(store, monkeypatch):
    original = Store.validate
    def validate(self, node_id):
        if node_id == "first" and self.parent_of("first") == "last":
            return ["変更後の経路ではイベントの前提が成立しません"]
        return original(self, node_id)
    monkeypatch.setattr(Store, "validate", validate)
    before = store.graph()
    with pytest.raises(ValueError, match="矛盾"):
        run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args()))
    assert store.graph() == before



def test_reconnect_cannot_disconnect_active_ending(store):
    store.append_node({"id": "island", "beat": "独立", "cast": ["aya"]}, detached=True)
    before = store.graph()
    ending = store.active_ending()
    with pytest.raises(ValueError, match="結末"):
        run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args(parent_id="island", mode="branch")))
    assert store.graph() == before
    assert store.active_ending() == ending


def test_reconnect_ambiguous_destination_is_not_guessed(store):
    store.append_node({"id": "island", "beat": "独立", "cast": ["aya"]}, detached=True)
    for nid in ("left", "right"):
        store.append_node({"id": nid, "beat": "分岐", "cast": ["aya"]}, parent_id="island", force_draft=True)
    before = store.graph()
    with pytest.raises(ValueError, match="一意"):
        run(production.apply_edit(store, "fake", "reconnect_scene", reconnect_args(parent_id="island")))
    assert store.graph() == before


@pytest.mark.parametrize("change", ["body", "events", "edge", "delete"])
def test_versions_reject_changed_dependencies(store, change):
    versions = production.NodeVersions(store)
    if change == "body":
        node_operations.update(store, "first", {"beat": "手動の本文"})
    elif change == "events":
        store.replace_events("first", [{"type": "memory_add", "source": "user", "payload": {
            "char": "aya", "content": "手動の記憶", "importance": 0.5}}])
    elif change == "edge":
        node_operations.reconnect(store, "first", "last", "scene")
    else:
        node_operations.delete(store, "first")
    with pytest.raises(production.ManualEditPending):
        versions.check(store, {"node_id": "last"})


def test_versions_ignore_positions_and_unrelated_branch_body(store):
    start = store.parent_of("first")
    store.append_node({"id": "other", "title": "別の枝", "beat": "別案"}, parent_id=start, force_draft=True)
    versions = production.NodeVersions(store)
    node_operations.update(store, "other", {"beat": "別案の手動修正"})
    store.conn.execute("UPDATE nodes SET pos_x = 123 WHERE id = 'first'")
    store.conn.commit()
    versions.check(store, {"node_id": "first"})


def test_manual_change_during_extraction_is_not_overwritten(store, monkeypatch):
    async def extract(candidate, base_url, node_id):
        node_operations.update(store, node_id, {"beat": "手動で保存した本文"})
        candidate.replace_events(node_id, [])
    monkeypatch.setattr(generation, "extract_events", extract)
    with pytest.raises(production.ManualEditPending):
        run(production.apply_edit(store, "fake", "update_scene", {
            "node_id": "first", "beat": "古い判断の本文", "reason": "変更"}))
    assert store.get_node("first")["beat"] == "手動で保存した本文"


@pytest.mark.parametrize("arrival", ["model", "extraction"])
def test_manual_pause_resume_discards_old_operation(store, monkeypatch, arrival):
    fake_extraction(monkeypatch)
    prompts = []
    def manual_change():
        active = production.gate.run
        active.set_paused(True)
        node_operations.update(store, "first", {"beat": "作者が残した本文"})
        active.set_paused(False)
    if arrival == "extraction":
        async def extract(candidate, base_url, node_id):
            manual_change()
            candidate.replace_events(node_id, [])
        monkeypatch.setattr(generation, "extract_events", extract)
    async def model(messages, **kwargs):
        prompts.append(messages)
        if len(prompts) == 1:
            if arrival == "model":
                manual_change()
            yield "done", call("update_scene", {"node_id": "first", "beat": "破棄する本文", "reason": "旧判断"})
        else:
            yield "done", {"content": "手動の変更を残して終了します"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = run(collect(store, True))
    assert len(prompts) == 2
    assert not any("changed" in e for e in events)
    assert store.get_node("first")["beat"] == "作者が残した本文"
    assert "手動編集を終えました" in json.dumps(prompts[1], ensure_ascii=False)


def test_manual_pause_wait_and_cancel(store, monkeypatch):
    fake_llm(monkeypatch, [])
    async def check():
        stream = production.stream(store, "fake", None, "編集", True, lambda: None)
        async for raw in stream:
            if json.loads(raw.removeprefix("data: ")).get("manual_edit_ready"):
                production.gate.run.set_paused(True)
                break
        task = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.02)
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert production.gate.run is None
    run(check())


def test_manual_pause_api_guards_and_allowed_operations(store, monkeypatch):
    import app as api
    monkeypatch.setattr(api, "store", store)
    gate = production.ProductionGate()
    monkeypatch.setattr(production, "gate", gate)
    chat = store.create_chat(None, "all", mode="production")
    active = production.ProductionRun(store, chat["id"], [], True)
    gate.active, gate.run, gate.inflight = True, active, 1
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            body = {"run_id": active.id, "paused": True}
            assert (await client.post("/production/pause", json=body)).status_code == 409
            active.ready = True
            assert (await client.post("/production/pause", json={**body, "run_id": "old"})).status_code == 409
            assert (await client.patch("/nodes/first", json={"beat": "拒否"})).status_code == 409
            assert (await client.post("/production/pause", json=body)).status_code == 200
            assert (await client.patch("/nodes/first", json={"beat": "手動保存"})).status_code == 200
            assert (await client.put("/nodes/first/events", json={"events": []})).status_code == 200
            assert (await client.post("/nodes/first/insert_after", json={"beat": "手動追加"})).status_code == 200
            assert (await client.post("/library/switch", json={"root": "unused"})).status_code == 409
            assert (await client.post("/nodes/first/extract_events")).status_code == 409
            gate.inflight = 2
            assert (await client.post("/production/pause", json={**body, "paused": False})).status_code == 409
            gate.inflight = 1
            assert (await client.post("/production/pause", json={**body, "paused": False})).status_code == 200
            assert (await client.delete("/nodes/first")).status_code == 409
            assert gate.inflight == 1
    run(check())
    assert snapshots.list_snapshots(store) == []


def test_manual_delete_of_protected_node_does_not_block_other_edits(store, monkeypatch):
    fake_extraction(monkeypatch)
    policy = production.ProductionPolicy(store, protected_ids=["first"])
    node_operations.delete(store, "first")
    run(production.apply_edit(store, "fake", "update_scene", {
        "node_id": "last", "beat": "残った場面を修正", "reason": "続き"}, policy=policy))
    assert store.get_node("last")["beat"] == "残った場面を修正"


def test_manual_move_out_of_selected_chapter_cannot_expand_scope(store, monkeypatch):
    fake_extraction(monkeypatch)
    store.create_group("対象章", ["first"])
    group_id = store.get_node("first")["group_id"]
    store.create_group("別章", ["last"])
    policy = production.ProductionPolicy(store, group_id=group_id)
    node_operations.reconnect(store, "first", "last", "scene")
    with pytest.raises(ValueError):
        run(production.apply_edit(store, "fake", "update_scene", {
            "node_id": "first", "beat": "章外への変更", "reason": "変更"}, policy=policy))
    assert store.get_node("first")["beat"] == "村を出る"



def test_work_memory_persists_across_connections_and_isolated_libraries(store, tmp_path):
    from production_memory import read, write, history
    write(store, "## 方針\n結末は和解。", "作者が決定", "user", expected_revision=0)
    other_conn = db.connect(store.root + "/story-graph.db")
    try:
        reopened = Store(other_conn)
        assert read(reopened)["content"] == "## 方針\n結末は和解。"
        with pytest.raises(ValueError):
            write(reopened, "古いメモ", "競合", "user", expected_revision=0)
        write(reopened, "## 方針\n故郷へ戻らない。", "方針変更", "user", expected_revision=1)
        assert len(history(reopened)) == 2
    finally:
        other_conn.close()
    isolated = Store(db.connect(tmp_path / "other.db"))
    assert read(isolated)["revision"] == 0
    isolated.conn.close()


@pytest.mark.parametrize("content,reason", [("a" * 6001, "理由"), (None, "理由"), ("方針", ""), ("方針", "a" * 501)])
def test_work_memory_rejects_invalid_values(store, content, reason):
    import production_memory
    with pytest.raises(ValueError):
        production_memory.write(store, content, reason, "llm")
    assert production_memory.read(store)["revision"] == 0


def test_memory_tool_checkpoint_and_new_chat_resume(store, monkeypatch):
    import production_memory
    fake_extraction(monkeypatch)
    fake_llm(monkeypatch, [
        call("update_work_memory", {"content": "## 決定事項\n作者の依頼: 故郷には戻らない\n## 次の作業\nlastの帰還を見直す", "reason": "方針を引継ぎ"}),
        call("update_scene", {"node_id": "first", "beat": "和解を目指して旅立つ", "reason": "動機を補強"}),
        {"content": "出発を修正しました。帰還の見直しは次回です。"},
    ])
    events = run(collect(store, True))
    memory = production_memory.read(store)
    assert memory["revision"] == 1 and memory["source"] == "llm"
    assert memory["checkpoint"]["status"] == "completed"
    assert len(memory["checkpoint"]["changes"]) == 1
    assert any("memory" in e for e in events)
    prompts = []
    async def model(messages, **kwargs):
        prompts.append(messages)
        yield "done", {"content": "次は帰還を見直します"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    next_events = run(collect(store, False))
    assert next_events[0]["chat_id"] != events[0]["chat_id"]
    assert "故郷には戻らない" in prompts[0][0]["content"]
    assert "帰還の見直しは次回" in prompts[0][0]["content"]
    assert production_memory.read(store) == memory  # 相談は記録を上書きしない
    assert not any(e["type"] == "memory_add" and "故郷" in str(e) for e in store.list_events("first"))


def test_readonly_cannot_update_work_memory(store, monkeypatch):
    import production_memory
    fake_llm(monkeypatch, [call("update_work_memory", {"content": "書けない", "reason": "相談"}), {"content": "案のみ"}])
    events = run(collect(store, False))
    assert any("相談モード" in e.get("delta", "") for e in events)
    assert production_memory.read(store)["revision"] == 0
    assert "update_work_memory" not in [t["function"]["name"] for t in production.tools(False)]


def test_memory_snapshot_restore_and_interrupted_checkpoint(store, monkeypatch):
    import production_memory
    production_memory.write(store, "作業前", "初期方針", "user")
    fake_llm(monkeypatch, [call("update_work_memory", {"content": "作業途中の方針", "reason": "検討"})])
    async def check():
        stream = production.stream(store, "fake", None, "続きを作る", True, lambda: None)
        snapshot = None
        async for raw in stream:
            event = json.loads(raw.removeprefix("data: "))
            snapshot = event.get("snapshot", snapshot)
            if "memory" in event:
                await stream.aclose()
                break
        assert production_memory.read(store)["content"] == "作業途中の方針"
        assert production_memory.read(store)["checkpoint"]["status"] == "interrupted"
        snapshots.restore(store, snapshot["id"])
        assert production_memory.read(store)["content"] == "作業前"
        assert production_memory.read(store)["checkpoint"] is None
    run(check())


def test_memory_api_revision_and_production_lock(store, monkeypatch):
    import app as api
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(production, "gate", production.ProductionGate())
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            assert (await client.get("/production/memory")).json()["revision"] == 0
            assert (await client.put("/production/memory", json={"content": "作者の方針", "revision": 0})).status_code == 200
            assert (await client.put("/production/memory", json={"content": "競合", "revision": 0})).status_code == 409
            production.gate.active = True
            assert (await client.put("/production/memory", json={"content": "制作中", "revision": 1})).status_code == 409
            assert len((await client.get("/production/memory/history")).json()) == 1
    run(check())


def test_split_scene_keeps_trimmed_text_available_for_next_insert(store, monkeypatch):
    """分割: 前半に縮めた後も、縮める前の本文を次の判断のツール結果で参照できる。"""
    fake_extraction(monkeypatch)
    node_operations.update(store, "first", {"beat": "前半の出来事。\n\n後半の出来事。"})
    prompts = []
    async def model(messages, **kwargs):
        prompts.append(messages)
        if len(prompts) == 1:
            yield "done", call("update_scene", {"node_id": "first", "beat": "前半の出来事。", "reason": "前半に縮める"})
        elif len(prompts) == 2:
            latest = messages[-1]["content"]
            assert "後半の出来事。" in latest  # previous_beat が直近の取得結果に残る
            yield "done", call("insert_scene", {"after_id": "first", "title": "後半", "beat": "後半の出来事。",
                                                "cast": ["aya"], "reason": "残りを新しい場面にする"})
        else:
            yield "done", {"content": "分割しました"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = run(collect(store, True))
    changed = [e["changed"] for e in events if "changed" in e]
    assert [c["action"] for c in changed] == ["update_scene", "insert_scene"]
    assert all("previous_beat" not in c for c in changed)
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert all("previous_beat" not in m.get("operation", {}) for m in history)
    canon = store.canon_path()
    assert [store.get_node(n)["beat"] for n in canon] == ["前半の出来事。", "後半の出来事。", "村に戻る"]
    assert "分割するときは" in prompts[0][0]["content"]


def test_truncated_tool_arguments_are_reported_in_japanese(store, monkeypatch):
    before = store.graph()
    prompts = []
    async def model(messages, **kwargs):
        prompts.append(messages)
        if len(prompts) == 1:
            yield "done", {"content": "", "stats": {"finish_reason": "length"}, "tool_calls": [
                {"function": {"name": "update_scene", "arguments": '{"node_id": "first", "beat": "途中で切れ'}}]}
        else:
            yield "done", {"content": "終了"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = run(collect(store, True))
    error = next(e["tool_error"] for e in events if "tool_error" in e)
    assert "長さ上限で途切れました" in error
    assert "途切れました" in prompts[1][-1]["content"]
    assert store.graph() == before


@pytest.mark.parametrize("old", ["後半の出来事。\n", "\n後半の出来事。", r"\n後半の出来事。\n"])
def test_patch_replace_tolerates_surrounding_whitespace(store, monkeypatch, old):
    fake_extraction(monkeypatch)
    node_operations.update(store, "first", {"beat": "前半の出来事。\n\n後半の出来事。"})
    change = run(production.apply_edit(store, "fake", "patch_scene", {
        "node_id": "first", "mode": "replace", "old_text": old, "text": "", "reason": "後半を切り出す"}))
    assert change["scene"]["beat"].rstrip("\n") == "前半の出来事。"
    assert change["previous_beat"] == "前半の出来事。\n\n後半の出来事。"


@pytest.mark.parametrize("outcome", ["success", "reject", "stop", "consult"])
def test_streaming_preview_is_not_a_committed_edit(store, monkeypatch, outcome):
    fake_extraction(monkeypatch)
    original = store.get_node("first")["beat"]
    args = {"node_id": "first", "beat": "村を出る。空を見上げる。", "reason": "描写を追加"}
    function = {"name": "update_scene", "arguments": json.dumps(args, ensure_ascii=False)}
    calls = 0
    async def model(messages, **kwargs):
        nonlocal calls
        calls += 1
        if calls > 1:
            yield "done", {"content": "完了"}
            return
        assert kwargs["emit_tool_progress"] == (outcome != "consult")
        # モデルが引数を出し切る前のプレビュー。
        yield "tool_progress", {"index": 0, "function": {"name": "update_scene", "arguments": '{"node_id":"first","beat":"村を出る'}}
        yield "done", {"tool_calls": [{"id": "call", "function": function}]}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    if outcome == "reject":
        async def rejected(*args, **kwargs):
            raise ValueError("検証失敗")
        monkeypatch.setattr(production, "apply_edit", rejected)
    async def collect():
        previews = []
        stream = production.stream(store, "fake", None, "本文を更新", outcome != "consult", lambda: None)
        try:
            async for raw in stream:
                event = json.loads(raw.removeprefix("data: ").strip())
                if event.get("preview"):
                    assert store.get_node("first")["beat"] == original
                    previews.append(event["preview"])
                    if outcome == "stop":
                        break
        finally:
            await stream.aclose()
        return previews
    previews = run(collect())
    assert bool(previews) == (outcome != "consult")
    if previews:
        assert previews[0] == {"node_id": "first", "beat": "村を出る"}
    assert store.get_node("first")["beat"] == (args["beat"] if outcome == "success" else original)
    assert not production.gate.active


def test_preview_skips_protected_missing_and_other_tools(store):
    from production_preview import scene_preview
    policy = production.ProductionPolicy(store, protected_ids=["first"])
    for name, node_id in [("update_scene", "first"), ("update_scene", "missing"), ("patch_scene", "last")]:
        assert scene_preview(store, {"name": name, "arguments": json.dumps({"node_id": node_id, "beat": "未確定"})}, policy) is None


def test_preview_streams_beat_before_target_id(store):
    from production_preview import scene_preview
    policy = production.ProductionPolicy(store)
    first = scene_preview(store, {"name": "update_scene", "arguments": '{"beat":"村を出る'}, policy)
    assert first == {"node_id": None, "beat": "村を出る"}
    final = scene_preview(store, {"name": "update_scene", "arguments": '{"beat":"村を出る。","node_id":"first"}'}, policy)
    assert final == {"node_id": "first", "beat": "村を出る。"}
    protected = production.ProductionPolicy(store, protected_ids=["first"])
    assert scene_preview(store, {"name": "update_scene", "arguments": '{"beat":"村を出る'}, protected) == first
    assert scene_preview(store, {"name": "update_scene", "arguments": '{"beat":"村を出る。","node_id":"first"}'}, protected) is None
