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
    # 既定はオフ。終了時の見直しを含む経路を確かめるためオンにする
    s.set_settings({production_memory.KEY: "1"})
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
    prompts = fake_llm(monkeypatch, [read, read, read, read, {"content": "ここまでの情報では出発の本文を確認しました。"}])
    events = collect(store)
    assert done(events)["outcome"] == "stalled"
    # 4回目の同じ取得で止まり、5つ目の応答はツール無しの「まとめ」として使われる
    assert len(prompts) == 5
    assert "作業は停止しました" in json.dumps(prompts[4], ensure_ascii=False)
    # 2回目・3回目は結果と注意を返し(3回目は停止の予告つき)、4回目で停止理由を通知する
    assert "2回目" in json.dumps(prompts[2], ensure_ascii=False)
    assert "次に同じ取得をすると作業は停止します" in json.dumps(prompts[3], ensure_ascii=False)
    assert any("同じ情報の取得" in e.get("tool_error", "") for e in events)
    assert any("出発の本文を確認しました" in e.get("delta", "") for e in events)
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert history[-1].get("outcome") == "stalled"
    assert history[-2].get("closing") is True
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


def test_consult_mode_uses_the_same_repeat_rule_and_still_answers(store, monkeypatch):
    read = call("get_beats", {"node_ids": ["first"]})
    prompts = fake_llm(monkeypatch, [read, read, read, read, {"content": "案: 出発の末尾に約束の一文を足す。"}])
    events = collect(store, execute=False)
    assert done(events)["outcome"] == "stalled"
    assert done(events)["summary"] == guard.OUTCOME_LABELS["stalled"]
    assert len(prompts) == 5
    assert "変更案を具体的に示して" in json.dumps(prompts[4], ensure_ascii=False)
    assert any("約束の一文" in e.get("delta", "") for e in events)
    assert not any(e.get("changed") for e in events)


def test_consult_completion_has_no_summary(store, monkeypatch):
    fake_llm(monkeypatch, [{"content": "案です"}])
    events = collect(store, execute=False)
    assert done(events)["outcome"] == "completed" and done(events)["summary"] is None


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
    prompts = fake_llm(monkeypatch, [bad, bad, bad, {"content": "追記できませんでした。"}])
    events = collect(store)
    errors = [e["tool_error"] for e in events if e.get("tool_error")]
    assert len(errors) == 3
    assert "正しい形" not in errors[0] and "正しい形" in errors[1]
    assert "同じエラーが3回" in errors[2]
    assert done(events)["outcome"] == "stalled"
    assert done(events)["tool_errors"] == 3
    assert len(prompts) == 4  # 最後はツール無しのまとめ


def test_identical_errors_count_across_the_whole_run(store, monkeypatch):
    bad = call("patch_scene", {"node_id": "first", "mode": "append", "text": "", "reason": "追記"})
    other = call("patch_scene", {"node_id": "first", "mode": "replace", "old_text": "無い文", "text": "x", "reason": "置換"})
    ok = call("patch_scene", {"node_id": "first", "mode": "append", "text": "空を見上げる。", "reason": "追記"})
    # 別のエラーや成功を挟んでも、同じエラーが3回目で止まる
    fake_llm(monkeypatch, [bad, other, bad, ok, bad, {"content": "報告"}])
    events = collect(store)
    assert done(events)["outcome"] == "stalled"
    assert done(events)["tool_errors"] == 4
    assert store.get_node("first")["beat"] == "村を出る。空を見上げる。"


def test_second_edit_of_same_scene_adds_one_note(store, monkeypatch):
    first = call("patch_scene", {"node_id": "first", "mode": "append", "text": "一つ目。", "reason": "追記"})
    second = call("patch_scene", {"node_id": "first", "mode": "append", "text": "二つ目。", "reason": "追記"})
    third = call("patch_scene", {"node_id": "first", "mode": "append", "text": "三つ目。", "reason": "追記"})
    prompts = fake_llm(monkeypatch, [first, second, third, {"content": "完了"}])
    events = collect(store)
    assert done(events)["outcome"] == "completed" and done(events)["changes"] == 3
    texts = [json.dumps(p, ensure_ascii=False) for p in prompts]
    assert "2回編集しました" not in texts[1]
    assert "2回編集しました" in texts[2]
    assert "2回編集しました" not in texts[3]


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


