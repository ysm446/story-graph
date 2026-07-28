# story-graph — spec.md

ノードベース・ストーリー構築アプリ

## 1. 概要

物語を「ビート(出来事の仕様書)」のDAGとして構築し、各ノードが発行するイベントdiffの畳み込み(fold)によってキャラクター・世界の状態を任意時点で導出するアプリ。散文はビートとは分離された「レンダリング」として鑑賞モードで生成する。

設計原則:

1. **ビートが正史、散文はレンダー結果。** 状態抽出・編集・分岐はすべてビート層で行う。
2. **状態は保存せず、常に導出。** キャラ状態のマスターデータは存在しない。ルートからのイベント畳み込みが唯一の真実。
3. **関係はスパース。** イベントが発行されたペアにしかエッジは存在しない。
4. **レンダリングは状態を変更しない。** 散文化は読み取り専用の一方向変換。
5. **LLM由来の変更も手動修正も、同じイベントとして記録する。**

## 2. 技術スタック

- **フロント**: Electron + React + TypeScript(lm-graph の UI シェル・デザインを移植)
- **グラフキャンバス**: React Flow(lm-graph から移植)
- **関係グラフ**: d3-force(初回レイアウトのみ。座標はピン留め保存)
- **バックエンド**: FastAPI sidecar(Python)
- **推論**: llama.cpp server(:8080、Gemma4-31B、JSON schema 制約出力を使用)
- **DB**: SQLite + sqlite-vec + FTS5
- **埋め込み**: Ruri(lm-chat のハイブリッド検索層を移植)

## 3. データモデル(SQLite)

```sql
-- キャラクター庫(静的定義。タイムラインの外)
characters(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile TEXT,            -- 性格の基調・背景(自由記述)
  appearance TEXT,
  voice TEXT,              -- 口調・一人称など
  color TEXT,              -- UI表示色
  graph_x REAL, graph_y REAL,  -- 関係グラフのピン留め座標
  created_at TEXT
)

factions(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
)

faction_members(char_id TEXT, faction_id TEXT, PRIMARY KEY(char_id, faction_id))

-- シーンノード(ビート)
nodes(
  id TEXT PRIMARY KEY,
  title TEXT,
  beat TEXT NOT NULL,        -- 出来事の仕様書(数文)
  emotional_core TEXT,       -- このシーンの感情的な核(1行)
  cast TEXT NOT NULL,        -- JSON array of char_id
  location TEXT,
  story_time TEXT,           -- 物語内時間(自由形式 or 日数)
  status TEXT DEFAULT 'canon',  -- canon | draft
  created_at TEXT, updated_at TEXT
)

-- DAG構造。正史パスはエッジのフラグで表現
edges(
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  is_canon INTEGER DEFAULT 0   -- 各ノードにつき canon な子は最大1つ(app層で保証)
)

-- イベント(状態への差分。このアプリの心臓部)
events(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,      -- ノード内の適用順
  type TEXT NOT NULL,        -- §4 のイベント型
  source TEXT NOT NULL,      -- llm | user
  payload TEXT NOT NULL,     -- JSON
  created_at TEXT
)

-- 記憶の検索インデックス(memory_add イベントからの派生。再foldで再構築)
memories(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  content TEXT NOT NULL,
  emotion REAL,              -- -1.0 .. 1.0
  importance REAL,           -- 0.0 .. 1.0
  story_order INTEGER        -- 正史パス上の位置(時間減衰用)
)
-- + memories_fts (FTS5) + memories_vec (sqlite-vec, Ruri埋め込み)

-- 状態キャッシュ(導出結果。真実はeventsにある)
state_cache(
  node_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,       -- StateSnapshot JSON
  input_hash TEXT NOT NULL,  -- 親state hash + 自ノードevents hash
  dirty INTEGER DEFAULT 0
)

-- レンダリング結果
renders(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  pov_char TEXT,             -- NULL = 三人称
  prose TEXT NOT NULL,
  stale INTEGER DEFAULT 0,   -- 上流ビート編集で自動的に立つ
  created_at TEXT
)

style_presets(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  person TEXT,               -- first | third
  tone TEXT,                 -- 文体指示(自由記述)
  params TEXT                -- JSON(温度など)
)

-- 相談チャット(ノードにアンカー)
chats(
  id TEXT PRIMARY KEY,
  anchor_node TEXT,          -- どの時点で相談していたか
  scope TEXT DEFAULT 'upto', -- upto(選択ノードまで) | all
  messages TEXT NOT NULL,    -- JSON
  created_at TEXT, updated_at TEXT
)

settings(key TEXT PRIMARY KEY, value TEXT)
```

