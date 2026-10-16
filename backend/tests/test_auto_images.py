"""制作での人物・場所の画像生成(auto_images と generate_images。docs/design/image-gen.md §14)。"""

import asyncio
import json
from pathlib import Path

import pytest

import auto_images
import comfy
import db
import embed
import image_gen
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
    calls = {"workflows": [], "uploads": [], "ensure": 0, "prompts": []}

    async def chat(messages, **kwargs):
        calls["prompts"].append(messages[0]["content"])
        if messages[0]["content"] == image_gen.PLACE_PROMPT_SYSTEM:
            return {"content": "old harbor, fog", "usage": {}}
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


def collect(store, requests, ensure):
    async def go():
        return [e async for e in auto_images.run(store, requests, llm_base_url="http://llm", ensure_comfy=ensure)]
    return asyncio.run(go())


def auto(kind, item_id):
    return {"kind": kind, "id": item_id, "explicit": False}


def explicit(kind, item_id):
    return {"kind": kind, "id": item_id, "explicit": True}


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


def test_requests_for_prefers_reservation_and_keeps_order():
    created = [("character", "a"), ("place", "p")]
    reserved = [("character", "b"), ("character", "a")]
    assert auto_images.requests_for(created, reserved) == [
        {"kind": "character", "id": "a", "explicit": True},
        {"kind": "place", "id": "p", "explicit": False},
        {"kind": "character", "id": "b", "explicit": True},
    ]


def test_run_creates_reference_and_portrait_for_new_characters(store, fake_comfy):
    store.set_settings({auto_images.SETTING_KEY: "1", "comfy_workflow": "default"})
    aya = store.create_character({"name": "アヤ", "appearance": "黒髪に赤いコート"})
    events = collect(store, [auto("character", aya["id"])], fake_comfy["ensure_comfy"])
    stages = [e["stage"] for e in events if "stage" in e]
    assert any("参照画像" in s for s in stages) and any("プロフィール画像" in s for s in stages)
    assert [e for e in events if "notice" in e] == [
        {"notice": "「アヤ」の参照画像とプロフィール画像を作りました。", "kind": "character", "id": aya["id"]}]
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
    assert (Path(store.assets_dir()) / got["portrait_path"]).read_bytes() == b"PNG\x02"


def test_run_draws_places_with_their_own_toggle(store, fake_comfy):
    port = store.create_place({"name": "港", "description": "古い港"})
    assert collect(store, [auto("place", port["id"])], fake_comfy["ensure_comfy"]) == []
    store.set_settings({auto_images.SETTING_KEYS["place"]: "1"})
    events = collect(store, [auto("place", port["id"])], fake_comfy["ensure_comfy"])
    assert [e for e in events if "notice" in e] == [{"notice": "「港」の画像を作りました。", "kind": "place", "id": port["id"]}]
    got = store.get_place(port["id"])
    assert got["image_path"] and got["image_prompt"] == "old harbor, fog" and got["image_workflow"]
    assert [m["path"] for m in store.list_media("place", port["id"])] == [got["image_path"]]
    wf = fake_comfy["workflows"][0]
    assert wf["5"]["inputs"]["width"] == 1216 and wf["8"]["inputs"]["filename_prefix"] == "story-graph/place"
    assert fake_comfy["prompts"] == [image_gen.PLACE_PROMPT_SYSTEM]


def test_run_is_silent_when_disabled_or_nothing_to_do(store, fake_comfy):
    aya = store.create_character({"name": "アヤ", "appearance": "黒髪"})
    assert collect(store, [auto("character", aya["id"])], fake_comfy["ensure_comfy"]) == []
    store.set_settings({auto_images.SETTING_KEY: "1"})
    # 画像が既にある人物は(自動では)触らない
    store.update_character(aya["id"], {"portrait_path": "own.png"})
    assert collect(store, [auto("character", aya["id"]), auto("character", "missing"), auto("other", "x")],
                   fake_comfy["ensure_comfy"]) == []
    assert fake_comfy["ensure"] == 0
    # 外見もプロフィールも無い人物は知らせるだけ
    bob = store.create_character({"name": "ボブ"})
    events = collect(store, [auto("character", bob["id"])], fake_comfy["ensure_comfy"])
    assert len(events) == 1 and "外見もプロフィール" in events[0]["notice"] and fake_comfy["ensure"] == 0


