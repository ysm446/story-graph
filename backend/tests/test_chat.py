import asyncio
import json

import pytest

import chat_agent
import db
import embed
import llm as llm_mod
from store import Store


STATE_MEMORY_SAMPLE = 20  # 記憶の絞り込みを確かめるために足す件数(上限より多くする)


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.create_character({"name": "ケン", "id": "ken"})
    s.append_node({"beat": "出会い", "cast": ["aya", "ken"], "title": "第一話"}, [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        {"type": "char_introduce", "payload": {"char": "ken"}},
        {"type": "memory_add", "payload": {"char": "aya", "content": "石橋でケンの裏切りを知った", "importance": 0.9}},
    ])
    s.append_node({"beat": "対峙", "cast": ["aya", "ken"], "title": "第二話"})
    s.append_node({"beat": "決着", "cast": ["aya", "ken"], "title": "第三話"})
    return s


def collect_sse(agen):
    async def run():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in agen]

    return asyncio.run(run())


def _tool_call(name, args, call_id="tc1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def _fake_stream(results):
    """chat_stream_tools のモック。呼び出しごとに results を順に消費し、
    content をデルタとして流してから done を返す async generator を作る。"""
    calls = {"n": 0}

    def fake(messages, **kwargs):
        result = results[min(calls["n"], len(results) - 1)]
        calls["n"] += 1

        async def gen():
            if result.get("content"):
                yield ("content", result["content"])
            yield ("done", result)

        return gen()

    return fake


def test_scope_upto_limits_beats(store):
    anchor = store.canon_path()[1]  # 第二話まで
    path = chat_agent._visible_path(store, anchor, "upto")
    result = chat_agent._tool_get_beats(store, path, {})
    assert result["total"] == 2
    assert [b["title"] for b in result["beats"]] == ["第一話", "第二話"]
    # all なら全件
    all_path = chat_agent._visible_path(store, anchor, "all")
    assert chat_agent._tool_get_beats(store, all_path, {})["total"] == 3


def test_get_state_resolves_names_and_memory_contents(store):
    """state の ID(キャラ / 記憶)を名前と本文に解決してから返す。"""
    result = chat_agent._tool_get_state(store, store.canon_path(), {})
    aya = result["chars"]["aya"]
    assert aya["name"] == "アヤ"
    assert aya["memories"]["total"] == 1
    assert [m["content"] for m in aya["memories"]["recent"]] == ["石橋でケンの裏切りを知った"]
    # char_id 指定でも同じ形(記憶は絞らない)
    single = chat_agent._tool_get_state(store, store.canon_path(), {"char_id": "aya"})
    assert single["char"] == "aya"
    assert single["state"]["memories"]["recent"][0]["content"] == "石橋でケンの裏切りを知った"


def test_get_state_relationship_target_has_name_and_no_event_ids(store):
    store.append_node({"beat": "和解", "cast": ["aya", "ken"], "title": "第四話"}, [
        {"type": "relationship_update",
         "payload": {"char": "aya", "target": "ken", "delta": 0.5, "label": "許した"}},
    ])
    rel = chat_agent._tool_get_state(store, store.canon_path(), {})["chars"]["aya"]["relationships"]["ken"]
    assert rel["name"] == "ケン"
    assert rel["label"] == "許した"
    assert rel["updates"] == 1
    assert "reasons" not in rel  # event_id は LLM から引けないので載せない


def test_get_state_overview_limits_memories_per_char(store):
    for i in range(STATE_MEMORY_SAMPLE):
        store.append_node({"beat": f"追加{i}", "cast": ["aya"], "title": f"追加{i}"}, [
            {"type": "memory_add", "payload": {"char": "aya", "content": f"出来事{i}", "importance": 0.1}},
        ])
    aya = chat_agent._tool_get_state(store, store.canon_path(), {})["chars"]["aya"]["memories"]
    shown = len(aya.get("important") or []) + len(aya["recent"])
    assert shown <= chat_agent.STATE_OVERVIEW_MEMORIES * 2
    assert aya["total"] == STATE_MEMORY_SAMPLE + 1
    assert aya["omitted"] == aya["total"] - shown
    # char_id 指定なら絞らない(キャラモードと同じ上限まで載る)
    full = chat_agent._tool_get_state(store, store.canon_path(), {"char_id": "aya"})["state"]["memories"]
    assert len(full.get("important") or []) + len(full["recent"]) == chat_agent.CHARACTER_MEMORY_LIMIT


def test_tool_loop_and_persistence(store, monkeypatch):
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([
            {
                "content": "",
                "tool_calls": [_tool_call("get_beats", {"from_index": 1, "to_index": 2})],
                "message": {"role": "assistant", "content": None,
                            "tool_calls": [_tool_call("get_beats", {"from_index": 1, "to_index": 2})]},
            },
            {"content": "第二話まで確認しました。", "tool_calls": None,
             "message": {"role": "assistant", "content": "第二話まで確認しました。"}},
        ]),
    )
    anchor = store.canon_path()[1]
    events = collect_sse(chat_agent.chat_stream(store, "http://fake", None, anchor, "upto", "状況を教えて"))
    assert any("tool_call" in e for e in events)
    # 回答はデルタとしてもストリームされる
    assert "".join(e["delta"] for e in events if "delta" in e) == "第二話まで確認しました。"
    final = events[-1]
    assert final["answer"] == "第二話まで確認しました。"
    # 永続化: 履歴に user / assistant(tool_calls) / tool / assistant が残る
    chat = store.get_chat(final["chat_id"])
    roles = [m["role"] for m in chat["messages"]]
    assert roles == ["user", "assistant", "tool", "assistant"]
    assert chat["anchor_node"] == anchor
    assert chat["scope"] == "upto"