## 4. イベントスキーマ

統一エンベロープ: `{ "type": ..., "payload": {...} }`。source は DB カラムで管理。

| type | payload | 説明 |
|---|---|---|
| `memory_add` | `{char, content, emotion, importance, refs[]}` | エピソード記憶の追加。refs は関連キャラID |
| `memory_compress` | `{char, replaces[], summary, importance}` | 古い記憶群を要約記憶1件に圧縮(replaces は memory event_id 群) |
| `relationship_update` | `{char, target_type: "char"\|"faction", target, delta, reason, label?}` | 関係値への加算。reason 必須。label は関係の一言(相関図の矢印に表示、後勝ち。2026-07-25 追加) |
| `relationship_set` | `{char, target_type, target, value, reason, label?}` | 関係値の絶対値設定(主に手動修正用) |
| `fact_set` | `{scope: "char"\|"world", char?, key, value}` | 事実の設定。key例: location, alive, goal, items, weather, day |
| `char_introduce` | `{char}` | 物語への初登場(以降 cast に入れる資格を得る) |
| `char_retire` | `{char, reason: "death"\|"departure"\|...}` | 退場。以降 cast に入れると検証エラー |
| `manual_override` | `{path, value, note}` | 上記で表現できない任意の状態パスへの手動修正 |

適用規則:

- fold は 正史パス順 → ノード内 seq 順。**後勝ち**で解決する
- relationship の score は `clamp(-1.0, 1.0)`。reasons はイベントIDのリストとして蓄積(エッジクリック時の履歴表示に使用)
- 未定義の関係は「存在しない」。UI・コンテキストとも中立(エッジなし)として扱う
- 関係解決のフォールバック: 個別エッジ → 所属 faction へのエッジ → 中立

## 5. 状態導出(fold)

```
StateSnapshot = {
  world: { time, facts: {key: value} },
  chars: {
    [char_id]: {
      facts: {key: value},          -- location, alive, goal, items...
      relationships: {
        [target_id]: { score, target_type, reasons: [event_id] }
      },
      memories: [memory_ref]         -- event_id の列(実体は memories テーブル)
    }
  }
}
```

- `state(node) = apply(state(canon_parent), events(node))`。純粋関数・決定的
- **キャッシュと dirty 伝播**: `input_hash = hash(parent_state_hash, events_hash)`。ノードのビート/イベントが変更されたら下流全ノードの state_cache を dirty 化。次回アクセス時に遅延再fold(道路HDAの部分再計算と同型)
- 再fold 時、memories インデックス(FTS5 / vec)は差分更新。埋め込みは content 不変なら再計算しない
- 分岐ノードは分岐点の state を共有し、以降は独立に fold される

## 6. 生成パイプライン(構造モード)

### 6.1 コンテキスト構築

1. 選択ノードの fold 済み state から、**cast 内キャラの相互関係 + 各キャラの強度上位オフスクリーン関係(|score| >= 0.5、上位3件)** を抽出
2. cast 各キャラの記憶 retrieval: クエリ = 直近ビート + 生成指示。ハイブリッド検索(FTS5 + vec、RRF)× 重要度 × 物語内時間減衰。キャラごと上位5件
3. 直近ビート 3件(正史パス上)
4. キャラの静的プロフィール(cast のみ)

### 6.2 ビート生成(1パス構造化出力)

