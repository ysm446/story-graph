"""TTS エンジンの定義読み込みと、OpenAI 互換 `/v1/audio/speech` のクライアント。

設計: docs/design/voice.md。アプリとエンジンの間は `/v1/audio/speech` 1 本に揃え、
エンジンごとの違いはリポジトリ直下の `tts_engines/<id>.json` に書く(コードに直書きしない)。

- 定義 JSON の文字列にある `{name}` は値で埋める。値が `{name}` だけの欄は型を保って差し込み
  (seed を数値のまま渡すため)、埋める値が空の欄はリクエストから落とす
- 台本の感情タグ(エンジン非依存)をエンジン固有の表現に写すのは `STYLE_MAPS`。
  写した結果は送る直前に作って捨て、台本にも清書にも保存しない
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Callable

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
ENGINES_DIR = REPO_ROOT / "tts_engines"
DEFAULT_ENGINE = "irodori"

# 台本の感情タグの語彙(docs/design/voice.md §4.2)。どの style_map も未知の語は neutral 扱いにする
EMOTIONS = ("neutral", "joy", "sad", "anger", "fear", "surprise", "whisper", "shout", "laugh", "cry")

_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")
_ID_RE = re.compile(r"^[a-z0-9_-]+$")


# ---- エンジン定義 ----------------------------------------------------

def list_engines() -> list[dict[str, Any]]:
    engines = []
    for path in sorted(ENGINES_DIR.glob("*.json")):
        try:
            engines.append(_load(path))
        except (OSError, ValueError):
            continue  # 壊れた定義は一覧から外すだけ(ほかのエンジンは使える)
    return engines


def get_engine(engine_id: str | None) -> dict[str, Any]:
    engine_id = (engine_id or "").strip() or DEFAULT_ENGINE
    if not _ID_RE.match(engine_id):
        raise ValueError(f"不正なエンジン ID です: {engine_id}")
    path = ENGINES_DIR / f"{engine_id}.json"
    if not path.exists():
        raise ValueError(f"TTS エンジンの定義がありません: tts_engines/{engine_id}.json")
    return _load(path)


def _load(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("id") != path.stem:
        raise ValueError(f"{path.name} の id がファイル名と一致しません")
    return data


def resolve_engine_id(settings: dict[str, str]) -> str:
    return (settings.get("tts_engine") or "").strip() or DEFAULT_ENGINE


def resolve_base_url(settings: dict[str, str], engine: dict[str, Any]) -> str:
    configured = (settings.get("tts_base_url") or "").strip().rstrip("/")
    return configured or f"http://127.0.0.1:{engine.get('default_port', 8088)}"


# ---- テンプレート ------------------------------------------------------

class _Drop:
    """埋める値が空だった欄の印。fill の後で取り除く。"""


_DROP = _Drop()


def fill(obj: Any, values: dict[str, Any]) -> Any:
    """定義 JSON の `{name}` を values で埋める。

    - 文字列がちょうど `{name}` なら値をそのまま(型を保って)入れる
    - 文字列の一部なら str にして置き換える
    - 値が None / 空文字の欄は、辞書のキーごと・配列の要素ごと落とす
    """
    result = _fill(obj, values)
    return None if result is _DROP else result


def _fill(obj: Any, values: dict[str, Any]) -> Any:
    if isinstance(obj, str):
        names = _PLACEHOLDER.findall(obj)
        if not names:
            return obj
        if any(values.get(n) in (None, "") for n in names):
            return _DROP
        whole = _PLACEHOLDER.fullmatch(obj)
        if whole:
            return values[whole.group(1)]
        return _PLACEHOLDER.sub(lambda m: str(values[m.group(1)]), obj)
    if isinstance(obj, list):
        items = [_fill(v, values) for v in obj]
        items = [v for v in items if v is not _DROP]
        return items if items else _DROP
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            filled = _fill(v, values)
            if filled is not _DROP:
                out[k] = filled
        return out if out or not obj else _DROP
    return obj


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """辞書は再帰的に重ね、それ以外(配列を含む)は patch で置き換える。base は変更しない。"""
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


# ---- style_map(感情タグ → エンジン固有の表現) ------------------------

# Irodori-TTS v4 の絵文字(EMOJI_ANNOTATIONS.md)。同じ絵文字を重ねると効果が強まる
_IRODORI_EMOJI = {
    "joy": "😊",
    "sad": "😟",
    "anger": "😠",
    "fear": "😰",
    "surprise": "😲",
    "whisper": "👂",
    "shout": "💥",
    "laugh": "😆",
    "cry": "😭",
}
_IRODORI_NARRATION = "📖"


def irodori_emoji(line: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    text = line["text"]
    emotion = line.get("emotion") or "neutral"
    mark = _IRODORI_EMOJI.get(emotion, "")
    if mark and float(line.get("intensity") or 0.5) >= 0.8:
        mark *= 2
    if not mark and line.get("kind") == "narration":
        mark = _IRODORI_NARRATION  # 地の文は「ナレーション」の読み方に寄せる
    return f"{mark}{text}", {}


def plain(line: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    return line["text"], {}


STYLE_MAPS: dict[str, Callable[[dict[str, Any]], tuple[str, dict[str, Any]]]] = {
    "irodori_emoji": irodori_emoji,
    "none": plain,
}


# ---- リクエスト --------------------------------------------------------

def build_request(
    engine: dict[str, Any],
    line: dict[str, Any],
    voice: dict[str, Any],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """1 行ぶんの `/v1/audio/speech` の body を組む。重ねる順は
    エンジン定義の extra_body → 声(caption / 参照音声 / seed)→ style_map → 設定の追加パラメータ。"""
    req = engine.get("request") or {}
    style = STYLE_MAPS.get(engine.get("style_map") or "none", plain)
    text, style_body = style(line)
    body: dict[str, Any] = {
        "model": req.get("model", "tts-1"),
        "input": text,
        "response_format": req.get("response_format", "wav"),
    }
    if req.get("voice"):
        body["voice"] = req["voice"]
    body = deep_merge(body, req.get("extra_body") or {})

    spec = engine.get("voice") or {}
    values = {
        "caption": (voice.get("caption") or "").strip(),
        "ref_path": (voice.get("ref_path") or "").strip(),
        "seed": voice.get("seed"),
    }
    modes = spec.get("modes") or []
    if "caption" in modes and values["caption"]:
        body = deep_merge(body, fill(spec.get("caption_body") or {}, values) or {})
    if "reference" in modes and values["ref_path"]:
        body = deep_merge(body, fill(spec.get("reference_body") or {}, values) or {})
    if values["seed"] is not None:
        body = deep_merge(body, fill(spec.get("seed_body") or {}, values) or {})
    if voice.get("preset"):
        body["voice"] = voice["preset"]

    body = deep_merge(body, style_body)
    if extra:
        body = deep_merge(body, extra)
    return body


async def health(base_url: str, path: str = "/health", timeout: float = 2.0) -> bool:
    # 接続だけは短く待つ。Windows では閉じた localhost のポートへの接続が「拒否」になるまで約 2 秒
    # かかり、右上のバーが数秒ごとに呼ぶ /tts/status がその分だけ遅くなるため(動いていれば数 ms で繋がる)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=0.5)) as client:
            res = await client.get(f"{base_url}{path}")
            return res.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


async def synthesize(base_url: str, body: dict[str, Any], timeout: float = 300.0) -> bytes:
    """`/v1/audio/speech` を呼んで音声のバイト列を返す。失敗はサーバーの detail を添えて RuntimeError。"""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0)) as client:
            res = await client.post(f"{base_url}/v1/audio/speech", json=body)
    except (httpx.HTTPError, OSError) as e:
        raise RuntimeError(f"TTS サーバーに接続できませんでした({base_url}): {e}") from e
    if res.status_code != 200:
        detail = res.text[:500]
        try:
            detail = str(res.json().get("detail") or detail)
        except ValueError:
            pass
        raise RuntimeError(f"音声の合成に失敗しました(HTTP {res.status_code}): {detail}")
    return res.content
