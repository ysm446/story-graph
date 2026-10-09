"""6章・48シーンの制作実機検証。新規の検証ライブラリだけを操作する。

実行例: .venv/Scripts/python scripts/check-production-scenario.py --model path/to/model.gguf
全SSE、段階別グラフ、会話、チェック結果をdata/production-scenario-<id>へ残す。
"""
import argparse
import asyncio
import json
import re
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
    for cid, name, profile in [("aya", "アヤ", "洪水から故郷を守る水門技師。対立を対話で解く。"),
                               ("ken", "ケン", "アヤの幼なじみで記録係。和解を望む。"),
                               ("mio", "ミオ", "下流の診療所を守る医師。"),
                               ("ren", "レン", "水門の管理官。住民を守る責任を感じている。")]:
        store.create_character({"id": cid, "name": name, "profile": profile})
    chapters = [
        ("増水の町", ["雨の朝", "水位の記録", "幼なじみの相談", "古い水門図", "診療所の依頼", "出発の約束"]),
        ("上流調査", ["上流への道", "早すぎる告白", "管理官との対面", "水門の観察", "古文書の発見", "調査の報告"]),
        ("食い違う記録", ["役場の会議", "沈黙の理由", "記録係の決意", "避難の準備", "住民の反対", "夜の話し合い"]),
        ("閉じた水門", ["堤防の見回り", "管理官の説明", "修理の相談", "部品の不足", "共同作業", "夜明けの見通し"]),
        ("決壊前夜", ["最後の雨", "避難の合図", "診療所の移転", "水門の修理", "開門の判断", "濁流の通過"]),
        ("和解の朝", ["雨上がり", "残された記録", "謝罪の場", "和解の手紙", "新しい管理規約", "町の再出発"]),
    ]
    beats = [
        "長雨で水位が上がり、アヤは古い水門の異音に気づく。町へ警報を出す前に、目盛りが壊れていないかケンと確かめる。",
        "ケンは十年分の水位帳を並べ、同じ雨量でも今年だけ下流の水位が高いと知る。二人は記録の欠落した年に印を付ける。",
        "アヤは幼なじみのケンに、町を離れる予定を延期して調査したいと話す。ケンは過去の対立を棚上げし記録係を引き受ける。",
        "倉庫から見つかった旧水門図には、現在封鎖されている予備水路が描かれていた。アヤは図だけで開門せず、現物と照合すると決める。",
        "ミオは診療所の患者が急な避難に耐えられないと訴える。アヤは下流の準備ができるまで、水を放流しないと約束する。",
        "ケンは住民に調査の目的を説明し、アヤと上流へ向かう。調査結果を隠さず町へ伝えることを二人の約束にする。",
        "上流へ向かう途中、二人は本流へ流れ込まない小川を見る。水門だけでなく予備水路にも土砂がたまっている可能性を記録する。",
        "アヤは古文書を根拠に、レンが管理規約を書き換えた事実をケンへ告白する。責める前に当時の判断の理由を聞こうと二人で決める。",
        "レンは水門への立入りを渋るが、診療所の避難計画を見て調査に同行する。アヤは管理官の責任を奪わず協力を求める。",
        "三人は水門の歯車の欠けと予備水路の閉塞を確認する。一気に開けると下流へ濁流が出るため、小刻みな操作と水路の清掃が必要だと分かる。",
        "ケンは水門小屋で古文書を初めて発見する。旧規約の放流基準にはレンの筆跡による訂正があり、災害時の判断を変更した痕跡が残っている。",
        "アヤは現場の損傷と規約の改訂を分けて報告する。誰の責任かを決める前に、住民の安全を確保する必要があると役場へ伝える。",
        "役場で水門をすぐ開ける案と避難を先にする案が対立する。ケンは水位帳と患者数を机に並べ、判断材料を全員で共有する。",
        "レンは改訂について沈黙していた理由を話す。以前の放流で下流に被害を出した記憶から、決断を一人で抱え込んでいたと認める。",
        "ケンは記録を権力者だけに預けず、住民も読めるように残すと決意する。アヤに、都合の悪い事実も隠さないと約束する。",
        "ミオは患者の移動順と付き添いを決め、アヤは高台までの通路を点検する。雨が強まる前に薬と食料だけでも運び出す。",
        "商店主たちは避難で店を失うと反対する。ケンは命を守る準備と財産の記録を並行して進める案を出し、協力を求める。",
        "夜の集会でレンは過去の改訂を説明し、アヤは彼を追放しても歯車は直らないと話す。住民は修理と避難を共同で行うことに同意する。",
        "雨の中で堤防を見回ったアヤとケンは、水があふれそうな低い箇所を確認する。ミオへ連絡し、その地区の避難を早める。",
        "レンは歯車を無理に回せば軸が折れると説明する。操作の経験を住民に伝え、一人だけで判断するやり方を改めようとする。",
        "アヤとケンは修理の順序を相談し、清掃班と歯車の交換班に分ける。下流の避難完了の知らせが届くまで試運転はしないと決める。",
        "交換用の歯車が一つ足りず、役場の倉庫でも見つからない。レンは使われなくなった予備装置から部品を外す案を出す。",
        "住民が土砂を運び、アヤは部品を削って軸に合わせる。ケンは作業と水位を記録し、失敗しても同じ手順を繰り返さないようにする。",
        "夜明け前、予備水路に細い流れが戻る。まだ危機は去っていないが、段階的な開門で水を逃がせる見通しが立つ。",
        "最後の強い雨が山に降り、水位の上昇が速まる。アヤは焦って全開にせず、下流からの避難完了を待ちながら補強を続ける。",
        "ケンが合図を送り、各地区の責任者が人数を確認する。全員が高台へ着いたか、行方の分からない住民がいないかを照合する。",
        "ミオは最後の患者を高台の仮設診療所へ運ぶ。薬箱と診療記録も無事に届き、下流の診療所を離れたことを知らせる。",
        "アヤは最後の歯車を固定し、レンと一緒に少しだけ回す。異音が消えたことを確認してから住民へ試運転の成功を伝える。",
        "避難完了の報告を受け、住民の代表とレンが開門を決める。アヤは目盛りごとに止めて水位を確かめ、放流量を調整する。",
        "濁流は予備水路へ分散して町を通り抜ける。ケンは決定と操作の時刻を残し、誰か一人の英雄談にしないと考える。",
        "雨が上がり、住民は高台から町の被害を見渡す。建物の修理は必要だが人命は守られ、ミオは患者を急いで戻さないと決める。",
        "ケンは今回の記録を旧水位帳と一緒に保管する。アヤは失敗も成功も次の世代が読めるよう、住民へ複写を配る。",
        "レンは改訂を隠したことを謝罪する。住民は責任を問いながらも、今後は判断を公開し複数人で確認するよう求める。",
        "アヤはレンに和解の手紙を渡す。水門の責任を一人に負わせず、住民と管理官がともに守ると約束する。暴力での解決は選ばない。",
        "住民と管理官が新しい管理規約を作り、避難と開門の順序を定める。ケンは署名だけでなく反対意見も記録に残す。",
        "町の修理が始まり、アヤは新しい当番へ水門の点検方法を教える。ミオが診療所を再開する日、四人は橋の上から穏やかな川を眺める。",
    ]
    for ci, (chapter, titles) in enumerate(chapters):
        for offset, title in enumerate(titles):
            number = ci * 6 + offset + 1
            beat = beats[number - 1]
            store.append_node({"id": f"n{number:02}", "title": title, "beat": beat, "cast": ["aya", "ken"]})
    for ci, (title, _) in enumerate(chapters):
        ids = [f"n{ci*6+i:02}" for i in range(1, 7)]
        if ci in (1, 2, 4):
            parent = f"n{ci*6+2:02}"
            for j in range(1, 4):
                nid = f"b{ci}_{j}"
                store.append_node({"id": nid, "title": f"{title}の別案{j}",
                    "beat": f"正史とは別の案。アヤは第{j}の聞き取り先へ向かい、住民の証言を残す。この枝は結末にはつながっていない。",
                    "cast": ["aya"]}, parent_id=parent, force_draft=True)
                ids.append(nid)
                parent = nid
        store.create_group(title, ids)
    for j in range(1, 4):
        store.append_node({"id": f"d{j:02}", "title": f"未接続の後日談{j}",
            "beat": f"未採用の後日談案{j}。ミオが診療所の箱を整理し、住民から届いた手紙を読み返す。まだどの経路にも接続していない。",
            "cast": ["mio"]}, detached=True)

    for nid, char, content in [
        ("n04", "aya", "旧水門図には予備水路がある"),
        ("n11", "ken", "古文書にレンの筆跡が残る"),
        ("n27", "mio", "診療所の患者を全員移転できた"),
        ("b1_3", "aya", "別案でだけ聞いた、水路の秘密の合図"),
    ]:
        store.replace_events(nid, [{"type": "memory_add", "source": "user", "payload": {
            "char": char, "content": content, "importance": 0.7}}])


