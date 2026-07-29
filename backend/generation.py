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
                "label": {"type": "string", "description": "関係を一言で(例: 幼なじみ、ライバル視、想いを寄せる)"},
            },
            ["char", "target", "delta", "reason", "label"],
        ),
        # fact_set は scope=char のみ LLM に出させる(char を必須にできる形。
        # JSON schema の条件付き required は llama.cpp のグラマー変換が扱えない)。
        # scope=world は「誰もが知っている公のこと」専用で、作者が手動イベントで
        # 置く(2026-07-29)。LLM に開放すると秘密(真犯人 等)を world に落とし、
        # キャラチャットや POV 清書で「知らないはずのことを知っている」が起きる
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
        # char_introduce / char_retire は LLM に出させない(2026-07-26):
        # 登場は cast から導出でき、退場は「死亡か、その場を去っただけか」の
        # 意味判断なので作者が UI で決める。スキーマの枝が減るぶん、文法制約付き
        # 生成も安定する。手動イベントとしては引き続き有効。
    ]


def beat_schema(char_ids: list[str], place_ids: list[str] | None = None) -> dict[str, Any]:
    """place_ids を渡すと location は登録済み場所の enum になる(表記ゆれ防止)。

    場所が 1 つも登録されていないときは location をスキーマから外す。
    自由テキストを許すと ID 参照との混在データが生まれるため(docs/design/places.md §6)。
    """
    properties: dict[str, Any] = {
        "title": {"type": "string"},
        "beat": {"type": "string"},
        "emotional_core": {"type": "string"},
        "cast": {"type": "array", "items": {"type": "string", "enum": char_ids}},
    }
    required = ["title", "beat", "emotional_core", "cast"]
    if place_ids:
        properties["location"] = {"type": "string", "enum": place_ids}
        required.append("location")
    properties["story_time"] = {"type": "string"}
    properties["events"] = {"type": "array", "items": {"anyOf": _event_schemas(char_ids)}}
    required.append("events")
    return {"type": "object", "properties": properties, "required": required}


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
        place = store.place_name(store.effective_location(nid)[0])
        lines.append(f"[{node['title'] or '無題'}] ({cast} @ {place or '?'})\n{node['beat']}")
    return "\n\n".join(lines) or "(まだビートがない)"


def _format_places(store: Store) -> str:
    """登録済みの場所一覧(location の enum に対応する ID → 名前の対応表)。"""
    lines = []
    for p in store.list_places():
        parts = [f"- {p['id']}: {p['name']}"]
        if p.get("description"):
            parts.append(f"  {p['description']}")
        lines.append("\n".join(parts))
    return "\n".join(lines)


def _format_current_place(store: Store, path: list[str]) -> str:
    """直近シーンの実効ロケーション(場所が変わらない限り、次もここが舞台)。"""
    if not path:
        return ""
    place = store.location_context(path[-1])
    if place is None:
        return ""
    parts = [place["name"]]
    if place.get("atmosphere"):
        parts.append(f"({place['atmosphere']})")
    return " ".join(parts)


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

EVENT_RULES = """イベント発行のルール:
- 心に残る出来事は memory_add(そのキャラ視点の一人称的内容で)
  - 行動した本人だけでなく、その場に居合わせて心が動いたキャラにも出す。
    見た・聞いた・気づいた、も記憶になる(「〜するのを見た」「〜と聞かされた」のように書く)
  - 人から聞いた話は、見たことと区別できる書き方にする(誰から聞いたかを含める)
  - importance の目安: 人生を変える出来事 0.8〜1.0 / 当事者の重要な体験 0.5〜0.7 /
    目撃・伝聞 0.3〜0.5 / 些細なこと 0.1〜0.2
- 関係が動いたら relationship_update(delta は -0.3〜+0.3 程度の小さな変化。±1.0 は人生を変える出来事のみ。reason 必須)
  - label にはその時点の関係を一言で(例: 幼なじみ、ライバル視、想いを寄せる、犯人と疑う)。相関図の矢印に表示される
- 事実の変化は fact_set(scope="char" + char にキャラ ID。goal, items, 怪我 等)。
  そのキャラだけが知る秘密も、知っているキャラの事実として書く(例: 知っていること=真犯人は執事)
  - 誰がどこにいるかはシーンの location と cast で決まる。fact_set で場所を書かないこと"""

