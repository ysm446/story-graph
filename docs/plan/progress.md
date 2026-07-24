# progress — 進捗と注意点

作成日時: 2026-07-24 22:38
更新日時: 2026-07-24 23:53

## 現在の状態

- **Phase 1(コアループ MVP)完了。** M1〜M4 すべて実装・E2E 検証済み。次は Phase 2(編集耐性)。
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

## 未完了

- [ ] **Phase 2 — 編集耐性**: 分岐 DAG + 正史切替、手動イベント編集 UI、記憶 retrieval(news-picker の検索層を移植)をコンテキスト構築に組込み
- [ ] Phase 1 残タスク(小): factions の UI(API のみ実装済み)、31B での動作確認、生成イベントの重複除去(12B は同一イベントを重複して出すことがある)

## 注意点

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

### E2E 検証で得た LLM まわりの知見(2026-07-24)

- **llama.cpp のグラマー変換は JSON schema の `minimum`/`maximum` を無視する。** 数値の範囲制約はプロンプト指示 + 生成後の clamp(`generation.normalize_events`)で担保する。
- **条件付き required は表現できない。** fact_set の「scope=char なら char 必須」はスキーマを scope 別の 2 変種に分割して表現した。schema で強制しないと 12B は char を落とすことがあり、不正イベントが DB に入ると fold が壊れる(検証 `_missing_payload_fields` でも防御)。
- **グラマー制約下で空白のみを max_tokens まで生成し続けることがある**(Gemma + llama.cpp の既知事象、特に低温度)。finish_reason=length + 空内容として検出し、温度を変えてリトライで回避。
- SSE 生成器内で例外が漏れると接続が切れて原因が見えなくなる。`generate_beat_stream` は必ず error イベントに変換する構造にしている。
