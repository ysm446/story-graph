"""SQLite 接続とスキーマ管理。

スキーマは docs/story-graph-spec.md §3 が正。
FTS5 / sqlite-vec の索引テーブル(memories_fts / memories_vec)は
記憶 retrieval を組み込む Phase 2 で追加する。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "data" / "story-graph.db"

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS characters(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile TEXT,
  appearance TEXT,
  voice TEXT,
  color TEXT,
  graph_x REAL, graph_y REAL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS factions(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS faction_members(
  char_id TEXT,
  faction_id TEXT,
  PRIMARY KEY(char_id, faction_id)
);

CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY,
  title TEXT,
  beat TEXT NOT NULL,
  emotional_core TEXT,
  cast TEXT NOT NULL,
  location TEXT,
  story_time TEXT,
  status TEXT DEFAULT 'canon',
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS edges(
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  is_canon INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id, seq);

CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  content TEXT NOT NULL,
  emotion REAL,
  importance REAL,
  story_order INTEGER
);

CREATE TABLE IF NOT EXISTS state_cache(
  node_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  dirty INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS renders(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  pov_char TEXT,
  prose TEXT NOT NULL,
  stale INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS style_presets(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  person TEXT,
  tone TEXT,
  params TEXT
);

CREATE TABLE IF NOT EXISTS chats(
  id TEXT PRIMARY KEY,
  anchor_node TEXT,
  scope TEXT DEFAULT 'upto',
  messages TEXT NOT NULL,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);

-- 記憶の全文索引(trigram: 日本語の分かち書き不要。lm-chat の方式)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED, content, tokenize='trigram'
);
"""

_VEC_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  memory_id TEXT PRIMARY KEY, embedding FLOAT[768]
);
"""


def _try_load_vec(conn: sqlite3.Connection) -> bool:
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return True
    except Exception:  # noqa: BLE001
        return False


def has_vec(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT 1 FROM memories_vec LIMIT 1")
        return True
    except sqlite3.OperationalError:
        return False


def connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(db_path) if db_path else DEFAULT_DB_PATH
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    vec_loaded = _try_load_vec(conn)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    init_schema(conn)
    if vec_loaded:
        conn.executescript(_VEC_SCHEMA)
        conn.commit()
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    # 単純な列追加は冪等 ALTER で行う(lm-chat の作法)
    for ddl in (
        "ALTER TABLE nodes ADD COLUMN pos_x REAL",  # キャンバス上の手動配置(NULL = 自動レイアウト)
        "ALTER TABLE nodes ADD COLUMN pos_y REAL",
        "ALTER TABLE nodes ADD COLUMN image_path TEXT",  # シーン挿絵(装飾専用。LLM には渡さない)
        "ALTER TABLE characters ADD COLUMN portrait_path TEXT",  # プロフィール画像(切り抜き後。表示用)
        "ALTER TABLE characters ADD COLUMN portrait_source_path TEXT",  # 元画像(再クロップ用に保持)
        "ALTER TABLE characters ADD COLUMN portrait_crop TEXT",  # 切り抜きパラメータ(JSON。エディタ復元用)
        "ALTER TABLE chats ADD COLUMN char_id TEXT",  # NULL = 相談チャット。設定時はキャラとの会話
        "ALTER TABLE chats ADD COLUMN mode TEXT",  # キャラチャットの枠組み: interview | roleplay
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # 既に存在する
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < SCHEMA_VERSION:
        # 一回限りのデータ変換が必要になったらここに登録する(lm-chat の作法)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()