llama.cpp の JSON schema 制約で、**ビートとイベントを同時に**出力させる:

```json
{
  "title": "...",
  "beat": "アヤは橋でケンの裏切りを知る。問い詰めるが、ケンは沈黙する。...",
  "emotional_core": "怒りより深い、静かな失望",
  "cast": ["aya", "ken"],
  "location": "石橋",
  "events": [ ... §4 のイベント配列 ... ]
}
```

- 抽出を別パスにしない理由: ビートは仕様書粒度なので、生成と同時に diff を出させても 31B なら安定する。乖離リスクよりレイテンシ削減を取る
- ユーザー操作: **次のビート生成** / **ブランチ生成**(what-if 指示テキスト付き、draft ステータスで挿入) / **手動ビート記入**(この場合のみイベント抽出パスを単独実行)

### 6.3 検証パス

1. **ルールベース(コード)**: 退場キャラが cast に含まれていないか / location の瞬間移動 / char_introduce 前の登場 / スキーマ外の char_id
2. **LLM 検証(温度0.1)**: 感情の一貫性(直前の関係値・記憶と矛盾する言動がないか)を yes/no + 指摘で判定
3. NG → 指摘をプロンプトに添えて最大2回リトライ。それでも NG なら警告付きで採用可(ユーザー判断)

## 7. 鑑賞モード(レンダリング)

- 入力: 正史パスのビート列 + 各ノードの fold 状態 + style_preset + pov_char
- **シーケンシャル・スライディングウィンドウ**: シーン n のレンダー時、直前レンダー散文の末尾 ~800 tokens を渡し、文体と場面転換を接続する
- **制約(プロンプトで厳守)**: ビートにある出来事以外を発生させない。許可されるのは描写・内面・会話の肉付けのみ。pov_char 指定時は、そのキャラの state(記憶・関係)に**ある情報しか知らない**ものとして書く
- **部分レンダー**: ビート編集 → 該当シーン以降の renders.stale を立てる。再レンダーは「このシーンのみ」「ここから最後まで」を選択可
- ~~ビート昇格~~(2026-07-28 削除): 散文選択 → LLM がビート追記案 + イベント diff 案を生成する還流機能として実装したが、実際には使われず、散文のコピー選択のたびにモーダルが開く邪魔にもなっていたため撤去。散文で生まれた要素を正史に残したい場合は、構造モードでビートを直接編集する
- 出力: 縦読みビュー(シーン境界にノードへのリンク)、Markdown / txt エクスポート

## 8. 相談チャット

- 状態の**読み取り専用クライアント**。エージェント型(news-picker のチャット実装を踏襲)
- ツール:
  - `get_state(node_id, char_id?)` — fold 済み状態の取得
  - `search_memories(query, char_id?)` — ハイブリッド検索
  - `get_beats(from?, to?)` — ビート列の取得
- **スコープ**: デフォルト `upto`(アンカーノードまでの情報しか見えない。未来のネタバレ禁止)。`all` へはユーザーが明示的に切替
- **提案カード**: 「この先の展開を提案して」系の応答は自由文に加え、ビート下書き JSON(§6.2 と同形)を最大3案カード表示。各カードに**ブランチとして挿入**ボタン → draft ノードとして DAG に追加
- チャット履歴はアンカーノード付きで保存(後から「あの相談どこでしたっけ」を可能に)

## 9. 関係グラフ

- 有向グラフ。ノード = char_introduce 済みキャラ、エッジ = score 非ゼロの関係のみ
- 表示: 色 = 感情価(負:赤系 / 正:緑系 / 弱:灰)、太さ = |score|、矢印 = 方向
- **時間スクラブ**: スライダーで正史パス上のノードを移動 → その時点の fold 結果で再描画
- エッジクリック → reasons のイベント履歴をドリルダウン表示
- フィルタ: |score| 閾値スライダー / エゴネットワーク(1キャラ選択) / 2ノード間差分(変化したエッジのみハイライト)
- レイアウト: 初回 d3-force → characters.graph_x/y にピン留め。新キャラのみ追加配置

