# 全体設計(アーキテクチャ)

作成日時: 2026-08-09 15:30
更新日時: 2026-08-23 18:53

このアプリが **どう組まれているか** をまとめた入口。「何を作るか」は
[story-graph-spec.md](../story-graph-spec.md)(仕様)と [plan/goals.md](../plan/goals.md)(目的・価値)、
「いま何ができているか」は [plan/progress.md](../plan/progress.md) にある。
本書はその間 —— **プロセス構成・データの流れ・どこに何を書くか** —— を扱う。

機能ごとの設計は `docs/design/` の各ファイルにあり、本書はその索引を兼ねる。

| 文書 | 扱う範囲 |
|---|---|
| [style-guide.md](style-guide.md) | UI の具体値(色・タイポ・余白・部品の型・文言) |
| [endings.md](endings.md) | はじまり / 結末ノードと正史(canon)の導出 |
| [chapters.md](chapters.md) | 章グループ、章じまいのまとめ(digest)、stale の遮断 |
| [node-inheritance.md](node-inheritance.md) | シーンが前から引き継ぐもの / 引き継がないもの |
| [places.md](places.md) | 場所を登録制の第一級エンティティにする |
| [system-prompts.md](system-prompts.md) | LLM に送るプロンプトの構成と編集可能な範囲 |
| [chat.md](chat.md) | 相談チャット(読み取り専用エージェント) |
| [snapshots.md](snapshots.md) | 時点に戻す(ライブラリの中) |
| [backup.md](backup.md) | 外部バックアップ(zip でライブラリの外へ) |

## 1. 全体像

3 つのプロセスが 127.0.0.1 の中だけで完結する。外部サービスへの通信は無い
(llama.cpp のダウンロードだけが例外)。

```
┌── Electron main (Node) ────────────────────────────┐
│  ウィンドウ / ネイティブダイアログ / F12 撮影      │
│  sidecar の spawn・health・停止                    │
│  %APPDATA%/story-graph/app.json(開くライブラリ)  │
└──────────────┬─────────────────────────────────────┘
               │ IPC(preload の contextBridge = window.storyGraph)
┌──────────────▼── renderer (React) ─────────────────┐
│  構造 / 資料庫 / 鑑賞 / 設定 + 相談チャット        │
│  api.ts が唯一の HTTP 窓口、tasks.ts が実行キュー  │
└──────────────┬─────────────────────────────────────┘
               │ HTTP + SSE(baseUrl は bootstrap IPC で受け取る)
┌──────────────▼── FastAPI sidecar (Python) ─────────┐
│  app.py        HTTP / SSE の口                     │
│  store.py      SQLite への読み書き(集約点)       │
│  fold.py       イベント畳み込み(純粋関数)        │
│  generation / rendering / chat_agent   LLM 利用     │
│  retrieval + embed                     記憶検索     │
│  llm / llama_manager / llama_installer 推論基盤     │
│  snapshots / backup                    保全         │
└────────┬───────────────────────────┬───────────────┘
         │ HTTP                      │ ファイル
┌────────▼──────────┐   ┌────────────▼───────────────┐
│ llama-server:8080 │   │ <ライブラリ>/story-graph.db │
│ (Gemma / GGUF)    │   │ assets/ snapshots/ backups/ │
└───────────────────┘   └────────────────────────────┘
```

**なぜ Python の sidecar を挟むのか。** UI は Electron + React(lm-graph から移植した
シェルを使う)が快適な一方、この app の中身は sqlite-vec / FTS5 / Ruri 埋め込み /
llama.cpp の制約付き構造化出力 —— どれも Python 側に既存の実装(news-picker・lm-chat)
がある。**UI と推論・検索を別プロセスに分け、HTTP で薄くつなぐ**ことで、
片方だけを再起動・再実装できるようにしている。

## 2. ライブラリ(データの単位)

**1 つの物語 = 1 つのフォルダ**。アプリはこれを「ライブラリ」と呼び、いつでも切り替えられる。

