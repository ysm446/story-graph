"""制作から章の器と所属を編集する。本文・イベントは変更しない。"""
import uuid

import chat_agent
from node_operations import atomic_store

WRITE_TOOLS = {"create_chapter", "rename_chapter", "add_scenes_to_chapter", "remove_scenes_from_chapter", "delete_chapter"}


def tools(allow_write):
    definitions = [("read_chapters", "章のID・名前・所属シーン・入口(in_id)と出口(out_id)を読む。routeが読む順、scenesのprev_idが直前のシーン、on_route=falseは章の中の分岐や未接続。マーカーに本文は無く、get_beatsにはシーンのIDだけを渡す。", {}, [])]
    if allow_write:
        ids = {"type": "array", "items": {"type": "string"}, "description": "対象シーンID。別の章に所属するシーンとマーカーは指定不可"}
        definitions += [
            ("create_chapter", "指定シーンを新しい章にまとめる。node_idsが空なら空の章を作る。空の章を物語の途中に置くときはafter_idで位置を指定する(省略するとどこにもつながらない章になる)。"
                               "返されたin_idの後ろにinsert_sceneで本文を追加できる。",
             {"title": {"type": "string"}, "node_ids": ids,
              "after_id": {"type": "string", "description": "空の章を挟む位置。章の外のシーンのID、または直前の章のout_id。正史がこの章を通るようになる"}},
             ["title", "node_ids"]),
            ("rename_chapter", "章の名前だけを変更する。",
             {"chapter_id": {"type": "string"}, "title": {"type": "string"}}, ["chapter_id", "title"]),
            ("add_scenes_to_chapter", "既存章に指定シーンだけ追加する。後続は自動追加しない。他章からの移動や接続変更はしない。章の出口より下流のシーンは追加不可。",
             {"chapter_id": {"type": "string"}, "node_ids": ids}, ["chapter_id", "node_ids"]),
            ("remove_scenes_from_chapter", "指定シーンを章から外す(シーンと接続は残る)。別の章へ移すときは外してから追加する。",
             {"chapter_id": {"type": "string"}, "node_ids": {"type": "array", "items": {"type": "string"}, "description": "その章に属するシーンID"}}, ["chapter_id", "node_ids"]),
            ("delete_chapter", "章を解除する。シーンと接続は残り、入口・出口のマーカーだけ無くなる。シーンの削除ではない。",
             {"chapter_id": {"type": "string"}}, ["chapter_id"]),
        ]
    result = []
    for name, description, properties, required in definitions:
        if name in WRITE_TOOLS:
            properties = {**properties, "reason": {"type": "string", "description": "作者の依頼に対する変更理由"}}
            required = [*required, "reason"]
        result.append({"type": "function", "function": {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}})
    return result


def read(store):
    # node_ids は「読む道 + それ以外」を1列に並べるので、そのままだと章の中の分岐が本筋の続きに見える。
    # シーンごとに、読む道の上か(on_route)と直前のシーン(prev_id)を添える。
    _, links = chat_agent._scene_flow(store)
    titles = {row["id"]: row["title"] for row in store.conn.execute("SELECT id, title FROM nodes")}
    chapters = []
    for group in store.list_groups():
        chapter = {key: group.get(key) for key in ("id", "title", "node_ids", "in_id", "out_id", "route", "warning")}
        route = set(group["route"])
        chapter["scenes"] = [{"id": nid, "title": titles.get(nid), "on_route": nid in route,
                              "prev_id": ((links.get(nid) or {}).get("prev") or {}).get("node_id")}
                             for nid in group["node_ids"]]
        chapters.append(chapter)
    return {"chapters": chapters}


