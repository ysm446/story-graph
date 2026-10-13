"""シーンの時間 — 「前のシーンからの経過」と、そこから導く時点の距離。

時間はシーンごとに「1 つ前のシーンからどれだけ経ったか」で持つ(nodes.elapsed_unit /
elapsed_count)。絶対的な日付や Day 番号は持たない: 途中への挿入・並べ替え・分岐で
後ろの番号がずれるため。未設定(NULL)は「決めていない」で、「直後」とは区別する
(未設定を直後として扱うと、章が変わって数日経った場面が直前の続きとして書かれる)。

純粋関数と、道(シーン ID の並び)から値を引く薄い読み取りだけを置く。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from store import Store

# 数を持たない単位 / 持つ単位。画面のプルダウンと LLM のツール引数もこの並び
UNCOUNTED = ("immediate", "same_day")
COUNTED = ("day", "week", "month", "year")
UNITS = UNCOUNTED + COUNTED

_SUFFIX = {"day": "日", "week": "週間", "month": "か月", "year": "年"}
# 距離の概算に使う日数(月・年は暦を持たないので丸める)
_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}
MAX_COUNT = 9999

UNIT_HELP = (
    "immediate=直後(ひとつながりの場面) / same_day=同じ日(場面は変わるが日はまたがない) / "
    "day=日後 / week=週間後 / month=か月後 / year=年後"
)


def normalize(unit: Any, count: Any) -> tuple[str | None, int | None]:
    """保存する形に揃える。未設定は (None, None)。数を持つ単位は 1 以上の整数にする。"""
    if unit is None or unit == "":
        return None, None
    if unit not in UNITS:
        raise ValueError(f"経過の単位が不正です: {unit}({' / '.join(UNITS)} のいずれか)")
    if unit in UNCOUNTED:
        return unit, None
    if count is None:
        return unit, 1
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_COUNT:
        raise ValueError(f"経過の数は 1〜{MAX_COUNT} の整数で指定してください")
    return unit, count


def label(unit: str | None, count: int | None) -> str | None:
    """「3日後」「直後」のような表示。未設定は None。"""
    if unit is None:
        return None
    if unit == "immediate":
        return "直後"
    if unit == "same_day":
        return "同じ日"
    return f"{count or 1}{_SUFFIX[unit]}後"


def _days(unit: str, count: int | None) -> int:
    return 0 if unit in UNCOUNTED else _DAYS[unit] * (count or 1)


def points(steps: list[tuple[str | None, int | None]]) -> list[tuple[int, int]]:
    """道の各シーンの (区間, 区間の先頭からの日数)。

    経過が未設定のシーンで区間を切る。区間をまたぐ 2 点の距離は分からない。
    先頭のシーンの経過は「物語の前」からのもので、距離には使わない。
    """
    out: list[tuple[int, int]] = []
    segment = day = 0
    for i, (unit, count) in enumerate(steps):
        if i > 0:
            if unit is None:
                segment, day = segment + 1, 0
            else:
                day += _days(unit, count)
        out.append((segment, day))
    return out


def ago(then: tuple[int, int], now: tuple[int, int]) -> str | None:
    """now から見て then がどれくらい前か。区間が違えば None(分からない)。"""
    if then[0] != now[0]:
        return None
    days = now[1] - then[1]
    if days <= 0:
        return "今日"
    if days < 14:
        return f"{days}日前"
    if days < 60:
        return f"約{round(days / 7)}週間前"
    if days < 365 * 2:
        return f"約{round(days / 30)}か月前"
    return f"約{round(days / 365)}年前"


def steps_for(store: Store, scene_ids: list[str]) -> list[tuple[str | None, int | None]]:
    """シーン ID の並びに対応する (単位, 数)。"""
    if not scene_ids:
        return []
    marks = ",".join("?" for _ in scene_ids)
    rows = {
        r["id"]: (r["elapsed_unit"], r["elapsed_count"])
        for r in store.conn.execute(
            f"SELECT id, elapsed_unit, elapsed_count FROM nodes WHERE id IN ({marks})", scene_ids
        )
    }
    return [rows.get(nid, (None, None)) for nid in scene_ids]


def previous_scene(store: Store, node_id: str) -> str | None:
    """同じ道の 1 つ前のシーン(はじまり・章の入口と出口のマーカーは読み飛ばす)。"""
    path = [n for n in store.path_to(node_id) if store._node_kind(n) is None]
    if node_id not in path:
        return None
    index = path.index(node_id)
    return path[index - 1] if index > 0 else None


def transition(store: Store, node: dict[str, Any]) -> dict[str, Any] | None:
    """前のシーンからこのシーンへの移り方。前のシーンが無ければ None。

    continuous は「直前の続きとして書いてよいか」。経過が未設定でも、章が変わって
    いなければ従来どおり続きとして扱う(既存のシーンは全て未設定なので、ここを
    変えると章の中の連続した場面まで切れてしまう)。
    """
    prev_id = previous_scene(store, node["id"])
    if prev_id is None:
        return None
    unit = node.get("elapsed_unit")
    row = store.conn.execute("SELECT group_id FROM nodes WHERE id = ?", (prev_id,)).fetchone()
    chapter_changed = (row["group_id"] if row else None) != node.get("group_id")
    if unit == "immediate":
        note, continuous = "直後(前のシーンからひとつながり)", True
    elif unit == "same_day":
        note, continuous = "同じ日(場面は変わっている。直前の続きとして書かない)", False
    elif unit is not None:
        note = f"{label(unit, node.get('elapsed_count'))}(その時間が経ったところから始める。直前の続きとして書かない)"
        continuous = False
    elif chapter_changed:
        note, continuous = "未設定(章が変わっている。直前の続きと決めつけず、このシーンの内容から判断する)", False
    else:
        note, continuous = "未設定(直後とは限らない。このシーンの内容から判断する)", True
    return {"prev_id": prev_id, "note": note, "continuous": continuous, "chapter_changed": chapter_changed}
