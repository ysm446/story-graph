"""相談チャット — 状態の読み取り専用エージェント(spec §8)。

news-picker の chat_agent.py の tool calling ループを踏襲。
- ツール: get_beats / get_state / search_memories(読み取りのみ)。展開の提案は通常の文章で返す
- スコープ: upto = アンカーノードまでの情報しか見えない(未来のネタバレ禁止)。
  all はユーザーが明示的に切り替えたときのみ
- 履歴は chats テーブルにアンカーノード付きで保存(LLM メッセージ形式のまま)
"""

from __future__ import annotations

import chat_rules

import json
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import llm
import retrieval
from store import Store, _is_turn_start


def _now() -> str:
    """発言時刻(UTC の ISO 8601)。表示側でローカル時刻に直す。"""
    return datetime.now(timezone.utc).isoformat()


MAX_TOOL_STEPS = 8
CHAT_TEMPERATURE = 0.7
MEMORY_TOP_K = 8
STATE_OVERVIEW_MEMORIES = 5  # 全体 state で 1 キャラあたりに載せる記憶数(char_id 指定なら絞らない)


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def build_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "get_beats",
                "description": "シーン本文を取得する。全体スコープでは枝・未接続シーンも含む。index は一覧の1始まりで、全体では時系列ではない。流れは接続図の edges を参照する。node_ids で対象を指定できる。省略すると全件(見えている範囲)。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "node_ids": {"type": "array", "items": {"type": "string"}, "description": "接続図のノードID。指定すると該当シーンだけ取得"},
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
                "description": (
                    "fold 済みの物語状態(キャラの facts / 関係値 / 記憶、世界の facts)を取得する。"
                    "記憶は 1 キャラあたり数件に絞られるので、特定のキャラを詳しく見るときは "
                    "char_id を指定する。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "node_id": {"type": "string", "description": "状態を確認するシーンID。全体スコープで省略すると正史末尾。そのノードに至る経路だけを反映する"},
                        "char_id": {
                            "type": "string",
                            "description": "指定するとそのキャラの状態のみ(記憶も多めに返る)",
                        },
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
    ]


# LLM が「A $\to$ B」のように数式記法で矢印や記号を書く癖があり、吹き出しには
# 数式の描画が無いので記号がそのまま見える(2026-10-09 ユーザー報告)。3 つのプロンプトで禁じ、
# 漏れた分は renderer の Markdown.tsx が描画前に → などへ置き換える
NO_MATH_RULE = "- 数式記法($…$、\\to、\\times など)は使わない。矢印は →、掛け算は × のように普通の文字で書く"

# ---- ツール実装(すべて読み取り専用) --------------------------------

def _visible_path(store: Store, anchor: str | None, scope: str) -> list[str]:
    # 保存済みチャットのアンカーが削除済みシーンを指していることがある(delete_node は
    # chats.anchor_node を掃除しない)。その場合はアンカー無しとして正史全体に倒す
    if anchor is not None and store.get_node(anchor) is None:
        anchor = None
    if scope == "all" or anchor is None:
        # all の既定の状態取得先。全シーンの列挙・接続図は別に取得し、
        # 複数の枝を一本の path として fold しない。
        return store.canon_path()
    # はじまり / 結末マーカーはシーンではないので除く(fold はイベントが無く素通り)
    return [nid for nid in store.path_to(anchor) if store._node_kind(nid) is None]


def _story_graph(store: Store) -> dict[str, Any]:
    """本文を含めない接続図。マーカーも残して章・結末への接続を切らない。"""
    nodes = store.conn.execute("SELECT id, title, kind, group_id FROM nodes ORDER BY created_at, rowid").fetchall()
    edges = store.conn.execute("SELECT from_node, to_node FROM edges ORDER BY rowid").fetchall()
    canon = store.canon_path()
    ending = store.active_ending()
    parents = {e["to_node"]: e["from_node"] for e in edges}
    route = set(store.path_to(ending, parents) if ending and store._ending_is_rooted(ending, parents)
                else store._canon_chain_from_start())
    canon_groups = {n["group_id"] for n in nodes if n["id"] in route and n["group_id"]}
    groups = [dict(r) for r in store.conn.execute("SELECT id, title FROM groups ORDER BY created_at, rowid")]
    return {
        "counts": {"all_scenes": sum(n["kind"] is None for n in nodes), "canon_scenes": len(canon),
                   "all_chapters": len(groups), "canon_chapters": len(canon_groups)},
        "groups": groups,
        "branch_entries": [{"from_node": e["from_node"], "branch_root": e["to_node"]}
                           for e in edges if e["from_node"] in route and e["to_node"] not in route],
        "detached_roots": [n["id"] for n in nodes if n["id"] not in parents and n["kind"] != "start"],
        "nodes": [{"id": n["id"], "title": n["title"], "kind": n["kind"] or "scene", "group_id": n["group_id"]} for n in nodes],
        "edges": [dict(e) for e in edges],
        "canon_path": canon,
        "active_ending": ending,
    }