def apply(store, name, args, policy=None, before_commit=None):
    allowed = ({"reason", "title", "node_ids", "after_id"} if name == "create_chapter"
               else {"reason", "chapter_id"} if name == "delete_chapter"
               else {"reason", "chapter_id", "title" if name == "rename_chapter" else "node_ids"})
    if name not in WRITE_TOOLS or set(args) - allowed or not isinstance(args.get("reason"), str) or not args["reason"].strip():
        raise ValueError("章の操作項目と変更理由を確認してください")
    title = args.get("title")
    if name in ("create_chapter", "rename_chapter") and (not isinstance(title, str) or not title.strip()):
        raise ValueError("章の名前を入力してください")
    original = None
    if name != "create_chapter":
        if not isinstance(args.get("chapter_id"), str):
            raise ValueError("chapter_idが必要です")
        original = store.get_group(args["chapter_id"])
        if original is None:
            raise ValueError("指定した章がありません")
    ids = args.get("node_ids", [])
    if name not in ("rename_chapter", "delete_chapter"):
        if "node_ids" not in args or not isinstance(ids, list) or any(not isinstance(nid, str) for nid in ids):
            raise ValueError("node_idsはシーンIDの配列で指定してください")
        ids = list(dict.fromkeys(ids))
        if name in ("add_scenes_to_chapter", "remove_scenes_from_chapter") and not ids:
            raise ValueError("対象のシーンを指定してください")
        for nid in ids:
            node = store.get_node(nid)
            if node is None or node.get("kind") is not None:
                raise ValueError("通常のシーンだけを指定してください")
            if name == "remove_scenes_from_chapter":
                if node.get("group_id") != original["id"]:
                    raise ValueError(f"その章に属していないシーンです: {nid}")
            elif node.get("group_id") is not None:
                raise ValueError("既に章に属しているシーンは追加できません")
    anchor = None
    if name == "create_chapter" and "after_id" in args:
        if ids:
            raise ValueError("after_idは空の章を物語の途中に置くときだけ指定します。既存シーンをまとめる章の位置はシーンで決まります")
        anchor = store.get_node(args["after_id"]) if isinstance(args.get("after_id"), str) else None
        if anchor is None:
            raise ValueError(f"after_idのシーンがありません: {args.get('after_id')}")
        if anchor.get("kind") == "ending":
            raise ValueError("結末の後ろには章を置けません")
        if anchor.get("group_id") is not None and anchor.get("kind") != "chapter_out":
            raise ValueError("章の中のシーンの後ろには章を置けません。直前の章のout_id、または章の外のシーンを指定してください")
    if title is not None:
        title = title.strip()
        if any(group["title"] == title and group["id"] != args.get("chapter_id") for group in store.list_groups()):
            raise ValueError("同名の章が存在します。章の一覧を確認してください")
        if original and original["title"] == title:
            raise ValueError("その章名は反映済みです")
    before = store.graph()
    if policy:
        if policy.group_id and (not original or original["id"] != policy.group_id):
            raise ValueError("指定した章の範囲外です")
        if name == "create_chapter" and not ids and policy.allowed is not None:
            raise ValueError("空の章の作成は変更範囲を全体にしてください")
        targets = set(ids)
        if anchor is not None:
            targets.add(anchor["id"])
        if original:
            targets.update(node["id"] for node in before["nodes"] if node.get("group_id") == original["id"])
        for nid in targets:
            policy.check_target(nid)
    if before_commit:
        before_commit()
    with atomic_store(store) as tx:
        if name == "create_chapter":
            group = tx.create_group(title, ids)
            if anchor is not None:
                # 浮いた in → out のペアを anchor の直後に挟む: (anchor → c) を (anchor → in → out → c) に
                following = tx.conn.execute("SELECT id FROM edges WHERE from_node = ? AND is_canon = 1", (anchor["id"],)).fetchone()
                if following is not None:
                    tx.conn.execute("UPDATE edges SET from_node = ? WHERE id = ?", (group["out_id"], following["id"]))
                tx.conn.execute("INSERT INTO edges(id, from_node, to_node, is_canon) VALUES(?,?,?,1)",
                                (uuid.uuid4().hex[:12], anchor["id"], group["in_id"]))
                tx._resync_canon()
                tx.mark_dirty_downstream(group["in_id"], commit=False)
                group = tx.get_group(group["id"])
        elif name == "rename_chapter":
            group = tx.update_group(original["id"], {"title": title})
        elif name == "remove_scenes_from_chapter":
            for nid in ids:
                tx.remove_node_from_group(nid)
            group = tx.get_group(original["id"])
        elif name == "delete_chapter":
            tx.delete_group(original["id"])
            group = {"id": original["id"], "title": original["title"], "node_ids": [], "in_id": None, "out_id": None}
        else:
            for nid in ids:
                tx.add_node_to_group(original["id"], nid, include_following=False)
            group = tx.get_group(original["id"])
        if policy:
            policy.check_candidate(before, tx.graph())
    return {"action": name, "entity_type": "chapter", "entity_id": group["id"], "title": group["title"],
            "reason": args["reason"], "in_id": group.get("in_id"), "out_id": group.get("out_id"), "node_ids": group["node_ids"],
            **({"after_id": anchor["id"]} if anchor is not None else {}),
            "before": {"title": original["title"], "node_ids": ", ".join(original["node_ids"])} if original else None,
            "after": {"title": group["title"], "node_ids": ", ".join(group["node_ids"])}}
