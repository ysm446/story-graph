import comfy
import comfy_installer as ci
import image_gen


def _asset(name, size=100):
    return {"name": name, "browser_download_url": f"https://example.com/{name}", "size": size}


def test_build_release_picks_portable_variants_nvidia_first():
    raw = {
        "tag_name": "v0.34.0",
        "published_at": "2026-08-26T00:00:00Z",
        "html_url": "https://example.com/v0.34.0",
        "assets": [
            _asset("ComfyUI_windows_portable_amd.7z", 10),
            _asset("ComfyUI_windows_portable_nvidia.7z", 20),
            _asset("ComfyUI_windows_portable_nvidia_cu126.7z", 19),
            _asset("something-else.zip"),
        ],
    }
    rel = ci._build_release(raw)
    assert rel is not None
    assert rel["tag"] == "v0.34.0"
    assert [v["backend"] for v in rel["variants"]] == ["nvidia", "nvidia_cu126", "amd"]
    assert rel["variants"][0]["asset_url"].endswith("ComfyUI_windows_portable_nvidia.7z")


def test_build_release_without_portable_assets_is_none():
    assert ci._build_release({"tag_name": "x", "assets": [_asset("source.zip")]}) is None


def test_extra_model_paths_yaml_quotes_base_path():
    text = ci.extra_model_paths_text(r"D:\ai-models\diffusion\comfyui")
    assert "base_path: 'D:\\ai-models\\diffusion\\comfyui'" in text
    assert "  checkpoints: checkpoints" in text
    assert "  loras: loras" in text
    assert text.startswith("story_graph:\n")


def test_write_extra_model_paths_removes_when_empty(tmp_path):
    (tmp_path / "ComfyUI").mkdir()
    target = ci.write_extra_model_paths(tmp_path, r"D:\x")
    assert target.exists()
    ci.write_extra_model_paths(tmp_path, "")
    assert not target.exists()


def test_t2i_workflow_wires_nodes():
    wf = comfy.build_t2i_workflow(checkpoint="Qwen-Rapid-AIO.safetensors", positive="a girl", seed=7)
    assert wf["1"]["inputs"]["ckpt_name"] == "Qwen-Rapid-AIO.safetensors"
    ks = wf["6"]["inputs"]
    assert ks["model"] == ["2", 0]  # shift ノードを経由
    assert ks["positive"] == ["3", 0] and ks["negative"] == ["4", 0]
    assert ks["seed"] == 7 and ks["steps"] == comfy.DEFAULT_STEPS and ks["cfg"] == comfy.DEFAULT_CFG
    assert wf["3"]["inputs"]["text"] == "a girl"
    assert wf["7"]["inputs"]["vae"] == ["1", 2]
    assert wf["8"]["class_type"] == "SaveImage"


def test_character_workflow_uses_settings_and_suffix():
    settings = {"comfy_checkpoint": "ckpt.safetensors", "comfy_steps": "8", "comfy_cfg": "1.5", "comfy_shift": "2"}
    wf = image_gen.character_workflow(settings, "red hair, blue eyes,", seed=1)
    pos = wf["3"]["inputs"]["text"]
    assert pos.startswith("red hair, blue eyes, full body standing portrait")
    assert wf["6"]["inputs"]["steps"] == 8 and wf["6"]["inputs"]["cfg"] == 1.5
    assert wf["2"]["inputs"]["shift"] == 2.0


def test_character_workflow_requires_checkpoint():
    import pytest

    with pytest.raises(RuntimeError):
        image_gen.character_workflow({}, "x")


def test_store_keeps_ref_image_columns():
    import db
    from store import Store

    store = Store(db.connect(":memory:"))
    c = store.create_character({"name": "A"})
    updated = store.update_character(c["id"], {"ref_image_path": "abc.png", "ref_image_prompt": "p"})
    assert updated["ref_image_path"] == "abc.png" and updated["ref_image_prompt"] == "p"


def test_edit_workflow_wires_reference_images():
    wf = comfy.build_edit_workflow(checkpoint="c.safetensors", positive="p", ref_images=["a.png", "b.png"], seed=3)
    assert wf["10"]["inputs"]["image"] == "a.png" and wf["11"]["inputs"]["image"] == "b.png"
    enc = wf["3"]["inputs"]
    assert enc["image1"] == ["10", 0] and enc["image2"] == ["11", 0] and "image3" not in enc
    assert enc["vae"] == ["1", 2] and wf["4"]["inputs"]["image1"] == ["10", 0]
    assert wf["6"]["inputs"]["positive"] == ["3", 0]
    assert wf["5"]["inputs"]["width"] == 1216


def test_edit_workflow_limits_refs():
    import pytest

    with pytest.raises(ValueError):
        comfy.build_edit_workflow(checkpoint="c", positive="p", ref_images=["1", "2", "3", "4"])
    with pytest.raises(ValueError):
        comfy.build_edit_workflow(checkpoint="c", positive="p", ref_images=[])


