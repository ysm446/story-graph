"""キャラクターの参照画像(全身の立ち絵)・場面の挿絵・場所の画像の生成。

外見の記述 → LLM で英語の画像プロンプト → ComfyUI(text-to-image)→ assets へ保存。
参照画像は後で場面生成の画像編集モデルの入力(input1 / input2)に回す前提なので、
無地背景・全身・正面・ニュートラルなポーズに固定する(docs/plan/progress.md)。
"""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

import comfy
import llm


_sse = llm.sse

# 参照画像の共通指示。LLM の出力(人物の描写)の後ろに機械的に足す
REF_IMAGE_SUFFIX = (
    "full body standing portrait, entire body visible from head to feet with empty space above the head "
    "and below the shoes, front view, neutral relaxed pose, looking at viewer, "
    "plain solid light gray background, soft even studio lighting, single character, "
    "character reference sheet style, highly detailed"
)

PROMPT_SYSTEM = (
    "You write image-generation prompts in English for a character reference image.\n"
    "Given a character's name, profile, and appearance notes (may be in Japanese), "
    "describe ONLY the visible appearance as a comma-separated list of concrete visual tags: "
    "apparent age, gender presentation, body type, hair (color/length/style), eyes, skin, "
    "face features, clothing and accessories (specific colors and materials), distinguishing marks.\n"
    "Rules: 40-90 words. No names, no personality, no story, no background or scenery, "
    "no camera or style words (they are added separately). If the notes give an art style "
    "(e.g. anime, watercolor), include it as the first tag. Do not invent details that contradict the notes; "
    "fill unspecified basics with plausible neutral choices.\n"
    "Output ONLY the prompt text itself — no preamble, no quotes, no markdown, no explanation."
)


INSTRUCTIONS_HEADER = (
    "Author's extra instructions (may be in Japanese; they take priority over the notes above, "
    "translate their intent into the prompt):"
)


# 設定(ライブラリ単位)で差し替えられるシステムプロンプト。空なら既定(このファイルの定数)。
# 設定画面の「画像生成プロンプト」(docs/design/system-prompts.md)
PROMPT_SETTING_KEYS = {
    "character": "image_prompt_character",
    "place": "image_prompt_place",
    "scene_focus": "image_prompt_scene_focus",
    "scene": "image_prompt_scene",
}


def default_prompts() -> dict[str, str]:
    return {"character": PROMPT_SYSTEM, "place": PLACE_PROMPT_SYSTEM, "scene_focus": FOCUS_SYSTEM, "scene": SCENE_PROMPT_SYSTEM}


def system_prompt(settings: dict[str, str] | None, kind: str) -> str:
    custom = ((settings or {}).get(PROMPT_SETTING_KEYS[kind]) or "").strip()
    return custom or default_prompts()[kind]


def _with_instructions(notes: str, instructions: str | None) -> str:
    text = (instructions or "").strip()
    return f"{notes}\n\n{INSTRUCTIONS_HEADER}\n{text}" if text else notes


def _character_notes(char: dict[str, Any]) -> str:
    parts = [f"Name: {char.get('name') or ''}"]
    if char.get("appearance"):
        parts.append(f"Appearance:\n{char['appearance']}")
    if char.get("profile"):
        parts.append(f"Profile (for age/role hints only):\n{char['profile']}")
    return "\n\n".join(parts)


def character_prompt_messages(
    char: dict[str, Any], instructions: str | None = None, settings: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": system_prompt(settings, "character")},
        {"role": "user", "content": _with_instructions(_character_notes(char), instructions)},
    ]


