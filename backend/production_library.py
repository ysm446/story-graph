"""制作チャット専用の資料庫ツール。固定設定と物語内の状態を分ける。"""
import json
import re

from node_operations import atomic_store


FIELDS = {
    "character": ("name", "profile", "appearance", "voice", "reading", "color"),
    "place": ("name", "description", "atmosphere", "reading", "color"),
}
WRITE_TOOLS = {f"{action}_{kind}" for kind in FIELDS for action in ("create", "update", "delete")}


def tools(allow_write):
    result = [{"type": "function", "function": {
        "name": "read_library",
        "description": "資料庫のキャラクター・場所の固定設定と参照先を読む。ID省略は一覧、指定時は設定全文と使用先。編集・削除前に必ず読む。",
        "parameters": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["character", "place"]},
            "id": {"type": "string", "description": "資料のID。省略すると一覧"},
        }, "required": ["kind"], "additionalProperties": False},
    }}]
    if not allow_write:
        return result
    for kind, fields in FIELDS.items():
        label = "キャラクター" if kind == "character" else "場所"
        for action in ("create", "update", "delete"):
            properties = {"reason": {"type": "string", "description": "作者の依頼に対する変更理由"}}
            required = ["reason"]
            if action != "create":
                properties["id"] = {"type": "string"}
                required.append("id")
            if action != "delete":
                properties.update({field: {"type": "string"} for field in fields})
                if action == "create":
                    required.append("name")
            description = {
                "create": f"{label}を資料庫に新規登録する。同名は重複登録不可。返されたIDをシーンに使う。",
                "update": f"{label}の固定設定を編集する。指定した項目だけ更新し、省略項目は維持。空文字で項目を消去する。物語中の出来事・記憶はここに書かない。",
                "delete": f"{label}を資料庫から削除する。シーン・イベント・記憶などから使用中の資料は削除不可。参照を勝手に消さず作者へ報告する。",
            }[action]
            result.append({"type": "function", "function": {
                "name": f"{action}_{kind}", "description": description,
                "parameters": {"type": "object", "properties": properties,
                               "required": required, "additionalProperties": False},
            }})
    return result


def _contains(value, target):
    if isinstance(value, dict):
        return target in value or any(_contains(v, target) for v in value.values())
    if isinstance(value, list):
        return any(_contains(v, target) for v in value)
    return value == target


def references(store, kind, entity_id):
    nodes = set()
    other = set()
    graph_nodes = store.graph()["nodes"]
    for node in graph_nodes:
        if (kind == "character" and entity_id in node["cast"]
                or kind == "place" and node.get("location") == entity_id
                or any(_contains(e.get("payload"), entity_id) for e in node.get("events", []))):
            nodes.add(node["id"])
    if kind == "place":
        nodes.update(store._nodes_using_place(entity_id))
    for group in store.conn.execute("SELECT id, digest_events FROM groups WHERE digest_events IS NOT NULL"):
        if _contains(json.loads(group["digest_events"]), entity_id):
            other.add("章のまとめ: " + group["id"])
            nodes.update(n["id"] for n in graph_nodes if n.get("group_id") == group["id"])
    if kind == "character":
        for row in store.conn.execute("SELECT node_id FROM renders WHERE pov_char = ?", (entity_id,)):
            nodes.add(row["node_id"])
        for row in store.conn.execute("SELECT node_id, lines FROM voice_scripts"):
            if _contains(json.loads(row["lines"]), "char:" + entity_id):
                nodes.add(row["node_id"])
        for row in store.conn.execute("SELECT id, char_id, participants FROM chats"):
            if row["char_id"] == entity_id or entity_id in json.loads(row["participants"] or "[]"):
                other.add("キャラクター会話: " + row["id"])
        for table in ("memories", "faction_members"):
            if store.conn.execute(f"SELECT 1 FROM {table} WHERE char_id = ? LIMIT 1", (entity_id,)).fetchone():
                other.add("記憶" if table == "memories" else "派閥の所属")
        for row in store.conn.execute("SELECT id, image_ref_chars FROM nodes"):
            if entity_id in json.loads(row["image_ref_chars"] or "[]"):
                nodes.add(row["id"])
        for row in store.conn.execute("SELECT id, ref_chars FROM media"):
            if entity_id in json.loads(row["ref_chars"] or "[]"):
                other.add("画像の参照キャラクター: " + row["id"])
    return {"node_ids": sorted(nodes), "other": sorted(other)}


