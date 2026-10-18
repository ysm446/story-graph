"""2026-10-14 のレビューで直した不具合の回帰テスト。

- 結末の先にシーンをつなぐ要求は 400(500 にしない)
- 勢力の名前に明示的な null が来ても NOT NULL 違反にしない
- fold に掛けられないイベントは保存前に断る(以降のノードの状態取得を壊さない)
- 自動バックアップのローテーションは、ライブラリ名にグロブの記号があっても効く
- ツール付きストリームの統計は、choices が空の usage チャンクからも拾う
"""
import asyncio
import json

import httpx
import pytest

import backup
import db
import embed
import llm
from store import Store


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    for name in ["a", "b"]:
        s.append_node({"id": name, "title": name, "beat": name})
    yield s
    s.conn.close()


@pytest.fixture
def client(store, monkeypatch):
    import app as api

    async def snapshot(*args):
        pass

    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api.snapshots, "auto", snapshot)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test")


def test_append_after_ending_is_400(store, client):
    ending = store.active_ending()

    async def check():
        async with client as c:
            response = await c.post("/nodes", json={"title": "x", "beat": "x", "parent_id": ending})
            assert response.status_code == 400
            assert "結末" in response.json()["detail"]
            response = await c.post(f"/nodes/{ending}/insert_after", json={"title": "x", "beat": "x"})
            assert response.status_code == 400

    asyncio.run(check())


def test_faction_patch_with_null_name_keeps_name(store):
    faction = store.create_faction({"name": "騎士団", "description": "説明"})
    store.update_faction(faction["id"], {"name": None, "description": "新しい説明"})
    row = store.conn.execute("SELECT name, description FROM factions WHERE id = ?", (faction["id"],)).fetchone()
    assert (row["name"], row["description"]) == ("騎士団", "新しい説明")


def test_put_events_rejects_payload_fold_cannot_apply(store, client):
    store.create_character({"id": "aya", "name": "綾"})

    async def check():
        async with client as c:
            bad = {"events": [{"type": "memory_compress", "payload": {"char": "aya", "summary": "要約"}}]}
            response = await c.put("/nodes/a/events", json=bad)
            assert response.status_code == 400
            assert "replaces" in response.json()["detail"]
            # scope が world 以外で char が無いものも fold が落ちるので断る
            bad = {"events": [{"type": "fact_set", "payload": {"scope": "global", "key": "k", "value": "v"}}]}
            assert (await c.put("/nodes/a/events", json=bad)).status_code == 400
            # 断られたので下流の状態取得は生きている
            assert (await c.get("/nodes/b/state")).status_code == 200
            good = {"events": [{"type": "memory_add", "payload": {"char": "aya", "content": "覚えた"}}]}
            assert (await c.put("/nodes/a/events", json=good)).status_code == 200

    asyncio.run(check())


def test_rotate_with_glob_characters_in_name(tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    name = "story [v2]"
    for i in range(3):
        (dest / f"{name}{backup.AUTO_MARK}2026080{i}-000000.zip").write_bytes(b"x")
    removed = backup.rotate(str(dest), name, keep=1)
    assert removed == [
        f"{name}{backup.AUTO_MARK}20260801-000000.zip",
        f"{name}{backup.AUTO_MARK}20260800-000000.zip",
    ]


def test_chat_stream_tools_reads_usage_from_empty_choices_chunk(monkeypatch):
    chunks = [
        {"choices": [{"delta": {"content": "こん"}}]},
        {"choices": [{"delta": {"content": "にちは"}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"completion_tokens": 7, "prompt_tokens": 20}, "model": "m"},
    ]
    body = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=body.encode("utf-8")))
    real = httpx.AsyncClient
    monkeypatch.setattr(llm.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw))

    async def run():
        done = None
        async for kind, value in llm.chat_stream_tools([{"role": "user", "content": "hi"}], base_url="http://x"):
            if kind == "done":
                done = value
        return done

    result = asyncio.run(run())
    assert result["content"] == "こんにちは"
    assert result["stats"]["tokens"] == 7
    assert result["stats"]["prompt_tokens"] == 20
    assert result["stats"]["finish_reason"] == "stop"
    assert result["stats"]["model"] == "m"


def test_state_before_is_parent_state(store, client):
    """詳細欄のイベントで「前 → 後」を出すための、シーンに入る直前の状態"""
    store.create_character({"id": "aya", "name": "綾"})
    store.create_character({"id": "ken", "name": "健"})
    rel = {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": -0.2, "reason": "r"}}

    async def check():
        async with client as c:
            assert (await c.put("/nodes/a/events", json={"events": [rel]})).status_code == 200
            assert (await c.put("/nodes/b/events", json={"events": [rel]})).status_code == 200
            before = (await c.get("/nodes/b/state_before")).json()
            after = (await c.get("/nodes/b/state")).json()
            assert before["chars"]["aya"]["relationships"]["ken"]["score"] == pytest.approx(-0.2)
            assert after["chars"]["aya"]["relationships"]["ken"]["score"] == pytest.approx(-0.4)
            # 先頭のノードの直前は、はじまりの状態(関係はまだ無い)
            first = (await c.get("/nodes/a/state_before")).json()
            assert "ken" not in first["chars"].get("aya", {}).get("relationships", {})
            assert (await c.get("/nodes/missing/state_before")).status_code == 404

    asyncio.run(check())
