"""朗読台本の作成と、1 行ずつの音声合成(キャッシュ付き)。

設計: docs/design/voice.md。清書(renders.prose)を読み取るだけで、清書にも正史にも書き込まない。

- 行への分割は規則ベース(build_script)。清書を段落 → 「」の台詞 / 地の文の文単位に割る
- 話者と感情は LLM で付けられる(annotate_script)。LLM には行の文を書かせず、番号ごとに
  話者・感情・強さだけを選ばせるので、清書の文が欠けたり変わったりしない
- 保存するのは LLM で付けたときと作者が直したときだけ(voice_scripts)。保存が無ければ毎回
  規則ベースで作り、同じシーンの前の清書の台本から、同じ文の行を引き継ぐ(resolve_script)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Any

import llm
import tts

OPEN_QUOTES = "「『"
CLOSE_QUOTES = "」』"
# 文の終わり。直後に閉じ括弧や同じ記号が続く間は区切らない(「……!?」を割らない)
_SENTENCE_END = re.compile(r"(?<=[。！？!?])(?![。！？!?」』）)])")
# 仮名・漢字・英数字を 1 字も含まない段落(「＊＊＊」「◇」など)は場面の区切りとして間だけ空ける
_READABLE = re.compile(r"[\w぀-ヿ㐀-鿿]")
_TRIM = " \t　"

PAUSE_SENTENCE_MS = 250
PAUSE_PARAGRAPH_MS = 600
PAUSE_SCENE_BREAK_MS = 1200
# 台詞 1 つがこれより長ければ、文の終わりで分ける(1 回の合成が長すぎると最初の音が遅れる)
MAX_DIALOGUE_CHARS = 160
DEFAULT_SEED = 1234


def _line(text: str, kind: str) -> dict[str, Any]:
    return {
        "speaker": "narrator",
        "kind": kind,
        "text": text,
        # 清書から切り出したときの文。text は作者が読み仮名などを直すと変わるが、こちらは変えない
        # (作り直した清書へ引き継ぐときの突き合わせに使う)
        "source_text": text,
        "emotion": "neutral",
        "intensity": 0.5,
        "pause_after_ms": PAUSE_SENTENCE_MS,
        "edited": False,
    }


def _sentences(text: str) -> list[str]:
    return [s.strip(_TRIM) for s in _SENTENCE_END.split(text) if s.strip(_TRIM)]


def _split_paragraph(para: str) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    buf = ""
    depth = 0

    def flush_narration() -> None:
        nonlocal buf
        lines.extend(_line(s, "narration") for s in _sentences(buf))
        buf = ""

    def flush_dialogue() -> None:
        nonlocal buf
        text = buf.strip(_TRIM)
        buf = ""
        if not text:
            return
        parts = _sentences(text) if len(text) > MAX_DIALOGUE_CHARS else [text]
        lines.extend(_line(p, "dialogue") for p in parts)

    for ch in para:
        if ch in OPEN_QUOTES:
            if depth == 0:
                flush_narration()
            depth += 1
            buf += ch
        elif ch in CLOSE_QUOTES and depth > 0:
            buf += ch
            depth -= 1
            if depth == 0:
                flush_dialogue()
        else:
            buf += ch
    if depth > 0:
        flush_dialogue()  # 閉じ忘れの台詞も読む
    else:
        flush_narration()
    return lines


def build_script(prose: str) -> list[dict[str, Any]]:
    """清書を朗読台本(行の配列)にする。行の形は docs/design/voice.md §4.2。"""
    lines: list[dict[str, Any]] = []
    for raw in prose.replace("\r\n", "\n").split("\n"):
        para = raw.strip(_TRIM)
        if not para:
            if lines:
                lines[-1]["pause_after_ms"] = max(lines[-1]["pause_after_ms"], PAUSE_PARAGRAPH_MS)
            continue
        if not _READABLE.search(para):
            if lines:
                lines[-1]["pause_after_ms"] = PAUSE_SCENE_BREAK_MS
            continue
        para_lines = _split_paragraph(para)
        if para_lines:
            para_lines[-1]["pause_after_ms"] = PAUSE_PARAGRAPH_MS
            lines.extend(para_lines)
    return lines


# ---- 台本の検証・引き継ぎ ------------------------------------------------------

_SPEAKER_RE = re.compile(r"^(narrator|char:[A-Za-z0-9_-]+)$")
MAX_PAUSE_MS = 5000


def normalize_lines(lines: Any) -> list[dict[str, Any]]:
    """作者が直した台本を検証して形をそろえる。壊れた値は既定値に寄せ、読む文が空の行は落とす。"""
    if not isinstance(lines, list):
        raise ValueError("lines は配列で渡してください")
    out: list[dict[str, Any]] = []
    for raw in lines:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        speaker = str(raw.get("speaker") or "narrator")
        emotion = raw.get("emotion")
        try:
            intensity = min(1.0, max(0.0, float(raw.get("intensity", 0.5))))
        except (TypeError, ValueError):
            intensity = 0.5
        try:
            pause = min(MAX_PAUSE_MS, max(0, int(raw.get("pause_after_ms", PAUSE_SENTENCE_MS))))
        except (TypeError, ValueError):
            pause = PAUSE_SENTENCE_MS
        out.append(
            {
                "speaker": speaker if _SPEAKER_RE.match(speaker) else "narrator",
                "kind": "dialogue" if raw.get("kind") == "dialogue" else "narration",
                "text": text,
                "source_text": str(raw.get("source_text") or text),
                "emotion": emotion if emotion in tts.EMOTIONS else "neutral",
                "intensity": intensity,
                "pause_after_ms": pause,
                "edited": bool(raw.get("edited")),
            }
        )
    return out


_CARRY_FIELDS = ("speaker", "text", "emotion", "intensity", "pause_after_ms", "edited")


def carry_over(lines: list[dict[str, Any]], old_lines: list[dict[str, Any]]) -> int:
    """前の台本から、元の文(source_text)が同じ行の話者・感情・直した文などを写す。写した行数を返す。

    同じ文が何度も出てくるとき(「はい」など)は、出てくる順に対応させる。"""
    pool: dict[str, list[dict[str, Any]]] = {}
    for old in old_lines:
        pool.setdefault(old.get("source_text") or old.get("text") or "", []).append(old)
    carried = 0
    for line in lines:
        candidates = pool.get(line["source_text"])
        if not candidates:
            continue
        old = candidates.pop(0)
        for key in _CARRY_FIELDS:
            if key in old:
                line[key] = old[key]
        carried += 1
    return carried


def resolve_script(store: Any, render: dict[str, Any]) -> dict[str, Any]:
    """読み上げに使う台本。保存があればそれ、無ければ規則ベースで作って前の台本から引き継ぐ(保存はしない)。"""
    saved = store.get_voice_script(render["id"])
    if saved is not None:
        return {"lines": saved["lines"], "source": saved["source"], "saved": True, "carried": 0}
    lines = build_script(render.get("prose") or "")
    carried = 0
    previous = store.previous_voice_script(render["node_id"], render["id"])
    if previous is not None:
        carried = carry_over(lines, previous["lines"])
    return {"lines": lines, "source": "rule", "saved": False, "carried": carried}


# ---- LLM で話者と感情を付ける ---------------------------------------------------

ANNOTATE_TEMPERATURE = 0.2
# 1 回の呼び出しで扱う行数。長いシーンは分けて、前の数行を文脈として添える
ANNOTATE_CHUNK = 100
ANNOTATE_CONTEXT = 4

ANNOTATE_PROMPT = """あなたは小説の朗読の演出家です。小説の本文を行に分けた「朗読台本」に、話者と感情を付けます。

