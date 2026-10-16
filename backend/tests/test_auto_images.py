"""制作で作った人物の画像の自動生成(auto_images。docs/design/image-gen.md §14)。"""

import asyncio
import json

import pytest

import auto_images
import comfy
import db
import embed
import llm
import production_agent as production
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


@pytest.fixture
def fake_comfy(monkeypatch):
    """LLM と ComfyUI を差し替え、送られたワークフローを記録する。"""
    calls = {"workflows": [], "uploads": [], "ensure": 0}

    async def chat(messages, **kwargs):
        assert messages[0]["content"] == __import__("image_gen").PROMPT_SYSTEM
        return {"content": '"1girl, black hair, red coat"', "usage": {}}

    async def run_workflow(base_url, workflow, **kwargs):
        calls["workflows"].append(workflow)
        return b"PNG" + bytes([len(calls["workflows"])])

    async def upload_image(base_url, data, name):
        calls["uploads"].append((name, data))
        return f"story-graph/{name}"

    async def ensure(settings):
        calls["ensure"] += 1
        return "http://comfy"

    monkeypatch.setattr(llm, "chat", chat)
    monkeypatch.setattr(comfy, "run_workflow", run_workflow)
    monkeypatch.setattr(comfy, "upload_image", upload_image)
    calls["ensure_comfy"] = ensure
    return calls


def collect(store, char_ids, ensure):
    async def go():
        return [e async for e in auto_images.run(store, char_ids, llm_base_url="http://llm", ensure_comfy=ensure)]
    return asyncio.run(go())


def _positive(wf):
    """正のプロンプトの文字列(テンプレートごとに入力名が違うので、接尾辞を含む文字列を探す)。"""
    return next(v for n in wf.values() for v in n["inputs"].values()
                if isinstance(v, str) and v.endswith(auto_images.PORTRAIT_SUFFIX))


def test_portrait_workflow_uses_edit_template_with_reference_and_square_size():
    settings = {"comfy_workflow": "default"}
    wf = auto_images.portrait_workflow(settings, "black hair", "story-graph/ref.png", seed=1)
    assert wf["10"]["class_type"] == "LoadImage" and wf["10"]["inputs"]["image"] == "story-graph/ref.png"
    assert "11" not in wf and "12" not in wf
    latent = next(n["inputs"] for n in wf.values() if n["class_type"] == "EmptySD3LatentImage")
    assert latent["width"] == auto_images.PORTRAIT_SIZE and latent["height"] == auto_images.PORTRAIT_SIZE
    positive = wf["3"]["inputs"]["prompt"]
    assert positive.startswith(auto_images.PORTRAIT_REF_PROMPT) and positive.endswith(auto_images.PORTRAIT_SUFFIX)
    assert "black hair" not in positive  # 手本が人物描写を持つので本文には書かない
    assert wf["8"]["inputs"]["filename_prefix"] == "story-graph/portrait"


def test_portrait_workflow_without_reference_falls_back_to_t2i_with_description():
    wf = auto_images.portrait_workflow({"comfy_workflow": "default"}, "black hair, red coat,", None, seed=1)
    assert wf["1"]["class_type"] == "CheckpointLoaderSimple"
    assert wf["3"]["inputs"]["text"] == f"black hair, red coat, {auto_images.PORTRAIT_SUFFIX}"
    latent = wf["5"]["inputs"]
    assert latent["width"] == latent["height"] == auto_images.PORTRAIT_SIZE


def test_portrait_workflow_rewrites_reference_label_for_variant():
    wf = auto_images.portrait_workflow({}, "x", "ref.png", seed=1, variant="qwen21")
    assert "<image1>" in _positive(wf) and "image1," not in _positive(wf)


def test_run_creates_reference_and_portrait_for_new_characters(store, fake_comfy):
    store.set_settings({auto_images.SETTING_KEY: "1", "comfy_workflow": "default"})
    aya = store.create_character({"name": "アヤ", "appearance": "黒髪に赤いコート"})
    events = collect(store, [aya["id"]], fake_comfy["ensure_comfy"])
    stages = [e["stage"] for e in events if "stage" in e]
    assert any("参照画像" in s for s in stages) and any("プロフィール画像" in s for s in stages)
    assert [e for e in events if "notice" in e] == [{"notice": "「アヤ」の参照画像とプロフィール画像を作りました。", "character_id": aya["id"]}]
    got = store.get_character(aya["id"])
    assert got["ref_image_path"] and got["portrait_path"] and got["ref_image_path"] != got["portrait_path"]
    assert got["portrait_source_path"] is None and got["portrait_crop"] is None
    # 参照画像は手動の「生成 → 決定」と同じ形でストックに入り、プロンプト・seed・組が 1 セットで残る
    assert got["ref_image_prompt"] == "1girl, black hair, red coat" and got["ref_image_workflow"] == "default"
    media = store.list_media("character", aya["id"])
    assert [m["path"] for m in media] == [got["ref_image_path"]]
    assert media[0]["prompt"] == got["ref_image_prompt"] and media[0]["seed"] == got["ref_image_seed"]
    # 顔は参照画像を手本に(edit ワークフロー、image1 = 参照画像のファイル)
    assert len(fake_comfy["workflows"]) == 2 and fake_comfy["ensure"] == 1
    ref_wf, portrait_wf = fake_comfy["workflows"]
    assert ref_wf["5"]["inputs"]["height"] == 1216
    assert fake_comfy["uploads"] == [(got["ref_image_path"], b"PNG\x01")]
    assert portrait_wf["10"]["inputs"]["image"] == f"story-graph/{got['ref_image_path']}"
    assets = store.assets_dir()
    assert (__import__("pathlib").Path(assets) / got["portrait_path"]).read_bytes() == b"PNG\x02"


