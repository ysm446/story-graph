"""制作メモの照合根拠と、副作用のない見直し生成を検証する。"""
import asyncio
import json

import pytest
import db
import embed
import llm
import production_memory as memory
from store import Store


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(tmp_path / "test.db"), root=str(tmp_path))
    s.create_character({"id": "aya", "name": "アヤ", "profile": "古い設定"})
    s.append_node({"id": "first", "title": "出発", "beat": "村を出る", "cast": ["aya"]})
    yield s
    s.conn.close()


def test_review_supplies_manual_diffs_without_writing(store, monkeypatch):
    memory.write(store, "方針を残す", "初期", "user")
    memory.mark_reviewed(store, memory.basis(store), 1)
    store.conn.execute("UPDATE nodes SET beat=? WHERE id='first'", ("作者が修正した文章",))
    store.conn.execute("UPDATE characters SET profile=? WHERE id='aya'", ("作者の新設定",))
    store.conn.commit()
    captured = []
    async def chat(messages, **kwargs):
        captured.append((messages, kwargs))
        return {"content": json.dumps({"content": "方針を残す。次の依頼待ち", "reason": "差分照合"})}
    monkeypatch.setattr(llm, "chat", chat)
    value, revision, basis = asyncio.run(memory.review(store, "fake", "確認", [], [], "完了"))
    evidence = json.loads(captured[0][0][1]["content"])
    delta = json.dumps(evidence, ensure_ascii=False)
    assert all(text in delta for text in ("村を出る", "作者が修正した文章", "古い設定", "作者の新設定"))
    assert captured[0][1].get("tools") is None
    assert value["reason"] == "差分照合" and revision == 1
    assert memory.read(store)["content"] == "方針を残す"
    assert memory.read(store)["needs_review"]
    assert basis == memory.basis(store)


@pytest.mark.parametrize("response", [
    {"content": "不正なJSON"}, {"content": "[]"},
    {"content": '{"content":"", "reason":"空"}'},
    {"content": '{"content":"途中", "reason":"途中"}', "finish_reason": "length"},
])
def test_invalid_review_preserves_memo(store, monkeypatch, response):
    memory.write(store, "消してはいけない方針", "初期", "user")
    async def chat(*args, **kwargs):
        return response
    monkeypatch.setattr(llm, "chat", chat)
    with pytest.raises(ValueError):
        asyncio.run(memory.review(store, "fake", "確認", [], [], "完了"))
    assert memory.read(store)["content"] == "消してはいけない方針"
    assert memory.review_state(store) == {}


def test_diff_tracks_deletion_connections_and_ignores_position(store):
    before = memory.basis(store)
    store.conn.execute("UPDATE characters SET graph_x=100 WHERE id='aya'")
    assert memory.basis(store) == before
    store.append_node({"id": "last", "title": "帰還", "beat": "帰る", "cast": ["aya"]})
    changed = memory.differences(before, memory.basis(store))
    assert {c["対象"] for c in changed["変更"]} >= {"scene:last", "connections", "canon"}
    removed = memory.differences(memory.basis(store), before)
    scene = next(c for c in removed["変更"] if c["対象"] == "scene:last")
    assert "-" in scene["差分"] and "+null" in scene["差分"]


def test_unchanged_review_does_not_add_revision(store):
    note = memory.write(store, "有効な方針", "初期", "user")
    same = memory.write(store, "有効な方針", "変更不要", "llm", expected_revision=1)
    memory.mark_reviewed(store, memory.basis(store), same["revision"])
    assert memory.read(store)["created_at"] == note["created_at"]
    assert memory.read(store)["reviewed_at"] and not memory.read(store)["needs_review"]
    assert len(memory.history(store)) == 1
