"""ルールベース検証(spec §6.3-1)。

ノード適用前の state と、ノードの cast / events を照合する。
LLM 検証(感情の一貫性)は Phase 6。
location の瞬間移動チェックは場所の隣接情報が未定義のため未実装(TODO)。
"""

from __future__ import annotations

from typing import Any

from fold import EVENT_TYPES


def validate_node(
    state_before: dict[str, Any],
    cast: list[str],
    events: list[dict[str, Any]],
    known_char_ids: set[str],
) -> list[str]:
    """違反メッセージのリストを返す。空なら OK。"""
    errors: list[str] = []

    introduced_here = {
        e["payload"]["char"] for e in events if e["type"] == "char_introduce"
    }

    for char_id in cast:
        if char_id not in known_char_ids:
            errors.append(f"cast に未登録のキャラ ID があります: {char_id}")
            continue
        char_state = state_before["chars"].get(char_id)
        if char_state is not None and char_state["status"] == "retired":
            errors.append(
                f"退場済みキャラが cast に含まれています: {char_id}"
                f" (理由: {char_state.get('retire_reason')})"
            )
        if char_state is None and char_id not in introduced_here:
            errors.append(
                f"char_introduce 前のキャラが cast に含まれています: {char_id}"
            )

    for event in events:
        if event["type"] not in EVENT_TYPES:
            errors.append(f"未知のイベント型です: {event['type']}")
            continue
        for key in ("char", "target"):
            value = event["payload"].get(key)
            if key == "target" and event["payload"].get("target_type") == "faction":
                continue
            if isinstance(value, str) and value and value not in known_char_ids:
                errors.append(
                    f"イベント {event['type']} がスキーマ外の char_id を参照しています: {value}"
                )

    return errors
