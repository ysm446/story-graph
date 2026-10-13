import asyncio

import pytest

import db
import embed
import llm as llm_mod
import production_suggest
from store import Store


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    yield s
    s.conn.close()


def make_chat(store, messages):
    chat = store.create_chat(None, "all", mode="production")
    store.save_chat_messages(chat["id"], messages)
    return chat["id"]


def fake_llm(monkeypatch, suggestions):
    calls = []

    async def chat_json(messages, **kwargs):
        calls.append({"messages": messages, **kwargs})
        return {"suggestions": suggestions}

    monkeypatch.setattr(llm_mod, "chat_json", chat_json)
    return calls


def test_last_exchange_uses_the_final_text_reply():
    messages = [
        {"role": "user", "content": "古い依頼"},
        {"role": "assistant", "content": "古い回答"},
        {"role": "user", "content": "展開を相談したい", "execute": False},
        {"role": "assistant", "content": "", "step": {"name": "get_beats"}},
        {"role": "assistant", "content": "案Aと案Bがあります。"},
        {"role": "assistant", "content": "追記した", "operation": {"action": "patch_scene"}},
    ]
    request, reply = production_suggest.last_exchange(messages)
    assert request["content"] == "展開を相談したい" and reply == "案Aと案Bがあります。"
    # 応答がまだ無い依頼には候補を作らない
    assert production_suggest.last_exchange([*messages, {"role": "user", "content": "次の依頼"}]) is None
    assert production_suggest.last_exchange([]) is None


def test_suggest_marks_execution_by_kind_and_adds_the_guard(store, monkeypatch):
    chat_id = make_chat(store, [
        {"role": "user", "content": "この章の展開を相談したい", "execute": False},
        {"role": "assistant", "content": "案A: 橋で再会する。案B: 手紙で知る。"},
    ])
    calls = fake_llm(monkeypatch, [
        {"kind": "proceed", "label": "案Bで進めて", "text": "案B(手紙で知る)で進めてください。"},
        {"kind": "alternative", "label": "案Aの別の再会場所", "text": "案Aの再会場所の別案を出してください。"},
        {"kind": "review", "label": "レビューして", "text": "レビューしてください。"},  # 対象を特定しない依頼は捨てる
        {"kind": "proceed", "label": "案Aで進めて", "text": "案A(橋で再会する)で進めてください。"},
    ])
    result = asyncio.run(production_suggest.suggest(store, "fake", chat_id))
    # 案を進める候補が先頭に並ぶ
    assert [(item["label"], item["execute"]) for item in result] == [
        ("案Bで進めて", True), ("案Aで進めて", True), ("案Aの別の再会場所", False)]
    assert result[0]["text"].endswith(production_suggest.EXECUTE_GUARD)
    assert result[2]["text"].endswith(production_suggest.CONSULT_GUARD)
    prompt = calls[0]["messages"][0]["content"]
    assert "案A: 橋で再会する" in prompt and "この章の展開を相談したい" in prompt
    assert calls[0]["schema"]["properties"]["suggestions"]["items"]["properties"]["kind"]["enum"] == [
        "proceed", "fix", "review", "alternative"]


def test_no_execute_suggestions_after_an_executed_request(store, monkeypatch):
    """実行の完了報告から、1クリックで作品を書き換える候補を作らせない。"""
    chat_id = make_chat(store, [
        {"role": "user", "content": "案Bで進めて", "execute": True},
        {"role": "assistant", "content": "手紙の場面を追加しました。伏線が弱い点が残ります。"},
    ])
    calls = fake_llm(monkeypatch, [
        {"kind": "fix", "label": "伏線を強めて", "text": "手紙の伏線を強めてください。"},  # スキーマ外の種類が返っても捨てる
        {"kind": "review", "label": "手紙の場面を点検", "text": "追加した手紙の場面を点検してください。"},
    ])
    result = asyncio.run(production_suggest.suggest(store, "fake", chat_id))
    assert [(item["label"], item["execute"]) for item in result] == [("手紙の場面を点検", False)]
    assert calls[0]["schema"]["properties"]["suggestions"]["items"]["properties"]["kind"]["enum"] == ["review", "alternative"]


def test_suggest_returns_nothing_without_a_reply_or_for_other_chats(store, monkeypatch):
    calls = fake_llm(monkeypatch, [{"kind": "review", "label": "点検して", "text": "点検してください。"}])
    assert asyncio.run(production_suggest.suggest(store, "fake", "missing")) == []
    assert asyncio.run(production_suggest.suggest(store, "fake", make_chat(store, [{"role": "user", "content": "依頼"}]))) == []
    consult = store.create_chat(None, "all")
    store.save_chat_messages(consult["id"], [{"role": "user", "content": "質問"}, {"role": "assistant", "content": "回答"}])
    assert asyncio.run(production_suggest.suggest(store, "fake", consult["id"])) == []
    assert calls == []
