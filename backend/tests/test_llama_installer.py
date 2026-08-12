import pytest

import llama_installer as inst


def _asset(name, size=100):
    return {"name": name, "browser_download_url": f"https://example.com/{name}", "size": size}


def test_build_release_extracts_variants_and_pairs_cudart():
    raw = {
        "tag_name": "b9496",
        "name": "b9496",
        "published_at": "2026-01-01T00:00:00Z",
        "html_url": "https://example.com/b9496",
        "assets": [
            _asset("llama-b9496-bin-win-cuda-13-x64.zip", 200),
            _asset("llama-b9496-bin-win-cpu-x64.zip", 150),
            _asset("cudart-llama-bin-win-cuda-13-x64.zip", 50),
            _asset("some-unrelated-file.txt"),
        ],
    }
    rel = inst._build_release(raw)
    assert rel is not None
    assert rel["tag"] == "b9496"
    # cuda が先頭(FAMILY_RANK で cuda < cpu)
    assert rel["variants"][0]["family"] == "cuda"
    cuda = rel["variants"][0]
    assert cuda["label"] == "CUDA 13 (NVIDIA)"
    assert cuda["cudart_url"].endswith("cudart-llama-bin-win-cuda-13-x64.zip")
    assert cuda["cudart_size_bytes"] == 50
    # cpu バリアントには cudart は付かない
    cpu = next(v for v in rel["variants"] if v["family"] == "cpu")
    assert cpu["cudart_url"] is None


def test_build_release_returns_none_without_variants():
    raw = {"tag_name": "b1", "assets": [_asset("readme.txt")]}
    assert inst._build_release(raw) is None


def test_find_server_installs_prefers_higher_build(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    (runtime / "llama-b100-bin-win-cpu-x64").mkdir(parents=True)
    (runtime / "llama-b100-bin-win-cpu-x64" / "llama-server.exe").write_bytes(b"x")
    (runtime / "llama-b200-bin-win-cuda-13-x64").mkdir(parents=True)
    (runtime / "llama-b200-bin-win-cuda-13-x64" / "llama-server.exe").write_bytes(b"x")
    monkeypatch.setattr(inst, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(inst, "LEGACY_BIN_DIR", tmp_path / "nonexistent")

    installs = inst.find_server_installs()
    assert len(installs) == 2
    # build 番号が大きい b200 が先頭
    assert installs[0]["build"] == "b200"
    assert inst.resolve_server_path() == installs[0]["path"]


def _make_install(runtime, name, payload=b"xxxx"):
    d = runtime / name
    d.mkdir(parents=True)
    (d / "llama-server.exe").write_bytes(payload)
    return d


def test_find_server_installs_skips_removal_leftovers(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    _make_install(runtime, "llama-b100-bin-win-cpu-x64")
    # 削除に失敗して残った残骸は起動候補に混ぜない
    _make_install(runtime, ".removing-deadbeef")
    monkeypatch.setattr(inst, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(inst, "LEGACY_BIN_DIR", tmp_path / "nonexistent")

    installs = inst.find_server_installs()
    assert [c["build"] for c in installs] == ["b100"]
    assert installs[0]["removable"] is True


def test_status_reports_sizes(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    _make_install(runtime, "llama-b100-bin-win-cpu-x64", b"x" * 10)
    _make_install(runtime, "llama-b200-bin-win-cuda-13-x64", b"x" * 30)
    monkeypatch.setattr(inst, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(inst, "LEGACY_BIN_DIR", tmp_path / "nonexistent")

    st = inst.status()
    assert st["total_size_bytes"] == 40
    assert {c["build"]: c["size_bytes"] for c in st["installs"]} == {"b100": 10, "b200": 30}


def test_uninstall_removes_only_runtime_installs(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    legacy = tmp_path / "bin" / "llama-server"
    target = _make_install(runtime, "llama-b100-bin-win-cpu-x64", b"x" * 12)
    kept = _make_install(runtime, "llama-b200-bin-win-cuda-13-x64")
    borrowed = _make_install(legacy, "b9496-win-cuda13-x64")
    monkeypatch.setattr(inst, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(inst, "LEGACY_BIN_DIR", legacy)

    result = inst.uninstall(str(target))
    assert result["freed_bytes"] == 12
    assert not target.exists()
    assert kept.exists()
    # 残骸(.removing-*)も残さない
    assert [p.name for p in runtime.iterdir()] == ["llama-b200-bin-win-cuda-13-x64"]

    # レガシー配置(移植元からの流用)は他プロジェクトの資産なので消さない
    with pytest.raises(ValueError):
        inst.uninstall(str(borrowed))
    assert borrowed.exists()

    # 存在しない・exe の無いフォルダも拒否する
    with pytest.raises(ValueError):
        inst.uninstall(str(runtime / "no-such-build"))
    empty = runtime / "llama-b300-bin-win-cpu-x64"
    empty.mkdir()
    with pytest.raises(ValueError):
        inst.uninstall(str(empty))
