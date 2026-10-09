# plan — 実装方針と優先順位

作成日時: 2026-07-24 22:38
更新日時: 2026-10-10 06:03

## アーキテクチャ決定

```
Electron (main)
 ├─ BrowserWindow ── renderer (React + TS + Tailwind + React Flow)
 │                      │  HTTP + SSE (localhost)
 └─ spawn ──────────► FastAPI sidecar (Python, .venv)
                        ├─ SQLite (sqlite-vec + FTS5)  … DBの唯一の所有者
                        ├─ fold エンジン / 検証 / コンテキスト構築
                        └─ spawn ──► llama-server.exe (:8080, Gemma4-31B)
```

- **レンダラは FastAPI と直接 HTTP/SSE で通信する。** lm-graph の「メインプロセス fetch → IPC push」方式は採らない(データ層が Python 側にあるため中継が無駄)。Electron IPC はウィンドウ制御・sidecar のライフサイクル管理のみ。
- **llama-server の管理(spawn / ポート探索 / ヘルスチェック)は sidecar が持つ。** バックエンド単体で起動して curl / pytest で検証できるようにする(Electron なしで開発ループを回せる)。
- **Python は必ずリポジトリ直下の `.venv` を使う**(ユーザー指示)。
- DB スキーマ・イベントスキーマ・fold 規則は spec §3〜§5 が正。移植元のスキーマは一切引き継がない。

## 移植元マップ(調査済み、すべてローカル)

| 移植元 | 持ってくるもの | 参照ファイル |
|---|---|---|
| `D:\GitHub\lm-graph` | デザイントークン(CSS変数+Tailwind任意値、紫アクセント #7c5af7、ダーク固定)、React Flow の UX 規約(ホイールズーム無効・中ボタンパン・矩形選択・snap 20px・ドット背景)、electron-vite 構成、llama-server spawn ロジック(TS→Python に翻訳) | `src/renderer/src/index.css`, `App.tsx`, `flowEdges.tsx`, `electron.vite.config.ts`, `src/main/llamaServer.ts` |
| `D:\GitHub\news-picker` | ハイブリッド検索層(**lm-chat 版でなくこちらを雛形にする**。非対称プレフィックス修正済み・依存最小)、エージェント型チャット(tool calling ループ、SSE 中の tool_calls 断片組み立て)、FastAPI 構成 | `server/search_vault.py`, `server/embed.py`, `server/store.py`, `server/chat_agent.py`, `server/llm.py` |
| `D:\GitHub\lm-chat` | FTS5 trigram トークナイザの使い方、スキーマ版管理(`PRAGMA user_version`)の作法 | `backend/store_base.py`, `backend/store_memory.py` |

## 確定済みの技術判断

- FTS5 は `tokenize='trigram'`(日本語の分かち書き不要)。ベクトルは `vec0` + FLOAT[768](Ruri v3-310m)。RRF は k=60。
- 時間減衰は半減期式 `0.5^(Δ/half_life)` の入力を「実時間」→「正史パス上の story_order 差分」に差し替える(spec §12)。
- ビート生成は llama.cpp の JSON schema 制約(`response_format` / `json_schema`)で 1 パス構造化出力(spec §6.2)。
- モデルは `models/` 配下の Gemma4-31B Q6_K(12B Q6_K も検証用に配置済み)。llama-server バイナリは lm-graph の `bin/llama-server/b9496-win-cuda13-x64` を流用可能。
- fold は純粋関数として実装し、UI から独立に pytest で回帰テストする。イベント適用は「正史パス順 → seq 順、後勝ち」。

## フェーズ計画

spec §13 の 6 フェーズに従う。Phase 1〜5 は完了し、Phase 6 は未完了。
以下のPhase 1の分解は初期計画として残す。最新の実装状況は [progress.md](progress.md) を参照。

### Phase 1 の分解

- **M1 — 骨格**: electron-vite + React + Tailwind の起動、デザイントークン移植、`.venv` + FastAPI 起動(`/health`)、Electron main からの sidecar spawn
- **M2 — データ層**: SQLite スキーマ(spec §3 全テーブル)、characters / factions CRUD、nodes / edges CRUD(単線タイムライン)、fold エンジン + state_cache(input_hash / dirty)+ ルールベース検証。pytest で fold の回帰テスト
- **M3 — UI**: UI シェル(ヘッダー + 4 モード切替)、構造モード 3 ペイン(React Flow 縦タイムライン / インスペクタ: ビート編集 + キャラ状態閲覧)、キャラクター庫 CRUD 画面、設定画面(LLM エンドポイント)
- **M4 — 生成**: llama-server マネージャ(Python)、コンテキスト構築(Phase 1 は直近ビート+プロフィールのみ。記憶 retrieval は Phase 2)、ビート生成(JSON schema 構造化出力、SSE でストリーム表示)、ルール検証 NG 時のリトライ

Phase 1 では作らないもの: 分岐(DAG は単線のみ)、手動イベント編集 UI、記憶 retrieval、LLM 検証パス、鑑賞モード、関係グラフ、相談チャット。

### Phase 2 以降(spec §13 のまま)

- Phase 2 — 編集耐性: 分岐 DAG + 正史切替、手動イベント、dirty 伝播と再fold、記憶 retrieval
- Phase 3 — 関係グラフ / Phase 4 — 鑑賞モード / Phase 5 — 相談チャット / Phase 6 — スケール対応

## 追加機能の計画（制作チャットは段階0実装済み）

追加機能として **制作チャット** を進める。段階0の挿入・更新・削除と逐次表示、停止を実装・検証済み。追加で制作中の途中指示、変更範囲・保護指定、1シーンの並べ替え・枝の親変更に対応。既存の読み取り専用の相談とは分け、
会話で依頼された範囲のノード作成・編集・削除・接続変更を行い、作業を逐次キャンバスへ反映する。
設計・実装順序・検証観点は [制作チャットの計画](../design/production-chat.md) を参照。
手動編集への切替・保存後の再開とノード単位の競合検出まで対応済み。作業メモの保存・更新と別会話や再起動後の引継ぎも対応済み。
6章・48シーンのあらすじで、途中指示・再構成・引継ぎを含む7工程の実機検証を完了。
次は作者の作品で意図・人物像・言い回しの適合を確認する。追記時の余計な意味付けには課題が残る。
詳細は [検証記録](../reference/production-scenario-validation.md)。手動編集切替は補助機能とする。
作業基盤 → 作成・編集 → 再構成 → 作業メモと再開の順を実装案とし、Phase 6との着手順・日程は未確定。

## リスクと備え

- **31B Q6_K の VRAM/速度**: 12B Q6_K を開発時の代替として使えるようにモデル選択を settings に置く。
- **JSON schema 制約出力の安定性**: 生成 NG 時のリトライ(最大2回)をルール検証とセットで最初から入れる(spec §6.3)。
- **App.tsx 一枚岩問題**: lm-graph は 4000 行単一ファイルだが、story-graph は 4 モードあるため最初からモード単位でファイル分割する(デザイントークンと UX 規約だけを移植し、コンポーネント構造は新規)。
