"""制作モードでの人物・場所・シーンの画像生成(docs/design/image-gen.md §14)。

制作チャットの作業の終わりに、次の画像をまとめて描く。

- 制作 LLM が `create_character` / `create_place` で作った資料(設定のトグルがオンのときだけ。画像があれば飛ばす)
- 制作 LLM が `generate_images` で予約した資料・シーン(作者の「〇〇の画像を作って」「〇〇の挿絵を作って」。
  設定に関わらず描き、画像があっても描き直す。前の画像はストックに残る)。シーンの挿絵は予約だけで、
  シーンを作ったときの自動生成は無い(1 枚 15〜30 秒かかり、本文を直した後に描き直すことが多いため)

人物は 外見 → 英語プロンプト(LLM)→ 参照画像(全身。ストックに入れて選択)→ プロフィール画像(顔のアップ)。
顔は参照画像を手本に画像編集ワークフローで描くので、全身像と同じ人物になる
(2026-10-16 ユーザー発案「顔画像だけ別で生成して作ってしまう」。切り抜きより顔の描き込みが良く、
Pillow も顔検出も要らない)。場所は 説明 → 英語プロンプト → 全景(横長。ストックに入れて選択)。

- 画像は装飾専用。失敗しても資料は残し、会話に知らせるだけ(例外を外へ出さない)。
- 確定の中で待たず作業の終わりにまとめるのは、1 件に 10〜60 秒かかり、制作の流れを止めないため。
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

import comfy
import image_gen
import llm

KINDS = ("character", "place", "scene")
GETTERS = {"character": "get_character", "place": "get_place", "scene": "get_node"}
# 作った資料の画像を自動で描くか(アプリ単位。"1" でオン)。シーンに自動は無い(予約だけ)
SETTING_KEYS = {"character": "comfy_auto_character_images", "place": "comfy_auto_place_images"}
SETTING_KEY = SETTING_KEYS["character"]


def get_item(store: Any, kind: str, item_id: str) -> dict[str, Any] | None:
    return getattr(store, GETTERS[kind])(item_id) if kind in GETTERS else None

# 顔(プロフィール画像)の共通指示。正方形で顔を大きく描く
PORTRAIT_SUFFIX = (
    "close-up portrait, head and shoulders, face centered and filling the frame, front view, "
    "looking at viewer, calm neutral expression, plain solid light gray background, "
    "soft even studio lighting, single character, highly detailed"
)
# 参照画像(image1)を手本にするときの本文。人物描写は手本が持つので書かない
PORTRAIT_REF_PROMPT = "close-up portrait of the person from image1, same face, same hair, same clothing"
PORTRAIT_SIZE = 1024


def enabled(settings: dict[str, str], kind: str = "character") -> bool:
    key = SETTING_KEYS.get(kind)
    return bool(key) and (settings.get(key) or "").strip() == "1"


def portrait_workflow(
    settings: dict[str, str],
    description: str,
    ref_name: str | None,
    seed: int | None = None,
    variant: str | None = None,
) -> dict[str, Any]:
    """顔のワークフロー。参照画像(ComfyUI にアップロード済みの名前)があれば組の `edit` で手本にし、
    無ければ組の `t2i` で人物描写から描く。どちらも正方形(PORTRAIT_SIZE)。"""
    v = image_gen.resolve_variant(settings, variant)
    common = dict(
        seed=seed,
        width=PORTRAIT_SIZE,
        height=PORTRAIT_SIZE,
        filename_prefix="story-graph/portrait",
        **image_gen._common_values(settings, v),
    )
    if ref_name:
        positive = f"{image_gen.apply_ref_label(PORTRAIT_REF_PROMPT, v.get('ref_label'))}, {PORTRAIT_SUFFIX}"
        return image_gen._build(v, comfy.build_edit_workflow, template=v["edit"], ref_images=[ref_name], positive=positive, **common)
    positive = f"{description.strip().rstrip(',')}, {PORTRAIT_SUFFIX}"
    return image_gen._build(v, comfy.build_t2i_workflow, template=v["t2i"], positive=positive, **common)


async def generate_portrait(
    settings: dict[str, str],
    description: str,
    ref_file: tuple[str, bytes] | None,
    *,
    comfy_base_url: str,
    seed: int | None = None,
    variant: str | None = None,
) -> tuple[bytes, int]:
    """(PNG, 使った seed)。ref_file は (assets のファイル名, バイト列)。"""
    if seed is None or seed < 0:
        seed = image_gen.new_seed()
    ref_name = await comfy.upload_image(comfy_base_url, ref_file[1], ref_file[0]) if ref_file else None
    wf = portrait_workflow(settings, description, ref_name, seed, variant)
    return await comfy.run_workflow(comfy_base_url, wf), seed


async def _write_asset(assets: str, data: bytes) -> str:
    name = f"{uuid.uuid4().hex[:12]}.png"
    await asyncio.to_thread((Path(assets) / name).write_bytes, data)
    return name


def _label(item: dict[str, Any]) -> str:
    return f"「{item.get('name') or item.get('title') or '(無題)'}」"


def _has_image(kind: str, item: dict[str, Any]) -> bool:
    if kind == "character":
        return bool(item.get("ref_image_path") or item.get("portrait_path"))
    return bool(item.get("image_path"))


NOTES_KEYS = {"character": ("appearance", "profile"), "place": ("description", "atmosphere"), "scene": ("beat",)}
NOTES_LABEL = {"character": "外見もプロフィールも", "place": "説明も雰囲気も", "scene": "本文が"}


def _has_notes(kind: str, item: dict[str, Any]) -> bool:
    return any((item.get(k) or "").strip() for k in NOTES_KEYS[kind])


def requests_for(created: list[tuple[str, str]], reserved: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """作業の終わりに描く一覧。created は制作で作った (kind, id)(設定がオンのときだけ描く)、
    reserved は generate_images で予約した (kind, id)(必ず描く)。同じ資料は予約を優先し、順は最初に出た順。"""
    order: list[tuple[str, str]] = []
    explicit: set[tuple[str, str]] = set()
    for key in [*created, *reserved]:
        if key not in order:
            order.append(key)
    explicit.update(reserved)
    return [{"kind": kind, "id": item_id, "explicit": (kind, item_id) in explicit} for kind, item_id in order]


async def _prompt(messages: list[dict[str, Any]], base_url: str, label: str) -> str:
    res = await llm.chat(messages, base_url=base_url, max_tokens=400, temperature=0.4, label=label)
    prompt = image_gen._clean_prompt(res.get("content") or "")
    if not prompt:
        raise RuntimeError("画像プロンプトが空でした")
    return prompt


async def _draw_character(store: Any, settings: dict[str, str], char: dict[str, Any], *, assets: str, llm_base_url: str,
                          comfy_base_url: str, variant: str) -> AsyncIterator[dict[str, Any]]:
    label = _label(char)
    target = {"kind": "character", "id": char["id"]}
    yield {"stage": f"{label}の画像プロンプトを書いています…", **target}
    prompt = await _prompt(image_gen.character_prompt_messages(char), llm_base_url, "auto_ref_image_prompt")
    yield {"stage": f"{label}の参照画像を描いています…", **target}
    ref_png, ref_seed = await image_gen.generate_character_image(settings, prompt, comfy_base_url=comfy_base_url, variant=variant)
    ref_name = await _write_asset(assets, ref_png)
    # 手動の「生成 → 決定」と同じ形でストックに入れて選択する(プロンプト・seed・組を 1 セットで)
    media = store.add_media("character", char["id"], ref_name, prompt=prompt, seed=ref_seed, workflow=variant)
    store.select_media(media["id"])
    yield {"stage": f"{label}のプロフィール画像を描いています…", **target}
    portrait_png, _ = await generate_portrait(settings, prompt, (ref_name, ref_png), comfy_base_url=comfy_base_url, variant=variant)
    portrait_name = await _write_asset(assets, portrait_png)
    store.update_character(char["id"], {"portrait_path": portrait_name, "portrait_source_path": None, "portrait_crop": None})
    yield {"notice": f"{label}の参照画像とプロフィール画像を作りました。", "kind": "character", "id": char["id"]}


async def _draw_place(store: Any, settings: dict[str, str], place: dict[str, Any], *, assets: str, llm_base_url: str,
                      comfy_base_url: str, variant: str) -> AsyncIterator[dict[str, Any]]:
    label = _label(place)
    target = {"kind": "place", "id": place["id"]}
    yield {"stage": f"{label}の画像プロンプトを書いています…", **target}
    prompt = await _prompt(image_gen.place_prompt_messages(place), llm_base_url, "auto_place_image_prompt")
    yield {"stage": f"{label}の画像を描いています…", **target}
    png, seed = await image_gen.generate_place_image(settings, prompt, comfy_base_url=comfy_base_url, variant=variant)
    name = await _write_asset(assets, png)
    media = store.add_media("place", place["id"], name, prompt=prompt, seed=seed, workflow=variant)
    store.select_media(media["id"])
    yield {"notice": f"{label}の画像を作りました。", "kind": "place", "id": place["id"]}


async def _draw_scene(store: Any, settings: dict[str, str], node: dict[str, Any], *, assets: str, llm_base_url: str,
                      comfy_base_url: str, variant: str) -> AsyncIterator[dict[str, Any]]:
    """挿絵。手動の生成ウインドウの既定と同じく、cast の順に参照画像のある人物を 3 人まで手本にする。"""
    label = _label(node)
    chars = [c for c in (store.get_character(cid) for cid in node.get("cast") or []) if c]
    place_id, _ = store.effective_location(node["id"])
    place = store.get_place(place_id) if place_id else None
    target = {"kind": "scene", "id": node["id"]}
    yield {"stage": f"{label}の挿絵に描く人物を選んでいます…", **target}
    # 本文で話す・動く人物だけを絵に入れる(cast 順ではない)。手本もその人物から取る
    focus = await image_gen.choose_scene_focus(node, chars, base_url=llm_base_url)
    others = [c for c in chars if c not in focus]
    refs = image_gen.select_scene_refs(focus)
    yield {"stage": f"{label}の挿絵のプロンプトを書いています…", **target}
    res = await llm.chat(image_gen.scene_prompt_messages(node, focus, refs, place, others=others), base_url=llm_base_url,
                         max_tokens=500, temperature=0.5, label="auto_scene_image_prompt")
    prompt = image_gen._clean_prompt(res.get("content") or "")
    if not prompt:
        raise RuntimeError("画像プロンプトが空でした")
    ref_files = []
    for c in refs:
        p = Path(assets) / c["ref_image_path"]
        if p.is_file():
            ref_files.append((p.name, await asyncio.to_thread(p.read_bytes)))
    yield {"stage": f"{label}の挿絵を描いています…", **target}
    png, seed = await image_gen.generate_scene_image(settings, prompt, ref_files, comfy_base_url=comfy_base_url, variant=variant)
    name = await _write_asset(assets, png)
    media = store.add_media("node", node["id"], name, prompt=prompt, seed=seed, ref_chars=[c["id"] for c in refs], workflow=variant)
    store.select_media(media["id"])
    yield {"notice": f"{label}の挿絵を作りました。", "kind": "scene", "id": node["id"]}


async def run(
    store: Any,
    requests: list[dict[str, Any]],
    *,
    llm_base_url: str,
    ensure_comfy: Callable[[dict[str, str]], Awaitable[str]],
) -> AsyncIterator[dict[str, Any]]:
    """requests(`requests_for` の形)の資料を順に描く。

    流すもの: `{"stage": 進捗}`(対象が決まっているものは kind / id 付き。画面の「作業対象を追う」用)と、
    資料・シーンごと(または全体)の `{"notice": 会話に残す文, "kind", "id"}`
    (全体の知らせは kind / id が None)。自動の分は設定がオフ・画像が既にあるなら飛ばし、
    外見(説明)が無い資料は知らせるだけ。ComfyUI が起動できなければ 1 件の notice で終える。
    資料ごとの失敗はその資料の notice にして次へ進む。
    """
    settings = store.get_settings()
    assets = store.assets_dir()
    if assets is None:
        return
    targets: list[tuple[str, dict[str, Any]]] = []
    for req in requests:
        kind = req["kind"]
        if kind not in KINDS:
            continue
        item = get_item(store, kind, req["id"])
        if item is None:
            continue
        if not req.get("explicit") and (not enabled(settings, kind) or _has_image(kind, item)):
            continue
        if not _has_notes(kind, item):
            yield {"notice": f"{_label(item)}は{NOTES_LABEL[kind]}書かれていないので、画像は作りませんでした。", "kind": kind, "id": item["id"]}
            continue
        targets.append((kind, item))
    if not targets:
        return
    yield {"stage": "画像生成の準備をしています(ComfyUI を起動中…)"}
    try:
        comfy_base_url = await ensure_comfy(settings)
    except Exception as e:  # noqa: BLE001 — 画像は装飾なので、資料だけ残して知らせる
        yield {"notice": f"画像を作れませんでした(ComfyUI を起動できません: {e})。資料の設定は残しています。",
               "kind": None, "id": None}
        return
    variant = image_gen.resolve_variant(settings, None)["id"]
    for kind, item in targets:
        draw = {"character": _draw_character, "place": _draw_place, "scene": _draw_scene}[kind]
        try:
            async for event in draw(store, settings, item, assets=assets, llm_base_url=llm_base_url,
                                    comfy_base_url=comfy_base_url, variant=variant):
                yield event
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            yield {"notice": f"{_label(item)}の画像を作れませんでした: {e}。資料の設定は残しています。", "kind": kind, "id": item["id"]}
