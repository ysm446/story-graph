"""Ruri v3 埋め込み(news-picker の embed.py を踏襲)。

- 非対称プレフィックス必須(クエリ/文書で異なる。lm-chat はこれを欠いて精度を落としていた)
- CPU で実行。モデルはグローバルに 1 回だけロード(threading.Lock で二重ロード防止)
- sentence-transformers が無い / ロード失敗時は available() が False になり、
  検索は FTS のみに退化する(アプリは止めない)
"""

from __future__ import annotations

import logging
import threading
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)

MODEL_NAME = "cl-nagoya/ruri-v3-310m"
EMBEDDING_DIM = 768
QUERY_PREFIX = "検索クエリ: "
DOCUMENT_PREFIX = "検索文書: "

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / "models" / "embeddings"

_model = None
_load_failed = False
_lock = threading.Lock()


def _load_model_locked():
    """_lock を保持した状態で呼ぶこと。"""
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model
    try:
        from sentence_transformers import SentenceTransformer

        log.info("loading embedding model: %s", MODEL_NAME)
        _model = SentenceTransformer(
            MODEL_NAME, cache_folder=str(CACHE_DIR), device="cpu"
        )
    except Exception:  # noqa: BLE001
        log.exception("埋め込みモデルのロードに失敗。ベクトル検索なしで続行します")
        _load_failed = True
    return _model


def _get_model():
    if _model is not None or _load_failed:
        return _model
    with _lock:
        return _load_model_locked()


def available() -> bool:
    """検索経路から呼ばれる。warmup がロード中(初回はダウンロードで分単位)の
    ときにロック待ちするとイベントループごと固まるため、待たずに False を返して
    FTS のみで続行する(ロード完了後の検索からベクトルが効く)。"""
    if _model is not None:
        return True
    if _load_failed:
        return False
    if not _lock.acquire(blocking=False):
        return False
    try:
        return _load_model_locked() is not None
    finally:
        _lock.release()


def is_ready() -> bool:
    """ロード済みかを(ロードをトリガせずに)返す。"""
    return _model is not None


def warmup() -> None:
    """起動時にバックグラウンドで呼ぶ(初回ダウンロード・ロードを先に済ませる)。"""
    if available():
        embed_document("ウォームアップ")


@lru_cache(maxsize=512)
def _embed(text: str) -> tuple[float, ...]:
    model = _get_model()
    if model is None:
        raise RuntimeError("embedding model unavailable")
    vec = model.encode(text, normalize_embeddings=True, show_progress_bar=False)
    return tuple(float(v) for v in vec)


def embed_query(text: str) -> list[float]:
    return list(_embed(QUERY_PREFIX + text))


def embed_document(text: str) -> list[float]:
    return list(_embed(DOCUMENT_PREFIX + text))