def test_explicit_request_redraws_even_when_disabled_and_keeps_old_images_in_stock(store, fake_comfy):
    aya = store.create_character({"name": "アヤ", "appearance": "黒髪"})
    old = store.add_media("character", aya["id"], "old.png")
    store.select_media(old["id"])
    store.update_character(aya["id"], {"portrait_path": "own.png", "portrait_source_path": "old.png", "portrait_crop": "{}"})
    events = collect(store, [explicit("character", aya["id"])], fake_comfy["ensure_comfy"])
    assert [e["notice"] for e in events if "notice" in e] == ["「アヤ」の参照画像とプロフィール画像を作りました。"]
    got = store.get_character(aya["id"])
    assert got["ref_image_path"] != "old.png" and got["portrait_path"] != "own.png" and got["portrait_source_path"] is None
    assert {m["path"] for m in store.list_media("character", aya["id"])} == {"old.png", got["ref_image_path"]}


def test_run_reports_comfy_failure_once_and_per_item_errors(store, fake_comfy, monkeypatch):
    store.set_settings({auto_images.SETTING_KEY: "1"})
    a = store.create_character({"name": "A", "profile": "旅人"})
    b = store.create_character({"name": "B", "appearance": "金髪"})

    async def broken(settings):
        raise RuntimeError("起動失敗")

    events = collect(store, [auto("character", a["id"]), auto("character", b["id"])], broken)
    notices = [e for e in events if "notice" in e]
    assert len(notices) == 1 and notices[0]["id"] is None and "起動失敗" in notices[0]["notice"]
    assert store.get_character(a["id"])["ref_image_path"] is None

    # 1 人目の生成で失敗しても 2 人目は描く
    calls = {"n": 0}

    async def flaky(base_url, workflow, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("VRAM 不足")
        return b"PNG"

    monkeypatch.setattr(comfy, "run_workflow", flaky)
    events = collect(store, [auto("character", a["id"]), auto("character", b["id"])], fake_comfy["ensure_comfy"])
    notices = [e["notice"] for e in events if "notice" in e]
    assert "VRAM 不足" in notices[0] and "作りました" in notices[1]
    assert store.get_character(a["id"])["ref_image_path"] is None and store.get_character(a["id"])["portrait_path"] is None
    assert store.get_character(b["id"])["portrait_path"]


def _collect_stream(store, execute, hook, message="人物を作る"):
    async def go():
        return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in
                production.stream(store, "fake", None, message, execute, lambda: None, image_hook=hook)]
    return asyncio.run(go())


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

    async def hook(requests):
        seen.append(requests)
        yield {"stage": "描いています…"}
        yield {"notice": "「アヤ」の参照画像とプロフィール画像を作りました。", "kind": "character", "id": requests[0]["id"]}

    events = _collect_stream(store, True, hook)
    created = next(e["changed"] for e in events if "changed" in e)
    assert seen == [[{"kind": "character", "id": created["entity_id"], "explicit": False}]]
    assert any(e.get("stage") == "描いています…" for e in events)
    changed = next(e for e in events if "image_changed" in e)
    assert changed["image_changed"] == {"kind": "character", "id": created["entity_id"]}
    assert changed["active_library"] == {"kind": "character", "id": created["entity_id"]}
    deltas = [e["delta"] for e in events if "delta" in e]
    assert deltas[-1].startswith("「アヤ」の参照画像")
    # 画像の知らせは done より前に流れ、履歴にも残る
    assert events.index(changed) < events.index(next(e for e in events if e.get("done")))
    messages = store.get_chat(events[0]["chat_id"])["messages"]
    assert [m for m in messages if m.get("auto_image")][-1]["content"].startswith("「アヤ」")
    # 相談モードでは人物が作られないので呼ばれない
    step = 0
    seen.clear()
    _collect_stream(store, False, hook)
    assert seen == []


