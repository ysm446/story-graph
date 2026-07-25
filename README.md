# Story Graph

ノードベース・ストーリー構築アプリ。物語を「シーン(ビート = 出来事の仕様書)」の DAG として組み立て、各シーンが発行するイベントの畳み込み(fold)からキャラクター・世界の状態を任意時点で導出します。散文はシーンから分離された「清書」として鑑賞モードで生成します。すべてローカル(llama.cpp + SQLite)で完結します。

## 設計原則

1. **シーンが正史、散文は清書結果。** 状態抽出・編集・分岐はすべてシーン層で行う
2. **状態は保存せず、常に導出。** ルートからのイベント畳み込みが唯一の真実
3. **関係はスパース。** イベントが発行されたペアにしかエッジは存在しない
4. **清書は状態を変更しない。** 散文化は読み取り専用の一方向変換
5. **LLM 由来の変更も手動修正も、同じイベントとして記録する**

詳細仕様は [docs/story-graph-spec.md](docs/story-graph-spec.md) を参照。

## 主な機能

- **構造モード** — React Flow キャンバスに正史タイムラインと what-if 分岐を表示。シーン生成(構造化出力でイベントも同時生成)、ブランチ生成、正史切替、手動イベント編集、校正(選択範囲対応・プレビュー付き)、タイトル/感情の核の自動生成、挿絵の添付(ドラッグ&ドロップ)
- **インスペクタ** — シーン編集 / その時点のキャラ状態(facts・関係値・記憶)/ 関係図(時間スクラブ、関係ラベル、エッジ履歴、ズーム・パン)
- **鑑賞モード** — シーケンシャル清書(前シーンの末尾と接続)、スタイルプリセット(システムプロンプト全文編集可)、POV(視点キャラが知る情報のみで描写)、表示スタイル 3 種(縦読み / 挿絵分割 / ページ+シークバー)、フォント・文字サイズ変更、散文の一節をシーンへ取り込み、Markdown エクスポート
- **相談チャット** — 物語の状態をツールで自分で調べて答えるエージェント。アンカーまでの情報しか見えないスコープ制御(ネタバレ防止)、展開の提案カード → draft ブランチ挿入
- **キャラクター** — プロフィール・口調・表示色・ポートレート(切り抜き UI、元画像保持で再調整可)
- **記憶検索** — Ruri v3 埋め込み + FTS5 のハイブリッド検索(RRF × 重要度 × 物語内時間減衰)を生成コンテキストに注入
- **ライブラリ方式** — ストーリーごとのフォルダにデータ(SQLite + 画像)が完結。ヘッダーから切替

## 必要環境

- Windows(開発・動作確認は Windows 11)
- Node.js 24.x + npm
- Python 3.13(`py` ランチャー経由で検出)
- NVIDIA GPU 推奨(llama.cpp の CUDA ビルドを使用)
- llama.cpp の `llama-server.exe`(CUDA ビルド)
- GGUF モデル(既定: Gemma4-31B / 12B。`models/` 配下に配置)

## セットアップと起動

```
git clone <このリポジトリ>
cd story-graph
start.bat
```

`start.bat` が初回に `npm install` と `.venv` 作成(+ `backend/requirements.txt`)を行い、アプリを起動します。Electron 起動時に FastAPI サイドカーが自動で spawn されます。

初回に確認すること:

1. **モデル**: `models/` 配下に GGUF を置く(例: `models/gemma-4-31B-it-GGUF/gemma-4-31B-it-Q6_K.gguf`)。設定画面のドロップダウンから選択
2. **llama-server**: 設定画面「llama-server.exe のパス」に CUDA ビルドの実行ファイルを指定(既定値あり)。シーン生成・清書時に自動起動される(tool calling のため `--jinja` 付きで起動)
3. **埋め込みモデル**: 記憶検索用の Ruri v3-310m は初回に自動ダウンロードされ、`models/embeddings/` にキャッシュされる(約 1.2GB)

### 開発コマンド

```
npm run dev          # 開発起動(Electron + sidecar)
npm run typecheck    # TypeScript 型チェック
npm run build        # ビルド

cd backend
..\.venv\Scripts\python.exe -m uvicorn app:app --port 8765   # バックエンド単体起動
..\.venv\Scripts\python.exe -m pytest tests/ -q              # バックエンドテスト
```

## データ(ライブラリ)

ストーリーごとに 1 フォルダ = 1 ライブラリです。フォルダ内に `story-graph.db`(SQLite)、`assets/images/`(添付画像)、`screenshot/`(F12 スクリーンショット)が入り、フォルダごとバックアップ・移動できます。既定のライブラリはリポジトリ内 `data/` で、サンプルストーリー「白樺荘の密室」が `data/sample-locked-room/` にあります(ヘッダーの 📁 メニューから切替)。

## アーキテクチャ

```
Electron (main)
 ├─ BrowserWindow ── renderer (React + TypeScript + Tailwind + React Flow)
 │                      │  HTTP + SSE (localhost)
 └─ spawn ──────────► FastAPI sidecar (Python, .venv)
                        ├─ SQLite (sqlite-vec + FTS5) … データの唯一の所有者
                        ├─ fold エンジン / 検証 / 生成・清書パイプライン / チャットエージェント
                        └─ spawn ──► llama-server.exe (:8080)
```

- レンダラは FastAPI と直接通信(生成・清書・チャットは SSE ストリーミング)
- fold は純粋関数。状態キャッシュは `input_hash` + dirty 伝播で遅延再計算
- LLM の構造化出力は llama.cpp の JSON schema 制約を使用(既知の制限と対策は [docs/plan/progress.md](docs/plan/progress.md) の知見メモ参照)

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/story-graph-spec.md](docs/story-graph-spec.md) | 正式仕様(データモデル、イベントスキーマ、fold、各モード) |
| [docs/plan/goals.md](docs/plan/goals.md) | 目的と完成形 |
| [docs/plan/plan.md](docs/plan/plan.md) | 実装方針・移植元マップ |
| [docs/plan/progress.md](docs/plan/progress.md) | 進捗・注意点・実装知見 |
| [docs/design/system-prompts.md](docs/design/system-prompts.md) | LLM プロンプトの構成と編集可能範囲 |
| [docs/changelog.md](docs/changelog.md) | 変更履歴 |

## ライセンス

MIT
