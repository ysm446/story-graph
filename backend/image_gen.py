"""キャラクターの参照画像(全身の立ち絵)の生成。

外見の記述 → LLM で英語の画像プロンプト → ComfyUI(text-to-image)→ assets へ保存。
参照画像は後で場面生成の画像編集モデルの入力(input1 / input2)に回す前提なので、
無地背景・全身・正面・ニュートラルなポーズに固定する(docs/plan/progress.md)。
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import comfy
import llm


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

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


def character_prompt_messages(char: dict[str, Any], instructions: str | None = None) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": PROMPT_SYSTEM},
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
    char: dict[str, Any], *, base_url: str, instructions: str | None = None
) -> AsyncIterator[str]:
    """外見・プロフィール(+ 作者の追加指示)から英語プロンプト(人物描写部分のみ)をストリーミングで作る。"""
    return _stream_prompt(
        character_prompt_messages(char, instructions),
        base_url=base_url, label="ref_image_prompt", max_tokens=400, temperature=0.4,
    )


def full_prompt(description: str) -> str:
    return f"{description.strip().rstrip(',')}, {REF_IMAGE_SUFFIX}"


def _float(settings: dict[str, str], key: str, default: float) -> float:
    try:
        return float(settings.get(key) or default)
    except ValueError:
        return default


def character_workflow(settings: dict[str, str], description: str, seed: int | None = None) -> dict[str, Any]:
    checkpoint = (settings.get("comfy_checkpoint") or "").strip()
    if not checkpoint:
        raise RuntimeError("設定 →「画像生成」でチェックポイント(モデル)を選んでください")
    return comfy.build_t2i_workflow(
        checkpoint=checkpoint,
        positive=full_prompt(description),
        negative=(settings.get("comfy_negative") or comfy.DEFAULT_NEGATIVE),
        steps=int(_float(settings, "comfy_steps", comfy.DEFAULT_STEPS)),
        cfg=_float(settings, "comfy_cfg", comfy.DEFAULT_CFG),
        shift=_float(settings, "comfy_shift", comfy.DEFAULT_SHIFT),
        seed=seed,
    )


def new_seed() -> int:
    import random

    return random.randint(0, 2**53 - 1)


async def generate_character_image(
    settings: dict[str, str], description: str, *, comfy_base_url: str, seed: int | None = None
) -> tuple[bytes, int]:
    """(PNG, 使った seed)。seed を返すのは、UI で同じ絵を再現・微調整できるようにするため。
    None または負数(-1。ComfyUI などの慣例)はランダム。"""
    if seed is None or seed < 0:
        seed = new_seed()
    return await comfy.run_workflow(comfy_base_url, character_workflow(settings, description, seed)), seed


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
    "Output ONLY the prompt text itself — no preamble, no quotes, no markdown, no explanation."
)


def select_scene_refs(cast_chars: list[dict[str, Any]], limit: int = MAX_SCENE_REFS) -> list[dict[str, Any]]:
    """cast の並び(主役から)で参照画像のあるキャラを最大 limit 人選ぶ。"""
    return [c for c in cast_chars if c.get("ref_image_path")][:limit]


def _scene_notes(
    node: dict[str, Any], cast_chars: list[dict[str, Any]], refs: list[dict[str, Any]], place: dict[str, Any] | None
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
    if node.get("story_time"):
        lines.append(f"Time: {node['story_time']}")
    cast_lines = []
    for c in cast_chars:
        label = f"image{ref_ids[c['id']]} (has reference image)" if c["id"] in ref_ids else "no reference image"
        appearance = (c.get("appearance") or "").strip().replace("\n", " ")
        cast_lines.append(f"- {c.get('name')}: {label}" + (f"; appearance: {appearance}" if appearance else ""))
    lines.append("Cast:\n" + ("\n".join(cast_lines) if cast_lines else "(nobody — a landscape / establishing shot)"))
    return "\n\n".join(lines)


def scene_prompt_messages(
    node: dict[str, Any],
    cast_chars: list[dict[str, Any]],
    refs: list[dict[str, Any]],
    place: dict[str, Any] | None,
    instructions: str | None = None,
) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": SCENE_PROMPT_SYSTEM},
        {"role": "user", "content": _with_instructions(_scene_notes(node, cast_chars, refs, place), instructions)},
    ]


def stream_scene_prompt(
    node: dict[str, Any],
    cast_chars: list[dict[str, Any]],
    refs: list[dict[str, Any]],
    place: dict[str, Any] | None,
    *,
    base_url: str,
    instructions: str | None = None,
) -> AsyncIterator[str]:
    return _stream_prompt(
        scene_prompt_messages(node, cast_chars, refs, place, instructions),
        base_url=base_url, label="scene_image_prompt", max_tokens=500, temperature=0.5,
    )


def scene_workflow(
    settings: dict[str, str], description: str, ref_names: list[str], seed: int | None = None
) -> dict[str, Any]:
    checkpoint = (settings.get("comfy_checkpoint") or "").strip()
    if not checkpoint:
        raise RuntimeError("設定 →「画像生成」でチェックポイント(モデル)を選んでください")
    common = dict(
        checkpoint=checkpoint,
        positive=f"{description.strip().rstrip(',')}, {SCENE_SUFFIX}",
        negative=(settings.get("comfy_negative") or comfy.DEFAULT_NEGATIVE),
        steps=int(_float(settings, "comfy_steps", comfy.DEFAULT_STEPS)),
        cfg=_float(settings, "comfy_cfg", comfy.DEFAULT_CFG),
        shift=_float(settings, "comfy_shift", comfy.DEFAULT_SHIFT),
        seed=seed,
        width=1216,
        height=832,
    )
    if ref_names:
        return comfy.build_edit_workflow(ref_images=ref_names, **common)
    return comfy.build_t2i_workflow(filename_prefix="story-graph/scene", **common)


async def generate_scene_image(
    settings: dict[str, str],
    description: str,
    ref_files: list[tuple[str, bytes]],
    *,
    comfy_base_url: str,
    seed: int | None = None,
) -> tuple[bytes, int]:
    """ref_files は (assets のファイル名, バイト列)。ComfyUI へ上げてから描く。(PNG, 使った seed)。
    seed が None または負数ならランダム。"""
    if seed is None or seed < 0:
        seed = new_seed()
    names = [await comfy.upload_image(comfy_base_url, data, name) for name, data in ref_files]
    return await comfy.run_workflow(comfy_base_url, scene_workflow(settings, description, names, seed)), seed