def bodies(store):
    return {n["id"]: (n["title"], n["beat"], n["cast"], n["events"]) for n in store.graph()["nodes"]}


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8089")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--addition-only", action="store_true", help="追記で既存の公開方針と矛盾する秘密設定を足さないか確認する")
    mode.add_argument("--manual-only", action="store_true", help="実モデルの編集確定前に一時停止し、手動変更を保存して再開する")
    args = parser.parse_args()
    root = ROOT / "data" / ("production-scenario-" + uuid.uuid4().hex[:8])
    root.mkdir(parents=True)
    store = Store(db.connect(root / "story-graph.db"), root=str(root))
    embed.available = lambda: False
    embed.is_ready = lambda: False
    seed(store)
    manager = LlamaManager()
    summary = []
    result = {"passed": False, "model": args.model, "chapters": 6, "scenes": 48}
    print(f"RESULT: {root}", flush=True)
    async def turn(label, prompt, execute=True, policy=None, instruction=None, manual_node=None):
        events = []
        started = time.monotonic()
        pending = None
        async def interrupt():
            await asyncio.sleep(0.5)
            production.gate.run.submit("scenario-direction", instruction)
        async def manual_edit():
            paused_graph = store.graph()
            await asyncio.sleep(1)
            assert store.graph() == paused_graph, "一時停止中にグラフが変わった"
            node_operations.update(store, manual_node, {"beat": store.get_node(manual_node)["beat"]
                + "青い封筒は診療所の鍵付きの棚で保管し、住民が閲覧を求めたときはミオが開ける。"})
            (root / f"{label}-manual-graph.json").write_text(
                json.dumps(store.graph(), ensure_ascii=False, indent=2), encoding="utf-8")
            production.gate.run.set_paused(False)
        try:
            async with asyncio.timeout(360):
                async for raw in production.stream(store, args.base_url, None, prompt, execute, lambda: None, policy=policy):
                    e = json.loads(raw.removeprefix("data: "))
                    events.append(e)
                    if instruction and pending is None and e.get("stage"):
                        pending = asyncio.create_task(interrupt())
                    if manual_node and pending is None and e.get("active_node") == manual_node and e.get("stage") == production.TOOL_LABELS["update_scene"]:
                        production.gate.run.set_paused(True)
                        pending = asyncio.create_task(manual_edit())
                    if e.get("changed") or e.get("error") or e.get("tool_error"):
                        print(label, json.dumps(e, ensure_ascii=False), flush=True)
        finally:
            if pending:
                if not pending.done():
                    pending.cancel()
                outcomes = await asyncio.gather(pending, return_exceptions=True)
                if any(isinstance(outcome, Exception) for outcome in outcomes):
                    raise RuntimeError(f"途中操作に失敗: {outcomes}")
            (root / f"{label}-events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
            (root / f"{label}-graph.json").write_text(json.dumps(store.graph(), ensure_ascii=False, indent=2), encoding="utf-8")
            (root / f"{label}-prompts.json").write_text(json.dumps(list(llm.PROMPT_LOG), ensure_ascii=False, indent=2), encoding="utf-8")
            for event in events:
                if event.get("chat_id"):
                    (root / f"{label}-chat.json").write_text(json.dumps(store.get_chat(event["chat_id"]), ensure_ascii=False, indent=2), encoding="utf-8")
                    break
        assert not any(e.get("error") for e in events), f"{label}: SSE error"
        if manual_node:
            assert pending is not None and not pending.cancelled(), "手動編集への切替が未実行"
        assert any(e.get("done") for e in events), f"{label}: unfinished"
        checkpoint = production_memory.read(store)["checkpoint"]
        if execute:
            assert checkpoint["status"] == "completed", f"{label}: step limit"
        summary.append({"stage": label, "seconds": round(time.monotonic()-started, 1),
                        "changes": [e["changed"] for e in events if "changed" in e],
                        "steps": sum(e.get("stage", "").startswith("確認しています") for e in events),
                        "memory_revision": production_memory.read(store)["revision"],
                        "tool_errors": [e["tool_error"] for e in events if "tool_error" in e]})
        print(f"{label}: completed in {summary[-1]['seconds']}s", flush=True)
        return events
    try:
        if await llm.health(args.base_url):
            raise RuntimeError("専用ポートが使用中です")
        await manager.start({"llm_base_url": args.base_url, "llm_model_path": args.model, "llm_ctx_size": "16384"})
        if args.manual_only:
            before = bodies(store)
            edges_before = store.graph()["edges"]
            canon_before = store.canon_path()
            ending_before = store.active_ending()
            events = await turn("manual-resume", "記録係の決意(n15)に『青い封筒』を保管する決意を加えてください。既存の公開方針は維持し、他のシーンや接続は変更しません。",
                policy=production.ProductionPolicy(store, allowed_ids=["n15"], protected_ids=["n34"]), manual_node="n15")
            assert any("未確定の操作を破棄" in e.get("tool_error", "") for e in events), "旧操作の破棄通知なし"
            beat = store.get_node("n15")["beat"]
            assert all(word in beat for word in ("青い封筒", "診療所", "鍵付き", "棚", "住民", "ミオ")), "手動変更の取りこぼし"
            assert {nid for nid in before if before[nid] != bodies(store)[nid]} == {"n15"}
            assert store.graph()["edges"] == edges_before and store.canon_path() == canon_before and store.active_ending() == ending_before
            after = store.graph()
            await turn("manual-no-repeat", "前回依頼した青い封筒の保管が実際の本文で完了しているか確認してください。診療所の鍵付きの棚で保管し、住民の閲覧時にミオが開ける設定です。完了済みなら編集せず報告してください。",
                policy=production.ProductionPolicy(store, allowed_ids=["n15"], protected_ids=["n34"]))
            assert store.graph() == after, "完了した手動変更を重ねて編集した"
            result["passed"] = True
            print("MANUAL RESUME CHECK PASSED", flush=True)
            return
        if args.addition_only:
            before = bodies(store)
            await turn("addition", "記録係の決意(n15)に『青い封筒』を保管する決意を加えてください。", policy=production.ProductionPolicy(store, allowed_ids=["n15"]))
            assert {nid for nid in before if before[nid] != bodies(store)[nid]} == {"n15"}
            beat = store.get_node("n15")["beat"]
            assert "青い封筒" in beat and "住民" in beat
            assert "誰にも渡さず" not in beat and "秘密" not in beat
            result["quality_findings"] = (["依頼にない証拠という意味付けが追加された。文章の忠実さは要確認。"] if "証拠" in beat else [])
            result["passed"] = True
            print("ADDITION OPERATION CHECK PASSED", result["quality_findings"], flush=True)
            return
        initial = store.graph()
        events = await turn("01-read", "全体の構成を確認してください。正史は何章・何シーンか、結末につながらない枝3つを分岐元→枝の先頭の両IDで、未接続の後日談3つをIDで挙げ、早すぎる告白の前後関係の問題を本文で確かめて説明してください。編集はしません。", False)
        text = "".join(e.get("delta", "") for e in events)
        assert all(nid in text for nid in ("b1_1", "b2_1", "b4_1", "d01", "d02", "d03")), "枝・未接続の列挙漏れ"
        assert re.search(r"6\s*章", text) and re.search(r"36\s*シーン", text), "章数またはシーン数の誤り"
        assert store.graph() == initial
        before = bodies(store)
        await turn("02-reconnect", "早すぎる告白(n08)を1シーンだけ古文書の発見(n11)の直後に移してください。その後、別案の枝b1_1を子孫b1_2,b1_3ごと水門の観察(n10)の後ろへ付け替えてください。本文やシーン数は変更せず、和解の手紙(n34)は残してください。", policy=production.ProductionPolicy(store, protected_ids=["n34"]))
        assert store.parent_of("n08") == "n11" and store.parent_of("b1_1") == "n10"
        assert store.parent_of("b1_2") == "b1_1" and store.parent_of("b1_3") == "b1_2"
        assert bodies(store) == before
        before = bodies(store)
        events = await turn("03-instruction", "沈黙の理由(n14)の本文を補強してください。", policy=production.ProductionPolicy(store, allowed_ids=["n14", "n15"], protected_ids=["n34"]),
            instruction="方針変更です。n14は変更せず残し、今回は記録係の決意(n15)だけに『青い封筒』を保管する決意を加えてください。次回は未接続の後日談d01にミオが『赤いマフラー』を見つける展開を加える予定です。その次回作業をメモに残してください。今回はd01を編集しません。和解を守り、暴力では解決しません。")
        assert any(e.get("instruction", {}).get("instruction", {}).get("status") == "reflected" for e in events)
        after = bodies(store)
        assert {nid for nid in before if before[nid] != after[nid]} == {"n15"}
        assert "青い封筒" in store.get_node("n15")["beat"]
        assert "赤いマフラー" in production_memory.read(store)["content"]
        # 作者の追記を挟み、メモより現在の本文が優先されることも確認する。
        node_operations.update(store, "d01", {"beat": store.get_node("d01")["beat"] + "手紙は燃やさず保管する。"})
        store.conn.close()
        store = Store(db.connect(root / "story-graph.db"), root=str(root))
        before = bodies(store)
        await turn("04-resume", "作業メモにある次の作業を進めてください。現在の本文の内容は残してください。", policy=production.ProductionPolicy(store, allowed_ids=["d01"], protected_ids=["n34"]))
        assert {nid for nid in before if before[nid] != bodies(store)[nid]} == {"d01"}
        assert "赤いマフラー" in store.get_node("d01")["beat"] and "保管" in store.get_node("d01")["beat"]
        before = store.graph()
        await turn("05-no-repeat", "前回の作業が完了しているか、メモと実際の本文を照合してください。完了済みならシーンや接続を変更せず、次の依頼待ちと報告してください。", policy=production.ProductionPolicy(store, allowed_ids=["d01"], protected_ids=["n34"]))
        assert store.graph() == before, "完了済み操作を繰り返した"
        baseline = bodies(store)
        events = await turn("06-create", "修理の相談(n21)の直前、管理官の説明(n20)の直後に、アヤとケンが住民の合意を確かめる短いシーンを1つ追加してください。既存シーンの本文は変更しません。", policy=production.ProductionPolicy(store, protected_ids=["n34"]))
        additions = [e["changed"]["node_id"] for e in events if e.get("changed", {}).get("action") == "insert_scene"]
        assert len(additions) == 1 and len(bodies(store)) == len(baseline) + 1
        inserted = additions[0]
        assert store.parent_of(inserted) == "n20" and store.parent_of("n21") == inserted
        assert all(bodies(store)[nid] == value for nid, value in baseline.items())
        await turn("07-delete", f"先ほど追加したシーン({inserted})だけを削除し、n20とn21を直結してください。他のシーンは変更しません。", policy=production.ProductionPolicy(store, protected_ids=["n34"]))
        assert bodies(store) == baseline and store.parent_of("n21") == "n20"
        assert len(store.canon_path()) == 36
        production.node_operations._check_connections(store.graph())
        branch_memories = {e["id"] for e in store.list_events("b1_3")}
        assert not branch_memories.intersection(store.get_state("n36")["chars"]["aya"]["memories"]), "枝の記憶が正史へ混入"
        assert branch_memories.issubset(set(store.get_state("b1_3")["chars"]["aya"]["memories"]))
        result["passed"] = True
        print("SCENARIO CHECK PASSED", flush=True)
    except BaseException as e:
        result["error"] = f"{type(e).__name__}: {e}"
        raise
    finally:
        (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        (root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        store.conn.close()
        await manager.stop_async()


if __name__ == "__main__":
    asyncio.run(main())
