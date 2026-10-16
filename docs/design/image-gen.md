# 画像生成(ComfyUI 連携)— キャラクターの参照画像・場面の挿絵・場所の画像

作成日時: 2026-08-26 15:15
更新日時: 2026-10-16 23:40

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
  既定値は steps 4 / cfg 1 / shift 3.1(蒸留モデルの推奨)。チェックポイント名と steps / cfg / shift は
  組の `values` が持つ(§12。2026-10-16 から設定画面には無い)。ネガティブプロンプトだけ設定 `comfy_negative`。
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

- **システムプロンプトは設定で差し替え可**(2026-10-16 23:40)。`image_gen.PROMPT_SETTING_KEYS`(人物 / 場所 / 挿絵の人物選び / 挿絵の描写)。
  空なら既定の定数。設定画面 → システムプロンプト → 「画像生成プロンプト」。接尾辞と顔の本文は編集不可で読み取り専用に見せる
  (`GET /image_prompts`)。[system-prompts.md](system-prompts.md) を参照。

- `characters.ref_image_path` — 参照画像のファイル名(`assets/images`)。`gc_assets` の参照保護に含めた。
- `characters.ref_image_prompt` — 生成に使った人物描写(英語)。画像を外しても残す。
- settings: `comfy_base_url` / `comfy_models_dir` / `comfy_workflow`(既定のワークフローの組の id)/
  `comfy_negative`(アプリ単位。`app_settings` の `comfy_` 接頭辞)。`comfy_checkpoint` は組に checkpoint が
  書かれていないときの予備としてだけ読む。`comfy_steps` / `comfy_cfg` / `comfy_shift` はもう読まない(§12)。

## 6. 場面の挿絵

1. `POST /nodes/{id}/image/prompt` `{char_ids | null, instructions}` — ビート・感情の核・場所(実効ロケーションの
   description / atmosphere)・cast(外見つき)を LLM に渡し、**1 つの瞬間**を英語で描写させる
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
4. **絵に入れる人物は本文で話す・動く人だけ**(2026-10-16 23:06 ユーザー判断「3 人目でも黙っていれば省く。必要最低限の会話か、
   その場面に適した行動を描く」。cast 全員が仲良く談義している絵ばかりになっていた)。
   `image_gen.choose_scene_focus`(`FOCUS_SYSTEM`、`chat_json` で `character_ids` を最大 3 つ。cast が 1 人以下なら呼ばない。
   失敗・空なら cast 順のまま = 従来の結果)で中心の人物を選び、**手本(参照画像)もその人物から**取る。外した人物は
   `_scene_notes` の "Also present in the scene but NOT in the picture (leave them out)" で名前だけ知らせる(知らないと
   別人として作り直すことがある)。`SCENE_PROMPT_SYSTEM` にも「話す・動く人物だけ(ふつう 1〜2 人、最大 3 人)、
   ほかの cast は背景の人影としても描かない、その瞬間に必要な最低限のやり取りか行動だけ、本文に無い和やかな談義にしない」を足した。
   手動の生成ウインドウは `char_ids` 未指定(既定)でこの選び方になり、作者が手本を選び直したときはその人物を中心にする。
   制作チャットの予約(§14)も同じ。実測: 3 人の cast(2 人が口論、1 人は離れて黙って作業)で中心は 2 人、
   黙っている人物は絵に出ず、背を向けた緊張した構図になった(`data/test/auto-images-focus`)。
4. 実測(2026-08-26): プロンプト 6 秒、生成 14.6 秒(参照 2 枚)。2 人とも参照画像どおりの
   顔・服装で描かれた。VRAM は 31B 同居で 47.3GB まで上がった(48.9GB 中)。

## 7. ストック(候補の一覧と選び直し)

2026-08-28 ユーザー発案「画像(動画)を何枚かカードにストックし、候補から 1 枚を選ぶ形にすれば、
入れ替えで前の画像が消えることがなく安心。候補ウインドウに削除ボタンも」。

**考え方**: これまで挿絵・参照画像は持ち主に 1 枚だけで、差し替えると前のファイルは参照が外れて
`gc_assets` に回収されていた(= 入れ替えは事実上の削除)。ストックは「参照を残す」ことで、
削除を作者の明示操作だけにする。seed を変えて何枚か引き、あとで見比べて選ぶ使い方にも合う。

