"""制作の作業の終わりに添える、保存結果だけでは分からない報告。

- 清書と章のまとめの「古くなった」: シーンの本文・登場人物・場所を変えると既存の清書は stale になるが、
  制作の完了報告はそれを伝えていなかった(2026-10-25 レビュー)。作業の前後で stale の集合を比べ、
  今回の作業で新しく古くなった分だけを知らせる(前からの分は数えない)。
"""

from __future__ import annotations


def stale_state(store) -> tuple[set[str], set[str]]:
    """最新の清書が stale なシーンの ID と、まとめが古くなった章の ID。"""
    renders = set()
    seen = set()
    for row in store.conn.execute(
            "SELECT node_id, preset_id, pov_char, stale FROM renders ORDER BY created_at DESC, rowid DESC"):
        key = (row["node_id"], row["preset_id"], row["pov_char"])
        if key in seen:
            continue
        seen.add(key)
        if row["stale"]:
            renders.add(row["node_id"])
    groups = {r["id"] for r in store.conn.execute("SELECT id FROM groups WHERE digest_stale = 1 AND digest_events IS NOT NULL")}
    return renders, groups


def stale_notice(store, before: tuple[set[str], set[str]]) -> str | None:
    """作業で新しく古くなった清書・まとめの知らせ。無ければ None。"""
    renders_after, groups_after = stale_state(store)
    renders = renders_after - before[0]
    groups = groups_after - before[1]
    if not renders and not groups:
        return None
    parts = []
    if renders:
        titles = [(store.get_node(nid) or {}).get("title") or "(無題)" for nid in sorted(renders)]
        shown = "、".join(f"「{t}」" for t in titles[:4]) + (f" ほか{len(titles) - 4}件" if len(titles) > 4 else "")
        parts.append(f"清書が古くなったシーン {len(renders)} 件: {shown}")
    if groups:
        titles = [row[0] for gid in sorted(groups)
                  for row in store.conn.execute("SELECT title FROM groups WHERE id = ?", (gid,)).fetchall()]
        parts.append("まとめが古くなった章: " + "、".join(f"「{t}」" for t in titles))
    return "この作業で" + "。".join(parts) + "。鑑賞するときに清書し直してください(清書は自動では作り直しません)。"
