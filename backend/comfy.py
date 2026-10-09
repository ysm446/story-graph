"""ComfyUI の HTTP API クライアントと、アプリが使うワークフロー(API 形式 JSON)の組み立て。

- `/prompt` に投げて prompt_id を受け取り、`/history/{id}` を待って `/view` で画像を取る
- ワークフローの本体は `workflows/*.json`(リポジトリ直下)(ComfyUI の「Save (API Format)」と同じ形。
  値が `{{name}}` の欄をここで埋める)。Qwen-Image 系の AIO チェックポイント(Qwen-Rapid-AIO)前提。
  ノード ID は文字列で固定し、テストで参照できるようにしてある
"""

from __future__ import annotations

import asyncio
import json
import random
import re
from pathlib import Path
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

# リポジトリ直下の workflows/(ComfyUI に送る API 形式のワークフロー。ユーザーが差し替える前提で backend の外に置く)
WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / "workflows"
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def _load_template(name: str) -> str:
    """workflows/<name>.json(リポジトリ直下)の中身。毎回読む(小さいファイルで、編集して試すことが多い)。"""
    return (WORKFLOWS_DIR / f"{name}.json").read_text(encoding="utf-8")


DEFAULT_VARIANT = {"id": "default", "label": "既定", "t2i": "ref_t2i", "edit": "scene_edit", "values": {}}


def list_variants() -> list[dict[str, Any]]:
    """workflows/variants.json の「生成ウインドウで選べるワークフローの組」。読めなければ既定 1 つ。"""
    try:
        data = json.loads((WORKFLOWS_DIR / "variants.json").read_text(encoding="utf-8"))
        variants = [v for v in data.get("variants", []) if isinstance(v, dict) and v.get("id")]
    except (OSError, ValueError):
        variants = []
    return variants or [dict(DEFAULT_VARIANT)]


def get_variant(variant_id: str | None) -> dict[str, Any]:
    """id の組。無い / 消えた id は既定(先頭)に落とす(保存済みの id が古くても生成は止めない)。"""
    variants = list_variants()
    for v in variants:
        if v["id"] == variant_id:
            return v
    return variants[0]


def _fill(obj: Any, values: dict[str, Any]) -> Any:
    """`{{name}}` を埋める。欄の値がプレースホルダだけなら型を保って差し込む(seed や steps は数値のまま)。
    文字列の一部に含まれるときは文字列として置換する。未知の名前はそのまま残す。"""
    if isinstance(obj, dict):
        return {k: _fill(v, values) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_fill(v, values) for v in obj]
    if isinstance(obj, str):
        m = _PLACEHOLDER.fullmatch(obj)
        if m:
            return values.get(m.group(1), obj)
        return _PLACEHOLDER.sub(lambda mm: str(values.get(mm.group(1), mm.group(0))), obj)
    return obj


def _drop_optional_nodes(wf: dict[str, Any], values: dict[str, Any]) -> None:
    """`"_optional": "<name>"` を持つノードは、values[name] が空なら配線ごと外す。

    外したノードの `model` 入力(上流)を、そのノードを参照していた入力へ付け替える
    (LoRA ローダーのように「挟むだけ」のノードを組ごとに有無を切り替えるため)。
    残すノードからは `_optional` キーを落とす。
    """
    for nid in list(wf):
        node = wf[nid]
        if not isinstance(node, dict) or "_optional" not in node:
            continue
        flag = node.pop("_optional")
        if values.get(flag):
            continue
        upstream = node.get("inputs", {}).get("model")
        del wf[nid]
        if upstream is None:
            continue
        for other in wf.values():
            if not isinstance(other, dict):
                continue
            for key, val in other.get("inputs", {}).items():
                if isinstance(val, list) and len(val) == 2 and val[0] == nid:
                    other["inputs"][key] = list(upstream)


def load_workflow(name: str, values: dict[str, Any]) -> dict[str, Any]:
    """テンプレートを読んでプレースホルダを埋めた API 形式の dict を返す(`_comment` は落とす)。"""
    wf = _fill(json.loads(_load_template(name)), values)
    wf.pop("_comment", None)
    _drop_optional_nodes(wf, values)
    return wf


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
    template: str = "ref_t2i",
    extra_values: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """AIO チェックポイント 1 本で完結する text-to-image(既定は `workflows/ref_t2i.json`)。
    CheckpointLoaderSimple → ModelSamplingAuraFlow(shift) → KSampler → VAEDecode → SaveImage。
    template / extra_values は variants.json の組(LoRA 版・Krea2 など)から来る。組の値は設定画面の値より優先。"""
    if seed is None:
        seed = random.randint(0, 2**53 - 1)
    return load_workflow(
        template,
        {
            "checkpoint": checkpoint,
            "positive": positive,
            "negative": negative,
            "width": width,
            "height": height,
            "steps": steps,
            "cfg": cfg,
            "shift": shift,
            "seed": seed,
            "sampler": sampler,
            "scheduler": scheduler,
            "filename_prefix": filename_prefix,
            # 組の値が最後(モデルごとに向く steps / cfg / shift が違うので、設定画面の値より優先)
            **(extra_values or {}),
        },
    )


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
    template: str = "scene_edit",
    extra_values: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Qwen-Image-Edit 2509 系の複数画像入力(最大 3 枚)で場面を描く(既定は `workflows/scene_edit.json`)。

    ref_images は ComfyUI の input フォルダにアップロード済みのファイル名。
    `TextEncodeQwenImageEditPlus` の image1..3 に順に繋ぎ、プロンプト側は
    「image1 = 誰」で参照する(docs/design/image-gen.md §3)。テンプレートは 3 枚分の
    LoadImage("10"〜"12")を持っているので、渡した枚数より後ろのノードと配線を外す。
    Krea2 / Qwen Image 2.1 の組も同じ形のテンプレートでここを通る。"""
    if not ref_images:
        raise ValueError("ref_images が空です(参照画像が無いときは build_t2i_workflow を使う)")
    if len(ref_images) > 3:
        raise ValueError("参照画像は 3 枚までです")
    if seed is None:
        seed = random.randint(0, 2**53 - 1)
    values: dict[str, Any] = {
        "checkpoint": checkpoint,
        "positive": positive,
        "negative": negative,
        "width": width,
        "height": height,
        "steps": steps,
        "cfg": cfg,
        "shift": shift,
        "seed": seed,
        "sampler": sampler,
        "scheduler": scheduler,
        "filename_prefix": filename_prefix,
        **(extra_values or {}),  # 組の値が最後(設定画面の値より優先)
    }
    for i, name in enumerate(ref_images):
        values[f"ref_image_{i + 1}"] = name
    wf = load_workflow(template, values)
    # 入力名はモデルごとに違う(image2 / images.image_2)ので、外した LoadImage を指す配線を名前によらず外す
    unused = {str(10 + i) for i in range(len(ref_images), 3)}
    for nid in unused:
        wf.pop(nid, None)
    for node in wf.values():
        inputs = node.get("inputs", {})
        for key in [k for k, v in inputs.items() if isinstance(v, list) and len(v) == 2 and v[0] in unused]:
            del inputs[key]
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
