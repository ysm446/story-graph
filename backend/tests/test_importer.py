"""取り込み JSON(importer)の検査と一括登録を確認する。"""

import copy
import subprocess
import sys
from pathlib import Path

import pytest

import db
import embed
import importer
from store import Store


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    root = tmp_path / "library"
    root.mkdir()
    s = Store(db.connect(root / "story-graph.db"), root=str(root))
    yield s
    s.conn.close()


def sample():
    return {
        "format": "story-graph-import",
        "version": 1,
        "title": "港の話",
        "characters": [
            {"name": "アヤ", "reading": "あや", "profile": "測量士", "voice": "短く言い切る"},
            {"name": "ケン", "profile": "漁師"},
        ],
        "places": [{"name": "港", "description": "古い防波堤", "atmosphere": "潮の匂い"}],
        "documents": [{"title": "測量組合", "category": "組織", "body": "本文", "status": "confirmed", "ai_mode": "always"}],
        "chapters": [{"title": "第一幕", "scenes": ["出発", "橋の上"]}, {"title": "第二幕", "scenes": ["k3"]}],
        "scenes": [
            {
                "title": "出発", "beat": "アヤは港を出る。", "emotional_core": "言えなかった別れ",
                "cast": ["アヤ", "ケン"], "location": "港",
                "events": [
                    {"type": "memory", "who": "アヤ", "text": "戻る日を言わずに港を出た", "importance": 0.7},
                    {"type": "memory", "who": "ケン", "text": "アヤを見送った"},
                    {"type": "relation", "who": "ケン", "toward": "アヤ", "change": -0.2, "label": "置いていかれた", "reason": "理由を聞かされなかった"},
                    {"type": "fact", "who": "アヤ", "key": "目的", "value": "北の橋を測る"},
                    {"type": "fact", "world": True, "key": "季節", "value": "冬"},
                ],
            },
            {"title": "橋の上", "beat": "アヤは橋を測る。", "cast": ["アヤ"], "elapsed": {"unit": "day", "count": 3}},
            {
                "key": "k3", "title": "帰港", "beat": "アヤは港へ戻る。", "cast": ["アヤ", "ケン"], "location": "港",
                "elapsed": {"unit": "month", "count": 2},
                "events": [{"type": "relation", "who": "アヤ", "toward": "ケン", "value": 0.5, "label": "頼れる人"}],
            },
        ],
    }


def test_valid_file_passes_with_summary():
    result = importer.validate(sample())
    assert result["errors"] == [] and result["warnings"] == []
    assert result["summary"] == {"title": "港の話", "characters": 2, "places": 1, "documents": 1,
                                 "chapters": 2, "scenes": 3, "events": 6}


def test_errors_say_where_and_how_to_fix():
    data = sample()
    data["scenes"][0]["cast"].append("田中")
    data["scenes"][1]["location"] = "山"
    data["scenes"][1]["elapsed"] = {"unit": "minute", "count": 2}
    data["scenes"][2]["emotion_core"] = "綴りの誤り"
    data["scenes"][2]["events"].append({"type": "relation", "who": "アヤ", "toward": "ケン"})
    data["scenes"].append({"title": "分岐", "beat": "別の道。", "after": "出発"})
    data["chapters"].append({"title": "飛び地", "scenes": ["出発", "帰港"]})
    data["documents"][0]["status"] = "final"
    errors = importer.validate(data)["errors"]
    joined = "\n".join(errors)
    assert 'scenes の 1 番目「出発」: "cast" の「田中」が characters にありません' in joined
    assert '"location" の「山」が places にありません' in joined
    assert '"elapsed"' in joined and "経過の単位が不正" in joined
    assert '不明な項目 "emotion_core"' in joined
    assert '"change"(増減)か "value"(絶対値)のどちらか一方' in joined
    assert '"after"(分岐)はまだ対応していません' in joined
    assert "章「第一幕」にも入っています" in joined
    assert '"status" は confirmed / draft / reference' in joined
    # 同じ配列の誤りを二重に数えない
    assert len(errors) == len(set(errors))


def test_top_level_and_shape_errors():
    assert "オブジェクト" in importer.validate([])["errors"][0]
    result = importer.validate({"format": "x", "version": 2, "scenes": [], "extra": 1})
    joined = "\n".join(result["errors"])
    assert '"format" は "story-graph-import"' in joined and '"version" は 1' in joined
    assert '不明な項目 "extra"' in joined and "シーンが 1 つ以上必要" in joined
    data = sample()
    data["characters"].append({"name": "アヤ"})
    data["scenes"][0]["elapsed"] = {"unit": "day", "count": 1}
    data["scenes"][1]["events"] = [{"type": "memory", "who": "ケン", "text": "聞いた話"}]
    result = importer.validate(data)
    assert any("「アヤ」が重複" in e for e in result["errors"])
    assert any("最初のシーン" in w for w in result["warnings"])
    assert any('「ケン」はこのシーンの "cast" に居ません' in w for w in result["warnings"])