```
<ライブラリ>/
  story-graph.db     … 本体(SQLite。WAL)。キャラ・シーン・イベント・清書・チャット・設定
  assets/images/     … 挿絵・立ち絵・動画(DB は参照パスだけを持つ)
  snapshots/         … 時点保存(<id>.db + index.json)。docs/design/snapshots.md
  backups/           … 自動バックアップの既定の置き場(zip)。docs/design/backup.md
  screenshot/        … F12 で撮った画面
```

- **どのライブラリを開くかは Electron 側が覚える**(`%APPDATA%/story-graph/app.json` の
  `libraryRoot` と `recentRoots`)。未設定ならリポジトリ内の `data/`
- 切り替えは 3 手: `library:switch`(main が記憶)→ `/library/switch`(バックエンドが
  接続を張り替え)→ `location.reload()`(レンダラを作り直す)。
  **アプリ内の状態を差分更新せず、丸ごと読み直す**のが約束
- 設定(スタイルプリセット・モデルパス・バックアップ設定など)は **DB の中**にある。
  つまり設定もライブラリに付いてくる

## 3. データの流れ

**events テーブルが唯一の真実**で、それ以外はいつでも捨てて作り直せる導出物。

```
シーン(nodes)+ イベント(events)      ← 作者と LLM が書くのはここだけ
        │ fold.py(ルートからの畳み込み)
        ▼
状態(state_cache)                     ← 導出物。dirty フラグ付きで遅延再計算
        │
        ├─▶ インスペクタ / 関係グラフ / FactTimeline
        ├─▶ memories(+ FTS5・sqlite-vec 索引)→ retrieval で検索
        └─▶ 清書(renders)              ← 導出物。stale フラグを立てて作り直す
```

- **状態のマスターデータは存在しない**(spec の設計原則 2)。`state_cache` は
  「同じ入力なら同じ結果」を `input_hash` で確かめてから使うキャッシュにすぎない
- 上流を編集すると `mark_dirty_downstream()` が **自分と下流の state_cache を dirty に、
  清書を stale に** する。再計算は次に必要になったときまで遅延する
- 章グループは **stale の伝播を章の境界で遮断する**(章内で閉じた編集が物語の末尾まで
  「作り直し」を波及させないため。[chapters.md](chapters.md))
- 正史(canon)は保存された属性ではなく、**有効な結末ノードから根へさかのぼって導出**する
  ([endings.md](endings.md))

## 4. バックエンドのレイヤ

| モジュール | 責務 | 依存の向き |
|---|---|---|
| `app.py` | HTTP / SSE の口。Pydantic で入出力を定義し、処理は下へ委譲 | すべてを呼ぶ |
| `store.py` | SQLite の読み書き。CRUD・タイムライン・章・state_cache・dirty 伝播 | db / fold |
| `fold.py` | イベント畳み込みによる状態導出。**純粋関数のみ、DB を持たない** | なし |
| `db.py` | 接続・スキーマ・マイグレーション(sqlite-vec / FTS5 のロード) | なし |
| `generation.py` | ビート生成・イベント抽出・章まとめ(JSON schema 制約 + 検証 + リトライ) | llm / store / validation |
| `rendering.py` | 鑑賞モードの散文化(直前の散文を渡して文体を接続) | llm / store |
| `chat_agent.py` | 相談チャットの tool calling ループ(**読み取り専用**+ 提案カード) | llm / store / retrieval |
| `retrieval.py` + `embed.py` | 記憶のハイブリッド検索(RRF + 重要度 + 物語内時間減衰)、Ruri 埋め込み | db |
| `llm.py` | llama-server クライアント(httpx 非同期、構造化出力) | なし |
| `llama_manager.py` / `llama_installer.py` | llama-server の起動・停止と自動インストール | なし |
| `validation.py` | ルールベース検証(cast と state の照合) | fold |
| `snapshots.py` / `backup.py` | 時点保存と外部バックアップ | store |
| `system_info.py` | CPU / RAM / GPU / VRAM とモデル一覧 | なし |

