# ノードが引き継ぐもの / 引き継がないもの

作成日時: 2026-07-26 07:20
更新日時: 2026-07-26 07:20

シーン(ノード)を辿ったときに、何が前のシーンから受け継がれ、何がそのシーン限りなのかの
一覧。編集や分岐・島の接続で「どこまで自動で整合が取れるのか」を判断するための資料。

原則は spec §4-5 のとおり:

- **真実は `events`**。`state`(fold 結果)/ `memories` / `state_cache` はすべて導出物で、
  いつでも再構築できる
- **state(node) = fold(state(parent), events(node), cast(node))** — ルートから順に畳む。
  ルート(親のいないノード = 島の根)は空の state から始まる
- 分岐は**分岐点までの state を共有**し、そこから独立に畳まれる

## 1. 引き継ぐもの(state。親から積み上がる)

fold の実装は [backend/fold.py](../../backend/fold.py)。すべて「後勝ち」で解決する。

| 引き継ぐ値 | 変化させるイベント | 積み方 |
|---|---|---|
| `world.time` | `fact_set(scope="world", key="time")` | 上書き |
| `world.facts[key]` | `fact_set(scope="world")` | キー単位で上書き |
| `chars[id].status` | **cast(導出)** / `char_retire` | cast にいれば `introduced`、退場イベントで `retired` |
| `chars[id].retire_reason` | `char_retire` | 上書き |
| `chars[id].facts[key]` | `fact_set(scope="char")` | キー単位で上書き |
| `chars[id].relationships[t].score` | `relationship_update`(delta 加算)/ `relationship_set`(絶対値) | ±1.0 で clamp |
| `chars[id].relationships[t].label` | 同上の `label` | 上書き(後勝ち) |
| `chars[id].relationships[t].reasons` | 同上 | **イベント ID を蓄積**(関係図のエッジ履歴に使う) |
| `chars[id].memories` | `memory_add` / `memory_compress` | 追加 / `replaces` を要約1件に置換 |
| 任意のパス | `manual_override` | `chars.aya.facts.location` のようなドット区切りパスへ代入 |

**登場(introduced)は cast からの導出**(2026-07-26 変更)。`fold(parent_state, events, cast)` が
cast のキャラを未登場なら初登場として作る。`char_introduce` イベントは廃止した(古いデータに
残っていても冪等なので無害。右クリックの「整合を取る」で掃除できる)。
既に `retired` のキャラは作り直されないので、**cast に入れても蘇生しない**(矛盾は検証が警告)。

## 2. 引き継がないもの(そのシーン限りの項目)

`nodes` テーブルの列は、原則すべてそのノードだけのもの。**次のシーンには自動で伝わらない。**

| 項目 | 引き継がれない結果どうなるか |
|---|---|
| `title` / `beat` / `emotional_core` | シーン固有なので当然 |
| `cast` | 空にすれば「誰も出ていないシーン」。登場の導出元なので、書かないと state にも現れない |
| `location` | **空欄だと清書プロンプトが「場所: 不明」になる**(引き継ぎは未実装。検討中) |
| `story_time` | 清書と相談チャットに渡す参考情報。空欄なら渡らない |
| `image_path` | 挿絵(装飾専用。LLM には渡さない) |
| `pos_x` / `pos_y` | キャンバス上の手動配置(NULL なら自動レイアウト) |

## 3. 導出される(持たないが自動で決まる)もの

| 値 | 決まり方 | 再計算のきっかけ |
|---|---|---|
| `chars[id].status`(登場) | cast にいるか | cast の編集(`input_hash` に cast を含めている) |
| `nodes.status`(canon / draft) | 正史パス上にいるか | `make_canon` / エッジの切断・接続 / ノード削除 |
| `memories.story_order` | 正史パス上の位置。**分岐上は -1** | 正史の変更、挿入・削除、切断・接続 |
| `state_cache` | `fold` の途中結果 | `input_hash`(親 state hash + events hash + cast)が変わる or dirty |
| `renders.stale` | 上流が変わったら立つ | `mark_dirty_downstream` |

## 4. 記憶の「引き継ぎ」は参照だけ

`chars[id].memories` はイベント ID の配列で、本文は `memories` テーブル(events からの導出)にある。
生成や相談チャットで**実際に想起されるのはハイブリッド検索の上位数件**で、全部が毎回渡るわけではない。

- 検索は FTS5(trigram)+ sqlite-vec のコサイン距離を RRF で融合し、`importance` と
  **`story_order` 距離の半減期減衰**(HALF_LIFE_BEATS = 20)を掛ける([backend/retrieval.py](../../backend/retrieval.py))
- **分岐ノード上の記憶は `story_order = -1`** = 「現在」扱い(距離 0)なので減衰しない
- 候補は「そのノード時点の state にある記憶 ID」に限定されるので、**未来や他人の記憶は混ざらない**

## 5. 清書(散文)の引き継ぎ

清書は state とは別系統で、**直前シーンの散文の末尾**を引き継ぐ。

- `renders` は `node_id + preset_id + pov_char` 単位。同じシーンでも「三人称・標準」と
  「アヤ視点」は別に保存される
- 正史パス上で 1 つ前のシーンの清書があれば、その**末尾 ~1400 字**をスライディングウィンドウとして
  プロンプトに渡す(`## 直前シーンの末尾(この続きから書く)`)
- したがって**清書は順番に実行する必要がある**(一括清書も正史順に並べ替えて逐次実行している)

## 6. 編集操作ごとの波及

| 操作 | state | story_order | 清書 |
|---|---|---|---|
| ビート本文の編集 | 変わらない(イベントを直さない限り) | — | `stale` が立つ |
| cast の編集 | **登場が変わる**(導出) | — | `stale` |
| イベントの編集 / 再抽出 | 下流すべて dirty | — | `stale` |
| シーンの挿入 / 削除 | 下流すべて dirty | 再同期 | `stale` |
| エッジの切断 | 島は**空 state から**畳み直す | 再同期(島は -1) | `stale` |
| エッジの接続 | 島が**上流の state を引き継ぐ** | 再同期 | `stale` |
| 正史の切替(`make_canon`) | パスが変わるので dirty | 再同期 | `stale` |

**エッジの接続で LLM は不要**(2026-07-26 の判断): 状態は fold が親から積み直すので、繋ぐだけで
正しく積み上がる。接続直後に走るのは `normalize_chain`(不要になった `char_introduce` の掃除と検証)
だけで、LLM は起動しない。LLM の再抽出が要るのは、**関係値の delta や記憶の文面がその文脈に
合わない**ときだけ(島を「関係ゼロ」前提で書いていた場合など)。経緯は
[changelog](../changelog.md) の 2026-07-26 05:10 の項。

## 7. 今後の検討

- **location の引き継ぎ**: 空欄なら親から遡って直近の場所を使う(実効ロケーション)。
  「場所が変わらない限り書かない」書き方を許すため。清書 / 生成コンテキスト / 相談チャット /
  ノード表示の 4 箇所を差し替える想定
- **記憶の入手経路**(`source: experience | witness | told`): [progress.md](../plan/progress.md) の未完了に登録済み
- **memory_compress の自動化**(Phase 6): 記憶が増えたときに古いものを要約1件へ畳む