## 10. UI 構成

トップレベル 4 モード(lm-graph のシェルデザインを踏襲):

1. **構造モード**(メイン、3ペイン)
   - 中央: React Flow キャンバス。正史パスを縦のタイムラインとして表示、分岐は横に展開。draft ノードは点線枠
   - 右: インスペクタ(タブ切替)
     - ビート: title / beat / emotional_core / cast / location の編集
     - キャラ: cast 各キャラのタブ。その時点の facts / relationships / memories を表示。編集可能フィールドへの変更は手動イベント化(source=user バッジ表示)
     - 関係図: §9 のグラフ
   - 下: 相談チャットドロワー(開閉式)
2. **鑑賞モード**: 縦読み + スタイルプリセット / pov 切替 + stale シーンの再レンダー UI
3. **キャラクター庫**: characters / factions の CRUD
4. **設定**: LLM エンドポイント、コンテキスト予算、検証パスの ON/OFF

## 11. LLM 構成

- :8080 に llama.cpp server、Gemma4-31B(Q5 目安)。全用途を単一モデルで賄う(MVP では第2ポートなし)
- 用途別パラメータ:

| 用途 | 温度 | 制約 | コンテキスト予算目安 |
|---|---|---|---|
| ビート生成 | 0.8 | JSON schema | 8k |
| イベント抽出(手動ビート時) | 0.2 | JSON schema | 4k |
| 検証 | 0.1 | JSON schema | 4k |
| レンダリング | 0.9 | なし | 16k |
| 相談チャット | 0.7 | tool calling | 12k |

- レンダリングとチャットの併用時に KV が競合しないよう、llama.cpp の slot 数と `--ctx-size` の配分を settings で調整可能にする

## 12. lm-graph / 既存資産からの移植

| 移植元 | 部品 |
|---|---|
| lm-graph | React Flow キャンバス(パン・ズーム・選択 UX)、UI シェル・デザイン(配色・レイアウト)、llama.cpp SSE ストリーミングクライアント、Electron + FastAPI 起動骨格 |
| lm-chat | ハイブリッド検索層(FTS5 + sqlite-vec + Ruri、RRF)。時間減衰を「実時間→物語内順序」に差し替え |
| news-picker | エージェント型チャット(tool calling ループ) |

DB スキーマとノードのデータ構造は**一切引き継がず**、本 spec で新規設計。

## 13. 実装フェーズ

- **Phase 1 — コアループ(MVP)**: 単線タイムラインのみ(分岐なし)。characters CRUD、ビート生成(構造化出力)、fold + state_cache、インスペクタでの状態閲覧。検証はルールベースのみ
- **Phase 2 — 編集耐性**: 分岐 DAG + 正史切替、手動イベント(状態編集)、dirty 伝播と再fold、記憶 retrieval をコンテキスト構築に組込み
- **Phase 3 — 関係グラフ**: 描画、時間スクラブ、履歴ドリルダウン、ピン留めレイアウト
- **Phase 4 — 鑑賞モード**: シーケンシャルレンダリング、スタイルプリセット、pov、部分レンダー、ビート昇格(後日削除)
- **Phase 5 — 相談チャット**: ツール3種、スコープ制御、提案カード → ブランチ挿入
- **Phase 6 — スケール対応**: faction フォールバック、memory_compress(自動要約圧縮)、2ノード差分表示、LLM 検証パス、エクスポート

## 14. 非目標

- 画像・動画生成、シーンカードの視覚演出(story-flow の領分)
  - ※ユーザーが用意した画像の添付・表示(キャラのプロフィール画像、シーンの挿絵)は範囲内。
    ただし**装飾専用**とし、LLM には視覚情報として渡さない。画像が無くてもアプリは完全に成り立つこと(2026-07-25 追記)
- マルチユーザー / クラウド同期
- 実時間ベースの記憶減衰(物語内順序のみを使う)
- ノードトポロジーによる自由なコンテキスト配線(lm-graph の領分。本アプリはタイムラインが主軸)
