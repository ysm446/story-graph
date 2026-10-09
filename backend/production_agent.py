"""制作チャットの段階0。短いツール往復で編集し、確定した変更を逐次通知する。"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import chat_agent
import db
import generation
import llm
import node_operations
import snapshots
from store import Store
from production_policy import ProductionPolicy

MAX_STEPS = 16
WRITE_TOOLS = {"insert_scene", "update_scene", "delete_scene"}
TOOL_LABELS = {
    "get_beats": "シーンを読んでいます…", "get_state": "状態を確認しています…",
    "search_memories": "記憶を調べています…", "insert_scene": "シーンを追加しています…",
    "update_scene": "シーンを編集しています…", "delete_scene": "シーンを削除しています…",
}


class ProductionGate:
    """段階0は制作中の外部書き込みを止める。LLMの応答待ちもロック範囲。"""

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


class ProductionRun:
    """一つのSSE作業だけに結び付く途中指示。記録は同じ会話へ即時保存する。"""

    def __init__(self, store, chat_id, history, execute):
        self.id = uuid.uuid4().hex
        self.store = store
        self.chat_id = chat_id
        self.history = history
        self.accepting = execute
        self.pending = []

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
        writing = scope["method"] not in ("GET", "HEAD", "OPTIONS") and not position and not (scope["method"] == "POST" and path == "/production/instruction")
        if writing and gate.active:
            from starlette.responses import JSONResponse
            return await JSONResponse(
                {"detail": "制作中は手動編集と別の生成を停止しています。制作を停止してから操作してください"},
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
    result = chat_agent.build_tools()
    if not allow_write:
        return result
    scene = {
        "title": {"type": "string"},
        "beat": {"type": "string", "description": "シーンの本文全文"},
        "cast": {"type": "array", "items": {"type": "string"}, "description": "既存キャラID"},
    }
    for name, description, properties, required in [
        ("insert_scene", "指定ノードの直後にシーンを挿入する。後続があればその間に入る。はじまりのIDも指定可能。",
         {"after_id": {"type": "string"}, **scene}, ["after_id", "title", "beat", "cast"]),
        ("update_scene", "既存シーンの本文を全文置換する。title/cast省略時は維持する。",
         {"node_id": {"type": "string"}, **scene}, ["node_id", "beat"]),
        ("delete_scene", "指定シーンのみを削除し、親と子を直結する。子孫は削除しない。マーカーは削除不可。",
         {"node_id": {"type": "string"}}, ["node_id"]),
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
    field = "after_id" if name == "insert_scene" else "node_id"
    node = store.get_node(args.get(field))
    if node is None:
        raise ValueError(f"対象シーンがありません: {args.get(field)}")
    if name != "insert_scene" and node.get("kind") is not None:
        raise ValueError("はじまり・結末・章の境界は編集できません")
    if name != "delete_scene":
        if not isinstance(args.get("beat"), str) or not args["beat"].strip():
            raise ValueError("シーン本文が必要です")
        if "cast" in args:
            if not isinstance(args["cast"], list) or any(c not in store.known_char_ids() for c in args["cast"]):
                raise ValueError("castには既存のキャラクターIDを指定してください")
        if "title" in args and not isinstance(args["title"], str):
            raise ValueError("タイトルは文字列で指定してください")
        if name == "insert_scene" and not all(k in args for k in ("title", "cast")):
            raise ValueError("挿入にはtitleとcastが必要です")
    return node


async def apply_edit(store: Store, base_url: str, name: str, args: dict, before_commit=None, policy=None):
    """コピーで生成・検証を済ませ、成功した本文とイベントだけを同期的に確定する。"""
    original = _validate_args(store, name, args)
    if policy is not None:
        policy.check_target(original["id"])
    before = store.graph() if policy is not None else None
    if name == "update_scene" and all(args[k] == original.get(k) for k in ("title", "beat", "cast") if k in args):
        raise ValueError("その本文はすでに反映済みです。次の作業へ進んでください")
    candidate_conn = db.connect(":memory:")
    try:
        store.conn.backup(candidate_conn)
        candidate = Store(candidate_conn)
        data = {k: args[k] for k in ("title", "beat", "cast") if k in args}
        node_id = original["id"]
        if name == "insert_scene":
            node_id = uuid.uuid4().hex[:12]
            data["id"] = node_id
            node_operations.insert(candidate, original["id"], data, source="llm")
        elif name == "update_scene":
            node_operations.update(candidate, node_id, data)
        elif name == "delete_scene":
            node_operations.delete(candidate, node_id)
        else:
            raise ValueError(f"unknown tool: {name}")
        if policy is not None:
            policy.check_candidate(before, candidate.graph())
        if name != "delete_scene":
            await generation.extract_events(candidate, base_url, node_id)
            errors = candidate.validate(node_id)
            if errors:
                raise ValueError("シーンの検証に失敗: " + "; ".join(errors))
            events = candidate.list_events(node_id)
        if before_commit is not None:
            before_commit()
        if policy is not None:
            policy.check_candidate(before, candidate.graph())
        # 最後のawaitが中断された場合はここに到達しない。ライブDBへの書き込み中はawaitしない。
        if name == "insert_scene":
            node_operations.insert(store, original["id"], data, events, source="llm")
        elif name == "update_scene":
            node_operations.update(store, node_id, data, events)
        else:
            node_operations.delete(store, node_id)
        if policy is not None:
            policy.committed(name, node_id)
        result = {"action": name, "node_id": node_id,
                  "title": data.get("title", original.get("title")), "reason": args["reason"]}
        if name != "delete_scene":
            node = store.get_node(node_id)
            result["scene"] = {k: node[k] for k in ("id", "title", "beat", "cast")}
        return result
    finally:
        candidate_conn.close()


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
    snapshot = None
    completed = False
    try:
        yield chat_agent._sse({"chat_id": chat_id, "run_id": run.id, "accepting_instructions": execute})
        if execute:
            snapshot = await snapshots.create_async(store, "制作: " + message[:60], kind="manual")
            history.append({"role": "assistant", "content": "作業前の状態を保存しました。", "snapshot": snapshot})
            store.save_chat_messages(chat_id, history)
            yield chat_agent._sse({"snapshot": snapshot})
        for step in range(MAX_STEPS):
            for item in run.take():
                yield chat_agent._sse({"instruction": item})
            system = chat_agent.build_system(store, store.canon_path(), "all") + "\n" + (
                "あなたは制作の担当です。今回の依頼の範囲だけを編集してください。"
                "一度にツールは1つ。編集前に対象と前後の本文を読んでください。"
                "質問・意見を求められただけなら編集しないで回答してください。"
                "変更は短い理由を添え、目的を達成したら通常の文章で報告して終了してください。"
                "新しいキャラや場所の登録はできません。マーカーは変更しません。"
                "ツール結果と最新の接続図を使い、同じ変更を繰り返さないでください。"
                "作者の途中指示は当初の依頼より優先し、変更済みの内容も踏まえて計画を調整してください。"
                + ("\n今回は編集が許可されています。" if execute else "\n今回は相談のみ。編集は許可されていません。")
            )
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
                                           if m.get("instruction", {}).get("run_id") == run.id
                                           and m["instruction"]["status"] == "reflected"], ensure_ascii=False)
                             + "\n直近の取得結果: "
                             + json.dumps(recent_results[-3:], ensure_ascii=False)})
            yield chat_agent._sse({"stage": f"確認しています… ({step + 1}/{MAX_STEPS})"})
            result = {}
            async for kind, value in llm.chat_stream_tools(
                messages, base_url=base_url, tools=tools(execute), temperature=0.5,
                max_tokens=3072, label=f"制作チャット({step + 1})",
            ):
                if kind == "content":
                    yield chat_agent._sse({"delta": value})
                elif kind == "done":
                    result = value
            if run.pending:
                yield chat_agent._sse({"response_end": True, "stage": "途中指示を取り込み、考え直しています…"})
                continue
            content = result.get("content") or ""
            if content:
                history.append({"role": "assistant", "content": content})
                store.save_chat_messages(chat_id, history)
            yield chat_agent._sse({"response_end": True})
            if run.pending:
                continue
            calls = result.get("tool_calls") or []
            if not calls:
                run.accepting = False
                completed = True
                break
            # 複数呼び出しを返しても1つずつ処理し、確定ごとに画面へ知らせる。
            for call in calls:
                if run.pending:
                    break
                name = call.get("function", {}).get("name", "")
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                    if not isinstance(args, dict):
                        raise ValueError("引数はオブジェクトで指定してください")
                    yield chat_agent._sse({"stage": TOOL_LABELS.get(name, "操作を確認しています…"), "active_node": args.get("node_id") or args.get("after_id")})
                    if name in WRITE_TOOLS:
                        if not execute:
                            raise ValueError("相談中は編集できません。「制作を実行」から依頼してください")
                        signature = (name, json.dumps({k: v for k, v in args.items() if k != "reason"}, sort_keys=True))
                        if signature in applied:
                            raise ValueError("その変更は適用済みです。最新のシーンを読み直してください")
                        payload = await apply_edit(store, base_url, name, args, before_commit=run.check, policy=policy)
                        applied.add(signature)
                        changes.append({k: v for k, v in payload.items() if k != "scene"})
                        # 変更前の本文が次の判断を引き戻さないよう、古い取得結果を捨てる。
                        recent_results.clear()
                        history.append({"role": "assistant", "content": args["reason"], "operation": payload})
                        store.save_chat_messages(chat_id, history)
                        if name == "delete_scene":
                            on_delete()
                        yield chat_agent._sse({"changed": payload})
                    else:
                        payload = chat_agent.dispatch_tool(store, name, args, store.canon_path(), "all")
                except InstructionsPending as e:
                    yield chat_agent._sse({"stage": str(e), "active_node": None})
                    break
                except (ValueError, KeyError, RuntimeError, TypeError) as e:
                    payload = {"error": str(e)}
                    yield chat_agent._sse({"tool_error": str(e)})
                recent_results.append({"tool": name, "result": payload})
                recent_results = recent_results[-3:]
                yield chat_agent._sse({"active_node": None})
        if not completed:
            history.append({"role": "assistant", "content": "作業の上限に達したため停止しました。確定済みの変更を確認し、必要なら続きを依頼してください。"})
        run.close()
        yield chat_agent._sse({"done": True, "chat_id": chat_id})
    except asyncio.CancelledError:
        history.append({"role": "assistant", "content": "作業を停止しました。確定済みの変更は残しています。"})
        raise
    except Exception as e:
        history.append({"role": "assistant", "content": f"作業を停止しました: {e}"})
        yield chat_agent._sse({"error": str(e)})
    finally:
        request_message["policy_after"] = policy.spec()
        run.close()
        if gate.run is run:
            gate.run = None
        store.save_chat_messages(chat_id, history)
