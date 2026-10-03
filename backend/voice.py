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
# 声に出ない文・台詞(「……」「……っ！」など)は読まずに、この長さの間にする
PAUSE_SILENT_MS = 900
# 小さい仮名と長音は、それだけでは声にならない(「っ」「ぁ」「ー」を TTS に渡すと妙な音になる)
_SILENT_KANA = set("っッぁぃぅぇぉァィゥェォゃゅょャュョゎヮゕゖヵヶーｰ〜～")
# 台詞 1 つがこれより長ければ、文の終わりで分ける(1 回の合成が長すぎると最初の音が遅れる)
MAX_DIALOGUE_CHARS = 160
# 地の文は、同じ段落の続く文をこの字数までまとめて 1 行にする。1 行ずつ別々に合成するので、
# 行の継ぎ目ごとに声色が少し揺れる(2026-09-28 ユーザー指摘)。まとめて継ぎ目を減らす
MERGE_NARRATION_CHARS = 100
DEFAULT_SEED = 1234


def _line(text: str, kind: str, effect: str | None = None) -> dict[str, Any]:
    line = {
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
    if effect:
        line["effect"] = effect
    return line


_ENDERS = "。！？!?"
_TRAILING = "。！？!?」』）)"


def is_voiceable(text: str) -> bool:
    """声に出せる文字があるか。記号・三点リーダ・ダッシュ・小さい仮名・長音だけなら False
    (「……」「……っ！」「――」「ッ!?」など。息づかいや間であって、読む言葉ではない)。"""
    return any(_READABLE.match(ch) and ch not in _SILENT_KANA for ch in text)


# 声に出ない文・台詞の代わりに置く印。build_script が取り除き、直前の行の後ろの間を延ばす
_SILENT = {"silent": True}

# 効果音(台本の行の effect)。言葉ではなく音として鳴らすもの。エンジン非依存の名前で持ち、どう鳴らすかは
# エンジン定義の effects で決める(持たないエンジンでは鳴らさず間にする)
EFFECTS = ("gasp",)


def effect_of(text: str) -> str | None:
    """声に出ない文・台詞が効果音になるか。「……っ！」「ッ!?」のような詰まる音は息を呑む音(gasp)。
    「……」「――」のような沈黙は None(間にする)。"""
    return "gasp" if any(ch in "っッ" for ch in text) else None


def _silent_or_effect(text: str, kind: str) -> dict[str, Any]:
    effect = effect_of(text)
    return _line(text, kind, effect) if effect else _SILENT


def _sentences(text: str, quote_aware: bool = True) -> list[str]:
    """文末(。！？!? の連なり)で割る。quote_aware なら「」の中では割らない(地の文に含めた強調の
    「」の中の句点で文を割らないため)。長い台詞を割るときは、台詞の中で割るので quote_aware=False。"""
    if not quote_aware:
        return [s.strip(_TRIM) for s in _SENTENCE_END.split(text) if s.strip(_TRIM)]
    out: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(text):
        if ch in OPEN_QUOTES:
            depth += 1
        elif ch in CLOSE_QUOTES and depth > 0:
            depth -= 1
        elif depth == 0 and ch in _ENDERS and (i + 1 >= len(text) or text[i + 1] not in _TRAILING):
            out.append(text[start : i + 1])
            start = i + 1
    out.append(text[start:])
    return [s.strip(_TRIM) for s in out if s.strip(_TRIM)]


def _group_sentences(sentences: list[str], limit: int = MERGE_NARRATION_CHARS) -> list[str]:
    """続く文を limit 字までまとめる(1 文で limit を超えるものはそのまま 1 行)。"""
    groups: list[str] = []
    for s in sentences:
        if groups and len(groups[-1]) + len(s) <= limit:
            groups[-1] += s
        else:
            groups.append(s)
    return groups


# 「」の直後にこれが続くなら、その「」は名詞句(強調・引用・名前)であって台詞ではない
# (「重要な相談」という言葉、「約束」とは、「はい」って、「田村工業」から、など)
_NOUN_PHRASE_AFTER = ("という", "といった", "とは", "とか", "との", "として", "って")
_PARTICLES = "がをはにでへもやのから"


def _top_level_quotes(para: str) -> list[tuple[int, int]]:
    """段落の中のいちばん外側の「」『』の範囲 (開始, 終了の次)。閉じ忘れは段落の終わりまで。"""
    spans: list[tuple[int, int]] = []
    depth = 0
    start = 0
    for i, ch in enumerate(para):
        if ch in OPEN_QUOTES:
            if depth == 0:
                start = i
            depth += 1
        elif ch in CLOSE_QUOTES and depth > 0:
            depth -= 1
            if depth == 0:
                spans.append((start, i + 1))
    if depth > 0:
        spans.append((start, len(para)))
    return spans


def _is_speech(before: str, after: str) -> bool:
    """「」が台詞かどうか(2026-09-28 ユーザー指摘。文の途中の「」は強調のことが多い)。

    - 文の頭で始まっている: 段落の頭か、直前が文末(。！？)か別の「」の閉じ
    - 閉じた後が台詞らしい: 段落の終わり・次の「」・句読点、または「と言った」の「と」
      (「という」「とは」「って」や助詞が続くなら名詞句として扱う)
    """
    prev = before.rstrip(_TRIM)
    if prev and prev[-1] not in _ENDERS + CLOSE_QUOTES:
        return False
    rest = after.lstrip(_TRIM)
    if not rest or rest[0] in OPEN_QUOTES or rest[0] in "。、！？!?…―":
        return True
    if rest.startswith(_NOUN_PHRASE_AFTER):
        return False
    if rest[0] == "と":
        return True
    return rest[0] not in _PARTICLES


def _split_paragraph(para: str) -> list[dict[str, Any]]:
    """段落を台詞と地の文の行に分ける。台詞と判定しなかった「」は、前後の文とつなげて地の文のまま読む。"""
    lines: list[dict[str, Any]] = []
    buf = ""  # まだ行にしていない地の文(強調の「」を含む)
    pos = 0

    def flush_narration() -> None:
        nonlocal buf
        # 声に出ない文は、効果音(「……っ！」→ 息を呑む音)か間にする。そこをまたいで文をまとめない
        run: list[str] = []
        for s in _sentences(buf):
            if is_voiceable(s):
                run.append(s)
                continue
            lines.extend(_line(g, "narration") for g in _group_sentences(run))
            run = []
            lines.append(_silent_or_effect(s, "narration"))
        lines.extend(_line(g, "narration") for g in _group_sentences(run))
        buf = ""

    for start, end in _top_level_quotes(para):
        buf += para[pos:start]
        quote = para[start:end]
        if _is_speech(buf, para[end:]):
            flush_narration()
            text = quote.strip(_TRIM)
            parts = _sentences(text, quote_aware=False) if len(text) > MAX_DIALOGUE_CHARS else [text]
            lines.extend(_line(p, "dialogue") if is_voiceable(p) else _silent_or_effect(p, "dialogue") for p in parts)
        else:
            buf += quote
        pos = end
    buf += para[pos:]
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
        if not is_voiceable(para) and not effect_of(para):
            if lines:
                # 「……」「……っ！」のような無言の台詞・息づかいは間、＊＊＊ のような記号だけの段落は場面の区切り
                # 「……」だけの段落も沈黙の間(場面転換は ＊＊＊ や ◇ のような記号で書かれる)
                silent_speech = any(ch in OPEN_QUOTES + "…‥" for ch in para) or bool(_READABLE.search(para))
                pause = PAUSE_SILENT_MS if silent_speech else PAUSE_SCENE_BREAK_MS
                lines[-1]["pause_after_ms"] = max(lines[-1]["pause_after_ms"], pause)
            continue
        para_lines: list[dict[str, Any]] = []
        for line in _split_paragraph(para):
            if line is _SILENT:
                target = para_lines[-1] if para_lines else (lines[-1] if lines else None)
                if target is not None:
                    target["pause_after_ms"] = max(target["pause_after_ms"], PAUSE_SILENT_MS)
                continue
            para_lines.append(line)
        if para_lines:
            para_lines[-1]["pause_after_ms"] = max(para_lines[-1]["pause_after_ms"], PAUSE_PARAGRAPH_MS)
            lines.extend(para_lines)
    return lines


# ---- チャットの返答の読み上げ(docs/design/voice.md §6.1) -----------------------

_MD_FENCE = re.compile(r"```.*?(```|$)", re.DOTALL)
_MD_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"!\[([^\]]*)\]\([^)]*\)"), r"\1"),  # 画像 → 代替テキスト
    (re.compile(r"\[([^\]]+)\]\([^)]*\)"), r"\1"),  # リンク → 文字
    (re.compile(r"`([^`]*)`"), r"\1"),  # インラインコード
    (re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE), ""),  # 見出し
    (re.compile(r"^\s*>\s?", re.MULTILINE), ""),  # 引用
    (re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE), ""),  # 箇条書きの記号
    (re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$", re.MULTILINE), ""),  # 表の区切り行
    (re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$", re.MULTILINE), ""),  # 水平線
    (re.compile(r"\*\*|__|~~"), ""),  # 太字・取り消し線
    (re.compile(r"\*([^*\n]+)\*"), r"\1"),  # 斜体(太字を外した後に残る * の組)
    (re.compile(r"[ \t]*\|[ \t]*"), "、"),  # 表のセル区切り(改行はまたがない)
]


def strip_markdown(text: str) -> str:
    """チャットの返答(Markdown)から、読み上げに要らない記号を外す。コードブロックは丸ごと読まない。"""
    text = _MD_FENCE.sub("", text)
    for pattern, repl in _MD_RULES:
        text = pattern.sub(repl, text)
    return "\n".join(line.strip("、 ") for line in text.split("\n"))


# キャラとの会話の返事に混ざるト書き(「（少し視線を外し、落ち着いた様子で）」)。全角の丸括弧だけを見る
# (半角の () は顔文字や補足にも使われるので、ト書きとは限らない)
_STAGE_DIRECTION = re.compile(r"（[^（）]*）")


def chat_lines(
    text: str,
    char_id: str | None,
    mode: str | None,
    chat_profile_id: str | None,
    read_directions: bool = True,
) -> list[dict[str, Any]]:
    """チャットの返答を読み上げの行にする。感情は付けない(LLM をもう一度呼ぶと返答が遅れるため)。

    - 相談チャット(char_id なし): 全行を「相談相手の声」(未設定なら語り手の声)
    - キャラとの会話: 返事はキャラ本人の発言(「」を使わず一人称で話す)なので、全行をキャラの声で、
      台詞(会話調)として読む。（）のト書きは、劇中会話なら語り手の声で読み、インタビューでは読まない
      (2026-09-29 修正。以前は劇中会話で「」の外を語り手の声にしていて、返事のほとんどが語り手の声になっていた)
    - read_directions=False(設定 tts_chat_directions = '0')なら、劇中会話・会話室でもト書きを読まない
      (2026-10-03 ユーザー要望。「（〇〇な表情で）台詞」のト書きが続くと台詞の流れが切れる)
    """
    text = strip_markdown(text)
    if not char_id:
        lines = build_script(text)
        for line in lines:
            line["profile_id"] = chat_profile_id or None
        return lines
    lines = []
    pos = 0
    segments: list[tuple[str, bool]] = []  # (文, ト書きか)
    for m in _STAGE_DIRECTION.finditer(text):
        segments.append((text[pos : m.start()], False))
        segments.append((m.group(0)[1:-1], True))
        pos = m.end()
    segments.append((text[pos:], False))
    for segment, direction in segments:
        if not segment.strip():  # 空白(全角の空白・改行を含む)だけの切れ端
            continue
        if direction:
            if mode != "roleplay" or not read_directions:
                continue  # インタビューのト書きは読まない(設定で全部読まないこともできる)
            lines.extend(build_script(segment))  # 語り手の声(話者は narrator のまま)
            continue
        for line in build_script(segment):
            line["speaker"] = f"char:{char_id}"
            line["kind"] = "dialogue"  # 会話調で読む(地の文のナレーション調にしない)
            lines.append(line)
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
        line = {
                "speaker": speaker if _SPEAKER_RE.match(speaker) else "narrator",
                "kind": "dialogue" if raw.get("kind") == "dialogue" else "narration",
                "text": text,
                "source_text": str(raw.get("source_text") or text),
                "emotion": emotion if emotion in tts.EMOTIONS else "neutral",
                "intensity": intensity,
                "pause_after_ms": pause,
                "edited": bool(raw.get("edited")),
        }
        if raw.get("effect") in EFFECTS:
            line["effect"] = raw["effect"]
        out.append(line)
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


def pov_narrator(store: Any, render: dict[str, Any]) -> str | None:
    """一人称の清書なら、地の文を語る視点人物の話者(char:<id>)。三人称(視点寄りを含む)は None。

    一人称の地の文は視点人物(「俺」「私」)自身の語りなので、語り手の声ではなくその人物の声で読む
    (2026-09-28 ユーザー指摘)。人称はスタイルプリセットの person、視点は清書の pov_char で決まる。"""
    pov = render.get("pov_char")
    if not pov:
        return None
    preset = store.get_preset(render.get("preset_id") or "")
    return f"char:{pov}" if preset and preset.get("person") == "first" else None


def apply_pov_narration(lines: list[dict[str, Any]], speaker: str | None) -> None:
    """地の文の話者を視点人物にする。作者が手で直した行(edited)は、作者の指定を優先して触らない。"""
    if not speaker:
        return
    for line in lines:
        if line.get("kind") == "narration" and line.get("speaker", "narrator") == "narrator" and not line.get("edited"):
            line["speaker"] = speaker


def drop_silent_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """声に出ない行(以前の区切り方で保存された「……っ！」など)を取り除き、直前の行の間を延ばす。"""
    out: list[dict[str, Any]] = []
    for line in lines:
        if is_voiceable(line.get("text") or "") or line.get("effect") in EFFECTS:
            out.append(line)
        elif out:
            out[-1]["pause_after_ms"] = max(out[-1].get("pause_after_ms", 0), PAUSE_SILENT_MS)
    return out


_SPAN_SKIP = " \t\u3000\r\n"


def _match_at(prose: str, i: int, src: str) -> int | None:
    """prose[i:] が src と(空白の有無を無視して)一致すれば、一致した終わりの位置。"""
    j, k = 0, i
    while j < len(src):
        if k >= len(prose):
            return None
        if prose[k] == src[j]:
            j += 1
            k += 1
        elif prose[k] in _SPAN_SKIP:
            k += 1
        elif src[j] in _SPAN_SKIP:
            j += 1
        else:
            return None
    return k


def align_spans(prose: str, lines: list[dict[str, Any]]) -> None:
    """各行が清書の本文のどこにあたるか(span = [開始, 終了])を付ける。鑑賞モードで、読んでいる所を
    本文の中で強調し、ページを送るのに使う。台本の文は前後や文の間の空白を詰めてあるので、本文側の
    空白は読み飛ばして照合する。作者が読みを直した行も元の文(source_text)で探す。見つからなければ None。"""
    cursor = 0
    for line in lines:
        src = str(line.get("source_text") or line.get("text") or "").strip(_SPAN_SKIP)
        line["span"] = None
        if not src:
            continue
        i = prose.find(src[0], cursor)
        while i != -1:
            end = _match_at(prose, i, src)
            if end is not None:
                line["span"] = [i, end]
                cursor = end
                break
            i = prose.find(src[0], i + 1)


def resolve_script(store: Any, render: dict[str, Any]) -> dict[str, Any]:
    """読み上げに使う台本。保存があればそれ、無ければ規則ベースで作って前の台本から引き継ぐ(保存はしない)。
    一人称の清書は、ここで地の文の話者を視点人物にする。読み上げ・台本の画面・音声キャッシュの掃除が
    どれもここを通るので、どこでも同じ話者になる。"""
    narrator = pov_narrator(store, render)
    saved = store.get_voice_script(render["id"])
    if saved is not None:
        lines = drop_silent_lines(saved["lines"])
        apply_pov_narration(lines, narrator)
        align_spans(render.get("prose") or "", lines)
        return {"lines": lines, "source": saved["source"], "saved": True, "carried": 0}
    lines = build_script(render.get("prose") or "")
    carried = 0
    previous = store.previous_voice_script(render["node_id"], render["id"])
    if previous is not None:
        carried = carry_over(lines, previous["lines"])
    apply_pov_narration(lines, narrator)
    align_spans(render.get("prose") or "", lines)
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


# ---- 声と設定(docs/design/voice.md §5) --------------------------------------

def legacy_narrator_voice(settings: dict[str, str]) -> dict[str, Any]:
    """Step 1 の設定キー(tts_narrator_caption / _ref / _seed)で決める語り手の声。語り手の声
    (tts_narrator_profile)が未設定のときの受け皿。seed を固定しないと行ごとに声が変わる。"""
    seed_text = (settings.get("tts_narrator_seed") or "").strip()
    try:
        seed = int(seed_text) if seed_text else DEFAULT_SEED
    except ValueError:
        raise ValueError(f"語り手の seed が整数ではありません: {seed_text}")
    ref = (settings.get("tts_narrator_ref") or "").strip()
    return {
        "caption": (settings.get("tts_narrator_caption") or "").strip(),
        "ref_paths": [ref] if ref else [],
        "seed": seed,
        "preset": None,
        "params": None,
    }


def migrate_legacy_narrator(store: Any) -> dict[str, Any] | None:
    """Step 1 の語り手の設定キーを「語り手」という名前の声に移し、語り手に割り当てる(1 回だけ)。
    参照音声(絶対パス)はライブラリの assets/voices へ複製する。移したら声を返す。"""
    import shutil
    import uuid

    settings = store.get_settings()
    if (settings.get("tts_narrator_profile") or "").strip():
        return None
    caption = (settings.get("tts_narrator_caption") or "").strip()
    ref = (settings.get("tts_narrator_ref") or "").strip()
    seed_text = (settings.get("tts_narrator_seed") or "").strip()
    if not (caption or ref or seed_text):
        return None
    ref_paths: list[str] = []
    voices = store.voices_dir()
    if ref and voices and Path(ref).is_file():
        name = f"{uuid.uuid4().hex[:12]}{Path(ref).suffix.lower()}"
        shutil.copyfile(ref, Path(voices) / name)
        ref_paths.append(name)
    profile = store.create_voice_profile(
        {
            "name": "語り手",
            "caption": caption or None,
            "ref_paths": ref_paths,
            "seed": int(seed_text) if seed_text.lstrip("-").isdigit() else None,
        }
    )
    store.set_settings(
        {"tts_narrator_profile": profile["id"], "tts_narrator_caption": "", "tts_narrator_ref": "", "tts_narrator_seed": ""}
    )
    return profile


CAPTION_TEMPERATURE = 0.5
CAPTION_PROMPT = """あなたは音声合成(TTS)の声を設計するボイスディレクターです。小説の登場人物の資料から、
その人物の声を作るための「声の説明」を書きます。

- 1〜2 文の日本語。性別・年代、声の高さと質感、話す速さと調子、普段どんな話し方をするかを入れる
- 例: 「落ち着いた大人の男性。深く響く低めの声で、ゆっくりと丁寧に話している」
  「若く元気な女性の声。明るくハキハキとした少し高めのトーンで、早口気味に話している」
- 資料に無いことは、人物像から自然に推し量ってよい。名前・固有名詞・台詞の引用は書かない
- 説明文だけを出力する(前置き・かぎ括弧・箇条書きは付けない)"""


async def draft_caption(char: dict[str, Any], base_url: str) -> str:
    """キャラの資料(プロフィール・外見・口調)から声の説明の下書きを LLM で作る。保存はしない。"""
    notes = [f"名前: {char['name']}"]
    for key, label in (("profile", "プロフィール"), ("appearance", "外見"), ("voice", "口調・一人称")):
        if (char.get(key) or "").strip():
            notes.append(f"{label}: {char[key].strip()}")
    result = await llm.chat(
        [
            {"role": "system", "content": CAPTION_PROMPT},
            {"role": "user", "content": "## 人物の資料\n" + "\n".join(notes) + "\n\nこの人物の声の説明を書いてください。"},
        ],
        base_url=base_url,
        max_tokens=300,
        temperature=CAPTION_TEMPERATURE,
        label=f"声の説明: {char['name']}",
    )
    text = (result.get("content") or "").strip().strip("「」\"'")
    if not text:
        raise RuntimeError("声の説明を作れませんでした(LLM の出力が空)")
    return text


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

# キャッシュ(assets/audio)は「いま読むと使う音声」だけを残す。清書の上書き・声や台本の変更・シーンの削除・
# エンジンの切り替えで使われなくなったものは gc(expected_audio + sweep_audio)で消える。
# 作り直した清書でも変わらなかった文は同じファイル名になるので、消さずに使い回せる

def cache_key(engine_id: str, body: dict[str, Any], voice: dict[str, Any]) -> str:
    """同じ (エンジン, リクエスト, 参照音声の中身) なら同じ鍵。参照音声は差し替えに気付けるよう
    パスだけでなく大きさと更新時刻も混ぜる。"""
    ref_stats: list[Any] = []
    for ref in voice.get("ref_paths") or []:
        try:
            st = Path(ref).stat()
            ref_stats.append([st.st_size, int(st.st_mtime)])
        except OSError:
            ref_stats.append("missing")
    payload = json.dumps({"engine": engine_id, "body": body, "ref": ref_stats or None}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


# ---- 読み(名前や用語を正しく読ませる。docs/design/voice.md §4.5) -------------------

_NAME_SPACE = re.compile(r"[ \u3000]+")
# 姓だけ・名だけも覚えるのは 2 文字以上の部分だけ(「誠」のような 1 文字を置き換えると「誠実」まで読みが変わる)
MIN_PART_CHARS = 2


def reading_dict(settings: dict[str, str]) -> list[dict[str, str]]:
    """設定の読み辞書(tts_reading_dict。[{word, reading}] の JSON)。読めない値は空として扱う
    (読みが壊れていても読み上げは止めない)。"""
    try:
        value = json.loads(settings.get("tts_reading_dict") or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, dict):
            word = str(item.get("word") or "").strip()
            reading = str(item.get("reading") or "").strip()
            if word and reading and word != reading:
                out.append({"word": word, "reading": reading})
    return out


def reading_pairs(
    entities: list[dict[str, Any]], dictionary: list[dict[str, str]]
) -> list[tuple[str, str]]:
    """置き換える (語, 読み) の一覧。辞書が優先(同じ語ならキャラ・場所の読みより強い)。

    キャラ・場所は、名前と読みの両方を入れる。名前が空白で区切られていれば、空白なしの続け書き
    (「山崎 誠」→「山崎誠」)と、読みも同じ数に区切られているときの姓だけ・名だけも入れる。"""
    pairs: dict[str, str] = {}
    for item in dictionary:
        pairs.setdefault(item["word"], item["reading"])
    for entity in entities:
        name = (entity.get("name") or "").strip()
        reading = (entity.get("reading") or "").strip()
        if not name or not reading:
            continue
        pairs.setdefault(name, reading)
        name_parts = _NAME_SPACE.split(name)
        reading_parts = _NAME_SPACE.split(reading)
        if len(name_parts) > 1:
            pairs.setdefault("".join(name_parts), "".join(reading_parts))
            if len(name_parts) == len(reading_parts):
                for part, part_reading in zip(name_parts, reading_parts):
                    if len(part) >= MIN_PART_CHARS:
                        pairs.setdefault(part, part_reading)
    return [(w, r) for w, r in pairs.items() if w != r]


class Readings:
    """文中の語を読みに置き換える。長い語から先に当てる(「山崎 誠」を「山崎」より先に)。"""

    def __init__(self, pairs: list[tuple[str, str]]) -> None:
        self.table = dict(pairs)
        words = sorted(self.table, key=len, reverse=True)
        self.pattern = re.compile("|".join(re.escape(w) for w in words)) if words else None

    def apply(self, text: str) -> str:
        if self.pattern is None:
            return text
        return self.pattern.sub(lambda m: self.table[m.group(0)], text)


class VoiceBook:
    """行の話者から声を引く帳面。声・キャラの割り当て・設定をまとめて読んでおき、1 回の読み上げ(1 行)や
    掃除の間だけ使う。合成(speak)と掃除(expected_audio)が同じ計算を使うことで、「いま読むと使う
    ファイル」を合成せずに割り出せる。声の決め方を変えるときはここだけを直す。

    - 台詞(speaker = char:<id>)は、そのキャラに割り当てた声。割り当てが無ければ語り手の声
    - 地の文と narrator の台詞は語り手の声(tts_narrator_profile。未設定なら Step 1 の設定キー)
    - 声が壊れた設定(追加パラメータの JSON が読めない等)なら作るときに ValueError
    """

    def __init__(self, store: Any, settings: dict[str, str]) -> None:
        self.settings = settings
        voices = store.voices_dir()
        self.voices_dir = Path(voices) if voices else None
        self.profiles = {p["id"]: p for p in store.list_voice_profiles()}
        self.char_profile = {c["id"]: c.get("voice_profile_id") for c in store.list_characters()}
        self.extra = extra_body(settings)
        # 読み: キャラ・場所の名前の読みと、設定の読み辞書。合成の直前に文へ当てる
        self.readings = Readings(
            reading_pairs([*store.list_characters(), *store.list_places()], reading_dict(settings))
        )
        narrator_id = (settings.get("tts_narrator_profile") or "").strip()
        self.narrator = (
            self.profile_voice(self.profiles[narrator_id])
            if narrator_id in self.profiles
            else legacy_narrator_voice(settings)
        )

    def profile_voice(self, profile: dict[str, Any]) -> dict[str, Any]:
        refs = [str(self.voices_dir / name) for name in profile.get("ref_paths") or []] if self.voices_dir else []
        return {
            "caption": profile.get("caption") or "",
            "ref_paths": refs,
            "seed": profile["seed"] if profile.get("seed") is not None else DEFAULT_SEED,
            "preset": profile.get("preset"),
            "params": profile.get("params"),
        }

    def voice_for(self, line: dict[str, Any], profile_id: str | None = None) -> dict[str, Any]:
        """行を読む声。profile_id を渡すとその声で読む(声の試し読み用)。"""
        if profile_id and profile_id in self.profiles:
            return self.profile_voice(self.profiles[profile_id])
        speaker = str(line.get("speaker") or "narrator")
        if speaker.startswith("char:"):
            assigned = self.char_profile.get(speaker[5:])
            if assigned in self.profiles:
                return self.profile_voice(self.profiles[assigned])
        return self.narrator

    def line_audio(
        self, engine: dict[str, Any], line: dict[str, Any], profile_id: str | None = None
    ) -> tuple[str, dict[str, Any]] | None:
        """1 行の (キャッシュのファイル名, リクエストの body)。声だけの追加パラメータは設定の上に重ねる。
        効果音の行で、エンジンがその効果音を鳴らせない(定義の effects に無い)ときは None(鳴らさず間にする)。"""
        if line.get("effect") and line["effect"] not in (engine.get("effects") or {}):
            return None
        voice = self.voice_for(line, profile_id)
        if not line.get("effect"):
            # 名前や用語を読みに置き換えて送る(台本・清書・画面の表示は元の漢字のまま)
            line = {**line, "text": self.readings.apply(str(line.get("text") or ""))}
        extra = tts.deep_merge(self.extra, voice.get("params") or {})
        body = tts.build_request(engine, line, voice, extra)
        ext = str(body.get("response_format") or "wav")
        return f"{cache_key(engine['id'], body, voice)}.{ext}", body


async def speak(
    book: VoiceBook,
    engine: dict[str, Any],
    line: dict[str, Any],
    base_url: str,
    audio_dir: Path,
    profile_id: str | None = None,
) -> Path | None:
    """1 行を合成して音声ファイルのパスを返す。キャッシュにあれば合成しない。
    エンジンが鳴らせない効果音の行は None(呼び出し側は鳴らさずに間だけ置く)。"""
    audio = book.line_audio(engine, line, profile_id)
    if audio is None:
        return None
    name, body = audio
    ext = name.rsplit(".", 1)[1]
    path = audio_dir / name
    if path.exists():
        return path
    data = await tts.synthesize(base_url, body)
    tmp = path.with_suffix(f".{ext}.part")
    await asyncio.to_thread(tmp.write_bytes, data)
    await asyncio.to_thread(tmp.replace, path)
    return path


# 掃除で消さない猶予。合成した直後(試聴の音声を返している最中など)のファイルを守る
AUDIO_GC_GRACE_SEC = 60


def expected_audio(store: Any, settings: dict[str, str]) -> set[str]:
    """いま読み上げると使う音声のファイル名。対象は、シーン × スタイルプリセット × 視点ごとの最新の清書
    (画面に出るのはこれだけ。上書きされた古い清書は読まれない)。台本は読み上げと同じく resolve_script で決める。

    声の設定が壊れている(seed が数でない等)と ValueError。そのときに空集合を返すと全部消えてしまうので、
    呼び出し側は掃除をやめる。"""
    engine = tts.get_engine(tts.resolve_engine_id(settings))
    book = VoiceBook(store, settings)
    names: set[str] = set()
    for render in store.latest_renders():
        for line in resolve_script(store, render)["lines"]:
            audio = book.line_audio(engine, line)
            if audio is not None:
                names.add(audio[0])
    return names


def sweep_audio(audio_dir: Path, keep: set[str], now: float | None = None) -> int:
    """keep に無いファイルを消して、消した数を返す(猶予内のものは残す)。"""
    import time

    if not audio_dir.is_dir():
        return 0
    limit = (now if now is not None else time.time()) - AUDIO_GC_GRACE_SEC
    removed = 0
    for f in audio_dir.iterdir():
        if not f.is_file() or f.name in keep:
            continue
        try:
            if f.stat().st_mtime > limit:
                continue
            f.unlink()
            removed += 1
        except OSError:
            pass  # 再生中で掴まれていても次の掃除で消える
    return removed


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