def test_apply_registers_everything_in_order(store):
    summary = importer.apply(store, sample())
    assert summary["scenes"] == 3 and summary["events"] == 6
    chars = {c["name"]: c for c in store.list_characters()}
    assert chars["アヤ"]["reading"] == "あや" and chars["ケン"]["profile"] == "漁師"
    places = {p["name"]: p for p in store.list_places()}
    docs = store.list_setting_documents()
    assert docs[0]["title"] == "測量組合" and docs[0]["status"] == "confirmed" and docs[0]["ai_mode"] == "always"
    path = [store.get_node(nid) for nid in store.canon_path()]
    assert [n["title"] for n in path] == ["出発", "橋の上", "帰港"]
    assert path[0]["cast"] == [chars["アヤ"]["id"], chars["ケン"]["id"]] and path[0]["location"] == places["港"]["id"]
    assert (path[0]["elapsed_unit"], path[1]["elapsed_unit"], path[1]["elapsed_count"]) == (None, "day", 3)
    assert (path[2]["elapsed_unit"], path[2]["elapsed_count"]) == ("month", 2)
    # イベントは内部の形へ変換され、状態に積み上がる
    types = [e["type"] for e in path[0]["events"]]
    assert types == ["memory_add", "memory_add", "relationship_update", "fact_set", "fact_set"]
    state = store.get_state(path[2]["id"])
    aya, ken = chars["アヤ"]["id"], chars["ケン"]["id"]
    assert state["chars"][aya]["facts"]["目的"] == "北の橋を測る" and state["world"]["facts"]["季節"] == "冬"
    assert state["chars"][ken]["relationships"][aya]["score"] == pytest.approx(-0.2)
    assert state["chars"][aya]["relationships"][ken]["score"] == pytest.approx(0.5)
    assert len(state["chars"][aya]["memories"]) == 1
    groups = {g["title"]: g for g in store.list_groups()}
    assert [store.get_node(n)["title"] for n in groups["第一幕"]["route"]] == ["出発", "橋の上"]
    assert [store.get_node(n)["title"] for n in groups["第二幕"]["route"]] == ["帰港"]
    for node in path:
        assert store.validate(node["id"]) == []
    # 配置は自動レイアウトに任せる(空のときに保存された「結末」の位置を残さない)
    assert all(n["pos_x"] is None and n["pos_y"] is None for n in store.graph()["nodes"])


def test_apply_refuses_non_empty_library_and_bad_files(store):
    with pytest.raises(importer.ImportError_) as caught:
        bad = sample()
        bad["scenes"][0]["cast"] = ["居ない人"]
        importer.apply(store, bad)
    assert "characters にありません" in caught.value.errors[0]
    assert store.list_characters() == [] and store.canon_path() == []
    importer.apply(store, sample())
    with pytest.raises(importer.ImportError_) as caught:
        importer.apply(store, sample())
    assert "すでにシーンが 3 件あります" in caught.value.errors[0]
    assert any("同じ名前のキャラクター" in e for e in caught.value.errors)
    assert len(store.canon_path()) == 3


def test_apply_rolls_back_everything_when_it_fails_midway(store, monkeypatch):
    original = Store.create_group

    def fail(self, title, node_ids):
        raise RuntimeError("章の作成に失敗")

    monkeypatch.setattr(Store, "create_group", fail)
    with pytest.raises(RuntimeError):
        importer.apply(store, sample())
    monkeypatch.setattr(Store, "create_group", original)
    assert store.list_characters() == [] and store.list_places() == []
    assert store.list_setting_documents() == [] and store.canon_path() == []
    # 取り消した後は、そのまま取り込み直せる
    assert importer.apply(store, sample())["scenes"] == 3


def test_retired_character_reappearing_is_rejected_with_scene_name(store):
    data = sample()
    data["scenes"][0]["events"].append({"type": "retire", "who": "ケン", "reason": "death"})
    with pytest.raises(importer.ImportError_) as caught:
        importer.apply(store, data)
    assert "scenes の 3 番目「帰港」" in caught.value.errors[0] and "退場済み" in caught.value.errors[0]
    assert store.canon_path() == []


def test_check_command_reports_and_sets_exit_code(tmp_path):
    import json

    script = Path(importer.__file__).with_name("import_check.py")
    good = tmp_path / "good.json"
    good.write_text(json.dumps(sample(), ensure_ascii=False), encoding="utf-8")
    bad_data = copy.deepcopy(sample())
    bad_data["scenes"][0]["location"] = "山"
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(bad_data, ensure_ascii=False), encoding="utf-8")
    run = lambda path: subprocess.run([sys.executable, str(script), str(path)], capture_output=True, encoding="utf-8")
    ok = run(good)
    assert ok.returncode == 0 and "問題ありません" in ok.stdout and "シーン 3" in ok.stdout
    ng = run(bad)
    assert ng.returncode == 1 and "誤り: scenes の 1 番目「出発」" in ng.stdout and "places にありません" in ng.stdout
    broken = tmp_path / "broken.json"
    broken.write_text("{", encoding="utf-8")
    assert run(broken).returncode == 1
