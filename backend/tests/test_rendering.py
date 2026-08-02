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


def test_render_saves_meta_and_prompt_messages(store, monkeypatch):
    # 清書には生成統計(meta)と、生成時に LLM へ送った messages の控え
    # (prompt_messages)を保存する(UI の閲覧用)
    captured = []

    async def fake_stream(messages, *, stats_out=None, **kwargs):
        captured.append(messages)
        if stats_out is not None:
            stats_out.update({"tokens": 100, "prompt_tokens": 500, "elapsed_sec": 2.5,
                              "tokens_per_sec": 40.0, "finish_reason": "stop"})
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    node_id = store.canon_path()[0]
    events = collect_sse(rendering.render_stream(store, "http://fake", [node_id], preset["id"], None))
    emitted = next(e["render"] for e in events if "scene_done" in e)
    saved = store.latest_render(node_id, preset["id"], None)
    for r in (emitted, saved):
        assert r["meta"] == {"tokens": 100, "elapsed_sec": 2.5, "tokens_per_sec": 40.0, "finish_reason": "stop"}
        assert r["prompt_messages"] == captured[0]


def test_render_meta_is_null_when_stats_unavailable(store, monkeypatch):
    # サーバーが timings / usage を返さないときは meta を残さない(控えは残す)
    async def fake_stream(messages, **kwargs):
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    node_id = store.canon_path()[0]
    collect_sse(rendering.render_stream(store, "http://fake", [node_id], preset["id"], None))
    saved = store.latest_render(node_id, preset["id"], None)
    assert saved["meta"] is None
    assert saved["prompt_messages"] is not None


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


def test_target_chars_adds_length_instruction_and_raises_max_tokens(store, monkeypatch):
    captured = []

    async def fake_stream(messages, **kwargs):
        captured.append((messages, kwargs))
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    node_id = store.canon_path()[0]
    collect_sse(rendering.render_stream(store, "http://fake", [node_id], preset["id"], None, 2000))
    system, kwargs = captured[0][0][0]["content"], captured[0][1]
    # 目安の前後 ±25% を幅として示す(数値ぴったりは狙わせない)
    assert "分量: 日本語で 1500〜2500 字程度" in system
    # 長い指定でも途中で切れないよう max_tokens が上がる
    assert kwargs["max_tokens"] == 5000


def test_node_target_chars_overrides_the_shared_default(store, monkeypatch):
    """シーン個別の分量が共通の設定より優先される(一括清書でシーンごとに変わる)。"""
    captured = []

    async def fake_stream(messages, **kwargs):
        captured.append((messages, kwargs))
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    path = store.canon_path()
    store.set_node_target_chars(path[0], 2000)  # 1 シーン目だけ長め
    collect_sse(rendering.render_stream(store, "http://fake", path, preset["id"], None, 600))
    first, second = captured[0][0][0]["content"], captured[1][0][0]["content"]
    assert "1500〜2500 字程度" in first  # 個別指定の 2000
    assert "450〜750 字程度" in second  # 共通の 600
    assert captured[0][1]["max_tokens"] == 5000
    assert captured[1][1]["max_tokens"] == 1500


def test_node_target_chars_applies_without_shared_default(store, monkeypatch):
    """共通がおまかせでも、指定のあるシーンだけ分量が効く。"""
    captured = []

    async def fake_stream(messages, **kwargs):
        captured.append((messages, kwargs))
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    path = store.canon_path()
    store.set_node_target_chars(path[1], 800)
    collect_sse(rendering.render_stream(store, "http://fake", path, preset["id"], None))
    assert "分量:" not in captured[0][0][0]["content"]
    assert "600〜1000 字程度" in captured[1][0][0]["content"]
    # 0 を渡すと個別指定を外せる(共通に戻る)
    store.set_node_target_chars(path[1], 0)
    assert store.get_node(path[1])["target_chars"] is None


