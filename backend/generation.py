"""生成パイプライン(spec §6)。

- ビート生成: コンテキスト構築 → JSON schema 制約で 1 パス構造化出力
  (ビート + イベント同時) → ルール検証 → NG なら指摘を添えて最大 2 回リトライ
  → それでも NG なら警告付きで採用(ユーザー判断で削除可能)
- イベント抽出: 手動記入されたビートからイベント列のみを抽出する単独パス

LLM が発行できるイベント型は 5 種に絞る(relationship_set / manual_override /
memory_compress は手動・Phase 6 の領分)。
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import llm
import retrieval
from store import Store
from validation import validate_node

GENERATION_TEMPERATURE = 0.8
EXTRACTION_TEMPERATURE = 0.2
MAX_RETRIES = 2
RECENT_BEATS = 3


# ---- JSON schema -----------------------------------------------------

def _event_schemas(char_ids: list[str]) -> list[dict[str, Any]]:
    char_ref = {"type": "string", "enum": char_ids}
    value_ref = {"type": ["string", "number", "boolean"]}

    def event(type_name: str, payload_props: dict[str, Any], required: list[str]) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "type": {"const": type_name},
                "payload": {
                    "type": "object",
                    "properties": payload_props,
                    "required": required,
                },
            },
            "required": ["type", "payload"],
        }

    return [
        event(
            "memory_add",
            {
                "char": char_ref,
                "content": {"type": "string"},
                "emotion": {"type": "number", "minimum": -1.0, "maximum": 1.0},
                "importance": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                "refs": {"type": "array", "items": char_ref},
            },
            ["char", "content", "emotion", "importance"],
        ),
        event(
            "relationship_update",
            {
                "char": char_ref,
                "target_type": {"const": "char"},
                "target": char_ref,
                "delta": {"type": "number", "minimum": -1.0, "maximum": 1.0},
                "reason": {"type": "string"},
            },
            ["char", "target", "delta", "reason"],
        ),
        # fact_set は scope ごとに分割する(scope=char のとき char を必須にするため。
        # JSON schema の条件付き required は llama.cpp のグラマー変換が扱えない)
        event(
            "fact_set",
            {
                "scope": {"const": "char"},
                "char": char_ref,
                "key": {"type": "string"},
                "value": value_ref,
            },
            ["scope", "char", "key", "value"],
        ),
        event(
            "fact_set",
            {
                "scope": {"const": "world"},
                "key": {"type": "string"},
                "value": value_ref,
            },
            ["scope", "key", "value"],
        ),
        event("char_introduce", {"char": char_ref}, ["char"]),
        event(
            "char_retire",
            {"char": char_ref, "reason": {"type": "string"}},
            ["char"],
        ),
    ]


def beat_schema(char_ids: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "beat": {"type": "string"},
            "emotional_core": {"type": "string"},
            "cast": {"type": "array", "items": {"type": "string", "enum": char_ids}},
            "location": {"type": "string"},
            "story_time": {"type": "string"},
            "events": {"type": "array", "items": {"anyOf": _event_schemas(char_ids)}},
        },
        "required": ["title", "beat", "emotional_core", "cast", "location", "events"],
    }


def events_schema(char_ids: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "events": {"type": "array", "items": {"anyOf": _event_schemas(char_ids)}},
        },
        "required": ["events"],
    }


# ---- コンテキスト構築(spec §6.1。記憶 retrieval は Phase 2) ----------

def _format_characters(store: Store) -> str:
    lines = []
    for c in store.list_characters():
        parts = [f"- {c['id']}: {c['name']}"]
        if c.get("profile"):
            parts.append(f"  性格: {c['profile']}")
        if c.get("voice"):
            parts.append(f"  口調: {c['voice']}")
        lines.append("\n".join(parts))
    return "\n".join(lines)


def _format_state(store: Store, node_id: str | None) -> str:
    if node_id is None:
        return "(物語はまだ始まっていない)"
    state = store.get_state(node_id)
    lines = []
    if state["world"]["time"] is not None:
        lines.append(f"時間: {state['world']['time']}")
    for key, value in state["world"]["facts"].items():
        lines.append(f"世界: {key} = {value}")
    for char_id, cs in state["chars"].items():
        if cs["status"] == "retired":
            lines.append(f"{char_id}: 退場済み({cs['retire_reason']})")
            continue
        facts = ", ".join(f"{k}={v}" for k, v in cs["facts"].items())
        if facts:
            lines.append(f"{char_id}: {facts}")
        for target, rel in cs["relationships"].items():
            lines.append(f"{char_id} → {target}: {rel['score']:+.2f}")
    return "\n".join(lines) or "(まだ状態がない)"


def _format_recent_beats(store: Store, path: list[str]) -> str:
    recent = path[-RECENT_BEATS:]
    lines = []
    for nid in recent:
        node = store.get_node(nid)
        if node is None:
            continue
        cast = ", ".join(node["cast"])
        lines.append(f"[{node['title'] or '無題'}] ({cast} @ {node['location'] or '?'})\n{node['beat']}")
    return "\n\n".join(lines) or "(まだビートがない)"


def _format_retrieved_memories(store: Store, path: list[str], instruction: str | None) -> str:
    """直近ビートの cast 各キャラについて、fold 済み state の記憶参照から
    ハイブリッド検索で上位 5 件を想起する(spec §6.1-2)。"""
    if not path:
        return ""
    tail = store.get_node(path[-1])
    if tail is None or not tail["cast"]:
        return ""
    state = store.get_state(path[-1])
    query = " ".join(filter(None, [tail["beat"], instruction])).strip()
    if not query:
        return ""
    current_order = len(path) - 1
    lines: list[str] = []
    for char_id in tail["cast"]:
        char_state = state["chars"].get(char_id)
        if not char_state or not char_state["memories"]:
            continue
        hits = retrieval.search_memories(
            store.conn, query, set(char_state["memories"]), current_order, top_k=5
        )
        for hit in hits:
            lines.append(f"- {char_id}: {hit['content']}")
    return "\n".join(lines)


# シーン生成のシステムプロンプトは「編集可能な本文 + 自動追加ルール」の 2 層
# (docs/design/system-prompts.md)。本文は settings の generation_system_prompt。
DEFAULT_GENERATION_PROMPT = """あなたは物語のビート(出来事の仕様書)を設計する構成作家です。
ビートは散文ではなく、そのシーンで起きる出来事を数文で記述した仕様書です。
起伏と因果を意識し、キャラクターの感情が動く出来事を設計してください。"""

GENERATION_RULES = """出力は必ず指定の JSON 形式に従ってください。