1. **データ**: `media(id, owner_type: node|character|place, owner_id, path, thumb_path, prompt, instructions,
   seed, ref_chars, created_at)`。`nodes.image_path` / `characters.ref_image_path` は
   **「選択中の 1 枚」としてそのまま残す**ので、読み手モード・カード・場面生成の参照画像渡しは変わらない。
   生成物は**生成に使ったプロンプト・追加指示・seed(・参照キャラ)を 1 セット**で持つ(再現用)。
   ドロップ / ファイル選択で足した手持ちの画像はすべて NULL。`SCHEMA_VERSION = 3` の移行で、設定済みの
   画像をそれぞれの持ち主の最初の候補として登録する(そのときの保存状態を添える)。
2. **参照保護**: `ASSET_REF_SQLS` に `media.path` / `media.thumb_path` を足したので、`gc_assets` も
   スナップショットの参照保護もストック内のファイルを守る。持ち主(シーン / キャラ)を消すと
   その行も消える。サムネイル(`nodes.thumb_path`)は `set_node_thumb` が `media.thumb_path` にも写し、
   選び直したときに作り直さない。サムネイルはレンダラの `thumbs.ts` が構造モードを開いたときに
   未生成のものだけ 1 件ずつ作る: 動画は先頭フレームの JPEG、静止画は長辺 576px の WebP
   (2026-10-12 まで静止画は原寸のままカードに出していた。長辺が 576px 以下の画像は原画を
   そのまま thumb_path に登録する)。カードはサムネイルだけを表示し、原寸は鑑賞モードと
   詳細欄で使う。
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
  (LoRA 版なら `lora` / `lora_strength`)。既定は設定の `comfy_workflow`(未設定・不明なら先頭。§12)。
  **`id` は DB と設定に保存されるので変えない。**
- LoRA 版のテンプレート `ref_t2i_lora.json` / `scene_edit_lora.json` は、既定の
  `CheckpointLoaderSimple("1")` と `ModelSamplingAuraFlow("2")` の間に `LoraLoaderModelOnly("9")` を挟んだもの
  (CLIP は触らない。Qwen-Image 系の LoRA は model のみが通例)。LoRA ファイルは ComfyUI の `loras/`
  (`D:\ai-models\diffusion\comfyui\loras`)から名前で参照する。
- `comfy.list_variants()` / `get_variant(id, default_id)`(不明な id は既定に落として生成は止めない)。
  `build_*_workflow(template=, extra_values=)` に組を渡す。`GET /comfy/workflows` が UI 用の一覧。
- **組はセットの一部**: LoRA の有無で絵が変わるので、プロンプト・seed と同じく
  `nodes.image_workflow` / `characters.ref_image_workflow` / `media.workflow` に生成時の id を保存し、
  次に開いたとき復元、ストックから選び直したときもそのセットに戻る。手持ちの画像は NULL。
- UI は `ImageCandidate.WorkflowSelect`(seed 欄の隣のセレクト。両モーダル共用)。組が 1 つしか無ければ
  出さない。一覧は開くたびに読むので、`variants.json` を編集すればアプリを再起動せずに反映される。
- **組の `values` が最後に入る**(steps / cfg / shift / checkpoint …)。モデルごとに向く値が
  違うため(Qwen-Rapid は 4 steps、Krea2 Turbo は 8 steps)。2026-10-16 からは設定画面に steps などの欄は無い(§12)。
- **`_optional` ノード**: テンプレートのノードに `"_optional": "<name>"` を書くと、組の `values[name]` が
  空のときそのノードを配線ごと外す(`model` 入力の上流を、そのノードを参照していた入力へ付け替える)。
  「挟むだけ」の LoRA ローダーの有無を、テンプレートを複製せずに組で切り替えるため。

## 10. Krea2 Turbo の組

2026-08-28 ユーザー質問「Krea2 で Qwen-Image と同じことはできるか」→ 仕組み上は同じ経路が組めるので、
見比べられるように組を足した(実機での品質は未検証)。

