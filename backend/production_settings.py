"""制作専用の設定資料作成・部分項目更新。参照禁止と版の競合を保護する。"""
import setting_documents as documents

WRITE_TOOLS = {"create_setting_document", "update_setting_document"}


def tools():
    fields = {
        "title": {"type": "string"},
        "body": {"type": "string", "description": "Markdown本文(更新時は全文)"},
        "category": {"type": "string", "description": "分類(制度・文化など)"},
        "scope": {"type": "string", "description": "適用範囲・時点"},
        "status": {"type": "string", "enum": ["draft", "confirmed", "reference"], "description": "既定draft。confirmedは作者の明示指示時のみ"},
        "ai_mode": {"type": "string", "enum": ["search", "always", "never"], "description": "既定search。作者の指定時のみ変更"},
        "reason": {"type": "string", "description": "変更理由"},
    }
    result = []
    for action in ("create", "update"):
        properties = dict(fields)
        required = ["reason", "title", "body"] if action == "create" else ["reason", "id", "revision"]
        if action == "update":
            properties.update(id={"type": "string"}, revision={"type": "integer", "description": "読んだ全文のrevision"})
        result.append({"type": "function", "function": {
            "name": action + "_setting_document",
            "description": ("設定資料(世界観・制度・文化・用語の文書)を新規作成する。同名は作らない。人物・場所そのものの設定には使わない(update_character / update_place)。")
            if action == "create" else "設定資料を編集する。先に全文を読み、指定項目だけ更新(省略は維持)。",
            "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
        }})
    return result


def apply(store, name, args, before_commit=None):
    creating = name == "create_setting_document"
    allowed = {*documents.FIELDS, "reason"} | (set() if creating else {"id", "revision"})
    if set(args) - allowed or not isinstance(args.get("reason"), str) or not args["reason"].strip():
        raise ValueError("対応する項目と変更理由を指定してください")
    original = None
    if not creating:
        if not isinstance(args.get("id"), str) or type(args.get("revision")) is not int:
            raise ValueError("全文を読んでidとrevisionを指定してください")
        original = store.get_setting_document(args["id"])
        if original is None or original["ai_mode"] == "never":
            raise ValueError("参照・編集できる設定資料がありません")
        if original["revision"] != args["revision"]:
            raise documents.RevisionConflict("設定資料が更新されています。全文を読み直してください")
    elif not all(key in args for key in ("title", "body")):
        raise ValueError("タイトルと本文が必要です")
    changes = {key: args[key] for key in documents.FIELDS if key in args}
    if original and (not changes or all(original[key] == value for key, value in changes.items())):
        raise ValueError("その設定は反映済みです。次の作業へ進んでください")
    data = {key: original[key] for key in documents.FIELDS} if original else {}
    data.update(changes)
    data = documents.DocumentInput.model_validate(data).model_dump()
    data["title"] = data["title"].strip()
    if any(item["title"].strip().casefold() == data["title"].casefold() and item["id"] != args.get("id") for item in store.list_setting_documents()):
        raise ValueError("同名の設定資料が登録済みです。既存資料を確認してください")
    if before_commit:
        before_commit()
    item = store.save_setting_document(data, args.get("id"), args.get("revision"))
    return {"action": name, "entity_type": "setting_document", "entity_id": item["id"],
            "title": item["title"], "reason": args["reason"], "revision": item["revision"],
            "before": {key: original[key] for key in documents.FIELDS} if original else None,
            "after": {key: item[key] for key in documents.FIELDS}}
