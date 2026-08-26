# 画像生成(ComfyUI 連携)— キャラクターの参照画像と場面の挿絵

作成日時: 2026-08-26 15:15
更新日時: 2026-08-27 02:20

ローカルの ComfyUI で挿絵を作る仕組みの設計メモ。2026-08-26 のユーザー発案
([progress.md](../plan/progress.md) の「場面の画像生成」)。画像は**装飾専用**で、
ビート・イベント・状態には一切影響しない([goals.md](../plan/goals.md) 原則 4)。

## 1. 全体像

```
外見の記述 ──LLM──▶ 英語プロンプト ──ComfyUI(t2i)──▶ 参照画像(全身の立ち絵)   ← 今回実装
                                                      │
場面(ビート + cast) ──LLM──▶ 場面プロンプト ──ComfyUI(画像編集, image1..3 = 参照画像)──▶ 挿絵   ← 実装済み
```

- **参照画像を先に作る**のは、場面ごとにゼロから描くと同じ人物にならないため。複数画像入力を
  取れる編集モデル(Qwen-Image-Edit 2509 系)に参照画像を渡せば、LoRA 無しで外見が揃う。
- **外部読み込みと内部生成は同じ枠**。参照画像はドロップ / ファイル選択でも置けるし、
  生成結果を手持ちの画像で差し替えることもできる(保存経路も同じ `assets/images`)。

## 2. プロセスと配置(llama と同じ作法)

| 役割 | ファイル | 相当する llama 側 |
|---|---|---|
| portable 版のダウンロード・展開・削除 | `backend/comfy_installer.py` | `llama_installer.py` |
| spawn / ヘルスチェック / 停止 | `backend/comfy_manager.py` | `llama_manager.py` |
| HTTP API クライアント + ワークフロー組み立て | `backend/comfy.py` | `llm.py` |
| 参照画像のプロンプト生成 + 生成の段取り | `backend/image_gen.py` | `generation.py` |

- **外部起動を優先**: 設定 `comfy_base_url`(既定 `http://127.0.0.1:8188`)が応答すればそれを使う。
  応答しなければ `runtime/comfyui/` の portable 版を spawn する(`python_embeded\python.exe -s ComfyUI\main.py`)。
- **インストールは 1 箇所だけ**(`runtime/comfyui/`)。portable 版は Python と torch 同梱で 5GB 級あるため、
  llama のようにビルドを並べない。GitHub `Comfy-Org/ComfyUI` のリリースから `ComfyUI_windows_portable_*.7z`
  を落とし、Windows 同梱の bsdtar(`System32\tar.exe`)で展開する(2GB。py7zr は portable 版が使う BCJ2 フィルタに非対応)。staging → rename の置き換えも llama と同じ。
- **モデルはコピーもリンクもしない**。設定 `comfy_models_dir`(既定はこの PC の
  `D:\ai-models\diffusion\comfyui`。無ければ空 = 同梱の `models/` のみ)を、起動のたびに
  `ComfyUI/extra_model_paths.yaml` に `base_path` として書き出す(`is_default: true`)。
  フォルダ構成は ComfyUI の `models/` と同じ(checkpoints / diffusion_models / loras / vae / …)前提。
- **VRAM**: RTX PRO 5000(48GB)で 31B Q6_K(ctx 32k)と Qwen-Rapid-AIO を同居させた実測は
  **46.3GB / 48.9GB**(2026-08-26)。ぎりぎり入るが余裕は 2GB 強。ctx を増やすか大きい画像を
  作ると溢れるので、足りない環境では設定画面から LLM を先に停止する運用
  (自動の排他は未実装。必要になったら `comfy_manager.ensure_running` の前で `llama.stop_async()` を挟む)。
- **所要時間(実測)**: ComfyUI 起動 35 秒、参照画像のプロンプト生成 22 秒(31B のロード込み)、
  画像生成 11 秒(832×1216、4 steps。初回はモデルロード込み)。portable 版の展開は bsdtar で 46 秒。

## 3. ワークフロー

API 形式の JSON を `comfy.build_t2i_workflow` で組み立てて `/prompt` に投げる。
ノード ID は固定(テスト `tests/test_comfy.py` が参照):

```
1 CheckpointLoaderSimple(AIO)
2 ModelSamplingAuraFlow(shift)   ← 1.model
3 CLIPTextEncode(positive)       ← 1.clip
4 CLIPTextEncode(negative)       ← 1.clip
5 EmptySD3LatentImage 832×1216
6 KSampler(steps / cfg / euler / simple) ← 2, 3, 4, 5
7 VAEDecode ← 6, 1.vae
8 SaveImage(story-graph/ref)
```

- 前提は **VAE とテキストエンコーダを 1 ファイルにまとめた AIO 版**(`Qwen-Rapid-AIO`)。
  既定値は steps 4 / cfg 1 / shift 3.1(蒸留モデルの推奨)。設定 `comfy_steps` / `comfy_cfg` /
  `comfy_shift` / `comfy_negative` で上書き。
- 実行は `/prompt` → `/history/{id}` を 1 秒ごとにポーリング → 出力の `images[0]` を `/view` で取得。
  クライアント切断(AbortController)では `/interrupt` を送って GPU を解放する。
- **場面用の編集ワークフロー** `comfy.build_edit_workflow`(同じ AIO チェックポイント):
  `LoadImage`("10"〜"12")→ `TextEncodeQwenImageEditPlus`("3" 正 / "4" 負。clip + vae + image1..3)→
  `EmptySD3LatentImage 1216×832` → KSampler → VAEDecode → SaveImage。参照画像は `/upload/image`
  (`input/story-graph/`)へ先に上げる。参照画像が 1 枚も無ければ t2i にフォールバック(`image_gen.scene_workflow`)。
