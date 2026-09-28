import asyncio

import pytest

import db
import llm as llm_mod
import tts
import tts_manager
import voice
from store import Store


# ---- エンジン定義とテンプレート ------------------------------------------------

def test_irodori_engine_definition_loads():
    engine = tts.get_engine("irodori")
    assert engine["id"] == "irodori"
    assert engine["style_map"] in tts.STYLE_MAPS
    assert any(e["id"] == "irodori" for e in tts.list_engines())


def test_get_engine_rejects_path_like_ids():
    for bad in ("../x", "a/b", "IRODORI"):
        try:
            tts.get_engine(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad} は拒否されるべき")


def test_fill_keeps_type_and_drops_empty():
    spec = {"a": "{seed}", "b": "x-{port}", "c": {"d": "{caption}"}, "e": ["{ref_path}"]}
    filled = tts.fill(spec, {"seed": 7, "port": 8088, "caption": "", "ref_path": None})
    assert filled == {"a": 7, "b": "x-8088"}


def test_deep_merge_nested_without_mutating_base():
    base = {"irodori": {"num_steps": 24}, "voice": "none"}
    merged = tts.deep_merge(base, {"irodori": {"seed": 1}})
    assert merged == {"irodori": {"num_steps": 24, "seed": 1}, "voice": "none"}
    assert base == {"irodori": {"num_steps": 24}, "voice": "none"}


def test_build_request_caption_voice_and_seed():
    engine = tts.get_engine("irodori")
    line = {"text": "こんにちは。", "kind": "dialogue", "emotion": "neutral"}
    body = tts.build_request(engine, line, {"caption": "落ち着いた女性の声", "ref_path": "", "seed": 5})
    assert body["model"] == "irodori-tts"
    assert body["voice"] == "none"
    assert body["input"] == "こんにちは。"
    assert body["irodori"]["caption"] == "落ち着いた女性の声"
    assert body["irodori"]["seed"] == 5
    assert "ref_wavs" not in body["irodori"]


def test_build_request_reference_and_extra_override():
    engine = tts.get_engine("irodori")
    line = {"text": "はい。", "kind": "dialogue"}
    body = tts.build_request(
        engine, line, {"caption": "", "ref_path": r"D:\voices\a.wav", "seed": 1}, {"irodori": {"num_steps": 16}}
    )
    assert body["irodori"]["ref_wavs"] == [r"D:\voices\a.wav"]
    assert body["irodori"]["num_steps"] == 16
    assert "caption" not in body["irodori"]


def test_irodori_emoji_style_map():
    assert tts.irodori_emoji({"text": "やった!", "emotion": "joy"})[0] == "😊やった!"
    assert tts.irodori_emoji({"text": "やった!", "emotion": "joy", "intensity": 0.9})[0] == "😊😊やった!"
    assert tts.irodori_emoji({"text": "雨だった。", "kind": "narration"})[0] == "📖雨だった。"
    assert tts.irodori_emoji({"text": "え?", "emotion": "unknown", "kind": "dialogue"})[0] == "え?"


def test_launch_spec_fills_port_and_models_dir(tmp_path):
    engine = tts.get_engine("irodori")
    settings = {"tts_base_url": "http://127.0.0.1:9123", "tts_models_dir": str(tmp_path)}
    cmd, env = tts_manager.launch_spec(engine, settings, "C:/uv/uv.exe")
    assert cmd[0] == "C:/uv/uv.exe"
    assert cmd[cmd.index("--port") + 1] == "9123"
    assert env["HF_HOME"].endswith("/hf-cache")
    assert "\\" not in env["HF_HOME"]


def test_launch_spec_without_models_dir_drops_hf_home(monkeypatch):
    monkeypatch.setattr(tts_manager, "DEFAULT_MODELS_DIR", r"Z:\does-not-exist")
    engine = tts.get_engine("irodori")
    _, env = tts_manager.launch_spec(engine, {}, "uv")
    assert "HF_HOME" not in env
    assert env["IRODORI_PRELOAD"] == "true"


# ---- 台本 ------------------------------------------------------------------

