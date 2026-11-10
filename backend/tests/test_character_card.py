"""キャラクターカードの書き出し(docs/design/character-card.md、形式は docs/reference/character-card-format.md)。"""
import json
import zipfile
from datetime import datetime
from pathlib import Path

import pytest

import character_card
import chat_agent
import db
import embed
from store import Store


@pytest.fixture
def lib(tmp_path, monkeypatch):
    """ライブラリのフォルダを持つストア(画像・参照音声を同梱するため)。3 シーンの直列。"""
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    root = tmp_path / "雨の町"
    root.mkdir()
    s = Store(db.connect(root / "story-graph.db"), root=str(root))
    s.create_character({"name": "アヤ", "id": "aya", "profile": "面倒見がよい", "appearance": "黒髪の女性",
                        "voice": "丁寧語"})
    s.create_character({"name": "ケン", "id": "ken", "profile": "実は密偵という秘密", "appearance": "背の高い男"})
    s.create_character({"name": "ポチ", "id": "pochi", "appearance": "柴犬。" + "茶" * 100})
    s.update_character("aya", {"reading": "あや"})
    s.append_node({"id": "n1", "beat": "出会い", "cast": ["aya", "ken", "pochi"], "title": "第一話"}, [
        {"type": "char_introduce", "payload": {"char": "aya"}},
        {"type": "char_introduce", "payload": {"char": "ken"}},
        {"type": "char_introduce", "payload": {"char": "pochi"}},
        {"type": "memory_add", "payload": {"char": "aya", "content": "石橋でケンと出会った", "importance": 0.9}},
        {"type": "memory_add", "payload": {"char": "ken", "content": "アヤを見張れと命じられた", "importance": 0.9}},
        {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": 0.2, "reason": "親切"}},
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "居場所", "value": "石橋の町"}},
        {"type": "fact_set", "payload": {"scope": "world", "key": "天気", "value": "雨が止まない"}},
    ])
    s.append_node({"id": "n2", "beat": "散歩", "cast": ["aya", "pochi"], "title": "第二話"}, [
        {"type": "relationship_update", "payload": {"char": "aya", "target": "pochi", "delta": 0.7, "reason": "散歩", "label": "相棒"}},
    ])
    s.append_node({"id": "n3", "beat": "裏切り", "cast": ["aya", "ken"], "title": "第三話"}, [
        {"type": "memory_add", "payload": {"char": "aya", "content": "ケンの裏切りを知った", "importance": 0.8}},
        {"type": "relationship_update", "payload": {"char": "aya", "target": "ken", "delta": -0.9, "reason": "裏切り", "label": "疑念"}},
        {"type": "fact_set", "payload": {"scope": "char", "char": "aya", "key": "居場所", "value": "港"}},
    ])
    return s


def _asset(lib, sub, name, data=b"x"):
    folder = Path(lib.root) / "assets" / sub
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(data)
    return name


def test_card_fields(lib):
    build = character_card.build_card(lib, "aya", "n3", now=datetime(2026, 11, 10, 18, 10))
    card = build.card
    assert card["format"] == "story-graph-character-card" and card["version"] == 1
    assert card["language"] == "ja"
    assert card["source"] == {
        "app": "story-graph",
        "character_id": "aya",
        "node_id": "n3",
        "library": "雨の町",
        "label": "「第三話」の直後",
        "exported_at": "2026-11-10 18:10",
    }
    assert (card["name"], card["reading"], card["profile"], card["appearance"], card["speech"]) == (
        "アヤ", "あや", "面倒見がよい", "黒髪の女性", "丁寧語")
    assert card["situation"] == ["居場所: 港"]
    assert card["world"] == ["天気: 雨が止まない"]
    # 無い項目は項目ごと省く
    assert "images" not in card and "voice" not in card and "summary" not in card


def test_app_version_and_label(lib, monkeypatch):
    monkeypatch.setenv("STORY_GRAPH_APP_VERSION", "0.1.0")
    card = character_card.build_card(lib, "aya", "n3", label="  三話のあと ").card
    assert card["source"]["app_version"] == "0.1.0"
    assert card["source"]["label"] == "三話のあと"
    lib.update_node("n3", {"title": ""})
    assert character_card.build_card(lib, "aya", "n3").card["source"]["label"] == "(無題)の直後"


