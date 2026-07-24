"""鑑賞モード — シーケンシャルレンダリング(spec §7)。

- シーン n のレンダー時、直前レンダー散文の末尾を渡して文体と場面転換を接続する
- ビートにある出来事以外を発生させない(プロンプトで厳守)
- pov_char 指定時は、そのキャラの state にある情報しか知らないものとして書く
- ビート昇格: 散文中の選択テキストからビート追記案 + イベント diff 案を生成
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import generation
import llm
from store import Store

RENDER_TEMPERATURE = 0.9
PREV_TAIL_CHARS = 1400  # 直前散文の受け渡し量(~800 tokens 目安)
MEMORY_LIMIT = 8


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _memory_contents(store: Store, memory_ids: list[str], limit: int = MEMORY_LIMIT) -> list[str]:
    contents = []
    for mid in memory_ids[-limit:]:
        row = store.conn.execute("SELECT content FROM memories WHERE id = ?", (mid,)).fetchone()
        if row:
            contents.append(row["content"])
    return contents


def _state_summary(store: Store, node_id: str, cast: list[str], pov_char: str | None) -> str:
    """レンダー用の状態要約。pov 指定時は pov キャラが知る情報のみ。"""
    state = store.get_state(node_id)
    lines: list[str] = []
    if state["world"]["time"] is not None:
        lines.append(f"時間: {state['world']['time']}")
    if pov_char is None:
        for key, value in state["world"]["facts"].items():
            lines.append(f"世界: {key} = {value}")
    target_chars = [pov_char] if pov_char else cast
    for char_id in target_chars:
        cs = state["chars"].get(char_id)
        if cs is None:
            continue
        char = store.get_character(char_id)
        name = char["name"] if char else char_id
        facts = ", ".join(f"{k}={v}" for k, v in cs["facts"].items())
        if facts:
            lines.append(f"{name}: {facts}")
        for target, rel in cs["relationships"].items():
            target_char = store.get_character(target)
            target_name = target_char["name"] if target_char else target
            lines.append(f"{name} → {target_name}: {rel['score']:+.2f}")
        for content in _memory_contents(store, cs["memories"]):
            lines.append(f"{name}の記憶: {content}")
    return "\n".join(lines) or "(状態情報なし)"


def _cast_profiles(store: Store, cast: list[str]) -> str:
    lines = []
    for char_id in cast:
        c = store.get_character(char_id)
        if not c:
            continue
        parts = [f"- {c['name']}"]
        if c.get("appearance"):
            parts.append(f"  外見: {c['appearance']}")
        if c.get("voice"):
            parts.append(f"  口調: {c['voice']}")
        lines.append("\n".join(parts))
    return "\n".join(lines)


def build_render_messages(
    store: Store,
    node: dict[str, Any],
    preset: dict[str, Any],
    pov_char: str | None,
    prev_tail: str | None,
) -> list[dict[str, str]]:
    pov_name = None
    if pov_char:
        c = store.get_character(pov_char)
        pov_name = c["name"] if c else pov_char
    person_text = (
        f"一人称({pov_name} の視点)" if preset.get("person") == "first" and pov_name
        else f"三人称({pov_name} 寄りの視点)" if pov_name
        else "三人称"
    )
    # プリセットの tone = ユーザーが編集できるシステムプロンプト全文。
    # 人称と厳守事項(アプリの整合性を守る制約)だけを末尾に自動追加する
    base_prompt = (preset.get("tone") or "").strip() or (
        "あなたはプロの小説家です。与えられたシーン(出来事の仕様書)を散文に仕上げます。"
    )
    system = "\n".join(
        [
            base_prompt,
            "",
            f"人称: {person_text}",
            "",
            "厳守事項:",
            "- シーンに書かれている出来事以外を発生させない(新しい事件・移動・関係の変化を起こさない)",
            "- 許されるのは描写・内面・会話の肉付けのみ",
            "- 「状態」にない情報を登場人物に知らせない"
            + ("(視点キャラが知らないことは地の文にも書かない)" if pov_char else ""),
            "- 直前シーンの末尾から自然に接続する(あらすじの繰り返しをしない)",
            "- 見出し・注釈・メタ情報は書かず、本文のみを出力する",
        ]
    )
    user_parts = [
        "## 登場人物",
        _cast_profiles(store, node["cast"]),
        "",
        "## 状態(このシーン適用後)",
        _state_summary(store, node["id"], node["cast"], pov_char),
        "",
        "## このシーンのビート",
        f"タイトル: {node['title'] or '(無題)'}",
        f"場所: {node['location'] or '不明'}" + (f" / 時間: {node['story_time']}" if node["story_time"] else ""),
        f"感情の核: {node['emotional_core'] or '-'}",
        node["beat"],
    ]
    if prev_tail:
        user_parts += ["", "## 直前シーンの末尾(この続きから書く)", prev_tail]
    user_parts += ["", "このビートを散文化してください。"]
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(user_parts)},
    ]


async def render_stream(
    store: Store,
    base_url: str,
    node_ids: list[str],
    preset_id: str,
    pov_char: str | None,
) -> AsyncIterator[str]:
    """node_ids を順にレンダーする SSE ストリーム。"""
    try:
        preset = store.get_preset(preset_id)
        if preset is None:
            yield _sse({"error": f"プリセットが見つかりません: {preset_id}"})
            return
        canon = store.canon_path()
        for node_id in node_ids:
            node = store.get_node(node_id)
            if node is None:
                yield _sse({"error": f"ノードが見つかりません: {node_id}"})
                return
            # 直前シーンの散文末尾(スライディングウィンドウ)
            prev_tail = None
            if node_id in canon:
                idx = canon.index(node_id)
                if idx > 0:
                    prev = store.latest_render(canon[idx - 1], preset_id, pov_char)
                    if prev:
                        prev_tail = prev["prose"][-PREV_TAIL_CHARS:]
            yield _sse({"scene_start": node_id, "title": node["title"]})
            messages = build_render_messages(store, node, preset, pov_char, prev_tail)
            prose_parts: list[str] = []
            async for delta in llm.chat_stream(
                messages,
                base_url=base_url,
                temperature=RENDER_TEMPERATURE,
                max_tokens=4096,
                label=f"清書: {node['title'] or '(無題)'}",
            ):
                prose_parts.append(delta)
                yield _sse({"delta": delta})
            prose = "".join(prose_parts).strip()
            render = store.save_render(node_id, preset_id, pov_char, prose)
            yield _sse({"scene_done": node_id, "render": render})
        yield _sse({"done": True})
    except Exception as e:  # noqa: BLE001
        yield _sse({"error": f"{type(e).__name__}: {e}"})


# ---- ビート昇格(散文 → 正史への唯一の還流経路。spec §7) --------------

PROMOTE_PROMPT = """あなたは物語の編集者です。散文レンダリングの中からユーザーが気に入った一節を、
正史(ビート = 出来事の仕様書)に取り込むための提案を作ります。