def test_run_is_silent_when_disabled_or_nothing_to_do(store, fake_comfy):
    aya = store.create_character({"name": "アヤ", "appearance": "黒髪"})
    assert collect(store, [aya["id"]], fake_comfy["ensure_comfy"]) == []
    store.set_settings({auto_images.SETTING_KEY: "1"})
    # 画像が既にある人物は触らない
    store.update_character(aya["id"], {"portrait_path": "own.png"})
    assert collect(store, [aya["id"], "missing"], fake_comfy["ensure_comfy"]) == []
    assert fake_comfy["ensure"] == 0
    # 外見もプロフィールも無い人物は知らせるだけ
    bob = store.create_character({"name": "ボブ"})
    events = collect(store, [bob["id"]], fake_comfy["ensure_comfy"])
    assert len(events) == 1 and "外見もプロフィール" in events[0]["notice"] and fake_comfy["ensure"] == 0


def test_run_reports_comfy_failure_once_and_per_character_errors(store, fake_comfy, monkeypatch):
    store.set_settings({auto_images.SETTING_KEY: "1"})
    a = store.create_character({"name": "A", "profile": "旅人"})
    b = store.create_character({"name": "B", "appearance": "金髪"})

    async def broken(settings):
        raise RuntimeError("起動失敗")

    events = collect(store, [a["id"], b["id"]], broken)
    notices = [e for e in events if "notice" in e]
    assert len(notices) == 1 and notices[0]["character_id"] is None and "起動失敗" in notices[0]["notice"]
    assert store.get_character(a["id"])["ref_image_path"] is None

    # 1 人目の生成で失敗しても 2 人目は描く
    calls = {"n": 0}

    async def flaky(base_url, workflow, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("VRAM 不足")
        return b"PNG"

    monkeypatch.setattr(comfy, "run_workflow", flaky)
    events = collect(store, [a["id"], b["id"]], fake_comfy["ensure_comfy"])
    notices = [e["notice"] for e in events if "notice" in e]
    assert "VRAM 不足" in notices[0] and "作りました" in notices[1]
    assert store.get_character(a["id"])["ref_image_path"] is None and store.get_character(a["id"])["portrait_path"] is None
    assert store.get_character(b["id"])["portrait_path"]


def test_production_stream_runs_image_hook_after_creating_characters(store, monkeypatch):
    store.append_node({"id": "first", "beat": "出発", "cast": []})
    step = 0

    async def stream(messages, **kwargs):
        nonlocal step
        step += 1
        if step == 1:
            yield "done", {"tool_calls": [{"function": {"name": "create_character", "arguments": json.dumps(
                {"name": "アヤ", "appearance": "黒髪", "reason": "依頼"})}}]}
            return
        yield "done", {"content": "完了"}

    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    seen = []

    async def hook(char_ids):
        seen.append(char_ids)
        yield {"stage": "描いています…"}
        yield {"notice": "「アヤ」の参照画像とプロフィール画像を作りました。", "character_id": char_ids[0]}

    async def collect_events(execute):
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in
                production.stream(store, "fake", None, "人物を作る", execute, lambda: None, image_hook=hook)]

    events = asyncio.run(collect_events(True))
    created = next(e["changed"] for e in events if "changed" in e)
    assert seen == [[created["entity_id"]]]
    assert any(e.get("stage") == "描いています…" for e in events)
    assert next(e for e in events if "image_changed" in e)["image_changed"] == {"kind": "character", "id": created["entity_id"]}
    deltas = [e["delta"] for e in events if "delta" in e]
    assert deltas[-1].startswith("「アヤ」の参照画像")
    # 画像の知らせは done より前に流れ、履歴にも残る
    assert events.index(next(e for e in events if "image_changed" in e)) < events.index(next(e for e in events if e.get("done")))
    messages = store.get_chat(events[0]["chat_id"])["messages"]
    assert [m for m in messages if m.get("auto_image")][-1]["content"].startswith("「アヤ」")
    # 相談モードでは人物が作られないので呼ばれない
    step = 0
    seen.clear()
    asyncio.run(collect_events(False))
    assert seen == []
