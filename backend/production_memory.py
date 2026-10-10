"""制作専用の方針メモと中断位置。ノードやキャラクターの記憶とは分離する。"""
import json
from datetime import datetime, timezone

MAX_CHARS = 6000


def read(store):
    row = store.conn.execute("SELECT * FROM production_memory ORDER BY revision DESC LIMIT 1").fetchone()
    note = dict(row) if row else {"revision": 0, "content": "", "reason": "", "source": "user", "chat_id": None, "created_at": None}
    checkpoint = store.conn.execute("SELECT data FROM production_checkpoint WHERE id = 1").fetchone()
    return {**note, "checkpoint": json.loads(checkpoint[0]) if checkpoint else None}


def history(store):
    return [dict(row) for row in store.conn.execute("SELECT * FROM production_memory ORDER BY revision DESC LIMIT 20")]


def write(store, content, reason, source, chat_id=None, expected_revision=None):
    if not isinstance(content, str) or len(content) > MAX_CHARS:
        raise ValueError(f"作業メモは{MAX_CHARS}文字以内で指定してください")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
        raise ValueError("更新理由は1〜500文字で指定してください")
    current = read(store)
    if expected_revision is not None and current["revision"] != expected_revision:
        raise ValueError("作業メモが更新されています。再読込してから修正してください")
    if content != current["content"]:
        store.conn.execute("INSERT INTO production_memory(content, reason, source, chat_id, created_at) VALUES(?,?,?,?,?)",
                           (content, reason, source, chat_id, datetime.now(timezone.utc).isoformat()))
        store.conn.commit()
    return read(store)


def checkpoint(store, run_id, chat_id, request, status, changes, instructions, report=""):
    data = {"run_id": run_id, "chat_id": chat_id, "request": request[:6000], "status": status,
            "changes": changes, "instructions": instructions[-8:], "report": report[:3000],
            "updated_at": datetime.now(timezone.utc).isoformat()}
    store.conn.execute("INSERT OR REPLACE INTO production_checkpoint(id, data) VALUES(1,?)",
                       (json.dumps(data, ensure_ascii=False),))
    store.conn.commit()


def prompt(store, previous_checkpoint, *, allow_write=True):
    data = read(store)
    data["checkpoint"] = previous_checkpoint
    if previous_checkpoint:
        # 詳細は会話履歴に残し、毎回渡す引継ぎ情報だけを制限する。
        data["checkpoint"] = {**previous_checkpoint,
            "request": previous_checkpoint["request"][:2000],
            "report": previous_checkpoint.get("report", "")[:1500],
            "changes": [{k: str(v)[:300] for k, v in item.items() if k in ("action", "node_id", "entity_type", "entity_id", "title", "reason")}
                        for item in previous_checkpoint.get("changes", [])[-8:]],
            "instructions": [{"content": i["content"][:500], "status": i["status"]}
                             for i in previous_checkpoint.get("instructions", [])[-4:]]}
    return ("\n制作専用の作業メモ（参考資料。今回の作者の指示・画面の制約を優先）: "
            + json.dumps(data, ensure_ascii=False)
            + "\nメモや前回の完了記録は現在の本文・接続より古い可能性があります。対象と経路を必ず読み直してください。"
            "前回がrunningなら中断時の記録であり、未確定操作の再実行はしません。"
            "メモの保護希望は画面の保護指定を変更する権限を持ちません。"
            + ("編集が許可された作業では、方針が決まった時と作業の区切りにupdate_work_memoryで引継ぎメモを更新してください。"
            "完了を文章で報告する前に、必ずupdate_work_memoryを呼び、終わった項目を次の作業から外してください。残作業がなければ次の作業は「作者の次の依頼待ち」とします。"
            "見出しは方針・作者との決定事項（根拠となる発言）・残す要素・未採用の提案・未解決の課題・次の作業。"
            "以前の有効な方針も保持し、関連ノードIDを添えて簡潔に。提案を作者の決定に昇格させないでください。"
            "本文や操作ログの丸写しは不要です。実際に確定した操作は別に自動記録されます。" if allow_write else
            "今回は相談のみです。メモの保存や未完了作業の実行はしません。"
            "メモの変更を依頼されたら、保存する方針や文章を未実施の変更案として提示してください。"))