def test_no_length_instruction_by_default(store, monkeypatch):
    captured = []

    async def fake_stream(messages, **kwargs):
        captured.append((messages, kwargs))
        yield "本文"

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    preset = store.list_presets()[0]
    node_id = store.canon_path()[0]
    collect_sse(rendering.render_stream(store, "http://fake", [node_id], preset["id"], None))
    assert "分量:" not in captured[0][0][0]["content"]
    assert captured[0][1]["max_tokens"] == rendering.DEFAULT_MAX_TOKENS


def test_list_renders_scoped_to_group(store):
    """鑑賞モードのスコープ: group_id を渡すとその章のシーンだけを鎖の順に返す。

    島の章(正史パス外)でも読めることが要点。存在しない章 ID は空。
    """
    preset = store.list_presets()[0]
    canon = store.canon_path()
    chapter = store.create_group("第一章", [canon[0]])
    i1 = store.append_node({"beat": "島1", "cast": ["aya"], "title": "島の1"}, [], detached=True)
    i2 = store.append_node({"beat": "島2", "cast": ["aya"], "title": "島の2"}, [], parent_id=i1["id"])
    island = store.create_group("作り置きの章", [i2["id"], i1["id"]])
    assert island["on_canon"] is False

    assert [e["node"]["id"] for e in store.list_renders(preset["id"], None)] == canon
    assert [e["node"]["id"] for e in store.list_renders(preset["id"], None, chapter["id"])] == [canon[0]]
    # 島の章も鎖の順で読める(正史パスには 1 つも入っていない)
    assert [e["node"]["id"] for e in store.list_renders(preset["id"], None, island["id"])] == [
        i1["id"],
        i2["id"],
    ]
    assert store.list_renders(preset["id"], None, "no-such-group") == []


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
    # ビート編集はプロンプト文面のみ → 自シーンだけ stale(フェーズ A で変更。
    # 下流の清書は状態と直前散文にしか依存しないので保たれる)
    store.update_node(path[0], {"beat": "編集後のビート"})
    assert store.latest_render(path[0], preset["id"], None)["stale"] == 1
    assert store.latest_render(path[1], preset["id"], None)["stale"] == 0
    # 状態に効く編集(イベント書き換え)は従来どおり下流の清書も stale になる
    store.replace_events(path[0], [
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "goal", "value": "旅"}},
    ])
    assert store.latest_render(path[1], preset["id"], None)["stale"] == 1



def test_chapter_digest_survives_the_memory_limit(store):
    """章のまとめ(要約記憶)は、当章の記憶が増えても清書の枠から落ちない。

    従来は末尾 MEMORY_LIMIT 件を渡すだけだったので、当章の記憶が枠を超えると
    前章までのまとめが押し出され、長い物語ほど過去が見えなくなっていた
    (2026-08-02 ユーザー指摘)。
    """
    path = store.canon_path()
    # 第一章(1 シーン)に記憶を積んでまとめる
    store.replace_events(path[0], store.list_events(path[0]) + [
        {"type": "memory_add", "payload": {"char": "aya", "content": "石橋で誓った", "importance": 0.9}},
    ])
    g = store.create_group("第一章", [path[0]])
    old = [e["id"] for e in store.list_events(path[0]) if e["type"] == "memory_add"]
    store.save_group_digest(g["id"], [
        {"type": "memory_compress",
         "payload": {"char": "aya", "replaces": old, "summary": "第一章で誓いを立てた", "importance": 0.9}},
    ])
    # 第二話(章の外)に、枠を超える数の記憶を積む
    store.replace_events(path[1], store.list_events(path[1]) + [
        {"type": "memory_add", "payload": {"char": "aya", "content": f"当章の出来事{i}", "importance": 0.4}}
        for i in range(rendering.MEMORY_LIMIT + 4)
    ])
    memories = store.get_state(path[1])["chars"]["aya"]["memories"]
    assert len(memories) > rendering.MEMORY_LIMIT

    contents = rendering._memory_contents(store, memories)
    assert len(contents) <= rendering.MEMORY_LIMIT
    assert "第一章で誓いを立てた" in contents  # まとめは残る
    assert any(c.startswith("当章の出来事") for c in contents)  # 直近も入る
