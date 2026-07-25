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
