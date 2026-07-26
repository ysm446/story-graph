"""fold エンジン — イベント畳み込みによる状態導出(spec §4, §5)。

純粋関数のみ。DB アクセスは持たない。
StateSnapshot は plain dict:

{
  "world": { "time": ..., "facts": {key: value} },
  "chars": {
    char_id: {
      "status": "introduced" | "retired",
      "retire_reason": str | None,
      "facts": {key: value},
      "relationships": {
        target_id: { "score": float, "target_type": "char"|"faction", "reasons": [event_id] }
      },
      "memories": [event_id]
    }
  }
}
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

EVENT_TYPES = frozenset(
    {
        "memory_add",
        "memory_compress",
        "relationship_update",
        "relationship_set",
        "fact_set",
        "char_introduce",
        "char_retire",
        "manual_override",
    }
)


def empty_state() -> dict[str, Any]:
    return {"world": {"time": None, "facts": {}}, "chars": {}}


def _clamp(value: float) -> float:
    return max(-1.0, min(1.0, value))


def _ensure_char(state: dict[str, Any], char_id: str) -> dict[str, Any]:
    char = state["chars"].get(char_id)
    if char is None:
        char = {
            "status": "introduced",
            "retire_reason": None,
            "facts": {},
            "relationships": {},
            "memories": [],
        }
        state["chars"][char_id] = char
    return char


def _ensure_relationship(char: dict[str, Any], target: str, target_type: str) -> dict[str, Any]:
    rel = char["relationships"].get(target)
    if rel is None:
        rel = {"score": 0.0, "target_type": target_type, "reasons": []}
        char["relationships"][target] = rel
    return rel


def apply_event(state: dict[str, Any], event: dict[str, Any]) -> None:
    """state を破壊的に更新する。event = {id, type, payload}。後勝ち。"""
    etype = event["type"]
    payload = event["payload"]
    event_id = event["id"]

    if etype == "memory_add":
        char = _ensure_char(state, payload["char"])
        char["memories"].append(event_id)
    elif etype == "memory_compress":
        char = _ensure_char(state, payload["char"])
        replaced = set(payload["replaces"])
        char["memories"] = [m for m in char["memories"] if m not in replaced]
        char["memories"].append(event_id)
    elif etype == "relationship_update":
        char = _ensure_char(state, payload["char"])
        rel = _ensure_relationship(char, payload["target"], payload.get("target_type", "char"))
        rel["score"] = _clamp(rel["score"] + float(payload["delta"]))
        rel["reasons"].append(event_id)
        if payload.get("label"):
            rel["label"] = payload["label"]  # 関係の一言(後勝ち)
    elif etype == "relationship_set":
        char = _ensure_char(state, payload["char"])
        rel = _ensure_relationship(char, payload["target"], payload.get("target_type", "char"))
        rel["score"] = _clamp(float(payload["value"]))
        rel["reasons"].append(event_id)
        if payload.get("label"):
            rel["label"] = payload["label"]
    elif etype == "fact_set":
        if payload["scope"] == "world":
            key = payload["key"]
            if key == "time":
                state["world"]["time"] = payload["value"]
            else:
                state["world"]["facts"][key] = payload["value"]
        else:
            char_id = payload.get("char")
            if not char_id:
                raise ValueError(f"fact_set(scope=char) に char がありません (event {event_id})")
            char = _ensure_char(state, char_id)
            char["facts"][payload["key"]] = payload["value"]
    elif etype == "char_introduce":
        char = _ensure_char(state, payload["char"])
        char["status"] = "introduced"
        char["retire_reason"] = None
    elif etype == "char_retire":
        char = _ensure_char(state, payload["char"])
        char["status"] = "retired"
        char["retire_reason"] = payload.get("reason")
    elif etype == "manual_override":
        _set_path(state, payload["path"], payload["value"])
    else:
        raise ValueError(f"unknown event type: {etype}")


def _set_path(state: dict[str, Any], path: str, value: Any) -> None:
    """'chars.aya.facts.location' のようなドット区切りパスへの代入。"""
    keys = path.split(".")
    target: Any = state
    for key in keys[:-1]:
        if key not in target or not isinstance(target[key], dict):
            target[key] = {}
        target = target[key]
    target[keys[-1]] = value


def fold(
    parent_state: dict[str, Any],
    events: list[dict[str, Any]],
    cast: list[str] | None = None,
) -> dict[str, Any]:
    """state(node) = apply(state(canon_parent), events(node))。純粋・決定的。

    events は seq 順にソート済みであること。

    登場(introduced)は cast から導出する: cast にいて state にまだ現れていない
    キャラは、そのシーンで初登場したものとして作る。cast はノードが持っている
    情報なので char_introduce イベントは不要(既存データのイベントは無害な
    冗長情報として残る)。既に退場済みのキャラは _ensure_char が作り直さない
    ため、cast に入れても蘇生しない(矛盾は validation が警告する)。
    """
    state = copy.deepcopy(parent_state)
    for char_id in cast or []:
        _ensure_char(state, char_id)
    for event in events:
        apply_event(state, event)
    return state


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def state_hash(state: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(state).encode("utf-8")).hexdigest()


def events_hash(events: list[dict[str, Any]]) -> str:
    stripped = [
        {"id": e["id"], "type": e["type"], "payload": e["payload"], "seq": e.get("seq", i)}
        for i, e in enumerate(events)
    ]
    return hashlib.sha256(canonical_json(stripped).encode("utf-8")).hexdigest()


def input_hash(parent_state_hash: str, node_events_hash: str, cast: list[str] | None = None) -> str:
    """state_cache の妥当性キー。登場を cast から導出するので cast も入力に含める。"""
    cast_part = canonical_json(sorted(cast or []))
    return hashlib.sha256(
        f"{parent_state_hash}:{node_events_hash}:{cast_part}".encode("utf-8")
    ).hexdigest()