def test_prompt_messages_saved_but_not_sent(store, monkeypatch):
    # 返事には生成時に LLM へ送った内容(system + 履歴)の控えを保存する(UI の閲覧用)。
    # ただし次ターン以降の LLM 送信メッセージには混ぜない
    sent = []

    def capture(messages, **kwargs):
        sent.append([dict(m) for m in messages])

        async def gen():
            yield ("content", "回答")
            yield ("done", {"content": "回答", "tool_calls": None,
                            "message": {"role": "assistant", "content": "回答"}})

        return gen()

    monkeypatch.setattr(llm_mod, "chat_stream_tools", capture)
    anchor = store.canon_path()[1]
    events = collect_sse(chat_agent.chat_stream(store, "http://fake", None, anchor, "upto", "1回目"))
    chat_id = events[-1]["chat_id"]
    saved = store.get_chat(chat_id)["messages"]
    assert saved[-1]["role"] == "assistant"
    # 控えは実際の送信内容と一致する(system が先頭、その後にそれまでの履歴)
    assert saved[-1]["prompt_messages"] == sent[-1]
    assert saved[-1]["prompt_messages"][0]["role"] == "system"
    collect_sse(chat_agent.chat_stream(store, "http://fake", chat_id, None, "upto", "2回目"))
    assert sent[-1][0]["role"] == "system"
    # 控え(と旧形式の system_prompt)は送信から除外され、入れ子にもならない
    assert all("prompt_messages" not in m and "system_prompt" not in m for m in sent[-1])
    saved = store.get_chat(chat_id)["messages"]
    assert all("prompt_messages" not in m for m in saved[-1]["prompt_messages"])


def test_proposals_are_plain_text(store, monkeypatch):
    answer = "決裂: アヤはケンを追放する。\n和解: アヤはケンを赦す。"
    sent_tools = []

    async def respond(messages, **kwargs):
        sent_tools.extend(kwargs["tools"])
        yield ("content", answer)
        yield ("done", {"content": answer, "tool_calls": None,
                        "message": {"role": "assistant", "content": answer}})

    monkeypatch.setattr(llm_mod, "chat_stream_tools", respond)
    before = store.canon_path()
    events = collect_sse(chat_agent.chat_stream(store, "http://fake", None, None, "upto", "この先を2案提案して"))
    assert {tool["function"]["name"] for tool in sent_tools} == {"get_beats", "get_state", "search_memories"}
    assert "".join(e.get("delta", "") for e in events) == answer
    assert not any("proposals" in e for e in events)
    saved = store.get_chat(events[-1]["chat_id"])["messages"]
    assert saved[-1]["content"] == answer
    assert store.canon_path() == before


def test_search_memories_tool_scope(store):
    path = chat_agent._visible_path(store, store.canon_path()[-1], "upto")
    result = chat_agent._tool_search_memories(store, path, "upto", {"query": "裏切り"})
    assert any("裏切り" in m["content"] for m in result["memories"])


