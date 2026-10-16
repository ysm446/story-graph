"""制作モードで人物を作ったときの画像の自動生成(docs/design/image-gen.md §14)。

制作 LLM が `create_character` で人物を作ると、作業の終わりに人物ごとに
外見 → 英語プロンプト(LLM)→ 参照画像(全身。ストックに入れて選択)→ プロフィール画像(顔のアップ)
の順に描く。顔は参照画像を手本に画像編集ワークフローで描くので、全身像と同じ人物になる
(2026-10-16 ユーザー発案「顔画像だけ別で生成して作ってしまう」。切り抜きより顔の描き込みが良く、
Pillow も顔検出も要らない)。

- 設定 `comfy_auto_character_images`("1" でオン。アプリ単位)で切り替える。既定はオフ。
- 画像は装飾専用。失敗しても人物の設定は残し、会話に知らせるだけ(例外を外へ出さない)。
- 人物の確定後にまとめて走らせるのは、画像 1 枚に 10〜30 秒かかり、制作の流れを止めないため。
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

import comfy
import image_gen
import llm

SETTING_KEY = "comfy_auto_character_images"

# 顔(プロフィール画像)の共通指示。正方形で顔を大きく描く
PORTRAIT_SUFFIX = (
    "close-up portrait, head and shoulders, face centered and filling the frame, front view, "
    "looking at viewer, calm neutral expression, plain solid light gray background, "
    "soft even studio lighting, single character, highly detailed"
)
# 参照画像(image1)を手本にするときの本文。人物描写は手本が持つので書かない
PORTRAIT_REF_PROMPT = "close-up portrait of the person from image1, same face, same hair, same clothing"
PORTRAIT_SIZE = 1024


def enabled(settings: dict[str, str]) -> bool:
    return (settings.get(SETTING_KEY) or "").strip() == "1"


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


def _label(char: dict[str, Any]) -> str:
    return f"「{char.get('name') or '(無名)'}」"


async def run(
    store: Any,
    char_ids: list[str],
    *,
    llm_base_url: str,
    ensure_comfy: Callable[[dict[str, str]], Awaitable[str]],
) -> AsyncIterator[dict[str, Any]]:
    """人物ごとに参照画像とプロフィール画像を作る。

    流すもの: `{"stage": 進捗}` と、人物ごと(または全体)の `{"notice": 会話に残す文, "character_id": id | None}`。
    設定がオフなら何も流さない。画像が既にある人物・外見もプロフィールも無い人物は飛ばす。
    ComfyUI が起動できなければ 1 件の notice で終える。人物ごとの失敗はその人物の notice にして次へ進む。
    """
    settings = store.get_settings()
    if not enabled(settings):
        return
    assets = store.assets_dir()
    if assets is None:
        return
    targets = []
    for char_id in char_ids:
        char = store.get_character(char_id)
        if char is None or char.get("ref_image_path") or char.get("portrait_path"):
            continue
        if not ((char.get("appearance") or "").strip() or (char.get("profile") or "").strip()):
            yield {"notice": f"{_label(char)}は外見もプロフィールも書かれていないので、画像は作りませんでした。",
                   "character_id": char_id}
            continue
        targets.append(char)
    if not targets:
        return
    yield {"stage": "画像生成の準備をしています(ComfyUI を起動中…)"}
    try:
        comfy_base_url = await ensure_comfy(settings)
    except Exception as e:  # noqa: BLE001 — 画像は装飾なので、人物の設定だけ残して知らせる
        yield {"notice": f"人物の画像を作れませんでした(ComfyUI を起動できません: {e})。人物の設定は残しています。",
               "character_id": None}
        return
    variant = image_gen.resolve_variant(settings, None)["id"]
    for char in targets:
        label = _label(char)
        try:
            yield {"stage": f"{label}の画像プロンプトを書いています…"}
            res = await llm.chat(
                image_gen.character_prompt_messages(char), base_url=llm_base_url,
                max_tokens=400, temperature=0.4, label="auto_ref_image_prompt",
            )
            prompt = image_gen._clean_prompt(res.get("content") or "")
            if not prompt:
                raise RuntimeError("画像プロンプトが空でした")
            yield {"stage": f"{label}の参照画像を描いています…"}
            ref_png, ref_seed = await image_gen.generate_character_image(
                settings, prompt, comfy_base_url=comfy_base_url, variant=variant
            )
            ref_name = await _write_asset(assets, ref_png)
            # 手動の「生成 → 決定」と同じ形でストックに入れて選択する(プロンプト・seed・組を 1 セットで)
            media = store.add_media("character", char["id"], ref_name, prompt=prompt, seed=ref_seed, workflow=variant)
            store.select_media(media["id"])
            yield {"stage": f"{label}のプロフィール画像を描いています…"}
            portrait_png, _ = await generate_portrait(
                settings, prompt, (ref_name, ref_png), comfy_base_url=comfy_base_url, variant=variant
            )
            portrait_name = await _write_asset(assets, portrait_png)
            store.update_character(
                char["id"], {"portrait_path": portrait_name, "portrait_source_path": None, "portrait_crop": None}
            )
            yield {"notice": f"{label}の参照画像とプロフィール画像を作りました。", "character_id": char["id"]}
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            yield {"notice": f"{label}の画像を作れませんでした: {e}。人物の設定は残しています。", "character_id": char["id"]}