def test_build_script_splits_dialogue_and_narration():
    prose = "　雨が降っていた。彼女は窓を見た。\n「行かないで。……お願い」\nと、彼女は言った。"
    lines = voice.build_script(prose)
    assert [(l["kind"], l["text"]) for l in lines] == [
        ("narration", "雨が降っていた。"),
        ("narration", "彼女は窓を見た。"),
        ("dialogue", "「行かないで。……お願い」"),
        ("narration", "と、彼女は言った。"),
    ]
    assert all(l["speaker"] == "narrator" and l["emotion"] == "neutral" for l in lines)
    assert lines[0]["pause_after_ms"] == voice.PAUSE_SENTENCE_MS
    assert lines[1]["pause_after_ms"] == voice.PAUSE_PARAGRAPH_MS


def test_build_script_keeps_punctuation_runs_together():
    lines = voice.build_script("本当に!?　嘘でしょう。")
    assert [l["text"] for l in lines] == ["本当に!?", "嘘でしょう。"]


def test_build_script_scene_break_becomes_pause():
    lines = voice.build_script("一日目が終わった。\n\n＊＊＊\n\n朝が来た。")
    assert [l["text"] for l in lines] == ["一日目が終わった。", "朝が来た。"]
    assert lines[0]["pause_after_ms"] == voice.PAUSE_SCENE_BREAK_MS


def test_build_script_long_dialogue_is_split():
    long_quote = "「" + "今日はとても長い一日だった。" * 15 + "」"
    lines = voice.build_script(long_quote)
    assert len(lines) > 1
    assert all(l["kind"] == "dialogue" for l in lines)
    assert "".join(l["text"] for l in lines) == long_quote


def test_build_script_unclosed_quote_is_still_read():
    lines = voice.build_script("「待って")
    assert [(l["kind"], l["text"]) for l in lines] == [("dialogue", "「待って")]


# ---- 声・キャッシュ --------------------------------------------------------

def test_narrator_voice_defaults_seed():
    v = voice.narrator_voice({"tts_narrator_caption": " 若い男性 "})
    assert v == {"caption": "若い男性", "ref_path": "", "seed": voice.DEFAULT_SEED}


def test_extra_body_must_be_object():
    assert voice.extra_body({"tts_extra_body": '{"irodori": {"num_steps": 20}}'}) == {"irodori": {"num_steps": 20}}
    for bad in ("[1]", "{oops"):
        try:
            voice.extra_body({"tts_extra_body": bad})
        except ValueError:
            continue
        raise AssertionError(bad)


def test_cache_key_changes_with_body_and_ref_file(tmp_path):
    ref = tmp_path / "a.wav"
    ref.write_bytes(b"1")
    body = {"input": "あ"}
    k1 = voice.cache_key("irodori", body, {"ref_path": str(ref)})
    assert k1 == voice.cache_key("irodori", dict(body), {"ref_path": str(ref)})
    assert k1 != voice.cache_key("irodori", {"input": "い"}, {"ref_path": str(ref)})
    ref.write_bytes(b"12")
    assert k1 != voice.cache_key("irodori", body, {"ref_path": str(ref)})


def test_speak_uses_cache(tmp_path, monkeypatch):
    calls = []

    async def fake_synth(base_url, body, timeout=300.0):
        calls.append(body)
        return b"RIFF"

    monkeypatch.setattr(tts, "synthesize", fake_synth)
    engine = tts.get_engine("irodori")
    line = {"text": "こんにちは。", "kind": "dialogue"}
    p1 = asyncio.run(voice.speak({}, engine, line, "http://x", tmp_path))
    p2 = asyncio.run(voice.speak({}, engine, line, "http://x", tmp_path))
    assert p1 == p2 and p1.read_bytes() == b"RIFF"
    assert len(calls) == 1
    assert voice.cache_status(tmp_path) == {"files": 1, "bytes": 4}
    assert voice.clear_cache(tmp_path) == 1


# ---- Step 2: 台本の保存・引き継ぎ・LLM での話者と感情 ---------------------------


