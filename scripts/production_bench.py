"""制作チャットの固定シナリオ集を同じ条件で繰り返し回し、改善の前後を比べる。

既存の実機検証(check-production-*.py)は 1 回ずつ手で回して読む形で、ハーネスやプロンプトを直すたびに
「前より良くなったか」を数で比べられなかった(2026-10-25 レビュー)。ここでは小さい作品に対する短い依頼を
ケースとして固定し、各ケースを N 回ずつ新規ライブラリで実行して、合否・ステップ数・ツールエラー・所要時間・
終了理由を集計する。結果は data/test/production-bench-<id>/ に残し、--compare で前回の summary.json と並べる。

実行例(起動済みの llama-server を使う。ユーザーのモデルを落とさないよう別ポートを使う):
  .venv/Scripts/python scripts/production_bench.py --base-url http://127.0.0.1:8089 --repeat 3 --label before
  .venv/Scripts/python scripts/production_bench.py --model D:/ai-models/llm/xxx.gguf --repeat 3 --label after \
      --compare data/test/production-bench-xxxx/summary.json
  .venv/Scripts/python scripts/production_bench.py --fake      # モデル無しでハーネス自体の動作を確かめる

合否はケースごとの決定的な条件(保存結果)で判定し、ステップ数・エラー数は参考値。少数試行なので成功率は目安。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

import db  # noqa: E402
import embed  # noqa: E402
import generation  # noqa: E402
import llm  # noqa: E402
import production_agent as production  # noqa: E402
import production_continuity  # noqa: E402
import production_metrics  # noqa: E402
from llama_manager import LlamaManager  # noqa: E402
from store import Store  # noqa: E402

DEPARTURE = "アヤは何も告げず村を出る。幼なじみのケンには、戻る日を伝えなかった。"
RETURN = "アヤは村に戻り、ケンと和解する。二人は川辺で長い話をした。"
PATCH_TEXT = "村を守る方法を探すためだった。"


def seed(store):
    store.create_character({"id": "aya", "name": "アヤ", "profile": "村を守りたい旅人"})
    store.create_character({"id": "ken", "name": "ケン", "profile": "アヤの幼なじみ"})
    store.create_place({"id": "village", "name": "村", "description": "川沿いの小さな村"})
    store.append_node({"id": "departure", "title": "出発", "beat": DEPARTURE, "cast": ["aya", "ken"], "location": "village"})
    store.append_node({"id": "return", "title": "帰還", "beat": RETURN, "cast": ["aya", "ken"], "location": "village"})


def _beats(store):
    return {n["id"]: n["beat"] for n in store.graph()["nodes"] if n.get("kind") is None}


# ---- ケース。check は失敗の理由の一覧を返す(空なら合格) ---------------------------------------

def check_insert_and_edit(store, events, changes):
    issues = []
    if sum(c["action"] == "insert_scene" for c in changes) != 1:
        issues.append("挿入が 1 回でない")
    if not any(c["action"] == "update_scene" and c["node_id"] == "departure" for c in changes):
        issues.append("出発の編集が無い")
    if len(store.canon_path()) != 3:
        issues.append(f"正史が {len(store.canon_path())} シーン")
    if store.get_node("return")["beat"] != RETURN:
        issues.append("帰還が変わった")
    return issues


def check_patch_exact(store, events, changes):
    issues = []
    if store.get_node("departure")["beat"] != DEPARTURE + PATCH_TEXT:
        issues.append("追記が指定の文と完全一致しない: " + store.get_node("departure")["beat"][-40:])
    if len(changes) != 1:
        issues.append(f"変更が {len(changes)} 件")
    return issues


def check_no_change(store, events, changes):
    issues = []
    if changes:
        issues.append("編集してはいけない依頼で変更した")
    if not any(e.get("delta") for e in events):
        issues.append("回答が無い")
    return issues


def check_scope(store, events, changes):
    issues = []
    if store.get_node("return")["beat"] != RETURN:
        issues.append("保護した帰還が変わった")
    if not any(c["action"] in ("update_scene",) and c["node_id"] == "departure" for c in changes):
        issues.append("出発が編集されていない")
    if any(c["action"] in ("insert_scene", "branch_scene", "delete_scene") for c in changes):
        issues.append("追加・削除をした")
    return issues


def check_branch(store, events, changes):
    issues = []
    if sum(c["action"] == "branch_scene" for c in changes) != 1:
        issues.append("分岐の作成が 1 回でない")
    if store.canon_path() != ["departure", "return"]:
        issues.append("正史が変わった")
    if any(c["action"] == "insert_scene" for c in changes):
        issues.append("分岐の代わりに挿入した")
    return issues


def check_chapter_new_scenes(store, events, changes):
    issues = []
    groups = store.list_groups()
    if len(groups) != 1:
        issues.append(f"章が {len(groups)} 個")
    else:
        inside = [nid for nid in groups[0]["node_ids"] if (store.get_node(nid) or {}).get("kind") is None]
        if len(inside) != 2:
            issues.append(f"章の中のシーンが {len(inside)} 件")
    if len(store.canon_path()) != 4:
        issues.append(f"正史が {len(store.canon_path())} シーン")
    for nid, text in (("departure", DEPARTURE), ("return", RETURN)):
        if store.get_node(nid)["beat"] != text:
            issues.append(f"{nid} が変わった")
    return issues


CASES = {
    "insert_and_edit": {
        "prompt": "出発と帰還の間に、アヤがケンとの約束を思い出すシーンを1つ挿入してください。"
                  "さらに出発の本文を、村を守る方法を探すために旅立つと分かるよう修正してください。"
                  "既存のキャラだけを使い、削除はしないでください。この2つの変更ができたら終了してください。",
        "execute": True, "check": check_insert_and_edit,
    },
    "patch_exact": {
        "prompt": f"出発(departure)の本文の末尾に、次の一文をそのまま追記してください: 「{PATCH_TEXT}」他の文は変えないでください。",
        "execute": True, "check": check_patch_exact,
    },
    "question_only": {
        "prompt": "出発と帰還の間にどのような場面を入れると自然でしょうか?意見だけを聞かせてください。編集はしないでください。",
        "execute": True, "check": check_no_change,
    },
    "ambiguous": {
        "prompt": "そのシーンをさっきの案に直してください。",
        "execute": True, "check": check_no_change,
    },
    "scope": {
        "prompt": "出発と帰還の本文を補強してください。出発は村を守る方法を探すために旅立つことを明記してください。"
                  "画面の変更範囲と保護条件を守り、変更できない部分は報告してください。",
        "execute": True, "check": check_scope,
        "policy": lambda store: production.ProductionPolicy(store, allowed_ids=["departure"], protected_ids=["return"]),
    },
    "branch": {
        "prompt": "出発(departure)から分岐して、アヤが村を出ずに森へ向かう別ルートの先頭シーンを1つ作ってください。正史は変えないでください。",
        "execute": True, "check": check_branch,
    },
    "chapter_new_scenes": {
        "prompt": "出発と帰還の間に新しい章「森の夜」を作り、アヤが森で一夜を過ごすシーンを2つ、その章の中に入れてください。"
                  "出発と帰還の本文は変えないでください。",
        "execute": True, "check": check_chapter_new_scenes,
    },
}


# ---- --fake: モデル無しでハーネス自体を確かめるための台本 ------------------------------------------

def _call(name, args):
    return {"content": "", "tool_calls": [{"function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


def fake_script(case, store):
    scene = {"cast": ["aya"], "reason": "依頼に従う"}
    if case == "insert_and_edit":
        return [_call("insert_scene", {"after_id": "departure", "title": "約束", "beat": "アヤはケンとの約束を思い出す。", **scene}),
                _call("update_scene", {"node_id": "departure", "beat": DEPARTURE + "村を守る方法を探すためだ。", "reason": "目的を明記"}),
                {"content": "2 件の変更を終えました。"}]
    if case == "patch_exact":
        return [_call("patch_scene", {"node_id": "departure", "mode": "append", "text": PATCH_TEXT, "reason": "追記"}),
                {"content": "追記しました。"}]
    if case in ("question_only", "ambiguous"):
        return [{"content": "対象を確認させてください。" if case == "ambiguous" else "川辺で別れを惜しむ場面が自然です。"}]
    if case == "scope":
        return [_call("update_scene", {"node_id": "departure", "beat": DEPARTURE + "村を守る方法を探すためだ。", "reason": "目的を明記"}),
                {"content": "帰還は保護されているので変更していません。"}]
    if case == "branch":
        return [_call("branch_scene", {"after_id": "departure", "title": "森へ", "beat": "アヤは村を出ずに森へ向かう。", **scene}),
                {"content": "分岐を作りました。"}]
    if case == "chapter_new_scenes":
        def after_create():
            group = store.list_groups()[0]
            return group["in_id"]
        return [_call("create_chapter", {"title": "森の夜", "node_ids": [], "after_id": "departure", "reason": "章を作る"}),
                lambda: _call("insert_scene", {"after_id": after_create(), "title": "森の夕暮れ", "beat": "アヤは森で火を起こす。", **scene}),
                lambda: _call("insert_scene", {"after_id": store.canon_path()[1], "title": "森の夜明け", "beat": "アヤは夜明けの森で目を覚ます。", **scene}),
                {"content": "章と 2 シーンを作りました。"}]
    raise KeyError(case)


def install_fake(case, store):
    responses = iter(fake_script(case, store))

    async def stream(messages, **kwargs):
        item = next(responses)
        if callable(item):
            item = item()
        if item.get("content"):
            yield "content", item["content"]
        yield "done", item
    llm.chat_stream_tools = stream

    async def extract(candidate, base_url, node_id):
        return candidate.replace_events(node_id, [])
    generation.extract_events = extract

    async def continuity(*args):
        return None
    production_continuity.check = continuity

    async def suggest(*args, **kwargs):
        return {"found": False, "evidence": "", "elapsed_unit": None, "elapsed_count": None, "location": None, "label": None}
    generation.suggest_scene_setting = suggest

    async def count(text, **kwargs):
        return None
    llm.count_tokens = count

    async def chat_json(messages, **kwargs):
        # 計画係・途中指示の照合などの構造化出力。台本では計画なし
        return {"needs_plan": False, "steps": [], "note": "", "cancelled_node_ids": [], "remaining": ""}
    llm.chat_json = chat_json


# ---- 実行と集計 ---------------------------------------------------------------------------------

async def run_case(name, case, root, base_url, fake):
    run_root = root / name
    run_root.mkdir(parents=True, exist_ok=True)
    store = Store(db.connect(run_root / "story-graph.db"), root=str(run_root))
    seed(store)
    if fake:
        install_fake(name, store)
    policy = case["policy"](store) if case.get("policy") else None
    events = []
    started = time.monotonic()
    try:
        async with asyncio.timeout(600):
            async for raw in production.stream(store, base_url, None, case["prompt"], case["execute"], lambda: None, policy=policy):
                events.append(json.loads(raw.removeprefix("data: ")))
    except Exception as e:  # noqa: BLE001 — 失敗も記録して次のケースへ進む
        events.append({"error": f"{type(e).__name__}: {e}"})
    seconds = round(time.monotonic() - started, 1)
    changes = [e["changed"] for e in events if "changed" in e]
    try:
        issues = case["check"](store, events, changes)
    except Exception as e:  # noqa: BLE001
        issues = [f"判定中の例外: {type(e).__name__}: {e}"]
    if any(e.get("error") for e in events):
        issues.append("SSE error: " + str(next(e["error"] for e in events if e.get("error"))))
    metrics = production_metrics.summarize(events)
    (run_root / "events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_root / "prompts.json").write_text(json.dumps(list(llm.PROMPT_LOG), ensure_ascii=False, indent=2), encoding="utf-8")
    (run_root / "graph.json").write_text(json.dumps(store.graph(), ensure_ascii=False, indent=2), encoding="utf-8")
    store.conn.close()
    return {"case": name, "passed": not issues, "issues": issues, "seconds": seconds, "metrics": metrics}


def aggregate(runs):
    cases = {}
    for name in dict.fromkeys(r["case"] for r in runs):
        items = [r for r in runs if r["case"] == name]
        cases[name] = {
            "runs": len(items), "pass": sum(r["passed"] for r in items),
            "steps_mean": round(statistics.fmean(r["metrics"]["steps"] or 0 for r in items), 1),
            "tool_errors_mean": round(statistics.fmean(r["metrics"]["tool_errors"] for r in items), 1),
            "seconds_mean": round(statistics.fmean(r["seconds"] for r in items), 1),
            "outcomes": dict(Counter(r["metrics"]["outcome"] for r in items)),
            "failures": [issue for r in items for issue in r["issues"]],
        }
    return cases


def render(summary, previous=None):
    lines = [f"# 制作ベンチ {summary['label']}", "",
             f"作成日時: {summary['created_at']}", "",
             f"モデル: {summary.get('model') or summary.get('base_url')} / 繰り返し: {summary['repeat']}", ""]
    head = "| ケース | 合格 | ステップ平均 | ツールエラー平均 | 秒平均 | 終了理由 |"
    if previous:
        head = "| ケース | 合格(前 → 今) | ステップ平均(前 → 今) | ツールエラー平均(前 → 今) | 秒平均(前 → 今) | 終了理由 |"
    lines += [head, "|---|---:|---:|---:|---:|---|"]
    for name, c in summary["cases"].items():
        outcomes = ", ".join(f"{k}×{v}" for k, v in c["outcomes"].items())
        if previous and name in previous["cases"]:
            p = previous["cases"][name]
            lines.append(f"| {name} | {p['pass']}/{p['runs']} → {c['pass']}/{c['runs']} | {p['steps_mean']} → {c['steps_mean']} | "
                         f"{p['tool_errors_mean']} → {c['tool_errors_mean']} | {p['seconds_mean']} → {c['seconds_mean']} | {outcomes} |")
        else:
            lines.append(f"| {name} | {c['pass']}/{c['runs']} | {c['steps_mean']} | {c['tool_errors_mean']} | {c['seconds_mean']} | {outcomes} |")
    failures = [(name, f) for name, c in summary["cases"].items() for f in c["failures"]]
    if failures:
        lines += ["", "## 不合格の理由", ""] + [f"- {name}: {f}" for name, f in failures]
    return "\n".join(lines) + "\n"


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:8089")
    parser.add_argument("--model", help="専用ポートで llama-server を起動するモデル。省略時は base-url の起動済みサーバーを使う")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--cases", help="カンマ区切りのケース名。省略時は全部: " + ", ".join(CASES))
    parser.add_argument("--label", default="")
    parser.add_argument("--compare", help="前回の summary.json。表に前 → 今で並べる")
    parser.add_argument("--fake", action="store_true", help="モデルを使わず台本で動かし、ハーネス自体を確かめる")
    parser.add_argument("--ctx", type=int, default=32768, help="--model で起動するときのコンテキスト長(アプリの設定に合わせて 8192 なども)")
    args = parser.parse_args()
    names = [n.strip() for n in args.cases.split(",")] if args.cases else list(CASES)
    unknown = [n for n in names if n not in CASES]
    if unknown:
        parser.error("不明なケース: " + ", ".join(unknown))
    root = ROOT / "data" / "test" / ("production-bench-" + uuid.uuid4().hex[:8])
    root.mkdir(parents=True)
    embed.available = lambda: False
    embed.is_ready = lambda: False
    manager = LlamaManager()
    runs = []
    try:
        if args.model and not args.fake:
            if await llm.health(args.base_url):
                raise RuntimeError("専用ポートが使用中です。別の base-url を指定してください")
            await manager.start({"llm_base_url": args.base_url, "llm_model_path": args.model, "llm_ctx_size": str(args.ctx)})
        for i in range(args.repeat):
            for name in names:
                production.gate = production.ProductionGate()
                result = await run_case(name, CASES[name], root / f"{i + 1:02}", args.base_url, args.fake)
                runs.append(result)
                print(f"{i + 1:02} {name}: {'PASS' if result['passed'] else 'FAIL ' + '; '.join(result['issues'])} "
                      f"({result['seconds']}s) METRICS " + production_metrics.describe(result["metrics"]), flush=True)
    finally:
        summary = {"label": args.label or root.name, "created_at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
                   "model": args.model, "base_url": args.base_url, "repeat": args.repeat, "fake": args.fake, "ctx": args.ctx if args.model else None,
                   "cases": aggregate(runs), "runs": runs}
        (root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        previous = json.loads(Path(args.compare).read_text(encoding="utf-8")) if args.compare else None
        (root / "summary.md").write_text(render(summary, previous), encoding="utf-8")
        print(render(summary, previous), flush=True)
        print(f"RESULT: {root}", flush=True)
        if args.model and not args.fake:
            await manager.stop_async()
    total = sum(c["pass"] for c in summary["cases"].values())
    count = sum(c["runs"] for c in summary["cases"].values())
    sys.exit(0 if total == count else 1)


if __name__ == "__main__":
    asyncio.run(main())
