"""TTS サーバーの置き場(設定 tts_server_dir_<engine>)と、外の置き場を消さない約束。"""

import asyncio
import json
import os

import pytest

import app_settings
import tts_installer as inst


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    """既定の置き場(runtime/tts/)を tmp に差し替える。"""
    root = tmp_path / "runtime"
    monkeypatch.setattr(inst, "RUNTIME_DIR", root)
    monkeypatch.setattr(inst, "TTS_DIR", root / "tts")
    return root


def _installed(path):
    path.mkdir(parents=True)
    (path / inst.MARKER_NAME).write_text(json.dumps({"engine": "irodori", "commit": "abc"}), encoding="utf-8")
    (path / "server.py").write_text("x", encoding="utf-8")
    return path


def _settings(path):
    return {inst.server_dir_key("irodori"): str(path)}


def test_install_dir_defaults_to_runtime(runtime):
    assert inst.install_dir("irodori") == runtime / "tts" / "irodori"
    assert inst.install_dir("irodori", {inst.server_dir_key("irodori"): "  "}) == runtime / "tts" / "irodori"
    assert not inst.is_external("irodori", {})
    # 既定の場所をそのまま書いても「外」とは扱わない(消してよい場所のまま)
    assert not inst.is_external("irodori", _settings(runtime / "tts" / "irodori"))


def test_configured_dir_is_used_for_status(runtime, tmp_path):
    shared = _installed(tmp_path / "shared" / "irodori")
    st = inst.status("irodori", _settings(shared))
    assert st["installed"] and not st["incomplete"]
    assert st["install_dir"] == str(shared)
    assert st["default_install_dir"] == str(runtime / "tts" / "irodori")
    assert st["install_external"] and st["install_blocked"]
    # ほかのエンジンの設定は効かない
    assert not inst.status("other", _settings(shared))["installed"]
    # 設定が無ければ既定の場所を見る(そこには無い)
    st = inst.status("irodori", {})
    assert not st["installed"] and not st["install_external"] and not st["install_blocked"]


def test_server_dir_setting_is_app_scoped():
    assert app_settings.is_app_key(inst.server_dir_key("irodori"))


def test_uninstall_refuses_external_dir(runtime, tmp_path):
    shared = _installed(tmp_path / "shared" / "irodori")
    with pytest.raises(RuntimeError):
        inst.uninstall("irodori", _settings(shared))
    assert (shared / "server.py").exists() and (shared / inst.MARKER_NAME).exists()


def test_uninstall_default_dir_removes_it(runtime):
    path = _installed(runtime / "tts" / "irodori")
    inst.uninstall("irodori", {})
    assert not path.exists()


@pytest.mark.skipif(os.name != "nt", reason="Junction は Windows だけ")
def test_uninstall_default_junction_keeps_target(runtime, tmp_path):
    import _winapi

    shared = _installed(tmp_path / "shared" / "irodori")
    link = runtime / "tts" / "irodori"
    link.parent.mkdir(parents=True)
    _winapi.CreateJunction(str(shared), str(link))
    assert inst.status("irodori", {})["installed"]
    inst.uninstall("irodori", {})
    assert not link.exists() and not link.is_junction()
    assert (shared / "server.py").exists() and (shared / inst.MARKER_NAME).exists()


def test_install_refuses_non_empty_external_dir(runtime, tmp_path, monkeypatch):
    shared = _installed(tmp_path / "shared" / "irodori")
    monkeypatch.setattr(inst.shutil, "which", lambda name: "git")
    engine = {"id": "irodori", "install": {"git": "https://example.invalid/x.git"}}

    async def run():
        async for _ in inst.install(engine, _settings(shared)):
            pass

    with pytest.raises(RuntimeError, match="中身がある"):
        asyncio.run(run())
    assert (shared / "server.py").exists() and (shared / inst.MARKER_NAME).exists()
