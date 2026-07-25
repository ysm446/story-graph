# progress — 進捗と注意点

作成日時: 2026-07-24 22:38
更新日時: 2026-07-25 09:44

## 現在の状態

- **Phase 5(相談チャット)完了。** 残るは Phase 6(スケール対応)と小タスク。
- **ライブラリ方式を導入**(lm-graph 踏襲): ストーリーごとのフォルダに `story-graph.db` を置く。現在のライブラリと最近使ったライブラリは `%APPDATA%/story-graph/app.json`(Electron userData)に保存。ヘッダー右のドロップダウンで切替(切替時はレンダラをリロード)。デフォルトはリポジトリ内 `data/`。
- `npm run dev` で Electron が起動し、FastAPI sidecar(ポート 8765〜自動探索)が自動 spawn される。
- バックエンドは単体でも起動可能: `cd backend && ../.venv/Scripts/python.exe -m uvicorn app:app --port 8765`
- テスト: `cd backend && ../.venv/Scripts/python.exe -m pytest tests/ -q`(19件、全て成功)

## 完了済み

- [x] 仕様確定: [docs/story-graph-spec.md](../story-graph-spec.md)
- [x] 移植元 3 リポジトリの調査(lm-graph / lm-chat / news-picker。結果は [plan.md](plan.md) の移植元マップ)
- [x] モデル配置: `models/gemma-4-31B-it-GGUF/`(Q6_K + mmproj)、`models/gemma-4-12B-it-GGUF/`(Q6_K + mmproj)
- [x] 計画ドキュメント作成(goals / plan / progress)
- [x] **M1 — 骨格**: electron-vite + React 19 + Tailwind、lm-graph のデザイントークン移植(`src/renderer/src/index.css`)、`.venv`(Python 3.13) + FastAPI `/health`、Electron main からの sidecar spawn + ヘルスチェック(`src/main/index.ts`)
- [x] **M2 — データ層**: SQLite スキーマ全テーブル(`backend/db.py`)、characters / factions CRUD、nodes / edges(単線タイムライン)、fold エンジン(`backend/fold.py`、純粋関数)、state_cache(input_hash / dirty 伝播 / 遅延再fold)、ルールベース検証(`backend/validation.py`)、memories 行の events からの再構築。pytest 19件
- [x] **M3 — UI(基本形)**: シェル(ヘッダー + 4 モード切替、`App.tsx`)、構造モード(React Flow 縦タイムライン + インスペクタ[ビート編集 / キャラ状態閲覧] + 相談チャットドロワー枠、`modes/StructureMode.tsx`)、キャラクター庫 CRUD(`modes/CharactersMode.tsx`)、設定画面(`modes/SettingsMode.tsx`)
- [x] **M4 — 生成**: llama-server マネージャ(`backend/llama_manager.py`、外部起動優先 + 自動 spawn)、LLM クライアント(`backend/llm.py`、httpx 非同期 + json_schema response_format)、生成パイプライン(`backend/generation.py`、コンテキスト構築 + ビート生成 SSE + 検証リトライ + イベント抽出)、UI(生成パネル / イベント抽出ボタン / LLM 起動・停止)。**12B で E2E 検証済み**(2連続ビート生成 → fold 状態確認 → 手動ビートのイベント抽出)

- [x] **Phase 2 — 編集耐性**(2026-07-25):
  - 分岐 DAG: 任意ノードからの分岐作成(`parent_id`)、`path_to` による分岐パスの fold(分岐点まで state 共有)、正史切替(`make_canon`: canon エッジ付け替え + status 導出 + story_order 再同期)、リーフ削除、`GET /graph`
  - ブランチ生成: `POST /generate/beat` に `parent_id`(what-if 指示付き、draft として挿入)
  - 手動イベント編集 UI: イベントの削除/追加(型テンプレート付き)、キャラタブから facts / relationship_set / memory_add を手動イベント化(source=user バッジ)
  - 記憶 retrieval: `backend/embed.py`(Ruri v3-310m、非対称プレフィックス、CPU)+ `backend/retrieval.py`(FTS5 trigram + sqlite-vec cosine の RRF × 重要度 × story_order 半減期減衰)。生成コンテキストに cast 各キャラの想起記憶 top5 を注入(spec §6.1-2)。意味検索の実動作を確認済み
  - UI: DAG レイアウト(正史=縦一直線、分岐=右レーンへ)、canon/draft のエッジ・ノード描画分け、「このブランチを正史にする」