@pytest.fixture
def store():
    s = Store(db.connect(":memory:"))
    s.create_character({"name": "アヤ", "id": "aya", "voice": "一人称は「あたし」"})
    s.create_character({"name": "ケン", "id": "ken"})
    s.create_character({"name": "ミナ", "id": "mina"})
    s.append_node({"beat": "出会い", "cast": ["aya"], "title": "第一話"})
    return s


def _node_id(s):
    return s.canon_path()[0]


PROSE2 = "雨だった。\n「待って」とアヤが言った。\n「なんだよ」ケンは振り返った。"


def test_build_script_keeps_source_text():
    lines = voice.build_script("雨だった。")
    assert lines[0]["source_text"] == "雨だった。"


def test_normalize_lines_fixes_bad_values():
    lines = voice.normalize_lines(
        [
            {"text": " こんにちは ", "speaker": "../x", "emotion": "angry", "intensity": 3, "pause_after_ms": -5, "kind": "x"},
            {"text": "   "},
            "oops",
            {"text": "はい", "speaker": "char:aya", "emotion": "joy", "kind": "dialogue", "edited": 1},
        ]
    )
    assert len(lines) == 2
    assert lines[0] == {
        "speaker": "narrator", "kind": "narration", "text": "こんにちは", "source_text": "こんにちは",
        "emotion": "neutral", "intensity": 1.0, "pause_after_ms": 0, "edited": False,
    }
    assert lines[1]["speaker"] == "char:aya" and lines[1]["edited"] is True


def test_carry_over_matches_source_text_in_order():
    old = voice.build_script("「はい」\n「はい」\n雨だった。")
    old[0].update(speaker="char:aya", emotion="joy")
    old[1].update(speaker="char:ken")
    old[2].update(text="あめだった。", edited=True)
    new = voice.build_script("雨だった。\n「はい」\n「はい」\n晴れた。")
    assert voice.carry_over(new, old) == 3
    assert new[0]["text"] == "あめだった。" and new[0]["edited"] is True
    assert [new[1]["speaker"], new[2]["speaker"]] == ["char:aya", "char:ken"]
    assert new[3]["text"] == "晴れた。" and new[3]["edited"] is False


def test_resolve_script_prefers_saved_then_carries_from_previous_render(store):
    nid = _node_id(store)
    r1 = store.save_render(nid, "p", None, PROSE2)
    fresh = voice.resolve_script(store, r1)
    assert fresh["saved"] is False and fresh["source"] == "rule"
    lines = fresh["lines"]
    lines[1]["speaker"] = "char:aya"
    store.save_voice_script(r1["id"], nid, lines, "llm")
    assert voice.resolve_script(store, r1)["saved"] is True

    r2 = store.save_render(nid, "p", None, PROSE2 + "\n終わり。")
    carried = voice.resolve_script(store, r2)
    assert carried["saved"] is False and carried["carried"] == len(lines)
    assert carried["lines"][1]["speaker"] == "char:aya"


def test_delete_node_removes_voice_scripts(store):
    nid = store.append_node({"beat": "二話", "cast": []})["id"]
    r = store.save_render(nid, "p", None, "雨。")
    store.save_voice_script(r["id"], nid, voice.build_script("雨。"), "rule")
    store.delete_node(nid)
    assert store.get_voice_script(r["id"]) is None


