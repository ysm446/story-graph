"""記憶のハイブリッド検索(news-picker の search_vault.py を story-graph 用に移植)。

スコア = RRF(FTS5 trigram + ベクトル cosine) × 重要度 × 物語内時間減衰(spec §6.1)。
時間減衰は実時間ではなく正史パス上の story_order 距離の半減期式(spec §12)。半減期は作品ごとの設定。
分岐ノード上の記憶(story_order = -1)は「現在」扱い(距離 0)。
"""

from __future__ import annotations

import math
import re
import sqlite3
import struct
from typing import Any

import db
import embed

RRF_K = 60
# 何シーン前で重みが半分になるか。作品ごとの設定 memory_half_life で変えられる(設定 → 記憶の検索)。
# 既定は 100。以前は 20 固定で、150 シーンある作品では序盤の記憶の点数が 180 分の 1 になり、
# 検索の言葉にぴったり合っていても出てこなかった(2026-10-14 ユーザー報告)
HALF_LIFE_KEY = "memory_half_life"
HALF_LIFE_BEATS = 100.0
HALF_LIFE_CHOICES = (0, 20, 50, 100, 200)  # 0 = 古さを点数に反映しない


def half_life(settings: dict[str, str]) -> float | None:
    """設定から半減期(シーン数)を読む。None は「古さを点数に反映しない」。"""
    raw = settings.get(HALF_LIFE_KEY)
    if raw is None or raw == "":
        return HALF_LIFE_BEATS
    try:
        value = float(raw)
    except ValueError:
        return HALF_LIFE_BEATS
    return value if value > 0 else None
CANDIDATE_LIMIT = 50


def _fts_terms(query: str) -> list[str]:
    """trigram トークナイザ向けの検索語を生成する。

    日本語は助詞込みで一続きになり「語」単位では 3 文字未満(ケン、裏切 等)が
    多く trigram で照合できないため、連続文字列から文字トライグラムを
    ストライド 1 で切り出して OR 検索に使う(bm25 が重み付けする)。
    """
    runs = re.findall(r"[ぁ-んァ-ヶー一-龠a-zA-Z0-9]{3,}", query)
    terms: list[str] = []
    for run in runs:
        for i in range(len(run) - 2):
            gram = run[i : i + 3]
            if gram not in terms:
                terms.append(gram)
    return terms[:24]


def ensure_vectors(conn: sqlite3.Connection) -> None:
    """ベクトル未作成の記憶を埋め込む(モデル未ロード時の取りこぼしを自己修復)。"""
    if not db.has_vec(conn) or not embed.available():
        return
    rows = conn.execute(
        """SELECT m.id, m.content FROM memories m
           LEFT JOIN memories_vec v ON v.memory_id = m.id
           WHERE v.memory_id IS NULL"""
    ).fetchall()
    for r in rows:
        vector = embed.embed_document(r["content"])
        # vec0 仮想テーブルは版によって UPSERT 非対応なので DELETE → INSERT にする
        conn.execute("DELETE FROM memories_vec WHERE memory_id = ?", (r["id"],))
        conn.execute(
            "INSERT INTO memories_vec(memory_id, embedding) VALUES(?,?)",
            (r["id"], struct.pack(f"{len(vector)}f", *vector)),
        )
    if rows:
        conn.commit()


def _decayed_score(
    base: float, row: sqlite3.Row, current_order: int, half_life: float | None = HALF_LIFE_BEATS
) -> float:
    importance = row["importance"] if row["importance"] is not None else 0.5
    story_order = row["story_order"]
    distance = 0 if story_order is None or story_order < 0 else max(0, current_order - story_order)
    factor = math.pow(0.5, distance / half_life) if half_life else 1.0
    return base * max(importance, 0.1) * factor


def search_memories(
    conn: sqlite3.Connection,
    query: str,
    candidate_ids: set[str],
    current_order: int,
    top_k: int = 5,
    half_life: float | None = HALF_LIFE_BEATS,
) -> list[dict[str, Any]]:
    """candidate_ids(fold 済み state の記憶参照)の中から上位 top_k 件を返す。

    half_life は何シーン前で重みが半分になるか。None で物語内時間の減衰を掛けない
    (点数は RRF × 重要度だけ)。"""
    if not candidate_ids:
        return []
    ensure_vectors(conn)

    scores: dict[str, float] = {}

    # LIMIT を DB 全体に掛けてから候補で絞ると、記憶が増えたとき候補が上位 N から
    # 押し出されてスコアが付かなくなる。全順位を走査し、候補のヒットだけを数える
    terms = _fts_terms(query)
    if terms:
        match = " OR ".join(f'"{t}"' for t in terms)
        rank = 0
        try:
            for r in conn.execute(
                "SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank",
                (match,),
            ):
                if r["id"] in candidate_ids:
                    scores[r["id"]] = scores.get(r["id"], 0.0) + 1.0 / (RRF_K + rank + 1)
                    rank += 1
                    if rank >= CANDIDATE_LIMIT:
                        break
        except sqlite3.OperationalError:
            pass

    if db.has_vec(conn) and embed.available():
        vector = embed.embed_query(query)
        total = conn.execute("SELECT COUNT(*) FROM memories_vec").fetchone()[0]
        rank = 0
        for r in conn.execute(
            """SELECT memory_id, vec_distance_cosine(embedding, ?) AS distance
               FROM memories_vec ORDER BY distance ASC LIMIT ?""",
            (struct.pack(f"{len(vector)}f", *vector), total),
        ):
            if r["memory_id"] in candidate_ids:
                scores[r["memory_id"]] = scores.get(r["memory_id"], 0.0) + 1.0 / (RRF_K + rank + 1)
                rank += 1
                if rank >= CANDIDATE_LIMIT:
                    break

    if not scores:
        # 検索シグナルが無い場合は重要度×減衰のみで選ぶ(取りこぼし防止)
        scores = {mid: 1.0 for mid in candidate_ids}

    results: list[tuple[float, dict[str, Any]]] = []
    for memory_id, base in scores.items():
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
        if row is None:
            continue
        results.append((_decayed_score(base, row, current_order, half_life), dict(row)))
    results.sort(key=lambda pair: pair[0], reverse=True)
    return [row for _, row in results[:top_k]]