- 同梱 ComfyUI の公式テンプレート「Text to Image (Krea-2 Turbo)」「Image Style Reference (Krea-2 Turbo)」を
  API 形式に写した `krea2_t2i.json` / `krea2_edit.json`。Krea2 は AIO ではなく
  `UNETLoader(diffusion_models/krea2_turbo_bf16)` + `CLIPLoader(text_encoders/qwen3vl_4b_fp8_scaled, type=krea2)` +
  `VAELoader(vae/qwen_image_vae)` の 3 つを別々に読む(`D:\ai-models\diffusion\comfyui` に全部ある)。
  サンプリングは `ModelSamplingFlux(max_shift 1.15 / base_shift 0.5)` → `CFGGuider(cfg 1)` →
  `SamplerCustomAdvanced`(euler / simple / 8 steps)。負側は `ConditioningZeroOut`。
- **参照画像の経路は Qwen-Image-Edit と同じ** `TextEncodeQwenImageEditPlus(image1..3)`。Krea2 の本体が
  `ref_latents` を受ける(`comfy/ldm/krea2/model.py`)ので、`FluxKontextMultiReferenceLatentMethod
  (index_timestep_zero)` を挟んで渡す。公式の用途は 1 枚の *style reference* なので、人物の同一性は
  `krea2_identity_edit_v1_2` LoRA("9"、edit では必須)に頼る。**2〜3 人の参照を同時に渡して両方の顔を
  保てるかは未検証**(以前の調査メモどおり 1 枚寄り。2 人場面は Qwen 側が有利な見込み)。
- 組は `krea2`(identity のみ)と `krea2_zeniji`(+ `krea2-zeniji-style` を "13" で重ねる)。
  設定画面のチェックポイントは使わず、モデル名は `values` で持つ。

## 11. Qwen Image 2.1 の組

2026-10-10 ユーザー要望「Qwen Image 2.1 を追加」。組の id は `qwen21`。

- **ComfyUI v0.37.0 以降が必要**(2.1 の対応が入った版。v0.34.0 はモデルを判別できない)。同梱の portable 版を
  v0.39.0 に入れ直した(設定 →「画像生成」のインストールでも同じことができる)。既定の組(Qwen-Rapid-AIO)は
  v0.39.0 でもそのまま動く。
- 公式テンプレート「Text to Image / Image Edit (Qwen Image 2.1)」から、プロンプト書き直し用の LLM
  (prompt enhancer。別のモデルが要る)を除いて API 形式に写した `qwen21_t2i.json` / `qwen21_edit.json`。
  プロンプトは従来どおりアプリ側の LLM が書く。
- 読むのは 3 ファイル: `UNETLoader(diffusion_models/qwen_image_2.1_int8_convrot)` +
  `CLIPLoader(text_encoders/qwen3vl_8b_int8_convrot, type=qwen_image)` + `VAELoader(vae/qwen_image_2.1_vae_bf16)`。
  2.1 は従来の Qwen-Image とは別のモデル(VAE も別)なので、`qwen_image_vae` や Qwen-Image 用の LoRA は使えない。
- **エンコードは 1 ノード** `TextEncodeQwenImage21`("3")。正・負の両方を出す(出力 0 / 1)ので "4" は無い。
  参照画像は `images.image_1..`(公式は 16 枚まで。アプリは従来どおり 3 枚まで)。モデルの前に
  `QwenImage21Cache`("2"、auto / default)を挟む。サンプリングは `KSampler`(euler / simple)で、shift のノードは無い。
- **値は公式テンプレートどおり** steps 25 / cfg 1(cfg 1 では負のプロンプトは使われない。公式パイプラインは
  40〜50 steps)。`ref_resolution` 1024 は参照画像を縮める目安(約 1024×1024 相当の画素数。縦横比は保つ)。
- **参照画像の指し方は `<image1>`**。場面プロンプトは組を選ぶ前に `image1` の形で書かれるので、組の
  `ref_label`(`<image{n}>`)を見て `image_gen.apply_ref_label` が渡す直前に直す(保存されるプロンプトは `image1` のまま)。
- 公式の Image Edit は 1 枚目の参照画像の大きさで描く(1 枚目が「編集対象」)が、ここは立ち絵から横長の場面を
  描くので `EmptyLatentImage` で 1216×832 を決める(公式の custom_size オンと同じ配線)。
- `build_edit_workflow` は、使わない LoadImage を指す配線を**入力名によらず**外すようにした
  (これまでは "3" / "4" の `image2` / `image3` を名前で外していた)。
