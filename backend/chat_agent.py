"""相談チャット — 状態の読み取り専用エージェント(spec §8)。

news-picker の chat_agent.py の tool calling ループを踏襲。
- ツール: get_beats / get_state / search_memories(読み取りのみ)+ propose_beats(提案カード)
- スコープ: upto = アンカーノードまでの情報しか見えない(未来のネタバレ禁止)。
  all はユーザーが明示的に切り替えたときのみ
- 履歴は chats テーブルにアンカーノード付きで保存(LLM メッセージ形式のまま)
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import llm
import retrieval
from store import Store

MAX_TOOL_STEPS = 8
CHAT_TEMPERATURE = 0.7
MEMORY_TOP_K = 8


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def build_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "get_beats",
                "description": "シーン(ビート)の一覧を取得する。index は 1 始まり。省略すると全件(見えている範囲)。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_index": {"type": "integer", "description": "開始シーン番号(1始まり)"},
                        "to_index": {"type": "integer", "description": "終了シーン番号(含む)"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_state",
                "description": "fold 済みの物語状態(キャラの facts / 関係値 / 記憶参照、世界の facts)を取得する。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "char_id": {"type": "string", "description": "指定するとそのキャラの状態のみ"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_memories",
                "description": "キャラの記憶をハイブリッド検索する(意味検索 + キーワード)。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "検索クエリ"},
                        "char_id": {"type": "string", "description": "指定するとそのキャラの記憶のみ"},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "propose_beats",
                "description": "この先の展開の提案をシーン下書きとして提出する(最大3案)。展開の提案を求められたときに使う。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "proposals": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string"},
                                    "beat": {"type": "string", "description": "出来事の仕様書(数文)"},
                                    "emotional_core": {"type": "string"},
                                    "cast": {"type": "array", "items": {"type": "string"}, "description": "キャラ ID の配列"},
                                    "location": {"type": "string"},
                                },
                                "required": ["title", "beat"],
                            },
                        },
                    },
                    "required": ["proposals"],
                },
            },
        },
    ]


# ---- ツール実装(すべて読み取り専用) --------------------------------

def _visible_path(store: Store, anchor: str | None, scope: str) -> list[str]:
    if scope == "all" or anchor is None:
        return store.canon_path()
    return store.path_to(anchor)


def _tool_get_beats(store: Store, path: list[str], args: dict[str, Any]) -> dict[str, Any]:
    from_i = max(int(args.get("from_index") or 1), 1)
    to_i = min(int(args.get("to_index") or len(path)), len(path))
    beats = []
    for i in range(from_i - 1, to_i):
        node = store.get_node(path[i])
        if node is None:
            continue
        beats.append(
            {
                "index": i + 1,
                "title": node["title"],
                "beat": node["beat"],
                "cast": node["cast"],
                "location": node["location"],
                "story_time": node["story_time"],
            }
        )
    return {"total": len(path), "beats": beats}


def _tool_get_state(store: Store, path: list[str], args: dict[str, Any]) -> dict[str, Any]:
    if not path:
        return {"error": "シーンがまだありません"}
    state = store.get_state(path[-1])
    char_id = args.get("char_id")
    if char_id:
        char_state = state["chars"].get(char_id)
        if char_state is None:
            return {"error": f"キャラ {char_id} はまだ登場していません"}
        return {"char": char_id, "state": char_state}
    return state


def _tool_search_memories(store: Store, path: list[str], scope: str, args: dict[str, Any]) -> dict[str, Any]:
    query = args.get("query") or ""
    if not query:
        return {"error": "query が必要です"}
    char_id = args.get("char_id")
    if scope == "all":
        rows = store.conn.execute("SELECT id, char_id FROM memories").fetchall()
        candidates = {r["id"] for r in rows if not char_id or r["char_id"] == char_id}
        current_order = len(store.canon_path()) - 1
    else:
        if not path:
            return {"memories": []}
        state = store.get_state(path[-1])
        candidates = set()
        for cid, cs in state["chars"].items():
            if char_id and cid != char_id:
                continue
            candidates.update(cs["memories"])
        current_order = len(path) - 1
    hits = retrieval.search_memories(store.conn, query, candidates, current_order, top_k=MEMORY_TOP_K)
    return {
        "memories": [
            {"char_id": h["char_id"], "content": h["content"], "importance": h["importance"]}
            for h in hits
        ]
    }


def dispatch_tool(store: Store, name: str, args: dict[str, Any], path: list[str], scope: str) -> dict[str, Any]:
    try:
        if name == "get_beats":
            return _tool_get_beats(store, path, args)
        if name == "get_state":
            return _tool_get_state(store, path, args)
        if name == "search_memories":
            return _tool_search_memories(store, path, scope, args)
        return {"error": f"unknown tool: {name}"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


# ---- キャラクターと話す(キャラモード。docs/design/chat.md §6) --------
#
# アンカー時点の fold 済み state をキャラの人格材料にする。シーン一覧は
# 渡さない(居合わせていない場面を含むため)。知識は facts + 記憶のみ。

CHARACTER_MEMORY_LIMIT = 15  # システムプロンプトに直接入れる記憶数(importance 上位)


def build_character_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "recall",
                "description": "自分の記憶を思い出す(意味検索)。会話で聞かれたことが手元の記憶にないときに使う。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "思い出したい内容"},
                    },
                    "required": ["query"],
                },
            },
        },
    ]


def _describe_score(score: float) -> str:
    if score >= 0.6:
        return "深い信頼・愛情"
    if score >= 0.3:
        return "好意的"
    if score >= 0.1:
        return "やや好意的"
    if score > -0.1:
        return "中立"
    if score > -0.3:
        return "やや警戒"
    if score > -0.6:
        return "敵対的"
    return "強い憎しみ・恐れ"


def build_character_system(store: Store, path: list[str], char_id: str, mode: str) -> str:
    char = store.get_character(char_id)
    if char is None:
        raise ValueError(f"キャラが見つかりません: {char_id}")
    state = store.get_state(path[-1]) if path else {"world": {"time": None, "facts": {}}, "chars": {}}
    cs = state["chars"].get(char_id) or {"facts": {}, "relationships": {}, "memories": []}

    lines: list[str] = [f"あなたは「{char['name']}」という人物です。"]
    if char.get("profile"):
        lines.append(f"性格: {char['profile']}")
    if char.get("appearance"):
        lines.append(f"外見: {char['appearance']}")
    if char.get("voice"):
        lines.append(f"口調: {char['voice']}")

    facts = cs.get("facts") or {}
    if facts or state["world"]["facts"] or state["world"]["time"] is not None:
        lines += ["", "## 現在のあなたの状況"]
        if state["world"]["time"] is not None:
            lines.append(f"- 時間: {state['world']['time']}")
        for k, v in facts.items():
            lines.append(f"- {k}: {v}")
        for k, v in state["world"]["facts"].items():
            lines.append(f"- (世界){k}: {v}")

    rels = cs.get("relationships") or {}
    if rels:
        lines += ["", "## 他者への今の気持ち"]
        for target, rel in rels.items():
            t = store.get_character(target)
            t_name = t["name"] if t else target
            label = f"「{rel['label']}」" if rel.get("label") else ""
            lines.append(f"- {t_name}: {_describe_score(float(rel['score']))}{label}(強さ {rel['score']:+.2f})")

    memory_ids = list(cs.get("memories") or [])
    if memory_ids:
        placeholders = ",".join("?" for _ in memory_ids)
        rows = store.conn.execute(
            f"SELECT content, importance FROM memories WHERE id IN ({placeholders})"
            " ORDER BY COALESCE(importance, 0) DESC",
            memory_ids,
        ).fetchall()
        lines += ["", "## あなたの記憶(重要なもの)"]
        for r in rows[:CHARACTER_MEMORY_LIMIT]:
            lines.append(f"- {r['content']}")
        if len(rows) > CHARACTER_MEMORY_LIMIT:
            lines.append("(ほかにも記憶がある。思い出せないことは recall ツールで思い出せる)")

    frame = (
        [
            "あなたは今、この物語の外で作者からインタビューを受けています。",
            "作者の質問に、あなた自身の言葉で答えてください。これまでの出来事への気持ち、",
            "いまの考え、これからの望みなど、あなたが知っている範囲で率直に話してください。",
        ]
        if mode != "roleplay"
        else [
            "あなたは今、見知らぬ相手と言葉を交わしています。この会話は物語の本編には含まれません。",
            "相手が誰であっても、いまのあなたとして自然に応対してください。",
            "初対面の相手に話さないようなこと(秘密や本心)は、簡単には明かさないでください。",
        ]
    )
    lines += [
        "",
        "## この会話について",
        *frame,
        "",
        "## 厳守すること",
        "- 上に書かれた状況・気持ち・記憶にあることだけを知っています。それ以外を聞かれたら「知らない」「分からない」と答える",
        "- 記憶にない大きな出来事や事実を発明しない(言い回しや細部の脚色は構いません)",
        "- これから先に何が起きるかは知りません",
        "- 一人称で、あなたの口調で話す。物語・シーン・登場人物などのメタな言葉は使わない",
    ]
    return "\n".join(lines)


# ---- システムプロンプト ----------------------------------------------

def build_system(store: Store, path: list[str], scope: str) -> str:
    chars = "\n".join(f"- {c['id']}: {c['name']}" for c in store.list_characters())
    anchor_text = (
        f"あなたに見えているのはシーン {len(path)} までの情報だけです。"
        "それ以降の展開について聞かれたら、まだ見えていないことを伝えてください。"
        if scope == "upto"
        else "物語全体が見えています。"
    )
    return "\n".join(
        [
            "あなたは物語作りの相談相手です。作者と一緒に物語の状態を確認し、展開を考えます。",
            "",
            "ルール:",
            "- 推測で答えず、必要に応じて get_beats / get_state / search_memories で事実を確認してから答える",
            f"- {anchor_text}",
            "- 「この先の展開を提案して」のような依頼には propose_beats ツールで最大3案の下書きを提出し、"
            "本文では各案の狙いを1行ずつ簡潔に説明する",
            "- 回答は簡潔に。作者の判断材料になる観察(関係値の流れ、未回収の記憶など)を優先する",
            "",
            "## キャラクター ID 一覧",
            chars,
        ]
    )


# ---- エージェントループ ----------------------------------------------

async def chat_stream(
    store: Store,
    base_url: str,
    chat_id: str | None,
    anchor_node: str | None,
    scope: str,
    user_message: str,
    char_id: str | None = None,
    mode: str = "interview",
    replace_from: int | None = None,
) -> AsyncIterator[str]:
    try:
        async for chunk in _chat_impl(
            store, base_url, chat_id, anchor_node, scope, user_message, char_id, mode, replace_from
        ):
            yield chunk
    except Exception as e:  # noqa: BLE001
        yield _sse({"error": f"{type(e).__name__}: {e}"})


async def _chat_impl(
    store: Store,
    base_url: str,
    chat_id: str | None,
    anchor_node: str | None,
    scope: str,
    user_message: str,
    char_id: str | None,
    mode: str,
    replace_from: int | None = None,
) -> AsyncIterator[str]:
    if chat_id:
        chat = store.get_chat(chat_id)
        if chat is None:
            yield _sse({"error": f"チャットが見つかりません: {chat_id}"})
            return
        anchor_node = chat["anchor_node"]
        scope = chat["scope"]
        char_id = chat.get("char_id")
        mode = chat.get("mode") or "interview"
    else:
        # キャラチャットは常に upto(未来を知るキャラは成立しない)
        if char_id:
            scope = "upto"
        chat = store.create_chat(anchor_node, scope, char_id=char_id, mode=mode if char_id else None)
        chat_id = chat["id"]
    yield _sse({"chat_id": chat_id})

    path = _visible_path(store, anchor_node, scope)
    history: list[dict[str, Any]] = list(chat["messages"])
    # 編集・再生成: 指定位置以降を捨ててから、新しい発言を積み直す
    if replace_from is not None and 0 <= replace_from <= len(history):
        history = history[:replace_from]
    history.append({"role": "user", "content": user_message})
    if char_id:
        system = build_character_system(store, path, char_id, mode)
        tools = build_character_tools()
    else:
        system = build_system(store, path, scope)
        tools = build_tools()

    def messages() -> list[dict[str, Any]]:
        # meta(生成統計)は保存用の付加情報なので LLM には渡さない
        return [
            {"role": "system", "content": system},
            *({k: v for k, v in m.items() if k != "meta"} for m in history),
        ]

    # ツールステップをまたいだ合計。ツール呼び出しの分も含めて「この返事にかかった量」
    stats_total: dict[str, Any] = {"tokens": 0, "elapsed_sec": 0.0, "steps": 0, "finish_reason": None}

    def accumulate(result: dict[str, Any]) -> None:
        s = result.get("stats") or {}
        if s.get("tokens"):
            stats_total["tokens"] += s["tokens"]
        if s.get("elapsed_sec"):
            stats_total["elapsed_sec"] += s["elapsed_sec"]
        if s.get("finish_reason"):
            stats_total["finish_reason"] = s["finish_reason"]
        stats_total["steps"] += 1

    def final_stats() -> dict[str, Any] | None:
        if not stats_total["tokens"]:
            return None
        elapsed = stats_total["elapsed_sec"] or None
        return {
            "tokens": stats_total["tokens"],
            "elapsed_sec": round(elapsed, 2) if elapsed else None,
            "tokens_per_sec": round(stats_total["tokens"] / elapsed, 1) if elapsed else None,
            "finish_reason": stats_total["finish_reason"],
            "steps": stats_total["steps"],
        }

    final_answer: str | None = None
    for step in range(MAX_TOOL_STEPS):
        yield _sse({"stage": "thinking"})
        result: dict[str, Any] = {}
        async for kind, value in llm.chat_stream_tools(
            messages(),
            base_url=base_url,
            temperature=CHAT_TEMPERATURE,
            max_tokens=2048,
            tools=tools,
            label=f"相談チャット(step {step + 1})",
        ):
            if kind == "content":
                yield _sse({"delta": value})
            elif kind == "done":
                result = value
        accumulate(result)
        tool_calls = result.get("tool_calls")
        if not tool_calls:
            final_answer = result["content"]
            stats = final_stats()
            history.append(
                {"role": "assistant", "content": final_answer, **({"meta": stats} if stats else {})}
            )
            break
        history.append(result["message"])
        for tc in tool_calls:
            name = tc.get("function", {}).get("name", "")
            try:
                args = json.loads(tc.get("function", {}).get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            yield _sse({"tool_call": {"name": name, "args": args}})
            if char_id:
                # キャラモードのツールは recall(自分の記憶の検索)だけ
                if name == "recall":
                    payload: dict[str, Any] = _tool_search_memories(
                        store, path, scope, {"query": args.get("query") or "", "char_id": char_id}
                    )
                else:
                    payload = {"error": f"unknown tool: {name}"}
            elif name == "propose_beats":
                proposals = (args.get("proposals") or [])[:3]
                yield _sse({"proposals": proposals})
                payload = {"ok": True, "count": len(proposals)}
            else:
                payload = dispatch_tool(store, name, args, path, scope)
            history.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": json.dumps(payload, ensure_ascii=False),
                }
            )
            yield _sse({"tool_result": {"name": name, "is_error": "error" in payload}})
    else:
        # ツール上限到達 → 打ち切らず、手持ちの情報でまとめさせる(news-picker 方式)
        history.append(
            {
                "role": "user",
                "content": "(これ以上ツールは使えません。ここまでに得られた情報で回答をまとめてください)",
            }
        )
        yield _sse({"stage": "thinking"})
        result = {}
        async for kind, value in llm.chat_stream_tools(
            messages(),
            base_url=base_url,
            temperature=CHAT_TEMPERATURE,
            max_tokens=2048,
            label="相談チャット(まとめ)",
        ):
            if kind == "content":
                yield _sse({"delta": value})
            elif kind == "done":
                result = value
        accumulate(result)
        final_answer = result.get("content") or ""
        stats = final_stats()
        history.append(
            {"role": "assistant", "content": final_answer, **({"meta": stats} if stats else {})}
        )

    store.save_chat_messages(chat_id, history)
    yield _sse({"answer": final_answer or "", "chat_id": chat_id, "stats": final_stats()})


# ---- コンテキスト使用量 ----------------------------------------------
#
# lm-chat の /history/sessions/{id}/token_count と同方式。次のターンで
# llama-server に送られる内容(システム + ツール定義 + 保存済み履歴)を
# 連結して /tokenize で数え、ctx_size との比を UI のリングに出す。

CHAR_PER_TOKEN_FALLBACK = 2  # サーバー未起動時の概算(lm-chat と同じ len//2)


def _usage_text(
    store: Store,
    chat: dict[str, Any] | None,
    path: list[str],
    scope: str,
    char_id: str | None = None,
    mode: str = "interview",
) -> str:
    if char_id:
        system = build_character_system(store, path, char_id, mode)
        tools = build_character_tools()
    else:
        system = build_system(store, path, scope)
        tools = build_tools()
    parts = [system, json.dumps(tools, ensure_ascii=False)]
    for m in list(chat["messages"]) if chat else []:
        role = str(m.get("role", ""))
        content = m.get("content")
        if isinstance(content, str) and content:
            parts.append(f"{role}: {content}")
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function", {})
            parts.append(f"{role}: {fn.get('name', '')}({fn.get('arguments', '')})")
    return "\n".join(parts)


async def token_usage(
    store: Store,
    base_url: str,
    chat_id: str | None,
    anchor_node: str | None,
    scope: str,
    char_id: str | None = None,
    mode: str = "interview",
) -> dict[str, Any]:
    chat = store.get_chat(chat_id) if chat_id else None
    if chat is not None:
        anchor_node = chat["anchor_node"]
        scope = chat["scope"]
        char_id = chat.get("char_id")
        mode = chat.get("mode") or "interview"
    path = _visible_path(store, anchor_node, scope)
    if char_id and store.get_character(char_id) is None:
        char_id = None  # 削除済みキャラの履歴はシステム部を相談扱いで数える
    text = _usage_text(store, chat, path, scope, char_id, mode)
    counted = await llm.count_tokens(text, base_url=base_url)
    if counted is None:
        return {"token_count": len(text) // CHAR_PER_TOKEN_FALLBACK, "estimated": True}
    return {"token_count": counted, "estimated": False}


# ---- 内容ベースの質問候補 --------------------------------------------
#
# video-content-analyzer の /review/questions を参考にした軽量な生成。
# ツールは使わせず、見えている範囲のシーン見出しと直近の会話だけを渡して
# 3 件出させる(設定 chat_dynamic_suggestions が '0' のときは呼ばれない)。

SUGGEST_TEMPERATURE = 0.9
SUGGEST_HISTORY_TURNS = 2  # 直近の往復数
SUGGEST_BEATS = 12  # 末尾から渡すシーン数

QUESTIONS_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": {"type": "string", "minLength": 6, "maxLength": 60},
        }
    },
    "required": ["questions"],
}


def _recent_exchanges(messages: list[dict[str, Any]], turns: int) -> list[str]:
    """保存済み履歴から user / assistant の発言だけを取り出して末尾 turns 往復分。"""
    lines: list[str] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "user" and isinstance(content, str) and not content.startswith("(これ以上ツールは使えません"):
            lines.append(f"作者: {content}")
        elif role == "assistant" and isinstance(content, str) and content:
            lines.append(f"相談相手: {content}")
    return lines[-(turns * 2) :]


async def suggest_questions(
    store: Store,
    base_url: str,
    chat_id: str | None,
    anchor_node: str | None,
    scope: str,
) -> list[str]:
    if chat_id:
        chat = store.get_chat(chat_id)
        if chat is not None:
            anchor_node = chat["anchor_node"]
            scope = chat["scope"]
    else:
        chat = None
    path = _visible_path(store, anchor_node, scope)
    if not path:
        return []

    beats: list[str] = []
    for i, node_id in list(enumerate(path))[-SUGGEST_BEATS:]:
        node = store.get_node(node_id)
        if node is None:
            continue
        summary = (node["beat"] or "").replace("\n", " ")
        if len(summary) > 120:
            summary = summary[:120] + "…"
        beats.append(f"{i + 1}. {node['title'] or '(無題)'}: {summary}")

    parts = [
        "以下は執筆中の物語の、ここまでのシーン一覧です。",
        "作者がこの先を考えるうえで、聞いてみたくなる質問を3つ作ってください。",
        "",
        "条件:",
        "- 作者が相談相手(あなた)に投げる文として書く。40字以内、日本語、疑問文または依頼文",
        "- この物語の固有名詞(人物名・場所・出来事)を使い、この物語にしか当てはまらない内容にする",
        "- 一般論(「テーマは何ですか」など)や、すでに答えの出ている質問は避ける",
        "- 3つは互いに違う切り口にする(人物の内面 / 関係の変化 / 未回収の要素 / 次の展開 など)",
        "",
        "## シーン一覧",
        *beats,
    ]
    if chat is not None:
        recent = _recent_exchanges(list(chat["messages"]), SUGGEST_HISTORY_TURNS)
        if recent:
            parts += [
                "",
                "## 直近の会話(この続きとして自然な質問にする)",
                *recent,
            ]

    result = await llm.chat_json(
        [{"role": "user", "content": "\n".join(parts)}],
        base_url=base_url,
        schema=QUESTIONS_SCHEMA,
        max_tokens=512,
        temperature=SUGGEST_TEMPERATURE,
        label="質問候補",
    )
    questions = [q.strip() for q in (result.get("questions") or []) if isinstance(q, str) and q.strip()]
    return questions[:3]
