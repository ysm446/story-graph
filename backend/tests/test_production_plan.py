"""制作の計画(production_plan)。"""
import asyncio

import pytest

import db
import embed
import llm
import production_plan
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


def test_proposal_is_the_last_reply_before_the_request():
    history = [
        {"role": "user", "content": "どう直す?"},
        {"role": "assistant", "content": "", "step": {"name": "get_beats"}},
        {"role": "assistant", "content": "案: 出発に目的を足し、帰還の前に再会を 1 シーン入れる。"},
        {"role": "user", "content": "この案で進めて"},
    ]
    assert production_plan.proposal_from(history) == "案: 出発に目的を足し、帰還の前に再会を 1 シーン入れる。"
    # 直前が操作や通知だけなら提案なし。作者の発言しか無くても提案なし
    assert production_plan.proposal_from([{"role": "user", "content": "x"}]) == ""
    assert production_plan.proposal_from([
        {"role": "user", "content": "直して"}, {"role": "assistant", "content": "追記", "operation": {"action": "patch_scene"}},
        {"role": "user", "content": "続けて"}]) == ""


def test_normalize_budget_and_prompt():
    assert production_plan.normalize({"needs_plan": False, "steps": [{"summary": "x", "target_ids": []}], "note": ""}) is None
    assert production_plan.normalize({"needs_plan": True, "steps": [], "note": ""}) is None
    assert production_plan.normalize("garbage") is None
    plan = production_plan.normalize({"needs_plan": True, "note": " 文体は既存に合わせる ", "steps": [
        {"summary": "章「森の夜」を出発の後に作る", "target_ids": ["first"]},
        {"summary": "  森で火を起こすシーンを入口の後ろに追加 ", "target_ids": []},
        {"summary": "", "target_ids": []}, "broken",
    ]})
    assert [s["summary"] for s in plan["steps"]] == ["章「森の夜」を出発の後に作る", "森で火を起こすシーンを入口の後ろに追加"]
    assert plan["note"] == "文体は既存に合わせる"
    text = production_plan.prompt_text(plan)
    assert "1. 章「森の夜」を出発の後に作る(対象: first) / 2. 森で火を起こす" in text and "計画の注意: 文体" in text
    assert production_plan.prompt_text(None) == ""
    assert production_plan.step_budget(None) == 16
    assert production_plan.step_budget(plan) == 16  # 4 + 2*2 = 8 → 下限の 16
    big = {"steps": [{"summary": str(i), "target_ids": []} for i in range(10)], "note": ""}
    assert production_plan.step_budget(big) == 24
    huge = {"steps": [{"summary": str(i), "target_ids": []} for i in range(24)], "note": ""}
    assert production_plan.step_budget(huge) == 48


def test_make_passes_outline_and_proposal_and_swallows_failures(store, monkeypatch):
    captured = {}
    async def chat_json(messages, **kwargs):
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        return {"needs_plan": True, "note": "", "steps": [{"summary": "再会を帰還の前に追加", "target_ids": ["last"]}]}
    monkeypatch.setattr(llm, "chat_json", chat_json)
    history = [{"role": "user", "content": "案を"}, {"role": "assistant", "content": "再会を入れる案"}, {"role": "user", "content": "この案で進めて"}]
    plan = asyncio.run(production_plan.make(store, "fake", "この案で進めて", history, selection=[{"id": "last", "title": "帰還"}], policy_label="変更範囲: 全体"))
    assert plan["steps"][0]["target_ids"] == ["last"]
    user = captured["messages"][1]["content"]
    assert "再会を入れる案" in user and '"id": "first"' in user and "変更範囲: 全体" in user
    assert captured["kwargs"]["schema"] is production_plan.SCHEMA
    async def broken(messages, **kwargs):
        raise RuntimeError("down")
    monkeypatch.setattr(llm, "chat_json", broken)
    assert asyncio.run(production_plan.make(store, "fake", "x", [])) is None