- [x] **Phase 3 — 関係グラフ**(2026-07-25): インスペクタ「関係図」タブ(`src/renderer/src/RelationGraph.tsx`)。有向グラフ(色=感情価 / 太さ=|score| / 矢印=方向)、正史パスの時間スクラブ、|score| 閾値フィルタ、ノードクリックでエゴネットワーク、エッジクリックで reasons のイベント履歴(delta/理由/ノード)、初回 d3-force 配置 → `characters.graph_x/y` にピン留め保存(ドラッグで再配置可、新キャラのみ追加配置)

- [x] **Phase 4 — 鑑賞モード**(2026-07-25): `backend/rendering.py` + `modes/ReaderMode.tsx`。シーケンシャルレンダリング(直前散文の末尾 ~1400 字をスライディングウィンドウで接続、12B 実機で接続を確認)、スタイルプリセット(seed 2 種 + CRUD API)、POV(pov キャラの state にある情報のみをプロンプトへ)、部分レンダー(「このシーンのみ」「ここから最後まで」、上流編集で renders.stale 自動化)、ビート昇格(散文の選択 → LLM が追記案+イベント diff 案 → 確認して正史へ)、Markdown エクスポート、SSE トークンストリーミング表示

- [x] **Phase 5 — 相談チャット**(2026-07-25): `backend/chat_agent.py` + `src/renderer/src/ChatDrawer.tsx`。
  tool calling ループ(news-picker 方式、MAX_TOOL_STEPS=8、上限到達時は打ち切らずまとめさせる)。
  ツール: get_beats / get_state / search_memories(読み取り専用)+ propose_beats(提案カード)。
  スコープ upto(アンカーのパスまでしか見えない。チャット作成時に固定)/ all。
  提案カード → 「⑂ ブランチとして挿入」で anchor から draft 挿入。履歴はアンカー付きで chats に保存。
  llama-server に `--jinja` を追加(tool calling に必要)。12B 実機 E2E でツール使用・提案とも確認済み

## 未完了

- [ ] **Phase 6 — スケール対応**: memory_compress(記憶の自動要約圧縮)、LLM 検証パス(感情の一貫性、温度0.1)、faction フォールバック + factions UI、2ノード間差分表示、エクスポート強化
- [ ] **フル版の関係図**(2026-07-25 ユーザー発案。予定): インスペクタ内のコンパクト版とは別に、
  しっかりしたバージョンを作る。置き場所は「キャラクターセクション内」か「関係図の独立セクション」か要検討。
  - 大きなキャンバスでスライダー等の操作(時間スクラブ、再生アニメーション?)
  - より詳細な情報表示: キャラ選択で facts / 記憶 / 関係一覧のサイドパネル、エッジ履歴のタイムライン表示、
    faction 表示、2ノード間差分(Phase 6 と統合)など
  - インスペクタ版は「選択ノード時点のクイックビュー」として残す
- [ ] 生成コンテキストの絞り込み(spec §6.1 準拠: cast 相互 + オフスクリーン上位3件。現状は全キャラ・全状態を入れており、キャラが増えると肥大化する)
- [ ] 残タスク(小): factions の UI(API のみ実装済み)、31B での動作確認、生成イベントの重複除去(12B は同一イベントを重複して出すことがある)、`GET /graph` の全ノード events 込み返却が大規模ストーリーで重くなったら分割
- [ ] 鑑賞モードの縦書き表示(2026-07-25 ユーザー発案。任意): CSS `writing-mode: vertical-rl` 自体は Chromium で動くが、ページ分割の実測を縦横入れ替える(高さ→幅の二分探索)必要がある。ページモードに追加する場合は右→左のページ送りも要検討

## 注意点

