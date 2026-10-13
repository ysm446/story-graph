import json

import pytest

import app_settings
import db
import embed
from store import Store


@pytest.fixture
def make_store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    stores = []

    def make():
        s = Store(db.connect(":memory:"))
        stores.append(s)
        return s

    yield make
    for s in stores:
        s.conn.close()


def library_rows(store):
    return {r["key"]: r["value"] for r in store.conn.execute("SELECT * FROM settings")}


def test_without_app_data_everything_stays_in_the_library(make_store, monkeypatch):
    monkeypatch.delenv("STORY_GRAPH_APP_DATA", raising=False)
    store = make_store()
    store.set_settings({"models_dir": "D:/models", "comfy_negative": "blurry", "backup_dir": "E:/backup"})
    assert library_rows(store)["models_dir"] == "D:/models"
    assert store.get_settings()["comfy_negative"] == "blurry"


def test_app_keys_are_saved_per_machine_and_shared_between_libraries(make_store, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_GRAPH_APP_DATA", str(tmp_path))
    first, second = make_store(), make_store()
    first.set_settings({"models_dir": "D:/models", "comfy_checkpoint": "qwen.safetensors", "comfy_steps": "6",
                        "tts_engine": "irodori", "backup_dir": "E:/backup", "tts_narrator_profile": "p1"})
    saved = json.loads((tmp_path / app_settings.FILE_NAME).read_text(encoding="utf-8"))
    assert saved == {"models_dir": "D:/models", "comfy_checkpoint": "qwen.safetensors", "comfy_steps": "6", "tts_engine": "irodori"}
    # 作品に依存する値(バックアップの保存先・声の割り当て)はライブラリに残る
    assert {k: v for k, v in library_rows(first).items() if k in ("backup_dir", "tts_narrator_profile", "models_dir")} == {
        "backup_dir": "E:/backup", "tts_narrator_profile": "p1"}
    # 別のライブラリを開いても、環境設定はそのまま使える
    other = second.get_settings()
    assert other["models_dir"] == "D:/models" and other["comfy_checkpoint"] == "qwen.safetensors"
    assert "backup_dir" not in other and "tts_narrator_profile" not in other


def test_existing_library_values_are_adopted_once(make_store, monkeypatch, tmp_path):
    """移行: アプリの設定にまだ無いキーは、開いているライブラリの値を引き継ぐ。"""
    monkeypatch.delenv("STORY_GRAPH_APP_DATA", raising=False)
    old, later = make_store(), make_store()
    old.set_settings({"llm_base_url": "http://127.0.0.1:8080", "comfy_negative": "blurry"})
    later.set_settings({"llm_base_url": "http://other:9000", "llm_ctx_size": "32768"})
    monkeypatch.setenv("STORY_GRAPH_APP_DATA", str(tmp_path))
    assert old.get_settings()["llm_base_url"] == "http://127.0.0.1:8080"
    # 先に引き継いだ値が優先。まだ無いキーだけ、後から開いたライブラリの値で埋まる
    merged = later.get_settings()
    assert merged["llm_base_url"] == "http://127.0.0.1:8080" and merged["llm_ctx_size"] == "32768"
    assert merged["comfy_negative"] == "blurry"
    # ライブラリ側の値は消さない(古い版でもそのまま動く)
    assert library_rows(later)["llm_base_url"] == "http://other:9000"
    # 以後の変更はアプリの設定だけに入る
    later.set_settings({"llm_base_url": "http://new:1"})
    assert old.get_settings()["llm_base_url"] == "http://new:1"
    assert library_rows(later)["llm_base_url"] == "http://other:9000"


def test_broken_file_is_treated_as_empty(make_store, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_GRAPH_APP_DATA", str(tmp_path))
    (tmp_path / app_settings.FILE_NAME).write_text("{ broken", encoding="utf-8")
    store = make_store()
    assert "models_dir" not in store.get_settings()
    store.set_settings({"models_dir": "D:/models"})
    assert store.get_settings()["models_dir"] == "D:/models"
