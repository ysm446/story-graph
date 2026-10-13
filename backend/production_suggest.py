"""制作チャットの直前の応答に合わせた、次の依頼の候補。

固定の候補(「○○をレビュー」など。renderer の productionSuggestions.ts)は対象を特定しない。
応答が示した案や指摘を指す依頼(「橋で再会する案で進めて」「指摘2の伏線だけ直して」など)を LLM に
作らせて足す。案を進めるボタンは、応答に案があるときだけ・案ごとに出したいので、固定では持たず
ここで作る(固定の「この案で進めて」は、ここが使えないときの代わりにだけ出る)。ツールを使わない軽い1回の呼び出しで、失敗しても固定の候補は残る。

候補は押した時点でそのまま送られる。実行として送るかどうかは LLM に決めさせず、種類(kind)から
機械的に決める。実行の候補は、相談の応答(案の提示・レビュー)の後にだけ出す。実行の完了報告を
もとに LLM が新しい編集を思いつき、1クリックで作品が書き換わるのを避ける。
"""

from __future__ import annotations

from typing import Any

import llm
from store import Store

MAX_SUGGESTIONS = 3  # 案が2つあると「進めて」だけで2枠使うので、もう1枠残す
REPLY_LIMIT = 4000  # 応答の末尾から渡す文字数(案や指摘のまとめは末尾に来やすい)
REQUEST_LIMIT = 600
TEMPERATURE = 0.3

# 種類 → 実行として送るか
KINDS = {"proceed": True, "fix": True, "review": False, "alternative": False}
# 依頼文の末尾に機械的に足す歯止め(固定の候補と同じ約束を守らせる)
EXECUTE_GUARD = ("対象と作業範囲は、この会話の直前の回答に従ってください。画面の選択だけを理由に変更せず、"
                 "完了済みの変更は繰り返さないでください。対象が特定できない場合は確認してください。")
CONSULT_GUARD = "保存内容は変更しないでください。"
# 対象を特定しない依頼は固定の候補と重なるので捨てる
GENERIC_LABELS = ("レビューして", "別案を考えて")


def schema(kinds: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "maxItems": MAX_SUGGESTIONS,
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": kinds},
                        "label": {"type": "string", "minLength": 4, "maxLength": 24},
                        "text": {"type": "string", "minLength": 8, "maxLength": 160},
                    },
                    "required": ["kind", "label", "text"],
                },
            }
        },
        "required": ["suggestions"],
    }


def last_exchange(messages: list[dict[str, Any]]) -> tuple[dict[str, Any], str] | None:
    """最後の依頼と、それに対する最後の文章の応答。応答が無ければ None。"""
    index = next((i for i in range(len(messages) - 1, -1, -1)
                  if messages[i].get("role") == "user" and not messages[i].get("instruction")), None)
    if index is None:
        return None
    reply = next((m["content"].strip() for m in reversed(messages[index + 1:])
                  if m.get("role") == "assistant" and isinstance(m.get("content"), str) and m["content"].strip()
                  and not any(m.get(key) for key in ("operation", "snapshot", "step", "instruction", "instruction_review"))), None)
    return (messages[index], reply) if reply else None


def clean(items: Any, kinds: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or item.get("kind") not in kinds:
            continue
        label = item["label"].strip() if isinstance(item.get("label"), str) else ""
        text = item["text"].strip() if isinstance(item.get("text"), str) else ""
        if not label or not text or label in GENERIC_LABELS or any(label == other["label"] for other in result):
            continue
        execute = KINDS[item["kind"]]
        result.append({"kind": item["kind"], "label": label, "execute": execute,
                       "text": text + "\n" + (EXECUTE_GUARD if execute else CONSULT_GUARD)})
    # 案を進める候補を先頭に置く(いちばん使うもの。同じ種類の中では LLM の順を保つ)
    result.sort(key=lambda item: item["kind"] != "proceed")
    return result[:MAX_SUGGESTIONS]


async def suggest(store: Store, base_url: str, chat_id: str) -> list[dict[str, Any]]:
    chat = store.get_chat(chat_id)
    if chat is None or chat.get("mode") != "production":
        return []
    exchange = last_exchange(list(chat["messages"]))
    if exchange is None:
        return []
    request, reply = exchange
    kinds = [kind for kind, execute in KINDS.items() if not execute or request.get("execute") is not True]
    parts = [
        f"以下は、物語の制作チャットの直近のやり取りです。作者が次に送りそうな依頼を、最大{MAX_SUGGESTIONS}つ作ってください。",
        "",
        "条件:",
        "- 直前の回答に書かれている内容だけを使う。回答に無い案・設定・シーン・出来事を作らない",
        "- 回答が挙げた案や指摘のうちの1つを具体的に指す依頼にする(例: 「案Bで進めて」「指摘2の伏線だけ直して」)",
        *(["- 回答が作品への変更案を示しているときは、案ごとに proceed を1つ作り、先頭に置く。案が1つだけでも作り、"
           "label はその案の中身がわかる文にする(例: 「橋で再会する案で進めて」)。変更案が無い回答(質問への答え、感想だけ)では proceed を作らない"]
          if "proceed" in kinds else []),
        "- label はボタンに出す短い文(20字以内)。text は制作担当へ送る依頼文(120字以内)で、どの案・どの指摘・どのシーンかを名前や番号で特定する",
        "- kind は依頼の種類: " + " / ".join(f"{kind}={KIND_HELP[kind]}" for kind in kinds),
        "- 「レビューして」「別案を考えて」のように対象を特定しない依頼は作らない(別のボタンが既にある)",
        "- 複数作るときは、互いに違う案・違う指摘を指す",
        "- 具体的に指せる案や指摘が無ければ、suggestions を空の配列にする",
        "",
        "## 作者の依頼",
        str(request.get("content") or "")[:REQUEST_LIMIT],
        "",
        "## 直前の回答",
        reply[-REPLY_LIMIT:],
    ]
    result = await llm.chat_json(
        [{"role": "user", "content": "\n".join(parts)}],
        base_url=base_url, schema=schema(kinds), max_tokens=512, temperature=TEMPERATURE, label="制作の依頼候補",
    )
    return clean(result.get("suggestions"), kinds)


KIND_HELP = {
    "proceed": "回答の案をそのまま実施する",
    "fix": "回答が指摘した問題を直す",
    "review": "内容を点検する",
    "alternative": "別の方向の案を求める",
}
