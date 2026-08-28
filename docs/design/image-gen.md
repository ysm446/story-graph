# 画像生成(ComfyUI 連携)— キャラクターの参照画像と場面の挿絵

作成日時: 2026-08-26 15:15
更新日時: 2026-08-28 06:50

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
| HTTP API クライアント + ワークフロー組み立て | `backend/comfy.py`(本体は `workflows/*.json`) | `llm.py` |
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

API 形式の JSON テンプレート `workflows/ref_t2i.json` を `comfy.build_t2i_workflow` が読み、
`{{name}}` の欄(checkpoint / positive / negative / seed / steps / cfg / shift / width / height …)を埋めて
`/prompt` に投げる(2026-08-28 ユーザー要望でコード直書きから `workflows/` へ移した。値が `{{name}}` だけの
欄は数値の型を保って差し込む。ComfyUI の「Save (API Format)」と同じ形なので、ComfyUI で調整した
ワークフローをそのまま置き換えられる)。
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
- **場面用の編集ワークフロー** `comfy.build_edit_workflow`(`workflows/scene_edit.json`。同じ AIO チェックポイント。
  テンプレートは 3 枚分の LoadImage を持ち、渡した枚数より後ろのノードと image2/3 の配線を build 時に外す):
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
2. `POST /characters/{id}/ref_image/generate` `{prompt, instructions?, seed?}` — 人物描写の後ろに共通の接尾辞
   (`REF_IMAGE_SUFFIX`: 全身・正面・ニュートラルなポーズ・無地の薄灰背景・単独)を機械的に足して生成。
   PNG を `assets/images/<uuid>.png` に**候補として**置き、`{image_path, seed, prompt, instructions, ref_chars}`
   を返す(ストックにもキャラにも入れない)。UI はプレビューを見せ、「決定」で `POST /media`
   (戻り値のセット付き、select)→ ストックに入り参照画像になる。決定しなかった候補は参照が無いので
   `gc_assets` が回収する(2026-08-28 ユーザー要望「決定したときだけストックに。過程の絵は廃棄でよい」)。
   seed は使った値を返し、UI の seed 欄に入る(同じ seed + 同じプロンプト = 同じ絵。-1(または 🎲)で
   ランダムにして別の絵を引く)。2026-08-27 ユーザー要望「生成しても即決定ではなく、確認してから」。
3. **追加指示と保存・復元**(2026-08-27 ユーザー要望): モーダルに「追加指示」欄(日本語可。
   「制服姿で」「20 代後半に」など外見欄を変えるほどではない一時的な指示)を置き、1. の LLM 呼び出しに
   `instructions` として渡して英語プロンプトへ織り込む(`image_gen._with_instructions`。最終プロンプトに
   直接足す案 B は、英語で書く必要があり LLM の本文と矛盾しやすいので採らない)。
   プロンプト・追加指示・seed は `characters.ref_image_prompt / ref_image_instructions / ref_image_seed`
   に保存し、**次に開いたときはそのまま復元する(LLM は呼ばない)**。保存するのは**「生成」したとき**だけ
   (2026-08-28、再現性のため): 生成に使った 3 つが常に 1 セットで揃う(サーバが generate の中で
   ストックの行とキャラの列の両方に書く)。「決定」は画像だけを設定し、
   「閉じる」は何も保存しない(手直しや書き直し途中の欄で保存済みのセットを崩さない)。
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
   生成(1216×832、接尾辞 `SCENE_SUFFIX`)。`assets/images` に候補として保存し
   `{image_path, seed, prompt, instructions, ref_chars}` を返す。採用は UI の「決定」→ `POST /media`
   (セット付き、select)。決定しなかった候補は `gc_assets` が回収する。
3. UI は `SceneImageModal.tsx`(インスペクタの挿絵欄「生成」)。cast のトグルで渡す参照画像を選ぶ
   (参照画像の無いキャラは押せず、文章での描写になる)。選び方を変えるとラベルがずれるので、
   「書き直す」を押すまで生成ボタンを止める。生成 → プレビュー → 「決定」/ seed を変えて「もう一度生成」/
   「閉じる」(不採用)。seed 欄と候補プレビューは `ImageCandidate.tsx` で参照画像側と共用。
   候補プレビューは生成前に**いま設定されている画像**(`current`、表示専用)を見せ、上のラベルで
   「いまの挿絵 / いまの参照画像 / 生成した候補(未決定)」を区別する。「決定」の対象は生成した候補だけ。
   **追加指示**欄(日本語可)は 1. の LLM に渡してプロンプトへ織り込む。変えたら「書き直す」まで生成を止める。
   **プロンプト・追加指示・seed・参照キャラ**は `nodes.image_prompt / image_instructions / image_seed /
   image_ref_chars`(`POST /nodes/{id}/image_gen`)に保存し、次に開いたとき復元する(保存済みなら LLM は
   呼ばない。dirty 化しない装飾の設定)。保存は参照画像と同じく**「生成」したときだけ**で、生成に使った
   4 つを 1 セットで書く(サーバが generate の中でストックの行とシーンの列の両方に書く。
   `instructions` は generate の入力に含める)。「決定」は挿絵だけ、「閉じる」は保存しない。
4. 実測(2026-08-26): プロンプト 6 秒、生成 14.6 秒(参照 2 枚)。2 人とも参照画像どおりの
   顔・服装で描かれた。VRAM は 31B 同居で 47.3GB まで上がった(48.9GB 中)。

## 7. ストック(候補の一覧と選び直し)