def test_force_draft_insertion(store):
    tail = store.canon_path()[-1]
    node = store.append_node(
        {"beat": "提案から挿入", "cast": ["aya"], "title": "if 案"},
        parent_id=tail, force_draft=True,
    )
    assert node["status"] == "draft"
    # 正史は変わらない
    assert store.canon_path()[-1] == tail


def test_usage_text_includes_system_tools_and_history(store):
    path = store.canon_path()
    chat = store.create_chat(path[-1], "upto")
    tc = _tool_call("get_state", {})
    store.save_chat_messages(
        chat["id"],
        [
            {"role": "user", "content": "アヤの状態は?"},
            {"role": "assistant", "content": None, "tool_calls": [tc]},
            {"role": "tool", "tool_call_id": "tc1", "content": '{"chars": {}}'},
            {"role": "assistant", "content": "落ち着いています。"},
        ],
    )
    text = chat_agent._usage_text(store, store.get_chat(chat["id"]), path, "upto")
    assert "あなたは物語作りの相談相手です" in text  # システムプロンプト
    assert "search_memories" in text  # ツール定義
    assert "アヤの状態は?" in text  # ユーザー発言
    assert "get_state({})" in text  # tool_calls
    assert "落ち着いています。" in text  # 回答


def test_token_usage_falls_back_to_estimate_when_server_down(store, monkeypatch):
    async def unavailable(text, *, base_url, timeout=10.0):
        return None

    monkeypatch.setattr(llm_mod, "count_tokens", unavailable)
    usage = asyncio.run(chat_agent.token_usage(store, "http://fake", None, store.canon_path()[-1], "upto"))
    assert usage["estimated"] is True
    assert usage["token_count"] > 0


def test_token_usage_uses_tokenizer_when_available(store, monkeypatch):
    async def counted(text, *, base_url, timeout=10.0):
        return 1234

    monkeypatch.setattr(llm_mod, "count_tokens", counted)
    usage = asyncio.run(chat_agent.token_usage(store, "http://fake", None, store.canon_path()[-1], "upto"))
    assert usage == {"token_count": 1234, "estimated": False}


# ---- キャラクターと話す(キャラモード) --------------------------------

def test_character_system_prompt_contents(store):
    # 関係と facts を積んでからアンカー時点のプロンプトを確認する
    path = store.canon_path()
    store.replace_events(path[0], store.list_events(path[0]) + [
        {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": -0.5, "reason": "裏切り", "label": "疑念"}},
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "location", "value": "石橋の町"}},
    ])
    text = chat_agent.build_character_system(store, path, "aya", "interview")
    assert "あなたは「アヤ」という人物です" in text
    assert "location: 石橋の町" in text
    assert "ケン" in text and "疑念" in text  # 相手は ID でなく名前で
    assert "石橋でケンの裏切りを知った" in text  # 記憶
    assert "インタビュー" in text  # interview 枠組み
    assert "get_beats" not in text  # シーン一覧は渡さない


def test_character_system_prompt_roleplay_frame(store):
    path = store.canon_path()
    text = chat_agent.build_character_system(store, path, "aya", "roleplay")
    assert "見知らぬ相手" in text
    assert "インタビュー" not in text


def test_character_system_prompt_keeps_recent_memories(store):
    """重要度の低い直近の記憶が、重要度上位に押し出されて消えないこと。

    章のまとめ(digest)のような importance 高めの記憶が溜まると、重要度だけの
    選抜では「少し前の出来事」が本文から落ちて本人が覚えていないことになる。
    """
    path = store.canon_path()
    # 第一話に重要度の高い記憶を大量に積む(15 件枠を埋め尽くす役)
    store.replace_events(path[0], store.list_events(path[0]) + [
        {"type": "memory_add", "payload": {"char": "aya", "content": f"重大な出来事{i}", "importance": 0.9}}
        for i in range(20)
    ])
    # 最新シーンに、重要度は低いが直近の記憶
    store.replace_events(path[-1], store.list_events(path[-1]) + [
        {"type": "memory_add", "payload": {"char": "aya", "content": "昨日ケンと橋で立ち話をした", "importance": 0.2}},
    ])
    text = chat_agent.build_character_system(store, path, "aya", "interview")
    assert "昨日ケンと橋で立ち話をした" in text
    assert "## 最近の出来事" in text
    assert "## 強く残っている記憶" in text
    # 本文に載るのは合計 15 件まで(節見出しと補足行は数えない)
    prefixes = ("- 重大な出来事", "- 昨日", "- 石橋")
    shown = [ln for ln in text.splitlines() if ln.startswith(prefixes)]
    assert len(shown) == chat_agent.CHARACTER_MEMORY_LIMIT
    assert "件ある" in text  # 残りは recall で、の案内


