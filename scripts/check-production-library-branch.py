"""実モデルで資料庫操作・分岐・途中指示を通す。新規の検証用DBだけを変更する。"""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import db
import embed
import llm
import node_operations
import production_agent as production
import production_memory
from llama_manager import LlamaManager
from store import Store


def seed(store):
    store.create_character({"id": "aya", "name": "アヤ", "profile": "故郷へ帰る旅人"})
    store.create_place({"id": "village", "name": "村", "description": "アヤの故郷"})
    for nid, title, beat in [
        ("departure", "出発", "アヤは故郷へ帰るため村を出る。"),
        ("crossroads", "分かれ道", "アヤは分かれ道に着く。正史では街道を進む。"),
        ("road", "街道", "アヤは街道を通って村へ向かう。"),
        ("return", "帰還", "アヤは無事に村へ戻る。"),
    ]:
        store.append_node({"id": nid, "title": title, "beat": beat, "cast": ["aya"], "location": "village"})
    store.create_group("旅立ち", ["departure", "crossroads"])
    store.create_group("帰郷", ["road", "return"])


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8089")
    args = parser.parse_args()
    root = ROOT / "data" / ("production-library-branch-" + uuid.uuid4().hex[:8])
    root.mkdir(parents=True)
    store = Store(db.connect(root / "story-graph.db"), root=str(root))
    embed.available = lambda: False
    embed.is_ready = lambda: False
    seed(store)
    initial = store.graph()
    canon = store.canon_path()
    ending = store.active_ending()
    manager = LlamaManager()
    result = {"passed": False, "model": args.model, "stages": []}
    print(f"RESULT: {root}", flush=True)

    def preserved():
        graph = store.graph()
        assert store.canon_path() == canon and store.active_ending() == ending, "正史が変わった"
        assert all(edge in graph["edges"] for edge in initial["edges"]), "既存接続が変わった"
        for old in initial["nodes"]:
            now = store.get_node(old["id"])
            assert all(now[key] == old[key] for key in ("title", "beat", "cast", "location", "events", "group_id")), "既存本文が変わった"
        node_operations._check_connections(graph)

    async def turn(label, prompt, execute=True, instruction=None):
        events, pending = [], None
        started = time.monotonic()
        async def interrupt():
            await asyncio.sleep(0.5)
            production.gate.run.submit("change-direction", instruction)
        try:
            async with asyncio.timeout(360):
                async for raw in production.stream(store, args.base_url, None, prompt, execute, lambda: None,
                        policy=production.ProductionPolicy(store, protected_ids=["return"])):
                    event = json.loads(raw.removeprefix("data: "))
                    events.append(event)
                    if instruction and pending is None and event.get("stage"):
                        pending = asyncio.create_task(interrupt())
                    if event.get("changed") or event.get("tool_error") or event.get("error"):
                        print(label, json.dumps(event, ensure_ascii=False), flush=True)
        finally:
            if pending:
                if not pending.done():
                    pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            for suffix, data in [("events", events), ("graph", store.graph()), ("prompts", list(llm.PROMPT_LOG))]:
                (root / f"{label}-{suffix}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            result["stages"].append({"label": label, "seconds": round(time.monotonic() - started, 1),
                "changes": [e["changed"] for e in events if "changed" in e],
                "errors": [e.get("error") or e.get("tool_error") for e in events if e.get("error") or e.get("tool_error")],
                "usage": [e["usage"] for e in events if "usage" in e]})
        assert any(e.get("done") for e in events), f"{label}: 未完了"
        assert not any(e.get("error") for e in events), f"{label}: SSEエラー"
        if execute:
            assert production_memory.read(store)["checkpoint"]["status"] == "completed", "ステップ上限"
        assert any(e.get("usage", {}).get("estimated") is False for e in events), "実トークン計測なし"
        preserved()
        print(f"{label}: completed ({result['stages'][-1]['seconds']}s)", flush=True)
        return events

    try:
        if await llm.health(args.base_url):
            raise RuntimeError("専用ポートが使用中です")
        await manager.start({"llm_base_url": args.base_url, "llm_model_path": args.model, "llm_ctx_size": "16384"})
        await turn("01-library-branch", "資料庫にキャラクター『リオ』を登録してください。プロフィールは『森の案内人』、外見は『黒髪』。"
            "場所『森の小屋』も登録してください。説明は『木造の小さな小屋』、雰囲気は『静か』です。"
            "その後、分かれ道(crossroads)から正史とは別の分岐ルートを2シーン作ってください。"
            "最初はアヤが森でリオと出会い、次は二人で森の小屋へ着く展開です。新しい人物・場所の登録IDを使ってください。"
            "既存の正史・結末・シーン本文は残し、正史の間には挿入しません。作業メモも更新してください。")
        rio = next(c for c in store.list_characters() if c["name"] == "リオ")
        hut = next(p for p in store.list_places() if p["name"] == "森の小屋")
        assert rio["profile"] == "森の案内人" and rio["appearance"] == "黒髪", "指定した人物設定の取りこぼし"
        assert hut["description"] == "木造の小さな小屋" and hut["atmosphere"] == "静か", "指定した場所設定の取りこぼし"
        new = [n for n in store.graph()["nodes"] if n["id"] not in {old["id"] for old in initial["nodes"]}]
        assert len(new) == 2, "分岐のシーン数が違う"
        head = next(n for n in new if store.parent_of(n["id"]) == "crossroads")
        tail = next(n for n in new if store.parent_of(n["id"]) == head["id"])
        assert rio["id"] in tail["cast"] and tail["location"] == hut["id"]
        assert all(n["group_id"] == store.get_node("crossroads")["group_id"] for n in new)
        assert all(n["status"] == "draft" for n in new)
        branch_events = {e["id"] for n in new for e in n["events"]}
        canon_state = store.get_state("return")
        assert not any(branch_events.intersection(c["memories"]) for c in canon_state["chars"].values())
        graph_before = store.graph()
        await turn("02-edit-library", "資料庫のリオの口調を『穏やかな敬語』に、森の小屋の雰囲気を『雨音が響く静けさ』に変更してください。"
            "小屋の説明は既存の『木造の小さな小屋』を残して『入口にひさしがある』を追記してください。"
            "プロフィール、外見、シーン本文と接続はそのまま残してください。")
        assert store.get_character(rio["id"])["voice"] == "穏やかな敬語"
        assert store.get_character(rio["id"])["appearance"] == rio["appearance"]
        assert store.get_place(hut["id"])["atmosphere"] == "雨音が響く静けさ"
        description = store.get_place(hut["id"])["description"]
        assert hut["description"] in description and "入口にひさしがある" in description
        hut = store.get_place(hut["id"])
        assert store.graph() == graph_before, "資料編集でシーンが変わった"
        events = await turn("03-instruction", f"分岐末尾のシーン({tail['id']})に赤いランタンを見つける描写を追加してください。",
            instruction=f"変更します。赤いランタンは追加しないでください。分岐末尾({tail['id']})で青い布を見つける描写だけを加えてください。人物・場所・既存の出来事は残してください。")
        assert any(e.get("instruction", {}).get("instruction", {}).get("status") == "reflected" for e in events)
        assert "青い布" in store.get_node(tail["id"])["beat"] and "赤いランタン" not in store.get_node(tail["id"])["beat"]
        assert store.get_node(head["id"])["beat"] == head["beat"], "途中指示で対象外の枝を変更"
        graph_before = store.graph()
        await turn("04-create-unused", "資料庫に未使用の試案としてキャラクター『仮人物』と場所『仮場所』を登録してください。名前だけでよく、シーンは追加・編集しません。")
        await turn("05-delete-unused", "資料庫の未使用の『仮人物』と『仮場所』を削除してください。他の人物・場所・シーンは変更しません。")
        assert {c["name"] for c in store.list_characters()} == {"アヤ", "リオ"}
        assert {p["name"] for p in store.list_places()} == {"村", "森の小屋"}
        assert store.graph() == graph_before, "未使用資料の操作でシーンが変わった"
        before = store.graph()
        library_before = (store.list_characters(), store.list_places())
        await turn("06-used-delete", "リオと森の小屋を資料庫から削除できますか。使用中なら削除や参照解除はせず、使用先を確認して説明してください。")
        assert store.get_character(rio["id"]) and store.get_place(hut["id"])
        assert store.graph() == before
        await turn("07-consult-only", "リオの名前を『別名』に変更し、森の小屋の説明を書き換えてください。", execute=False)
        assert store.get_character(rio["id"])["name"] == "リオ"
        assert store.get_place(hut["id"])["description"] == hut["description"]
        assert store.graph() == before
        assert (store.list_characters(), store.list_places()) == library_before
        result["passed"] = True
        print("LIBRARY BRANCH CHECK PASSED", flush=True)
    except BaseException as e:
        result["error"] = f"{type(e).__name__}: {e}"
        raise
    finally:
        (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        store.conn.close()
        await manager.stop_async()


if __name__ == "__main__":
    asyncio.run(main())
