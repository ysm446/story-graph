"""まとめて更新(docs/design/bulk-update.md)。

古くなった章のまとめ・清書・朗読台本(話者と感情)を拾って数える。実行そのものは既存の口
(`/groups/{id}/digest/generate`・`/render`・`/renders/{id}/voice_script/annotate`)を画面のキューが順に呼ぶので、ここは**何を対象にするか**だけを決める
(数え方を 1 か所にして、ダイアログの件数と実際に走る対象を食い違わせない)。

段階 1 は章のまとめ・清書・台本。イベント(正史を変える)は段階 2 で足す。
"""
from __future__ import annotations

from typing import Any

from store import Store


def render_style(store: Store) -> dict[str, Any]:
    """清書の対象にする文体プリセットと視点(鑑賞モードでいま選んでいる組)。

    画面(RenderStyle.tsx)と同じ決め方: 保存された選択が生きていればそれ、無ければ先頭のプリセット。
    視点は、消えたキャラクターを指していたら「なし」。
    """
    settings = store.get_settings()
    presets = store.list_presets()
    saved = settings.get("reader_preset_id")
    preset = next((p for p in presets if p["id"] == saved), presets[0] if presets else None)
    pov = store.get_character(settings.get("reader_pov_char") or "")
    try:
        target_chars = max(0, round(float(settings.get("reader_target_chars") or 0)))
    except ValueError:
        target_chars = 0
    return {
        "preset": {"id": preset["id"], "name": preset["name"]} if preset else None,
        "pov": {"id": pov["id"], "name": pov["name"]} if pov else None,
        "target_chars": target_chars,
    }


def _scenes(store: Store, include_branches: bool) -> list[dict[str, Any]]:
    """対象の範囲のシーン(マーカーを除く)を、物語の順に返す。

    正史の道はその並び。分岐・島を含めるときは、その後ろにルートからの深さ順で足す
    (清書は 1 つ前のシーンの清書の末尾につなげるので、親が先に来るようにする)。
    """
    rows = {
        r["id"]: dict(r)
        for r in store.conn.execute("SELECT id, title, beat FROM nodes WHERE kind IS NULL")
    }
    parents = store._parents_map()
    canon = [nid for nid in store.canon_path(parents) if nid in rows]
    ordered = list(canon)
    if include_branches:
        on_canon = set(canon)
        rest = [nid for nid in rows if nid not in on_canon]
        rest.sort(key=lambda nid: len(store.path_to(nid, parents)))
        ordered += rest
    return [rows[nid] for nid in ordered]


def _latest_stale(store: Store, preset_id: str, pov_char: str | None) -> dict[str, bool]:
    """この組の最新の清書が古いかどうか(シーン ID → stale)。清書の無いシーンは入らない。"""
    latest: dict[str, bool] = {}
    for r in store.conn.execute(
        """SELECT node_id, stale FROM renders
           WHERE preset_id = ? AND pov_char IS ?
           ORDER BY created_at DESC, rowid DESC""",
        (preset_id, pov_char),
    ):
        latest.setdefault(r["node_id"], bool(r["stale"]))
    return latest


def _latest_renders(store: Store, preset_id: str, pov_char: str | None) -> dict[str, dict[str, Any]]:
    """この組の最新の清書(シーン ID → {id, prose})。`_latest_stale` と同じ並びで選ぶ(画面の getRender と同じ)。"""
    latest: dict[str, dict[str, Any]] = {}
    for r in store.conn.execute(
        """SELECT id, node_id, prose FROM renders
           WHERE preset_id = ? AND pov_char IS ?
           ORDER BY created_at DESC, rowid DESC""",
        (preset_id, pov_char),
    ):
        latest.setdefault(r["node_id"], {"id": r["id"], "prose": r["prose"] or ""})
    return latest


def _script_sources(store: Store, preset_id: str, pov_char: str | None) -> tuple[set[str], set[str]]:
    """この組の清書に付いた台本のうち、LLM で話者と感情を付けたもの。
    (LLM で付けた清書 ID の集合, その清書のシーン ID の集合)を返す。"""
    render_ids: set[str] = set()
    node_ids: set[str] = set()
    for r in store.conn.execute(
        """SELECT v.render_id, v.node_id FROM voice_scripts v
           JOIN renders r ON r.id = v.render_id
           WHERE v.source = 'llm' AND r.preset_id = ? AND r.pov_char IS ?""",
        (preset_id, pov_char),
    ):
        render_ids.add(r["render_id"])
        node_ids.add(r["node_id"])
    return render_ids, node_ids


def _item(node: dict[str, Any]) -> dict[str, str]:
    return {"id": node["id"], "title": node["title"] or "(無題)"}


def plan(store: Store, include_branches: bool = False) -> dict[str, Any]:
    """更新の対象を、実行する順に並べて返す。

    - digests: まとめが「要更新」の章。まとめを一度も作っていない章は拾わない(作るかどうかは作者の判断)
    - renders: 清書し直すシーン(物語の順)。status は次のどちらか
      - "stale": いまの組の最新の清書が「要更新」
      - "missing": いまの組の清書がまだ無く、本文が空でない
    - scripts: 朗読台本に LLM で話者と感情を付けるシーン(物語の順)。相手はいまの組の最新の清書
      (古い清書でも、読み上げに使うのはそれなので拾う)。清書の本文が空なら拾わない。status は次のどちらか
      - "stale": 最新の清書の台本は付けていないが、この組の前の清書には付けてあった(清書を作り直した)
      - "missing": この組の清書のどれにも付けていない
    """
    style = render_style(store)
    digests = [
        {"id": g["id"], "title": g["title"] or "(無題)"}
        for g in store.list_groups()
        if g["has_digest"] and g["digest_stale"] and (include_branches or g["on_canon"])
    ]
    renders: list[dict[str, str]] = []
    scripts: list[dict[str, str]] = []
    if style["preset"]:
        preset_id = style["preset"]["id"]
        pov_char = style["pov"]["id"] if style["pov"] else None
        latest = _latest_stale(store, preset_id, pov_char)
        latest_renders = _latest_renders(store, preset_id, pov_char)
        llm_renders, llm_nodes = _script_sources(store, preset_id, pov_char)
        scenes = _scenes(store, include_branches)
        for node in scenes:
            if node["id"] not in latest:
                if (node["beat"] or "").strip():
                    renders.append({**_item(node), "status": "missing"})
            elif latest[node["id"]]:
                renders.append({**_item(node), "status": "stale"})
        for node in scenes:
            render = latest_renders.get(node["id"])
            if not render or not render["prose"].strip() or render["id"] in llm_renders:
                continue
            status = "stale" if node["id"] in llm_nodes else "missing"
            scripts.append({**_item(node), "render_id": render["id"], "status": status})
    return {
        **style,
        "include_branches": include_branches,
        "digests": digests,
        "renders": renders,
        "scripts": scripts,
    }