# ---- 取りやめ判定の誤検出対策と相談の承認案内 --------------------------

def test_cancelled_ids_mentioned_in_latest_instruction_or_remaining_are_kept(store, monkeypatch):
    async def chat_json(messages, **kwargs):
        return {"cancelled_node_ids": ["first", "last"], "remaining": "帰還(last)に青い布の描写を足す"}
    monkeypatch.setattr(llm, "chat_json", chat_json)
    cancelled, remaining = asyncio.run(guard.reconcile_instructions(
        store, "fake", "出発と帰還を補強", ["赤いランタンはやめて、first には青い布を足して"], []))
    # first は最新指示に、last は残作業にIDが出るので、どちらも取りやめにしない
    assert cancelled == [] and "青い布" in remaining


def test_cancel_block_is_lifted_on_second_attempt(store, monkeypatch):
    async def chat_json(messages, **kwargs):
        return {"cancelled_node_ids": ["first"], "remaining": "帰還を直す"}
    monkeypatch.setattr(llm, "chat_json", chat_json)
    prompts = []
    async def model(messages, **kwargs):
        prompts.append(messages)
        if len(prompts) == 1:
            production.gate.run.submit("keep", "出発は残して")
            yield "done", call("get_beats", {"node_ids": ["first"]})
        elif len(prompts) in (2, 3):
            yield "done", call("patch_scene", {"node_id": "first", "mode": "append", "text": "x", "reason": "対象は出発"})
        else:
            yield "done", {"content": "完了"}
    monkeypatch.setattr(llm, "chat_stream_tools", model)
    events = collect(store)
    errors = [e["tool_error"] for e in events if e.get("tool_error")]
    assert len(errors) == 1 and "判定を解除します" in errors[0]
    assert any("取りやめ判定を解除しました" in e.get("stage", "") for e in events)
    assert store.get_node("first")["beat"] == "村を出る。x"
    assert done(events)["outcome"] == "completed"


@pytest.mark.parametrize("message, answer, expected", [
    ("この案で進めて", "私は相談役なので編集できません。ご自身で編集画面から追記してください。", True),
    ("この案で進めて", "案は未実施です。「制作を実行」に切り替えて「この案で進めて」と送ってください。", False),
    ("出発の本文はどんな内容ですか", "出発では村を出ます。", False),
    ("お願いします", "", True),
])
def test_consult_guidance_for(message, answer, expected):
    assert (guard.consult_guidance_for(message, answer) is not None) == expected


def test_consult_approval_without_guidance_gets_it_appended(store, monkeypatch):
    fake_llm(monkeypatch, [{"content": "私は相談役です。ご自身で編集してください。"}])
    events = collect(store, execute=False, message="この案で進めて")
    text = "".join(e.get("delta", "") for e in events)
    assert "制作を実行" in text
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert history[-1]["content"].startswith("私は相談役です。") and "制作を実行" in history[-1]["content"]
    assert done(events)["outcome"] == "completed"


def test_consult_question_does_not_get_guidance(store, monkeypatch):
    fake_llm(monkeypatch, [{"content": "出発では村を出ます。"}])
    events = collect(store, execute=False, message="出発の内容を教えて")
    assert "制作を実行" not in "".join(e.get("delta", "") for e in events)


def test_step_limit_gets_a_closing_report(store, monkeypatch):
    reads = [call("get_beats", {"node_ids": [nid]}) for nid in ["first", "last", "first"]]
    edits = [call("patch_scene", {"node_id": "first", "mode": "append", "text": f"{i}。", "reason": "追記"}) for i in range(20)]
    # 読み取りと書き込みを交互にして反復停止にかからないまま上限へ到達させる
    sequence = []
    for i in range(production.MAX_STEPS):
        sequence.append(edits[i] if i % 2 else call("get_beats", {"node_ids": ["first"]}))
    prompts = fake_llm(monkeypatch, sequence + [{"content": "上限までの報告"}])
    events = collect(store)
    assert done(events)["outcome"] == "limit"
    assert len(prompts) == production.MAX_STEPS + 1
    assert any("上限までの報告" in e.get("delta", "") for e in events)
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert history[-2].get("closing") and history[-1].get("outcome") == "limit"