GENERATION_RULES = f"""出力は必ず指定の JSON 形式に従ってください。

ルール:
- beat は出来事の記述に徹する(描写・台詞の肉付けはしない)
- events はビートで起きた出来事による状態変化を漏れなく列挙する
- cast はそのシーンに登場するキャラ ID のみ
- 退場済みキャラは登場させない
- location は「場所一覧」にある ID から選ぶ(場所が変わらないなら直前と同じ ID)

{EVENT_RULES}"""


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
    places_text = _format_places(store)
    current_place = _format_current_place(store, path)
    user_parts = [
        "## キャラクター一覧",
        _format_characters(store),
        "",
        *(["## 場所一覧(location にはこの ID を使う)", places_text, ""] if places_text else []),
        *(["## 現在の場所", current_place, ""] if current_place else []),
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
    schema = beat_schema(char_ids, sorted(store.known_place_ids()))
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


# ---- シーンメタ情報の提案(タイトル / 感情の核) ----------------------

# シーン生成で実績のある「意味を持つプロパティ名のスキーマ」に合わせる
# ({"value": string} のような極小スキーマは空白ループに嵌まりやすかった)
SUGGEST_SYSTEM_PROMPT = """あなたは物語のビート(出来事の仕様書)を整える構成作家です。
与えられたビート本文にふさわしい title と emotional_core を生成してください。
出力は必ず指定の JSON 形式に従ってください。

- title: シーンの短いタイトル。6〜14文字程度。体言止めか短い句で、内容を説明しすぎず余韻を残す
- emotional_core: シーンの感情的な核。40字前後(長くなるときは2文まで)。出来事の説明ではなく、
  シーンを貫く感情の質を突く言葉で(例: 「怒りより深い、静かな失望」)"""

# maxLength は暴走ループ対策として入れていたが、原因は思考モード(reasoning)
# だったことが分かったので(全呼び出しで無効化済み)、余裕のある上限に戻した。
# 上限自体は保険として残す。
_SUGGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "minLength": 1, "maxLength": 40},
        "emotional_core": {"type": "string", "minLength": 1, "maxLength": 160},
    },
    "required": ["title", "emotional_core"],
}

_SUGGEST_LABELS = {"title": "タイトル生成", "emotional_core": "感情の核生成"}


def _cleanup_suggestion(text: str) -> str:
    """出力から1行の提案を取り出す(引用符・記号・前置きの除去)。"""
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    line = line.strip('「」"\'`* 　')
    for sep in (":", ":"):
        if sep in line and len(line.split(sep, 1)[0]) <= 12:
            line = line.split(sep, 1)[1].strip().strip('「」"\'` 　')
    return line[:60]


async def suggest_field(base_url: str, beat: str, field: str) -> str:
    if field not in _SUGGEST_LABELS:
        raise ValueError(f"unknown field: {field}")
    messages = [
        {"role": "system", "content": SUGGEST_SYSTEM_PROMPT},
        {"role": "user", "content": beat},
    ]
    last_error: RuntimeError | None = None
    for temperature in (0.7, 0.4):
        try:
            result = await llm.chat_json(
                messages,
                base_url=base_url,
                schema=_SUGGEST_SCHEMA,
                temperature=temperature,
                max_tokens=512,
                label=_SUGGEST_LABELS[field],
            )
            value = _cleanup_suggestion(str(result.get(field, "")))
            if value:
                return value
        except RuntimeError as e:
            last_error = e
    # 最終フォールバック: グラマーなしの自由テキスト(原理的にループしない)
    try:
        result = await llm.chat(
            messages,
            base_url=base_url,
            temperature=0.7,
            max_tokens=128,
            label=f"{_SUGGEST_LABELS[field]}(fallback)",
        )
        value = _cleanup_suggestion(result["content"])
        if value:
            return value
    except RuntimeError as e:
        last_error = e
    raise last_error or RuntimeError("提案を生成できませんでした(空の応答)")