def test_card_is_a_snapshot_of_the_anchor(lib):
    """道より先の記憶・関係・事実は入らない。"""
    early = character_card.build_card(lib, "aya", "n1").card
    assert early["source"]["node_id"] == "n1"
    assert early["situation"] == ["居場所: 石橋の町"]
    assert [m["text"] for m in early["memories"]] == ["石橋でケンと出会った"]
    assert [r["name"] for r in early["relationships"]] == ["ケン"]
    assert "疑念" not in json.dumps(early, ensure_ascii=False)
    # アンカー無しは正史の末尾
    assert character_card.build_card(lib, "aya", None).card["source"]["node_id"] == "n3"


def test_knowledge_boundary(lib):
    """他人の内面(profile)と他人の記憶は入らない。外見は短くして入る。"""
    text = json.dumps(character_card.build_card(lib, "aya", "n3").card, ensure_ascii=False)
    assert "密偵" not in text and "見張れ" not in text
    rels = {r["name"]: r for r in character_card.build_card(lib, "aya", "n3").card["relationships"]}
    assert rels["ポチ"]["appearance"] == chat_agent.appearance_hint(lib.get_character("pochi"))
    assert rels["ポチ"]["appearance"].endswith("…")


def test_relationships_are_words_ordered_by_strength(lib):
    rels = character_card.build_card(lib, "aya", "n3").card["relationships"]
    # ケンは 0.2 - 0.9 = -0.7、ポチは +0.7。同じ強さなら元の順(ケンが先)
    assert [r["name"] for r in rels] == ["ケン", "ポチ"]
    assert rels[0]["feeling"] == "強い憎しみ・恐れ「疑念」"
    assert rels[1]["feeling"] == "深い信頼・愛情「相棒」"
    assert all(set(r) <= {"name", "appearance", "feeling"} for r in rels)  # 数値を入れない
    # 削除済みの相手は省く
    lib.conn.execute("DELETE FROM characters WHERE id = 'pochi'")
    assert [r["name"] for r in character_card.build_card(lib, "aya", "n3").card["relationships"]] == ["ケン"]


def test_memories_all_recent_first_then_importance(lib):
    lib.replace_events("n1", lib.list_events("n1") + [
        {"type": "memory_add", "payload": {"char": "aya", "content": f"昔のこと{i}", "importance": i / 100}}
        for i in range(30)
    ])
    lib.replace_events("n3", lib.list_events("n3") + [
        {"type": "memory_add", "payload": {"char": "aya", "content": "さっきの些細なこと", "importance": 0.05}},
    ])
    memories = [m["text"] for m in character_card.build_card(lib, "aya", "n3").card["memories"]]
    assert len(memories) == 33  # 15 件に絞らず全件
    recent = memories[: chat_agent.CHARACTER_RECENT_SLOTS]
    assert "さっきの些細なこと" in recent and "ケンの裏切りを知った" in recent
    rest = memories[chat_agent.CHARACTER_RECENT_SLOTS:]
    assert rest[0] == "石橋でケンと出会った"  # 残りは重要度の高い順(0.9)
    assert rest[-1] == "昔のこと0"


def test_memories_have_when_only_with_elapsed(lib):
    assert all("when" not in m for m in character_card.build_card(lib, "aya", "n3").card["memories"])
    lib.update_node("n2", {"elapsed_unit": "day", "elapsed_count": 1})
    lib.update_node("n3", {"elapsed_unit": "day", "elapsed_count": 2})
    when = {m["text"]: m.get("when") for m in character_card.build_card(lib, "aya", "n3").card["memories"]}
    assert when == {"ケンの裏切りを知った": "今日", "石橋でケンと出会った": "3日前"}