def test_scene_workflow_falls_back_to_t2i_without_refs():
    settings = {"comfy_checkpoint": "c.safetensors"}
    wf = image_gen.scene_workflow(settings, "a quiet street", [], seed=1)
    assert wf["3"]["class_type"] == "CLIPTextEncode"
    assert wf["3"]["inputs"]["text"].startswith("a quiet street, cinematic illustration")
    wf2 = image_gen.scene_workflow(settings, "two people", ["r.png"], seed=1)
    assert wf2["3"]["class_type"] == "TextEncodeQwenImageEditPlus"


def test_select_scene_refs_keeps_cast_order_and_limit():
    chars = [{"id": "a", "ref_image_path": None}, {"id": "b", "ref_image_path": "b.png"},
             {"id": "c", "ref_image_path": "c.png"}, {"id": "d", "ref_image_path": "d.png"},
             {"id": "e", "ref_image_path": "e.png"}]
    assert [c["id"] for c in image_gen.select_scene_refs(chars)] == ["b", "c", "d"]


def test_scene_notes_label_refs_and_place():
    node = {"title": "T", "beat": "本文", "cast": ["a", "b"], "story_time": "夜"}
    chars = [{"id": "a", "name": "A", "ref_image_path": "a.png", "appearance": "赤髪"}, {"id": "b", "name": "B"}]
    notes = image_gen._scene_notes(node, chars, image_gen.select_scene_refs(chars), {"name": "港", "description": "古い"})
    assert "- A: image1 (has reference image); appearance: 赤髪" in notes
    assert "- B: no reference image" in notes
    assert "Place: 港 — 古い" in notes and "Time: 夜" in notes


def test_instructions_are_appended_to_notes():
    assert image_gen._with_instructions("N", None) == "N"
    assert image_gen._with_instructions("N", "  ") == "N"
    out = image_gen._with_instructions("N", "夕方の逆光で")
    assert out.startswith("N\n\n") and out.endswith("夕方の逆光で") and "priority" in out


def test_store_keeps_image_gen_state():
    import db
    from store import Store

    store = Store(db.connect(":memory:"))
    n = store.append_node({"beat": "b", "cast": []})
    store.set_node_image_gen(n["id"], prompt="p", instructions="i", seed=7, ref_chars=["a", "b"])
    got = store.get_node(n["id"])
    assert got["image_prompt"] == "p" and got["image_instructions"] == "i" and got["image_seed"] == 7
    assert got["image_ref_chars"] == ["a", "b"]
    store.set_node_image_gen(n["id"], prompt=None, instructions=None, seed=None, ref_chars=None)
    assert store.get_node(n["id"])["image_ref_chars"] is None


def test_clean_prompt_strips_fences_and_quotes():
    assert image_gen._clean_prompt('"anime style, red hair"') == "anime style, red hair"
    assert image_gen._clean_prompt("```text\nanime style\n```") == "anime style"
    assert image_gen._clean_prompt("  plain  ") == "plain"


def test_variants_include_default_and_lora():
    ids = [v["id"] for v in comfy.list_variants()]
    assert ids[0] == "default" and "zeniji" in ids
    assert comfy.get_variant("nope")["id"] == "default"  # 不明な id は既定に落ちる
    assert comfy.get_variant(None)["id"] == "default"


def test_lora_variant_inserts_loader_between_checkpoint_and_sampling():
    v = comfy.get_variant("zeniji")
    wf = comfy.build_t2i_workflow(template=v["t2i"], extra_values=v["values"], checkpoint="c", positive="p", seed=1)
    assert wf["9"]["class_type"] == "LoraLoaderModelOnly"
    assert wf["9"]["inputs"]["lora_name"] == "qwen-image-zeniji.safetensors"
    assert wf["9"]["inputs"]["strength_model"] == 1.0 and wf["9"]["inputs"]["model"] == ["1", 0]
    assert wf["2"]["inputs"]["model"] == ["9", 0]
    wf2 = comfy.build_edit_workflow(
        template=v["edit"], extra_values=v["values"], checkpoint="c", positive="p", ref_images=["a.png"], seed=1
    )
    assert wf2["9"]["inputs"]["lora_name"] == "qwen-image-zeniji.safetensors" and "11" not in wf2
    # 既定の組には LoRA ノードが無い
    assert "9" not in comfy.build_t2i_workflow(checkpoint="c", positive="p", seed=1)


def test_scene_workflow_honours_variant():
    settings = {"comfy_checkpoint": "c.safetensors"}
    wf = image_gen.scene_workflow(settings, "x", ["r.png"], seed=1, variant="zeniji")
    assert wf["9"]["class_type"] == "LoraLoaderModelOnly"
    assert "9" not in image_gen.scene_workflow(settings, "x", ["r.png"], seed=1)
    assert "9" not in image_gen.character_workflow(settings, "x", seed=1, variant="missing")
