import pytest

import db
import embed
import retrieval
from store import Store


@pytest.fixture
def store(monkeypatch):
    # モデルロードを避けて FTS のみで検証する(vec は ensure_vectors 側で無効化)
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.create_character({"name": "ケン", "id": "ken"})
    return s


def _memory(char, content, importance=0.5):
    return {"type": "memory_add", "payload": {"char": char, "content": content, "importance": importance}}


def test_fts_terms_generates_trigrams():
    terms = retrieval._fts_terms("ケンの裏切りを 橋で知った")
    assert all(len(t) == 3 for t in terms)
    assert "裏切り" in terms  # 内容語のトライグラムが含まれる


def test_search_prefers_keyword_match(store):
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        _memory("aya", "村の祭りで踊った楽しい思い出", 0.5),
        _memory("aya", "石橋の上でケンの裏切りを知った", 0.5),
    ])
    state = store.get_state(n1["id"])
    candidates = set(state["chars"]["aya"]["memories"])
    hits = retrieval.search_memories(store.conn, "裏切りの理由をケンに問い詰める", candidates, 1, top_k=1)
    assert len(hits) == 1
    assert "裏切り" in hits[0]["content"]


def test_search_applies_importance_and_decay(store):
    events = [{"type": "char_introduce", "payload": {"char": "aya"}}]
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, events + [
        _memory("aya", "とても重要な誓い", importance=1.0),
    ])
    # 30 ビート後に些末な記憶を追加(検索語はどちらにもヒットしない)
    for i in range(30):
        store.append_node({"beat": f"間のビート {i}", "cast": ["aya"]})
    tail = store.append_node({"beat": "最新", "cast": ["aya"]}, [
        _memory("aya", "今朝のパンの味", importance=0.2),
    ])
    state = store.get_state(tail["id"])
    candidates = set(state["chars"]["aya"]["memories"])
    hits = retrieval.search_memories(store.conn, "全く関係ない語句xyz", candidates, 31, top_k=2)
    # 検索シグナルなし → importance × 減衰。誓い: 1.0 × 0.5^(31/20) ≈ 0.34、
    # パン: 0.2 × 1.0 = 0.2 → 誓いが勝つ
    assert hits[0]["content"] == "とても重要な誓い"


def test_index_removed_with_events(store):
    n1 = store.append_node({"beat": "b1", "cast": ["aya"]}, [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        _memory("aya", "消される記憶テスト"),
    ])
    assert store.conn.execute("SELECT COUNT(*) FROM memories_fts").fetchone()[0] == 1
    store.replace_events(n1["id"], [{"type": "char_introduce", "payload": {"char": "aya"}}])
    assert store.conn.execute("SELECT COUNT(*) FROM memories_fts").fetchone()[0] == 0
