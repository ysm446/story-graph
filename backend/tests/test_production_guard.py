"""制作ハーネスの決定的な制御: 反復の停止、空応答・途切れた報告の区別、全文置換の保持、取り消し対象の拒否。"""

import asyncio
import json

import pytest

import db
import embed
import generation
import llm
import production_guard as guard
import production_memory
import production_agent as production
from store import Store


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    reviews = []
    async def memory_review(store, *args, **kwargs):
        reviews.append(True)
        note = production_memory.read(store)
        return {"content": note["content"], "reason": "照合済み"}, note["revision"], production_memory.basis(store)
    monkeypatch.setattr(production_memory, "review", memory_review)
    async def continuity_ok(*args):
        pass
    monkeypatch.setattr(production.production_continuity, "check", continuity_ok)
    async def extract(candidate, base_url, node_id):
        return candidate.replace_events(node_id, [])
    monkeypatch.setattr(generation, "extract_events", extract)
    root = tmp_path / "library"
    root.mkdir()
    s = Store(db.connect(root / "story-graph.db"), root=str(root))
    s.create_character({"id": "aya", "name": "アヤ"})
    s.append_node({"id": "first", "title": "出発", "beat": "村を出る。", "cast": ["aya"]})
    s.append_node({"id": "last", "title": "帰還", "beat": "村に戻る。", "cast": ["aya"]})
    s.reviews = reviews
    yield s
    s.conn.close()


