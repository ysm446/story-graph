"""鑑賞モード — シーケンシャルレンダリング(spec §7)。

- シーン n のレンダー時、直前レンダー散文の末尾を渡して文体と場面転換を接続する
- ビートにある出来事以外を発生させない(プロンプトで厳守)
- pov_char 指定時は、そのキャラの state にある情報しか知らないものとして書く
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import llm
from store import Store

RENDER_TEMPERATURE = 0.9
PREV_TAIL_CHARS = 1400  # 直前散文の受け渡し量(~800 tokens 目安)
MEMORY_LIMIT = 8
SUMMARY_SLOTS = 4  # うち「章のまとめ(要約記憶)」に確保する枠
DEFAULT_MAX_TOKENS = 4096
# 字数指定時の生成上限。日本語は Gemma のトークナイザで 1 字 ≈ 1.0〜1.5 tokens
# なので、指示より長めに書かれても途中で切れないよう 2.5 倍を取る
TOKENS_PER_CHAR = 2.5
MAX_TOKENS_CAP = 12288


def length_instruction(target_chars: int | None) -> str | None:
    """分量の指示文。目安の前後 ±25% を幅として示す(数値ぴったりは狙わせない)。"""
    if not target_chars or target_chars <= 0:
        return None
    low = max(int(target_chars * 0.75) // 50 * 50, 50)
    high = int(target_chars * 1.25) // 50 * 50
    return f"分量: 日本語で {low}〜{high} 字程度(目安。話の切れ目を優先し、無理に埋めたり削ったりしない)"


def _max_tokens(target_chars: int | None) -> int:
    if not target_chars or target_chars <= 0:
        return DEFAULT_MAX_TOKENS
    return min(max(int(target_chars * TOKENS_PER_CHAR), 1024), MAX_TOKENS_CAP)


def effective_target_chars(node: dict[str, Any], default_chars: int | None) -> int | None:
    """このシーンに効く目安の字数。ノードの個別指定が共通の設定に優先する。"""
    own = node.get("target_chars")
    if own and int(own) > 0:
        return int(own)
    return default_chars


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _memory_contents(store: Store, memory_ids: list[str], limit: int = MEMORY_LIMIT) -> list[str]:
    """清書に渡す記憶。**章のまとめ(要約記憶)は押し出さない**。

    従来は末尾 limit 件(時系列の新しい順)だけを渡していたため、当章の記憶が
    limit 件を超えると前章までのまとめが枠から落ちて、長い物語ほど過去が
    見えなくなっていた(2026-08-02 ユーザー指摘)。まとめは章 1 つを代表する
    骨格なので、新しい順に SUMMARY_SLOTS 件までは必ず入れ、残りの枠を生の
    記憶の新しい順で埋める。並びは時系列のまま(fold の順)。
    """
    if not memory_ids:
        return []
    summaries = store.summary_memory_ids()
    kept = [mid for mid in memory_ids if mid in summaries][-SUMMARY_SLOTS:]
    raw = [mid for mid in memory_ids if mid not in summaries]
    room = max(limit - len(kept), 0)
    chosen = set(kept) | set(raw[-room:] if room else [])
    contents = []
    for mid in memory_ids:  # 時系列の並びを保って取り出す
        if mid not in chosen:
            continue
        row = store.conn.execute("SELECT content FROM memories WHERE id = ?", (mid,)).fetchone()
        if row:
            contents.append(row["content"])
    return contents


def _state_summary(store: Store, node_id: str, cast: list[str], pov_char: str | None) -> str:
    """レンダー用の状態要約。pov 指定時は pov キャラが知る情報のみ。

    world facts は「誰もが知っている公のこと」という規約(2026-07-29。秘密は
    知っているキャラの char fact に置く)なので、POV でも出してよい。
    """
    state = store.get_state(node_id)
    lines: list[str] = []
    if state["world"]["time"] is not None:
        lines.append(f"時間: {state['world']['time']}")
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


def _place_block(store: Store, node_id: str) -> list[str]:
    """実効ロケーションの固定設定(docs/design/places.md §6)。

    POV ではフィルタしない: その場にいる以上、場所の様子は見えている。
    """
    place = store.location_context(node_id)
    if place is None:
        return []
    lines = [f"- {place['name']}"]
    if place.get("description"):
        lines.append(f"  {place['description']}")
    if place.get("atmosphere"):
        lines.append(f"  雰囲気: {place['atmosphere']}")
    return ["## 場所", "\n".join(lines), ""]


def build_render_messages(
    store: Store,
    node: dict[str, Any],
    preset: dict[str, Any],
    pov_char: str | None,
    prev_tail: str | None,
    target_chars: int | None = None,
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
    length_text = length_instruction(target_chars)
    system = "\n".join(
        [
            base_prompt,
            "",
            f"人称: {person_text}",
            *([length_text] if length_text else []),
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
    place_name = store.place_name(store.effective_location(node["id"])[0])
    user_parts = [
        "## 登場人物",
        _cast_profiles(store, node["cast"]),
        "",
        *_place_block(store, node["id"]),
        "## 状態(このシーン適用後)",
        _state_summary(store, node["id"], node["cast"], pov_char),
        "",
        "## このシーンのビート",
        f"タイトル: {node['title'] or '(無題)'}",
        f"場所: {place_name or '不明'}" + (f" / 時間: {node['story_time']}" if node["story_time"] else ""),
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


def _render_stats(raw: dict[str, Any]) -> dict[str, Any] | None:
    """llm.chat_stream の stats_out をチャットの meta と同じ形に整える。
    統計が取れなかったとき(サーバーが timings / usage を返さない等)は None。"""
    if not raw.get("tokens"):
        return None
    elapsed = raw.get("elapsed_sec")
    per_sec = raw.get("tokens_per_sec")
    return {
        "tokens": raw["tokens"],
        "elapsed_sec": round(elapsed, 2) if elapsed else None,
        "tokens_per_sec": round(per_sec, 1) if per_sec else None,
        "finish_reason": raw.get("finish_reason"),
    }


async def render_stream(
    store: Store,
    base_url: str,
    node_ids: list[str],
    preset_id: str,
    pov_char: str | None,
    target_chars: int | None = None,
) -> AsyncIterator[str]:
    """node_ids を順にレンダーする SSE ストリーム。

    target_chars は共通の設定(既定値)。シーンに個別指定があればそちらが優先する。
    """
    try:
        preset = store.get_preset(preset_id)
        if preset is None:
            yield _sse({"error": f"プリセットが見つかりません: {preset_id}"})
            return
        canon = store.canon_path()
        # 何シーン書くのかを最初に伝える(UI の進捗表示 N/M 用)
        yield _sse({"stage": "start", "total": len(node_ids)})
        for node_id in node_ids:
            node = store.get_node(node_id)
            if node is None:
                yield _sse({"error": f"ノードが見つかりません: {node_id}"})
                return
            if node.get("kind"):
                continue  # はじまり / 結末マーカーは清書しない
            # 直前シーンの散文末尾(スライディングウィンドウ)
            prev_tail = None
            if node_id in canon:
                idx = canon.index(node_id)
                if idx > 0:
                    prev = store.latest_render(canon[idx - 1], preset_id, pov_char)
                    if prev:
                        prev_tail = prev["prose"][-PREV_TAIL_CHARS:]
            yield _sse({"scene_start": node_id, "title": node["title"]})
            chars = effective_target_chars(node, target_chars)
            messages = build_render_messages(store, node, preset, pov_char, prev_tail, chars)
            prose_parts: list[str] = []
            raw_stats: dict[str, Any] = {}
            async for delta in llm.chat_stream(
                messages,
                base_url=base_url,
                temperature=RENDER_TEMPERATURE,
                max_tokens=_max_tokens(chars),
                label=f"清書: {node['title'] or '(無題)'}",
                stats_out=raw_stats,
            ):
                prose_parts.append(delta)
                yield _sse({"delta": delta})
            prose = "".join(prose_parts).strip()
            # 統計はチャットの meta と同じ形に整えて保存する(UI の StatsLine を共用)。
            # 送った messages も控えとして丸ごと保存し、清書タブから確認できるようにする
            meta = _render_stats(raw_stats)
            render = store.save_render(node_id, preset_id, pov_char, prose, meta=meta, prompt_messages=messages)
            yield _sse({"scene_done": node_id, "render": render})
        yield _sse({"done": True})
    except Exception as e:  # noqa: BLE001
        yield _sse({"error": f"{type(e).__name__}: {e}"})

