"""制作の実機検証で、最終状態だけでなく途中経過を数える(plan.md「制作ハーネスの精度向上」)。

production_agent.stream の SSE イベント列から、ステップ数・停止理由・ツールエラー(文面別)・
同じ取得の反復・ノードごとの書き込み回数(同じシーンへの再編集)を集計する。
検証スクリプトは結果JSONにこれを添える。合否判定そのものは各スクリプトの条件で行う。
"""
from __future__ import annotations

from collections import Counter


def summarize(events: list[dict]) -> dict:
    tool_calls = [e["tool_call"] for e in events if isinstance(e.get("tool_call"), dict)]
    reads = Counter((c.get("name"), c.get("target")) for c in tool_calls
                    if c.get("name") in ("get_beats", "get_state", "search_memories", "read_library",
                                         "search_setting_documents", "read_setting_document"))
    writes_per_node: Counter = Counter()
    for e in events:
        change = e.get("changed")
        if not isinstance(change, dict):
            continue
        key = change.get("node_id") or change.get("entity_id")
        if key:
            writes_per_node[f"{change.get('action')}:{key}"] += 1
    errors = Counter(e["tool_error"] for e in events if isinstance(e.get("tool_error"), str))
    done = next((e for e in events if e.get("done")), None)
    return {
        "outcome": (done or {}).get("outcome"),
        "steps": (done or {}).get("steps", sum(str(e.get("stage", "")).startswith("確認しています") for e in events)),
        "changes": sum(1 for e in events if e.get("changed")),
        "tool_errors": sum(errors.values()),
        "tool_errors_by_message": [{"message": m, "count": n} for m, n in errors.most_common()],
        "repeated_reads": [{"tool": name, "target": target, "count": n} for (name, target), n in reads.most_common() if n > 1],
        "repeated_writes": [{"operation": op, "count": n} for op, n in writes_per_node.most_common() if n > 1],
        "instructions_reflected": sum(1 for e in events if (e.get("instruction") or {}).get("instruction", {}).get("status") == "reflected"),
        "sse_error": next((e["error"] for e in events if e.get("error")), None),
    }


def describe(metrics: dict) -> str:
    parts = [f"outcome={metrics['outcome']}", f"steps={metrics['steps']}", f"changes={metrics['changes']}",
             f"tool_errors={metrics['tool_errors']}"]
    if metrics["repeated_reads"]:
        parts.append("repeated_reads=" + ",".join(f"{r['tool']}({r['target']})x{r['count']}" for r in metrics["repeated_reads"]))
    if metrics["repeated_writes"]:
        parts.append("repeated_writes=" + ",".join(f"{w['operation']}x{w['count']}" for w in metrics["repeated_writes"]))
    return " ".join(parts)
