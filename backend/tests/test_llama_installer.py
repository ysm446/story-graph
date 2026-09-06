from pathlib import Path

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
    assert cuda["cuda_version"] == "13"
    assert cuda["cudart_url"].endswith("cudart-llama-bin-win-cuda-13-x64.zip")
    assert cuda["cudart_size_bytes"] == 50
    # cpu バリアントには cudart は付かない
    cpu = next(v for v in rel["variants"] if v["family"] == "cpu")
    assert cpu["cudart_url"] is None
    assert cpu["cuda_version"] is None


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
    monkeypatch.setattr(inst, "system_cudart_versions", lambda: [])

    st = inst.status()
    assert st["total_size_bytes"] == 40
    assert {c["build"]: c["size_bytes"] for c in st["installs"]} == {"b100": 10, "b200": 30}


def test_status_reports_cudart_presence(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    with_dll = _make_install(runtime, "llama-b200-bin-win-cuda-13-x64")
    (with_dll / "cudart64_13.dll").write_bytes(b"x")
    (with_dll / "cublas64_13.dll").write_bytes(b"x")
    _make_install(runtime, "llama-b100-bin-win-cuda-12-x64")
    _make_install(runtime, "llama-b100-bin-win-cpu-x64")
    monkeypatch.setattr(inst, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(inst, "LEGACY_BIN_DIR", tmp_path / "nonexistent")
    monkeypatch.setattr(inst, "system_cudart_versions", lambda: ["12"])

    st = inst.status()
    by_dir = {Path(c["dir"]).name: c for c in st["installs"]}
    cuda13 = by_dir["llama-b200-bin-win-cuda-13-x64"]
    assert (cuda13["is_cuda"], cuda13["cuda_version"], cuda13["has_cudart"]) == (True, "13", True)
    # DLL 未同梱の CUDA ビルド(システム側の CUDA ランタイム頼り)
    cuda12 = by_dir["llama-b100-bin-win-cuda-12-x64"]
    assert (cuda12["is_cuda"], cuda12["has_cudart"]) == (True, False)
    cpu = by_dir["llama-b100-bin-win-cpu-x64"]
    assert (cpu["is_cuda"], cpu["has_cudart"]) == (False, False)
    assert st["system_cudart"] == ["12"]


def test_has_cudart_needs_full_dll_set(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    # 展開が途中で失敗して cudart だけ残ったケースは「無い」扱い
    # (UI が追加ダウンロードの導線を出せるように)
    partial = _make_install(runtime, "llama-b100-bin-win-cuda-13-x64")
    (partial / "cudart64_13.dll").write_bytes(b"x")
    assert inst.has_cudart(partial) is False
    (partial / "cublas64_13.dll").write_bytes(b"x")
    assert inst.has_cudart(partial) is True


def test_dest_dir_for_rejects_path_traversal():
    ok = inst.dest_dir_for("llama-b9496-bin-win-cuda-13-x64.zip")
    assert ok.parent == inst.RUNTIME_DIR
    assert ok.name == "llama-b9496-bin-win-cuda-13-x64"
    for bad in (
        "..\\..\\evil.zip",
        "../evil.zip",
        "C:\\Users\\x\\evil.zip",
        "a/b.zip",
        "..zip",
        "",
    ):
        with pytest.raises(ValueError):
            inst.dest_dir_for(bad)


def test_swap_into_place_replaces_existing_install(tmp_path):
    dest = tmp_path / "llama-b100-bin-win-cpu-x64"
    dest.mkdir()
    (dest / "llama-server.exe").write_bytes(b"old")
    staging = tmp_path / ".installing-x"
    staging.mkdir()
    (staging / "llama-server.exe").write_bytes(b"new")

    inst._swap_into_place(staging, dest)
    assert (dest / "llama-server.exe").read_bytes() == b"new"
    assert not staging.exists()
    # 置き換えの残骸(.removing-*)も残らない
    assert [p.name for p in tmp_path.iterdir()] == [dest.name]


def test_cleanup_leftovers_removes_hidden_dirs(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    keep = _make_install(runtime, "llama-b100-bin-win-cpu-x64")
    _make_install(runtime, ".removing-deadbeef")
    _make_install(runtime, ".installing-cafebabe")
    monkeypatch.setattr(inst, "RUNTIME_DIR", runtime)

    inst.cleanup_leftovers()
    assert [p.name for p in runtime.iterdir()] == [keep.name]


def test_system_cudart_versions_needs_both_dlls(tmp_path, monkeypatch):
    both = tmp_path / "cuda13"
    both.mkdir()
    for name in ("cudart64_13.dll", "cublas64_13.dll", "cudart64_12.dll"):
        (both / name).write_bytes(b"x")
    monkeypatch.setenv("PATH", str(both))
    monkeypatch.delenv("CUDA_PATH", raising=False)
    inst.system_cudart_versions.cache_clear()

    # cublas の無い 12 は数えない(llama-server が動かないため)
    assert inst.system_cudart_versions() == ["13"]
    inst.system_cudart_versions.cache_clear()


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


def test_dest_dir_for_rejects_non_llama_asset_names():
    """runtime/ 直下の別インストール(comfyui など)を置き換え先にできない(2026-09-06)。"""
    for bad in ("comfyui.zip", "cudart-llama-bin-win-cuda-13-x64.zip", "evil.zip"):
        with pytest.raises(ValueError):
            inst.dest_dir_for(bad)


def test_check_download_url_allows_only_github_release_hosts():
    inst.check_download_url("https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip")
    inst.check_download_url("https://objects.githubusercontent.com/x")
    for bad in ("https://evil.example/x.zip", "http://github.com/x.zip", "file:///C:/x.zip", ""):
        with pytest.raises(ValueError):
            inst.check_download_url(bad)