守っている境界は 2 つだけ。**fold は DB を知らない**(テストしやすく、状態導出を
どこからでも再現できる)。**DB への書き込みは store に集約する**(dirty 伝播や
memories の同期を書き忘れる場所を作らない)。

## 5. 同時実行の約束

ローカル単一ユーザーなので、**並行性を足すのではなく、意図的に直列にしている**。

- **バックエンドのハンドラはすべて `async def`**。イベントループ上で直列に走るので、
  SQLite への書き込みが競合しない(ロック待ちもデッドロックも起きない)
- **重いファイル IO は `asyncio.to_thread` に逃がす**。SQLite に触る部分だけをループ上に
  残すのが型(例: バックアップは `VACUUM INTO` がループ上、zip 書き出しはスレッド)
- **エラー時は必ず rollback**。共有コネクションに半端な変更を残さないよう、
  例外ハンドラで `store.conn.rollback()` を通す
- **長い処理は SSE(`text/event-stream`)で進捗を返す**。生成・清書・再抽出・
  llama.cpp のインストールがこれ。フロントは `fetch` + `body.getReader()` で読む
- **フロント側は `tasks.ts` の単一キュー**。llama-server は 1 リクエストずつしか
  処理しないので、LLM を使う処理は積んだ順に 1 件ずつ実行する。モードを切り替えても
  キューは残り、進捗と中止はステータスバーから触れる

## 6. フロントエンドの構成

- `App.tsx` — モード切替(構造 / 資料庫 / 鑑賞)、ライブラリメニュー、モデルバー、
  ステータスバー。**モードをまたぐ状態は `selectedNodeId` など App が持つ**
- `modes/StructureMode.tsx` — React Flow(`@xyflow/react`)のキャンバス。DAG の編集、
  章ビュー、インスペクタ。アプリで最も大きい画面
- `modes/ReaderMode.tsx` — 鑑賞(ページ / 縦読み / 挿絵分割)。読んでいるシーンを App に返す
- `modes/CharactersMode.tsx` / `PlaceEditor.tsx` — 資料庫(キャラ・場所・派閥)
- `modes/SettingsMode.tsx` — モデル・プロンプト・スナップショット・バックアップ
- `RelationGraph.tsx` — d3-force の関係グラフ(初回レイアウトのみ。座標はピン留め)
- `ChatDrawer.tsx` — 相談チャット(引き出し)
- `api.ts` — **バックエンドへの唯一の窓口**。`baseUrl` は `bootstrap` IPC で受け取る。
  SSE を読む関数もここに集約する
- `tasks.ts` — LLM を使う長い処理のキュー(§5)
- `types.ts` — バックエンドの JSON に対応する型

UI の色・角丸・余白は `index.css` の CSS 変数(`--bg-*` / `--text-*` / `--border-*` /
`--accent-*`)を使う。**Tailwind のクラスで色を直書きしない**のが既存の書き方。
具体値と部品の型は [style-guide.md](style-guide.md) にまとめてある。

## 7. LLM の扱い

- **llama-server は外部起動を優先**する。`llm_base_url` が既に healthy ならそれを使い、
  無ければ `llama_server_path` + `llm_model_path` で spawn する
  (`llama_manager.py`)。llama.cpp 本体は設定画面から自動ダウンロードできる
- **GGUF を探すフォルダは設定 `models_dir`**(設定画面の「モデルフォルダ」)。空なら
  リポジトリ内の `models/`(`system_info.resolve_models_dir`)。`llm_model_path` が空のときの
  既定モデルは `llama_manager.resolve_model_path`(モデルフォルダの先頭の GGUF → 同梱の既定)
- **構造化出力**は `response_format` の json_schema で強制する。生成したものは
  `validation.py` のルール検証にかけ、NG なら指摘を添えて最大 2 回リトライする
- **LLM が発行できるイベント型は 3 つだけ**(`memory_add` / `relationship_update` /
  `fact_set`)。キャラの登場・退場や関係の直接指定は手動の領分