- **用語(2026-07-25 ユーザー決定)**: UI 表示は「ビート」→**「シーン」**、レンダー散文→**「清書」**。コード・DB スキーマ・spec・LLM プロンプト内は `beat` / `render` のまま変えない(表示ラベルのみ)。
- **Python は必ず `.venv` を使う**(ユーザー指示)。
- spec §12 の「Electron + FastAPI 起動骨格 ← lm-graph」は実態と異なる: lm-graph に Python バックエンドはない。FastAPI 構成の実例は news-picker / lm-chat 側。lm-graph からは spawn+ヘルスチェックのロジックだけ借りた。
- 検索層の移植(Phase 2)は lm-chat 直接ではなく news-picker 版を雛形にする(lm-chat には Ruri v3 の非対称プレフィックス欠落バグがあり、news-picker で修正済み)。
- llama-server バイナリはまだ本リポジトリに置いていない。lm-graph の `bin/llama-server/b9496-win-cuda13-x64` を流用予定。パスは settings で上書き可能にする。
- モデルは spec 目安(Q5)より上の Q6_K。VRAM が厳しければ 12B に切替。
- Windows の `python` コマンドは Store スタブなので venv 作成は `py -3.13` を使う。
- electron-vite dev では `app.getAppPath()` が `out/main` を返す。リポジトリルート解決は `.venv` の存在チェックで行っている(`src/main/index.ts` の `repoRoot`)。
- sidecar の起動は `ensureSidecar()`(in-flight Promise)で一本化している。`whenReady` と `bootstrap` IPC が同時に呼んでも spawn は 1 回。Windows は占有ポートでも listen チェックをすり抜けることがあるため、spawn 前に必ず既存ポートの `/health` を確認して healthy なら再利用する。
- バックエンドのライブラリ切替は `Store.switch_library`(接続差し替え・インスタンス再利用)。起動時は `STORY_GRAPH_LIBRARY` 環境変数(Electron が app.json から渡す)で解決。レンダラは起動時に app.json とバックエンドのライブラリが一致しているか確認して同期する(再利用 sidecar 対策)。
- bat ファイルに日本語を書かない(UTF-8 の日本語バイト列が cp932 パースで後続コマンドを壊す)。メッセージは ASCII のみ。
- FastAPI のエンドポイントは全て `async def` でイベントループ直列実行にして SQLite の書き込み競合を回避している(ローカル単一ユーザー前提)。ハンドラ内でブロッキングの長い処理(LLM 呼び出し等)を書くときはこの前提を崩さないよう注意(LLM 呼び出しは httpx の async 版を使う)。
- Phase 1 のノード削除は末尾のみ許可(単線維持のため)。

### 検索層の知見(2026-07-25)

- **trigram FTS は 3 文字未満の語を照合できない。** 日本語クエリは「語」抽出では機能しない(助詞込みで一続きになる)ため、クエリから文字トライグラムをストライド 1 で生成して OR 検索する(`retrieval._fts_terms`)。重み付けは bm25 に任せる。
- 埋め込みは書き込み時にモデルがロード済みの場合のみ行い、未処理分は検索時の `ensure_vectors` が自己修復する(初回ロード/ダウンロードで書き込みを塞がないため)。モデルは FastAPI startup でバックグラウンド warmup。
- Ruri のモデルキャッシュは `models/embeddings/`(gitignore 済み、約 1.2GB)。

### E2E 検証で得た LLM まわりの知見(2026-07-24)

- **llama.cpp のグラマー変換は JSON schema の `minimum`/`maximum` を無視する。** 数値の範囲制約はプロンプト指示 + 生成後の clamp(`generation.normalize_events`)で担保する。
- **条件付き required は表現できない。** fact_set の「scope=char なら char 必須」はスキーマを scope 別の 2 変種に分割して表現した。schema で強制しないと 12B は char を落とすことがあり、不正イベントが DB に入ると fold が壊れる(検証 `_missing_payload_fields` でも防御)。
- **グラマー制約下で空白のみを max_tokens まで生成し続けることがある**(Gemma + llama.cpp の既知事象、特に低温度)。finish_reason=length + 空内容として検出し、温度を変えてリトライで回避。
- SSE 生成器内で例外が漏れると接続が切れて原因が見えなくなる。`generate_beat_stream` は必ず error イベントに変換する構造にしている。