- beat_appendix: 選択された一節の内容をビートに追記する 1〜2 文(出来事の記述として)
- events: その内容が状態に影響する場合のイベント(なければ空配列)
- 選択部分に書かれていないことを追加しない"""


def promote_schema(char_ids: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "beat_appendix": {"type": "string"},
            "events": {"type": "array", "items": {"anyOf": generation._event_schemas(char_ids)}},
        },
        "required": ["beat_appendix", "events"],
    }


async def promote_preview(
    store: Store, base_url: str, node_id: str, selection: str
) -> dict[str, Any]:
    node = store.get_node(node_id)
    if node is None:
        raise KeyError(f"node not found: {node_id}")
    char_ids = sorted(store.known_char_ids())
    messages = [
        {"role": "system", "content": PROMOTE_PROMPT},
        {
            "role": "user",
            "content": "\n".join(
                [
                    "## 現在のビート",
                    node["beat"],
                    "",
                    "## ユーザーが選択した散文の一節",
                    selection,
                ]
            ),
        },
    ]
    result = await llm.chat_json(
        messages,
        base_url=base_url,
        schema=promote_schema(char_ids),
        temperature=0.3,
        max_tokens=1024,
        label="シーン取り込み提案",
    )
    generation.normalize_events(result.get("events", []))
    return result