- **プロンプトは設定画面で編集できる**。組み立て方と編集可能な範囲は
  [system-prompts.md](system-prompts.md)
- 終了時は `POST /llm/stop` で **VRAM を明示的に解放**してから sidecar を落とす。
  外部起動の llama-server は管理外なので止めない(意図的)

## 8. 起動と終了

**起動**

1. Electron が単一インスタンスロックを取り、ウィンドウを作る
2. `ensureSidecar()` —— まず 8765 から 20 ポートぶんを health で叩き、
   **既に動いている sidecar が居れば再利用**する(前回セッションの残存や手動起動)。
   居なければ `.venv/Scripts/python.exe -m uvicorn app:app` を spawn し、
   `STORY_GRAPH_LIBRARY` に開くライブラリを渡す。30 秒で healthy にならなければ失敗
3. バックエンドは起動時に、埋め込みモデルの warmup(バックグラウンド)、
   未参照 assets の GC、**15 秒後に自動バックアップの日次チェック**を行う
   (レンダラのライブラリ同期より先に走らないための待ち)
4. レンダラは `bootstrap` IPC で `baseUrl` を受け取ってから API を叩き始める

**終了**

`before-quit` で一度 quit を止め、`POST /llm/stop` → sidecar を
`taskkill /T /F`(プロセスツリー)で落としてから改めて quit する。
`quit` でも保険の `stopSidecar()` を通す。

## 9. 保全(壊したときに戻せる仕組み)

守備範囲の違う 2 段構えになっている。

| | スナップショット | 外部バックアップ |
|---|---|---|
| 守るもの | 操作ミス(削除・正史切替・イベント作り直し) | フォルダ消失・ディスク障害・PC 乗り換え |
| 置き場所 | `<ライブラリ>/snapshots/` | 既定は `<ライブラリ>/backups/`、外のフォルダも選べる |
| 契機 | 危険な操作の直前(自動)+ 手動 | 日次(自動。既定オフ)+ 手動 |
| 戻し方 | その場で時点に戻す | 新しいライブラリとして展開して開く |

どちらも `VACUUM INTO` で整合コピーを取る。assets は **その場では消さず**、
ライブラリを開いたときの GC でまとめて回収する(1 時間以内の新しいファイルは対象外)。

## 10. 変更するときの指針

- **新しい API を足す**: `app.py` に Pydantic のスキーマとハンドラ → 実処理は
  `store.py` か専用モジュール → `renderer/src/api.ts` に関数 → `types.ts` に型。
  ハンドラは `async def` のままにする(直列実行の前提を崩さない)
- **DB スキーマを変える**: `db.py` の `_SCHEMA` と `SCHEMA_VERSION`、マイグレーション。
  spec の §3 も直す
- **新しいイベント型を足す**: `fold.py`(適用)→ `validation.py`(検証)→
  `generation.py`(LLM に出させるなら schema)→ `EventsEditor.tsx`(手動編集の UI)
- **まとまった機能を作る**: `docs/design/<機能>.md` に設計を書き、本書の索引に足す。
  判断の理由(なぜ他の案を採らなかったか)を残すのがこのリポジトリの書き方
- **ユーザーに見える変更**: `docs/changelog.md` の「未リリース」に日本語で記録し、
  `docs/plan/progress.md` を更新する

## 11. 前提と制約

- **Windows 前提**(`.venv/Scripts/python.exe`、`taskkill`、llama.cpp の x64 zip)。
  他 OS では sidecar の起動まわりに手入れが要る
- **ローカル単一ユーザー**。マルチユーザー・クラウド同期は非目標(goals.md)なので、
  直列実行と共有コネクションで押し切っている
- **Python の依存は `.venv`**(リポジトリ直下)。無いと sidecar が起動しない
- **llama-server は同時に 1 本**。複数モデルの並行実行は想定していない
- 埋め込み(Ruri)が使えない環境では **検索が FTS のみに退化**する。アプリは止まらない