- **実測(2026-10-10、LLM 停止中)**: 立ち絵(832×1216)7〜12 秒(初回はモデルのロード込み)、
  2 人の場面(参照 2 枚、1216×832)14.4 秒。2 人とも参照画像どおりの髪・服で描かれた。25 steps でも
  4 steps の Qwen-Rapid-AIO(同じ条件で 3〜8 秒 / 11.4 秒)と大差ない。モデルは 3 ファイルで約 16GB と
  AIO(26GB)より軽い。**31B と同居したときの VRAM、3 人の場面は未確認**。

## 12. 既定のワークフロー(モデルは組が持つ)

2026-10-16 ユーザー要望「既定のチェックポイントのように、既定のワークフローも設定したい」
「ワークフローを選ぶかたちにすれば、モデルのほうは意識しなくていい」。

- 設定画面の「画像生成」は**既定のワークフロー**(`comfy_workflow`)を選ぶ。チェックポイント・ステップ数・
  CFG・シフトの欄はなくし、ネガティブプロンプトだけ残した(作品の好みに近いので)。
- 組の解決は `image_gen.resolve_variant`: 生成ウインドウで選んだ / 保存済みの組 → 設定の既定 → `variants.json` の先頭。
  生成ウインドウ(`WorkflowSelect`)は、まだ描いていない(保存済みの組が null)ときに既定の組を選んだ状態で開き、
  null のまま送る(サーバが同じ既定の組で描く)。**描いたことのある絵は、そのとき使った組で開く**(再現のため)。
  組を記録していない古い絵(null)は、いまの既定の組で開く。
- Qwen 系の組(`default` / `zeniji`)も `values` に `checkpoint` と steps / cfg / shift を書いた。組に
  `checkpoint` が無ければ以前の設定 `comfy_checkpoint` を予備として使う(移行前の `variants.json` でも描ける)。
  書かれなかった steps / cfg / shift は `comfy.DEFAULT_*`(Qwen-Rapid の推奨値)。
- **値の書き忘れは送る前に止める**: テンプレートに埋まらない `{{name}}` が残ったら `comfy.MissingValuesError`
  (`_check_filled`)。`image_gen._build` が「ワークフロー「…」で使うモデル(checkpoint)が決まっていません」の
  ように組の名前を添えて返す。
- **モデルがそろっているかの確認**: `GET /comfy/workflows?check=true` が組ごとに `models`(`[{key, folder, name}]`)と
  `missing`(ComfyUI のフォルダに無いもの。ComfyUI が止まっていれば null)を返す。使うモデルは
  `comfy.variant_models` がテンプレートのローダーの入力名から拾う(`ckpt_name` → checkpoints、`unet_name` →
  diffusion_models、`clip_name*` → text_encoders、`vae_name` → vae、`lora_name` → loras。`_optional` で外れるノードは除く)。
  設定画面は選んだ組のモデルを並べ、見つからないものを赤で「見つかりません」と出し、選択肢にも「(モデルが足りません)」を添える。

## 13. 場所の画像

2026-10-16 ユーザー発案「場所の画像も説明から画像生成できるように」。あわせて「シーンの画像を作るときに
背景の画像があると良い」という話があり、**場所の画像は人物なし・横長の全景**で作る(背景の手本に回せる形)。
場面生成へ背景の手本として渡すのは別の作業(手本は合計 3 枚までで人物と枠を取り合い、構図が背景の画像に
引っ張られるおそれもあるので、場面の生成ウインドウのオン/オフで試す予定)。

- **流れ**: キャラの参照画像と同じ 2 段。`POST /places/{id}/image/prompt`(SSE。説明・雰囲気 + 追加指示 →
  LLM → 風景描写の英語タグ)→ 確認・手直し → `POST /places/{id}/image/generate`(候補として assets に保存)→
  「決定」で `POST /media {owner_type: 'place'}`。
- **プロンプト**: `image_gen.PLACE_PROMPT_SYSTEM`(見えるものだけ。人物・名前・出来事・カメラや画風の語は書かない。
  画風の指定があれば先頭のタグに)。後ろに `PLACE_IMAGE_SUFFIX`(scenery, establishing shot, wide view,
  no people …)を機械的に足す。