def _tool_get_beats(store: Store, path: list[str], args: dict[str, Any], scope: str = "upto") -> dict[str, Any]:
    if scope == "all":
        path = [r["id"] for r in store.conn.execute(
            "SELECT id FROM nodes WHERE kind IS NULL ORDER BY created_at, rowid"
        )]
    requested = args.get("node_ids")
    if requested is not None and (not isinstance(requested, list) or any(nid not in path for nid in requested)):
        return {"error": "node_ids に参照範囲外またはシーン以外のIDが含まれています"}
    from_i = max(int(args.get("from_index") or 1), 1)
    to_i = min(int(args.get("to_index") or len(path)), len(path))
    beats = []
    for i in range(from_i - 1, to_i):
        if requested is not None and path[i] not in requested:
            continue
        node = store.get_node(path[i])
        if node is None:
            continue
        beats.append(
            {
                "node_id": path[i],
                "index": i + 1,
                "title": node["title"],
                "beat": node["beat"],
                "cast": node["cast"],
                "location": store.place_name(store.effective_location(path[i])[0]),
                "story_time": node["story_time"],
            }
        )
    return {"total": len(path), "beats": beats}


# fold の state(fold.py の StateSnapshot)は memories / reasons を event_id、キャラや
# 勢力を ID で持つ。そのまま返すとツール結果が ID の羅列になり、LLM 側には ID から
# 本文を引く手段が無い(search_memories はクエリ検索)。記憶は「何件あるか」しか
# 伝わっていなかったので、キャラモードのシステムプロンプト(build_character_system)
# と同じように、名前と本文に解決してから渡す。

def _name_map(store: Store) -> dict[str, str]:
    """char_id / faction_id → 名前。関係の相手を読める形に直すのに使う。"""
    names = {c["id"]: c["name"] for c in store.list_characters()}
    names.update({f["id"]: f["name"] for f in store.list_factions()})
    return names


def _memory_row(row: Any) -> dict[str, Any]:
    item: dict[str, Any] = {"content": row["content"]}
    if row["importance"] is not None:
        item["importance"] = round(float(row["importance"]), 2)
    return item


def _memories_view(store: Store, memory_ids: list[str], limit: int | None) -> dict[str, Any]:
    """記憶 ID の配列を本文に解決する。選び方はキャラモードと同じ(_select_memories)。

    limit を渡すと important / recent をそれぞれその件数までに絞る(全体 state 用)。
    載せきれなかった分は omitted で件数だけ伝える(search_memories で探せる)。
    """
    if not memory_ids:
        return {"total": 0, "recent": []}
    important, recent, total = _select_memories(store, memory_ids)
    if limit is not None:
        important = important[:limit]
        recent = recent[-limit:]
    view: dict[str, Any] = {"total": total}
    if important:
        view["important"] = [_memory_row(r) for r in important]
    view["recent"] = [_memory_row(r) for r in recent]
    omitted = total - len(important) - len(recent)
    if omitted > 0:
        view["omitted"] = omitted
    return view