def test_character_system_prompt_single_section_when_all_fit(store):
    """記憶が枠に収まるときは 1 節のまま(節を分けない)。"""
    text = chat_agent.build_character_system(store, store.canon_path(), "aya", "interview")
    assert "## あなたの記憶" in text
    assert "## 最近の出来事" not in text
    assert "件ある" not in text


def test_character_system_prompt_tells_to_recall_first(store):
    """「無ければ知らないと答える」だけだと recall を呼ばずに打ち切る。"""
    text = chat_agent.build_character_system(store, store.canon_path(), "aya", "interview")
    assert "まず recall で思い出そうとする" in text


def test_character_chat_uses_recall_and_saves_char(store, monkeypatch):
    tc = _tool_call("recall", {"query": "裏切り"})
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([
            {"content": "", "tool_calls": [tc],
             "message": {"role": "assistant", "content": None, "tool_calls": [tc]}},
            {"content": "…あの日のことは忘れない。", "tool_calls": None,
             "message": {"role": "assistant", "content": "…あの日のことは忘れない。"}},
        ]),
    )
    events = collect_sse(
        chat_agent.chat_stream(store, "http://fake", None, store.canon_path()[-1], "upto",
                               "彼のことをどう思ってる?", char_id="aya", mode="interview")
    )
    chat_id = next(e["chat_id"] for e in events if "chat_id" in e)
    saved = store.get_chat(chat_id)
    assert saved["char_id"] == "aya"
    assert saved["mode"] == "interview"
    assert saved["scope"] == "upto"
    # recall の結果(tool メッセージ)に該当記憶が入っている
    tool_msg = next(m for m in saved["messages"] if m.get("role") == "tool")
    assert "裏切り" in tool_msg["content"]
    assert any(e.get("answer") for e in events)


def test_character_chat_rejects_other_tools(store, monkeypatch):
    tc = _tool_call("get_beats", {})
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([
            {"content": "", "tool_calls": [tc],
             "message": {"role": "assistant", "content": None, "tool_calls": [tc]}},
            {"content": "分からない。", "tool_calls": None,
             "message": {"role": "assistant", "content": "分からない。"}},
        ]),
    )
    events = collect_sse(
        chat_agent.chat_stream(store, "http://fake", None, store.canon_path()[-1], "upto",
                               "全シーンを教えて", char_id="aya", mode="interview")
    )
    assert any(e.get("tool_result", {}).get("is_error") for e in events if "tool_result" in e)


def test_token_usage_character_mode(store, monkeypatch):
    async def counted(text, *, base_url, timeout=10.0):
        # キャラモードのシステムが数える対象に入っていること
        assert "あなたは「アヤ」という人物です" in text
        assert "recall" in text
        return 500

    monkeypatch.setattr(llm_mod, "count_tokens", counted)
    usage = asyncio.run(chat_agent.token_usage(
        store, "http://fake", None, store.canon_path()[-1], "upto", char_id="aya"
    ))
    assert usage == {"token_count": 500, "estimated": False}


def test_set_chat_title_and_list(store):
    chat = store.create_chat(store.canon_path()[-1], "upto")
    store.save_chat_messages(chat["id"], [{"role": "user", "content": "冒頭の質問"}])
    assert store.get_chat(chat["id"])["title"] is None
    store.set_chat_title(chat["id"], "  裏切りの相談  ")
    assert store.get_chat(chat["id"])["title"] == "裏切りの相談"
    row = next(h for h in store.list_chats() if h["id"] == chat["id"])
    assert row["title"] == "裏切りの相談"
    assert row["snippet"] == "冒頭の質問"  # 見出しが無いときのフォールバック用に残る
    store.set_chat_title(chat["id"], "   ")  # 空にすると NULL に戻る
    assert store.get_chat(chat["id"])["title"] is None