2026-08-28 ユーザー発案「画像(動画)を何枚かカードにストックし、候補から 1 枚を選ぶ形にすれば、
入れ替えで前の画像が消えることがなく安心。候補ウインドウに削除ボタンも」。

**考え方**: これまで挿絵・参照画像は持ち主に 1 枚だけで、差し替えると前のファイルは参照が外れて
`gc_assets` に回収されていた(= 入れ替えは事実上の削除)。ストックは「参照を残す」ことで、
削除を作者の明示操作だけにする。seed を変えて何枚か引き、あとで見比べて選ぶ使い方にも合う。

1. **データ**: `media(id, owner_type: node|character, owner_id, path, thumb_path, prompt, instructions,
   seed, ref_chars, created_at)`。`nodes.image_path` / `characters.ref_image_path` は
   **「選択中の 1 枚」としてそのまま残す**ので、読み手モード・カード・場面生成の参照画像渡しは変わらない。
   生成物は**生成に使ったプロンプト・追加指示・seed(・参照キャラ)を 1 セット**で持つ(再現用)。
   ドロップ / ファイル選択で足した手持ちの画像はすべて NULL。`SCHEMA_VERSION = 3` の移行で、設定済みの
   画像をそれぞれの持ち主の最初の候補として登録する(そのときの保存状態を添える)。
2. **参照保護**: `ASSET_REF_SQLS` に `media.path` / `media.thumb_path` を足したので、`gc_assets` も
   スナップショットの参照保護もストック内のファイルを守る。持ち主(シーン / キャラ)を消すと
   その行も消える。動画のサムネイルは `set_node_thumb` が `media.thumb_path` にも写し、
   選び直したときに作り直さない。
3. **API**: `GET /media/{owner_type}/{owner_id}` → `{items(新しい順), selected}`。
   `POST /media {owner_type, owner_id, path, select=true, prompt?, instructions?, seed?, ref_chars?}` は
   手持ちのファイル(アップロード後、セット無し)と生成ウインドウの「決定」(generate の戻り値のセット付き)の
   両方が通る。**ストックに入るのは決定した画像だけ**で、生成の過程の候補は残さない。
   `POST /media/{id}/select` で現在の画像にする(生成物なら**生成ウインドウの保存状態もそのセットに戻す**。
   手持ちの画像は保存状態に触れない)。`DELETE /media/{id}` は**選択中の 1 枚なら 400**
   (先に別の候補を選ぶか、画像を外す)。`DELETE /media/{owner_type}/{owner_id}/unselected` で
   選択中以外をまとめて消す。
4. **UI**: `MediaPicker.tsx`(インスペクタの挿絵欄・参照画像パネルの「ストック」ボタン)。
   カードの格子(場面は 3 列横長、参照画像は 4 列縦長)。クリックで選択、選択中はアクセント枠 +
   「選択中」バッジ、動画は右下に「動画」。各カードの下に seed(手持ちは「手持ち」)と「削除」
   (選択中は押せない)。上に「+ 追加」(選択せずに足す)と「選んでいない候補を削除(N)」。
   ツールチップに seed・追加指示・プロンプト(先頭 160 字)を出す。
   生成ウインドウの「決定」は `addMedia(path, select, セット)`、ドロップ / ファイル選択は `addMedia(select=true)`、
   「外す」は従来どおり `image_path = NULL`(ストックは残る)。

## 8. この先

- ワークフロー JSON は `workflows/` に出し、`variants.json` で組を選べるようにした(2026-08-28。下記 §9)。
  Krea2 用など別モデルの組を足すのは、テンプレートと variants の行を足すだけ。
- VRAM 不足時に LLM を一時停止する排他パス。

## 9. ワークフローの組(variants)と LoRA 版

2026-08-28 ユーザー要望「LoRA(`qwen-image-zeniji.safetensors`)を挟んだワークフローを追加し、
生成時に既定 / LoRA 版を選べるように」。

- `workflows/variants.json` の `variants[]` が「生成ウインドウで選べる組」。各行は
  `{id, label, t2i, edit, values}`。`t2i` はキャラの参照画像と参照画像なしの場面、`edit` は参照画像ありの
  場面に使うテンプレート名(`workflows/<name>.json`)。`values` はテンプレートの `{{name}}` に追加で入る値
  (LoRA 版なら `lora` / `lora_strength`)。先頭が既定。**`id` は DB に保存されるので変えない。**
- LoRA 版のテンプレート `ref_t2i_lora.json` / `scene_edit_lora.json` は、既定の
  `CheckpointLoaderSimple("1")` と `ModelSamplingAuraFlow("2")` の間に `LoraLoaderModelOnly("9")` を挟んだもの
  (CLIP は触らない。Qwen-Image 系の LoRA は model のみが通例)。LoRA ファイルは ComfyUI の `loras/`
  (`D:i-models\diffusion\comfyui\loras`)から名前で参照する。
- `comfy.list_variants()` / `get_variant(id)`(不明な id は既定に落として生成は止めない)。
  `build_*_workflow(template=, extra_values=)` に組を渡す。`GET /comfy/workflows` が UI 用の一覧。
- **組はセットの一部**: LoRA の有無で絵が変わるので、プロンプト・seed と同じく
  `nodes.image_workflow` / `characters.ref_image_workflow` / `media.workflow` に生成時の id を保存し、
  次に開いたとき復元、ストックから選び直したときもそのセットに戻る。手持ちの画像は NULL。
- UI は `ImageCandidate.WorkflowSelect`(seed 欄の隣のセレクト。両モーダル共用)。組が 1 つしか無ければ
  出さない。一覧は開くたびに読むので、`variants.json` を編集すればアプリを再起動せずに反映される。
