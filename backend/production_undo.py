"""制作の 1 回の作業をまとめて元に戻す。

作業の始めに取る「制作: <依頼>」のスナップショットへ戻す(ライブラリ全体の復元)。
操作ごとの取り消しは競合の扱いが難しいので、作業単位だけを提供する。

- 戻せるのは「いちばん新しい制作の作業」だけ。後の作業があれば、新しいものから戻す
  (古い作業へ戻すと、後の作業の変更まで消えるため)。
- 作業の後に作者が手で直した分も戻る。復元自体の前に「復元の前」を自動保存するので、
  間違えて戻しても元に戻せる。
- 復元で会話も作業前へ戻るが、制作チャットの履歴は復元後に書き戻し、取り消したことを記録に残す。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import snapshots

SNAPSHOT_PREFIX = "制作: "


def _now():
    return datetime.now(timezone.utc).isoformat()


def offer(snapshot: dict[str, Any], changes: int) -> dict[str, Any]:
    """作業の終わりに会話へ残す「元に戻せる」の項目。画面はこれにボタンを付ける。"""
    return {"role": "assistant",
            "content": f"この作業の変更 {changes} 件は、作業前の状態へまとめて戻せます(作業の後に手で直した分も戻ります)。",
            "undo": {"snapshot_id": snapshot["id"], "changes": changes, "undone": False}}


def find_offer(messages: list[dict[str, Any]], snapshot_id: str) -> dict[str, Any] | None:
    return next((m for m in messages if isinstance(m.get("undo"), dict) and m["undo"].get("snapshot_id") == snapshot_id), None)


def check(store, chat_id: str, snapshot_id: str) -> list[dict[str, Any]]:
    """戻せるかを確かめ、書き戻す会話の履歴を返す。戻せなければ ValueError。"""
    chat = store.get_chat(chat_id)
    if chat is None or chat.get("mode") != "production":
        raise ValueError("制作チャットが見つかりません")
    offer_item = find_offer(chat["messages"], snapshot_id)
    if offer_item is None:
        raise ValueError("この作業の取り消し情報がありません")
    if offer_item["undo"].get("undone"):
        raise ValueError("この作業はすでに元に戻しています")
    production_snapshots = [s for s in snapshots.list_snapshots(store) if (s.get("label") or "").startswith(SNAPSHOT_PREFIX)]
    if not any(s["id"] == snapshot_id for s in production_snapshots):
        raise ValueError("作業前の保存が見つかりません(スナップショットが削除されています)")
    if production_snapshots[0]["id"] != snapshot_id:
        raise ValueError("この作業の後にも制作の作業があります。新しい作業から順に元に戻してください")
    return chat["messages"]


def undo(store, chat_id: str, snapshot_id: str) -> dict[str, Any]:
    messages = check(store, chat_id, snapshot_id)
    snapshots.restore(store, snapshot_id)
    # 戻した時点と同じ内容なので、作業前の保存は消す(残すと、より前の作業を「後の作業がある」と誤って拒む)。
    # 戻す前の状態は restore が「復元の前」として自動保存している
    snapshots.delete(store, snapshot_id)
    # 復元で会話も作業前に戻るので、取り消しの記録を添えて履歴を書き戻す
    for m in messages:
        if isinstance(m.get("undo"), dict) and m["undo"].get("snapshot_id") == snapshot_id:
            m["undo"]["undone"] = True
    messages.append({"role": "assistant", "content": "この作業を元に戻しました。作品・資料庫・作業メモは作業前の状態です。",
                     "undo_done": True, "created_at": _now()})
    # 会話は作業前の保存の時点で存在する(依頼を保存してからスナップショットを取る)
    if store.get_chat(chat_id) is not None:
        store.save_chat_messages(chat_id, messages)
    return {"restored": snapshot_id, "chat_id": chat_id}