def test_generate_images_tool_reserves_and_runs_at_end(store, monkeypatch):
    aya = store.create_character({"id": "aya", "name": "アヤ", "appearance": "黒髪"})
    store.create_character({"id": "bob", "name": "ボブ"})
    port = store.create_place({"id": "port", "name": "港", "description": "古い港"})
    store.append_node({"id": "first", "beat": "出発", "cast": ["aya"]})
    results = []
    step = 0

    async def stream(messages, **kwargs):
        nonlocal step
        names = {tool["function"]["name"] for tool in kwargs["tools"]}
        assert ("generate_images" in names) == execute_flag[0]
        step += 1
        # 直前のツール結果を記録(予約の返事を確かめる)
        for m in messages:
            if m.get("role") == "tool":
                results.append(json.loads(m["content"]) if isinstance(m["content"], str) and m["content"].startswith("{") else m["content"])
        if step == 1:
            yield "done", {"tool_calls": [{"function": {"name": "generate_images", "arguments": json.dumps(
                {"kind": "character", "ids": ["aya", "missing"], "reason": "依頼"})}}]}
            return
        if step == 2:
            yield "done", {"tool_calls": [{"function": {"name": "generate_images", "arguments": json.dumps(
                {"kind": "character", "ids": ["bob"], "reason": "依頼"})}}]}
            return
        if step == 3:
            yield "done", {"tool_calls": [
                {"function": {"name": "generate_images", "arguments": json.dumps({"kind": "character", "ids": ["aya"], "reason": "依頼"})}},
                {"function": {"name": "generate_images", "arguments": json.dumps({"kind": "place", "ids": ["port"], "reason": "依頼"})}},
            ]}
            return
        yield "done", {"content": "予約しました。作業の終わりに描かれます。"}

    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    seen = []

    async def hook(requests):
        seen.append(requests)
        yield {"notice": "「港」の画像を作りました。", "kind": "place", "id": "port"}

    execute_flag = [True]
    events = _collect_stream(store, True, hook, "アヤと港の画像を作って")
    errors = [e["tool_error"] for e in events if "tool_error" in e]
    assert any("missing" in t for t in errors) and any("ボブ" in t and "空" in t for t in errors)
    assert seen == [[{"kind": "character", "id": "aya", "explicit": True}, {"kind": "place", "id": "port", "explicit": True}]]
    assert [e["delta"] for e in events if "delta" in e][0].startswith("画像の生成を予約しました: 「アヤ」")
    assert next(e for e in events if "image_changed" in e)["image_changed"] == {"kind": "place", "id": "port"}
    messages = store.get_chat(events[0]["chat_id"])["messages"]
    assert [m["image_request"] for m in messages if m.get("image_request")] == [
        {"kind": "character", "ids": ["aya"]}, {"kind": "place", "ids": ["port"]}]
    # 予約は変更(スナップショットの対象)には数えない
    assert next(e for e in events if e.get("done"))["changes"] == 0
    # 相談モードでは予約できず、案内して終わる
    step = 0
    seen.clear()
    execute_flag[0] = False
    events = _collect_stream(store, False, hook, "アヤの画像を作って")
    assert seen == [] and any("相談モード" in e.get("delta", "") for e in events)
    assert aya["id"] == "aya" and port["id"] == "port"


def test_image_request_guidance_in_consult_mode():
    import production_guard as guard
    assert guard.wants_images("製塩工場の画像をつくって")
    assert guard.wants_images("アヤの立ち絵を描いてほしい") and guard.wants_images("港のイラストを生成して")
    assert not guard.wants_images("製塩工場の描写を詳しくして")
    assert guard.consult_guidance_for("製塩工場の画像をつくって", "画像を生成する機能は持っておりません") == guard.CONSULT_IMAGE_GUIDANCE
    assert guard.consult_guidance_for("製塩工場の画像をつくって", "送信モードを「制作を実行」に切り替えてください") is None


def test_execute_mode_reminds_once_when_image_request_has_no_reservation(store, monkeypatch):
    store.create_place({"id": "salt", "name": "製塩工場", "description": "海辺の工場"})
    store.append_node({"id": "first", "beat": "出発", "cast": []})
    notes_seen = []
    step = 0

    async def stream(messages, **kwargs):
        nonlocal step
        step += 1
        notes_seen.append(any("generate_imagesの予約がありません" in (m.get("content") or "") for m in messages))
        if step == 1:
            yield "done", {"content": "申し訳ありませんが、画像を生成する機能は持っておりません。"}
            return
        yield "done", {"tool_calls": [{"function": {"name": "generate_images", "arguments": json.dumps(
            {"kind": "place", "ids": ["salt"], "reason": "依頼"})}}]} if step == 2 else {"content": "予約しました。"}

    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    seen = []

    async def hook(requests):
        seen.append(requests)
        return
        yield

    events = _collect_stream(store, True, hook, "製塩工場の画像をつくって")
    assert notes_seen == [False, True, False]  # 注記は 1 回だけ渡り、予約の後は消える
    assert seen == [[{"kind": "place", "id": "salt", "explicit": True}]]
    assert next(e for e in events if e.get("done"))["outcome"] == "completed"