def test_annotate_script_sets_dialogue_speakers_and_skips_edited(store, monkeypatch):
    nid = _node_id(store)
    render = store.save_render(nid, "p", "aya", PROSE2)
    lines = voice.build_script(PROSE2)
    lines[2]["edited"] = True
    captured = {}

    async def fake_chat_json(messages, **kwargs):
        captured["messages"] = messages
        captured["schema"] = kwargs["schema"]
        return {
            "lines": [
                {"i": 0, "speaker": "char:aya", "emotion": "sad", "intensity": 0.6},
                {"i": 1, "speaker": "char:aya", "emotion": "fear", "intensity": 1.7},
                {"i": 2, "speaker": "char:ken", "emotion": "anger", "intensity": 0.9},
                {"i": 99, "speaker": "narrator", "emotion": "joy", "intensity": 0.5},
            ]
        }

    monkeypatch.setattr(llm_mod, "chat_json", fake_chat_json)
    out = asyncio.run(voice.annotate_script(store, render, lines, "http://llm"))
    # 候補は cast(アヤ)+ 本文に名前が出てくるキャラ(ケン)。出てこないミナは入らない
    assert captured["schema"]["properties"]["lines"]["items"]["properties"]["speaker"]["enum"] == [
        "narrator", "char:aya", "char:ken",
    ]
    assert "視点人物: アヤ" in captured["messages"][1]["content"]
    assert out[0]["speaker"] == "narrator" and out[0]["emotion"] == "sad"  # 地の文は話者を変えない
    assert out[1]["speaker"] == "char:aya" and out[1]["intensity"] == 1.0
    assert out[2]["speaker"] == "narrator" and out[2]["emotion"] == "neutral"  # 手で直した行は触らない
    assert lines[1]["speaker"] == "narrator"  # 入力は変更しない


# ---- 音声キャッシュの掃除 ----------------------------------------------------

def _touch_old(path, now):
    import os

    path.write_bytes(b"x")
    os.utime(path, (now - 3600, now - 3600))


def test_latest_renders_picks_one_per_node_preset_pov(store):
    nid = _node_id(store)
    store.save_render(nid, "p", None, "古い。")
    new = store.save_render(nid, "p", None, "新しい。")
    other_pov = store.save_render(nid, "p", "aya", "視点違い。")
    ids = {r["id"] for r in store.latest_renders()}
    assert ids == {new["id"], other_pov["id"]}


def test_gc_keeps_audio_of_unchanged_sentences_after_rerender(store, tmp_path):
    import time

    engine = tts.get_engine("irodori")
    nid = _node_id(store)
    settings: dict[str, str] = {}
    old = store.save_render(nid, "p", None, "雨だった。\n風が吹いた。")
    old_names = {voice.line_audio(settings, engine, l)[0] for l in voice.build_script(old["prose"])}
    now = time.time()
    for name in old_names:
        _touch_old(tmp_path / name, now)
    _touch_old(tmp_path / "stale-preview.opus", now)
    fresh = tmp_path / "just-made.opus"
    fresh.write_bytes(b"x")  # 猶予内(合成した直後)は消さない

    store.save_render(nid, "p", None, "雨だった。\n晴れた。")  # 清書を上書き
    keep = voice.expected_audio(store, settings)
    removed = voice.sweep_audio(tmp_path, keep, now=now)

    kept_same = voice.line_audio(settings, engine, voice.build_script("雨だった。")[0])[0]
    gone = voice.line_audio(settings, engine, voice.build_script("風が吹いた。")[0])[0]
    assert (tmp_path / kept_same).exists()  # 変わらなかった文は使い回す
    assert not (tmp_path / gone).exists()
    assert not (tmp_path / "stale-preview.opus").exists()
    assert fresh.exists()
    assert removed == 2


def test_gc_follows_voice_settings_and_saved_script(store, tmp_path):
    engine = tts.get_engine("irodori")
    nid = _node_id(store)
    render = store.save_render(nid, "p", None, "雨だった。")
    line = voice.build_script("雨だった。")[0]
    before = voice.expected_audio(store, {"tts_narrator_seed": "1"})
    after = voice.expected_audio(store, {"tts_narrator_seed": "2"})
    assert before and before.isdisjoint(after)  # 声を変えると前の音声は使われない

    edited = dict(line, text="あめだった。", edited=True)
    store.save_voice_script(render["id"], nid, [edited], "rule")
    assert voice.expected_audio(store, {}) == {voice.line_audio({}, engine, edited)[0]}


def test_gc_refuses_when_voice_settings_are_broken(store):
    store.save_render(_node_id(store), "p", None, "雨だった。")
    with pytest.raises(ValueError):
        voice.expected_audio(store, {"tts_narrator_seed": "abc"})


def test_irodori_uses_opus():
    name, body = voice.line_audio({}, tts.get_engine("irodori"), voice.build_script("雨。")[0])
    assert body["response_format"] == "opus" and name.endswith(".opus")
