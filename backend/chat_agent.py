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
) -> AsyncIterator[str]:
    try:
        async for chunk in _chat_impl(store, base_url, chat_id, anchor_node, scope, user_message):
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
) -> AsyncIterator[str]:
    if chat_id:
        chat = store.get_chat(chat_id)
        if chat is None:
            yield _sse({"error": f"チャットが見つかりません: {chat_id}"})
            return
        anchor_node = chat["anchor_node"]
        scope = chat["scope"]
    else:
        chat = store.create_chat(anchor_node, scope)
        chat_id = chat["id"]
    yield _sse({"chat_id": chat_id})

    path = _visible_path(store, anchor_node, scope)
    history: list[dict[str, Any]] = list(chat["messages"])
    history.append({"role": "user", "content": user_message})
    system = build_system(store, path, scope)
    tools = build_tools()

    def messages() -> list[dict[str, Any]]:
        return [{"role": "system", "content": system}, *history]

    final_answer: str | None = None
    for step in range(MAX_TOOL_STEPS):
        yield _sse({"stage": "thinking"})
        result = await llm.chat(
            messages(),
            base_url=base_url,
            temperature=CHAT_TEMPERATURE,
            max_tokens=2048,
            tools=tools,
            label=f"相談チャット(step {step + 1})",
        )
        tool_calls = result.get("tool_calls")
        if not tool_calls:
            final_answer = result["content"]
            history.append({"role": "assistant", "content": final_answer})
            break
        history.append(result["message"])
        for tc in tool_calls:
            name = tc.get("function", {}).get("name", "")
            try:
                args = json.loads(tc.get("function", {}).get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            yield _sse({"tool_call": {"name": name, "args": args}})
            if name == "propose_beats":
                proposals = (args.get("proposals") or [])[:3]
                yield _sse({"proposals": proposals})
                payload: dict[str, Any] = {"ok": True, "count": len(proposals)}
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
        result = await llm.chat(
            messages(),
            base_url=base_url,
            temperature=CHAT_TEMPERATURE,
            max_tokens=2048,
            label="相談チャット(まとめ)",
        )
        final_answer = result["content"]
        history.append({"role": "assistant", "content": final_answer})

    store.save_chat_messages(chat_id, history)
    yield _sse({"answer": final_answer or "", "chat_id": chat_id})