- 別モデル(Krea2 など)は、同じ形でワークフロー関数を増やす。

## 4. 参照画像の作り方

1. `POST /characters/{id}/ref_image/prompt` — 外見・プロフィールから LLM(31B)が**人物の見た目だけ**を
   英語のタグ列で書く(`image_gen.PROMPT_SYSTEM`。名前・性格・背景・画風の語は禁止。40〜90 語)。
   **SSE でストリーミング**(`{meta} → {delta}… → {done, prompt}`。JSON schema は使わず平文で書かせ、
   引用符・コードフェンスだけ `_clean_prompt` で剥がす。2026-08-27 ユーザー要望)。
   保存はしない。UI はモーダルのプロンプト欄へ delta を流し込み、手直しさせる。
2. `POST /characters/{id}/ref_image/generate` `{prompt, seed?}` — 人物描写の後ろに共通の接尾辞
   (`REF_IMAGE_SUFFIX`: 全身・正面・ニュートラルなポーズ・無地の薄灰背景・単独)を機械的に足して生成。
   PNG を `assets/images/<uuid>.png` に**候補として**置き、`{image_path, seed}` を返すだけ
   (キャラには設定しない)。UI はプレビューを見せ、「決定」で `PATCH /characters`(`ref_image_path` /
   `ref_image_prompt`)する。不採用の候補は参照が無いので `gc_assets` が回収する。
   seed は使った値を返し、UI の seed 欄に入る(同じ seed + 同じプロンプト = 同じ絵。-1(または 🎲)で
   ランダムにして別の絵を引く)。2026-08-27 ユーザー要望「生成しても即決定ではなく、確認してから」。
3. **追加指示と保存・復元**(2026-08-27 ユーザー要望): モーダルに「追加指示」欄(日本語可。
   「制服姿で」「20 代後半に」など外見欄を変えるほどではない一時的な指示)を置き、1. の LLM 呼び出しに
   `instructions` として渡して英語プロンプトへ織り込む(`image_gen._with_instructions`。最終プロンプトに
   直接足す案 B は、英語で書く必要があり LLM の本文と矛盾しやすいので採らない)。
   プロンプト・追加指示・seed は `characters.ref_image_prompt / ref_image_instructions / ref_image_seed`
   に保存し(生成・決定・閉じるのたび)、**次に開いたときはそのまま復元する(LLM は呼ばない)**。
   外見を書き換えたときは「外見から書き直す」で作り直す。追加指示を変えたら書き直すまで生成を止める。
   画像そのものの**自動再生成はしない**。

参照画像から顔を切り抜いてプロフィール画像(`portrait_path`)にする導線がある(逆は無い)。
`ImageCropModal` に `sourcePath` を渡し、`portrait_source_path` を参照画像にする。

## 5. データ

- `characters.ref_image_path` — 参照画像のファイル名(`assets/images`)。`gc_assets` の参照保護に含めた。
- `characters.ref_image_prompt` — 生成に使った人物描写(英語)。画像を外しても残す。
- settings: `comfy_base_url` / `comfy_models_dir` / `comfy_checkpoint` / `comfy_steps` / `comfy_cfg` /
  `comfy_shift` / `comfy_negative`(ライブラリごと)。

## 6. 場面の挿絵

1. `POST /nodes/{id}/image/prompt` `{char_ids | null, instructions}` — ビート・感情の核・場所(実効ロケーションの
   description / atmosphere)・story_time・cast(外見つき)を LLM に渡し、**1 つの瞬間**を英語で描写させる
   (`SCENE_PROMPT_SYSTEM`)。参照画像を渡すキャラは `image1..3` のラベルで、名前は使わせない。
   SSE: 冒頭の `{meta:{suffix, refs, cast}}` で「誰が image1.. か」を返し、続けて `{delta}` を流す。
   `char_ids` 省略時は cast 順に参照画像のあるキャラを最大 3 人自動選択(`select_scene_refs`)。
2. `POST /nodes/{id}/image/generate` `{prompt, char_ids, seed?}` — 参照画像を ComfyUI に上げ、編集ワークフローで
   生成(1216×832、接尾辞 `SCENE_SUFFIX`)。`assets/images` に候補として保存し `{image_path, seed}` を返す。
   採用は UI の「決定」→ `POST /nodes/{id}/image`(挿絵と同じ経路。サムネイルは落ちる)。
3. UI は `SceneImageModal.tsx`(インスペクタの挿絵欄「生成」)。cast のトグルで渡す参照画像を選ぶ
   (参照画像の無いキャラは押せず、文章での描写になる)。選び方を変えるとラベルがずれるので、
   「書き直す」を押すまで生成ボタンを止める。生成 → プレビュー → 「決定」/ seed を変えて「もう一度生成」/
   「閉じる」(不採用)。seed 欄と候補プレビューは `ImageCandidate.tsx` で参照画像側と共用。
   **追加指示**欄(日本語可)は 1. の LLM に渡してプロンプトへ織り込む。変えたら「書き直す」まで生成を止める。
   **プロンプト・追加指示・seed・参照キャラ**は `nodes.image_prompt / image_instructions / image_seed /
   image_ref_chars`(`POST /nodes/{id}/image_gen`)に保存し、次に開いたとき復元する(保存済みなら LLM は
   呼ばない。dirty 化しない装飾の設定)。
4. 実測(2026-08-26): プロンプト 6 秒、生成 14.6 秒(参照 2 枚)。2 人とも参照画像どおりの
   顔・服装で描かれた。VRAM は 31B 同居で 47.3GB まで上がった(48.9GB 中)。

## 7. この先

- ワークフロー JSON をテンプレート化して差し替え可能に(Krea2 用など)。
- VRAM 不足時に LLM を一時停止する排他パス。
