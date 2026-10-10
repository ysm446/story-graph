"""未完のツール引数から表示専用の本文を読む。編集・検証には使用しない。"""
import json


def partial_fields(raw: str) -> dict:
    decoder = json.JSONDecoder()
    result = {}
    pos = 0
    def skip(index):
        while index < len(raw) and raw[index].isspace():
            index += 1
        return index
    pos = skip(pos)
    if pos >= len(raw) or raw[pos] != "{":
        return result
    pos += 1
    while True:
        try:
            key, pos = decoder.raw_decode(raw, skip(pos))
            if not isinstance(key, str):
                return result
            pos = skip(pos)
            if pos >= len(raw) or raw[pos] != ":":
                return result
            pos = skip(pos + 1)
            start = pos
            try:
                value, pos = decoder.raw_decode(raw, pos)
            except json.JSONDecodeError:
                if key != "beat" or raw[start:start + 1] != '\"':
                    return result
                # 末尾の途中のエスケープだけを除き、JSON文字列として復号する。
                end = len(raw)
                while end > start:
                    try:
                        value = json.loads(raw[start:end] + '\"')
                        result[key] = value.encode("utf-8", errors="ignore").decode("utf-8")
                        return result
                    except (ValueError, UnicodeError):
                        end -= 1
                        if len(raw) - end > 12:
                            return result
                return result
            result[key] = value
            pos = skip(pos)
            if pos >= len(raw) or raw[pos] != ",":
                return result
            pos += 1
        except (ValueError, TypeError):
            return result


def scene_preview(store, function, policy):
    if function.get("name") != "update_scene":
        return None
    fields = partial_fields(function.get("arguments") or "")
    node_id, beat = fields.get("node_id"), fields.get("beat")
    if not isinstance(beat, str):
        return None
    if "node_id" not in fields:
        # Gemmaはbeatをnode_idより先に出す。対象を推測せず、表示だけ先に始める。
        # 未確定の表示だけであり、保存時の保護・範囲の検証は従来どおり行う。
        return {"node_id": None, "beat": beat}
    if not isinstance(node_id, str):
        return None
    try:
        policy.check_target(node_id)
        node = store.get_node(node_id)
        if not node or node.get("kind"):
            return None
    except (KeyError, ValueError):
        return None
    return {"node_id": node_id, "beat": beat}
