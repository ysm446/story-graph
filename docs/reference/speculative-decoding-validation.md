# 投機的デコーディング(31B + 下書きモデル)の速度検証

作成日時: 2026-10-26 13:22
更新日時: 2026-10-26 13:22

## 目的

31B の清書を、出力の質を変えずに速くできるかを確かめる。下書き役に Gemma 4 E2B を付けた投機的デコーディング(llama-server の `--spec-draft-model`)を、31B 単体と比べた。

## 条件

- 本体: `gemma-4-31B-it-Q4_K_M.gguf`。下書き: `gemma-4-E2B-it-Q4_K_M.gguf`(`--spec-type draft-simple --spec-draft-n-max 3`。先読み 3 は既定値)。
- サーバー: `runtime/llama-b10430-bin-win-cuda-13.3-x64/llama-server.exe`、検証専用ポート 18099、ctx 16384、`--flash-attn on --n-gpu-layers 999 --jinja`。
- GPU: NVIDIA RTX PRO 5000 Blackwell(48GB)。
- お題: サンプル作品(`data/sample-locked-room`)の 4 シーンを、アプリと同じ `rendering.build_render_messages` で清書するプロンプト(三人称・標準、1200 字指定)にした。temperature 0.9(清書と同じ)、各 3 回。毎回プロンプト処理から測る(`cache_prompt: false`)。
- 計測スクリプトと生データ: `data/test/spec-decoding/`(使い捨て)。

## 結果

| 構成 | 生成速度 | 1 シーンの所要 | 下書きの採用率 | VRAM |
|---|---|---|---|---|
| 31B 単体 | 46.7 tok/s | 17.2 秒 | - | 25.6GB |
| 31B + E2B(先読み 3) | 37.2 tok/s(0.80 倍) | 20.4 秒 | 37% | 27.2GB |

- 4 シーンとも同じ傾向だった(31B 単体は 45.9〜47.2 tok/s、E2B 付きは 34.8〜38.9 tok/s)。
- 下書きの採用率が 37% と低い。そのため、下書きを作る手間と検証の手間が、当たったトークン分の得を上回った。
- 先読み 8 と E4B 下書きの構成は、先読み 3 の時点で遅くなったため打ち切った。先読みを増やすと外れが増える。E4B は採用率が上がる見込みはあるが、下書き 1 トークンあたりの重さが E2B の倍近い。

## 確認できたこと

- Gemma 4 の E2B / E4B / 26B A4B / 31B は、語彙(262,144 語)と merges が完全に一致する。E2B だけ GGUF の `add_bos_token` が false だが、llama-server が Gemma 4 では true に上書きするので、下書きとして読み込める。
- `--cache-reuse` は、下書きの有無にかかわらず Gemma 4 では無効になる(`cache_reuse is not supported by this context, it will be disabled`)。アプリが付けている `--cache-reuse 256`([backend/llama_manager.py](../../backend/llama_manager.py))は、Gemma 4 では効いていない。

## 結論

日本語の清書(temperature 0.9)では、E2B を下書きにした投機的デコーディングで速くはならず、逆に約 2 割遅くなる。アプリへの組み込みは見送る。
