import asyncio
import json

import pytest

import db
import llm as llm_mod
import rendering
from store import Store


@pytest.fixture
def store():
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya", "voice": "一人称は「あたし」"})
    s.create_character({"name": "ケン", "id": "ken"})
    s.append_node({"beat": "出会い", "cast": ["aya", "ken"], "title": "第一話"}, [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        {"type": "char_introduce", "payload": {"char": "ken"}},
    ])
    s.append_node({"beat": "橋での対峙", "cast": ["aya", "ken"], "title": "第二話"})
    return s


def collect_sse(agen):
    async def run():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in agen]

    return asyncio.run(run())


def test_render_stream_sequential(store, monkeypatch):
    captured_messages = []

    async def fake_stream(messages, **kwargs):
        captured_messages.append(messages)
        yield "むかしむかし、"
        yield "あるところに。"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    path = store.canon_path()
    events = collect_sse(rendering.render_stream(store, "http://fake", path, preset["id"], None))
    assert events[-1] == {"done": True}
    scene_dones = [e for e in events if "scene_done" in e]
    assert len(scene_dones) == 2
    # 各シーンの散文が保存されている
    r1 = store.latest_render(path[0], preset["id"], None)
    assert r1["prose"] == "むかしむかし、あるところに。"
    # 2 シーン目のプロンプトに直前散文の末尾(スライディングウィンドウ)が入る
    second_user = captured_messages[1][1]["content"]
    assert "直前シーンの末尾" in second_user
    assert "むかしむかし" in second_user


def test_system_prompt_is_preset_text_plus_constraints(store, monkeypatch):
    captured = []

    async def fake_stream(messages, **kwargs):
        captured.append(messages)
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.upsert_preset({
        "name": "カスタム", "person": "third",
        "tone": "あなたはハードボイルド小説の名手です。乾いた文体で書いてください。",
    })
    node_id = store.canon_path()[0]
    collect_sse(rendering.render_stream(store, "http://fake", [node_id], preset["id"], None))
    system = captured[0][0]["content"]
    # プリセット全文が先頭、制約が末尾に自動追加される
    assert system.startswith("あなたはハードボイルド小説の名手です")
    assert "シーンに書かれている出来事以外を発生させない" in system
    assert "人称: 三人称" in system


def test_render_pov_filters_state(store, monkeypatch):
    store.replace_events(store.canon_path()[0], [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        {"type": "char_introduce", "payload": {"char": "ken"}},
        {"type": "fact_set", "payload": {"scope": "char", "char": "ken", "key": "secret", "value": "実は王子"}},
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "goal", "value": "薬草採取"}},
    ])
    captured = []

    async def fake_stream(messages, **kwargs):
        captured.append(messages)
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    node_id = store.canon_path()[0]
    collect_sse(rendering.render_stream(store, "http://fake", [node_id], preset["id"], "aya"))
    user = captured[0][1]["content"]
    # pov のアヤが知る情報のみ: ケンの secret は含まれない
    assert "薬草採取" in user
    assert "実は王子" not in user


def test_branch_node_render_is_retrievable(store, monkeypatch):
    """分岐(正史パス外)のシーンも清書して取り出せる。

    構造モードの清書タブは正史に限らず選択中のシーンを映すので、
    list_renders(正史のみ)ではなく latest_render で引ける必要がある。
    """
    async def fake_stream(messages, **kwargs):
        yield "分岐の本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    branch = store.append_node(
        {"beat": "もし橋を渡らなかったら", "cast": ["aya"], "status": "draft"},
        [],
        parent_id=store.canon_path()[0],
    )
    assert branch["id"] not in store.canon_path()
    collect_sse(rendering.render_stream(store, "http://fake", [branch["id"]], preset["id"], None))
    assert store.latest_render(branch["id"], preset["id"], None)["prose"] == "分岐の本文"


def test_stale_marked_on_upstream_edit(store, monkeypatch):
    async def fake_stream(messages, **kwargs):
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    path = store.canon_path()
    collect_sse(rendering.render_stream(store, "http://fake", path, preset["id"], None))
    assert store.latest_render(path[1], preset["id"], None)["stale"] == 0
    # 上流ビートを編集 → 下流のレンダーが stale になる
    store.update_node(path[0], {"beat": "編集後のビート"})
    assert store.latest_render(path[0], preset["id"], None)["stale"] == 1
    assert store.latest_render(path[1], preset["id"], None)["stale"] == 1