- **生成**: 組の `t2i` テンプレートで **1216×832**(場面の挿絵と同じ横長)、`filename_prefix = story-graph/place`。
- **データ**: `places.image_prompt / image_instructions / image_seed / image_workflow`(生成ウインドウの
  保存状態。キャラの `ref_image_*` と同じく「生成」したときにサーバが 1 セットで書く)。`places.image_path` は
  ストックの「選択中の 1 枚」。`SCHEMA_VERSION = 4` の移行で、設定済みの場所の画像を最初の候補(手持ち)として
  登録する。場所を消すとストックの行も消える。場所の画像は装飾専用のままなので、差し替えても清書は stale にしない。
- **UI**: 場所のページの画像の下に「ストック」「説明から生成」(画像があれば「作り直す」)。生成ウインドウは
  `PlaceImageModal.tsx`。ドロップ / ファイル選択もストックに足してから選択する(前の画像は消えない)。

## 14. 制作モードでの人物・場所の画像生成(自動と「〇〇の画像を作って」)

2026-10-16 ユーザー要望「制作モードの LLM がキャラクターを作成するときに画像も生成して、アイコンに
良い感じのサイズでセットしてほしい」「背景も同じように」「画像のない人物に『〇〇の画像を作って』もできるか」。
顔は全身像から切り抜くのではなく、**顔だけ別に描く**(ユーザー発案。切り抜きより顔の描き込みが良く、
Pillow も顔検出も要らない)。実装は `backend/auto_images.py`。

- **2 つの入口**。どちらも描くのは制作チャットの作業の終わり(下記)。
  1. **自動**: 設定 → 画像生成の「人物を作ったら画像も作る」(`comfy_auto_character_images`)と
     「場所を作ったら画像も作る」(`comfy_auto_place_images`)。"1" でオン、アプリ単位、既定はオフ
     (VRAM は 31B と ComfyUI の同居でぎりぎりなので常時オンにはしない)。この作業で `create_character` /
     `create_place` した資料が対象。画像が既にある資料は飛ばし、`update_*` では描き直さない(§4 の方針のまま)。
  2. **予約ツール `generate_images`** `{kind: character | place, ids, reason}`(制作を実行のときだけ渡す。相談モードでは
     他の書き込みと同じく案内して終わる)。作者が「〇〇の画像を作って」と頼んだときに制作 LLM が呼ぶ。
     ID の存在と外見(説明)の有無をその場で検証し、`reserved_images` に (kind, id) を積んで
     「画像の生成を予約しました: 「…」(作業の終わりに描きます)」を会話に残す(履歴 `image_request`)。
     ツール結果には「終了報告では描かれたと書かず、終了後に描かれると伝える」の注記を添える。
     予約は DB の変更ではないので `changes`(スナップショット・件数)には数えない。
     **設定がオフでも描き、画像があっても描き直す**(前の参照画像・場所の画像はストックに残る。
     プロフィール画像は差し替え)。
- **「画像は作れない」と答えさせない**(2026-10-16。gemma 4 31B が「製塩工場の画像をつくって」に
  「画像を生成する機能は持っておりません」と答えた): `EXECUTE_RULES` / `CONSULT_RULES` に「このアプリは人物・場所の
  画像を ComfyUI で描ける」と明記。加えてサーバー側で `production_guard.wants_images`(「画像 / イラスト / 絵 /
  アイコン / 立ち絵」+「作 / 描 / 生成 …」)を見て、相談モードは返答に「制作を実行」が無ければ
  `CONSULT_IMAGE_GUIDANCE` を添え、実行モードは予約が無いまま終えようとしたら `IMAGE_REQUEST_NOTE` を
  1 回だけ注記して判断し直させる(`monitor.add_note("images")`)。実 LLM で確認: 実行は `read_library` →
  `generate_images`、相談は切替案内。
- **タイミング**: `production_agent.stream` が判断ループを抜け、まとめ・作業メモの見直しまで終わった後、
  `done` の前に `image_hook`(`auto_images.run`。`app.py` の `/production/send` が渡す)を呼ぶ。
  描く一覧は `auto_images.requests_for(created, reserved)`(同じ資料は予約を優先、最初に出た順)。
  人物の確定の中で待たないのは、1 件 10〜60 秒かかるためと、ComfyUI の失敗で資料の作成を失敗にしないため。
