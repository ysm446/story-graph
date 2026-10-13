"""取り込み JSON — 外部の LLM が書いた作品データの検査と一括登録(docs/design/import-json.md)。

- 外部の LLM は ID を書かない。人物と場所は名前で参照し、ID は登録時にアプリが振る
- シーンは配列の順に、直列で並べる(分岐は未対応。将来はシーンの key を使って「どのシーンの後ろか」を
  指定できるようにする。そのため key はいまから受け付けておく)
- イベントは書きやすい形(memory / relation / fact / retire と人物の名前)で受け、内部の形へ変換する
- 検査(validate)は DB を見ない純粋な処理。コマンド(import_check.py)と画面の両方から同じものを使う
- 登録(apply)は、シーンが 1 つも無いライブラリにだけ行う。途中で失敗したら全部を取り消す

仕様書(外部の LLM に読ませる文書)は docs/reference/import-format.md。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import node_operations
import story_clock

if TYPE_CHECKING:
    from store import Store

FORMAT = "story-graph-import"
VERSION = 1

_TOP_KEYS = {"format", "version", "title", "characters", "places", "documents", "chapters", "scenes"}
_CHARACTER_KEYS = {"name", "reading", "profile", "appearance", "voice", "color"}
_PLACE_KEYS = {"name", "reading", "description", "atmosphere", "color"}
_DOCUMENT_KEYS = {"title", "category", "body", "status", "scope", "ai_mode"}
_CHAPTER_KEYS = {"title", "scenes"}
_SCENE_KEYS = {"key", "title", "beat", "emotional_core", "cast", "location", "elapsed", "events", "after"}
_EVENT_KEYS = {
    "memory": {"type", "who", "text", "importance", "emotion"},
    "relation": {"type", "who", "toward", "change", "value", "label", "reason"},
    "fact": {"type", "who", "world", "key", "value"},
    "retire": {"type", "who", "reason"},
}
_DOCUMENT_STATUS = ("confirmed", "draft", "reference")
_DOCUMENT_AI_MODES = ("search", "always", "never")


class ImportError_(ValueError):
    """取り込めない(検査の誤り、または空でないライブラリ)。errors に理由の一覧を持つ。"""

    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate(data: Any) -> dict[str, Any]:
    """取り込み JSON を検査する。返り値は {errors, warnings, summary}。errors が空なら取り込める。

    メッセージは、外部の LLM にそのまま貼り返して直してもらえるよう、場所と直し方が分かる文にする。
    """
    errors: list[str] = []
    warnings: list[str] = []
    summary = {"title": None, "characters": 0, "places": 0, "documents": 0, "chapters": 0, "scenes": 0, "events": 0}

    def result() -> dict[str, Any]:
        return {"errors": errors, "warnings": warnings, "summary": summary}

    if not isinstance(data, dict):
        errors.append("ファイルの一番外側は { } のオブジェクトにしてください")
        return result()
    if data.get("format") != FORMAT:
        errors.append(f'"format" は "{FORMAT}" にしてください')
    if data.get("version") != VERSION:
        errors.append(f'"version" は {VERSION} にしてください')
    for key in sorted(set(data) - _TOP_KEYS):
        errors.append(f'不明な項目 "{key}" があります(使える項目: {", ".join(sorted(_TOP_KEYS))})')
    summary["title"] = _text(data.get("title"))

    cache: dict[str, list[tuple[str, dict[str, Any]]]] = {}

    def items(key: str, label: str) -> list[tuple[str, dict[str, Any]]]:
        """配列を取り出し、各要素が { } であることを確かめる。(場所の名前, 要素) を返す。
        同じ配列を何度引いても、誤りは 1 回だけ記録する。"""
        if key in cache:
            return cache[key]
        value = data.get(key, [])
        out: list[tuple[str, dict[str, Any]]] = []
        if not isinstance(value, list):
            errors.append(f'"{key}" は [ ] の配列にしてください')
        else:
            for index, item in enumerate(value):
                where = f"{label} の {index + 1} 番目"
                if isinstance(item, dict):
                    out.append((where, item))
                else:
                    errors.append(f"{where}: {{ }} のオブジェクトにしてください")
        cache[key] = out
        return out

    def unknown(where: str, item: dict[str, Any], allowed: set[str]) -> None:
        for key in sorted(set(item) - allowed):
            errors.append(f'{where}: 不明な項目 "{key}" があります(使える項目: {", ".join(sorted(allowed))})')

    def strings(where: str, item: dict[str, Any], keys: tuple[str, ...]) -> None:
        for key in keys:
            if key in item and item[key] is not None and not isinstance(item[key], str):
                errors.append(f'{where}: "{key}" は文字列にしてください')

    def names(key: str, label: str, name_key: str, allowed: set[str], text_keys: tuple[str, ...]) -> set[str]:
        seen: set[str] = set()
        for where, item in items(key, label):
            unknown(where, item, allowed)
            strings(where, item, text_keys)
            name = _text(item.get(name_key))
            if name is None:
                errors.append(f'{where}: "{name_key}" が必要です')
            elif name in seen:
                errors.append(f'{where}: 「{name}」が重複しています。{label}の "{name_key}" は重ならないようにしてください')
            else:
                seen.add(name)
        return seen

    characters = names("characters", "characters", "name", _CHARACTER_KEYS, ("reading", "profile", "appearance", "voice", "color"))
    places = names("places", "places", "name", _PLACE_KEYS, ("reading", "description", "atmosphere", "color"))
    names("documents", "documents", "title", _DOCUMENT_KEYS, ("category", "body", "scope"))
    for where, item in items("documents", "documents"):
        if "status" in item and item["status"] not in _DOCUMENT_STATUS:
            errors.append(f'{where}: "status" は {" / ".join(_DOCUMENT_STATUS)} のいずれかにしてください')
        if "ai_mode" in item and item["ai_mode"] not in _DOCUMENT_AI_MODES:
            errors.append(f'{where}: "ai_mode" は {" / ".join(_DOCUMENT_AI_MODES)} のいずれかにしてください')
    summary["characters"], summary["places"] = len(characters), len(places)
    summary["documents"] = len(items("documents", "documents"))

    def person(where: str, key: str, value: Any) -> str | None:
        name = _text(value)
        if name is None:
            errors.append(f'{where}: "{key}" に人物の名前が必要です')
        elif name not in characters:
            errors.append(f'{where}: "{key}" の「{name}」が characters にありません。characters に足すか、名前を合わせてください')
        else:
            return name
        return None

    def check_event(where: str, event: dict[str, Any], cast: list[str]) -> None:
        kind = event.get("type")
        if kind not in _EVENT_KEYS:
            errors.append(f'{where}: "type" は {" / ".join(_EVENT_KEYS)} のいずれかにしてください')
            return
        unknown(where, event, _EVENT_KEYS[kind])
        world = kind == "fact" and event.get("world") is True
        who = None
        if world:
            if "who" in event:
                errors.append(f'{where}: 世界の事実("world": true)には "who" を書きません')
        else:
            who = person(where, "who", event.get("who"))
            if who is not None and cast and who not in cast and kind != "retire":
                warnings.append(f'{where}: 「{who}」はこのシーンの "cast" に居ません(その場に居ない人物のイベントになります)')
        if kind == "memory":
            if _text(event.get("text")) is None:
                errors.append(f'{where}: "text" に記憶の内容が必要です')
            for key, low in (("importance", 0.0), ("emotion", -1.0)):
                if key in event and not (_number(event[key]) and low <= event[key] <= 1.0):
                    errors.append(f'{where}: "{key}" は {low:g}〜1 の数にしてください')
        elif kind == "relation":
            toward = person(where, "toward", event.get("toward"))
            if who is not None and toward == who:
                errors.append(f'{where}: "who" と "toward" が同じ人物です')
            has_change, has_value = "change" in event, "value" in event
            if has_change == has_value:
                errors.append(f'{where}: "change"(増減)か "value"(絶対値)のどちらか一方を書いてください')
            for key in ("change", "value"):
                if key in event and not (_number(event[key]) and -1.0 <= event[key] <= 1.0):
                    errors.append(f'{where}: "{key}" は -1〜1 の数にしてください')
            strings(where, event, ("label", "reason"))
        elif kind == "fact":
            if _text(event.get("key")) is None:
                errors.append(f'{where}: "key" に事実の項目名が必要です')
            if not isinstance(event.get("value"), (str, int, float, bool)):
                errors.append(f'{where}: "value" は文字列・数・true/false のいずれかにしてください')
            if "world" in event and not isinstance(event["world"], bool):
                errors.append(f'{where}: "world" は true か false にしてください')
        else:
            strings(where, event, ("reason",))

    scenes = items("scenes", "scenes")
    if not scenes and isinstance(data.get("scenes", []), list):
        errors.append('"scenes" にシーンが 1 つ以上必要です')
    titles: dict[str, int] = {}
    keys: set[str] = set()
    for index, (where, scene) in enumerate(scenes):
        title = _text(scene.get("title"))
        if title:
            where = f"{where}「{title}」"
            titles[title] = titles.get(title, 0) + 1
        unknown(where, scene, _SCENE_KEYS)
        strings(where, scene, ("key", "title", "emotional_core"))
        if "after" in scene:
            errors.append(f'{where}: "after"(分岐)はまだ対応していません。シーンは "scenes" の順に直列で並べてください')
        key = _text(scene.get("key"))
        if key:
            if key in keys:
                errors.append(f'{where}: "key" の「{key}」が重複しています')
            keys.add(key)
        if _text(scene.get("beat")) is None:
            errors.append(f'{where}: "beat" にシーンの本文が必要です')
        cast: list[str] = []
        if "cast" in scene:
            if not isinstance(scene["cast"], list):
                errors.append(f'{where}: "cast" は人物の名前の配列にしてください')
            else:
                for name in scene["cast"]:
                    found = person(where, "cast", name)
                    if found and found not in cast:
                        cast.append(found)
        if scene.get("location") is not None:
            place = _text(scene.get("location"))
            if place is None:
                errors.append(f'{where}: "location" は場所の名前にしてください')
            elif place not in places:
                errors.append(f'{where}: "location" の「{place}」が places にありません。places に足すか、名前を合わせてください')
        if scene.get("elapsed") is not None:
            elapsed = scene["elapsed"]
            if not isinstance(elapsed, dict) or set(elapsed) - {"unit", "count"}:
                errors.append(f'{where}: "elapsed" は {{"unit": …, "count": …}} の形にしてください')
            else:
                try:
                    story_clock.normalize(elapsed.get("unit"), elapsed.get("count"))
                    if elapsed.get("unit") is None:
                        raise ValueError('"unit" が必要です(未設定にするなら "elapsed" ごと省略します)')
                    if index == 0:
                        warnings.append(f'{where}: 最初のシーンの "elapsed" は使われません(前のシーンが無いため)')
                except ValueError as error:
                    errors.append(f'{where}: "elapsed" — {error}')
        events = scene.get("events", [])
        if not isinstance(events, list):
            errors.append(f'{where}: "events" は配列にしてください')
            events = []
        for number, event in enumerate(events):
            event_where = f"{where}のイベント {number + 1} 番目"
            if isinstance(event, dict):
                check_event(event_where, event, cast)
                summary["events"] += 1
            else:
                errors.append(f"{event_where}: {{ }} のオブジェクトにしてください")
    summary["scenes"] = len(scenes)

    # 章: シーンをタイトルか key で指す。直列の上で一続きの範囲であること
    order = {}
    for index, (_, scene) in enumerate(scenes):
        for ref in (_text(scene.get("key")), _text(scene.get("title"))):
            if ref is not None and ref not in order:
                order[ref] = index
    used: dict[int, str] = {}
    chapter_titles: set[str] = set()
    for where, chapter in items("chapters", "chapters"):
        unknown(where, chapter, _CHAPTER_KEYS)
        title = _text(chapter.get("title"))
        if title is None:
            errors.append(f'{where}: "title" が必要です')
        else:
            where = f"{where}「{title}」"
            if title in chapter_titles:
                errors.append(f"{where}: 章の名前が重複しています")
            chapter_titles.add(title)
        refs = chapter.get("scenes")
        if not isinstance(refs, list) or not refs:
            errors.append(f'{where}: "scenes" に、この章のシーンのタイトル(または key)を 1 つ以上並べてください')
            continue
        indexes = []
        for ref in refs:
            name = _text(ref)
            if name is None or name not in order:
                errors.append(f'{where}: シーン「{ref}」が "scenes" にありません。タイトルか key を合わせてください')
                continue
            if titles.get(name, 0) > 1 and name not in keys:
                errors.append(f'{where}: タイトル「{name}」のシーンが複数あります。シーンに "key" を付けて、key で指してください')
                continue
            index = order[name]
            if index in used:
                errors.append(f'{where}: シーン「{name}」は章「{used[index]}」にも入っています。1 つのシーンは 1 つの章だけにしてください')
                continue
            used[index] = title or "?"
            indexes.append(index)
        if indexes and sorted(indexes) != list(range(min(indexes), max(indexes) + 1)):
            errors.append(f"{where}: 章のシーンが一続きになっていません。\"scenes\" の並びの中で連続する範囲を 1 つの章にしてください")
    summary["chapters"] = len(items("chapters", "chapters"))
    return result()


def _events(scene: dict[str, Any], char_ids: dict[str, str]) -> list[dict[str, Any]]:
    """書きやすい形のイベントを、内部の type / payload へ変換する(検査済みの入力が前提)。"""
    out = []
    for event in scene.get("events", []):
        kind = event["type"]
        if kind == "memory":
            payload = {
                "char": char_ids[event["who"].strip()],
                "content": event["text"].strip(),
                "emotion": float(event.get("emotion", 0.0)),
                "importance": float(event.get("importance", 0.5)),
                "refs": [],
            }
            out.append({"type": "memory_add", "payload": payload})
        elif kind == "relation":
            payload = {
                "char": char_ids[event["who"].strip()],
                "target_type": "char",
                "target": char_ids[event["toward"].strip()],
                **({"label": event["label"].strip()} if _text(event.get("label")) else {}),
                **({"reason": event["reason"].strip()} if _text(event.get("reason")) else {}),
            }
            if "change" in event:
                out.append({"type": "relationship_update", "payload": {**payload, "delta": float(event["change"])}})
            else:
                out.append({"type": "relationship_set", "payload": {**payload, "value": float(event["value"])}})
        elif kind == "fact":
            if event.get("world") is True:
                payload = {"scope": "world", "key": event["key"].strip(), "value": event["value"]}
            else:
                payload = {"scope": "char", "char": char_ids[event["who"].strip()],
                           "key": event["key"].strip(), "value": event["value"]}
            out.append({"type": "fact_set", "payload": payload})
        else:
            out.append({"type": "char_retire", "payload": {
                "char": char_ids[event["who"].strip()], "reason": _text(event.get("reason")) or "departure"}})
    return out


def check_target(store: Store, data: dict[str, Any]) -> list[str]:
    """このライブラリへ取り込めるか。取り込めない理由の一覧を返す(空なら取り込める)。"""
    problems = []
    scenes = store.conn.execute("SELECT COUNT(*) FROM nodes WHERE kind IS NULL").fetchone()[0]
    if scenes:
        problems.append(f"このライブラリにはすでにシーンが {scenes} 件あります。取り込みは、シーンが 1 つも無いライブラリにだけ行えます"
                        "(左上のライブラリのボタンから、新しいフォルダを選んでください)")
    existing_chars = {c["name"] for c in store.list_characters()}
    existing_places = {p["name"] for p in store.list_places()}
    existing_docs = {d["title"] for d in store.list_setting_documents()}
    for key, name_key, existing, label in (
        ("characters", "name", existing_chars, "キャラクター"),
        ("places", "name", existing_places, "場所"),
        ("documents", "title", existing_docs, "設定資料"),
    ):
        clash = sorted({_text(i.get(name_key)) for i in data.get(key, []) if isinstance(i, dict)} & existing)
        if clash:
            problems.append(f"同じ名前の{label}がすでにあります: {'、'.join(clash)}")
    return problems


def apply(store: Store, data: Any) -> dict[str, Any]:
    """検査してから一括登録する。誤りがあれば ImportError_。途中で失敗したら全部を取り消す。

    スナップショットは呼び出し側が先に取る(node_operations と同じ約束)。
    """
    checked = validate(data)
    if checked["errors"]:
        raise ImportError_(checked["errors"])
    problems = check_target(store, data)
    if problems:
        raise ImportError_(problems)
    with node_operations.atomic_store(store) as tx:
        char_ids: dict[str, str] = {}
        for item in data.get("characters", []):
            created = tx.create_character({k: _text(item.get(k)) for k in ("name", "profile", "appearance", "voice", "color")})
            if _text(item.get("reading")):
                tx.update_character(created["id"], {"reading": item["reading"].strip()})
            char_ids[item["name"].strip()] = created["id"]
        place_ids: dict[str, str] = {}
        for item in data.get("places", []):
            created = tx.create_place({k: _text(item.get(k)) for k in ("name", "description", "atmosphere", "color")})
            if _text(item.get("reading")):
                tx.update_place(created["id"], {"reading": item["reading"].strip()})
            place_ids[item["name"].strip()] = created["id"]
        for item in data.get("documents", []):
            tx.save_setting_document({
                "title": item["title"].strip(),
                "category": _text(item.get("category")) or "",
                "body": item.get("body") or "",
                "status": item.get("status", "draft"),
                "scope": _text(item.get("scope")) or "",
                "ai_mode": item.get("ai_mode", "search"),
            })
        node_ids: list[str] = []
        refs: dict[str, str] = {}
        for index, scene in enumerate(data["scenes"]):
            elapsed = scene.get("elapsed") if index > 0 else None  # 最初のシーンの経過は使わない
            cast = list(dict.fromkeys(char_ids[name.strip()] for name in scene.get("cast", [])))
            node = tx.append_node(
                {
                    "title": _text(scene.get("title")),
                    "beat": scene["beat"].strip(),
                    "emotional_core": _text(scene.get("emotional_core")),
                    "cast": cast,
                    "location": place_ids[scene["location"].strip()] if _text(scene.get("location")) else None,
                    "elapsed_unit": elapsed.get("unit") if elapsed else None,
                    "elapsed_count": elapsed.get("count") if elapsed else None,
                },
                _events(scene, char_ids),
                source="llm",
            )  # parent_id なし = 正史の末尾へ足す(画面の「+ シーン」と同じ経路。結末の手前に入る)
            node_ids.append(node["id"])
            for ref in (_text(scene.get("title")), _text(scene.get("key"))):
                if ref is not None:
                    refs.setdefault(ref, node["id"])
            # key は title より優先する(同じタイトルのシーンを key で区別できるように)
            if _text(scene.get("key")):
                refs[scene["key"].strip()] = node["id"]
        for chapter in data.get("chapters", []):
            tx.create_group(chapter["title"].strip(), [refs[ref.strip()] for ref in chapter["scenes"]])
        # 取り込んだ結果が、アプリの検査(退場した人物の再登場など)を通ることを確かめる
        broken = []
        for index, node_id in enumerate(node_ids):
            for message in tx.validate(node_id):
                broken.append(f"scenes の {index + 1} 番目「{data['scenes'][index].get('title') or ''}」: {message}")
        if broken:
            raise ImportError_(broken)
        # 配置を自動レイアウトへ戻す。空のライブラリを画面に出した時点で「はじまり」「結末」の位置が
        # 保存されているので、そのままだと結末が先頭の近くに残り、取り込んだシーンと並びが食い違う
        tx.reset_positions()
    store.conn.commit()
    return {**checked["summary"], "warnings": checked["warnings"]}
