"""制作の計画。実行の前に手順を決めて固定し、毎ステップ渡す。

これまでの実行は「読む → 1 操作決める → 適用」の繰り返しで、複数シーンにまたがる依頼でも全体の手順を
先に決める場所が無かった(2026-10-25 レビュー)。場当たりに 1 シーンずつ書いて後半が薄くなる、相談で詰めた案が
会話履歴(直近 12 件)から押し出される、16 ステップの枡に大きな依頼が収まらない、の 3 つに効かせる。

- 実行の開始時に 1 回だけ、構造化出力で手順(1 手順 = 1 回の書き込みツール)を作る。
  質問・相談だけ、対象が不明、1〜2 手順で済む依頼は計画なし(従来どおり)。
- 直前の相談の提案(「この案で進めて」の案)があれば、その内容をそのまま手順にする。
- 計画は履歴と SSE に残し、毎ステップのプロンプトに「今回の計画」として付ける。進捗は実行記録で判断させる。
- ステップの上限は手順の数に応じて広げる(4 + 2 × 手順数。16〜48)。反復停止の判定は従来のまま。
- 計画の失敗(モデルの不調・不正な出力)は無視し、計画なしで進める。権限は広がらない。
"""

from __future__ import annotations

import json
from typing import Any

import llm

MAX_PLAN_STEPS = 24
STEP_FLOOR = 16  # production_agent.MAX_STEPS と同じ
STEP_CEILING = 48
PROPOSAL_CHARS = 3000

SCHEMA = {
    "type": "object",
    "properties": {
        "needs_plan": {"type": "boolean"},
        "steps": {
            "type": "array", "maxItems": MAX_PLAN_STEPS,
            "items": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "maxLength": 120},
                    "target_ids": {"type": "array", "maxItems": 4, "items": {"type": "string"}},
                },
                "required": ["summary", "target_ids"],
            },
        },
        "note": {"type": "string", "maxLength": 200},
    },
    "required": ["needs_plan", "steps", "note"],
}

SYSTEM = (
    "あなたは物語制作の計画係です。作者の依頼を、制作ツールで実行する手順の列に分けます。"
    "1 手順 = 1 回の書き込み(1 シーンの追加、1 シーンの編集、章の作成、人物・場所・設定資料の登録や更新など)。"
    "本文を読む・構成を確認するなどの読み取りは手順に数えません。"
    "質問・相談・確認だけの発言、対象が特定できない依頼、1〜2 手順で済む依頼は needs_plan を false にして steps を空にします。"
    "直前の提案があるときは、その提案の内容をそのまま手順にします(作者はその案を承認しています)。"
    "手順は依頼と提案にある内容だけで組み、新しい設定・場面・人物を足しません。各手順の summary は何をどこにするかを 1 文で。"
    "target_ids には既存の対象の ID(シーン・章・資料)だけを入れ、新しく作るものの ID は書きません。"
    "複数のシーンを続けて書くときは物語の順に並べ、新しい章を途中に置くときは『章を作る』を最初の手順にします。"
    "note には手順全体で守ること(文体・長さ・残すもの)を短く書きます。"
)


def proposal_from(history: list[dict[str, Any]]) -> str:
    """直前の相談の提案(最後の作者の発言より前の、最後の文章の応答)。無ければ空。"""
    last_user = next((i for i in range(len(history) - 1, -1, -1)
                      if history[i].get("role") == "user" and not history[i].get("instruction")), None)
    if last_user is None:
        return ""
    for item in reversed(history[:last_user]):
        if item.get("role") == "user":
            break
        if item.get("role") == "assistant" and (item.get("content") or "").strip() and not any(
                item.get(k) for k in ("operation", "snapshot", "step", "instruction_review", "memory_review",
                                      "undo", "undo_done", "stale_notice", "plan", "closing", "outcome")):
            return item["content"][-PROPOSAL_CHARS:]
    return ""


def _outline(store) -> dict[str, Any]:
    canon = store.canon_path()
    titles = {row["id"]: row["title"] for row in store.conn.execute("SELECT id, title FROM nodes")}
    chapters = [{"id": g["id"], "title": g["title"], "in_id": g.get("in_id"), "out_id": g.get("out_id"),
                 "scenes": len([n for n in g["node_ids"] if n in titles])} for g in store.list_groups()]
    return {"canon": [{"id": nid, "title": titles.get(nid)} for nid in canon], "chapters": chapters}


async def make(store, base_url: str, request: str, history: list[dict[str, Any]], selection=None, policy_label: str = "") -> dict[str, Any] | None:
    """実行の前に手順を決める。計画が要らない・作れないときは None。"""
    proposal = proposal_from(history)
    user = {"依頼": request, "直前の提案": proposal, "送信時の選択": selection or [],
            "画面の変更条件": policy_label, "作品の構成": _outline(store)}
    try:
        result = await llm.chat_json(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(user, ensure_ascii=False)}],
            base_url=base_url, schema=SCHEMA, temperature=0.2, max_tokens=1200, label="制作の計画")
    except Exception:  # noqa: BLE001 — 計画は補助。失敗しても従来の進め方で続ける
        return None
    return normalize(result)


def normalize(result: Any) -> dict[str, Any] | None:
    if not isinstance(result, dict) or not result.get("needs_plan"):
        return None
    steps = []
    for item in result.get("steps") or []:
        if not isinstance(item, dict) or not isinstance(item.get("summary"), str) or not item["summary"].strip():
            continue
        targets = [t for t in (item.get("target_ids") or []) if isinstance(t, str) and t.strip()]
        steps.append({"summary": item["summary"].strip()[:120], "target_ids": targets[:4]})
    if not steps:
        return None
    note = result.get("note") if isinstance(result.get("note"), str) else ""
    return {"steps": steps[:MAX_PLAN_STEPS], "note": note.strip()[:200]}


def step_budget(plan: dict[str, Any] | None) -> int:
    """判断ループの上限。計画が無ければ従来の 16、あれば手順数に応じて広げる。"""
    if not plan:
        return STEP_FLOOR
    return max(STEP_FLOOR, min(STEP_CEILING, 4 + 2 * len(plan["steps"])))


def prompt_text(plan: dict[str, Any] | None) -> str:
    if not plan:
        return ""
    lines = [f"{i + 1}. {s['summary']}" + (f"(対象: {', '.join(s['target_ids'])})" if s["target_ids"] else "")
             for i, s in enumerate(plan["steps"])]
    return ("\n今回の計画(実行の前に決めた手順。進捗は実行記録と照合し、終わった手順は繰り返さない。"
            "作者の途中指示で変える必要があればそれに従う): " + " / ".join(lines)
            + (f"\n計画の注意: {plan['note']}" if plan.get("note") else ""))


def history_item(plan: dict[str, Any]) -> dict[str, Any]:
    return {"role": "assistant", "content": f"計画を立てました({len(plan['steps'])} 手順)。", "plan": plan}
