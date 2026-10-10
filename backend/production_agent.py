"""制作チャットの段階0。短いツール往復で編集し、確定した変更を逐次通知する。"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
import time
from production_preview import scene_preview
from typing import Any

import chat_agent
import db
import generation
import llm
import node_operations
import snapshots
import production_memory
import production_library
import production_continuity
from store import Store
from generated_text import normalize_scene_text
from production_policy import CONTENT_FIELDS, ProductionPolicy

MAX_STEPS = 16
CREATE_SCENE_TOOLS = {"insert_scene", "branch_scene"}
WRITE_TOOLS = CREATE_SCENE_TOOLS | {"update_scene", "patch_scene", "delete_scene", "reconnect_scene"} | production_library.WRITE_TOOLS
TOOL_LABELS = {
    "get_beats": "シーンを読んでいます…", "get_state": "状態を確認しています…",
    "search_memories": "記憶を調べています…", "insert_scene": "シーンを追加しています…",
    "branch_scene": "分岐シーンを追加しています…",
    "reconnect_scene": "シーンをつなぎ替えています…",
    "update_work_memory": "作業メモを更新しています…",
    "update_scene": "シーンを編集しています…", "delete_scene": "シーンを削除しています…",
    "patch_scene": "シーンの指定箇所を編集しています…",
    "read_library": "資料庫を読んでいます…",
    **{name: "資料庫を更新しています…" for name in production_library.WRITE_TOOLS},
}


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
        self.library = (store.list_characters(), store.list_places())

    def check(self, store, args):
        current = NodeVersions(store)
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

    def submit(self, instruction_id, content):
        if not self.accepting:
            raise ValueError("この作業は途中指示を受け付けていません")
        existing = next((m for m in self.history if m.get("instruction", {}).get("id") == instruction_id), None)
        if existing:
            if existing["content"] != content:
                raise ValueError("同じ指示IDで異なる内容は送れません")
            return existing
        if len(self.pending) >= 8:
            raise ValueError("未反映の指示が8件あります。反映を待ってから送ってください")
        item = {"role": "user", "content": content,
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


def tools(allow_write: bool):
    result = chat_agent.build_tools() + production_library.tools(allow_write)
    if not allow_write:
        return result
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
    }
    for name, description, properties, required in [
        ("insert_scene", "既存ルートの途中への挿入、または枝の末尾を延長する。後続があればその間に入り、正史上では正史が変わる。別ルート・分岐の新規作成には使わずbranch_sceneを使う。",
         {"after_id": {"type": "string"}, **scene}, ["after_id", "title", "beat", "cast"]),
        ("branch_scene", "指定地点から新しい別ルートの先頭シーンを作る。after_idは分岐元のID。既存の後続・正史・結末を変更しない。枝の続きを作るときは返された新規IDの後ろにinsert_sceneで追加する。",
         {"after_id": {"type": "string"}, **scene}, ["after_id", "title", "beat", "cast"]),
        ("update_scene", "構成や文章全体の書き直しが必要な場合に本文を全文置換する。追記や一部の修正にはpatch_sceneを優先する。title/cast省略時は維持する。",
         {"node_id": {"type": "string"}, **scene}, ["node_id", "beat"]),
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
        if "location" in args and args["location"] is not None:
            if not isinstance(args["location"], str) or args["location"] not in store.known_place_ids():
                raise ValueError("locationには登録済みの場所IDかnullを指定してください")
        if name in CREATE_SCENE_TOOLS and not all(k in args for k in ("title", "cast")):
            raise ValueError("シーン作成にはtitleとcastが必要です")
    return node


async def apply_edit(store: Store, base_url: str, name: str, args: dict, before_commit=None, policy=None, versions=None):
    """コピーで生成・検証を済ませ、成功した本文とイベントだけを同期的に確定する。"""
    if not isinstance(args, dict):
        raise ValueError("引数はオブジェクトで指定してください")
    versions = versions or NodeVersions(store)
    versions.check(store, args)
    if name in production_library.WRITE_TOOLS:
        return production_library.apply(store, name, args, policy=policy, before_commit=before_commit)
    # 部分編集は新しい断片だけを補正する。保存済みの本文を巻き込まない。
    field = "text" if name == "patch_scene" else "beat"
    if isinstance(args.get(field), str):
        args = {**args, field: normalize_scene_text(args[field])}
    if name == "patch_scene":
        args = _patch_args(store, args)
        # 確定・履歴・画面通知は既存の編集と共通。全文はサーバー側で組み立てる。
        name = "update_scene"
    original = _validate_args(store, name, args)
    before = None
    if policy is not None:
        policy.check_target(original["id"])
        before = store.graph()
    if name == "update_scene" and all(args[k] == original.get(k) for k in ("title", "beat", "cast", "location") if k in args):
        raise ValueError("その本文はすでに反映済みです。次の作業へ進んでください")
    candidate_conn = db.connect(":memory:")
    try:
        store.conn.backup(candidate_conn)
        candidate = Store(candidate_conn)
        data = {k: args[k] for k in ("title", "beat", "cast", "location") if k in args}
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


def build_messages(store, history, message, execute, policy, previous_checkpoint, changes, recent_results, run_id=None):
    system = chat_agent.build_system(store, store.canon_path(), "all", production=execute) + "\n" + (
        "あなたは制作の担当です。今回の依頼の範囲だけを編集してください。"
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
        "既存設定は省略で維持し、作者が頼んでいない項目は変更しません。物語中の変化や記憶は固定プロフィールに混ぜません。"
        "資料の登録・編集では、作者が明記した各項目を対応する引数へ漏れなく入れてください。場所の説明の引数はplace_description（保存結果ではdescription）、雰囲気はatmosphereです。"
        "操作結果のafterを依頼された項目と照合し、抜けた設定があればupdateで補ってから完了を報告してください。"
        "新しい人物・場所をシーンに使うときは先に資料庫へ登録し、返されたIDをcast/locationに指定してください。"
        "使用中の資料の削除が拒否されたら、参照や会話を勝手に消して回避せず作者へ報告してください。"
        "派閥・画像・音声の編集には未対応です。マーカーは変更しません。"
        "ツール結果と最新の接続図を使い、同じ変更を繰り返さないでください。"
        "作者の途中指示は当初の依頼より優先し、変更済みの内容も踏まえて計画を調整してください。"
        "\n今回は編集が許可されています。"
    ) if execute else chat_agent.build_system(store, store.canon_path(), "all") + (
        "\n今回は相談のみです。ノード・資料・作業メモは変更しませんが、変更案は具体的に提案してください。"
        "変更を依頼されたら、必要な本文・接続・資料を読み、変更対象と追加・修正・削除する内容を作者が確認できる文章で示してください。"
        "追記なら追記文、登録なら登録する設定、構成変更ならどこからどこへつなぐかを示し、依頼にない設定を勝手に確定しないでください。"
        "変更案は未実施と明示し、『この案でよければ、送信モードを「制作を実行」に切り替えて「この案で進めて」と送ってください』と案内して応答を終了してください。"
        "不足情報があれば質問して待ってください。切替案内だけで変更案を省略したり、同じ情報取得を繰り返したり、作業を開始すると宣言したりしないでください。"
        "相談モードのまま賛成や実行の返事が届いても編集せず、案と切替案内を返してください。"
        "質問や構成の相談には必要な情報を読んで答え、回答後は次の入力を待ってください。"
    )
    if any(m.get("instruction", {}).get("run_id") == run_id and m.get("instruction", {}).get("status") == "reflected" for m in history):
        system += ("実行記録にある変更はすでに確定しています。方針変更だけを理由に取り消してはいけません。"
                   "『ここまでの場面は残す』と指示されたら、追加済みの場面も含めて削除・統合・置き換えで失わせず、指定された残りの作業だけを進めてください。")
    system += production_memory.prompt(store, previous_checkpoint, allow_write=execute)
    system += "\n作者が画面で指定した変更条件（最優先）: " + policy.describe()
    # 各ステップで最新図を作り、本文を含むツール結果は直近だけ保持する。
    conversation = [{"role": m["role"], "content": m["content"]} for m in history
                    if m.get("role") in ("user", "assistant") and not m.get("operation") and not m.get("snapshot")
                    and m.get("instruction", {}).get("status") != "unapplied"][-12:]
    messages = [{"role": "system", "content": system}, *conversation]
    messages.append({"role": "user", "content": "今回の依頼: " + message + "\n今回の実行記録: "
                     + json.dumps(changes, ensure_ascii=False)
                     + "\n今回の途中指示（当初の依頼より優先）: "
                     + json.dumps([m["content"] for m in history
                                   if m.get("instruction") and m["instruction"].get("run_id") == run_id
                                   and m["instruction"]["status"] == "reflected"], ensure_ascii=False)
                     + "\n直近の取得結果: "
                     + json.dumps(recent_results[-3:], ensure_ascii=False)})
    return messages


async def context_usage(store, base_url, messages, execute):
    # 実際に組み立てたプロンプトとツール定義を数える。会話テンプレート分は含まない目安。
    text = json.dumps(messages, ensure_ascii=False) + "\n" + json.dumps(tools(execute), ensure_ascii=False)
    counted = await llm.count_tokens(text, base_url=base_url)
    return {"token_count": counted if counted is not None else len(text) // chat_agent.CHAR_PER_TOKEN_FALLBACK,
            "estimated": counted is None, "ctx_size": int(store.get_settings().get("llm_ctx_size") or 16384)}


async def stream(store: Store, base_url: str, chat_id: str | None, message: str, execute: bool, on_delete, policy=None):
    policy = policy or ProductionPolicy(store)
    chat = store.get_chat(chat_id) if chat_id else store.create_chat(None, "all", mode="production")
    if chat is None or chat.get("mode") != "production":
        yield chat_agent._sse({"error": "制作チャットが見つかりません"})
        return
    chat_id = chat["id"]
    history = list(chat["messages"])
    request_message = {"role": "user", "content": message, "execute": execute, "policy": policy.initial, "policy_label": policy.label}
    history.append(request_message)
    store.save_chat_messages(chat_id, history)
    run = ProductionRun(store, chat_id, history, execute)
    gate.run = run
    recent_results = []
    changes = []
    applied = set()
    consulted = set()
    snapshot = None
    completed = False
    previous_checkpoint = production_memory.read(store)["checkpoint"]
    checkpoint_started = False
    outcome = "interrupted"
    def save_checkpoint(status, report=""):
        production_memory.checkpoint(store, run.id, chat_id, message, status, changes,
            [{"content": m["content"], "status": m["instruction"]["status"]} for m in history
             if m.get("instruction", {}).get("run_id") == run.id], report)
    try:
        yield chat_agent._sse({"chat_id": chat_id, "run_id": run.id, "accepting_instructions": execute})
        if execute:
            snapshot = await snapshots.create_async(store, "制作: " + message[:60], kind="manual")
            history.append({"role": "assistant", "content": "作業前の状態を保存しました。", "snapshot": snapshot})
            store.save_chat_messages(chat_id, history)
            yield chat_agent._sse({"snapshot": snapshot})
        if execute:
            save_checkpoint("running")
            checkpoint_started = True
        run.ready = True
        yield chat_agent._sse({"manual_edit_ready": execute})
        previous_epoch = run.epoch
        for step in range(MAX_STEPS):
            if run.paused or run.epoch != previous_epoch:
                recent_results.clear()
            while run.paused:
                await asyncio.sleep(0.1)
            epoch = run.epoch
            previous_epoch = epoch
            versions = NodeVersions(store)
            for item in run.take():
                yield chat_agent._sse({"instruction": item})
            messages = build_messages(store, history, message, execute, policy, previous_checkpoint,
                                      changes, recent_results, run.id)
            yield chat_agent._sse({"usage": await context_usage(store, base_url, messages, execute)})
            yield chat_agent._sse({"stage": f"確認しています… ({step + 1}/{MAX_STEPS})"})
            result: dict[str, Any] = {}
            last_preview_at = 0.0
            async for kind, value in llm.chat_stream_tools(
                messages, base_url=base_url, tools=tools(execute), temperature=0.5,
                max_tokens=3072, label=f"制作チャット({step + 1})", emit_tool_progress=execute,
            ):
                if kind == "content":
                    yield chat_agent._sse({"delta": value})
                elif kind == "tool_progress" and execute:
                    if not run.paused and run.epoch == epoch and not run.pending and time.monotonic() - last_preview_at >= 0.1:
                        preview = scene_preview(store, value["function"], policy)
                        if preview is not None:
                            last_preview_at = time.monotonic()
                            yield chat_agent._sse({"preview": preview, "active_node": preview["node_id"], "stage": "本文の編集案を作成しています…"})
                        elif value["function"].get("name") == "update_scene":
                            yield chat_agent._sse({"preview": None})
                elif kind == "done":
                    result = value
            if run.paused or run.epoch != epoch:
                recent_results.clear()
                yield chat_agent._sse({"response_end": True, "stage": "手動編集の終了を待ち、最新の構成を読み直します…", "active_node": None})
                continue
            if run.pending:
                yield chat_agent._sse({"response_end": True, "stage": "途中指示を取り込み、考え直しています…"})
                continue
            content = result.get("content") or ""
            if content:
                history.append({"role": "assistant", "content": content})
                store.save_chat_messages(chat_id, history)
            yield chat_agent._sse({"response_end": True})
            if run.pending or run.paused or run.epoch != epoch:
                continue
            calls = result.get("tool_calls") or []
            if not calls:
                if execute:
                    yield chat_agent._sse({"stage": "手動修正と作業結果を照合し、作業メモを見直しています…", "active_node": None})
                    try:
                        run.check_epoch(epoch)
                        value, revision, basis = await production_memory.review(
                            store, base_url, message,
                            [m["content"] for m in history if m.get("instruction", {}).get("run_id") == run.id
                             and m["instruction"]["status"] == "reflected"], changes, content)
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
                    yield chat_agent._sse({"delta": notice})
                    yield chat_agent._sse({"response_end": True})
                completed = True
                break
            # 相談中の編集試行は再判断ループへ返さず、案内を保存して入力待ちへ戻す。
            if not execute and any(c.get("function", {}).get("name") in WRITE_TOOLS | {"update_work_memory"} for c in calls):
                notice = "現在は相談モードのため、変更は行っていません。実行する場合は「制作を実行」に切り替えて、変更依頼をもう一度送ってください。"
                history.append({"role": "assistant", "content": notice})
                store.save_chat_messages(chat_id, history)
                yield chat_agent._sse({"delta": notice})
                yield chat_agent._sse({"response_end": True, "active_node": None})
                completed = True
                break
            # 複数呼び出しを返しても1つずつ処理し、確定ごとに画面へ知らせる。
            truncated = (result.get("stats") or {}).get("finish_reason") == "length"
            for call in calls:
                if run.pending:
                    break
                name = call.get("function", {}).get("name", "")
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
                    if not execute:
                        signature = (name, json.dumps(args, sort_keys=True, ensure_ascii=False))
                        if signature in consulted:
                            notice = "同じ情報の確認が続いたため、いったん停止しました。追加で確認したい点を教えてください。変更を実行する場合は「制作を実行」に切り替えて依頼を送ってください。"
                            history.append({"role": "assistant", "content": notice})
                            store.save_chat_messages(chat_id, history)
                            yield chat_agent._sse({"delta": notice})
                            yield chat_agent._sse({"response_end": True, "active_node": None})
                            completed = True
                            break
                        consulted.add(signature)
                    yield chat_agent._sse({"stage": TOOL_LABELS.get(name, "操作を確認しています…"), "active_node": args.get("node_id") or args.get("after_id")})
                    if execute:
                        preview = scene_preview(store, call.get("function", {}), policy)
                        if preview is not None:
                            yield chat_agent._sse({"preview": preview, "stage": "編集案を検証しています…"})
                    if name == "update_work_memory":
                        if not execute:
                            raise ValueError("相談中は作業メモを変更できません")
                        run.check_epoch(epoch)
                        payload = production_memory.write(store, args.get("content"), args.get("reason"), "llm", chat_id)
                        history.append({"role": "assistant", "content": "作業メモを更新しました: " + args["reason"],
                                        "memory_revision": payload["revision"]})
                        store.save_chat_messages(chat_id, history)
                        yield chat_agent._sse({"memory": payload})
                        payload = {"revision": payload["revision"], "saved": True}
                    elif name in WRITE_TOOLS:
                        if not execute:
                            raise ValueError("相談中は編集できません。「制作を実行」から依頼してください")
                        signature = (name, json.dumps({k: v for k, v in args.items() if k != "reason"}, sort_keys=True))
                        if signature in applied:
                            raise ValueError("その変更は適用済みです。最新のシーンを読み直してください")
                        payload = await apply_edit(store, base_url, name, args, before_commit=lambda: run.check_epoch(epoch), policy=policy, versions=versions)
                        versions = NodeVersions(store)
                        applied.add(signature)
                        # 縮める前の本文(previous_beat)は次の判断のツール結果にだけ渡し、履歴・画面・引継ぎには残さない。
                        operation = {k: v for k, v in payload.items() if k != "previous_beat"}
                        changes.append({k: v for k, v in operation.items() if k != "scene"})
                        # 変更前の本文が次の判断を引き戻さないよう、古い取得結果を捨てる。
                        recent_results.clear()
                        history.append({"role": "assistant", "content": args["reason"], "operation": operation})
                        store.save_chat_messages(chat_id, history)
                        if name == "delete_scene" or name in production_library.WRITE_TOOLS:
                            on_delete()
                        save_checkpoint("running")
                        yield chat_agent._sse({"changed": operation})
                    elif name == "read_library":
                        payload = production_library.read(store, args)
                    else:
                        payload = chat_agent.dispatch_tool(store, name, args, store.canon_path(), "all")
                except ManualEditPending as e:
                    recent_results.clear()
                    history.append({"role": "assistant", "content": str(e)})
                    store.save_chat_messages(chat_id, history)
                    yield chat_agent._sse({"tool_error": str(e), "active_node": None})
                    break
                except InstructionsPending as e:
                    yield chat_agent._sse({"stage": str(e), "active_node": None})
                    break
                except (ValueError, KeyError, RuntimeError, TypeError) as e:
                    payload = {"error": str(e)}
                    yield chat_agent._sse({"tool_error": str(e)})
                recent_results.append({"tool": name, "result": payload})
                recent_results = recent_results[-3:]
                yield chat_agent._sse({"active_node": None})
            if completed:
                break
        if not completed:
            history.append({"role": "assistant", "content": "作業の上限に達したため停止しました。確定済みの変更を確認し、必要なら続きを依頼してください。"})
        outcome = "completed" if completed else "limit"
        # doneを送った後に届く途中指示を受け付けないよう、通知の前に閉じる。
        run.close()
        yield chat_agent._sse({"done": True, "chat_id": chat_id})
    except (asyncio.CancelledError, GeneratorExit):
        # 停止ボタンや接続断は、LLM待ちの途中ならCancelledError、yieldで止まっていれば
        # 生成器の後始末(GeneratorExit)として届く。どちらでも停止の記録を残す。
        history.append({"role": "assistant", "content": "作業を停止しました。確定済みの変更は残しています。"})
        raise
    except Exception as e:
        outcome = "error"
        history.append({"role": "assistant", "content": f"作業を停止しました: {e}"})
        yield chat_agent._sse({"error": str(e)})
    finally:
        run.close()  # 未反映の指示を「未反映のまま終了」にしてから記録する。
        if checkpoint_started:
            report = next((m["content"] for m in reversed(history) if m.get("role") == "assistant" and not m.get("operation") and not m.get("snapshot") and not m.get("memory_revision") and not m.get("memory_review")), "")
            save_checkpoint(outcome, report)
        request_message["policy_after"] = policy.spec()
        if gate.run is run:
            gate.run = None
        store.save_chat_messages(chat_id, history)
