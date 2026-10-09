"""制作段階0の実機検証。検証用ライブラリだけを変更し、通常の作品には触れない。

リポジトリの.venvで実行する。既存サーバーを使うか、--model 指定時に専用ポートで起動する。
結果とスナップショットは data/production-check-<id>/ に残す。
"""

import argparse
import asyncio
import json
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import db
import embed
from llama_manager import LlamaManager
import production_agent
from store import Store


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8089")
    parser.add_argument("--model", help="専用llama-serverを起動するモデルのパス")
    parser.add_argument("--instructions", action="store_true", help="途中指示による方針変更を検証する")
    parser.add_argument("--policy", action="store_true", help="変更範囲と保護指定を検証する")
    args = parser.parse_args()
    if args.instructions and args.policy:
        parser.error("--instructions と --policy は別々に実行してください")
    root = ROOT / "data" / ("production-check-" + uuid.uuid4().hex[:8])
    root.mkdir(parents=True)
    store = Store(db.connect(root / "story-graph.db"), root=str(root))
    # 小さい物語なのでFTSだけで確認し、埋め込みモデルの初回取得を避ける。
    embed.available = lambda: False
    embed.is_ready = lambda: False
    store.create_character({"id": "aya", "name": "アヤ", "profile": "村を守りたい旅人"})
    store.create_character({"id": "ken", "name": "ケン", "profile": "アヤの幼なじみ"})
    store.append_node({"id": "departure", "title": "出発", "beat": "アヤは何も告げず村を出る。", "cast": ["aya", "ken"]})
    store.append_node({"id": "return", "title": "帰還", "beat": "アヤは村に戻り、ケンと和解する。", "cast": ["aya", "ken"]})
    manager = LlamaManager()
    events = []
    try:
        if args.model:
            # 既存サーバーを停止したり設定を変更したりしない。
            import llm
            if await llm.health(args.base_url):
                raise RuntimeError("専用ポートが使用中です。別のbase-urlを指定してください")
            await manager.start({"llm_base_url": args.base_url, "llm_model_path": args.model, "llm_ctx_size": "16384"})
        prompt = (
            "出発と帰還の間に、アヤがケンとの約束を思い出すシーンを1つ挿入してください。"
            "さらに既存の出発の本文を、村を守る方法を探すために旅立つと分かるよう修正してください。"
            "既存のキャラだけを使い、削除はしないでください。この2つの変更ができたら終了してください。"
        )
        if args.instructions:
            prompt = "出発の本文を、村を守る方法を探すために旅立つと分かるよう修正してください。"
        policy = None
        if args.policy:
            policy = production_agent.ProductionPolicy(store, allowed_ids=["departure"], protected_ids=["return"])
            prompt = "出発と帰還の本文を補強してください。出発は村を守る方法を探すために旅立つことを明記してください。画面の変更範囲と保護条件を守り、変更できない部分は報告してください。"
        instruction_sent = False
        async for raw in production_agent.stream(store, args.base_url, None, prompt, True, lambda: None, policy=policy):
            event = json.loads(raw.removeprefix("data: "))
            events.append(event)
            if args.instructions and not instruction_sent and event.get("stage"):
                production_agent.gate.run.submit("live-direction", "方針変更です。出発は変更せずそのまま残してください。帰還の本文だけに、ケンとの約束を守って戻ったことを加えてください。追加・削除は不要です。")
                instruction_sent = True
            if "delta" not in event:
                print(json.dumps(event, ensure_ascii=False), flush=True)
        changes = [e["changed"] for e in events if "changed" in e]
        if args.policy:
            assert len(changes) == 1 and changes[0]["action"] == "update_scene" and changes[0]["node_id"] == "departure"
            assert store.get_node("return")["beat"] == "アヤは村に戻り、ケンと和解する。"
            assert store.canon_path() == ["departure", "return"]
            assert not any(e.get("error") for e in events)
            print("LIVE POLICY CHECK PASSED", flush=True)
            return
        if args.instructions:
            assert instruction_sent
            assert any(e.get("instruction", {}).get("instruction", {}).get("status") == "reflected" for e in events)
            assert store.get_node("departure")["beat"] == "アヤは何も告げず村を出る。", "旧指示の変更が適用された"
            assert len(changes) == 1 and changes[0]["action"] == "update_scene" and changes[0]["node_id"] == "return"
            assert "約束" in store.get_node("return")["beat"]
            assert store.canon_path() == ["departure", "return"]
            assert not any(e.get("error") for e in events)
            print("LIVE INSTRUCTION CHECK PASSED", flush=True)
            return
        assert any(c["action"] == "insert_scene" for c in changes), "追加が実行されなかった"
        assert any(c["action"] == "update_scene" and c["node_id"] == "departure" for c in changes), "出発の編集が実行されなかった"
        assert len(store.canon_path()) == 3, "シーン数が依頼と一致しない"
        assert store.get_node("return")["beat"] == "アヤは村に戻り、ケンと和解する。", "依頼外のシーンが変更された"
        assert not any(e.get("error") for e in events)
        inserted_id = next(c["node_id"] for c in changes if c["action"] == "insert_scene")
        chat_id = events[0]["chat_id"]
        async for raw in production_agent.stream(
            store, args.base_url, chat_id,
            f"追加したシーン（ID: {inserted_id}）だけを削除し、前後をつなぎ直してください。出発と帰還の本文は変更しないでください。",
            True, lambda: None,
        ):
            event = json.loads(raw.removeprefix("data: "))
            events.append(event)
            if "delta" not in event:
                print(json.dumps(event, ensure_ascii=False), flush=True)
        assert store.get_node(inserted_id) is None, "指定したシーンが削除されなかった"
        assert store.canon_path() == ["departure", "return"], "削除後の接続が不正"
        assert not any(e.get("error") for e in events)
        print("LIVE CHECK PASSED", flush=True)
    finally:
        (root / "events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"RESULT: {root}", flush=True)
        store.conn.close()
        if args.model:
            await manager.stop_async()


if __name__ == "__main__":
    asyncio.run(main())