- **人物 1 人の流れ**: `llm.chat`(非ストリーム)で `image_gen.PROMPT_SYSTEM` の人物描写を書く(手動の
  「外見から書き直す」と同じ messages)→ `generate_character_image` で参照画像(832×1216)→
  `add_media("character", select)`(手動の「生成 → 決定」と同じ形。プロンプト・seed・組を 1 セットで残す)→
  **参照画像を image1 に渡して**組の `edit` テンプレートで顔(`auto_images.portrait_workflow`。1024×1024、
  `PORTRAIT_REF_PROMPT` + `PORTRAIT_SUFFIX`。人物描写は手本が持つので本文に書かない)→ `assets/images` に置き
  `portrait_path` に直接セット(`portrait_source_path` / `portrait_crop` は NULL。ストックには入れない。
  選び直したい要望が出たら `media.owner_type = "portrait"` を足す)。参照画像が無い組み合わせでは
  `t2i` で人物描写 + 顔の接尾辞にフォールバックする(いまは参照画像を先に作るので通らない)。
- **場所 1 件の流れ**: `image_gen.PLACE_PROMPT_SYSTEM` で風景描写 → `generate_place_image`(1216×832、§13)→
  `add_media("place", select)`。
- **シーンの挿絵**(2026-10-16 20:06 ユーザー要望「シーンの画像を作るツールは?」): `generate_images {kind: "scene", ids: [node_id]}`
  で予約だけ(シーンを作ったときの自動生成は無い。1 枚 15〜30 秒かかり、本文を直した後に描き直すことが多いため)。
  `auto_images._draw_scene`: cast の順に参照画像のある人物を 3 人まで手本に(`select_scene_refs`。手動の生成ウインドウの既定と同じ)、
  実効ロケーションの場所と本文から `SCENE_PROMPT_SYSTEM` で場面のプロンプトを書き(`llm.chat`)、`generate_scene_image`(§6)→
  `add_media("node", select, ref_chars)`。目印のノード・本文が空のシーンは予約の時点で拒否。画面へは `image_changed {kind: "scene"}`
  だけ(`active_library` は無し)。実 LLM で確認: 「出発の挿絵を作って」→ `generate_images(scene)` 1 回で予約 → 作業の終わりに
  参照画像のケンを手本にした挿絵(1216×832)が入り、outcome は completed。
- **候補ボタン**: 相談モードで画像の依頼(`productionSuggestions.ts` の `IMAGE_REQUEST`。backend の
  `IMAGE_REQUEST_PATTERN` と同じ形)をした後は、LLM の候補に任せず固定で「この画像を制作を実行で作る」
  (作者の依頼文をそのまま「制作を実行」で送る)を先頭に出す。このとき固定の「この案で進めて」は出さない。
- **作業対象を追う**(2026-10-16 22:04 ユーザー要望): 対象が決まった `stage` には kind / id が付き、`production_agent` は
  シーンなら `active_node`(フローチャートでそのシーンを選んで枠が光る)、人物・場所なら `active_library`(資料庫のページを開く)を
  添えて流す。描き終わりの知らせの後に `active_node: null` で枠の光を消す。
- **画面**: 進捗は `stage`(「「名前」の参照画像を描いています…」など)で流し、資料ごとの結果は
  会話の本文(`delta`、履歴に `auto_image: true`)に残す。画像が入ったら `image_changed {kind, id}` を送り、
  `ProductionChat` が `notifyGraphChanged()`(フローチャート)と `workspace.changed()`(資料庫。`revision` でしか
  読み直さないので必須。2026-10-16 にユーザー報告「何かをしたら急に更新された」で判明)で資料(アイコン)を読み直す。あわせて `active_library`
  で作業対象を追っていればその資料を開く。
- **失敗**: ComfyUI を起動できなければ 1 件の知らせで終える。資料ごとの失敗(VRAM 不足など)はその資料の
  知らせにして次へ進む。外見もプロフィールも(説明も雰囲気も)無い資料は知らせるだけ。どの場合も資料の
  設定と確定済みの変更は残す。
- **実測(2026-10-16)**: 既存の参照画像から顔 1 枚 11〜13 秒(Qwen 既定の組と zeniji の組。どちらも同じ
  顔・髪・服装で、顔が枠いっぱい)。通し(31B でプロンプト → 描画。`data/test/auto-images-smoke`)は
  場所 12 秒、人物 24 秒(参照画像 9 秒 + 顔 13 秒)。栗色の髪・緑の目・ロケットなど指定どおりで、
  顔は参照画像と同じ人物だった。
