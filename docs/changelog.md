# Changelog

## 未リリース

- 2026-07-25 00:09 Phase 2(編集耐性)を実装。分岐 DAG + 正史切替、ブランチ生成(what-if、draft 挿入)、手動イベント編集(イベント追加/削除、キャラ状態からの編集)、記憶 retrieval(Ruri v3 + FTS5 + sqlite-vec、RRF × 重要度 × 物語内順序減衰)を生成コンテキストに組込み。

- 2026-07-24 23:53 ライブラリ方式を導入(ストーリーごとのフォルダに DB を分離、ヘッダーから選択/切替/最近使った一覧)。ノードエリアのホイール操作をズームに修正(中ボタンドラッグ=パンは維持)。sidecar の二重 spawn を修正。

- 2026-07-24 23:31 Phase 1 M4(生成)を実装、Phase 1 完了。llama-server マネージャ、ビート生成(JSON schema 構造化出力 + SSE + 検証リトライ)、手動ビートのイベント抽出、LLM 起動/停止 UI。Gemma4-12B で E2E 検証済み。

- 2026-07-24 22:56 Phase 1 M1〜M3 を実装。Electron + React + FastAPI sidecar の骨格、SQLite スキーマ、fold エンジン + state_cache + ルール検証(pytest 19件)、UI シェル(構造モード 3 ペイン / キャラクター庫 / 設定)。`npm run dev` で起動可能。
- 2026-07-24 22:38 計画ドキュメント(docs/plan/goals.md / plan.md / progress.md)を作成。Phase 1 実装を開始。