def test_images_and_voice_are_bundled(lib, tmp_path):
    lib.update_character("aya", {
        "portrait_path": _asset(lib, "images", "abc123.PNG", b"avatar"),
        "ref_image_path": _asset(lib, "images", "def456.webp", b"reference"),
    })
    profile = lib.create_voice_profile({
        "name": "アヤの声", "caption": "落ち着いた女性の声", "seed": 0,
        "ref_paths": [_asset(lib, "voices", "v1.wav", b"wav1"), _asset(lib, "voices", "v2.mp3", b"mp3")],
        "preset": "engine-voice-7", "params": {"num_steps": 16},
    })
    lib.update_character("aya", {"voice_profile_id": profile["id"]})

    dest = tmp_path / "out" / "aya"  # 拡張子が無ければ足す。フォルダが無ければ作る
    result = character_card.export_card(lib, "aya", "n3", str(dest))
    assert result["path"].endswith("aya.zip") and result["notes"] == []
    assert result["counts"]["images"] == 2 and result["counts"]["voice_refs"] == 2 and result["has_voice"]
    assert not list(dest.parent.glob("*.part"))

    with zipfile.ZipFile(result["path"]) as zf:
        names = set(zf.namelist())
        card = json.loads(zf.read("card.json").decode("utf-8"))
        assert zf.read("images/avatar.png") == b"avatar"
        assert zf.read("voice/ref2.mp3") == b"mp3"
    assert card["images"] == [
        {"file": "images/avatar.png", "role": "avatar"},
        {"file": "images/reference.webp", "role": "reference"},
    ]
    # seed の 0 は値なので残す。エンジンに依存する preset / params は入れない
    assert card["voice"] == {"caption": "落ち着いた女性の声", "seed": 0, "refs": ["voice/ref1.wav", "voice/ref2.mp3"]}
    referenced = {i["file"] for i in card["images"]} | set(card["voice"]["refs"])
    assert names == referenced | {"card.json"}


def test_missing_files_and_voices_are_noted(lib):
    lib.update_character("aya", {"portrait_path": "gone.png"})
    build = character_card.build_card(lib, "aya", "n3")
    assert "images" not in build.card and "voice" not in build.card
    assert any("gone.png" in n for n in build.notes)
    assert any("声が割り当てられていません" in n for n in build.notes)

    # エンジン側の声 ID しか無い声はカードに入れない
    preset_only = lib.create_voice_profile({"name": "登録済みの声", "preset": "engine-voice-7"})
    lib.update_character("aya", {"voice_profile_id": preset_only["id"]})
    build = character_card.build_card(lib, "aya", "n3")
    assert "voice" not in build.card
    assert any("登録済みの声" in n for n in build.notes)

    # 参照音声が消えていても説明があれば声は入る
    profile = lib.create_voice_profile({"name": "声", "caption": "低い声", "ref_paths": ["lost.wav"]})
    lib.update_character("aya", {"voice_profile_id": profile["id"]})
    build = character_card.build_card(lib, "aya", "n3")
    assert build.card["voice"] == {"caption": "低い声"}
    assert any("lost.wav" in n for n in build.notes)


def test_suggested_name(lib):
    lib.update_node("n3", {"title": 'A/B: "三話"?'})
    assert character_card.build_card(lib, "aya", "n3").summary()["suggested_name"] == "アヤ@A_B_ _三話__.zip"
    lib.update_node("n3", {"title": "長" * 200})
    name = character_card.build_card(lib, "aya", "n3").summary()["suggested_name"]
    assert name.endswith(".zip") and len(name) == character_card.FILE_NAME_MAX + 4


def test_refusals(lib):
    with pytest.raises(KeyError):
        character_card.build_card(lib, "nobody", "n3")
    with pytest.raises(ValueError, match="シーンが見つかりません"):
        character_card.build_card(lib, "aya", "no-such-node")
    empty = Store(db.connect(":memory:"))
    empty.create_character({"name": "アヤ", "id": "aya"})
    with pytest.raises(ValueError, match="シーンが 1 つも無い"):
        character_card.build_card(empty, "aya", None)


def test_export_does_not_change_the_story(lib, tmp_path):
    def dump():
        return {t: [tuple(r) for r in lib.conn.execute(f"SELECT * FROM {t} ORDER BY rowid")]
                for t in ("characters", "nodes", "edges", "events", "memories", "voice_profiles")}

    before = dump()
    character_card.export_card(lib, "aya", "n2", str(tmp_path / "card.zip"))
    assert dump() == before
    assert not (Path(lib.root) / "assets").exists()  # 素材のフォルダを勝手に作らない