def call(name, args, **extra):
    return {"content": "", "tool_calls": [{"function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}], **extra}


def fake_llm(monkeypatch, responses):
    it = iter(responses)
    prompts = []
    async def stream(messages, **kwargs):
        prompts.append(messages)
        item = next(it)
        if item.get("content"):
            yield "content", item["content"]
        yield "done", item
    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    return prompts


def collect(store, execute=True, message="動機を補強して"):
    async def go():
        return [json.loads(s.removeprefix("data: ")) async for s in production.stream(
            store, "fake", None, message, execute, lambda: None)]
    return asyncio.run(go())


def done(events):
    return next(e for e in events if e.get("done"))


# ---- 反復の停止 ------------------------------------------------------

def test_repeated_read_returns_cached_result_then_stops(store, monkeypatch):
    read = call("get_beats", {"node_ids": ["first"]})
    prompts = fake_llm(monkeypatch, [read, read, read, {"content": "終了"}])
    events = collect(store)
    assert done(events)["outcome"] == "stalled"
    assert len(prompts) == 3  # 3回目の同じ取得で止まり、4つ目の応答は使われない
    # 2回目は結果と注意を返し、3回目で停止理由を通知する
    assert "2回目" in json.dumps(prompts[2], ensure_ascii=False)
    assert any("同じ情報の取得" in e.get("tool_error", "") for e in events)
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert history[-1].get("outcome") == "stalled"
    assert "確定済みの変更 0 件" in history[-1]["content"]
    assert production_memory.read(store)["checkpoint"]["status"] == "stalled"
    assert not store.reviews, "停止時は作業メモの見直しをしない"


def test_reads_after_a_commit_are_not_counted_as_repeats(store, monkeypatch):
    read = call("get_beats", {"node_ids": ["first"]})
    edit = call("patch_scene", {"node_id": "first", "mode": "append", "text": "空を見上げる。", "reason": "追記"})
    fake_llm(monkeypatch, [read, edit, read, {"content": "完了"}])
    events = collect(store)
    assert done(events)["outcome"] == "completed"
    assert store.get_node("first")["beat"] == "村を出る。空を見上げる。"
    assert not any("同じ情報の取得" in e.get("tool_error", "") for e in events)


def test_consult_mode_keeps_its_own_repeat_rule(store, monkeypatch):
    read = call("get_beats", {"node_ids": ["first"]})
    fake_llm(monkeypatch, [read, read])
    events = collect(store, execute=False)
    assert done(events)["outcome"] == "completed"
    assert done(events)["summary"] is None
    assert any("いったん停止" in e.get("delta", "") for e in events)


def test_applied_operation_is_returned_as_saved_then_stops(store, monkeypatch):
    edit = call("patch_scene", {"node_id": "first", "mode": "append", "text": "空を見上げる。", "reason": "追記"})
    prompts = fake_llm(monkeypatch, [edit, edit, edit, {"content": "終了"}])
    events = collect(store)
    assert store.get_node("first")["beat"] == "村を出る。空を見上げる。"
    assert sum(1 for e in events if e.get("changed")) == 1
    # 2回目はエラーではなく保存済みの結果を返す
    second = json.dumps(prompts[2], ensure_ascii=False)
    assert "already_applied" in second and "再実行していません" in second
    assert any(e.get("stage") == "適用済みの変更の再実行を省きました" for e in events)
    assert done(events)["outcome"] == "stalled"
    assert done(events)["changes"] == 1


def test_same_error_gets_guidance_then_stops(store, monkeypatch):
    bad = call("patch_scene", {"node_id": "first", "mode": "append", "text": "", "reason": "追記"})
    prompts = fake_llm(monkeypatch, [bad, bad, bad, {"content": "終了"}])
    events = collect(store)
    errors = [e["tool_error"] for e in events if e.get("tool_error")]
    assert len(errors) == 3
    assert "正しい形" not in errors[0] and "正しい形" in errors[1]
    assert "同じエラーが3回" in errors[2]
    assert done(events)["outcome"] == "stalled"
    assert done(events)["tool_errors"] == 3
    assert len(prompts) == 3


def test_different_errors_do_not_stop_and_success_resets(store, monkeypatch):
    bad = call("patch_scene", {"node_id": "first", "mode": "append", "text": "", "reason": "追記"})
    other = call("patch_scene", {"node_id": "first", "mode": "replace", "old_text": "無い文", "text": "x", "reason": "置換"})
    ok = call("patch_scene", {"node_id": "first", "mode": "append", "text": "空を見上げる。", "reason": "追記"})
    fake_llm(monkeypatch, [bad, other, bad, ok, bad, {"content": "完了"}])
    events = collect(store)
    assert done(events)["outcome"] == "completed"
    assert done(events)["tool_errors"] == 4


# ---- 空応答・途切れた報告 --------------------------------------------

def test_empty_response_is_retried_once_then_recorded_as_empty(store, monkeypatch):
    prompts = fake_llm(monkeypatch, [{"content": ""}, {"content": ""}, {"content": "後から"}])
    events = collect(store)
    assert len(prompts) == 2
    assert "応答は空でした" in json.dumps(prompts[1], ensure_ascii=False)
    assert "応答は空でした" not in json.dumps(prompts[0], ensure_ascii=False)
    assert done(events)["outcome"] == "empty"
    assert "空のまま終了" in done(events)["summary"]
    assert production_memory.read(store)["checkpoint"]["status"] == "empty"
    assert not store.reviews


def test_empty_then_completion_is_normal(store, monkeypatch):
    fake_llm(monkeypatch, [{"content": ""}, {"content": "依頼は反映済みです。"}])
    events = collect(store)
    assert done(events)["outcome"] == "completed"
    assert store.reviews


def test_truncated_report_is_not_recorded_as_completed(store, monkeypatch):
    fake_llm(monkeypatch, [{"content": "報告の途中で", "stats": {"finish_reason": "length"}}])
    events = collect(store)
    assert done(events)["outcome"] == "truncated"
    assert production_memory.read(store)["checkpoint"]["status"] == "truncated"
    assert not store.reviews
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert "途切れました" in history[-1]["content"]


def test_consult_mode_ignores_empty_and_truncation_rules(store, monkeypatch):
    fake_llm(monkeypatch, [{"content": ""}])
    events = collect(store, execute=False)
    assert done(events)["outcome"] == "completed"


def test_step_limit_reports_counts(store, monkeypatch):
    reads = [call("get_beats", {"node_ids": [nid]}) for nid in ["first", "last"] * 8]
    fake_llm(monkeypatch, reads[:production.MAX_STEPS] + [{"content": "x"}])
    # 2件を交互に読むと同じ取得は2回ずつで止まらず、上限で終わる
    events = collect(store)
    assert done(events)["outcome"] in ("limit", "stalled")


# ---- 全文置換での内容の保持 -------------------------------------------

LONG = ("朝の光が差し込む。アヤは地図を広げた。ケンが扉を叩く。二人は水門の話をした。雨は止まない。出発の支度を終えた。"
        "ミオが薬箱を抱えて現れる。レンは黙って図面を指さした。三人は夜明けを待った。")  # 80文字以上(保護の対象)


def test_retention_measures_kept_sentences():
    assert guard.retention(LONG, LONG) == 1.0
    assert guard.retention(LONG, LONG + "新しい一文。") == 1.0
    assert guard.retention(LONG, "朝の光が差し込む。アヤは地図を広げた。") == pytest.approx(2 / 9)
    assert guard.retention("", "何でも") == 1.0


@pytest.mark.parametrize("new, rewrite, ok", [
    (LONG + "約束を思い出す。", False, True),                       # 追記
    (LONG.replace("地図", "古い図面"), False, True),                 # 語句の訂正
    ("朝の光が差し込む。アヤは地図を広げた。ケンが扉を叩く。", False, True),  # 前半へ縮める(分割)
    ("まったく別の朝。誰も来ない。静かな部屋で待つ。", False, False),  # 大半を失う置換
    ("まったく別の朝。誰も来ない。静かな部屋で待つ。", True, True),    # 明示の書き直し
])
def test_check_rewrite(new, rewrite, ok):
    if ok:
        guard.check_rewrite(LONG, new, rewrite)
    else:
        with pytest.raises(ValueError, match="rewrite: true"):
            guard.check_rewrite(LONG, new, rewrite)


def test_short_originals_are_not_guarded():
    guard.check_rewrite("短い。", "全部違う。", False)


def test_update_scene_rewrite_guard_in_stream(store, monkeypatch):
    store.update_node("first", {"beat": LONG})
    lost = "まったく別の朝。誰も来ない。静かな部屋で待つ。"
    fake_llm(monkeypatch, [
        call("update_scene", {"node_id": "first", "beat": lost, "reason": "書き直し"}),
        call("update_scene", {"node_id": "first", "beat": lost, "rewrite": True, "reason": "書き直し"}),
        {"content": "完了"}])
    events = collect(store)
    errors = [e["tool_error"] for e in events if e.get("tool_error")]
    assert len(errors) == 1 and "%しか残りません" in errors[0]
    assert store.get_node("first")["beat"] == lost
    assert done(events)["outcome"] == "completed"


def test_invalid_rewrite_flag_is_rejected(store, monkeypatch):
    fake_llm(monkeypatch, [call("update_scene", {"node_id": "first", "beat": "別", "rewrite": "yes", "reason": "x"}), {"content": "終了"}])
    events = collect(store)
    assert any("rewriteはtrue/false" in e.get("tool_error", "") for e in events)
    assert store.get_node("first")["beat"] == "村を出る。"


def test_patch_is_not_subject_to_rewrite_guard(store, monkeypatch):
    store.update_node("first", {"beat": LONG})
    fake_llm(monkeypatch, [call("patch_scene", {"node_id": "first", "mode": "replace",
        "old_text": LONG, "text": "一文だけ。", "reason": "整理"}), {"content": "完了"}])
    events = collect(store)
    assert store.get_node("first")["beat"] == "一文だけ。"
    assert not any(e.get("tool_error") for e in events)


# ---- 途中指示で取り消された対象 ---------------------------------------

def test_cancelled_target_from_instruction_is_rejected(store, monkeypatch):
    reconciled = []
    async def chat_json(messages, **kwargs):
        reconciled.append(messages)
        return {"cancelled_node_ids": ["first", "unknown"], "remaining": "帰還だけに約束の描写を足す"}
    monkeypatch.setattr(llm, "chat_json", chat_json)
    prompts = []
    async def model(messages, **kwargs):
        prompts.append(messages)
        if len(prompts) == 1:
            production.gate.run.submit("keep", "出発は変更せず残してください。帰還だけ直してください")
            yield "done", call("get_beats", {"node_ids": ["first"]})
        elif len(prompts) == 2:
            yield "done", call("patch_scene", {"node_id": "first", "mode": "append", "text": "x", "reason": "旧依頼"})
        elif len(prompts) == 3:
            yield "done", call("patch_scene", {"node_id": "last", "mode": "append", "text": "約束を守って戻った。", "reason": "最新指示"})
        else:
            yield "done", {"content": "完了"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = collect(store)
    assert len(reconciled) == 1
    payload = json.loads(reconciled[0][1]["content"])
    assert payload["途中指示(古い順)"] and payload["シーン一覧"]
    assert store.get_node("first")["beat"] == "村を出る。"
    assert store.get_node("last")["beat"] == "村に戻る。約束を守って戻った。"
    assert any("取りやめになった対象" in e.get("tool_error", "") for e in events)
    assert any("途中指示を照合しました" in e.get("delta", "") for e in events)
    # 照合結果は以後の判断に渡る(存在しないIDは無視)
    system = prompts[2][0]["content"]
    assert "取りやめになった対象" in system and "unknown" not in system and "残作業" in system
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert any(m.get("instruction_review") for m in history)
    assert done(events)["outcome"] == "completed"


def test_reconciliation_failure_does_not_block_edits(store, monkeypatch):
    async def chat_json(messages, **kwargs):
        raise RuntimeError("照合サーバーなし")
    monkeypatch.setattr(llm, "chat_json", chat_json)
    prompts = []
    async def model(messages, **kwargs):
        prompts.append(messages)
        if len(prompts) == 1:
            production.gate.run.submit("keep", "帰還も直して")
            yield "done", call("get_beats", {"node_ids": ["first"]})
        elif len(prompts) == 2:
            yield "done", call("patch_scene", {"node_id": "first", "mode": "append", "text": "x", "reason": "続行"})
        else:
            yield "done", {"content": "完了"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = collect(store)
    assert store.get_node("first")["beat"] == "村を出る。x"
    assert not any("途中指示を照合しました" in e.get("delta", "") for e in events)


def test_consult_mode_does_not_reconcile(store, monkeypatch):
    calls = []
    async def chat_json(messages, **kwargs):
        calls.append(messages)
        return {"cancelled_node_ids": [], "remaining": ""}
    monkeypatch.setattr(llm, "chat_json", chat_json)
    fake_llm(monkeypatch, [{"content": "案です"}])
    collect(store, execute=False)
    assert not calls


# ---- 完了前の点検 -----------------------------------------------------

def test_unused_created_entity_gets_one_nudge(store, monkeypatch):
    prompts = fake_llm(monkeypatch, [
        call("create_place", {"name": "小屋", "place_description": "川沿いの小屋", "reason": "登録"}),
        {"content": "登録しました。"},
        {"content": "シーンへの指定は依頼にないので、このまま終了します。"}])
    events = collect(store)
    assert len(prompts) == 3
    note = json.dumps(prompts[2], ensure_ascii=False)
    assert "どのシーンにも使われていません" in note and "小屋" in note
    assert "どのシーンにも使われていません" not in json.dumps(prompts[1], ensure_ascii=False)
    assert done(events)["outcome"] == "completed"
    assert any(e.get("stage") == "保存結果と依頼を照合しています…" for e in events)


def test_used_created_entity_is_not_flagged(store, monkeypatch):
    prompts = fake_llm(monkeypatch, [
        call("create_character", {"name": "レン", "reason": "登録"}),
        {"content": "cast に入れます"},
    ])
    # 2つ目の応答の前にキャラが使われていれば注記は出ない: モデルの代わりに直接 cast へ入れる
    original = llm.chat_stream_tools
    async def wrapped(messages, **kwargs):
        if len(prompts) == 1:
            ren = next(c["id"] for c in store.list_characters() if c["name"] == "レン")
            store.update_node("first", {"cast": ["aya", ren]})
        async for item in original(messages, **kwargs):
            yield item
    monkeypatch.setattr(llm, "chat_stream_tools", wrapped)
    events = collect(store)
    assert len(prompts) == 2
    assert done(events)["outcome"] == "completed"


def test_completion_issues_lists_unused_entities(store):
    place = store.create_place({"name": "塔", "color": "#123456"})
    issues = guard.completion_issues(store, [{"action": "create_place", "entity_type": "place", "entity_id": place["id"], "title": "塔"}],
                                     production.production_library.references)
    assert [key for key, _ in issues] == [f"unused:{place['id']}"]
    store.update_node("first", {"location": place["id"]})
    assert guard.completion_issues(store, [{"action": "create_place", "entity_type": "place", "entity_id": place["id"], "title": "塔"}],
                                   production.production_library.references) == []


def test_done_event_carries_summary_and_tool_call_events(store, monkeypatch):
    fake_llm(monkeypatch, [call("get_beats", {"node_ids": ["first"]}),
                           call("patch_scene", {"node_id": "first", "mode": "append", "text": "x", "reason": "追記"}),
                           {"content": "完了"}])
    events = collect(store)
    final = done(events)
    assert final["outcome"] == "completed" and final["changes"] == 1 and final["steps"] == 3
    assert final["summary"].startswith("完了しました（変更 1 件")
    calls = [e["tool_call"] for e in events if e.get("tool_call")]
    assert calls == [{"name": "get_beats", "target": None}, {"name": "patch_scene", "target": "first"}]