def read(store, args):
    kind = args.get("kind")
    if kind not in FIELDS:
        raise ValueError("kindはcharacterまたはplaceです")
    entity_id = args.get("id")
    if entity_id is None:
        items = getattr(store, f"list_{'characters' if kind == 'character' else 'places'}")()
        return {"kind": kind, "items": [{"id": item["id"], "name": item["name"]} for item in items]}
    if not isinstance(entity_id, str):
        raise ValueError("idは文字列で指定してください")
    item = getattr(store, f"get_{kind}")(entity_id)
    if item is None:
        raise ValueError("指定した資料がありません")
    return {"kind": kind, "item": {k: item.get(k) for k in ("id", *FIELDS[kind])},
            "references": references(store, kind, entity_id)}


def apply(store, name, args, policy=None, before_commit=None):
    if name not in WRITE_TOOLS or not isinstance(args, dict):
        raise ValueError("資料庫の操作が不正です")
    action, kind = name.split("_", 1)
    allowed = {"reason", *(FIELDS[kind] if action != "delete" else ())}
    if action != "create":
        allowed.add("id")
    if set(args) - allowed:
        raise ValueError("未対応の項目は変更できません")
    if not isinstance(args.get("reason"), str) or not args["reason"].strip():
        raise ValueError("変更理由が必要です")
    data = {k: args[k] for k in FIELDS[kind] if k in args}
    if any(not isinstance(v, str) for v in data.values()):
        raise ValueError("資料の項目は文字列で指定してください")
    if (action == "create" and "name" not in data) or ("name" in data and not data["name"].strip()):
        raise ValueError("名前を入力してください")
    if "name" in data:
        data["name"] = data["name"].strip()
    if data.get("color") and not re.fullmatch(r"#[0-9a-fA-F]{6}", data["color"]):
        raise ValueError("色は#RRGGBBで指定してください")
    original = None
    entity_id = args.get("id")
    if action != "create":
        if not isinstance(entity_id, str):
            raise ValueError("資料のIDが必要です")
        original = getattr(store, f"get_{kind}")(entity_id)
        if original is None:
            raise ValueError("指定した資料がありません")
        refs = references(store, kind, entity_id)
        if action == "delete" and (refs["node_ids"] or refs["other"]):
            raise ValueError("使用中の資料は削除できません。参照先: " + json.dumps(refs, ensure_ascii=False))
        if policy is not None:
            for node_id in refs["node_ids"]:
                policy.check_target(node_id)
        if action == "update" and (not data or all(original.get(k) == v for k, v in data.items())):
            raise ValueError("その設定は反映済みです。次の作業へ進んでください")
    if "name" in data:
        items = getattr(store, f"list_{'characters' if kind == 'character' else 'places'}")()
        if any(item["id"] != entity_id and item["name"].strip().casefold() == data["name"].casefold() for item in items):
            raise ValueError("同名の資料が登録済みです。一覧から既存のIDを確認してください")
    if before_commit:
        before_commit()
    with atomic_store(store) as tx:
        if action == "create":
            item = getattr(tx, f"create_{kind}")(data)
            entity_id = item["id"]
            # readingは作成APIの既定項目外なので、同じ確定単位で補う。
            if "reading" in data:
                item = getattr(tx, f"update_{kind}")(entity_id, {"reading": data["reading"]})
        elif action == "update":
            item = getattr(tx, f"update_{kind}")(entity_id, data)
        else:
            getattr(tx, f"delete_{kind}")(entity_id)
            item = original
    return {"action": name, "entity_type": kind, "entity_id": entity_id,
            "title": item["name"], "reason": args["reason"],
            "before": {k: original.get(k) for k in FIELDS[kind]} if original else None,
            "after": {k: item.get(k) for k in FIELDS[kind]} if action != "delete" else None}