def test_scene_request_draws_illustration_with_cast_references(store, fake_comfy, monkeypatch):
    aya = store.create_character({"id": "aya", "name": "アヤ", "appearance": "黒髪"})
    store.create_character({"id": "bob", "name": "ボブ", "appearance": "金髪"})
    port = store.create_place({"id": "port", "name": "港", "description": "古い港"})
    (Path(store.assets_dir()) / "aya-ref.png").write_bytes(b"REF")
    store.update_character("aya", {"ref_image_path": "aya-ref.png"})
    node = store.append_node({"id": "first", "title": "出発", "beat": "アヤとボブが港を出る。", "cast": ["aya", "bob"], "location": "port"})
    prompts = []

    async def chat(messages, **kwargs):
        prompts.append(messages)
        return {"content": "two people on a pier, image1 waving", "usage": {}}

    monkeypatch.setattr(llm, "chat", chat)
    # 自動の予約はシーンには無い(explicit でないものは描かない)
    assert collect(store, [auto("scene", "first")], fake_comfy["ensure_comfy"]) == []
    events = collect(store, [explicit("scene", "first")], fake_comfy["ensure_comfy"])
    assert [e for e in events if "notice" in e] == [{"notice": "「出発」の挿絵を作りました。", "kind": "scene", "id": "first"}]
    assert any("挿絵を描いています" in e.get("stage", "") for e in events)
    got = store.get_node("first")
    assert got["image_path"] and got["image_prompt"] == "two people on a pier, image1 waving" and got["image_ref_chars"] == ["aya"]
    media = store.list_media("node", "first")
    assert [m["path"] for m in media] == [got["image_path"]] and media[0]["ref_chars"] == ["aya"]
    # プロンプトは本文・登場人物(参照画像のあるアヤは image1)・場所から書く
    user = prompts[0][1]["content"]
    assert prompts[0][0]["content"] == image_gen.SCENE_PROMPT_SYSTEM
    assert "アヤ: image1" in user and "ボブ: no reference image" in user and "港" in user and "港を出る" in user
    # 参照画像を上げてから編集ワークフローで描く
    assert fake_comfy["uploads"] == [("aya-ref.png", b"REF")]
    assert fake_comfy["workflows"][0]["10"]["inputs"]["image"] == "story-graph/aya-ref.png"
    assert aya["id"] == "aya" and port["id"] == "port" and node["id"] == "first"


def test_generate_images_tool_accepts_scenes_and_rejects_empty_or_marker(store, monkeypatch):
    store.append_node({"id": "first", "title": "出発", "beat": "出発する。", "cast": []})
    store.append_node({"id": "blank", "title": "空", "beat": "", "cast": []})
    marker = next(n["id"] for n in store.graph()["nodes"] if n.get("kind"))
    step = 0

    async def stream(messages, **kwargs):
        nonlocal step
        step += 1
        calls = {1: ["blank"], 2: [marker], 3: ["first"]}
        if step in calls:
            yield "done", {"tool_calls": [{"function": {"name": "generate_images", "arguments": json.dumps(
                {"kind": "scene", "ids": calls[step], "reason": "依頼"})}}]}
            return
        yield "done", {"content": "予約しました。"}

    monkeypatch.setattr(llm, "chat_stream_tools", stream)
    seen = []

    async def hook(requests):
        seen.append(requests)
        return
        yield

    events = _collect_stream(store, True, hook, "出発の挿絵を作って")
    errors = [e["tool_error"] for e in events if "tool_error" in e]
    assert any("本文が空" in t for t in errors) and any("シーンがありません" in t for t in errors)
    assert len(errors) == 2  # 正しい予約はエラーにならない(シーンには name が無い)
    assert seen == [[{"kind": "scene", "id": "first", "explicit": True}]]
    assert next(e for e in events if e.get("done"))["outcome"] == "completed"
    assert [e["delta"] for e in events if "delta" in e][0].startswith("画像の生成を予約しました: 「出発」")
