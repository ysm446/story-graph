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
# 3: 挿絵・参照画像のストック(media)を作り、設定済みの 1 枚を初期の候補として登録する(docs/design/image-gen.md §7)
SCHEMA_VERSION = 3

_SCHEMA = """
CREATE TABLE IF NOT EXISTS production_memory(
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    chat_id TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS production_memory_review(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS production_checkpoint(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    data TEXT NOT NULL
);

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

-- 章グループ(docs/design/chapters.md)。章は正史パス上の連続区間へのラベルで、
-- 実体ノードではない(メンバーは nodes.group_id で持つ)。
-- digest_* はフェーズ C(章じまいのまとめ)用に先に用意しておく
CREATE TABLE IF NOT EXISTS groups(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  color TEXT,
  digest_events TEXT,
  digest_stale INTEGER DEFAULT 0,
  created_at TEXT
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

-- 挿絵・参照画像のストック(docs/design/image-gen.md §7)。持ち主(シーン / キャラ)ごとに
-- 生成した候補と手持ちの画像を溜め、その中の 1 枚を nodes.image_path / characters.ref_image_path
-- に「選択中」として写す。生成物はプロンプト・追加指示・seed(・参照キャラ)を 1 セットで持つ
-- (再現用)。手持ちの画像はどれも NULL。削除は作者の明示操作だけ(ファイルは gc_assets が回収)
CREATE TABLE IF NOT EXISTS media(
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,        -- 'node' | 'character'
  owner_id TEXT NOT NULL,
  path TEXT NOT NULL,              -- assets/images 内のファイル名(画像 / 動画)
  thumb_path TEXT,                 -- 動画のサムネイル(nodes.thumb_path と同じもの。選び直しで使い回す)
  prompt TEXT,
  instructions TEXT,
  seed INTEGER,
  ref_chars TEXT,                  -- JSON 配列(場面のみ)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_type, owner_id, created_at);

-- 朗読台本(docs/design/voice.md §4)。清書 1 件に 1 件。清書の本文は書き換わらない(作り直すと
-- 新しい renders 行になる)ので、台本は render_id に紐づけ、作り直した清書へは同じ文の行を引き継ぐ。
-- 保存するのは LLM で話者・感情を付けたときと、作者が手で直したときだけ(規則ベースは毎回作る)
CREATE TABLE IF NOT EXISTS voice_scripts(
  render_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  lines TEXT NOT NULL,             -- JSON 配列(行の形は docs/design/voice.md §4.2)
  source TEXT NOT NULL,            -- 'rule' | 'llm'(話者・感情を LLM で付けたか)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_scripts_node ON voice_scripts(node_id, updated_at);

-- 読み上げの声(docs/design/voice.md §5)。語り手(settings の tts_narrator_profile)と
-- キャラ(characters.voice_profile_id)に割り当てる。エンジンには縛らない(説明文と参照音声は
-- どのエンジンにも渡せる形で持ち、受け付けない指定はエンジン側で無視される)
CREATE TABLE IF NOT EXISTS voice_profiles(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  caption TEXT,                    -- 声の説明(ボイスデザイン)
  ref_paths TEXT,                  -- JSON 配列。assets/voices 内のファイル名(参照音声。複数可)
  seed INTEGER,                    -- NULL = 既定(voice.DEFAULT_SEED)。固定しないと行ごとに声が揺れる
  preset TEXT,                     -- エンジン側に登録済みの声 ID(voice.modes に preset があるエンジン用)
  params TEXT,                     -- JSON。この声だけ /v1/audio/speech に重ねるパラメータ
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 頻出クエリの索引。parent_of / 子の列挙(edges)、最新清書の取得と stale 化(renders)、
-- イベント削除に伴う記憶の削除(memories)はどれもミューテーションや画面更新の
-- たびに走るので、全表走査にしない
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
CREATE INDEX IF NOT EXISTS idx_renders_node ON renders(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_event ON memories(event_id);
CREATE INDEX IF NOT EXISTS idx_memories_char ON memories(char_id, story_order);

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
        # 参照画像(全身の立ち絵。場面画像の編集モデルへ渡す入力。生成 / 手持ち画像のどちらでも)
        "ALTER TABLE characters ADD COLUMN ref_image_path TEXT",
        "ALTER TABLE characters ADD COLUMN ref_image_prompt TEXT",  # 生成に使った英語プロンプト(作り直し用)
        # 参照画像の生成ウインドウの状態(次に開いたとき復元する。docs/design/image-gen.md §4)
        "ALTER TABLE characters ADD COLUMN ref_image_instructions TEXT",  # 作者の追加指示(日本語可)
        "ALTER TABLE characters ADD COLUMN ref_image_seed INTEGER",  # 最後に使った seed(NULL = ランダム)
        # 場面の挿絵の生成ウインドウの状態(docs/design/image-gen.md §6)
        "ALTER TABLE nodes ADD COLUMN image_prompt TEXT",  # 英語の場面プロンプト
        "ALTER TABLE nodes ADD COLUMN image_instructions TEXT",  # 作者の追加指示
        "ALTER TABLE nodes ADD COLUMN image_seed INTEGER",
        "ALTER TABLE nodes ADD COLUMN image_ref_chars TEXT",  # 参照画像を渡すキャラ ID(JSON 配列。image1.. の順)
        "ALTER TABLE chats ADD COLUMN char_id TEXT",  # NULL = 相談チャット。設定時はキャラとの会話
        "ALTER TABLE chats ADD COLUMN mode TEXT",  # キャラチャットの枠組み: interview | roleplay
        "ALTER TABLE chats ADD COLUMN title TEXT",  # 会話名(NULL = 冒頭の発言を見出しに使う)
        "ALTER TABLE nodes ADD COLUMN group_id TEXT",  # 章グループ(NULL = 未分類。docs/design/chapters.md)
        # 章ビューでの章カードの手動配置(NULL = 導出位置。正史章は専用レーン、島章は先頭シーンの位置)
        "ALTER TABLE groups ADD COLUMN pos_x REAL",
        "ALTER TABLE groups ADD COLUMN pos_y REAL",
        # 章カードの表紙にするシーン(NULL = 自動。章内で最初に挿絵があるシーンを使う)
        "ALTER TABLE groups ADD COLUMN cover_node_id TEXT",
        # はじまり / 結末のマーカーノード(NULL = 通常シーン。docs/design/endings.md)
        "ALTER TABLE nodes ADD COLUMN kind TEXT",
        "ALTER TABLE renders ADD COLUMN meta TEXT",  # 生成統計(JSON。tokens / elapsed_sec など)
        # 生成時に LLM へ送った messages の控え(JSON。UI の閲覧用。チャットの prompt_messages と同趣旨)
        "ALTER TABLE renders ADD COLUMN prompt_messages TEXT",
        # fold 済み状態のハッシュ。キャッシュヒット時に state 全体を parse し直して
        # ハッシュを取り直さずに済ませる(NULL = 旧キャッシュ。次の get_state で埋まる)
        "ALTER TABLE state_cache ADD COLUMN state_hash TEXT",
        # 一覧用スニペット(最初のユーザー発言の先頭 60 字)。保存時に控えることで、
        # 一覧を開くたびに全チャットの messages JSON(長い履歴は MB 級)を
        # パースしない(NULL = 旧データ。次の list_chats で埋まる)
        "ALTER TABLE chats ADD COLUMN snippet TEXT",
        # 生成に使ったワークフローの組(workflows/variants.json の id。NULL = 既定)。
        # プロンプト・seed と同じくセットの一部(LoRA の有無で絵が変わるので、再現に要る)
        "ALTER TABLE nodes ADD COLUMN image_workflow TEXT",
        "ALTER TABLE characters ADD COLUMN ref_image_workflow TEXT",
        "ALTER TABLE media ADD COLUMN workflow TEXT",
        # 読み上げの声(voice_profiles.id。NULL = 語り手の声で読む。docs/design/voice.md §5)。
        # 既存の voice 列は「口調・一人称」のテキストで、LLM に渡す資料なので別物
        "ALTER TABLE characters ADD COLUMN voice_profile_id TEXT",
        # 名前の読み(ひらがな)。読み上げで、合成の直前に名前をこの読みに置き換える(docs/design/voice.md §4.5)
        "ALTER TABLE characters ADD COLUMN reading TEXT",
        "ALTER TABLE places ADD COLUMN reading TEXT",
        # キャラ同士の会話室(mode='room')の参加者(JSON 配列の char_id。docs/design/chat.md §8)。
        # 会話室は char_id NULL のまま participants で見分ける
        "ALTER TABLE chats ADD COLUMN participants TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError as e:
            # 既に存在する列だけ無視する。ロック等で失敗した場合は起動時に気づけるよう投げる
            if "duplicate column" not in str(e).lower():
                raise
    # group_id は ALTER で足す列なので、索引も列が揃ってから作る
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nodes_group ON nodes(group_id)")
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < SCHEMA_VERSION:
        # 一回限りのデータ変換(lm-chat の作法)
        if version < 2:
            _migrate_locations_to_places(conn)
        if version < 3:
            _migrate_images_to_media(conn)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def _migrate_images_to_media(conn: sqlite3.Connection) -> None:
    """設定済みの挿絵 / 参照画像を、それぞれの持ち主のストックの最初の 1 枚として登録する。

    生成ウインドウの保存状態(プロンプト・追加指示・seed)は「その画像を作ったときのもの」とは
    限らない(ストック導入前は閉じるたびに保存していた)が、他に手がかりが無いのでそのまま添える。
    """
    now = datetime.now(timezone.utc).isoformat()
    rows = conn.execute(
        "SELECT id, image_path, thumb_path, image_prompt, image_instructions, image_seed, image_ref_chars"
        " FROM nodes WHERE image_path IS NOT NULL"
    ).fetchall()
    for r in rows:
        conn.execute(
            "INSERT INTO media(id, owner_type, owner_id, path, thumb_path, prompt, instructions, seed, ref_chars, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (uuid.uuid4().hex[:12], "node", r[0], r[1], r[2], r[3], r[4], r[5], r[6], now),
        )
    rows = conn.execute(
        "SELECT id, ref_image_path, ref_image_prompt, ref_image_instructions, ref_image_seed"
        " FROM characters WHERE ref_image_path IS NOT NULL"
    ).fetchall()
    for r in rows:
        conn.execute(
            "INSERT INTO media(id, owner_type, owner_id, path, thumb_path, prompt, instructions, seed, ref_chars, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (uuid.uuid4().hex[:12], "character", r[0], r[1], None, r[2], r[3], r[4], None, now),
        )


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