def test_list_chats_backfills_legacy_snippet(store):
    """snippet 列の無かった頃のデータは、一覧を開いたとき一度だけ埋める
    (以後は messages をパースしない)。"""
    chat = store.create_chat(store.canon_path()[-1], "upto")
    store.save_chat_messages(chat["id"], [{"role": "user", "content": "昔の質問"}])
    # 旧データを再現(保存時の snippet を消す)
    store.conn.execute("UPDATE chats SET snippet = NULL WHERE id = ?", (chat["id"],))
    store.conn.commit()
    row = next(h for h in store.list_chats() if h["id"] == chat["id"])
    assert row["snippet"] == "昔の質問"
    # 埋め戻されている(次回からパース不要)
    stored = store.conn.execute(
        "SELECT snippet FROM chats WHERE id = ?", (chat["id"],)
    ).fetchone()
    assert stored["snippet"] == "昔の質問"


# ---- メッセージ操作(編集 / 再生成 / 削除) ----------------------------

def _two_turn_chat(store):
    """user / assistant(tool_calls) / tool / assistant / user / assistant の履歴"""
    chat = store.create_chat(store.canon_path()[-1], "upto")
    tc = _tool_call("get_state", {})
    store.save_chat_messages(chat["id"], [
        {"role": "user", "content": "1回目の質問"},
        {"role": "assistant", "content": None, "tool_calls": [tc]},
        {"role": "tool", "tool_call_id": "tc1", "content": "{}"},
        {"role": "assistant", "content": "1回目の回答"},
        {"role": "user", "content": "2回目の質問"},
        {"role": "assistant", "content": "2回目の回答"},
    ])
    return chat["id"]


def test_delete_turn_removes_user_and_responses(store):
    chat_id = _two_turn_chat(store)
    chat = store.delete_chat_turn(chat_id, 0, keep_user=False)
    assert [m.get("content") for m in chat["messages"]] == ["2回目の質問", "2回目の回答"]


def test_delete_answer_keeps_user_message(store):
    chat_id = _two_turn_chat(store)
    chat = store.delete_chat_turn(chat_id, 0, keep_user=True)
    contents = [m.get("content") for m in chat["messages"]]
    assert contents == ["1回目の質問", "2回目の質問", "2回目の回答"]  # ツール行も往復ごと消える


def test_delete_turn_rejects_non_user_index(store):
    chat_id = _two_turn_chat(store)
    assert store.delete_chat_turn(chat_id, 3, keep_user=False) is None  # assistant の位置


def test_tool_limit_marker_is_not_a_turn_start(store):
    chat = store.create_chat(None, "upto")
    store.save_chat_messages(chat["id"], [
        {"role": "user", "content": "質問"},
        {"role": "user", "content": "(これ以上ツールは使えません。まとめてください)"},
        {"role": "assistant", "content": "回答"},
    ])
    result = store.delete_chat_turn(chat["id"], 0, keep_user=False)
    assert result["messages"] == []  # 内部指示ごと 1 往復として消える


def test_replace_from_rewinds_history(store, monkeypatch):
    chat_id = _two_turn_chat(store)
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([{"content": "作り直した回答", "tool_calls": None,
                      "message": {"role": "assistant", "content": "作り直した回答"}}]),
    )
    collect_sse(chat_agent.chat_stream(
        store, "http://fake", chat_id, None, "upto", "2回目の質問(修正)", replace_from=4
    ))
    contents = [m.get("content") for m in store.get_chat(chat_id)["messages"]]
    assert contents[:4] == ["1回目の質問", None, "{}", "1回目の回答"]  # 前半はそのまま
    assert contents[4:] == ["2回目の質問(修正)", "作り直した回答"]


def test_visible_path_falls_back_when_anchor_was_deleted(store):
    """保存済みチャットのアンカーが削除済みシーンを指していても、KeyError にせず
    正史全体を返す(2026-09-06 修正。delete_node は chats.anchor_node を掃除しない)。"""
    path = chat_agent._visible_path(store, "no-such-node", "upto")
    assert path == store.canon_path()
    assert chat_agent._tool_get_beats(store, path, {})["total"] == 3


# ---- キャラ同士の会話室(docs/design/chat.md §7) ------------------------


