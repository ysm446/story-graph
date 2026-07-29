"""SQLite 接続とスキーマ管理。

スキーマは docs/story-graph-spec.md §3 が正。
FTS5 / sqlite-vec の索引テーブル(memories_fts / memories_vec)は
記憶 retrieval を組み込む Phase 2 で追加する。
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "data" / "story-graph.db"

# 2: nodes.location を自由テキストから places.id 参照に変える(docs/design/places.md)
SCHEMA_VERSION = 2

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

-- 場所(docs/design/places.md)。characters と同型。ノードは 1 つだけ参照する。
-- 記憶も関係も持たず、状態(facts)だけが変化する予定(Step 1)
CREATE TABLE IF NOT EXISTS places(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,   -- 固定設定(地形・規模・成り立ち)。清書に毎回渡す
  atmosphere TEXT,    -- 雰囲気・空気感。描写のトーン用
  color TEXT,
  image_path TEXT,    -- 参考画像(装飾専用。LLM には渡さない)
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
        # 挿絵が動画のときのサムネイル画像。構造モードのカードで動画をデコードしないために持つ
        # (無ければ描画時に生成して埋める。docs/changelog.md 2026-07-27)
        "ALTER TABLE nodes ADD COLUMN thumb_path TEXT",
        # 清書の目安の字数。NULL / 0 = 共通の設定(settings の reader_target_chars)に従う
        "ALTER TABLE nodes ADD COLUMN target_chars INTEGER",
        "ALTER TABLE characters ADD COLUMN portrait_path TEXT",  # プロフィール画像(切り抜き後。表示用)
        "ALTER TABLE characters ADD COLUMN portrait_source_path TEXT",  # 元画像(再クロップ用に保持)
        "ALTER TABLE characters ADD COLUMN portrait_crop TEXT",  # 切り抜きパラメータ(JSON。エディタ復元用)
        "ALTER TABLE chats ADD COLUMN char_id TEXT",  # NULL = 相談チャット。設定時はキャラとの会話
        "ALTER TABLE chats ADD COLUMN mode TEXT",  # キャラチャットの枠組み: interview | roleplay
        "ALTER TABLE chats ADD COLUMN title TEXT",  # 会話名(NULL = 冒頭の発言を見出しに使う)
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # 既に存在する
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < SCHEMA_VERSION:
        # 一回限りのデータ変換(lm-chat の作法)
        if version < 2:
            _migrate_locations_to_places(conn)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def _migrate_locations_to_places(conn: sqlite3.Connection) -> None:
    """nodes.location の自由テキストを places に登録し、ID 参照に置き換える。

    同じ文字列は 1 つの場所にまとめる(表記ゆれは統合できないので、
    「港」と「港町」は別の場所として登録される。作者が庫で統合する)。
    """
    rows = conn.execute(
        "SELECT DISTINCT location FROM nodes WHERE location IS NOT NULL AND location != ''"
    ).fetchall()
    if not rows:
        return
    place_ids = {r["id"] for r in conn.execute("SELECT id FROM places")}
    by_name = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM places")}
    now = datetime.now(timezone.utc).isoformat()
    migrated = 0
    for row in rows:
        raw = row["location"]
        if raw in place_ids:
            continue  # 既に ID 参照(移行済み or 手で入れた)
        place_id = by_name.get(raw)
        if place_id is None:
            place_id = uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO places(id, name, created_at) VALUES(?,?,?)", (place_id, raw, now)
            )
            by_name[raw] = place_id
            place_ids.add(place_id)
        conn.execute("UPDATE nodes SET location = ? WHERE location = ?", (place_id, raw))
        migrated += 1
    if migrated:
        print(f"[migrate] location を places に移行しました({migrated} 件)")