# ---- 校正(シーン本文。lm-graph の 3 段階プリセットを踏襲) -----------

PROOFREAD_PRESETS = [
    {
        "id": "light",
        "name": "軽く(誤字脱字のみ)",
        "prompt": "あなたは日本語の校正者です。元の意味と文体をできるだけ保ちながら、誤字脱字、表記ゆれ、"
                  "不自然な言い回しだけを最小限に修正してください。説明は付けず、修正後の文章だけを返してください。",
    },
    {
        "id": "standard",
        "name": "標準(自然に整える)",
        "prompt": "あなたは優秀な日本語エディタです。文章の意味と筆者の意図を保ったまま、より自然で読みやすい"
                  "日本語に整えてください。必要に応じて語順や表現を調整し、不自然な言い回し、冗長さ、重複を"
                  "改善してください。説明は付けず、修正後の文章だけを返してください。Markdown は使わないでください。",
    },
    {
        "id": "aggressive",
        "name": "積極的(書き直し)",
        "prompt": "あなたはプロの編集者です。元の意図を保ちながら、文章をより明快で洗練された日本語に書き直して"
                  "ください。冗長な表現は簡潔にし、曖昧な箇所は自然な範囲で補い、全体の流れが良くなるように整えて"
                  "ください。説明は不要です。完成した文章だけを返してください。Markdown は使わないでください。",
    },
]


def proofread_presets(store: Store) -> list[dict[str, str]]:
    presets = [dict(p) for p in PROOFREAD_PRESETS]
    custom = (store.get_settings().get("proofread_custom_prompt") or "").strip()
    if custom:
        presets.append({"id": "custom", "name": "カスタム", "prompt": custom})
    return presets


def _proofread_messages(
    store: Store, text: str, preset_id: str, context_before: str, context_after: str
) -> tuple[list[dict[str, str]], str]:
    """校正のメッセージとログ用ラベルを組み立てる。

    context_before/after があれば「選択範囲のみの校正」モード:
    前後の文脈を参考として渡し、校正対象部分だけを返させる。"""
    preset = next((p for p in proofread_presets(store) if p["id"] == preset_id), None)
    if preset is None:
        raise ValueError(f"unknown proofread preset: {preset_id}")
    if context_before or context_after:
        user_content = "\n".join(
            [
                "次の【校正対象】の部分だけを校正してください。前後の文脈は参考情報です"
                "(文脈と自然につながるようにしてください)。",
                "修正後の【校正対象】部分の文章だけを返してください。",
                "",
                "## 前の文脈",
                context_before or "(なし)",
                "",
                "## 校正対象",
                text,
                "",
                "## 後の文脈",
                context_after or "(なし)",
            ]
        )
        label = f"校正・選択範囲({preset['name']})"
    else:
        user_content = text
        label = f"校正({preset['name']})"
    messages = [
        {"role": "system", "content": preset["prompt"]},
        {"role": "user", "content": user_content},
    ]
    return messages, label


async def proofread(
    store: Store,
    base_url: str,
    text: str,
    preset_id: str,
    context_before: str = "",
    context_after: str = "",
) -> str:
    messages, label = _proofread_messages(store, text, preset_id, context_before, context_after)
    result = await llm.chat(
        messages, base_url=base_url, temperature=0.3, max_tokens=2048, label=label
    )
    return result["content"].strip()


async def proofread_stream(
    store: Store,
    base_url: str,
    text: str,
    preset_id: str,
    context_before: str = "",
    context_after: str = "",
) -> AsyncIterator[str]:
    """校正の SSE ストリーム({delta} … {done, value})。"""
    try:
        messages, label = _proofread_messages(store, text, preset_id, context_before, context_after)
        parts: list[str] = []
        async for delta in llm.chat_stream(
            messages, base_url=base_url, temperature=0.3, max_tokens=2048, label=label
        ):
            parts.append(delta)
            yield _sse({"delta": delta})
        yield _sse({"done": True, "value": "".join(parts).strip()})
    except Exception as e:  # noqa: BLE001
        yield _sse({"error": f"{type(e).__name__}: {e}"})


