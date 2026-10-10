"""前後照合の経路分離・根拠・確定前の中断を確認する。"""
import asyncio
import json

import pytest

import db
import embed
import generation
import llm
import node_operations
import production_agent as production
import production_continuity as continuity
from store import Store


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    s.append_node({"id": "first", "title": "相談", "beat": "アヤは住民と相談する。", "cast": []})
    s.append_node({"id": "last", "title": "手渡す", "beat": "アヤは図面を住民へ初めて渡す。", "cast": []})
    yield s
    s.conn.close()


def test_marker_traversal_and_sibling_exclusion(store):
    store.create_group("相談の章", ["first"])
    store.create_group("手渡す章", ["last"])
    pairs = continuity.adjacent_pairs(store, "first")
    assert [(p["before"]["id"], p["after"]["id"]) for p in pairs] == [("first", "last")]
    store.append_node({"id": "branch", "beat": "別の場所へ向かう。"}, parent_id="first", force_draft=True)
    pairs = continuity.adjacent_pairs(store, "branch")
    assert [(p["before"]["id"], p["after"]["id"]) for p in pairs] == [("first", "branch")]


@pytest.mark.parametrize("mode", ["reject", "bad_quote", "bad_id", "malformed", "cancel", "conflict", "instruction", "pass"])
def test_review_before_extraction_and_commit(store, monkeypatch, mode):
    before = store.graph()
    extracted = []
    async def extract(candidate, base_url, node_id):
        extracted.append(node_id)
        candidate.replace_events(node_id, [])
    monkeypatch.setattr(generation, "extract_events", extract)
    async def review(messages, **kwargs):
        assert store.graph() == before
        pairs = json.loads(messages[-1]["content"])
        pair = next(p for p in pairs if p["after"]["id"] == "last")
        if mode == "cancel":
            raise asyncio.CancelledError()
        if mode == "conflict":
            node_operations.update(store, "first", {"beat": "作者の修正"})
        if mode in ("pass", "conflict", "instruction"):
            return {"issues": []}
        if mode == "malformed":
            return {"issues": [None]}
        return {"issues": [{"before_id": pair["before"]["id"], "after_id": "missing" if mode == "bad_id" else "last",
            "before_quote": "存在しない引用" if mode == "bad_quote" else "図面を持ち帰る",
            "after_quote": "初めて渡す", "reason": "初めて手渡す前に持ち帰っている"}]}
    monkeypatch.setattr(llm, "chat_json", review)
    def check_pending():
        if mode == "instruction":
            raise production.InstructionsPending("追加指示")
    task = production.apply_edit(store, "fake", "insert_scene", {
        "after_id": "first", "title": "待機", "beat": "住民が図面を持ち帰る。", "cast": [], "reason": "展開の追加"},
        before_commit=check_pending)
    if mode == "pass":
        result = asyncio.run(task)
        assert len(extracted) == 1 and store.get_node(result["node_id"])
    else:
        error = {"cancel": asyncio.CancelledError, "conflict": production.ManualEditPending,
                 "instruction": production.InstructionsPending}.get(mode, ValueError)
        with pytest.raises(error):
            asyncio.run(task)
        assert not extracted
        assert store.graph()["edges"] == before["edges"]
        assert len(store.graph()["nodes"]) == len(before["nodes"])
        if mode != "conflict":
            assert store.graph() == before