def _relationships_view(names: dict[str, str], rels: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for target, rel in rels.items():
        item: dict[str, Any] = {
            "name": names.get(target, target),
            "score": rel.get("score", 0.0),
            # reasons は event_id の配列で LLM からは引けない。更新回数だけ残す
            "updates": len(rel.get("reasons") or []),
        }
        if rel.get("label"):
            item["label"] = rel["label"]
        if rel.get("target_type") and rel["target_type"] != "char":
            item["target_type"] = rel["target_type"]
        out[target] = item
    return out


def _char_state_view(
    store: Store,
    names: dict[str, str],
    char_id: str,
    cs: dict[str, Any],
    memory_limit: int | None,
) -> dict[str, Any]:
    # キーは ID のまま残す(get_state / search_memories の char_id で LLM が ID を使うため)
    view: dict[str, Any] = {
        "name": names.get(char_id, char_id),
        "status": cs.get("status"),
        "facts": cs.get("facts") or {},
        "relationships": _relationships_view(names, cs.get("relationships") or {}),
        "memories": _memories_view(store, list(cs.get("memories") or []), memory_limit),
    }
    if cs.get("retire_reason"):
        view["retire_reason"] = cs["retire_reason"]
    return view


def _tool_get_state(store: Store, path: list[str], args: dict[str, Any], scope: str = "upto") -> dict[str, Any]:
    node_id = args.get("node_id")
    if node_id:
        node = store.get_node(node_id)
        if node is None or node.get("kind") is not None or (scope != "all" and node_id not in path):
            return {"error": "参照範囲内のシーンIDを指定してください"}
        path = store.path_to(node_id)
    if not path:
        return {"error": "シーンがまだありません"}
    state = store.get_state(path[-1])
    names = _name_map(store)
    char_id = args.get("char_id")
    if char_id:
        char_state = state["chars"].get(char_id)
        if char_state is None:
            return {"error": f"キャラ {char_id} はまだ登場していません"}
        return {"node_id": path[-1], "char": char_id, "state": _char_state_view(store, names, char_id, char_state, None)}
    result: dict[str, Any] = {
        "node_id": path[-1],
        "world": state["world"],
        "chars": {
            cid: _char_state_view(store, names, cid, cs, STATE_OVERVIEW_MEMORIES)
            for cid, cs in state["chars"].items()
        },
    }
    place = store.location_context(path[-1])
    if place is not None:
        result["place"] = {"name": place["name"], "description": place.get("description")}
    return result


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
    origins = {
        h["id"]: store.conn.execute("SELECT node_id FROM events WHERE id = ?", (h["event_id"],)).fetchone()
        for h in hits
    }
    return {
        "memories": [
            {"node_id": origins[h["id"]]["node_id"] if origins[h["id"]] else None,
             "char_id": h["char_id"], "content": h["content"], "importance": h["importance"]}
            for h in hits
        ]
    }


def dispatch_tool(store: Store, name: str, args: dict[str, Any], path: list[str], scope: str) -> dict[str, Any]:
    try:
        if name == "get_beats":
            return _tool_get_beats(store, path, args, scope)
        if name == "get_state":
            return _tool_get_state(store, path, args, scope)
        if name == "search_memories":
            return _tool_search_memories(store, path, scope, args)
        return {"error": f"unknown tool: {name}"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


# ---- キャラクターと話す(キャラモード。docs/design/chat.md §6) --------
#
# アンカー時点の fold 済み state をキャラの人格材料にする。シーン一覧は
# 渡さない(居合わせていない場面を含むため)。知識は facts + 記憶のみ。

CHARACTER_MEMORY_LIMIT = 15  # システムプロンプトに直接入れる記憶数
CHARACTER_RECENT_SLOTS = 5  # うち「最近の出来事」に確保する枠(残りを重要度で埋める)


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


def _select_memories(
    store: Store, memory_ids: list[str]
) -> tuple[list[Any], list[Any], int]:
    """本文に載せる記憶を選ぶ。返り値は (強く残っている記憶, 最近の記憶, 総数)。

    重要度だけで上位を取ると、記憶が増えるほど「少し前の出来事」が押し出されて
    本人が覚えていないことになる(retrieval 側は story_order の時間減衰を持って
    いるのに、プロンプト側には新しさの概念が無かった)。章のまとめ(digest)の
    要約記憶は importance が高め(既定 0.6)なので、章を重ねるほどこれが効く。
    そこで直近 CHARACTER_RECENT_SLOTS 件の枠を先に確保し、残りを重要度で埋める。

    全部載るときは (空, 全件を古い順, 総数) を返し、呼び出し側が 1 節にまとめる。
    """
    placeholders = ",".join("?" for _ in memory_ids)
    # 新しい順。分岐ノード上の記憶(story_order < 0)は retrieval と同じく「いま」扱い
    rows = store.conn.execute(
        f"SELECT id, content, importance FROM memories WHERE id IN ({placeholders})"
        " ORDER BY (story_order IS NULL OR story_order < 0) DESC, story_order DESC",
        memory_ids,
    ).fetchall()
    if len(rows) <= CHARACTER_MEMORY_LIMIT:
        return [], list(reversed(rows)), len(rows)
    recent = rows[:CHARACTER_RECENT_SLOTS]
    taken = {r["id"] for r in recent}
    important = sorted(
        (r for r in rows if r["id"] not in taken),
        key=lambda r: r["importance"] if r["importance"] is not None else 0.0,
        reverse=True,
    )[: CHARACTER_MEMORY_LIMIT - len(recent)]
    return important, list(reversed(recent)), len(rows)


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
        # world facts は「誰もが知っている公のこと」という規約(2026-07-29)なので
        # 本人に渡してよい。秘密は知っているキャラの char fact に置く運用
        for k, v in state["world"]["facts"].items():
            lines.append(f"- (世間で知られていること){k}: {v}")

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
        important, recent, total = _select_memories(store, memory_ids)
        if not important:
            lines += ["", "## あなたの記憶"]
            lines += [f"- {r['content']}" for r in recent]
        else:
            lines += ["", "## 強く残っている記憶"]
            lines += [f"- {r['content']}" for r in important]
            lines += ["", "## 最近の出来事"]
            lines += [f"- {r['content']}" for r in recent]
        rest = total - len(important) - len(recent)
        if rest > 0:
            lines.append(
                f"(ここに書かれていない記憶がほかに {rest} 件ある。"
                "思い出せないことは recall で思い出せる)"
            )

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
        # 「書かれていないことは知らないと答えろ」だけだと recall を呼ばずに打ち切って
        # しまう(本文には重要度・直近で選んだ一部しか載っていない)。先に思い出させる
        "- 上に書かれていないことを聞かれたら、まず recall で思い出そうとする。"
        "それでも出てこなければ「覚えていない」「知らない」と答える",
        "- 知っているのは、上に書かれた状況・気持ち・記憶と、recall で思い出したことだけ",
        "- 記憶にない大きな出来事や事実を発明しない(言い回しや細部の脚色は構いません)",
        "- これから先に何が起きるかは知りません",
        "- 一人称で、あなたの口調で話す。物語・シーン・登場人物などのメタな言葉は使わない",
        NO_MATH_RULE,
    ]
    return "\n".join(lines)


# ---- キャラ同士の会話室(docs/design/chat.md §8) ------------------------
#
# 複数のキャラを同じ場に置き、作者は会話に参加せず演出家として指示だけ出す。
# 目的は記憶・関係性の点検(片方だけが知っている秘密が漏れないか、関係値どおりの
# 距離感で話すか)。会話は物語に戻さず、state にも書かない。
#
# 履歴に保存するのは「演出指示(user)」と「キャラの発言(assistant + speaker)」だけ。
# recall の往復は保存せず、発言ごとの prompt_messages(控え)に残す。

MAX_ROOM_TURNS = 8  # 1 リクエストで続けて話させる発言数の上限(UI の選択肢より広め)
ROOM_MAX_TOKENS = 512  # 発言 1 つの長さ(長広舌にさせない)
ROOM_PARTICIPANTS_MAX = 6


def _strip_speaker_prefix(text: str, name: str) -> str:
    """モデルが「名前:」「名前「…」」の形で返したときに接頭辞を落とす。"""
    t = text.strip()
    for sep in (":", "："):
        if t.startswith(name + sep):
            return t[len(name) + len(sep):].strip()
    if t.startswith(name + "「") and t.endswith("」") and t.count("「") == 1:
        return t[len(name) + 1 : -1].strip()
    return t


def build_room_system(store: Store, path: list[str], speaker_id: str, participants: list[str]) -> str:
    """会話室での発言者 1 人分のシステムプロンプト。本人の知識はキャラチャットと同じ
    build_character_system で作り、枠組み(この会話について)だけを会話室用に差し替える。"""
    base = build_character_system(store, path, speaker_id, "roleplay")
    # 「## この会話について」以降を会話室の枠組みに置き換える(知識の節はそのまま)
    head = base.split("\n## この会話について", 1)[0].rstrip()
    others = []
    for cid in participants:
        if cid == speaker_id:
            continue
        c = store.get_character(cid)
        others.append(c["name"] if c else cid)
    me = store.get_character(speaker_id)
    my_name = me["name"] if me else speaker_id
    lines = [
        head,
        "",
        "## この会話について",
        f"あなた({my_name})は今、{'、'.join(others) or '誰か'}と同じ場所で言葉を交わしています。",
        "これは作者が人物どうしの関係と記憶を確かめるための試しの会話で、物語の本編には含まれません。",
        "相手の発言は「名前「…」」の形で届きます。作者(演出家)からの指示は（演出: …）の形で届きます。",
        "演出の指示には従ってください。ただし指示そのものを台詞にしたり、演出家に向けて話したりしないでください。",
        "",
        "## 厳守すること",
        "- 知っているのは、上に書かれた状況・気持ち・記憶と、recall で思い出したこと、"
        "そしてこの場で相手から直接聞いたことだけ",
        "- 上に書かれていないことを話題にされたら、まず recall で思い出そうとする。"
        "それでも出てこなければ、知らない・覚えていないものとして振る舞う",
        "- 記憶にない大きな出来事や事実を発明しない(言い回しや細部の脚色は構いません)",
        "- これから先に何が起きるかは知りません",
        "- 相手への今の気持ちに沿った距離感で話す。初対面や警戒している相手には、秘密や本心を簡単には明かさない",
        f"- あなた({my_name})の発言だけを書く。相手の台詞や相手の行動を書かない",
        "- 発言は一人称で、あなたの口調で、長くても数文にとどめる。短い動作や表情は（）で添えてよい",
        "- 名前の接頭辞(「名前:」)は付けない。物語・シーン・登場人物などのメタな言葉は使わない",
        NO_MATH_RULE,
    ]
    return "\n".join(lines)


def _room_transcript_messages(
    store: Store, history: list[dict[str, Any]], speaker_id: str
) -> list[dict[str, Any]]:
    """保存済みの会話室の履歴を、発言者の視点の messages にする。

    自分の発言は assistant、他のキャラの発言と演出指示は user に置く。user 側が続く
    ところは 1 つにまとめる(役割の交互を崩さないため)。
    """
    names = _name_map(store)
    out: list[dict[str, Any]] = []
    pending: list[str] = []

    def flush() -> None:
        if pending:
            out.append({"role": "user", "content": "\n".join(pending)})
            pending.clear()

    for m in history:
        role = m.get("role")
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        if role == "user":
            pending.append(f"（演出: {content.strip()}）")
        elif role == "assistant":
            sp = m.get("speaker")
            if sp == speaker_id:
                flush()
                out.append({"role": "assistant", "content": content})
            else:
                pending.append(f"{names.get(sp, sp or '?')}「{content.strip()}」")
    flush()
    if not out or out[-1]["role"] != "user":
        # 口火を切るとき(履歴が空、または直前が自分)も user で終わらせる
        out.append({"role": "user", "content": "（演出: あなたの番です。話してください）"})
    return out


def next_room_speaker(participants: list[str], history: list[dict[str, Any]]) -> str:
    """指名が無いときの話者: 最後に話した人の次(ラウンドロビン)。誰も話していなければ先頭。"""
    last = next((m.get("speaker") for m in reversed(history) if m.get("role") == "assistant"), None)
    if last in participants:
        return participants[(participants.index(last) + 1) % len(participants)]
    return participants[0]


async def room_stream(
    store: Store,
    base_url: str,
    chat_id: str | None,
    anchor_node: str | None,
    participants: list[str] | None,
    instruction: str | None,
    speaker: str | None,
    turns: int,
    replace_from: int | None = None,
) -> AsyncIterator[str]:
    try:
        async for chunk in _room_impl(
            store, base_url, chat_id, anchor_node, participants, instruction, speaker, turns, replace_from
        ):
            yield chunk
    except Exception as e:  # noqa: BLE001
        try:
            store.conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        yield _sse({"error": f"{type(e).__name__}: {e}"})


async def _room_impl(
    store: Store,
    base_url: str,
    chat_id: str | None,
    anchor_node: str | None,
    participants: list[str] | None,
    instruction: str | None,
    speaker: str | None,
    turns: int,
    replace_from: int | None = None,
) -> AsyncIterator[str]:
    if chat_id:
        chat = store.get_chat(chat_id)
        if chat is None:
            yield _sse({"error": f"チャットが見つかりません: {chat_id}"})
            return
        if chat.get("mode") != "room" or not chat.get("participants"):
            yield _sse({"error": "キャラ同士の会話ではありません"})
            return
        anchor_node = chat["anchor_node"]
        participants = list(chat["participants"])
    else:
        participants = list(dict.fromkeys(participants or []))
        if len(participants) < 2:
            yield _sse({"error": "参加者を 2 人以上選んでください"})
            return
        if len(participants) > ROOM_PARTICIPANTS_MAX:
            yield _sse({"error": f"参加者は {ROOM_PARTICIPANTS_MAX} 人までです"})
            return
        for cid in participants:
            if store.get_character(cid) is None:
                yield _sse({"error": f"キャラが見つかりません: {cid}"})
                return
        # 会話室は常に upto(未来を知るキャラは成立しない)
        chat = store.create_chat(anchor_node, "upto", mode="room", participants=participants)
        chat_id = chat["id"]
    yield _sse({"chat_id": chat_id})

    turns = max(0, min(int(turns), MAX_ROOM_TURNS))
    if speaker is not None and speaker not in participants:
        yield _sse({"error": f"参加者ではありません: {speaker}"})
        return

    path = _visible_path(store, anchor_node, "upto")
    history: list[dict[str, Any]] = list(chat["messages"])
    # 演出指示の編集・作り直し: 指定位置以降を捨ててから積み直す(話者の順もそこから数え直す)
    if replace_from is not None and 0 <= replace_from <= len(history):
        history = history[:replace_from]
    if instruction and instruction.strip():
        history.append({"role": "user", "content": instruction.strip(), "ts": _now()})
    tools = build_character_tools()
    names = _name_map(store)

    try:
        for turn in range(turns):
            # 指名は最初の発言だけ。以降はその人の次から順に回す
            current = speaker if (turn == 0 and speaker) else next_room_speaker(participants, history)
            system = build_room_system(store, path, current, participants)
            transcript = _room_transcript_messages(store, history, current)
            # ツール往復はこの発言の間だけ持つ(履歴には残さない)
            scratch: list[dict[str, Any]] = []

            def messages() -> list[dict[str, Any]]:
                return [{"role": "system", "content": system}, *transcript, *scratch]

            yield _sse({"speaker": current, "turn": turn})
            stats_total: dict[str, Any] = {"tokens": 0, "elapsed_sec": 0.0, "steps": 0, "finish_reason": None}
            text = ""
            used_tools: list[str] = []
            for step in range(MAX_TOOL_STEPS):
                yield _sse({"stage": "thinking", "speaker": current})
                result: dict[str, Any] = {}
                async for kind, value in llm.chat_stream_tools(
                    messages(),
                    base_url=base_url,
                    temperature=CHAT_TEMPERATURE,
                    max_tokens=ROOM_MAX_TOKENS,
                    tools=tools,
                    label=f"会話室 {names.get(current, current)}(step {step + 1})",
                ):
                    if kind == "content":
                        yield _sse({"delta": value, "speaker": current})
                    elif kind == "done":
                        result = value
                st = result.get("stats") or {}
                stats_total["tokens"] += st.get("tokens") or 0
                stats_total["elapsed_sec"] += st.get("elapsed_sec") or 0.0
                stats_total["finish_reason"] = st.get("finish_reason") or stats_total["finish_reason"]
                stats_total["model"] = st.get("model") or stats_total.get("model")
                stats_total["steps"] += 1
                tool_calls = result.get("tool_calls")
                if not tool_calls:
                    text = result.get("content") or ""
                    break
                scratch.append(result["message"])
                for tc in tool_calls:
                    name = tc.get("function", {}).get("name", "")
                    try:
                        args = json.loads(tc.get("function", {}).get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    yield _sse({"tool_call": {"name": name, "args": args}, "speaker": current})
                    if name == "recall":
                        payload: dict[str, Any] = _tool_search_memories(
                            store, path, "upto", {"query": args.get("query") or "", "char_id": current}
                        )
                    else:
                        payload = {"error": f"unknown tool: {name}"}
                    used_tools.append(name)
                    scratch.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id", ""),
                            "content": json.dumps(payload, ensure_ascii=False),
                        }
                    )
                    yield _sse({"tool_result": {"name": name, "is_error": "error" in payload}, "speaker": current})
            else:
                scratch.append(
                    {"role": "user", "content": "(これ以上 recall は使えません。思い出せたことで話してください)"}
                )
                yield _sse({"stage": "thinking", "speaker": current})
                result = {}
                async for kind, value in llm.chat_stream_tools(
                    messages(),
                    base_url=base_url,
                    temperature=CHAT_TEMPERATURE,
                    max_tokens=ROOM_MAX_TOKENS,
                    label=f"会話室 {names.get(current, current)}(まとめ)",
                ):
                    if kind == "content":
                        yield _sse({"delta": value, "speaker": current})
                    elif kind == "done":
                        result = value
                text = result.get("content") or ""
            text = _strip_speaker_prefix(text, names.get(current, current))
            elapsed = stats_total["elapsed_sec"] or None
            stats = (
                {
                    "tokens": stats_total["tokens"],
                    "elapsed_sec": round(elapsed, 2) if elapsed else None,
                    "tokens_per_sec": round(stats_total["tokens"] / elapsed, 1) if elapsed else None,
                    "finish_reason": stats_total["finish_reason"],
                    "steps": stats_total["steps"],
                    "model": stats_total.get("model"),
                }
                if stats_total["tokens"]
                else None
            )
            history.append(
                {
                    "role": "assistant",
                    "speaker": current,
                    "content": text,
                    "ts": _now(),
                    "prompt_messages": messages(),
                    **({"tools_used": used_tools} if used_tools else {}),
                    **({"meta": stats} if stats else {}),
                }
            )
            # 発言が確定するたびに保存する(途中で止めてもそこまでは残る)
            store.save_chat_messages(chat_id, history)
            yield _sse({"utterance": {"speaker": current, "text": text, "stats": stats, "index": len(history) - 1}})
    finally:
        store.save_chat_messages(chat_id, history)

    yield _sse({"done": True, "chat_id": chat_id})