def test_room_system_prompt_replaces_frame_and_keeps_knowledge(store):
    path = store.canon_path()
    system = chat_agent.build_room_system(store, path, "aya", ["aya", "ken"])
    # 知識の節(記憶)はキャラチャットと同じものが載る
    assert "石橋でケンの裏切りを知った" in system
    # 枠組みは会話室用に差し替わる(インタビュー / 見知らぬ相手の文言は残らない)
    assert "ケンと同じ場所で言葉を交わしています" in system
    assert "インタビュー" not in system
    assert "見知らぬ相手" not in system
    assert system.count("## この会話について") == 1
    assert system.count("## 厳守すること") == 1


def test_room_transcript_is_from_speakers_point_of_view(store):
    history = [
        {"role": "user", "content": "再会の場面。まず挨拶から"},
        {"role": "assistant", "speaker": "aya", "content": "久しぶりね。"},
        {"role": "assistant", "speaker": "ken", "content": "……ああ。"},
        {"role": "user", "content": "アヤは石橋の件を切り出す"},
    ]
    msgs = chat_agent._room_transcript_messages(store, history, "aya")
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    assert "（演出: 再会の場面。まず挨拶から）" in msgs[0]["content"]
    assert msgs[1]["content"] == "久しぶりね。"
    # 相手の発言と次の指示は 1 つの user にまとまる
    assert "ケン「……ああ。」" in msgs[2]["content"]
    assert "（演出: アヤは石橋の件を切り出す）" in msgs[2]["content"]
    # 口火を切るとき(履歴が空)でも user で終わる
    first = chat_agent._room_transcript_messages(store, [], "ken")
    assert [m["role"] for m in first] == ["user"]


def test_next_room_speaker_round_robin():
    parts = ["aya", "ken", "mio"]
    assert chat_agent.next_room_speaker(parts, []) == "aya"
    assert chat_agent.next_room_speaker(parts, [{"role": "assistant", "speaker": "aya"}]) == "ken"
    assert chat_agent.next_room_speaker(parts, [{"role": "assistant", "speaker": "mio"}]) == "aya"
    # 参加者から外れた話者(削除済みなど)の後は先頭から
    assert chat_agent.next_room_speaker(parts, [{"role": "assistant", "speaker": "zzz"}]) == "aya"


def test_strip_speaker_prefix():
    assert chat_agent._strip_speaker_prefix("アヤ: 久しぶりね。", "アヤ") == "久しぶりね。"
    assert chat_agent._strip_speaker_prefix("アヤ「久しぶりね。」", "アヤ") == "久しぶりね。"
    assert chat_agent._strip_speaker_prefix("久しぶりね。「そう」と言った。", "アヤ") == "久しぶりね。「そう」と言った。"


def test_room_stream_alternates_speakers_and_saves_only_utterances(store, monkeypatch):
    tc = _tool_call("recall", {"query": "石橋"})
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([
            # 1 人目: recall してから話す
            {"content": "", "tool_calls": [tc], "message": {"role": "assistant", "content": None, "tool_calls": [tc]}},
            {"content": "アヤ: 久しぶりね。", "tool_calls": None, "message": {"role": "assistant", "content": "アヤ: 久しぶりね。"},
             "stats": {"tokens": 10, "elapsed_sec": 1.0}},
            # 2 人目
            {"content": "……ああ。", "tool_calls": None, "message": {"role": "assistant", "content": "……ああ。"}},
        ]),
    )
    anchor = store.canon_path()[-1]
    events = collect_sse(
        chat_agent.room_stream(store, "http://fake", None, anchor, ["aya", "ken"], "再会の場面", None, 2)
    )
    chat_id = next(e["chat_id"] for e in events if "chat_id" in e)
    speakers = [e["speaker"] for e in events if "turn" in e]
    assert speakers == ["aya", "ken"]
    utterances = [e["utterance"] for e in events if "utterance" in e]
    assert [u["speaker"] for u in utterances] == ["aya", "ken"]
    assert utterances[0]["text"] == "久しぶりね。"  # 接頭辞が落ちる
    assert events[-1] == {"done": True, "chat_id": chat_id}
    saved = store.get_chat(chat_id)
    assert saved["mode"] == "room"
    assert saved["participants"] == ["aya", "ken"]
    assert saved["scope"] == "upto"
    assert saved["char_id"] is None
    # 履歴は 演出指示 + 発言 2 つ。recall の往復は保存されず、控えに残る
    assert [m["role"] for m in saved["messages"]] == ["user", "assistant", "assistant"]
    assert saved["messages"][1]["speaker"] == "aya"
    assert saved["messages"][1]["tools_used"] == ["recall"]
    assert saved["messages"][1]["meta"]["tokens"] == 10
    assert any(m.get("role") == "tool" for m in saved["messages"][1]["prompt_messages"])
    # 2 人目のプロンプトには 1 人目の発言が「名前「…」」で届いている
    ken_prompt = saved["messages"][2]["prompt_messages"]
    assert any("アヤ「久しぶりね。」" in (m.get("content") or "") for m in ken_prompt)
    assert ken_prompt[0]["content"].startswith("あなたは「ケン」という人物です。")