ルール:
- beat は出来事の記述に徹する(描写・台詞の肉付けはしない)
- events はビートで起きた出来事による状態変化を漏れなく列挙する
  - キャラの初登場シーンでは char_introduce を必ず発行する
  - 心に残る出来事は memory_add(そのキャラ視点の一人称的内容で)
  - 関係が動いたら relationship_update(delta は -1.0〜1.0 の小さな変化。reason 必須)
  - 場所の移動や状況変化は fact_set(key 例: location, goal, items)
- cast はそのシーンに登場するキャラ ID のみ
- 退場済みキャラは登場させない"""


def generation_system_prompt(store: Store) -> str:
    base = (store.get_settings().get("generation_system_prompt") or "").strip()
    return f"{base or DEFAULT_GENERATION_PROMPT}\n\n{GENERATION_RULES}"


def _build_messages(store: Store, instruction: str | None, path: list[str],
                    branching: bool = False) -> list[dict[str, str]]:
    tail = path[-1] if path else None
    default_instruction = (
        "直前のビートの時点から分岐する、もう一つの展開(what-if)を 1 つ設計してください。"
        if branching
        else "物語の流れに沿って、次のビートを 1 つ設計してください。"
    )
    memories_text = _format_retrieved_memories(store, path, instruction)
    user_parts = [
        "## キャラクター一覧",
        _format_characters(store),
        "",
        "## 現在の状態(直近ビート適用後)",
        _format_state(store, tail),
        "",
        *(["## 各キャラが想起している記憶", memories_text, ""] if memories_text else []),
        "## 直近のビート",
        _format_recent_beats(store, path),
        "",
        "## 指示",
        instruction or default_instruction,
    ]
    return [
        {"role": "system", "content": generation_system_prompt(store)},
        {"role": "user", "content": "\n".join(user_parts)},
    ]


# ---- ビート生成 ------------------------------------------------------

def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _clamp(value: Any, low: float, high: float) -> Any:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(low, min(high, float(value)))
    return value


def normalize_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """llama.cpp のグラマー変換は数値の minimum/maximum を無視するため、
    範囲付き数値フィールドをここで clamp する。"""
    for event in events:
        payload = event.get("payload", {})
        if event.get("type") == "memory_add":
            payload["emotion"] = _clamp(payload.get("emotion"), -1.0, 1.0)
            payload["importance"] = _clamp(payload.get("importance"), 0.0, 1.0)
        elif event.get("type") == "relationship_update":
            payload["delta"] = _clamp(payload.get("delta"), -1.0, 1.0)
    return events


async def generate_beat_stream(
    store: Store,
    base_url: str,
    instruction: str | None,
    parent_id: str | None = None,
) -> AsyncIterator[str]:
    """SSE イベント列を返す。最後に done(node + validation) または error。

    parent_id 指定時はそのノードからのブランチ生成(コンテキストは分岐元パス)。

    生成器の途中で例外が漏れると StreamingResponse が接続を切ってしまうため、
    必ず error イベントに変換する。
    """
    try:
        async for chunk in _generate_beat_impl(store, base_url, instruction, parent_id):
            yield chunk
    except Exception as e:  # noqa: BLE001
        yield _sse({"error": f"{type(e).__name__}: {e}"})


async def _generate_beat_impl(
    store: Store,
    base_url: str,
    instruction: str | None,
    parent_id: str | None = None,
) -> AsyncIterator[str]:
    char_ids = sorted(store.known_char_ids())
    if not char_ids:
        yield _sse({"error": "キャラクターが未登録です。先にキャラクター庫で登録してください。"})
        return
    if parent_id is not None and store.get_node(parent_id) is None:
        yield _sse({"error": f"分岐元ノードが見つかりません: {parent_id}"})
        return

    path = store.path_to(parent_id) if parent_id else store.canon_path()
    schema = beat_schema(char_ids)
    messages = _build_messages(store, instruction, path, branching=parent_id is not None)
    state_before = store.get_state(path[-1]) if path else None

    result: dict[str, Any] | None = None
    errors: list[str] = []
    for attempt in range(MAX_RETRIES + 1):
        yield _sse({"stage": "generating", "attempt": attempt + 1})
        try:
            result = await llm.chat_json(
                messages,
                base_url=base_url,
                schema=schema,
                temperature=GENERATION_TEMPERATURE if attempt == 0 else 0.4,
                max_tokens=3072,
                label=f"シーン生成({attempt + 1}回目)" if attempt else "シーン生成",
            )
        except RuntimeError as e:
            # JSON 打ち切り・パース失敗もリトライ対象(温度を下げて引き直す)
            if attempt < MAX_RETRIES:
                yield _sse({"stage": "retry", "errors": [str(e)]})
                continue
            yield _sse({"error": str(e)})
            return
        yield _sse({"stage": "validating"})
        normalize_events(result.get("events", []))
        candidate_events = [
            {"type": e["type"], "payload": e["payload"]} for e in result.get("events", [])
        ]
        errors = validate_node(
            state_before if state_before is not None else {"chars": {}, "world": {"time": None, "facts": {}}},
            result.get("cast", []),
            candidate_events,
            set(char_ids),
        )
        if not errors:
            break
        if attempt < MAX_RETRIES:
            yield _sse({"stage": "retry", "errors": errors})
            messages = messages + [
                {"role": "assistant", "content": json.dumps(result, ensure_ascii=False)},
                {
                    "role": "user",
                    "content": "検証エラーがあります。修正して出し直してください:\n- "
                    + "\n- ".join(errors),
                },
            ]

    assert result is not None
    node = store.append_node(
        {
            "title": result.get("title"),
            "beat": result["beat"],
            "emotional_core": result.get("emotional_core"),
            "cast": result.get("cast", []),
            "location": result.get("location"),
            "story_time": result.get("story_time"),
        },
        [{"type": e["type"], "payload": e["payload"], "source": "llm"} for e in result.get("events", [])],
        source="llm",
        parent_id=parent_id,
    )
    yield _sse({"done": True, "node": node, "validation": errors})


# ---- イベント抽出(手動ビート用) -------------------------------------

EXTRACTION_PROMPT = """あなたは物語のビート(出来事の仕様書)から状態変化イベントを抽出する解析器です。
ビートに書かれている出来事だけを対象に、状態変化を JSON で列挙してください。
書かれていない出来事を推測で追加してはいけません。"""


async def extract_events(store: Store, base_url: str, node_id: str) -> list[dict[str, Any]]:
    node = store.get_node(node_id)
    if node is None:
        raise KeyError(f"node not found: {node_id}")
    char_ids = sorted(store.known_char_ids())
    state_text = _format_state(store, store.parent_of(node_id))

    messages = [
        {"role": "system", "content": EXTRACTION_PROMPT},
        {
            "role": "user",
            "content": "\n".join(
                [
                    "## キャラクター一覧",
                    _format_characters(store),
                    "",
                    "## このビート適用前の状態",
                    state_text,
                    "",
                    "## 対象ビート",
                    f"cast: {', '.join(node['cast'])}",
                    f"location: {node['location'] or '?'}",
                    node["beat"],
                ]
            ),
        },
    ]
    # グラマー制約下で稀に空白のみを生成し続けるケース(Gemma + llama.cpp の
    # 既知事象)があるため、温度を変えて引き直す
    last_error: RuntimeError | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            result = await llm.chat_json(
                messages,
                base_url=base_url,
                schema=events_schema(char_ids),
                temperature=EXTRACTION_TEMPERATURE if attempt == 0 else 0.5,
                max_tokens=2048,
                label="イベント抽出",
            )
            break
        except RuntimeError as e:
            last_error = e
    else:
        raise last_error  # type: ignore[misc]
    normalize_events(result["events"])
    return store.replace_events(
        node_id,
        [{"type": e["type"], "payload": e["payload"], "source": "llm"} for e in result["events"]],
    )