# ---- システムプロンプト ----------------------------------------------

def build_system(store: Store, path: list[str], scope: str, *, production: bool = False) -> str:
    chars = "\n".join(f"- {c['id']}: {c['name']}" for c in store.list_characters())
    anchor_text = (
        f"あなたに見えているのはシーン {len(path)} までの情報だけです。"
        "それ以降の展開について聞かれたら、まだ見えていないことを伝えてください。"
        if scope == "upto"
        else "枝・未接続ノードを含む物語全体を参照できます。シーン本文は get_beats で確認してください。"
    )
    return "\n".join(
        [
            ("あなたは物語作りの制作担当です。作者の依頼に応じて構成を編集します。" if production else
             "あなたは物語作りの相談相手です。作者と一緒に物語の状態を確認し、展開を考えます。"),
            "",
            "ルール:",
            "- 推測で答えず、必要に応じて get_beats / get_state / search_memories で事実を確認してから答える",
            f"- {anchor_text}",
            ("- 作成・編集を依頼されたら、指定範囲の本文と設定を確認し、ツールで実際に編集する。"
             "手順や場面数が未指定でも依頼の目的に沿って判断し、案の提示や実行の再確認だけで終わらない。"
             "対象が特定できない場合や、両立しない条件がある場合は質問する。"
             "作者が相談・提案・確認だけを求めた場合は編集しない。" if production else
             "- 展開の提案は通常の文章で返し、各案の内容と狙いを説明する。提案用のツールは使わない。"
             "案数は固定せず、作者が数を指定した場合はその数に従う"),
            "- 回答は簡潔に。作者の判断材料になる観察(関係値の流れ、未回収の記憶など)を優先する",
            NO_MATH_RULE,
            chat_rules.prompt(store),
            "",
            "## キャラクター ID 一覧",
            chars,
            *([
                "",
                "## 物語全体の接続図",
                "edges は from_node → to_node の有向接続。配列順や一覧番号は物語の時系列ではない。",
                "counts はマーカーを除くシーン数と章数の集計。branch_entries は正史の分岐元from_nodeと枝の先頭branch_rootを区別する。枝を説明するときは分岐元→枝の先頭の両IDを示す。detached_rootsは親のない未接続の入口。",
                "canon_path が現在の正史。その他の枝・別の結末・未接続ノードも相談対象に含める。",
                "別経路の出来事を一続きの出来事として混ぜない。記憶の node_id を接続図と照合する。",
                "get_state は node_id で経路を選ぶ。省略時は正史末尾であり、全枝を合成した状態ではない。",
                "過去の会話の取得結果より、この接続図と今回取得する本文を優先する。",
                json.dumps(_story_graph(store), ensure_ascii=False),
            ] if scope == "all" else []),
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
    replace_turn: int | None = None,
) -> AsyncIterator[str]:
    try:
        async for chunk in _chat_impl(
            store, base_url, chat_id, anchor_node, scope, user_message, char_id, mode, replace_from, replace_turn
        ):
            yield chunk
    except Exception as e:  # noqa: BLE001
        # エラー時に半端な書き込みを次のリクエストへ持ち越さない(app.py の
        # ロールバックハンドラは SSE 生成器内の例外には届かない)
        try:
            store.conn.rollback()
        except Exception:  # noqa: BLE001
            pass
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
    replace_turn: int | None = None,
) -> AsyncIterator[str]:
    """replace_from: その位置以降を捨てて user_message を積み直す(巻き戻し)。
    replace_turn: その位置の user 発言はそのままに、**その往復の返事(ツール行込み)だけ**を
    作り直す。以降の往復は残す(履歴がずれるのは承知の上、ユーザー決定 2026-10-09)。
    生成に渡すのはその発言までの履歴だけ(未来を見せない)。user_message は使わない。
    """
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
    tail: list[dict[str, Any]] = []  # replace_turn のとき、残しておく以降の往復
    if replace_turn is not None:
        if not (0 <= replace_turn < len(history)) or history[replace_turn].get("role") != "user":
            yield _sse({"error": f"作り直す発言が見つかりません: {replace_turn}"})
            return
        end = replace_turn + 1
        while end < len(history) and not _is_turn_start(history[end]):
            end += 1
        tail = history[end:]
        history = history[: replace_turn + 1]
    else:
        # 巻き戻し: 指定位置以降を捨ててから、新しい発言を積み直す
        if replace_from is not None and 0 <= replace_from <= len(history):
            history = history[:replace_from]
        history.append({"role": "user", "content": user_message, "ts": _now()})
    if char_id:
        system = build_character_system(store, path, char_id, mode)
        tools = build_character_tools()
    else:
        system = build_system(store, path, scope)
        tools = build_tools()

    def messages() -> list[dict[str, Any]]:
        # meta(生成統計)・ts(発言時刻)・prompt_messages(生成時に送った内容の
        # 控え)は保存用の付加情報なので LLM には渡さない。system_prompt は
        # prompt_messages の旧形式(控えを system だけにしていた頃)の名残
        return [
            {"role": "system", "content": system},
            *({k: v for k, v in m.items() if k not in ("meta", "ts", "system_prompt", "prompt_messages")} for m in history),
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
        if s.get("model"):
            stats_total["model"] = s["model"]
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
            "model": stats_total.get("model"),
        }

    final_answer: str | None = None
    try:
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
                # prompt_messages はこの返事を作った LLM 呼び出しに実際に送った内容の
                # 控え(system + それまでの履歴 + ツール結果)。UI の閲覧用で、履歴が
                # 長くなると返事ごとに全文が積まれて嵩むが、正確さを優先して許容する
                history.append(
                    {
                        "role": "assistant",
                        "content": final_answer,
                        "ts": _now(),
                        "prompt_messages": messages(),
                        **({"meta": stats} if stats else {}),
                    }
                )
                break
            # ツール呼び出し途中の発言にも控えを付ける(content 付きなら吹き出しになる)
            history.append({**result["message"], "prompt_messages": messages()})
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
                {
                    "role": "assistant",
                    "content": final_answer,
                    "ts": _now(),
                    "prompt_messages": messages(),
                    **({"meta": stats} if stats else {}),
                }
            )
    finally:
        # 途中失敗・切断でも、ここまでの往復(ユーザー発言・ツール結果)は保存する
        store.save_chat_messages(chat_id, history + tail)

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
    participants: list[str] | None = None,
) -> str:
    if participants:
        # 会話室は発言者ごとにシステムプロンプトが違う。次に送る量の目安として一番長い人で数える
        systems = [
            build_room_system(store, path, cid, participants)
            for cid in participants
            if store.get_character(cid) is not None
        ]
        system = max(systems, key=len) if systems else ""
        tools = build_character_tools()
    elif char_id:
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
    participants: list[str] | None = None,
) -> dict[str, Any]:
    chat = store.get_chat(chat_id) if chat_id else None
    if chat is not None:
        anchor_node = chat["anchor_node"]
        scope = chat["scope"]
        char_id = chat.get("char_id")
        mode = chat.get("mode") or "interview"
        participants = chat.get("participants") if mode == "room" else None
    path = _visible_path(store, anchor_node, scope)
    if char_id and store.get_character(char_id) is None:
        char_id = None  # 削除済みキャラの履歴はシステム部を相談扱いで数える
    text = _usage_text(store, chat, path, scope, char_id, mode, participants)
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