- 行の文は変えません。行の番号(i)ごとに speaker / emotion / intensity を選んで返します。渡した行すべてに 1 件ずつ返してください
- speaker: 台詞の行は、前後の地の文から誰の発言かを判断し、登場人物の ID を選びます。
  一人称の小説では、語り手(「俺」「私」)の台詞は視点人物の ID です。
  判断できない台詞や、一覧に無い人物(通行人など)の台詞は narrator。地の文の行は narrator
- emotion: その行を声に出すときの感情。neutral / joy / sad / anger / fear / surprise / whisper / shout / laugh / cry から 1 つ。
  **地の文は原則 neutral** です。朗読者は地の文を落ち着いて読み、感情は台詞で演じます。
  地の文に付けるのは、叫びのような短い独白(「なぜ忘れた。」など)に限り、地の文全体の 1 割以下に抑えます。
  台詞は、はっきりしないときだけ neutral
- intensity: 感情の強さ 0〜1。ふつうは 0.5、はっきり強いときだけ 0.8 以上"""


def _speaker_candidates(store: Any, node: dict[str, Any] | None, prose: str) -> list[dict[str, Any]]:
    """話者の候補: シーンの cast と、本文に名前が出てくる登録キャラ。"""
    ids = list((node or {}).get("cast") or [])
    for char in store.list_characters():
        if char["id"] not in ids and char.get("name") and char["name"] in prose:
            ids.append(char["id"])
    chars = []
    for cid in ids:
        char = store.get_character(cid)
        if char is not None:
            chars.append(char)
    return chars


def annotate_schema(speakers: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "i": {"type": "integer"},
                        "speaker": {"type": "string", "enum": speakers},
                        "emotion": {"type": "string", "enum": list(tts.EMOTIONS)},
                        "intensity": {"type": "number"},
                    },
                    "required": ["i", "speaker", "emotion", "intensity"],
                },
            }
        },
        "required": ["lines"],
    }


def annotate_messages(
    chars: list[dict[str, Any]], lines: list[dict[str, Any]], start: int, end: int, pov_name: str | None
) -> list[dict[str, Any]]:
    cast_lines = [f"- char:{c['id']} … {c['name']}" + (f"(口調: {c['voice']})" if c.get("voice") else "") for c in chars]
    body: list[str] = []
    for i in range(max(0, start - ANNOTATE_CONTEXT), end):
        line = lines[i]
        label = "台詞" if line["kind"] == "dialogue" else "地の文"
        text = line["text"]
        if i < start:
            body.append(f"(文脈・返さなくてよい) {label}: {text}")
        else:
            body.append(f"[{i}] {label}: {text}")
    return [
        {"role": "system", "content": ANNOTATE_PROMPT},
        {
            "role": "user",
            "content": "\n".join(
                [
                    "## 登場人物(speaker に使う ID)",
                    "- narrator … 地の文 / 判断できない台詞 / 一覧に無い人物",
                    *(cast_lines or ["(登録されている登場人物はいません)"]),
                    *([f"\n視点人物: {pov_name}(一人称の「俺」「私」などはこの人物)"] if pov_name else []),
                    "",
                    f"## 朗読台本(番号 {start}〜{end - 1} を返す)",
                    *body,
                ]
            ),
        },
    ]


async def annotate_script(
    store: Any, render: dict[str, Any], lines: list[dict[str, Any]], base_url: str
) -> list[dict[str, Any]]:
    """行に話者・感情・強さを LLM で付けて返す(lines は変更しない)。作者が直した行(edited)には触らない。
    地の文の話者は narrator のまま(語り手の声で読む)。"""
    node = store.get_node(render["node_id"])
    chars = _speaker_candidates(store, node, render.get("prose") or "")
    speakers = ["narrator", *[f"char:{c['id']}" for c in chars]]
    pov = store.get_character(render["pov_char"]) if render.get("pov_char") else None
    title = (node or {}).get("title") or "(無題)"
    out = [dict(line) for line in lines]
    for start in range(0, len(lines), ANNOTATE_CHUNK):
        end = min(len(lines), start + ANNOTATE_CHUNK)
        result = await llm.chat_json(
            annotate_messages(chars, lines, start, end, pov["name"] if pov else None),
            base_url=base_url,
            schema=annotate_schema(speakers),
            temperature=ANNOTATE_TEMPERATURE,
            # 1 行あたり 30 トークン前後。JSON の途中で切れると全部失敗するので多めに取る
            max_tokens=min(8192, 512 + 48 * (end - start)),
            label=f"台本: {title}",
        )
        for item in result.get("lines") or []:
            i = item.get("i")
            if not isinstance(i, int) or not (start <= i < end) or out[i].get("edited"):
                continue
            line = out[i]
            if line["kind"] == "dialogue" and item.get("speaker") in speakers:
                line["speaker"] = item["speaker"]
            if item.get("emotion") in tts.EMOTIONS:
                line["emotion"] = item["emotion"]
            if isinstance(item.get("intensity"), (int, float)):
                line["intensity"] = round(min(1.0, max(0.0, float(item["intensity"]))), 2)
    return out


# ---- 声と設定 --------------------------------------------------------------

def narrator_voice(settings: dict[str, str]) -> dict[str, Any]:
    """地の文の声(Step 1 は台詞もこの声で読む)。seed を固定しないと行ごとに声が変わる。"""
    seed_text = (settings.get("tts_narrator_seed") or "").strip()
    try:
        seed = int(seed_text) if seed_text else DEFAULT_SEED
    except ValueError:
        raise ValueError(f"語り手の seed が整数ではありません: {seed_text}")
    return {
        "caption": (settings.get("tts_narrator_caption") or "").strip(),
        "ref_path": (settings.get("tts_narrator_ref") or "").strip(),
        "seed": seed,
    }


def extra_body(settings: dict[str, str]) -> dict[str, Any]:
    """設定「追加パラメータ(JSON)」。エンジン定義の extra_body の上に重ねる。"""
    text = (settings.get("tts_extra_body") or "").strip()
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"追加パラメータの JSON が読めません: {e}")
    if not isinstance(value, dict):
        raise ValueError("追加パラメータは JSON のオブジェクト({...})で書いてください")
    return value


# ---- 合成(キャッシュ付き) -------------------------------------------------

def cache_key(engine_id: str, body: dict[str, Any], voice: dict[str, Any]) -> str:
    """同じ (エンジン, リクエスト, 参照音声の中身) なら同じ鍵。参照音声は差し替えに気付けるよう
    パスだけでなく大きさと更新時刻も混ぜる。"""
    ref_stat = None
    ref = voice.get("ref_path")
    if ref:
        try:
            st = Path(ref).stat()
            ref_stat = [st.st_size, int(st.st_mtime)]
        except OSError:
            ref_stat = "missing"
    payload = json.dumps({"engine": engine_id, "body": body, "ref": ref_stat}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


async def speak(
    settings: dict[str, str],
    engine: dict[str, Any],
    line: dict[str, Any],
    base_url: str,
    audio_dir: Path,
) -> Path:
    """1 行を合成して音声ファイルのパスを返す。キャッシュにあれば合成しない。"""
    voice = narrator_voice(settings)
    body = tts.build_request(engine, line, voice, extra_body(settings))
    ext = str(body.get("response_format") or "wav")
    path = audio_dir / f"{cache_key(engine['id'], body, voice)}.{ext}"
    if path.exists():
        return path
    data = await tts.synthesize(base_url, body)
    tmp = path.with_suffix(f".{ext}.part")
    await asyncio.to_thread(tmp.write_bytes, data)
    await asyncio.to_thread(tmp.replace, path)
    return path


def cache_status(audio_dir: Path | None) -> dict[str, Any]:
    if audio_dir is None or not audio_dir.is_dir():
        return {"files": 0, "bytes": 0}
    files = [f for f in audio_dir.iterdir() if f.is_file()]
    return {"files": len(files), "bytes": sum(f.stat().st_size for f in files)}


def clear_cache(audio_dir: Path | None) -> int:
    if audio_dir is None or not audio_dir.is_dir():
        return 0
    removed = 0
    for f in audio_dir.iterdir():
        if f.is_file():
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass  # 再生中で掴まれていても致命的ではない
    return removed