def test_room_stream_speaker_override_then_round_robin(store, monkeypatch):
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([{"content": "ふむ。", "tool_calls": None, "message": {"role": "assistant", "content": "ふむ。"}}]),
    )
    anchor = store.canon_path()[-1]
    events = collect_sse(chat_agent.room_stream(store, "http://fake", None, anchor, ["aya", "ken"], None, "ken", 3))
    assert [e["speaker"] for e in events if "turn" in e] == ["ken", "aya", "ken"]
    chat_id = next(e["chat_id"] for e in events if "chat_id" in e)
    # 指示なしなので user は無い
    assert [m["role"] for m in store.get_chat(chat_id)["messages"]] == ["assistant"] * 3
    # 続き(既存チャット)は前の話者の次から
    events2 = collect_sse(chat_agent.room_stream(store, "http://fake", chat_id, None, None, None, None, 1))
    assert [e["speaker"] for e in events2 if "turn" in e] == ["aya"]


def test_room_stream_validates_participants(store):
    anchor = store.canon_path()[-1]
    one = collect_sse(chat_agent.room_stream(store, "http://fake", None, anchor, ["aya"], None, None, 1))
    assert "2 人以上" in one[-1]["error"]
    missing = collect_sse(chat_agent.room_stream(store, "http://fake", None, anchor, ["aya", "nobody"], None, None, 1))
    assert "nobody" in missing[-1]["error"]
    assert store.list_chats() == []  # 失敗時はチャットを作らない


def test_room_turns_are_capped(store, monkeypatch):
    monkeypatch.setattr(
        llm_mod,
        "chat_stream_tools",
        _fake_stream([{"content": "…", "tool_calls": None, "message": {"role": "assistant", "content": "…"}}]),
    )
    events = collect_sse(
        chat_agent.room_stream(store, "http://fake", None, store.canon_path()[-1], ["aya", "ken"], None, None, 100)
    )
    assert len([e for e in events if "utterance" in e]) == chat_agent.MAX_ROOM_TURNS


def test_room_list_and_delete_message(store):
    chat = store.create_chat(store.canon_path()[-1], "upto", mode="room", participants=["aya", "ken"])
    store.save_chat_messages(chat["id"], [
        {"role": "user", "content": "指示"},
        {"role": "assistant", "speaker": "aya", "content": "a"},
        {"role": "assistant", "speaker": "ken", "content": "k"},
    ])
    listed = store.list_chats()[0]
    assert listed["mode"] == "room"
    assert listed["participants"] == ["aya", "ken"]
    assert listed["participant_names"] == ["アヤ", "ケン"]
    # 1 件だけ消す(往復ではなく)
    after = store.delete_chat_message(chat["id"], 1)
    assert [m.get("speaker", m["role"]) for m in after["messages"]] == ["user", "ken"]
    assert store.delete_chat_message(chat["id"], 5) is None


def test_token_usage_room_uses_longest_participant(store, monkeypatch):
    seen = {}

    async def fake_count(text, base_url):
        seen["text"] = text
        return 123

    monkeypatch.setattr(llm_mod, "count_tokens", fake_count)
    usage = asyncio.run(
        chat_agent.token_usage(store, "http://fake", None, store.canon_path()[-1], "upto", None, "room", ["aya", "ken"])
    )
    assert usage == {"token_count": 123, "estimated": False}
    # アヤは記憶を持つのでシステムプロンプトが長い → アヤ分で数える
    assert "石橋でケンの裏切りを知った" in seen["text"]
    assert "と同じ場所で言葉を交わしています" in seen["text"]