# ---- イベント抽出(手動ビート用) -------------------------------------

EXTRACTION_PROMPT = f"""あなたは物語のビート(出来事の仕様書)から状態変化イベントを抽出する解析器です。
ビートに書かれている出来事だけを対象に、状態変化を JSON で列挙してください。
書かれていない出来事を推測で追加してはいけません。

{EVENT_RULES}"""


async def extract_events(
    store: Store, base_url: str, node_id: str, keep_user_events: bool = True
) -> list[dict[str, Any]]:
    """ビート本文と直前の状態からイベントを抽出し直す。

    keep_user_events=True のとき、手で足したイベント(source="user")は残す。
    再抽出は破壊的なので、既定で手動編集を守る。
    """
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
                    f"location: {store.place_name(store.effective_location(node_id)[0]) or '?'}",
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
    # char_introduce / char_retire はスキーマから外してあるが、古いモデル出力や
    # 想定外の出力が混ざっても取り込まない(登場は cast から導出、退場は作者の判断)
    extracted = [e for e in result["events"] if e["type"] not in ("char_introduce", "char_retire")]
    # 手動イベントは残す。ただし char_introduce は冗長なので拾わない。抽出結果と
    # 完全に同じ内容のものも二重にならないよう落とす
    extracted_keys = {(e["type"], json.dumps(e["payload"], sort_keys=True)) for e in extracted}
    kept = (
        [
            {"type": e["type"], "payload": e["payload"], "source": "user"}
            for e in node["events"]
            if e["source"] == "user"
            and e["type"] != "char_introduce"
            and (e["type"], json.dumps(e["payload"], sort_keys=True)) not in extracted_keys
        ]
        if keep_user_events
        else []
    )
    store.replace_events(
        node_id,
        [{"type": e["type"], "payload": e["payload"], "source": "llm"} for e in extracted] + kept,
    )
    return store.list_events(node_id)


async def reextract_chain(
    store: Store, base_url: str, node_id: str, keep_user_events: bool = True
) -> AsyncIterator[str]:
    """node_id 以下の部分木を、親から順にイベント抽出し直す(SSE)。"""
    async for chunk in _reextract(store, base_url, store.subtree_order(node_id), keep_user_events):
        yield chunk


async def reextract_nodes(
    store: Store,
    base_url: str,
    node_ids: list[str],
    include_downstream: bool = False,
    keep_user_events: bool = True,
) -> AsyncIterator[str]:
    """選択した複数ノードのイベントを抽出し直す(SSE)。

    抽出は親の状態を前提にするので、ルートからの深さが浅い順に並べ替えて
    逐次実行する(選択がチェーンをまたいでいても親が先に処理される)。
    """
    targets: list[str] = []
    seen: set[str] = set()
    for nid in node_ids:
        for target in store.subtree_order(nid) if include_downstream else [nid]:
            if target not in seen:
                seen.add(target)
                targets.append(target)
    targets.sort(key=lambda nid: len(store.path_to(nid)))
    async for chunk in _reextract(store, base_url, targets, keep_user_events):
        yield chunk


async def _reextract(
    store: Store, base_url: str, order: list[str], keep_user_events: bool
) -> AsyncIterator[str]:
    """順序が確定したノード列を逐次抽出する。

    各ノードは親の新しい状態を前提に抽出するので、必ず逐次で実行する。
    途中で失敗したノードは飛ばして続行し、最後にまとめて報告する。
    """
    failed: list[dict[str, str]] = []
    yield _sse({"stage": "start", "total": len(order)})
    for index, nid in enumerate(order):
        node = store.get_node(nid)
        title = (node["title"] if node else None) or "(無題)"
        yield _sse({"stage": "node", "index": index + 1, "total": len(order), "title": title, "node_id": nid})
        try:
            await extract_events(store, base_url, nid, keep_user_events)
        except Exception as e:  # noqa: BLE001
            failed.append({"node_id": nid, "title": title, "error": f"{type(e).__name__}: {e}"})
    yield _sse({"stage": "done", "total": len(order), "failed": failed})
