"""ComfyUI の HTTP API クライアントと、アプリが使うワークフロー(API 形式 JSON)の組み立て。

- `/prompt` に投げて prompt_id を受け取り、`/history/{id}` を待って `/view` で画像を取る
- ワークフローは Qwen-Image 系の AIO チェックポイント(Qwen-Rapid-AIO)を前提にした
  text-to-image 1 本(docs/plan/progress.md「場面の画像生成」)。
  ノード ID は文字列で固定し、テストで参照できるようにしてある
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

CLIENT_ID = "story-graph"

# Qwen-Image Rapid AIO の推奨値(少ステップ蒸留。cfg は 1 固定が前提)
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
DEFAULT_SHIFT = 3.1
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_NEGATIVE = "text, watermark, signature, blurry, low quality, extra limbs, deformed hands"


async def health(base_url: str, timeout: float = 2.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(f"{base_url}/system_stats")
            return res.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


async def list_models(base_url: str, folder: str = "checkpoints") -> list[str]:
    """`/models/{folder}` — そのフォルダで ComfyUI が見つけているファイル名(サブフォルダ込み)。"""
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.get(f"{base_url}/models/{folder}")
        if res.status_code != 200:
            raise RuntimeError(f"モデル一覧の取得に失敗しました (HTTP {res.status_code})")
        data = res.json()
    return [str(x) for x in data] if isinstance(data, list) else []


# ---- ワークフロー ---------------------------------------------------

def build_t2i_workflow(
    *,
    checkpoint: str,
    positive: str,
    negative: str = DEFAULT_NEGATIVE,
    width: int = 832,
    height: int = 1216,
    steps: int = DEFAULT_STEPS,
    cfg: float = DEFAULT_CFG,
    shift: float = DEFAULT_SHIFT,
    seed: int | None = None,
    sampler: str = DEFAULT_SAMPLER,
    scheduler: str = DEFAULT_SCHEDULER,
    filename_prefix: str = "story-graph/ref",
) -> dict[str, Any]:
    """AIO チェックポイント 1 本で完結する text-to-image。
    CheckpointLoaderSimple → ModelSamplingAuraFlow(shift) → KSampler → VAEDecode → SaveImage。"""
    if seed is None:
        seed = random.randint(0, 2**53 - 1)
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "2": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": shift}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": positive}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": negative}},
        "5": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["2", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler,
                "scheduler": scheduler,
                "denoise": 1.0,
            },
        },
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": filename_prefix}},
    }


def build_edit_workflow(
    *,
    checkpoint: str,
    positive: str,
    ref_images: list[str],
    negative: str = DEFAULT_NEGATIVE,
    width: int = 1216,
    height: int = 832,
    steps: int = DEFAULT_STEPS,
    cfg: float = DEFAULT_CFG,
    shift: float = DEFAULT_SHIFT,
    seed: int | None = None,
    sampler: str = DEFAULT_SAMPLER,
    scheduler: str = DEFAULT_SCHEDULER,
    filename_prefix: str = "story-graph/scene",
) -> dict[str, Any]:
    """Qwen-Image-Edit 2509 系の複数画像入力(最大 3 枚)で場面を描く。

    ref_images は ComfyUI の input フォルダにアップロード済みのファイル名。
    `TextEncodeQwenImageEditPlus` の image1..3 に順に繋ぎ、プロンプト側は
    「image1 = 誰」で参照する(docs/design/image-gen.md §3)。
    LoadImage は "10", "11", "12"、エンコーダは "3"(正) / "4"(負)。"""
    if not ref_images:
        raise ValueError("ref_images が空です(参照画像が無いときは build_t2i_workflow を使う)")
    if len(ref_images) > 3:
        raise ValueError("参照画像は 3 枚までです")
    if seed is None:
        seed = random.randint(0, 2**53 - 1)
    wf: dict[str, Any] = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "2": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": shift}},
    }
    image_inputs: dict[str, Any] = {}
    for i, name in enumerate(ref_images):
        nid = str(10 + i)
        wf[nid] = {"class_type": "LoadImage", "inputs": {"image": name, "upload": "image"}}
        image_inputs[f"image{i + 1}"] = [nid, 0]
    wf["3"] = {
        "class_type": "TextEncodeQwenImageEditPlus",
        "inputs": {"clip": ["1", 1], "vae": ["1", 2], "prompt": positive, **image_inputs},
    }
    wf["4"] = {
        "class_type": "TextEncodeQwenImageEditPlus",
        "inputs": {"clip": ["1", 1], "vae": ["1", 2], "prompt": negative, **image_inputs},
    }
    wf["5"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}}
    wf["6"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["2", 0],
            "positive": ["3", 0],
            "negative": ["4", 0],
            "latent_image": ["5", 0],
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": sampler,
            "scheduler": scheduler,
            "denoise": 1.0,
        },
    }
    wf["7"] = {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}}
    wf["8"] = {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": filename_prefix}}
    return wf


# ---- 実行 -----------------------------------------------------------

async def upload_image(base_url: str, data: bytes, name: str) -> str:
    """参照画像を ComfyUI の input フォルダへ置き、LoadImage で使う名前を返す。
    同名は上書き(名前は assets のファイル名 = uuid なので衝突しない)。"""
    async with httpx.AsyncClient(timeout=60.0) as client:
        res = await client.post(
            f"{base_url}/upload/image",
            files={"image": (name, data, "image/png")},
            data={"overwrite": "true", "type": "input", "subfolder": "story-graph"},
        )
        if res.status_code != 200:
            raise RuntimeError(f"参照画像のアップロードに失敗しました (HTTP {res.status_code}): {res.text[:200]}")
        j = res.json()
    sub = j.get("subfolder") or ""
    return f"{sub}/{j['name']}" if sub else str(j["name"])



def _format_error(history: dict[str, Any]) -> str:
    status = history.get("status") or {}
    msgs = []
    for m in status.get("messages") or []:
        # [["execution_error", {...}], ...] の形
        if isinstance(m, list) and len(m) == 2 and m[0] == "execution_error":
            d = m[1] or {}
            msgs.append(f"{d.get('node_type', '?')}: {d.get('exception_message', '')}".strip())
    return "; ".join(msgs) or status.get("status_str") or "unknown error"


async def run_workflow(base_url: str, workflow: dict[str, Any], *, timeout: float = 900.0) -> bytes:
    """ワークフローをキューに入れ、最初の出力画像のバイト列を返す。
    キャンセル(asyncio.CancelledError)時は `/interrupt` を送って GPU を解放する。"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(f"{base_url}/prompt", json={"prompt": workflow, "client_id": CLIENT_ID})
        if res.status_code != 200:
            detail = res.text[:500]
            try:
                j = res.json()
                errs = j.get("node_errors") or {}
                parts = [j.get("error", {}).get("message", "")]
                for nid, e in errs.items():
                    for er in e.get("errors") or []:
                        parts.append(f"node {nid} ({e.get('class_type')}): {er.get('message')} {er.get('details', '')}")
                detail = "; ".join(p for p in parts if p) or detail
            except ValueError:
                pass
            raise RuntimeError(f"ComfyUI がワークフローを受け付けませんでした: {detail}")
        prompt_id = res.json().get("prompt_id")
        if not prompt_id:
            raise RuntimeError("ComfyUI から prompt_id が返りませんでした")

        deadline = asyncio.get_event_loop().time() + timeout
        try:
            while True:
                if asyncio.get_event_loop().time() > deadline:
                    raise RuntimeError("画像生成がタイムアウトしました")
                await asyncio.sleep(1.0)
                h = await client.get(f"{base_url}/history/{prompt_id}")
                if h.status_code != 200:
                    continue
                entry = (h.json() or {}).get(prompt_id)
                if not entry:
                    continue
                status = entry.get("status") or {}
                if status.get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI の実行エラー: {_format_error(entry)}")
                outputs = entry.get("outputs") or {}
                for node_out in outputs.values():
                    for img in node_out.get("images") or []:
                        if img.get("type") != "output":
                            continue
                        v = await client.get(
                            f"{base_url}/view",
                            params={"filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": "output"},
                        )
                        if v.status_code != 200:
                            raise RuntimeError(f"生成画像の取得に失敗しました (HTTP {v.status_code})")
                        return v.content
                if status.get("completed"):
                    raise RuntimeError("ComfyUI は完了しましたが画像が出力されませんでした")
        except asyncio.CancelledError:
            try:
                await client.post(f"{base_url}/interrupt")
            except (httpx.HTTPError, OSError):
                pass
            raise