def test_closing_text_that_is_a_tool_call_string_is_hidden(store, monkeypatch):
    read = call("get_beats", {"node_ids": ["first"]})
    fake_llm(monkeypatch, [read, read, read, read, {"content": '{"node_id": "last", "mode": "append", "text": "x"}<tool_call|>'}])
    events = collect(store)
    assert done(events)["outcome"] == "stalled"
    assert not any("<tool_call" in e.get("delta", "") for e in events)
    assert any("本文ではなかったため表示しません" in e.get("stage", "") for e in events)
    history = store.get_chat(events[0]["chat_id"])["messages"]
    assert not any(m.get("closing") for m in history)


@pytest.mark.parametrize("text, usable", [
    ("確定済みの変更は1件です。", True),
    ("", False),
    ('{"name": "patch_scene"}', False),
    ("本文です。<tool_call|>", False),
    ("出発を直しました。<|tool_call>", False),
])
def test_closing_text_is_usable(text, usable):
    assert guard.closing_text_is_usable(text) == usable


def test_protection_error_guidance_is_specific(store, monkeypatch):
    policy = production.ProductionPolicy(store, allowed_ids=["first"], protected_ids=["last"])
    blocked = call("patch_scene", {"node_id": "last", "mode": "append", "text": "x", "reason": "補強"})
    fake_llm(monkeypatch, [blocked, blocked, {"content": "帰還は保護のため変更していません。"}])
    async def go():
        return [json.loads(s.removeprefix("data: ")) async for s in production.stream(
            store, "fake", None, "補強して", True, lambda: None, policy=policy)]
    events = asyncio.run(go())
    errors = [e["tool_error"] for e in events if e.get("tool_error")]
    assert len(errors) == 2 and "依頼文や途中指示では解除できません" in errors[1] and "正しい形" not in errors[1]
    assert done(events)["outcome"] == "completed"


# ---- 同じ内容のシーンの重複追加 ------------------------------------------

SCENE = "旅の途中で、アヤはふとケンとの約束を思い出した。足を止め、村に残した彼の言葉が彼女の背中を押した。"


def test_duplicate_scene_detects_identical_and_near_identical(store):
    store.append_node({"id": "mid", "title": "約束の記憶", "beat": SCENE, "cast": ["aya"]})
    assert guard.duplicate_scene(store, SCENE) == ("mid", "約束の記憶")
    assert guard.duplicate_scene(store, SCENE.replace("ふと", "")) == ("mid", "約束の記憶")
    assert guard.duplicate_scene(store, "まったく別の場面。") is None
    assert guard.duplicate_scene(store, SCENE, exclude_id="mid") is None
    # 短い本文は完全一致だけ
    assert guard.duplicate_scene(store, "村を出る。") == ("first", "出発")
    assert guard.duplicate_scene(store, "村を出た。") is None


def test_second_insert_of_the_same_scene_is_rejected(store, monkeypatch):
    first = call("insert_scene", {"after_id": "first", "title": "約束の記憶", "beat": SCENE, "cast": ["aya"], "reason": "挿入"})
    prompts = fake_llm(monkeypatch, [first, {"content": "次"}])
    # 1回目の挿入後に、新しいIDの後ろへ同じ本文を挿入しようとする
    original = llm.chat_stream_tools
    state = {"inserted": None}
    async def wrapped(messages, **kwargs):
        if len(prompts) == 1 and state["inserted"] is None:
            state["inserted"] = next(n["id"] for n in store.graph()["nodes"] if n.get("title") == "約束の記憶")
            yield "done", call("insert_scene", {"after_id": state["inserted"], "title": "約束の記憶", "beat": SCENE, "cast": ["aya"], "reason": "再挿入"})
            return
        async for item in original(messages, **kwargs):
            yield item
    monkeypatch.setattr(llm, "chat_stream_tools", wrapped)
    events = collect(store)
    errors = [e["tool_error"] for e in events if e.get("tool_error")]
    assert len(errors) == 1 and "同じ内容のシーンが既にあります" in errors[0]
    assert sum(1 for n in store.graph()["nodes"] if n.get("title") == "約束の記憶") == 1
    assert done(events)["outcome"] == "completed" and done(events)["changes"] == 1