def _clean_prompt(text: str) -> str:
    """LLM が付けがちな引用符・コードフェンスを剥がす。"""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`").strip()
        if t.lower().startswith("text"):
            t = t[4:].strip()
    return t.strip('"').strip("'").strip()


async def _stream_prompt(
    messages: list[dict[str, Any]], *, base_url: str, label: str, max_tokens: int, temperature: float
) -> AsyncIterator[str]:
    """プロンプト生成の SSE({delta} … {done, prompt} / {error})。平文で書かせてそのまま流す。"""
    try:
        parts: list[str] = []
        async for delta in llm.chat_stream(
            messages, base_url=base_url, temperature=temperature, max_tokens=max_tokens, label=label
        ):
            parts.append(delta)
            yield _sse({"delta": delta})
        prompt = _clean_prompt("".join(parts))
        if not prompt:
            raise RuntimeError("画像プロンプトが空でした")
        yield _sse({"done": True, "prompt": prompt})
    except Exception as e:  # noqa: BLE001
        yield _sse({"error": f"{type(e).__name__}: {e}"})


def stream_character_prompt(
    char: dict[str, Any], *, base_url: str, instructions: str | None = None, settings: dict[str, str] | None = None
) -> AsyncIterator[str]:
    """外見・プロフィール(+ 作者の追加指示)から英語プロンプト(人物描写部分のみ)をストリーミングで作る。"""
    return _stream_prompt(
        character_prompt_messages(char, instructions, settings),
        base_url=base_url, label="ref_image_prompt", max_tokens=400, temperature=0.4,
    )


def full_prompt(description: str) -> str:
    return f"{description.strip().rstrip(',')}, {REF_IMAGE_SUFFIX}"


def resolve_variant(settings: dict[str, str], variant: str | None) -> dict[str, Any]:
    """生成に使う組。variant(生成ウインドウで選んだ / 保存済みの id)→ 設定の「既定のワークフロー」→ 先頭。"""
    return comfy.get_variant(variant, settings.get("comfy_workflow") or None)


def _common_values(settings: dict[str, str], v: dict[str, Any]) -> dict[str, Any]:
    """組に依らない引数。モデル名・steps / cfg / shift は組の values が持つ(2026-10-16 ユーザー判断
    「ワークフローを選べばモデルは意識しなくていい」)。checkpoint だけは、組に書かれていなければ
    以前の設定 `comfy_checkpoint` を使う(移行前の variants.json でも描けるように)。"""
    return dict(
        extra_values=v.get("values") or {},
        checkpoint=(settings.get("comfy_checkpoint") or "").strip(),
        negative=(settings.get("comfy_negative") or comfy.DEFAULT_NEGATIVE),
    )


def _build(v: dict[str, Any], build: Any, **kwargs: Any) -> dict[str, Any]:
    try:
        return build(**kwargs)
    except comfy.MissingValuesError as e:
        label = v.get("label") or v["id"]
        if "checkpoint" in e.names:
            raise RuntimeError(
                f"ワークフロー「{label}」で使うモデル(checkpoint)が決まっていません。"
                "workflows/variants.json のこの組の values に checkpoint を書いてください"
            ) from e
        raise RuntimeError(
            f"ワークフロー「{label}」に値がありません: {', '.join(e.names)}"
            "(workflows/variants.json のこの組の values に書いてください)"
        ) from e


def character_workflow(
    settings: dict[str, str], description: str, seed: int | None = None, variant: str | None = None
) -> dict[str, Any]:
    """variant は workflows/variants.json の id(None / 不明なら設定の既定の組)。"""
    v = resolve_variant(settings, variant)
    return _build(
        v,
        comfy.build_t2i_workflow,
        template=v["t2i"],
        positive=full_prompt(description),
        seed=seed,
        **_common_values(settings, v),
    )


def new_seed() -> int:
    import random

    return random.randint(0, 2**53 - 1)


def resolve_seed(seed: int | None) -> int:
    """None または負数(-1。ComfyUI などの慣例)はランダムな seed にする"""
    return new_seed() if seed is None or seed < 0 else seed


async def save_png(assets: str, data: bytes) -> str:
    """生成した PNG を assets/ に乱数の名前で書き、そのファイル名を返す"""
    name = f"{uuid.uuid4().hex[:12]}.png"
    await asyncio.to_thread((Path(assets) / name).write_bytes, data)
    return name


async def generate_character_image(
    settings: dict[str, str],
    description: str,
    *,
    comfy_base_url: str,
    seed: int | None = None,
    variant: str | None = None,
) -> tuple[bytes, int]:
    """(PNG, 使った seed)。seed を返すのは、UI で同じ絵を再現・微調整できるようにするため。
    None または負数(-1。ComfyUI などの慣例)はランダム。"""
    seed = resolve_seed(seed)
    return await comfy.run_workflow(comfy_base_url, character_workflow(settings, description, seed, variant)), seed


# ---- 場所の画像 -------------------------------------------------------
# 説明・雰囲気 → LLM で英語の風景プロンプト → ComfyUI(text-to-image、横長)。
# 後で場面生成の背景の手本にも回せるよう、人物なしの全景に固定する(docs/design/image-gen.md §13)

PLACE_IMAGE_SUFFIX = (
    "scenery, establishing shot, wide view, no people, nobody, empty scene, "
    "detailed environment, natural lighting, no text, no watermark"
)

PLACE_PROMPT_SYSTEM = (
    "You write image-generation prompts in English for an illustration of a location (background art).\n"
    "Given a place's name, description, and atmosphere notes (may be in Japanese), "
    "describe ONLY what is visible as a comma-separated list of concrete visual tags: "
    "type of place, architecture or terrain, key objects and landmarks, materials and colors, "
    "time of day, weather, lighting, and mood conveyed through visuals.\n"
    "Rules: 40-90 words. No people or characters, no names, no story events, "
    "no camera or style words (they are added separately). If the notes give an art style "
    "(e.g. anime, watercolor), include it as the first tag. Do not invent details that contradict the notes; "
    "fill unspecified basics with plausible choices that fit the description.\n"
    "Output ONLY the prompt text itself — no preamble, no quotes, no markdown, no explanation."
)


def _place_notes(place: dict[str, Any]) -> str:
    parts = [f"Name: {place.get('name') or ''}"]
    if place.get("description"):
        parts.append(f"Description:\n{place['description']}")
    if place.get("atmosphere"):
        parts.append(f"Atmosphere:\n{place['atmosphere']}")
    return "\n\n".join(parts)


def place_prompt_messages(
    place: dict[str, Any], instructions: str | None = None, settings: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": system_prompt(settings, "place")},
        {"role": "user", "content": _with_instructions(_place_notes(place), instructions)},
    ]


def stream_place_prompt(
    place: dict[str, Any], *, base_url: str, instructions: str | None = None, settings: dict[str, str] | None = None
) -> AsyncIterator[str]:
    """説明・雰囲気(+ 作者の追加指示)から英語プロンプト(風景描写部分のみ)をストリーミングで作る。"""
    return _stream_prompt(
        place_prompt_messages(place, instructions, settings),
        base_url=base_url, label="place_image_prompt", max_tokens=400, temperature=0.4,
    )


def place_workflow(
    settings: dict[str, str], description: str, seed: int | None = None, variant: str | None = None
) -> dict[str, Any]:
    """場面の挿絵と同じ横長(1216×832)。variant は workflows/variants.json の id。"""
    v = resolve_variant(settings, variant)
    return _build(
        v,
        comfy.build_t2i_workflow,
        template=v["t2i"],
        positive=f"{description.strip().rstrip(',')}, {PLACE_IMAGE_SUFFIX}",
        seed=seed,
        width=1216,
        height=832,
        filename_prefix="story-graph/place",
        **_common_values(settings, v),
    )


async def generate_place_image(
    settings: dict[str, str],
    description: str,
    *,
    comfy_base_url: str,
    seed: int | None = None,
    variant: str | None = None,
) -> tuple[bytes, int]:
    """(PNG, 使った seed)。seed が None または負数ならランダム。"""
    seed = resolve_seed(seed)
    return await comfy.run_workflow(comfy_base_url, place_workflow(settings, description, seed, variant)), seed


# ---- 場面の挿絵 -------------------------------------------------------
# ビート + cast の参照画像(最大 3 枚)→ 画像編集モデルで場面を描く。
# 参照画像が 1 枚も無ければ text-to-image にフォールバックする(docs/design/image-gen.md §6)

MAX_SCENE_REFS = 3

SCENE_SUFFIX = (
    "cinematic illustration, wide shot, detailed background, natural lighting, "
    "no text, no speech bubbles, no watermark"
)

SCENE_PROMPT_SYSTEM = (
    "You write an image-generation prompt in English for one illustration of a story scene.\n"
    "You get the scene text (may be in Japanese), the place, and the cast. Some cast members have a "
    "reference image and are labeled like 'image1', 'image2' — refer to them ONLY by that label "
    "(e.g. 'the man from image1'), never by name, and keep their appearance as in the reference.\n"
    "Describe: who is in the frame (labels for referenced characters; a short visual description for "
    "characters without a reference), what they are doing, their expressions and poses, the setting and "
    "time of day, the mood, and the camera framing. 50-110 words, plain prose or comma-separated phrases.\n"
    "Rules: choose ONE moment from the scene, no dialogue, no character names, no story explanation, "
    "no style words (added separately), do not invent characters not in the cast.\n"
    "Put in the frame ONLY the people who speak or act in that moment, or who are the object of the action "
    "(a body, someone unconscious, someone being carried or held) - usually one or two, at most three. "
    "Leave every other cast member out entirely, even if they are present in the scene: no bystanders, "
    "no background figures. Show only what the moment requires: the minimum exchange between the people in the "
    "frame, or the specific action being taken. Do not stage a cheerful group discussion unless the text says so; "
    "keep poses, distance and expressions true to the text (someone turned away, alone, mid-action).\n"
    "Output ONLY the prompt text itself — no preamble, no quotes, no markdown, no explanation."
)


def select_scene_refs(cast_chars: list[dict[str, Any]], limit: int = MAX_SCENE_REFS) -> list[dict[str, Any]]:
    """渡した並び(主役から、または中心の人物の順)で参照画像のあるキャラを最大 limit 人選ぶ。"""
    return [c for c in cast_chars if c.get("ref_image_path")][:limit]


# 挿絵に入れる中心の人物を本文から選ぶ(2026-10-16 ユーザー判断「話す・動く人だけ。3 人目でも黙っていれば省く。
# 必要最低限の会話か、その場面に適した行動を描く」)。手本(参照画像)はここで選んだ人物から取る
FOCUS_SYSTEM = (
    "物語のシーンの本文と登場人物の一覧から、挿絵 1 枚に描く中心の人物を選びます。\n"
    "その場面で話す・行動する人物、または出来事の対象になっている人物(倒れている・運ばれている・遺体として見つかる・"
    "抱き起こされる、など)を、重要な順に最大 3 人まで選んでください。"
    "その場にいるだけ・黙って聞いているだけの人物は入れません。ふつうは 1〜2 人です。"
    "一覧に無い人物は選べません。本文から判断できなければ一覧の先頭の人物を 1 人選びます。"
)
FOCUS_SCHEMA = {
    "type": "object",
    "properties": {"character_ids": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_SCENE_REFS}},
    "required": ["character_ids"],
    "additionalProperties": False,
}


def focus_messages(
    node: dict[str, Any], cast_chars: list[dict[str, Any]], settings: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    cast = "\n".join(f"- {c['id']}: {c.get('name') or ''}" for c in cast_chars)
    return [
        {"role": "system", "content": system_prompt(settings, "scene_focus")},
        {"role": "user", "content": f"登場人物(id: 名前):\n{cast}\n\n本文:\n{node.get('beat') or ''}"},
    ]


async def choose_scene_focus(
    node: dict[str, Any], cast_chars: list[dict[str, Any]], *, base_url: str, settings: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    """挿絵に入れる中心の人物(cast の部分集合。選んだ順)。1 人以下なら LLM を呼ばない。
    失敗・空・一覧に無い id だけのときは cast の並びのまま返す(今までの cast 順と同じ結果)。"""
    if len(cast_chars) <= 1:
        return list(cast_chars)
    by_id = {c["id"]: c for c in cast_chars}
    try:
        result = await llm.chat_json(
            focus_messages(node, cast_chars, settings), base_url=base_url, schema=FOCUS_SCHEMA,
            max_tokens=200, temperature=0.2, label="scene_image_focus",
        )
        ids = result.get("character_ids") if isinstance(result, dict) else None
    except Exception:  # noqa: BLE001 — 選べなければ従来どおり cast 順
        ids = None
    chosen = []
    for cid in ids if isinstance(ids, list) else []:
        if isinstance(cid, str) and cid in by_id and by_id[cid] not in chosen:
            chosen.append(by_id[cid])
    return chosen[:MAX_SCENE_REFS] or list(cast_chars)


def _scene_notes(
    node: dict[str, Any], cast_chars: list[dict[str, Any]], refs: list[dict[str, Any]], place: dict[str, Any] | None,
    others: list[dict[str, Any]] | None = None,
) -> str:
    ref_ids = {c["id"]: i + 1 for i, c in enumerate(refs)}
    lines = []
    if node.get("title"):
        lines.append(f"Title: {node['title']}")
    lines.append(f"Scene:\n{node.get('beat') or ''}")
    if node.get("emotional_core"):
        lines.append(f"Emotional core: {node['emotional_core']}")
    if place:
        desc = " ".join(x for x in [place.get("description") or "", place.get("atmosphere") or ""] if x)
        lines.append(f"Place: {place.get('name')}" + (f" — {desc}" if desc else ""))
    cast_lines = []
    for c in cast_chars:
        label = f"image{ref_ids[c['id']]} (has reference image)" if c["id"] in ref_ids else "no reference image"
        appearance = (c.get("appearance") or "").strip().replace("\n", " ")
        cast_lines.append(f"- {c.get('name')}: {label}" + (f"; appearance: {appearance}" if appearance else ""))
    lines.append("Cast:\n" + ("\n".join(cast_lines) if cast_lines else "(nobody — a landscape / establishing shot)"))
    if others:
        # 中心から外した人物。描かせないが、名前を知らないと別人として作り直すことがあるので知らせる
        lines.append("Also present in the scene but NOT in the picture (leave them out): "
                     + ", ".join(c.get("name") or "" for c in others))
    return "\n\n".join(lines)


def scene_prompt_messages(
    node: dict[str, Any],
    cast_chars: list[dict[str, Any]],
    refs: list[dict[str, Any]],
    place: dict[str, Any] | None,
    instructions: str | None = None,
    others: list[dict[str, Any]] | None = None,
    settings: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": system_prompt(settings, "scene")},
        {"role": "user", "content": _with_instructions(_scene_notes(node, cast_chars, refs, place, others), instructions)},
    ]


def stream_scene_prompt(
    node: dict[str, Any],
    cast_chars: list[dict[str, Any]],
    refs: list[dict[str, Any]],
    place: dict[str, Any] | None,
    *,
    base_url: str,
    instructions: str | None = None,
    others: list[dict[str, Any]] | None = None,
    settings: dict[str, str] | None = None,
) -> AsyncIterator[str]:
    return _stream_prompt(
        scene_prompt_messages(node, cast_chars, refs, place, instructions, others, settings),
        base_url=base_url, label="scene_image_prompt", max_tokens=500, temperature=0.5,
    )


_REF_LABEL = re.compile(r"(?<![<\w])image\s?([1-9])(?![\w>])")


def apply_ref_label(text: str, ref_label: str | None) -> str:
    """プロンプト中の image1.. を、組の ref_label(例: `<image{n}>`)の形に直す。
    場面プロンプトは組を選ぶ前に `image1` の形で書かれるので、指し方の違うモデルには渡す直前に合わせる。"""
    if not ref_label:
        return text
    return _REF_LABEL.sub(lambda m: ref_label.replace("{n}", m.group(1)), text)


def scene_workflow(
    settings: dict[str, str],
    description: str,
    ref_names: list[str],
    seed: int | None = None,
    variant: str | None = None,
) -> dict[str, Any]:
    """variant は workflows/variants.json の id(None / 不明なら設定の既定の組)。"""
    v = resolve_variant(settings, variant)
    if ref_names:
        description = apply_ref_label(description, v.get("ref_label"))
    common = dict(
        positive=f"{description.strip().rstrip(',')}, {SCENE_SUFFIX}",
        seed=seed,
        width=1216,
        height=832,
        **_common_values(settings, v),
    )
    if ref_names:
        return _build(v, comfy.build_edit_workflow, template=v["edit"], ref_images=ref_names, **common)
    return _build(v, comfy.build_t2i_workflow, template=v["t2i"], filename_prefix="story-graph/scene", **common)


async def generate_scene_image(
    settings: dict[str, str],
    description: str,
    ref_files: list[tuple[str, bytes]],
    *,
    comfy_base_url: str,
    seed: int | None = None,
    variant: str | None = None,
) -> tuple[bytes, int]:
    """ref_files は (assets のファイル名, バイト列)。ComfyUI へ上げてから描く。(PNG, 使った seed)。
    seed が None または負数ならランダム。"""
    seed = resolve_seed(seed)
    names = [await comfy.upload_image(comfy_base_url, data, name) for name, data in ref_files]
    wf = scene_workflow(settings, description, names, seed, variant)
    return await comfy.run_workflow(comfy_base_url, wf), seed


# ---- できた画像の加工 ---------------------------------------------------
# 選択中の画像 1 枚 + 作者の指示(日本語のまま。LLM で書き直さない)→ 画像編集モデルで描き直す。
# 鉛筆画にする・モノクロにする など(2026-10-21 ユーザー要望。docs/design/image-gen.md §15)


def resolve_effect_variant(settings: dict[str, str], variant: str | None) -> dict[str, Any]:
    """加工に使う組。選んだ組 → 設定の既定の組の順で、`effect` を持つものだけを使う。
    どちらも持たなければ `effect` を持つ先頭の組。1 つも無ければ RuntimeError。"""
    v = resolve_variant(settings, variant)
    if v.get("effect"):
        return v
    for other in comfy.list_variants():
        if other.get("effect"):
            return other
    raise RuntimeError(
        "加工に使えるワークフローがありません(workflows/variants.json の組に effect のテンプレートを書いてください)"
    )


def effect_workflow(
    settings: dict[str, str], instruction: str, source_name: str, seed: int | None = None, variant: str | None = None
) -> dict[str, Any]:
    """source_name は ComfyUI にアップロード済みの元の画像。大きさはテンプレートが元の画像から決める。
    指示には何も足さない(場面の接尾辞「cinematic illustration」などは加工の向きとぶつかるため)。"""
    v = resolve_effect_variant(settings, variant)
    return _build(
        v,
        comfy.build_edit_workflow,
        template=v["effect"],
        positive=instruction.strip(),
        ref_images=[source_name],
        seed=seed,
        filename_prefix="story-graph/effect",
        **_common_values(settings, v),
    )


async def generate_effect_image(
    settings: dict[str, str],
    instruction: str,
    source: tuple[str, bytes],
    *,
    comfy_base_url: str,
    seed: int | None = None,
    variant: str | None = None,
) -> tuple[bytes, int, str]:
    """source は (assets のファイル名, バイト列)。(PNG, 使った seed, 使った組の id)。"""
    seed = resolve_seed(seed)
    v = resolve_effect_variant(settings, variant)
    name = await comfy.upload_image(comfy_base_url, source[1], source[0])
    wf = effect_workflow(settings, instruction, name, seed, v["id"])
    return await comfy.run_workflow(comfy_base_url, wf), seed, v["id"]
