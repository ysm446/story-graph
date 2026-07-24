# progress — 進捗と注意点

作成日時: 2026-07-24 22:38
更新日時: 2026-07-24 22:56

## 現在の状態

- Phase 1 の M1(骨格)・M2(データ層)が完了。M3(UI)は基本形まで実装済み。次は M4(生成)。
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

## 未完了(Phase 1)

- [ ] **M4 — 生成**: llama-server マネージャ(Python、spawn / ポート / ヘルスチェック)、コンテキスト構築(直近ビート3件 + cast プロフィール)、ビート生成(JSON schema 構造化出力 + SSE)、検証 NG 時のリトライ(最大2回)、手動ビートのイベント抽出パス
- [ ] M3 残: factions の UI(Phase 1 では API のみ)、インスペクタからの手動イベント編集 UI(spec では Phase 2)

## 注意点

- **Python は必ず `.venv` を使う**(ユーザー指示)。
- spec §12 の「Electron + FastAPI 起動骨格 ← lm-graph」は実態と異なる: lm-graph に Python バックエンドはない。FastAPI 構成の実例は news-picker / lm-chat 側。lm-graph からは spawn+ヘルスチェックのロジックだけ借りた。
- 検索層の移植(Phase 2)は lm-chat 直接ではなく news-picker 版を雛形にする(lm-chat には Ruri v3 の非対称プレフィックス欠落バグがあり、news-picker で修正済み)。
- llama-server バイナリはまだ本リポジトリに置いていない。lm-graph の `bin/llama-server/b9496-win-cuda13-x64` を流用予定。パスは settings で上書き可能にする。
- モデルは spec 目安(Q5)より上の Q6_K。VRAM が厳しければ 12B に切替。
- Windows の `python` コマンドは Store スタブなので venv 作成は `py -3.13` を使う。
- electron-vite dev では `app.getAppPath()` が `out/main` を返す。リポジトリルート解決は `.venv` の存在チェックで行っている(`src/main/index.ts` の `repoRoot`)。
- FastAPI のエンドポイントは全て `async def` でイベントループ直列実行にして SQLite の書き込み競合を回避している(ローカル単一ユーザー前提)。ハンドラ内でブロッキングの長い処理(LLM 呼び出し等)を書くときはこの前提を崩さないよう注意(LLM 呼び出しは httpx の async 版を使う)。
- Phase 1 のノード削除は末尾のみ許可(単線維持のため)。
