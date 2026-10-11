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
    {"content": json.dumps({"content": "長" * 6001, "reason": "超過"})},
    {"content": '{"content":"本文", "reason":""}'},
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


@pytest.mark.parametrize("initial_review", [False, True])
def test_large_review_covers_four_scenes_and_long_single_fields(store, monkeypatch, initial_review):
    memory.write(store, "作者の決定は維持", "初期", "user")
    if not initial_review:
        memory.mark_reviewed(store, memory.basis(store), 1)
    for i in range(4):
        store.append_node({"id": f"large{i}", "title": f"場面{i}",
                           "beat": f"開始{i}" + '文章\\"\n' * 5000 + f"終端{i}", "cast": ["aya"]})
    expected_basis = memory.basis(store)
    expected_review = memory.review_state(store)
    calls, fragments = [], []
    async def chat(messages, **kwargs):
        encoded = messages[1]["content"]
        assert len(encoded) <= memory.REVIEW_INPUT_CHARS
        evidence = json.loads(encoded)
        calls.append(evidence)
        if kwargs["label"] == "制作の作業メモ分割照合":
            fragments.extend(evidence)
            return {"content": json.dumps({"summary": "新しい4場面を確認。作者の決定は維持。"})}
        assert evidence["作業メモ"] == "作者の決定は維持"
        assert evidence["分割照合の要約"]
        return {"content": json.dumps({"content": "作者の決定は維持。次の依頼待ち", "reason": "全資料照合"})}
    monkeypatch.setattr(llm, "chat", chat)
    value, revision, captured_basis = asyncio.run(memory.review(store, "fake", "依頼" * 25000, [], [], "完了"))
    assert len(calls) > 2 and revision == 1 and value["reason"] == "全資料照合"
    assert captured_basis == expected_basis
    for diff in memory.differences(expected_review.get("basis"), expected_basis)["変更"]:
        parts = [f for f in fragments if f["分類"] == "前回の照合後の変更（手動修正を含む）" and f["対象"] == diff["対象"]]
        assert [f["断片"] for f in parts] == list(range(1, len(parts) + 1))
        assert json.loads("".join(f["資料"] for f in parts)) == diff["差分"]
    assert memory.review_state(store) == expected_review
    assert memory.read(store)["content"] == "作者の決定は維持"


@pytest.mark.parametrize("failure", ["invalid", "length", "cancel"])
def test_split_review_failure_never_saves_partial_results(store, monkeypatch, failure):
    memory.write(store, "残すメモ", "初期", "user")
    memory.mark_reviewed(store, memory.basis(store), 1)
    before = memory.review_state(store)
    calls = []
    async def chat(*args, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            return {"content": '{"summary":"途中まで確認"}'}
        if failure == "cancel":
            raise asyncio.CancelledError()
        if failure == "length":
            return {"content": '{"summary":"途中"}', "finish_reason": "length"}
        return {"content": '{"summary":""}'}
    monkeypatch.setattr(llm, "chat", chat)
    error = asyncio.CancelledError if failure == "cancel" else ValueError
    with pytest.raises(error):
        asyncio.run(memory.review(store, "fake", "依頼" * 50000, [], [], "完了"))
    assert len(calls) == 2
    assert memory.review_state(store) == before
    assert memory.read(store)["revision"] == 1
    assert memory.read(store)["content"] == "残すメモ"


def test_split_review_stops_before_next_call_on_new_instruction(store, monkeypatch):
    calls = []
    async def chat(*args, **kwargs):
        calls.append(True)
        return {"content": '{"summary":"一部確認"}'}
    def check():
        if calls:
            raise RuntimeError("途中指示")
    monkeypatch.setattr(llm, "chat", chat)
    with pytest.raises(RuntimeError, match="途中指示"):
        asyncio.run(memory.review(store, "fake", "依頼" * 50000, [], [], "完了", check_current=check))
    assert len(calls) == 1 and memory.review_state(store) == {}


def test_many_summaries_are_reduced_before_final_review(store, monkeypatch):
    calls = []
    async def chat(messages, **kwargs):
        assert len(messages[1]["content"]) <= memory.REVIEW_INPUT_CHARS
        data = json.loads(messages[1]["content"])
        calls.append(data)
        if isinstance(data, list):
            return {"content": json.dumps({"summary": "要点" * 1400})}
        return {"content": '{"content":"確認済み", "reason":"統合"}'}
    monkeypatch.setattr(llm, "chat", chat)
    value, _, _ = asyncio.run(memory.review(store, "fake", "長い資料" * 150000, [], [], "完了"))
    assert value["content"] == "確認済み"
    assert any(isinstance(data, list) and isinstance(data[0], str) for data in calls)
