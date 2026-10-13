"""制作チャットの段階0。短いツール往復で編集し、確定した変更を逐次通知する。"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
import time
from datetime import datetime, timezone
from contextlib import aclosing
from production_preview import scene_preview
from typing import Any

import chat_agent
import chat_rules
import db
import generation
import llm
import node_operations
import snapshots
import story_clock
import production_memory
import production_library
import production_chapters
import production_continuity
import production_guard
from store import Store
from generated_text import normalize_scene_text
from production_policy import CONTENT_FIELDS, ProductionPolicy

MAX_STEPS = 16
CREATE_SCENE_TOOLS = {"insert_scene", "branch_scene"}
WRITE_TOOLS = CREATE_SCENE_TOOLS | {"update_scene", "patch_scene", "delete_scene", "reconnect_scene"} | production_library.WRITE_TOOLS | production_chapters.WRITE_TOOLS
TOOL_LABELS = {
    "get_beats": "シーンを読んでいます…", "get_state": "状態を確認しています…",
    "search_memories": "記憶を調べています…", "insert_scene": "シーンを追加しています…",
    "branch_scene": "分岐シーンを追加しています…",
    "reconnect_scene": "シーンをつなぎ替えています…",
    "update_work_memory": "作業メモを更新しています…",
    "update_scene": "シーンを編集しています…", "delete_scene": "シーンを削除しています…",
    "patch_scene": "シーンの指定箇所を編集しています…",
    "read_library": "資料庫を読んでいます…",
    "read_chapters": "章の構成を読んでいます…",
    **{name: "章を編集しています…" for name in production_chapters.WRITE_TOOLS},
    **{name: "資料庫を更新しています…" for name in production_library.WRITE_TOOLS},
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _sse(data):
    return chat_agent._sse({"timestamp": _now(), **data})


class ProductionHistory(list):
    """新しい発言の記録時刻だけを保存する。過去の時刻不明な履歴は補完しない。"""
    def append(self, item):
        item.setdefault("created_at", _now())
        super().append(item)


def selected_nodes(store, node_ids):
    """送信時の選択をIDと名称で固定する。本文はget_beatsで最新の保存内容を読む。"""
    result = []
    for node_id in dict.fromkeys(node_ids):
        node = store.get_node(node_id)
        if node is None:
            raise ValueError(f"選択したノードがありません。選び直してください: {node_id}")
        result.append({"id": node_id, "title": node.get("title") or "(無題)", "kind": node.get("kind")})
    return result


READ_STEP_LABELS = {
    "get_beats": "シーン本文を読む",
    "get_state": "人物の状態を読む",
    "search_memories": "記憶を検索",
    "read_library": "資料庫を読む",
    "read_chapters": "章の構成を読む",
    "search_setting_documents": "設定資料を検索",
    "read_setting_document": "設定資料を読む",
}


def read_step(store, name, args, *, repeated=False, error=None):
    """読み取りの手順を、画面の時系列に出す1行にまとめる。本文は含めず、何を読んだかだけ残す。

    履歴に保存するが、LLM へ渡す会話には入れない(build_messages で除く)。
    """
    def title(node_id):
        node = store.get_node(node_id) if isinstance(node_id, str) else None
        return (node or {}).get("title") or "(無題)"
    detail = ""
    try:
        if name == "get_beats":
            ids = [i for i in (args.get("node_ids") or []) if isinstance(i, str)]
            if ids:
                detail = "、".join(title(i) for i in ids[:4]) + (f" ほか{len(ids) - 4}件" if len(ids) > 4 else "")
            elif args.get("from_index") or args.get("to_index"):
                detail = f"{args.get('from_index') or 1}〜{args.get('to_index') or '末尾'}番"
            else:
                detail = "全体"
        elif name == "get_state":
            detail = title(args["node_id"]) + " の時点" if args.get("node_id") else "正史の末尾の時点"
        elif name == "read_library":
            kind = "場所" if args.get("kind") == "place" else "キャラクター"
            item = (store.get_place(args["id"]) if args.get("kind") == "place" else store.get_character(args["id"])) if args.get("id") else None
            detail = f"{kind}「{item['name']}」" if item else f"{kind}の一覧" if not args.get("id") else f"{kind}({args['id']})"
        elif name in ("search_memories", "search_setting_documents"):
            detail = f"「{args.get('query') or ''}」"
        elif name == "read_setting_document":
            item = store.conn.execute("SELECT title FROM setting_documents WHERE id = ?", (args.get("id"),)).fetchone() if args.get("id") else None
            detail = f"「{item[0]}」" if item else str(args.get("id") or "")
    except Exception:
        detail = ""
    if not detail and name not in READ_STEP_LABELS:
        detail = json.dumps(args, ensure_ascii=False)[:80]
    step = {"name": name, "label": READ_STEP_LABELS.get(name, name), "detail": detail}
    if repeated:
        step["repeated"] = True
    if error:
        step["error"] = str(error)[:300]
    return step


def selection_context(selection):
    return "\nこの発言の送信時に選択していたノード（参照対象。編集許可ではありません）: " + json.dumps(selection, ensure_ascii=False)


def message_content(item):
    return item["content"] + (selection_context(item["selected_nodes"]) if "selected_nodes" in item else "")


class ProductionGate:
    """制作と手動編集を切り替える。別の生成やライブラリ切替は作業終了まで止める。"""

    def __init__(self):
        self.active = False
        self.inflight = 0
        self.run = None

    async def begin(self):
        if self.active:
            raise RuntimeError("ほかの制作が終わってから実行してください")
        self.active = True
        # 直前の保存やチャット候補生成が完了するまで待つ。新しい書き込みは
        # activeで遮断し、開始前スナップショットの後に古い処理が割り込むのを防ぐ。
        async with asyncio.timeout(30):
            while self.inflight > 1:
                await asyncio.sleep(0.1)


class InstructionsPending(RuntimeError):
    pass


class ManualEditPending(RuntimeError):
    pass


class NodeVersions:
    """内容・イベント・隣接接続を比較する。配置や派生キャッシュは版に含めない。"""
    def __init__(self, store):
        graph = store.graph()
        self.nodes = {n["id"]: {k: n.get(k) for k in CONTENT_FIELDS} for n in graph["nodes"]}
        self.edges = {(e["from_node"], e["to_node"], e["is_canon"]) for e in graph["edges"]}
        self.library = (store.list_characters(), store.list_places(), store.list_setting_documents())
        self.chapters = [tuple(row) for row in store.conn.execute("SELECT id,title FROM groups ORDER BY id")]

    def check(self, store, args):
        current = NodeVersions(store)
        if self.chapters != current.chapters:
            raise ManualEditPending("章が更新されたため構成を読み直します")
        if ("node_ids" in args or "chapter_id" in args) and (self.nodes != current.nodes or self.edges != current.edges):
            raise ManualEditPending("章の編集対象が更新されたため構成を読み直します")
        if self.library != current.library:
            raise ManualEditPending("資料庫が更新されたため、設定を読み直します")
        targets = {args.get(k) for k in ("node_id", "after_id", "parent_id")} - {None}
        # 操作対象の祖先(抽出の前提)、子孫(削除・接続変更の影響先)を別々にたどる。
        # 判断開始時と現在の両方の接続を隣接表にまとめ、辺の全走査を繰り返さない。
        children, parents = {}, {}
        for parent, child, _ in self.edges | current.edges:
            children.setdefault(parent, set()).add(child)
            parents.setdefault(child, set()).add(parent)
        related = set(targets)
        for adjacency in (children, parents):
            pending = list(targets)
            seen = set(targets)
            while pending:
                for nid in adjacency.get(pending.pop(), set()) - seen:
                    seen.add(nid)
                    pending.append(nid)
            related.update(seen)
        changed = {nid for nid in related if self.nodes.get(nid) != current.nodes.get(nid)}
        changed.update(nid for edge in self.edges ^ current.edges for nid in edge[:2] if nid in related)
        if changed:
            raise ManualEditPending("シーンが更新されたため読み直します: " + ", ".join(sorted(changed)))


class ProductionRun:
    """一つのSSE作業だけに結び付く途中指示。記録は同じ会話へ即時保存する。"""

    def __init__(self, store, chat_id, history, execute):
        self.id = uuid.uuid4().hex
        self.store = store
        self.chat_id = chat_id
        self.history = history
        self.accepting = execute
        self.pending = []
        self.paused = False
        self.epoch = 0
        self.ready = False

    def set_paused(self, paused):
        if not self.accepting or not self.ready:
            raise ValueError("制作の準備が終わってから操作してください")
        if self.paused != paused:
            self.paused = paused
            self.epoch += 1
            self.history.append({"role": "user", "content":
                "手動編集に切り替えました。" if paused else "手動編集を終えました。最新の本文と接続を読み直し、手動の変更を尊重して続きを進めてください。"})
            self.store.save_chat_messages(self.chat_id, self.history)

    def check_epoch(self, epoch):
        self.check()
        if self.paused or self.epoch != epoch:
            raise ManualEditPending("手動編集に切り替わったため、未確定の操作を破棄して読み直します")

    def submit(self, instruction_id, content, selection=None):
        if not self.accepting:
            raise ValueError("この作業は途中指示を受け付けていません")
        existing = next((m for m in self.history if m.get("instruction", {}).get("id") == instruction_id), None)
        if existing:
            if existing["content"] != content or existing.get("selected_nodes", []) != (selection or []):
                raise ValueError("同じ指示IDで異なる内容は送れません")
            return existing
        if len(self.pending) >= 8:
            raise ValueError("未反映の指示が8件あります。反映を待ってから送ってください")
        item = {"role": "user", "content": content, "selected_nodes": selection or [],
                "instruction": {"id": instruction_id, "status": "accepted", "run_id": self.id}}
        self.history.append(item)
        self.store.save_chat_messages(self.chat_id, self.history)
        self.pending.append(item)
        return item

    def take(self):
        items, self.pending = self.pending, []
        for item in items:
            item["instruction"]["status"] = "reflected"
        if items:
            self.store.save_chat_messages(self.chat_id, self.history)
        return items

    def check(self):
        if self.pending:
            raise InstructionsPending("途中指示が届いたため、未確定の変更を破棄して考え直します")

    def close(self):
        self.accepting = False
        for item in self.pending:
            item["instruction"]["status"] = "unapplied"
        self.pending.clear()


gate = ProductionGate()


class ProductionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        # 自動配置の座標保存は内容・経路を変えないので許可する。
        position = path.endswith("/position") or path == "/layout/positions"
        control = scope["method"] == "POST" and path in ("/production/instruction", "/production/pause")
        manual = gate.run is not None and gate.run.paused and bool(re.fullmatch(r"/(nodes(?:/[^/]+(?:/(?:insert_after|make_canon|ending|detach|normalize_chain|events|target_chars))?)?|edges|endings|groups(?:/[^/]+(?:/(?:move|digest|route/[^/]+|nodes/[^/]+))?)?|layout/reset)", path))
        writing = scope["method"] not in ("GET", "HEAD", "OPTIONS") and not position and not control
        if writing and gate.active and not manual:
            from starlette.responses import JSONResponse
            return await JSONResponse(
                {"detail": "制作中です。シーンの手動編集は制作チャットで切り替えてください。別の生成やライブラリ切替は制作終了後に操作してください"},
                status_code=409,
            )(scope, receive, send)
        if writing:
            gate.inflight += 1
        try:
            await self.app(scope, receive, send)
        finally:
            if writing:
                gate.inflight -= 1
            if writing and path == "/production/send":
                gate.active = False


def tools(allow_write: bool, memory: bool = True):
    result = chat_agent.build_tools() + production_library.tools(allow_write) + production_chapters.tools(allow_write)
    if not allow_write:
        return result
    if memory:
        result.append({"type": "function", "function": {
            "name": "update_work_memory", "description": "制作の引継ぎメモを全文更新する。方針・決定の根拠・未採用案・課題・次の作業を区別。最大6000文字。物語の本文や保護設定は変更しない。",
            "parameters": {"type": "object", "properties": {
                "content": {"type": "string"}, "reason": {"type": "string"}
            }, "required": ["content", "reason"], "additionalProperties": False}
        }})
    scene = {
        "title": {"type": "string"},
        "beat": {"type": "string", "description": "シーンの本文全文"},
        "cast": {"type": "array", "items": {"type": "string"}, "description": "既存キャラID"},
        "location": {"type": ["string", "null"], "description": "登録済み場所ID。nullで親から引継ぐ。省略時は維持"},
        "elapsed_unit": {"type": "string", "enum": [*story_clock.UNITS, "unset"],
                         "description": "前のシーンからの経過。" + story_clock.UNIT_HELP + "。unsetで未設定に戻す。省略時は維持(新規は未設定)。"
                                        "本文や依頼から経過が分かるときだけ指定し、推測では入れない"},
        "elapsed_count": {"type": "integer", "description": "elapsed_unitがhour/day/week/month/yearのときの数(1以上。省略時は1)"},
    }
    for name, description, properties, required in [
        ("insert_scene", "既存ルートの途中への挿入、または枝の末尾を延長する。後続があればその間に入り、正史上では正史が変わる。別ルート・分岐の新規作成には使わずbranch_sceneを使う。",
         {"after_id": {"type": "string"}, **scene}, ["after_id", "title", "beat", "cast"]),
        ("branch_scene", "指定地点から新しい別ルートの先頭シーンを作る。after_idは分岐元のID。既存の後続・正史・結末を変更しない。枝の続きを作るときは返された新規IDの後ろにinsert_sceneで追加する。",
         {"after_id": {"type": "string"}, **scene}, ["after_id", "title", "beat", "cast"]),
        ("update_scene", "構成や文章全体の書き直しが必要な場合に本文を全文置換する。追記や一部の修正にはpatch_sceneを優先する。title/cast省略時は維持する。",
         {"node_id": {"type": "string"}, **scene,
          "rewrite": {"type": "boolean", "description": "元の本文の大半を意図して書き直すときだけtrue。省略時は既存の内容を保つ修正として検証し、元の文の半分以上が失われる置換は保存されない"}},
         ["node_id", "beat"]),
        ("patch_scene", "本文の指定箇所だけを編集し、他の文章・タイトル・登場人物・場所を保持する。appendは末尾にtextをそのまま追記。replaceは本文中に1か所だけ存在するold_textをtextに置換（textが空ならその箇所を削除）。先にget_beatsで原文を読み、置換元を正確にコピーする。",
         {"node_id": {"type": "string"}, "mode": {"type": "string", "enum": ["append", "replace"]},
          "old_text": {"type": "string", "description": "replaceで必須。本文の一意な連続部分。appendでは指定しない。"},
          "text": {"type": "string", "description": "追加または置換する部分だけ。必要な改行・句読点も含める。全文を送らない。"}}, ["node_id", "mode", "text"]),
        ("delete_scene", "指定シーンのみを削除し、親と子を直結する。子孫は削除しない。マーカーは削除不可。",
         {"node_id": {"type": "string"}}, ["node_id"]),
        ("reconnect_scene", "既存シーンを移動する。mode=sceneは1シーンだけ取り出し旧前後を直結してparent_idの直後へ挿入。mode=branchはその先の枝ごと親を付け替える（移動先の既存の子はそのまま）。本文・イベントは保持。",
         {"node_id": {"type": "string"}, "parent_id": {"type": "string"},
          "mode": {"type": "string", "enum": ["scene", "branch"]}}, ["node_id", "parent_id", "mode"]),
    ]:
        result.append({"type": "function", "function": {
            "name": name, "description": description,
            "parameters": {"type": "object", "properties": {
                **properties, "reason": {"type": "string", "description": "依頼に対する変更理由"},
            }, "required": [*required, "reason"], "additionalProperties": False},
        }})
    return result


def _elapsed_args(args):
    """ツール引数の経過を保存する形にする。指定が無ければ空(= 維持)。unset は未設定に戻す。"""
    if "elapsed_unit" not in args:
        return {}
    unit = args["elapsed_unit"]
    unit, count = story_clock.normalize(None if unit == "unset" else unit, args.get("elapsed_count"))
    return {"elapsed_unit": unit, "elapsed_count": count}


def _validate_args(store, name, args):
    if not isinstance(args, dict):
        raise ValueError("引数はオブジェクトで指定してください")
    if not isinstance(args.get("reason"), str) or not args["reason"].strip():
        raise ValueError("変更理由が必要です")
    field = "after_id" if name in CREATE_SCENE_TOOLS else "node_id"
    node = store.get_node(args.get(field))
    if node is None:
        raise ValueError(f"対象シーンがありません: {args.get(field)}")
    if name not in CREATE_SCENE_TOOLS and node.get("kind") is not None:
        raise ValueError("はじまり・結末・章の境界は編集できません")
    if name == "reconnect_scene":
        if args.get("mode") not in ("scene", "branch") or not isinstance(args.get("parent_id"), str):
            raise ValueError("つなぎ替えにはparent_idとmode（scene/branch）が必要です")
    if name not in ("delete_scene", "reconnect_scene"):
        if not isinstance(args.get("beat"), str) or not args["beat"].strip():
            raise ValueError("シーン本文が必要です")
        if "cast" in args:
            if not isinstance(args["cast"], list) or not set(args["cast"]) <= store.known_char_ids():
                raise ValueError("castには既存のキャラクターIDを指定してください")
        if "title" in args and not isinstance(args["title"], str):
            raise ValueError("タイトルは文字列で指定してください")
        if "rewrite" in args and not isinstance(args["rewrite"], bool):
            raise ValueError("rewriteはtrue/falseで指定してください")
        if "location" in args and args["location"] is not None:
            if not isinstance(args["location"], str) or args["location"] not in store.known_place_ids():
                raise ValueError("locationには登録済みの場所IDかnullを指定してください")
        if "elapsed_count" in args and "elapsed_unit" not in args:
            raise ValueError("elapsed_countはelapsed_unitと一緒に指定してください")
        _elapsed_args(args)
        if name in CREATE_SCENE_TOOLS and not all(k in args for k in ("title", "cast")):
            raise ValueError("シーン作成にはtitleとcastが必要です")
    return node


async def apply_edit(store: Store, base_url: str, name: str, args: dict, before_commit=None, policy=None, versions=None):
    """コピーで生成・検証を済ませ、成功した本文とイベントだけを同期的に確定する。"""
    if not isinstance(args, dict):
        raise ValueError("引数はオブジェクトで指定してください")
    versions = versions or NodeVersions(store)
    versions.check(store, args)
    if name in production_chapters.WRITE_TOOLS:
        return production_chapters.apply(store, name, args, policy=policy, before_commit=before_commit)
    if name in production_library.WRITE_TOOLS:
        return production_library.apply(store, name, args, policy=policy, before_commit=before_commit)
    # 部分編集は新しい断片だけを補正する。保存済みの本文を巻き込まない。
    field = "text" if name == "patch_scene" else "beat"
    if isinstance(args.get(field), str):
        args = {**args, field: normalize_scene_text(args[field])}
    from_patch = name == "patch_scene"
    if from_patch:
        args = _patch_args(store, args)
        # 確定・履歴・画面通知は既存の編集と共通。全文はサーバー側で組み立てる。
        name = "update_scene"
    original = _validate_args(store, name, args)
    if name == "update_scene" and not from_patch and "beat" in args:
        # 全文置換で既存の内容の大半が失われる編集は、明示の rewrite が無ければ保存しない。
        production_guard.check_rewrite(original.get("beat") or "", args["beat"], bool(args.get("rewrite")))
    if name in CREATE_SCENE_TOOLS:
        duplicate = production_guard.duplicate_scene(store, args["beat"])
        if duplicate is not None:
            raise ValueError(f"同じ内容のシーンが既にあります: {duplicate[0]}「{duplicate[1]}」。重複して追加しません。"
                             "追加済みなら次の作業へ進み、別の場面が必要なら内容を変えてください")
    before = None
    if policy is not None:
        policy.check_target(original["id"])
        before = store.graph()
    elapsed = _elapsed_args(args)
    if name == "update_scene" and all(args[k] == original.get(k) for k in ("title", "beat", "cast", "location") if k in args) \
            and all(value == original.get(k) for k, value in elapsed.items()):
        raise ValueError("その本文はすでに反映済みです。次の作業へ進んでください")
    candidate_conn = db.connect(":memory:")
    try:
        store.conn.backup(candidate_conn)
        candidate = Store(candidate_conn)
        data = {**{k: args[k] for k in ("title", "beat", "cast", "location") if k in args}, **elapsed}
        node_id = original["id"]
        if name in CREATE_SCENE_TOOLS:
            node_id = uuid.uuid4().hex[:12]
            data["id"] = node_id
            create = node_operations.branch if name == "branch_scene" else node_operations.insert
            create(candidate, original["id"], data, source="llm")
        elif name == "update_scene":
            node_operations.update(candidate, node_id, data)
        elif name == "delete_scene":
            node_operations.delete(candidate, node_id)
        elif name == "reconnect_scene":
            connection = node_operations.reconnect(candidate, node_id, args["parent_id"], args["mode"])
        else:
            raise ValueError(f"unknown tool: {name}")
        if policy is not None:
            policy.check_candidate(before, candidate.graph())
        if name in CREATE_SCENE_TOOLS:
            await production_continuity.check(candidate, base_url, node_id)
            if before_commit is not None:
                before_commit()
            versions.check(store, args)
        if name == "reconnect_scene":
            # 接続変更は本文から再抽出しない。保存済みイベントを新しい経路で点検する。
            affected = set()
            for nid in connection["affected_ids"]:
                affected.update(candidate.subtree_order(nid))
            for nid in affected:
                added_errors = set(candidate.validate(nid)) - set(store.validate(nid))
                if added_errors:
                    raise ValueError(f"接続変更後のシーン {nid} に矛盾: " + "; ".join(sorted(added_errors)))
        if name not in ("delete_scene", "reconnect_scene"):
            await generation.extract_events(candidate, base_url, node_id)
            errors = candidate.validate(node_id)
            if errors:
                raise ValueError("シーンの検証に失敗: " + "; ".join(errors))
            events = candidate.list_events(node_id)
        if before_commit is not None:
            before_commit()
        if policy is not None:
            policy.check_candidate(before, candidate.graph())
        versions.check(store, args)
        # 最後のawaitが中断された場合はここに到達しない。ライブDBへの書き込み中はawaitしない。
        if name in CREATE_SCENE_TOOLS:
            create(store, original["id"], data, events, source="llm")
        elif name == "update_scene":
            node_operations.update(store, node_id, data, events)
        elif name == "reconnect_scene":
            connection = node_operations.reconnect(store, node_id, args["parent_id"], args["mode"])
        else:
            node_operations.delete(store, node_id)
        if policy is not None:
            policy.committed(name, node_id)
        result = {"action": name, "node_id": node_id,
                  "title": data.get("title", original.get("title")), "reason": args["reason"]}
        if name == "reconnect_scene":
            result["connection"] = connection
        if name != "delete_scene":
            node = store.get_node(node_id)
            result["scene"] = {k: node[k] for k in ("id", "title", "beat", "cast", "location")}
        if name == "update_scene":
            # 分割(前半に縮めてから残りを新しいシーンにする)で、縮めた本文を次の判断で
            # 使えるように返す。確定後は古い取得結果を捨てるため、ここでしか残らない。
            result["previous_beat"] = original.get("beat") or ""
        return result
    finally:
        candidate_conn.close()


def _patch_args(store, args):
    if set(args) - {"node_id", "mode", "old_text", "text", "reason"}:
        raise ValueError("部分編集では本文以外の項目は指定できません")
    node = store.get_node(args.get("node_id"))
    if node is None:
        raise ValueError("対象シーンがありません")
    beat = node.get("beat") or ""
    text = args.get("text")
    if not isinstance(text, str):
        raise ValueError("追加・置換するtextは文字列で指定してください")
    if args.get("mode") == "append":
        if "old_text" in args or not text.strip():
            raise ValueError("追記では空でないtextだけを指定してください")
        if beat.endswith(text):
            raise ValueError("その追記は末尾に反映済みです。本文を確認してください")
        updated = beat + text
    elif args.get("mode") == "replace":
        old = args.get("old_text")
        if not isinstance(old, str) or not old:
            raise ValueError("置換には空でないold_textが必要です")
        # 原文→改行表記の補正→前後の空白を除いた形の順に、本文中で一意に見つかる最初の形を使う。
        # 段落の末尾を削る分割では、置換元の末尾改行の有無だけで一致を外しやすい。
        candidates = [old, normalize_scene_text(old)]
        candidates += [c.strip() for c in candidates]
        start = -1
        for old in dict.fromkeys(c for c in candidates if c):
            start = beat.find(old)
            if start >= 0:
                break
        if start < 0 or beat.find(old, start + 1) >= 0:
            raise ValueError("置換元が本文の1か所に一致しません。get_beatsで最新の本文を読み、前後を含めて一意に指定してください")
        updated = beat[:start] + text + beat[start + len(old):]
    else:
        raise ValueError("部分編集のmodeはappendまたはreplaceです")
    return {"node_id": args.get("node_id"), "beat": updated, "reason": args.get("reason")}


# 制作チャットのシステムプロンプトのうち、設定で変えられない固定の指示(設定画面にも読み取り専用で出す)。
EXECUTE_RULES = (
    "あなたは制作の担当です。今回の依頼の範囲だけを編集してください。"
    "現在は実行モードです。作者が対象と変更内容を指定して編集を依頼した場合、その範囲の実行は許可済みです。"
    "途中指示による対象・内容の変更も同じ扱いです。必要な情報を読んだら編集ツールで反映し、『実行してよいですか』と再承認を求めて終了しないでください。"
    "ただし実行モードでも、質問・相談だけの発言は編集許可ではありません。対象や変更内容が特定できない場合、明示的な確認待ちの指示がある場合は質問して待ってください。"
    "一度にツールは1つ。編集前に対象と前後の本文を読んでください。"
    "場面の追加では前後の出来事の成立順を確認し、後で初めて起きる出来事を前提にした場面を先に入れないでください。"
    "追記や一部分の訂正・削除はpatch_sceneを優先し、既存本文を全文書き直さないでください。"
    "作者が追加・置換する文章を明示した場合は、その文章をそのまま使い、理由や新設定を補わないでください。"
    "編集ツールが返すscene.beatは保存後の本文です。依頼が反映されていれば完了を報告し、同じ追記・置換・削除を再実行しないでください。"
    "「ここから分岐」「別ルート」「正史を残して別展開」の依頼ではbranch_sceneで枝の先頭を作ってください。"
    "insert_sceneを正史の分岐元に使うと正史の間へ割り込むため、分岐作成の代用にはできません。"
    "枝の続きは作成した枝の末尾IDをafter_idにしてinsert_sceneで延長し、元の分岐元へ繰り返し挿入しないでください。"
    "追記・補強では既存の出来事や約束を維持してください。依頼にない証拠・秘密・人物設定を新たに確定したり、既存の約束と矛盾する制限を加えたりしないでください。"
    "既存シーンを複数に分割するときは、先にpatch_sceneまたはupdate_sceneで元のシーンを前半だけに縮め、"
    "その結果のprevious_beatに残る続きの本文を、縮めたシーンの後ろへinsert_sceneで1場面ずつ追加してください。"
    "元のシーンに同じ本文が残ったまま後半を追加すると、前後照合で重複として拒否されます。"
    "質問・意見を求められただけなら編集しないで回答してください。"
    "『この案で進めて』などの実行依頼では、直前の会話で提示した変更案を参照し、その範囲だけを実施してください。案が特定できなければ確認してください。"
    "変更は短い理由を添え、目的を達成したら通常の文章で報告して終了してください。"
    "通常の文章だけを返すと今回の制作は終了します。終了報告では実行記録にある確定済みの変更と未実施の作業を区別してください。"
    "未実施の作業を『次は編集します』『このまま続けます』と進行中のように告げて終了しないでください。必要な作業が残るならツールで続け、進められない場合は残件と理由を報告してください。"
    "資料庫のキャラクター・場所はread_libraryで一覧と詳細を確認し、新規登録・編集・削除できます。"
    "章はread_chaptersで所属と入口・出口を確認し、create_chapterで作成、rename_chapterで改名、add_scenes_to_chapterで指定シーンを追加できます。"
    "章立ての依頼には実際に章を作ってください。空の章を作ったら返されたin_idをinsert_sceneのafter_idに使って中身を作れます。"
    "設定資料はsearch_setting_documentsで探し、read_setting_documentで全文とrevisionを読んでから編集します。"
    "create_setting_documentで新規作成、update_setting_documentで指定項目を更新できます。"
    "新規資料は構想(draft)・必要に応じて検索(search)が既定です。作者の明示指示なしに確定設定へ変更せず、AI参照方法も維持してください。"
    "既存設定は省略で維持し、作者が頼んでいない項目は変更しません。物語中の変化や記憶は固定プロフィールに混ぜません。"
    "資料の登録・編集では、作者が明記した各項目を対応する引数へ漏れなく入れてください。場所の説明の引数はplace_description（保存結果ではdescription）、雰囲気はatmosphereです。"
    "操作結果のafterを依頼された項目と照合し、抜けた設定があればupdateで補ってから完了を報告してください。"
    "新しい人物・場所をシーンに使うときは先に資料庫へ登録し、返されたIDをcast/locationに指定してください。"
    "使用中の資料の削除が拒否されたら、参照や会話を勝手に消して回避せず作者へ報告してください。"
    "派閥・画像・音声の編集には未対応です。マーカーは変更しません。"
    "ツール結果と最新の接続図を使い、同じ変更を繰り返さないでください。"
    "作者の途中指示は当初の依頼より優先し、変更済みの内容も踏まえて計画を調整してください。"
    "同じ取得・同じエラー・適用済みの変更を繰り返すと作業は自動で停止します。保存済みの結果は実行記録とツール結果にあります。"
    "\n今回は編集が許可されています。"
)
CONSULT_RULES = (
    "\n今回は相談のみです。ノード・資料・作業メモは変更しませんが、変更案は具体的に提案してください。"
    "変更を依頼されたら、必要な本文・接続・資料を読み、変更対象と追加・修正・削除する内容を作者が確認できる文章で示してください。"
    "追記なら追記文、登録なら登録する設定、構成変更ならどこからどこへつなぐかを示し、依頼にない設定を勝手に確定しないでください。"
    "変更案は未実施と明示し、『この案でよければ、送信モードを「制作を実行」に切り替えて「この案で進めて」と送ってください』と案内して応答を終了してください。"
    "不足情報があれば質問して待ってください。切替案内だけで変更案を省略したり、同じ情報取得を繰り返したり、作業を開始すると宣言したりしないでください。"
    "相談モードのまま賛成や実行の返事が届いても編集せず、案と切替案内を返してください。"
    "質問や構成の相談には必要な情報を読んで答え、回答後は次の入力を待ってください。"
)


def recent_reads(results):
    """次の判断に渡す取得結果。直近3件に加えて、最後に読んだ章の構成を残す。

    章の本文を数回に分けて読むと、最初に読んだ章の構成(読む順)が3件の枠から落ち、
    本文だけを頼りに順番を推測することになる。構成は小さいので枠の外に保持する。
    編集が確定すると呼び出し側が全部捨てるので、古い構成が残ることはない。
    """
    chapters = next((item for item in reversed(results)
                     if item.get("tool") == "read_chapters" and "error" not in (item.get("result") or {})), None)
    kept = [item for item in results if item is not chapters][-3:]
    return [item for item in results if item is chapters or any(item is k for k in kept)]


def build_messages(store, history, message, execute, policy, previous_checkpoint, changes, recent_results, run_id=None, selection=None,
                   cancelled_text="", notes=()):
    system = (chat_agent.build_system(store, store.canon_path(), "all", production=True) + "\n" + EXECUTE_RULES
              if execute else chat_agent.build_system(store, store.canon_path(), "all") + CONSULT_RULES)
    if any(m.get("instruction", {}).get("run_id") == run_id and m.get("instruction", {}).get("status") == "reflected" for m in history):
        system += ("実行記録にある変更はすでに確定しています。方針変更だけを理由に取り消してはいけません。"
                   "『ここまでの場面は残す』と指示されたら、追加済みの場面も含めて削除・統合・置き換えで失わせず、指定された残りの作業だけを進めてください。")
    system += chat_rules.prompt(store)
    system += production_memory.prompt(store, previous_checkpoint, allow_write=execute)
    system += "\n作者が画面で指定した変更条件（最優先）: " + policy.describe()
    system += cancelled_text
    system += ("\n『今選択しているノード』『このシーン』は、その発言に添付された送信時の選択を参照します。"
               "選択は後から変わりません。本文はget_beatsで読み直し、選択だけを編集命令と見なさないでください。"
               "選択なしで対象が不明なら推測せず確認し、複数選択で単数の対象が曖昧な場合も確認してください。"
               "過去の発言の選択を今回の選択として扱わないでください。変更範囲・保護指定は選択より優先です。")
    # 各ステップで最新図を作り、本文を含むツール結果は直近だけ保持する。
    # step は読み取りの手順の記録(画面の時系列用)。LLM へ渡す会話には入れない。
    conversation = [{"role": m["role"], "content": message_content(m)} for m in history
                    if m.get("role") in ("user", "assistant") and not m.get("operation") and not m.get("snapshot")
                    and not m.get("step")
                    and m.get("instruction", {}).get("status") != "unapplied"][-12:]
    messages = [{"role": "system", "content": system}, *conversation]
    messages.append({"role": "user", "content": "今回の依頼: " + message + selection_context(selection or []) + "\n今回の実行記録: "
                     + json.dumps(changes, ensure_ascii=False)
                     + "\n今回の途中指示（当初の依頼より優先）: "
                     + json.dumps([message_content(m) for m in history
                                   if m.get("instruction") and m["instruction"].get("run_id") == run_id
                                   and m["instruction"]["status"] == "reflected"], ensure_ascii=False)
                     + "\n直近の取得結果: "
                     + json.dumps(recent_reads(recent_results), ensure_ascii=False)})
    if execute:
        messages[-1]["content"] += (
            "\n次の判断: まず最新の本文・保存結果と途中指示を照合してください。"
            "依頼された変更がすでに反映されていれば、ツールを呼ばず完了を報告してください。"
            "実行記録は予定ではなく保存済みです。完了後の言い換え・強調・重複追記は不要です。"
            "未反映の明確な編集依頼だけをツールで実行し、再承認は求めません。"
            "対象や変更内容が不明、質問だけ、または作者が確認待ちを指定した場合は編集せず回答・確認してください。"
        )
    if notes:
        messages[-1]["content"] += "\n制作ハーネスからの注記（保存結果の点検）: " + json.dumps(list(notes), ensure_ascii=False)
    return messages


async def context_usage(store, base_url, messages, execute):
    # 実際に組み立てたプロンプトとツール定義を数える。会話テンプレート分は含まない目安。
    text = json.dumps(messages, ensure_ascii=False) + "\n" + json.dumps(tools(execute, production_memory.enabled(store)), ensure_ascii=False)
    counted = await llm.count_tokens(text, base_url=base_url)
    return {"token_count": counted if counted is not None else len(text) // chat_agent.CHAR_PER_TOKEN_FALLBACK,
            "estimated": counted is None, "ctx_size": int(store.get_settings().get("llm_ctx_size") or 16384)}


async def stream(store: Store, base_url: str, chat_id: str | None, message: str, execute: bool, on_delete, policy=None, selection=None):
    policy = policy or ProductionPolicy(store)
    chat = store.get_chat(chat_id) if chat_id else store.create_chat(None, "all", mode="production")
    if chat is None or chat.get("mode") != "production":
        yield _sse({"error": "制作チャットが見つかりません"})
        return
    chat_id = chat["id"]
    history = ProductionHistory(chat["messages"])
    request_message = {"role": "user", "content": message, "selected_nodes": selection or [], "execute": execute, "policy": policy.initial, "policy_label": policy.label}
    history.append(request_message)
    store.save_chat_messages(chat_id, history)
    run = ProductionRun(store, chat_id, history, execute)
    gate.run = run
    monitor = production_guard.RunMonitor()
    recent_results = []
    changes = []
    snapshot = None
    completed = False
    finished_outcome = None  # 判断ループを抜けた理由(completed / stalled / empty / truncated)。None のまま尽きたら limit
    stop_detail = ""
    steps_used = 0
    previous_checkpoint = production_memory.read(store)["checkpoint"]
    # 作業メモを使うかは開始時に決める。オフでは更新ツールを渡さず、終了時の見直しもしない。
    memory_on = production_memory.enabled(store)
    checkpoint_started = False
    outcome = "interrupted"

    def tally_error(name, text):
        """同じエラーの反復を数える。止めるべきなら (文面, 停止理由) の停止理由が入る。"""
        try:
            return monitor.note_error(name, text), None
        except production_guard.StalledRun as stalled:
            return text, str(stalled)
    def save_checkpoint(status, report=""):
        production_memory.checkpoint(store, run.id, chat_id, message_content(request_message), status, changes,
            [{"content": message_content(m), "status": m["instruction"]["status"]} for m in history
             if m.get("instruction", {}).get("run_id") == run.id], report)
    try:
        yield _sse({"chat_id": chat_id, "run_id": run.id, "accepting_instructions": execute})
        if execute:
            snapshot = await snapshots.create_async(store, "制作: " + message[:60], kind="manual")
            history.append({"role": "assistant", "content": "作業前の状態を保存しました。", "snapshot": snapshot})
            store.save_chat_messages(chat_id, history)
            yield _sse({"snapshot": snapshot})
        if execute:
            save_checkpoint("running")
            checkpoint_started = True
        run.ready = True
        yield _sse({"manual_edit_ready": execute})
        previous_epoch = run.epoch
        for step in range(MAX_STEPS):
            if run.paused or run.epoch != previous_epoch:
                recent_results.clear()
            while run.paused:
                await asyncio.sleep(0.1)
            epoch = run.epoch
            previous_epoch = epoch
            versions = NodeVersions(store)
            taken = run.take()
            for item in taken:
                yield _sse({"instruction": item})
            if taken and execute:
                # 途中指示で取りやめになった対象を構造化し、以後その対象への編集はサーバーで拒否する。
                yield _sse({"stage": "途中指示と当初の依頼を照合しています…"})
                reflected = [message_content(m) for m in history if m.get("instruction", {}).get("run_id") == run.id
                             and m["instruction"]["status"] == "reflected"]
                cancelled, remaining = await production_guard.reconcile_instructions(
                    store, base_url, message_content(request_message), reflected, changes)
                titles = {n["id"]: n.get("title") or "(無題)" for n in store.graph()["nodes"]}
                monitor.set_cancelled(cancelled, titles, remaining)
                if cancelled or remaining:
                    notice = ("途中指示を照合しました。"
                              + ("取りやめ: " + "、".join(f"「{titles[i]}」" for i in cancelled) + "。" if cancelled else "")
                              + (f"残作業: {remaining}" if remaining else ""))
                    history.append({"role": "assistant", "content": notice, "instruction_review": True})
                    store.save_chat_messages(chat_id, history)
                    yield _sse({"delta": notice})
                    yield _sse({"response_end": True})
                if run.pending or run.paused or run.epoch != epoch:
                    continue
            messages = build_messages(store, history, message, execute, policy, previous_checkpoint,
                                      changes, recent_results, run.id, selection=selection,
                                      cancelled_text=monitor.cancelled_prompt(), notes=monitor.take_notes())
            steps_used = step + 1
            yield _sse({"usage": await context_usage(store, base_url, messages, execute)})
            yield _sse({"stage": f"確認しています… ({step + 1}/{MAX_STEPS})"})
            result: dict[str, Any] = {}
            last_preview_at = 0.0
            async for kind, value in llm.chat_stream_tools(
                messages, base_url=base_url, tools=tools(execute, memory_on), temperature=0.5,
                max_tokens=3072, label=f"制作チャット({step + 1})", emit_tool_progress=execute,
            ):
                if kind == "content":
                    yield _sse({"delta": value})
                elif kind == "tool_progress" and execute:
                    if not run.paused and run.epoch == epoch and not run.pending and time.monotonic() - last_preview_at >= 0.1:
                        preview = scene_preview(store, value["function"], policy)
                        if preview is not None:
                            last_preview_at = time.monotonic()
                            yield _sse({"preview": preview, "active_node": preview["node_id"], "stage": "本文の編集案を作成しています…"})
                        elif value["function"].get("name") == "update_scene":
                            yield _sse({"preview": None})
                elif kind == "done":
                    result = value
            if run.paused or run.epoch != epoch:
                recent_results.clear()
                yield _sse({"response_end": True, "stage": "手動編集の終了を待ち、最新の構成を読み直します…", "active_node": None})
                continue
            if run.pending:
                yield _sse({"response_end": True, "stage": "途中指示を取り込み、考え直しています…"})
                continue
            content = result.get("content") or ""
            if content:
                history.append({"role": "assistant", "content": content})
                store.save_chat_messages(chat_id, history)
            yield _sse({"response_end": True})
            if run.pending or run.paused or run.epoch != epoch:
                continue
            calls = result.get("tool_calls") or []
            if not calls:
                finish_reason = (result.get("stats") or {}).get("finish_reason")
                if execute and not content.strip():
                    # 空応答は完了ではない。1回だけ注記を添えて判断し直し、続くなら空応答として終える。
                    monitor.empty_responses += 1
                    if monitor.empty_responses < 2 and monitor.add_note(
                            "empty", "前回の応答は空でした(生成上限の可能性)。作業が残っていればツールで1つずつ進め、"
                                     "終わっていれば短い文章で完了を報告してください"):
                        yield _sse({"stage": "応答が空だったため、もう一度判断します…"})
                        continue
                    finished_outcome = "empty"
                    break
                if execute and finish_reason == "length":
                    # 報告が途中で切れている。未完了を完了として記録しない(作業メモの見直しもしない)。
                    finished_outcome = "truncated"
                    break
                if execute:
                    issues = production_guard.completion_issues(store, changes, production_library.references)
                    if any(monitor.add_note(key, text) for key, text in issues):
                        yield _sse({"stage": "保存結果と依頼を照合しています…"})
                        continue
                if execute and not memory_on:
                    # 通知のyield中に新しい指示を受け付けないよう、終了を確定する。
                    run.close()
                elif execute:
                    yield _sse({"stage": "手動修正と作業結果を照合し、作業メモを見直しています…", "active_node": None})
                    try:
                        run.check_epoch(epoch)
                        async with aclosing(production_memory.review_stream(
                            store, base_url, message_content(request_message),
                            [message_content(m) for m in history if m.get("instruction", {}).get("run_id") == run.id
                             and m["instruction"]["status"] == "reflected"], changes, content,
                            check_current=lambda: run.check_epoch(epoch))) as reviews:
                            async for kind, reviewed in reviews:
                                if kind == "stage":
                                    yield _sse({"stage": reviewed})
                                else:
                                    value, revision, basis = reviewed
                        run.check_epoch(epoch)
                        if production_memory.basis(store) != basis:
                            raise ValueError("照合中に制作資料が変更されました。次の制作で再確認します")
                        payload = production_memory.write(store, value.get("content"), value.get("reason"),
                                                          "llm", chat_id, expected_revision=revision)
                        production_memory.mark_reviewed(store, basis, payload["revision"])
                        notice = "作業メモを見直しました: " + value["reason"]
                        history.append({"role": "assistant", "content": notice, "memory_review": True})
                    except (ManualEditPending, InstructionsPending):
                        continue
                    except Exception as e:
                        if run.pending or run.paused or run.epoch != epoch:
                            continue
                        notice = f"作業メモの見直しに失敗しました。保存済みのメモと確定済みの変更は残しています: {e}"
                        state = production_memory.review_state(store)
                        production_memory.save_review(store, {**state, "error": notice})
                        history.append({"role": "assistant", "content": notice, "memory_review": True})
                    store.save_chat_messages(chat_id, history)
                    # 通知のyield中に新しい指示を受け付けないよう、終了を確定する。
                    run.close()
                    yield _sse({"delta": notice})
                    yield _sse({"response_end": True})
                else:
                    # 相談モードで作者が承認・実行を求めたのに切替案内が無い返答(自分で編集するよう
                    # 促すなど)には、サーバーが案内を添える。モデルの言い回しに頼らない。
                    extra = production_guard.consult_guidance_for(message, content)
                    if extra:
                        if history and history[-1].get("role") == "assistant" and history[-1].get("content") == content and content:
                            history[-1]["content"] = content + "\n\n" + extra
                        else:
                            history.append({"role": "assistant", "content": extra})
                        store.save_chat_messages(chat_id, history)
                        yield _sse({"delta": extra})
                        yield _sse({"response_end": True})
                completed = True
                break
            # 相談中の編集試行は再判断ループへ返さず、案内を保存して入力待ちへ戻す。
            if not execute and any(c.get("function", {}).get("name") in WRITE_TOOLS | {"update_work_memory"} for c in calls):
                notice = "現在は相談モードのため、変更は行っていません。実行する場合は「制作を実行」に切り替えて、変更依頼をもう一度送ってください。"
                history.append({"role": "assistant", "content": notice})
                store.save_chat_messages(chat_id, history)
                yield _sse({"delta": notice})
                yield _sse({"response_end": True, "active_node": None})
                completed = True
                break
            # 複数呼び出しを返しても1つずつ処理し、確定ごとに画面へ知らせる。
            truncated = (result.get("stats") or {}).get("finish_reason") == "length"
            stalled = None
            for call in calls:
                if run.pending:
                    break
                name = call.get("function", {}).get("name", "")
                args = {}
                try:
                    run.check_epoch(epoch)
                    try:
                        args = json.loads(call["function"].get("arguments") or "{}")
                    except json.JSONDecodeError as e:
                        # 長い本文を複数の呼び出しで一度に出すと上限で途切れる。原因を日本語で返し、同じ応答の繰り返しを防ぐ。
                        raise ValueError("ツール呼び出しの引数が応答の長さ上限で途切れました。1回の応答で呼ぶツールは1つにし、長い本文は場面ごとに分けて送ってください"
                                         if truncated else f"引数のJSONが不正です: {e}")
                    if not isinstance(args, dict):
                        raise ValueError("引数はオブジェクトで指定してください")
                    yield _sse({"stage": TOOL_LABELS.get(name, "操作を確認しています…"), "active_node": args.get("node_id") or args.get("after_id")})
                    # 検証スクリプトと画面の記録用。本文は含めず、ツール名と対象だけを流す。
                    yield _sse({"tool_call": {"name": name, "target": args.get("node_id") or args.get("after_id") or args.get("id")}})
                    if execute and name in {"update_character", "update_place", "update_setting_document"} and isinstance(args.get("id"), str):
                        kind = name.removeprefix("update_")
                        if getattr(store, f"get_{kind}")(args["id"]) is not None:
                            yield _sse({"active_library": {"kind": kind, "id": args["id"]}})
                    if execute:
                        preview = scene_preview(store, call.get("function", {}), policy)
                        if preview is not None:
                            yield _sse({"preview": preview, "stage": "編集案を検証しています…"})
                    if name == "update_work_memory":
                        if not execute:
                            raise ValueError("相談中は作業メモを変更できません")
                        if not memory_on:
                            raise ValueError("作業メモはオフです。メモは更新せず、依頼された作業を進めてください")
                        run.check_epoch(epoch)
                        payload = production_memory.write(store, args.get("content"), args.get("reason"), "llm", chat_id)
                        history.append({"role": "assistant", "content": "作業メモを更新しました: " + args["reason"],
                                        "memory_revision": payload["revision"]})
                        store.save_chat_messages(chat_id, history)
                        yield _sse({"memory": payload})
                        payload = {"revision": payload["revision"], "saved": True}
                        monitor.note_success()
                    elif name in WRITE_TOOLS:
                        if not execute:
                            raise ValueError("相談中は編集できません。「制作を実行」から依頼してください")
                        repeated = monitor.already_applied(name, args)
                        if repeated is not None:
                            # 適用済みの操作はエラーにせず、保存済みの結果をそのまま返して次へ進ませる。
                            payload = repeated
                            yield _sse({"stage": "適用済みの変更の再実行を省きました"})
                        else:
                            lifted = monitor.check_cancelled(name, args)
                            if lifted:
                                history.append({"role": "assistant", "content": lifted, "instruction_review": True})
                                store.save_chat_messages(chat_id, history)
                                yield _sse({"stage": lifted})
                            payload = await apply_edit(store, base_url, name, args, before_commit=lambda: run.check_epoch(epoch), policy=policy, versions=versions)
                            versions = NodeVersions(store)
                            # 縮める前の本文(previous_beat)は次の判断のツール結果にだけ渡し、履歴・画面・引継ぎには残さない。
                            operation = {k: v for k, v in payload.items() if k != "previous_beat"}
                            monitor.note_applied(name, args, operation)
                            changes.append({k: v for k, v in operation.items() if k != "scene"})
                            # 変更前の本文が次の判断を引き戻さないよう、古い取得結果を捨てる。
                            recent_results.clear()
                            history.append({"role": "assistant", "content": args["reason"], "operation": operation})
                            store.save_chat_messages(chat_id, history)
                            if name == "delete_scene" or name in production_library.WRITE_TOOLS:
                                on_delete()
                            save_checkpoint("running")
                            yield _sse({"changed": operation})
                    else:
                        # 読み取り。同じ取得は2回目に前回の結果を返し、3回目で止める(相談・実行とも)。
                        payload = monitor.repeated_read(name, args)
                        repeated_read = payload is not None
                        if payload is None:
                            payload = (production_library.read(store, args) if name == "read_library"
                                       else production_chapters.read(store) if name == "read_chapters"
                                       else chat_agent.dispatch_tool(store, name, args, store.canon_path(), "all"))
                            monitor.note_read(name, args, payload)
                        read_error = payload.get("error") if isinstance(payload, dict) else None
                        # 何を読んだかを時系列に残す(作者が LLM の動きを追えるように)。本文は残さない。
                        step = read_step(store, name, args, repeated=repeated_read, error=read_error)
                        history.append({"role": "assistant", "content": "", "step": step})
                        store.save_chat_messages(chat_id, history)
                        yield _sse({"step": step})
                        if read_error:
                            payload["error"], stalled = tally_error(name, str(payload["error"]))
                            yield _sse({"tool_error": stalled or payload["error"]})
                        else:
                            monitor.note_success()
                except ManualEditPending as e:
                    recent_results.clear()
                    history.append({"role": "assistant", "content": str(e)})
                    store.save_chat_messages(chat_id, history)
                    yield _sse({"tool_error": str(e), "active_node": None})
                    break
                except InstructionsPending as e:
                    yield _sse({"stage": str(e), "active_node": None})
                    break
                except production_guard.StalledRun as e:
                    stalled = str(e)
                    yield _sse({"tool_error": stalled, "active_node": None})
                    break
                except (ValueError, KeyError, RuntimeError, TypeError) as e:
                    text, stalled = tally_error(name, str(e))
                    payload = {"error": text}
                    yield _sse({"tool_error": stalled or text})
                recent_results.append({"tool": name, "result": payload})
                recent_results = recent_reads(recent_results)
                yield _sse({"active_node": None})
                if stalled:
                    break
            if stalled:
                finished_outcome, stop_detail = "stalled", stalled
                break
            if completed:
                break
        outcome = "completed" if completed else (finished_outcome or "limit")
        if outcome in ("stalled", "limit") and not (run.pending or run.paused):
            # 反復や上限で止めたときも、作者には取得済みの情報に基づく回答・報告を残す(ツールは渡さない)。
            # 報告は実行記録と区別して保存し、終了理由は変えない。
            closing_note = (f"作業は停止しました({production_guard.OUTCOME_LABELS[outcome]}"
                            + (f": {stop_detail}" if stop_detail else "") + ")。ツールは使えません。"
                            + ("実行記録にある確定済みの変更と未実施の作業を区別して、作者への短い報告を書いてください。"
                               if execute else
                               "取得済みの情報だけで、質問に答えるか変更案を具体的に示してください。変更は実行しません。"))
            yield _sse({"stage": "停止前に、ここまでの情報で回答をまとめています…", "active_node": None})
            try:
                closing_messages = build_messages(store, history, message, execute, policy, previous_checkpoint,
                                                  changes, recent_results, run.id, selection=selection,
                                                  cancelled_text=monitor.cancelled_prompt(), notes=[closing_note])
                closing_text = ""
                # ツール呼び出しを文字列で書いてしまう応答を画面に流さないよう、まとめは溜めてから出す。
                async for kind, value in llm.chat_stream_tools(
                    closing_messages, base_url=base_url, temperature=0.5, max_tokens=1024, label="制作チャット(まとめ)",
                ):
                    if kind == "content":
                        closing_text += value
                    elif kind == "done":
                        closing_text = (value.get("content") or closing_text)
                if production_guard.closing_text_is_usable(closing_text):
                    history.append({"role": "assistant", "content": closing_text, "closing": True})
                    store.save_chat_messages(chat_id, history)
                    yield _sse({"delta": closing_text})
                    yield _sse({"response_end": True})
                else:
                    yield _sse({"stage": "まとめの応答が本文ではなかったため表示しません"})
            except Exception as e:  # noqa: BLE001 まとめの失敗で停止の記録を妨げない
                yield _sse({"stage": f"回答のまとめに失敗しました: {e}"})
        if outcome != "completed":
            notice = production_guard.OUTCOME_LABELS[outcome] + (f": {stop_detail}" if stop_detail else "。")
            notice += f" 確定済みの変更 {len(changes)} 件は残しています。続きが必要なら、残りの作業を具体的に依頼してください。"
            history.append({"role": "assistant", "content": notice, "outcome": outcome})
            yield _sse({"delta": notice})
            yield _sse({"response_end": True, "active_node": None})
        # doneを送った後に届く途中指示を受け付けないよう、通知の前に閉じる。
        run.close()
        summary = ((production_guard.OUTCOME_LABELS[outcome] + f"（変更 {len(changes)} 件"
                    + (f"・ツールエラー {monitor.tool_errors} 件" if monitor.tool_errors else "") + "）") if execute
                   else production_guard.OUTCOME_LABELS[outcome] if outcome != "completed" else None)
        yield _sse({"done": True, "chat_id": chat_id, "outcome": outcome, "summary": summary,
                    "changes": len(changes), "tool_errors": monitor.tool_errors, "steps": steps_used})
    except (asyncio.CancelledError, GeneratorExit):
        # 停止ボタンや接続断は、LLM待ちの途中ならCancelledError、yieldで止まっていれば
        # 生成器の後始末(GeneratorExit)として届く。どちらでも停止の記録を残す。
        history.append({"role": "assistant", "content": "作業を停止しました。確定済みの変更は残しています。"})
        raise
    except Exception as e:
        outcome = "error"
        history.append({"role": "assistant", "content": f"作業を停止しました: {e}"})
        yield _sse({"error": str(e)})
    finally:
        run.close()  # 未反映の指示を「未反映のまま終了」にしてから記録する。
        if checkpoint_started:
            report = next((m["content"] for m in reversed(history) if m.get("role") == "assistant" and not m.get("step") and not m.get("operation") and not m.get("snapshot") and not m.get("memory_revision") and not m.get("memory_review")), "")
            save_checkpoint(outcome, report)
        request_message["policy_after"] = policy.spec()
        if gate.run is run:
            gate.run = None
        store.save_chat_messages(chat_id, history)
