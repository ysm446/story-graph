# UI スタイルガイド(色・タイポ・余白・部品)

作成日時: 2026-08-09 16:00
更新日時: 2026-10-19 06:22

新しい画面や部品を足すときに **見た目を揃えるための具体値** をまとめる。
[overview.md](overview.md) がアーキテクチャの入口なら、本書は UI の入口。

ここに書いてある値は思いつきではなく、**いまのコードの実測**(`src/renderer/src/**`)。
迷ったら本書の値を使い、ここに無い見た目が必要になったら **まず既存の近い部品を探す**。

## 0. 原則

1. **ダーク固定・紫アクセント。** ライトテーマは持たない(`color-scheme: dark`)。
   トークンは lm-graph から移植したもの
2. **色は必ず CSS 変数を経由する。** Tailwind の色クラス(`text-gray-400` など)は使わない。
   `style={{ color: 'var(--text-dim)' }}` か `text-[var(--...)]` の形にする
3. **情報密度は高め、装飾は控えめ。** 本文 12px、補助 11px。物語の情報そのものが主役なので、
   影・グラデーション・大きな余白でカードを飾らない
4. **強い色は意味があるときだけ。** アクセント紫は「いま選んでいる / これから実行する」、
   赤は「壊れている・消える」、緑は「動いている」。それ以外は無彩色で並べる
5. **クリックできるものには `data-tip` を付ける。** アイコンだけのボタンは特に。
   日本語で「何が起きるか」を書く(素の `title` は使わない。§4 のツールチップを参照)

## 1. 色

### デザイントークン(`src/renderer/src/index.css` の `:root`)

| 変数 | 値 | 使う場所 |
|---|---|---|
| `--bg` | `#0d0f14` | アプリの地。`body` と全画面の背景 |
| `--bg-sidebar` | `#111318` | 左右のペイン、ヘッダー、ステータスバー |
| `--bg-canvas` | `#181b23` | React Flow のキャンバス、画像の下地 |
| `--bg-chat` | `#13161e` | 相談チャットの本文領域 |
| `--bg-input` | `#1a1d27` | 入力欄・数値バッジ・コード |
| `--bg-card` | `#1c1f2b` | 浮いている面(モーダル、ポップオーバー、ノードカード) |
| `--bg-elevated` | `rgba(32,35,48,0.5)` | 一覧の行、ヘッダー内のボタンなど**半透明の一段上** |
| `--border` | `#252830` | 通常の枠線(区切り、カード) |
| `--border-strong` | `#2e3140` | 押せるものの枠線、見出しの下線、モーダルの枠 |
| `--text` | `#d0d3e1` | 本文・主要な値(2026-10-14 に `#e2e4ef` から少し落とした。チャットの長い文章で白がまぶしかったため。色相は同じで、明るさだけ約 8% 下げた) |
| `--text-dim` | `#9499b0` | ラベル、二次ボタンの文字 |
| `--text-faint` | `#5c6078` | 補足、無効、単位、eyebrow |
| `--accent` | `#7c5af7` | 選択中・実行ボタン・リンク |
| `--accent-hover` | `#6d4de6` | アクセントの hover |
| `--accent-soft` | `rgba(124,90,247,0.12)` | 選択中の背景、hover の背景 |
| `--accent-border` | `rgba(124,90,247,0.35)` | 選択中の枠 |
| `--accent-border-bright` | `rgba(140,110,255,0.75)` | 状態を強く示す枠(モデル読み込み済みのバー等) |
| `--danger` | `#ef4444` | 危険の強調(状態の点・処理の中止・しきい値 90% など)。**エラー文の文字には使わない** |
| `--danger-text` | `#f2a3a3` | **エラー文の文字色**(失敗メッセージ・検証 NG)。`--danger` の赤を読みやすく明るくした色(2026-10-19 ユーザー決定で統一) |

### 意味のある色(現状は直値。変数化はこれから)

| 値 | 意味 | 例 |
|---|---|---|
| `#3ecf8e` | 正常・稼働中 | サーバー稼働の点(`--ok`) |
| `--rel-positive` `#4db3f7` | 人物どうしの関係の好意(水色) | 関係図の矢印、キャラタブの関係のバー |
| `--rel-negative` `#f570a0` | 人物どうしの関係の反感(ピンク) | 同上 |
| `--danger-text` `#f2a3a3` | **エラーの文字色**(赤字を読みやすくした色) | 検証 NG、失敗メッセージ(直値で書かず変数を使う) |
| `rgba(239,68,68,0.12)` | エラーの下地 | 警告バッジ、NG のカード |
| `#f59e0b` | 警告(しきい値 70%) | チャットのトークン使用率リング |
| `#ef4444` | 危険(しきい値 90%) | 同上・削除ボタン |

> 関係の向きは、緑と赤を借りない(2026-10-14。それまで好意は `#3ecf8e`、反感は `#ef4444` で、関係図の矢印が
> 稼働中やエラーの表示と同じ強さになり、どぎつく見えた)。ほぼ中立(絶対値 0.15 未満)は `--text-faint`。
> 色だけでなく、矢印のラベルと数値でも向きが分かるようにしてある。
>
> 直値のまま散っているので、増やすときは `--ok` / `--warn` / `--danger-text` として
> `index.css` に足すほうがよい(既存を一括で置き換える必要はない)。

### エンティティの色(作者が選ぶ色)

キャラクター・場所・派閥は**自分の色**を持つ。既定値と描き方は決まっている。

- 新規キャラの既定 `#7c5af7`、新規の場所の既定 `#5a8fa7`、**色未設定のフォールバックは `#8a8fa8`**
- 塗りに使うときは **16 進に `33` を足して 20% の下地**にする(`` `${color}33` ``)
- 枠は `1.5px solid <color>`、文字色はその色のまま。**背景を不透明に塗らない**
  (キャラ色が自由なので、コントラストが壊れる)
- 点(凡例)は `inline-block h-2 w-2 rounded-full` に背景色
- 編集欄の色のスウォッチ(`color-swatch h-11 w-12`)の上には、「色」の見出しと並べて**既定の色に戻すボタン**を置く
  (`Icon name="rotateCcw"` 12px、`rounded-md p-0.5`、`--text-faint`、hover で `--accent-soft`、既定の色のときは `disabled:opacity-50`)。
  押すと下書きを新規の既定色にするだけで、保存は他の項目と同じく確定ボタンで行う。
  ボタンを `label` の中に置くと押したときに色の選択も開くので、見出しとスウォッチは `div` で包む(2026-10-19 追加)

## 2. タイポグラフィ

フォントは `:root` の 1 スタックのみ:
`"Inter", "Segoe UI", "Noto Sans JP", system-ui, sans-serif`。等幅は `Consolas, monospace`
(コードとトークン数)。

| サイズ | 用途 | 実測 |
|---|---|---|
| `text-[10px]` | 単位、スライダーの目盛、小さなバッジの中 | 43 |
| `text-[11px]` | 補助テキスト、ヒント、小さいボタン、バッジ、**eyebrow(小見出し)** | 105 |
| `text-[12px]` | **既定の本文**。一覧・入力・ほとんどのボタン | 126 |
| `text-[13px]` | 見出しラベル(`settings-field-label`)、少し目立たせる本文 | 58 |
| `text-[14px]` | セクション見出し、モーダルのタイトル | 5 |
| `text-[15px]` 以上 | 鑑賞モードの本文・数値の強調のみ | 少数 |

- **太さは `font-medium`(500)か `font-semibold`(600)だけ。** `font-bold` は使わない
  (`settings-group-title` の 700 が唯一の例外)
- **eyebrow(小見出し)は `text-[11px] uppercase tracking-[0.14em]` + `--text-faint`。**
  欄や区切りの見出し(`Library`、`Model`、「章のまとめ」)に使う。大きさと字間はどこでもこの値に揃える
  (2026-10-19 ユーザー決定で 10px から 11px へ。詳細欄では 11px が多数派だった。字間 0.2em・0.25em も使わない)。
  鑑賞モードの本文の中の章の扉(「第 1 章」+ 大きな章題)は読み物の組版なので、この規則の外に置く
- 長文には `leading-relaxed`。表・一覧には付けない
- 数値が並ぶ列は `tabular-nums`(桁が揺れない)
- 溢れる可能性のあるテキストは `truncate` + `title` に全文。横に並ぶ要素は `shrink-0`

## 3. 余白・サイズ・角丸

Tailwind の既定スケール(`1 = 4px`)をそのまま使う。**使う段は絞る。**

| 種類 | よく使う値 | 目安 |
|---|---|---|
| 横 padding | `px-2`(8) / `px-3`(12) / `px-1.5`(6) / `px-2.5`(10) | 小ボタン 2、行カード 3 |
| 縦 padding | `py-0.5`(2) / `py-1`(4) / `py-1.5`(6) | 小ボタン 0.5、行カード 1.5 |
| 要素間 | `gap-2`(8) / `gap-1.5`(6) / `gap-1`(4) | 既定は 2、詰めたいときに 1.5 |
| セクション間 | `gap-3` 以上 / `settings-card` の `gap: 14px` | 画面の大きな区切りのみ |

角丸は **大きさで役割を分ける**。

| 角丸 | 半径 | 使う対象 |
|---|---|---|
| `rounded-md` | 6px | 小さいボタン、入力欄、バッジ |
| `rounded-lg` | 8px | 一覧の行、ペイン内のカード、パネル |
| `rounded-xl` | 12px | ポップオーバー、画像の枠 |
| `rounded-2xl` | 16px | モーダル |
| `rounded-3xl` | 24px | 構造モードのノードカード |
| `rounded-full` | ∞ | 点、丸アイコン、チップ |

影は**浮いているものだけ**: `shadow-lg shadow-black/30`(ポップオーバー)、
`shadow-xl shadow-black/50`(モーダル)。カードには付けない。

## 4. 部品の型(そのまま写して使う)

### 二次ボタン(いちばん多い形)

```tsx
<button
  onClick={...}
  disabled={busy}
  className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
  data-tip="何が起きるか"
>
  書き出す
</button>
```

### 確定 / 取り消し(その場の編集・追加・入力)

**どこでも「取り消し(二次ボタン)… 確定(`accent-action`)」の順で、確定を右端に置く**(2026-10-19 に統一。
それまでは保存が左・取り消しが枠の無い文字・文言が「取消 / キャンセル / 元に戻す」など場所ごとに違った)。

- 部品は `FieldEdit.tsx` の `EditActions`(未保存の印・取り消し・確定、Ctrl+Enter / Esc は `editKeys`)。
  確定の文言は `commitLabel` で「追加」「保存」などに変えてよい。入る口の鉛筆は `EditPencil`(編集中は隠す)
- `EditActions` を使えない並び(チャットの発言の編集、パネルの保存)も同じ順・同じ型
  (取り消し = 二次ボタン、確定 = `accent-action rounded-md border px-2.5 py-1 text-[12px] font-medium`)
- 画面全体の保存(シーンタブの下端の「保存」)とモーダルの確定は主ボタン。その左の取り消しは二次ボタン
- 取り消しの文言は「取り消し」(§7)

### 削除ボタン

削除操作は共通クラス `delete-action` を使う。通常は文字 `--text-dim`、枠 `--border-strong`。
有効なボタンの hover / focus-visible だけ文字 `--delete-hover` (`#cf9393`)、
枠 `--delete-border` (`rgba(207, 147, 147, 0.4)`) にする。無効時は色を変えない。
サイズ・余白は既存のボタンの型を使い、インラインで文字色・枠色を指定しない。
状態の点・処理中止の `--danger` は別用途として維持する(エラー文の文字は `--danger-text`)。
現在の削除確認は `window.confirm` のOS標準表示で、色はOSに従う。

### 主ボタン(実行・確定。1 画面に 1 つが目安)

```tsx
<button
  className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
  style={{ background: 'var(--accent)' }}
>
  追加
</button>
```

- **大きさはこの 1 つだけ**(2026-10-19 に統一。それまでは `rounded-lg px-4 py-1.5 text-[13px]`・`rounded-lg px-2.5 py-1` など 8 通りあった)。
  設定画面の起動・インストール、モーダルの確定、清書・まとめを作るもこの型。隣に置く停止などは二次ボタンの型(11px)のままでよい
- **行の中で B 型の入力欄と横に並ぶとき**(キャラタブの記録、退場させる など)だけ、欄と高さを揃えて
  `rounded-md px-2 py-0.5 text-[12px] font-medium text-white` にする
- 構造モードのツールバー(「+ シーン」など浮いたボタンの列)は別の型(ツールバーの節)で、ここには含めない

### LLM を走らせるボタン(校正 / 自動生成 / 抽出 / 分岐生成)

色は `index.css` の `.accent-action` に持たせる。**大きさは持たせない**ので、
角丸・余白・文字サイズは置く場所に合わせて Tailwind 側で決める。

```tsx
<button
  className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
  data-tip="シーン本文からタイトルを自動生成"
>
  <Icon name="sparkle" size={11} /> 自動生成
</button>
```

- 下地 `--accent-soft` + 枠 `--accent-border` + 文字 `--accent`、**hover で `--accent` に塗りつぶす**
  (枠と文字だけだと本文に埋もれて気付かれない)
- 大きさの目安: ラベルの横 `text-[11px] px-2 py-0.5`(自動生成・推測・「全文を校正」。校正は 2026-10-13 に `text-[12px] px-2.5 py-1` から変更。アイコンは 11px) / 単独で置くもの `text-[12px] px-2.5 py-1` /
  パネル内の横幅いっぱい `text-[13px] px-3 py-1.5`
- **塗りつぶし固定(主ボタン)にはしない。** 同じ画面に何個も並ぶので、「保存」「まとめを作る」
  のような 1 つだけの主ボタンと強さが並んでしまう
- hover を CSS 側に置くのは、**インラインの `style` が `:hover` より強い**ため。
  `style={{ color: ... }}` と書くと hover の色が効かない

- **置き場所は、対象の欄の見出しの行の右端**(`mb-1 flex items-center justify-between gap-2`)。自動生成・推測・校正を同じ位置に揃える。
  校正(`ProofreadTextarea`)は 2026-10-13 に欄の下から見出しの行へ移した(長い本文でも欄の先頭にあり、探さずに済む)。
  見出しは部品の `label` に渡し、校正の左隣に「↩ 元に戻す」を出す。校正結果のポップアップと「直すところは見つかりませんでした」の文は欄の側に残す。
  資料庫の読む表示では、編集中だけ見出しを部品の中へ移す(鉛筆は編集中は出さないので、見出しの行は「項目名 … 校正」になる)。欄の下の段は「取り消し」「確定」だけになる

### トグル(チェックの意味を持つボタン)

`☑ / ☐` を文字で持つ。オンは `--accent-soft` の下地 + `--text`、オフは `--text-faint`。

```tsx
<button
  onClick={() => setOn((v) => !v)}
  className="rounded-md border px-2 py-0.5 text-[11px]"
  style={
    on
      ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
      : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
  }
>
  {on ? '☑' : '☐'} ライブラリの中
</button>
```

### セグメント(オン/オフ、モード切替)

外枠 1 本の中にボタンを並べ、選択中だけ `--accent-soft` を敷く。

```tsx
<div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
  {options.map(([value, label]) => (
    <button
      key={label}
      className="px-2.5 py-0.5 text-[12px]"
      style={current === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
    >
      {label}
    </button>
  ))}
</div>
```

### 入力欄

**型は 2 つ。どちらを使うかは置き方で決める**(2026-10-19 ユーザー決定。それまでは 3 系統以上が混在していた)。
選択欄(`select`)も同じ基準で A / B に分ける。

- **A. 書く欄** — 見出しの下に幅いっぱいで置く欄(シーン本文・資料庫の項目・プロンプト・設定画面の欄・複数行のもの)。
  長い文章を読み書きするので 13px

```tsx
<textarea
  className="w-full rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none"
  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
/>
```

- **B. 短い値の欄** — 行の中でボタンやラベルと横に並ぶ欄(数値・名前・key・検索・小さな選択欄)。
  隣の 11px の二次ボタンと高さを揃えるので 12px

```tsx
<input
  className="rounded-md border px-2 py-0.5 text-[12px] outline-none"
  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
/>
```

中間の形(`px-2 py-1`、`rounded-lg px-2 py-1`、設定画面の `px-3 py-2` など)は使わない。

`textarea` は `resize: vertical` が既定(`index.css`)。
**プレースホルダは `--text-faint`・不透明**(`index.css` の `textarea::placeholder, input::placeholder`。2026-10-16 に相談チャットだけから全体へ。既定の色だと入力済みの文章に見える)。
制作チャットの依頼・途中指示欄は `AutoTextarea` を使い、最小2行から内容・幅に合わせて自動伸縮する。
入力欄の直前に「選択中: …」を `shrink-0 text-[11px]` / `--text-dim` で表示する。
送信時に選択を固定すること・保護条件・保存済み本文の参照は `data-tip` で説明する。
発言履歴の「送信時の選択」は変更範囲の説明と同じ `mb-1 text-[11px]` / `--text-dim` に揃える。
高さの上限や入力欄内のスクロールは設けず、長文時は制作チャットの外側をスクロールする。
**フォーカス表示は `index.css` が全体に効かせている**ので、`outline-none` を付けたままでよい
(§5 参照)。個別に `focus:` を書く必要はない。

### 一覧の行

```tsx
<div
  className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
>
  <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--bg-input)', color: 'var(--text-faint)' }}>自動</span>
  <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>{name}</span>
  <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>{meta}</span>
</div>
```

**中身は `min-w-0 flex-1 truncate`、両脇は `shrink-0`** —— これを守らないと長い名前で
行が横に伸びる。

### 折りたたみ(`details`)

制作チャットの「本文を表示(N 字)」「資料庫の変更内容」「章の変更内容」の型(2026-10-15)。一覧の行と同じ枠で囲み、押せる場所を周りの文章と区別する。

```tsx
<details className="mb-1.5 mt-1.5 rounded-lg border px-3 py-1.5 text-[11px]"
         style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}>
  <summary className="cursor-pointer">本文を表示(320 字)</summary>
  <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed" style={{ color: 'var(--text)' }}>…</p>
</details>
```

- `summary` が見出し(`--text-dim`)、開いた中身は本文の色(`--text`)。既定は閉じる
- 上の見出し行(「編集: ○○」)との間は `mt-1.5`(6px)空ける(2026-10-15 指摘。枠が見出しに密着して窮屈だった)
- 設定画面の `settings-card` のような大きな区切りには使わない(あれは常に開いている)

### 行に並べる開閉ボタン(`ProductionPanelToggle`)

制作チャットの条件パネル(指示 / 作業メモ / 変更範囲)の型(2026-10-15)。閉じていても高さを取る `details` を
縦に積む代わりに、上の操作の行(`flex flex-wrap items-center gap-2`)へ小さなボタンとして並べる。

- ボタンは二次ボタンの大きさ(`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]`)。
  文字は `--text-dim`、末尾に `▾`(開くと `▴`。`text-[9px]`・`--text-faint`)。ラベルに状態を含める(「作業メモ · オフ」)
- 開いている間はトグルのオンと同じ `--accent-soft` と `--text`、`aria-expanded` を付ける
- 既定でない条件(範囲を絞った・保護がある・未保存)は、閉じていても枠を `--accent-border`・文字を `--text` にして目に入るようにする
- 中身は同じ行の中に `order-1 basis-full` で置き、ボタンの並びの下に全幅で開く。枠は以前の折りたたみと同じ
  `rounded-lg border px-3 py-2 text-[12px]`、背景 `--bg-elevated`。同時に開くのは 1 つだけ(開閉は親が持つ)
- 幅が足りなければボタンは折り返す(2 行に収まる程度の数に留める)

### ポップオーバー / モーダル

```tsx
// ポップオーバー(ボタンの真下)
<div className="absolute left-0 top-8 z-50 w-72 rounded-xl border p-1.5 shadow-lg shadow-black/40"
     style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}>

// モーダル(オーバーレイをクリックで閉じ、中身は stopPropagation)
<div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onCancel}>
  <div className="w-[520px] max-w-[92vw] rounded-2xl border p-4 shadow-xl shadow-black/50"
       style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
       onClick={(e) => e.stopPropagation()}>
    <h3 className="mb-3 text-[14px] font-semibold">タイトル</h3>
    …
    <div className="mt-3 flex justify-end gap-2">[取り消し(二次)] [確定(主ボタン)]</div>  // 見るだけのものは [閉じる(二次)]
```

幅は `w-[520px] max-w-[92vw]` のように**固定幅 + ビューポート上限**。`z-50` を使う。

モーダルはすべてこの型(2026-10-19 に統一。それまでは地の濃さ 0.45 / 0.55 / 0.6、面の色、影、タイトルの 13px / 14px、閉じる操作の形がモーダルごとに違った)。

- 地は `rgba(0,0,0,0.6)`、面は `--bg-card` + `--border-strong` + `rounded-2xl` + `p-4` + `shadow-xl shadow-black/50`(拡大表示の `Lightbox` だけは別。§4 拡大表示)
- タイトルは `h3`・`text-[14px] font-semibold`。説明を添えるときは `mb-1` にして、下に `text-[11px]`・`--text-faint` の文
- **閉じる操作は下端の右**。確定のあるものは「取り消し(二次)… 確定(主ボタン)」、見るだけのものは二次ボタンの「閉じる」。
  生成ウインドウ(画像の生成)は「[閉じる / 取り消し] …… [決定]」の並び(§4 画像のドロップ枠)
- 例外: 高さいっぱいの大きなモーダル(設定)はヘッダーの行を持ち、その右端に ✕ の記号ボタン
  (`flex h-6 w-6 items-center justify-center rounded-md text-[13px]`、hover で `--accent-soft`、`aria-label` と `data-tip` は「閉じる」)

スクロール領域(`overflow-y-auto`)の中から出すメニューは、`absolute` だと領域の端で切り取られる。
`createPortal` で `document.body` へ出し、`fixed` でボタンの位置(`getBoundingClientRect()`)に置く。
下に入りきらないときは上へ出し、領域がスクロールしたら閉じる(例: `ChatHistoryPanel.tsx` の行の ⋯ メニュー)。

### アイコン付きの選択メニュー(`ChatTargetPicker.tsx` の `IconPicker`)

人物をアイコンと名前で選ばせたいときは、標準の `select` を使わない(`option` に画像を置けない)。
相談チャットの「話す相手」と、会話室の「次に話す人」がこの型(2026-10-14)。共通部品 `IconPicker` に項目の一覧(`items`)を渡して使う。
会話室の参加者を選ぶ札(話す相手のすぐ下の横並び)も、このボタンと同じ大きさにする(`CharAvatar` 20px、`gap-1.5 rounded-md border py-0.5 pl-1 pr-2 text-[11px]`、札の間は6px。2026-10-14 にアイコンを 14px から拡大)。
入力欄の行に置くときは `tall` を付けて余白を `py-1` にする。会話室の入力行は `room-composer` で入力欄の最小高さと操作部品の高さを36px、角丸を8pxに揃える。幅は話者96px・発言数72px・進める/中止80pxで固定し、入力欄が残りの幅を使う。長い人物名は省略し、複数行の入力は上へ伸ばして操作部品の下端を揃える(2026-10-14)。ボタンの文言はメニューの行と変えられる(行は名前だけ、ボタンは「○○と話す」「○○から」)。

- ボタン: `inline-flex items-center gap-1.5 rounded-md border py-0.5 pl-1 pr-1.5 text-[11px]`、背景 `--bg-input`。
  左に今の選択の印(20px)、名前、右端に `▾`(`text-[9px]`・`--text-faint`)。開いている間は `--accent-soft` と `--text`。
  `aria-haspopup="listbox"`・`aria-expanded`・`aria-label` を付ける。枠の色はキャラを選んでいるときそのキャラの色
- メニュー: ポップオーバーの型(`--bg-card`・`rounded-xl`・`--border-strong`・`shadow-lg shadow-black/40`・`z-50`・`p-1.5`)で幅 `w-60`、
  高さは `min(320px, 60vh)` まで、中でスクロール。`createPortal` で body へ出し、`fixed` でボタンの下 4px に置く。
  実寸を測ってから、下に入らなければ上へ、右にはみ出すなら左へ寄せる(位置が決まるまでの1フレームは `visibility: hidden`)
- 行: 資料庫の一覧と同じ型(`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]`、選択は `--accent-soft` と `--text`、
  それ以外は `--text-dim`、hover で `--accent-soft`)。左の印は 24px の枠に揃える: キャラは `CharAvatar`、人物でない項目は線画のアイコン
  (17px)を同じ枠の中央に置く。人物でない項目とキャラの間に `--border` の区切り線。`role="listbox"` / `role="option"` / `aria-selected`
- 閉じ方: 選ぶ、外側のクリック、Esc(ボタンへフォーカスを戻す)、外側のスクロール、ウインドウのリサイズ

### 右クリックメニュー(`ContextMenu.tsx`)

```tsx
<ContextMenu x={menu.x} y={menu.y} heading="3 シーンを選択中" onPick={() => setMenu(null)}
  items={[
    { label: 'コピー', hint: '選択したシーンと内部の接続をコピー', shortcut: 'Ctrl+C', group: 'edit', run },
    { label: 'まとめて削除', hint: '後続シーンは前のシーンに繋がる', group: 'danger', run }
  ]} />
```

- 外枠はポップオーバーと同じ(`--bg-card` + `rounded-xl` + `--border-strong`、`z-50`)。幅 `w-60`、
  行は `text-[12px]` の **1 行だけ**。先頭に `text-[10px]` / `--text-faint` の見出し(何を選んでいるか)
- **説明(`hint`)は行の下に書かず、ホバーのツールチップに出す**(`data-tip`)。項目が 15 を超える
  メニューが 2 行構成で画面の半分を占めていたため(2026-10-10)。無効な項目では押せない理由を書く
- ツールチップは行の**右**に出す(外枠の `data-tip-side="right"`。下に出すと次の行に被る)
- ショートカットがある項目は `shortcut` に書き、右端に `text-[10px]` / `--text-faint` / `tabular-nums` で出す
- `group` が前の項目と変わるところに `border-t` / `--border` の区切り線。構造モードでは
  `edit`(コピー・貼り付け)→ `add`(追加・生成)→ `chapter`(章の操作)→ `llm`(作り直し・清書)→ `danger`(切り離す・削除)
- 位置は右クリック座標。**実寸を測ってから画面の右端・下端の内側(余白 8px)へ寄せる**。
  縦に入り切らないときは `overflow-y-auto`

### 画像のドロップ枠(プロフィール画像 / 参照画像 / 挿絵)

画像を置ける場所は **`button` 1 つで「クリックで選ぶ」「ドロップで置く」「hover で操作名を重ねる」** を
まとめる(`CharactersMode.tsx` のプロフィール画像、`RefImagePanel.tsx` の参照画像)。

```tsx
<button
  onClick={() => fileInputRef.current?.click()}
  onDragEnter / onDragOver / onDragLeave / onDrop   // 深さカウンタで dragleave の誤発火を抑える
  className="group relative h-48 w-32 shrink-0 overflow-hidden rounded-lg border"
  style={{
    borderColor: 'var(--border-strong)',
    background: 'var(--bg-canvas)',
    ...(dragOver ? { outline: '2px dashed var(--accent)', outlineOffset: 2 } : {})
  }}
  data-tip="クリックで別の画像に差し替え / 画像をドロップ"
>
  {url ? <img src={url} className="h-full w-full object-cover" /> : <span …>未設定</span>}
  <span className="absolute inset-0 hidden items-center justify-center bg-black/50 text-[11px] text-white group-hover:flex">
    差し替え
  </span>
</button>
<input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" … />
```

- 下地は `--bg-canvas`(画像の下地)、枠は `--border-strong`(押せるもの)。ドラッグ中は
  `--accent` の破線 outline を**外側**(`outlineOffset: 2`)に描く
- 形は用途で変える: プロフィールは丸(`h-36 w-36 rounded-full`、枠色はキャラの色。2026-10-13 に 112px から 144px へ拡大)、
  全身の参照画像は縦長(`h-48 w-32 rounded-lg`)
- 画像の**操作(外す / 生成)は枠の横か下に文字ボタンで並べる**。
  **画像があるときの枠クリックは拡大表示**(`Lightbox`)に使い、差し替えは枠の右下隅の小さなアイコンボタン
  (`h-6 w-6 rounded-md border`、地は `rgba(28,31,43,0.85)`、`Icon name="image"`)とドロップで受ける。
  それ以外の押せるものは枠の中に重ねない
- **並びは作業の順に左から、最後に押すものを右端に**(2026-10-16 ユーザー判断「左から項目をチェックしていくので」)。
  画像の下の操作は「ストック / 差し替え・外す …… [✦ 生成]」で、生成ボタン(`accent-action`)に `ml-auto` を付けて右端に置く
  (場所のページ・人物の参照画像・シーンの挿絵)。生成ウインドウ(`RefImagePanel` / `SceneImageModal` / `PlaceImageModal`)の
  操作の行は「書き直す → ワークフローの組 → seed → 生成」、いちばん下の行は「[閉じる] …… seed N [決定]」で、決定を右端に置く

### 候補の格子(`MediaPicker.tsx`)

生成した候補や手持ちの画像から 1 枚を選ぶ一覧。モーダル(`w-[720px]`)の中に `grid gap-3`
(横長は `grid-cols-3`、縦長は `grid-cols-4`)でカードを並べる。

```tsx
<button
  className="relative w-full overflow-hidden rounded-xl border"
  style={{
    aspectRatio: '1216 / 832',
    background: 'var(--bg-canvas)',
    borderColor: selected ? 'var(--accent)' : 'var(--border-strong)',
    boxShadow: selected ? '0 0 0 1px var(--accent)' : undefined
  }}
>
  <img className="h-full w-full object-cover" />
  {selected && (
    <span className="absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ background: 'var(--accent)', color: '#fff' }}>選択中</span>
  )}
</button>
<div className="flex items-center justify-between gap-1 px-0.5">   {/* カードの下: 補足 + 小ボタン */}
  <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>seed 123</span>
  <button className="rounded-md border px-1.5 py-0.5 text-[11px] disabled:opacity-40" …>削除</button>
</div>
```

- 選択中は**枠色 + 1px の外側リング + 左上のバッジ**で示す(色だけにしない)
- カードの中に押せるものを重ねない。削除などの操作はカードの**下**に `text-[11px]` の小ボタンで置く
- 種別(動画など)はカード右下の `text-[10px]` バッジ(地は `rgba(28,31,43,0.85)`)

### 拡大表示(`Lightbox.tsx`)

サムネイルをクリックしたときの等倍〜画面いっぱいの表示。モーダルより暗い地(`rgba(0,0,0,0.85)`)、
`z-50`、余白 `p-6`、中身は `max-h-full max-w-full object-contain`。**オーバーレイのクリックか Esc で閉じる**
(閉じるボタンは置かない)。開く側のサムネイルには `cursor-zoom-in`、オーバーレイには `cursor-zoom-out`。

### ツールチップ(`Tooltip.tsx`)

**素の `title` は使わない。`data-tip` を書く。**

```tsx
<button data-tip="何が起きるか">…</button>

// 複数行。行頭 `・` は箇条書きとして字下げして折り返す
<button
  data-tip={['清書に使うもの:', '・スタイルプリセット — 文体と人称', '・このシーンの本文'].join('\n')}
/>
```

- 実体は `App` に 1 つだけ置いた `<TooltipHost />`(`src/renderer/src/Tooltip.tsx`)。
  document の `pointermove` を 1 本だけ購読して座標から `[data-tip]` を引き、
  出ている間だけ portal に 1 個描く。**ボタン側は属性 1 つで、state もエフェクトも増えない**
- 見た目はポップオーバーと同じ(`--bg-card` + `rounded-xl` + `shadow-lg`、`text-[11px]`)。
  ただし**モーダル・ポップオーバー(`z-50`)より上に出す必要があるので `z-[100]`**
- 幅は `width: max-content` + 上限(340px と画面幅の小さいほう)で決める。幅を指定しないと、`position: fixed` の箱は「left から画面の右端まで」に収まるよう縮むので、右端近くの部品のツールチップが細く縦長になる(2026-10-13 修正)。
- 出るまでの間は 400ms(既に出ているとき隣へ移ったら 80ms)
- 座標から引いているのは、**`disabled` の要素がイベントを出さない**ため。素の `title` は
  押せないボタンで出ないが、押せない理由こそ読みたいので、そこを拾えるようにしてある
- **`data-tip` はアクセシブルな名前にはならない。** アイコンだけのボタンには
  `aria-label` も併記する(文言は同じでよい)
- 既定は要素の**下**(入らなければ上)。祖先に `data-tip-side="right"` があれば**右**(入らなければ左)に出す。
  縦に並ぶ行(右クリックメニュー)で次の行に被らないようにするための指定
- 部品に文字列を渡して中で `data-tip` にする場合、プロパティ名は **`title` ではなく `tip`**
  にする(`LengthSelect` / `MsgActionButton`)。`title` のままだと素の `title` と紛れる

### 設定画面の枠(`index.css` のクラス)

`settings-card` / `settings-group-title` / `settings-field` / `settings-field-header` /
`settings-field-label` / `settings-field-hint` / `settings-slider` / `settings-value-badge`。
設定画面に何か足すときは **Tailwind で似た見た目を作り直さず、このクラスに乗る**。

- 左の一覧は、関連する項目を見出しの下にまとめられる(現状は「システムプロンプト」の 5 項目)。見出しは押せないラベルで
  `mt-2 px-2.5 pb-1 text-[11px] font-medium`・`--text-dim`、配下の項目は `pl-5` で字下げし、まとまりの次の項目に `mt-2` を置く。
  1 項目 1 ページは保つ(プロンプトは長文なので、1 ページに並べると下の項目が探しにくい)。
- 左の一覧は、保存先で2つに分ける: 「環境設定(この PC)」と「この作品(ライブラリ)」(2026-10-13)。
  区切りの見出しは `px-2.5 pb-1 text-[11px] tracking-[0.14em]`(eyebrow と同じ大きさ。2026-10-19 に 10px から)・`--text-faint`。2つ目からは `mt-3 border-t pt-3`(`--border`)で線を引く。
  各ページの見出しのすぐ下に `settings-field-hint` で「保存先: …」を1行出す(保存先が混ざるページは、どれがどちらかを書く)。
- いまの状態を見せるだけの行(押せない)は、`settings-field-header` の右側に、状態の点(`h-2 w-2 rounded-full`)と文を `role="status"`・`text-[12px]`・`--text-dim` で置く(Embedding のページの「いまの状態」。2026-10-14)。点の色は 読み込み済み = `--ok`、失敗 = `--danger`、それ以外 = `--text-faint`。色だけにせず、必ず文で状態を書く。
- 1 ページに複数の画面・機能の設定をまとめるときは、カード(`settings-card`)ごとに見出しを置く(設定の「画面」の「構造モード」「鑑賞モード」。2026-10-18)。
  見出しは `h3`・`mt-1 text-[12px] font-medium`・`--text-dim`(ページの見出し `settings-group-title` より一段弱く、資料庫の項目の見出しと同じ強さ)
- 効く範囲が項目ごとに違う設定は、見出しの直下に `settings-field-hint` で「適用先: …」を 1 行書く(`Section` の `scope`)。
- 選んだものの中身(画像生成の「既定のワークフロー」が使うモデル)は、選択欄の下に `ul` で 1 行ずつ並べる(2026-10-16)。
  行は `flex items-baseline gap-2 text-[12px]`、左に分類(`w-28 shrink-0`、`--text-faint`)、右に名前(`min-w-0 truncate`、`--text-dim`)。
  足りないものは名前を `--danger-text` にし、右に「見つかりません」と文でも書く(色だけにしない)。確かめられないときは `settings-field-hint` でそう書く。
- 設定で変えられずに必ず付く指示は、読み取り専用の枠(`rounded-lg border px-3 py-2 text-[12px]`、背景 `--bg-elevated`、
  文字 `--text-faint`)で見せる(`FixedPrompt`。組み込みの校正プリセットと同じ見た目)。ラベルに「(編集不可)」を付け、
  長いものは `details` の「全文を表示」に畳む。編集欄と食い違ったときにどちらが残るかをヒントに書く。

### 状態の点・ヒント・エラー

```tsx
<span className="inline-block h-2 w-2 rounded-full" style={{ background: healthy ? '#3ecf8e' : 'var(--danger)' }} />
<p className="settings-field-hint">説明。なぜそうなるかまで書く</p>
<p className="text-[12px]" style={{ color: 'var(--danger-text)' }}>失敗した理由(パスや原因を含める)</p>
```

## 5. 状態の見せ方

- **無効**: `disabled:opacity-50`(通常)/ `disabled:opacity-40`(押せない理由が別にある)。
  **無効にしたら `data-tip` に理由を書く**(素の `title` と違い、押せないボタンでも読める)
- **選択中**: `--accent-soft` の下地 + `--text`。枠を足すなら `--accent-border`
- **フォーカス**: `index.css` の 1 か所で `a / button / input / textarea / select /
  [role=button] / [role=tab]` にまとめて付けてある。`--accent-border-bright` の 2px を
  **内側**(`outline-offset: -2px`)に描くので、`overflow-hidden` の親(セグメントの外枠など)に
  切られず角丸にも沿う。`:focus-visible` なので**マウスでボタンを押しただけでは出ない**
  (テキスト入力はクリックでも出る。編集中の欄が分かるほうがよいため)。
  各所の `outline-none` は要素セレクタの詳細度で上書きしているので、そのままでよい。
  スライダーだけはつまみの色で示すため枠を出さない
- **hover**: 控えめにしか付けない。付けるなら `hover:bg-[var(--accent-soft)]` か
  `rgba(255,255,255,0.06)`。**hover でしか分からない情報を作らない**
- **処理中**: LLM が動いているカードは `node-busy-ring`(枠が時計回りに光る)。
  変数 `--sg-ring-inset` / `--sg-ring-corner` / `--sg-ring-width` / `--sg-ring-glow` で
  ノード以外にも付けられる。点滅だけでよければ `node-generating-border`
- **作り直しが要る(stale / draft)**: 色ではなく**バッジの文字**で示す(`手動` / `自動` のように
  `text-[10px]` の小さなバッジ)。色だけの区別はキャラ色と混ざるため避ける
- **正史でない(draft のシーン・別ルートの章・アクティブでない結末)**: **淡くしない**
  (`opacity` を下げない)。破線の枠と破線のエッジ、それに文字(`draft` バッジ /
  「別ルートの章」/「アクティブ」)で示す。分岐も書きかけの本編であって、押せない項目や
  無効な状態ではない —— 淡くすると本文とサムネイルが読みにくくなるだけになる
  (2026-08-11 ユーザー判断)。`opacity` を下げてよいのは**無効な操作**と、
  引き継ぎの場所表示のような**同じ行の中での主従**だけ
- **読み上げ中の箇所**(鑑賞モードの本文): `<mark>` に `--accent-soft` の下地 + 下辺に
  `--accent-border-bright` の 1px(`box-shadow: 0 1px 0 …`)、`rounded-[3px]`、文字色はそのまま(`inherit`)。
  「いま選んでいる」と同じ系統の色で、本文の読みやすさを落とさない強さに留める
- **進捗**: 長い処理はステータスバーのタスクキューに出る(`tasks.ts`)。
  画面内に独自のスピナーを増やさない
- **ズームアウト時のノードタイトル**(構造モード): キャンバスの zoom が 0.5 以下になったら、
  各カードの上に画面上で一定サイズのタイトルを出す(`StructureNodes.tsx` の `ZoomedOutTitle`)。
  `absolute bottom-full left-1/2 mb-2` に置き、`transform: translateX(-50%) scale(1/zoom)` で
  縮小を打ち消す。`text-[13px] font-semibold rounded-lg px-3 py-1`、文字 `--text`、
  地は `--bg-card` の 85%(線と重なっても読める)。`pointer-events-none` でカードの操作を邪魔しない。
  カード本体のタイトルはそのまま残す(しきい値の前後で見た目が急に変わらないように)
  設定 → 画面の「構造モード」にある「ズームアウト時のタイトル」(`zoomed_out_titles`。既定は表示)で非表示にできる(2026-10-18 ユーザー要望)。
  カードは memo しているので、設定は data ではなく context(`ZoomedOutTitlesEnabled`)で全カードに渡す

## 6. アイコンとアニメーション

### アイコンのルール(2026-10-15 に具体化)

1. **アイコンは `icons.tsx` の `Icon` だけを使う。** lucide 準拠の線画(フラット・単色・`stroke="currentColor"`・`strokeWidth=2`)で、
   文字と同じ色になる。塗りつぶし・多色・影・グラデーションのアイコンは使わない。
   足りないものは `icons.tsx` の `PATHS` に 1 項目足す(lucide の 24px 枠のパスをそのまま写す。名前は用途が分かる camelCase で、`IconName` の一覧にコメントを添える)
2. **絵文字は使わない。** カラー絵文字は OS のフォントで描かれ、色・太さ・形が線画と揃わず、ダークの地で浮く
   (2026-10-15、ツールバーの「人物」の 👥 を `Icon name="users"` に置き換えたときの指摘)。
   古いコードに残っている 🏁(結末)・📖(章ビュー)・🖼・📷・🎲・✨ は置き換え待ちで、**新しく増やさない**。
3. **文字として読める記号は、文字の一部としてなら使ってよい。** フォントの記号で単色・同じ色になるもの:
   `☑ ☐`(トグル)、`▾ ▴ ▸`(開閉)、`✕`(閉じる)、`✎`(編集)、`⋯`(その他)、`▶ ■`(実行・停止)、`⟲`(戻す)、
   `⊞ ⊕`(表示切替・追加)、`→ ←`(文中の向き)、`⚠`(警告)、`★`(正史)。
   これらは「ラベルの先頭の 1 文字」か「記号だけの小さなボタン」に限る。同じ意味の `Icon` があるならそちらを優先する
4. **大きさは置く場所で決める**(実測):
   | サイズ | 置く場所 |
   |---|---|
   | 11px | ラベルの横の小さなボタン(`accent-action` の自動生成・推測・校正など、`text-[11px]` のボタン) |
   | 12〜13px | 一覧の行、`h-6 w-6` の記号だけのボタン(会話一覧・新しい会話) |
   | 14px | 既定。ツールバーのラベル付きボタン(`text-[13px]`)、詳細欄の見出し |
   | 15〜17px | 上のバー(ライブラリ / TTS / ComfyUI は 15px)、ヘッダー |
5. **ラベルと並べるときは `inline-flex items-center gap-1.5`** で縦の中心を揃え、アイコンを先に置く。
   ラベルの文字サイズより 1〜2px 大きいくらいが釣り合う(13px の文字に 14px)
6. **記号・アイコンだけのボタンには `aria-label` と `data-tip` を必ず付ける**(§0・§5)。
7. **人物はアイコンではなく `CharAvatar`。** 画像が無ければ色付きの頭文字になる。大きさは 18(ノードの行)・20(ヘッダー・札)・22〜24(一覧の行)
8. **状態の色はアイコンに持たせない。** アイコンは `currentColor` に従わせ、色は親の文字色(`--text-dim` / `--accent` など)で決める。
   稼働中・警告・エラーの色分けは §1 の意味のある色に従う

- トランジションは `transition-colors`(0.15s 相当)まで。位置やサイズは動かさない
- 例外的に動くもの: 処理中のリング(1.4s)、チャットの候補チップ(`chip-in` 0.2s)、
  ステータスバーの `animate-pulse`

## 7. 文言(日本語 UI)

- ボタンは**短い動詞**(「開く」「変更」「今すぐバックアップ」)。体言止めでもよいが敬体にしない
- `title` は**説明文**。「オンにするとライブラリの中に置きます」のように、結果を書く
- 完了は「〜しました」、進行中は「〜しています…」(三点リーダは `…` 1 文字)
- 編集・入力をやめて保存値に戻すボタンは **「取り消し」**(2026-10-19 ユーザー決定。「キャンセル」「取消」は使わない)。
  確定側は「確定」「保存」など何が起きるかの動詞。校正の「↩ 元に戻す」のように、行った処理を戻す操作は別なのでそのまま
- エラーは**原因と対象を具体的に**。パス・件数・ID を省かない
  (例: `保存先フォルダを開けませんでした: D:\...`)
- 用語は画面と揃える: シーン / イベント / 章 / 正史 / 清書 / 資料庫 / ライブラリ。
  内部名(node / group / canon / render、その日本語の「ノード」「エッジ」「パス」、stale、イベントの型名 `fact_set` など、ツールの関数名)を UI に出さない。
  画面では「シーン」「カード」「線」「正史」「要更新」「事実のイベント」のように言う(2026-10-19 に一通り置き換え。ファイルの「パス」は別)

## 8. どこに書くか(CSS ファイル vs Tailwind)

`index.css` に置くのは次の 3 つだけ。それ以外は Tailwind のクラスと `style` で書く。

1. **デザイントークン**(`:root` の変数)
2. **外部ライブラリの上書き**(React Flow、スクロールバー、`input[type=color]` など、
   自分では要素を書けないもの)
3. **繰り返し使う複合部品**(`settings-*`、`chat-md`、`node-busy-ring` のように
   擬似要素・keyframes・子孫セレクタが要るもの)。
   `accent-action` のように **`:hover` で色が変わるもの**もここに置く
   (インラインの `style` は `:hover` より強いため、`style` に書くと hover が効かない)

## 9. 既知のブレ(直すときのメモ)

- 意味色(`#3ecf8e` → `--ok` / `#f2a3a3` → `--danger-text` / `#f59e0b` → `--warn`)の変数はある。コードにはまだ直値が散っている(新しく書くときは変数を使う)
- `hover` の付け方が場所ごとに違う(付いていない押せる要素も多い)
- 構造モードのキャンバスは `disableKeyboardA11y` でノードをタブ順から外している
  (矢印キーの移動を自前で持っているため)。ノードのフォーカス枠は無い
- `text-[12.5px]` `text-[10.5px]` のような半端な値が数か所ある。新規では使わない
- 大きな画面(`StructureMode.tsx`)には、この表に無い一点物の見た目が残っている。
  触るときは近い部品を本書の型に寄せてよいが、**無関係な整形は混ぜない**


## コンテキスト使用量リング

相談・制作は `ContextUsageRing.tsx` を共用する。26px四方のSVG、半径10px、線幅2.2px。
割合は `text-[11px] tabular-nums`、円との間隔は `gap-1`。背景線は `--border-strong`。
70%未満は `--accent`、70%以上は `--context-warning`（#f59e0b）、90%以上は `--danger`。
円弧は100%で止め、数値は超過分も表示する。概算には `≈` を添える。
`data-tip` と読み上げ用のラベルにトークン数・上限・計測対象を記載する。


## ステータスバーの一時通知

コピー・貼り付けなどの短い操作結果は `statusNotice.ts` の `showStatusNotice` を使い、`StatusBar` に5秒表示する。
新しい通知で文言とタイマーを置き換える。`text-[11px]`、文字色 `--text-dim`、`min-w-0 truncate`。
全文は `data-tip`、読み上げは `role="status"`。既存のタスクキュー・選択件数と並べ、独自のポップアップは増やさない。


## 制作の本文プレビュー

制作チャットのユーザー発言（依頼・途中指示）は `ml-auto w-fit max-w-[85%]` で右寄せする。
長い単語・URL・選択名は `[overflow-wrap:anywhere]` で折り返す。本文の文字揃えは左のまま。
吹き出しは `rounded-lg border px-3 py-1.5 mb-2`、背景 `--accent-soft`、枠 `--border`。
AIの返答・変更報告は左側の全幅、背景 `--bg-elevated` を維持する。

制作チャットの発言・変更報告の見出しには記録時刻を `HH:mm:ss` で表示する。
既存の見出しの `text-[11px]` / `--text-faint` を継承し、`ml-2 tabular-nums` の `time` 要素を使う。
ホバーでは日付を含む日時を `data-tip` に表示。保存はUTC、表示は端末のローカル時刻。
時刻不明な旧履歴には表示しない。進行状況の時刻は説明の前に `mr-2 tabular-nums` で置く。
メモ照合の件数は「資料を確認しています… (2/5)」のように工程内の件数として表示し、全体の進捗率とはしない。

制作チャットの会話本文と進捗表示の間に置く。構造・資料庫で共通表示し、下段詳細欄には置かない。`shrink-0 rounded-lg border px-3 py-2`、枠は `--accent-border`、背景は `--accent-soft`。
説明は `text-[11px]` / `--text-dim`、本文は `text-[12px] leading-relaxed whitespace-pre-wrap break-words`。
本文枠は `max-h-48 overflow-y-auto inspector-scrollbar`。生成中の末尾を常に自動追従する。編集中のため手動スクロールは提供せず、全文確認は反映後に行う。
ノードの「AI編集中」バッジは `rounded-md px-1.5 py-0.5 text-[10px] shrink-0`、背景 `--accent-soft`、文字 `--text`。


## 制作エージェントへの指示欄

制作チャットだけに表示し、相談（編集者）には表示・適用しない。制作内の「相談する」でも適用する。既存の author_chat_rules の内容を引き継ぐ。

制作チャット上段の「作業対象を追う」の行に、作業メモ・変更範囲と並ぶ開閉ボタン「指示」として置く(2026-10-15。
それまでは 3 つの折りたたみ枠を縦に積んでいて、閉じていても会話の上を 3 段ぶん占めていた)。型は §4「行に並べる開閉ボタン」。
変更範囲のボタンは短い表記(「範囲: 全体 · 保護なし」)にし、保護するシーンの名前はツールチップに出す。制作が始まったら閉じる。
入力は共通の `AutoTextarea` を使い、最小3行から文章量と折り返しに合わせて自動伸縮する。
入力欄自体には高さの上限や内部スクロールを設けず、設定内容全体に `max-h-[50vh] overflow-y-auto inspector-scrollbar` を適用する。
長文でも保存操作へ到達できるようにし、相談・制作の外側にも必要時の縦スクロールを許可する。

## 共通チャットと下段の詳細欄

- シーン詳細は実際のパネル幅720px以上で2列。右はタイトル・本文・感情の核、左は既定42%の幅で挿絵・登場人物・場所・時刻・イベント。`DetailSplit` の `mainOnRight` を指定する。各列を独立スクロールし、保存欄は下端に固定する。本文の横幅は最大80ch。
- シーンタブは `DetailSplit` の `aside` を使う3列(2026-10-13。上の2列の記述のうちシーンタブの列の中身はこちらが優先)。パネル幅1100px以上で、左から 挿絵・登場人物・場所・前のシーンからの経過・削除(既定264px、200〜440px) / イベント(既定34%、最小260px) / タイトル・本文・感情の核(最小360px)。下段は横に広く縦に短いので、横に並べて縦スクロールを減らす。720px以上1100px未満は、挿絵・設定とイベントを左の1列に縦に重ねて1つのスクロールにし、本文を右に置く。左から右の順は幅が変わっても保ち、720px未満の1列だけ本文を先頭にする。境界は2本とも動かせる。イベントと本文の間は割合で `sceneDetailEventsWidth` に、左の列の右の境界は px で `sceneDetailEventsWidthAside` に保存する(左の列は挿絵と短い設定項目なので、パネルを広げても間延びしないよう px で持つ)。本文360px・イベント260pxを先に確保し、左の列はその残りまでしか広がらない。左の境界は3列のときだけ操作でき、縦に重なる幅では横線になる。列内余白は16px。章の詳細も同じ3列で、左から 表紙 / シーン一覧(目次) / まとめ(幅は `chapterDetailListWidth` と `…Aside` に保存。表紙が無いときは左の列に「まだ表紙がありません」の説明を出し、列を空にしない)。キャラ・清書・関係図は2列のまま。
- 下段の詳細エリアの左右の余白は 20px(`px-5`)で揃える(2026-10-13 に 12〜16px から拡大。この項より前に書いてある下段の列内余白 12px・16px は、左右については 20px に読み替える。上下は従来どおり)。対象はタブの行、`DetailSplit` の各列、保存欄・章名の行、時点の表示、事実の表。スクロールする列は、スクロールバー(10px)の溝を `scrollbar-gutter: stable` で常に確保し、右の余白をその分減らす(`pl-5 pr-2.5`)。こうすると中身の右端が、スクロールの有無にかかわらず、タブの行の「閉じる」や下の保存欄のボタンと同じ 20px の位置に揃う(溝を確保しないと、スクロールバーが出たときだけ中身が 10px 内側へずれる)。キャラ・事実の左の一覧は左 12px + 行の内側 8px で、アイコンの左端が 20px に揃う。
- 章の詳細のシーン一覧(目次)は、各行の左に挿絵のサムネイルを出す(2026-10-18 ユーザー要望)。大きさは Memories と同じ `h-10 w-16 rounded-md`・`object-cover`(中央で切り抜く)。行は `flex items-center gap-2 px-2 py-1` の `button` で、サムネイルも含めて押すとそのシーンを選ぶ。番号付きの一覧なので、挿絵の無いシーンも同じ大きさの空の枠(地 `--bg-canvas`)を置いてタイトルの位置を揃える(Memories は枠を出さないが、こちらは行が縦に揃っていることを優先)。章の中に挿絵が 1 枚も無いときは空の枠が並ぶだけなので、サムネイルの列ごと出さない。
- 下段のタブは、シーンを選んでいるとき「シーン / 清書 / キャラ / 関係図 / 事実」、章を指しているとき(章カードを選択、または章の中で何も選んでいない)は「章 / 関係図 / 事実」。清書・キャラはシーンに結びついた画面なので章では出さない。章のときの関係図・事実は章の最後のシーンまでを表示し、タブの下に `shrink-0 border-b px-3 py-1 text-[11px]`・`--text-faint` で「第N章「章名」の終わり(「最後のシーン名」)まで」と時点を出す。シーンの無い章では空の案内を出す。清書・キャラを開いたまま章を選んだら章の詳細を見せ、シーンに戻れば元のタブに戻す。
- キャラタブは、左に登場人物の一覧(`index.css` の `char-detail-list`、固定188px)、右に選んだ人物の状態(記憶 / 事実・関係の2列)。一覧の行は資料庫の一覧と同じ型(`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]`、`CharAvatar` 24px + 省略表示の名前、選択は `--accent-soft` と `--text`、`aria-pressed`)。パネル幅720px未満では一覧を上の横並び(折り返し)へ戻す。関係(Relationships)の相手の名前にも `CharAvatar` 24px を付ける(一覧と同じ大きさ。名前の欄は `w-32`)。
- 事実タブもキャラタブと同じ左の一覧(`char-detail-list`)で対象を選ぶ(プルダウンは使わない)。並べるのは登録済みの人物の全員と、末尾に区切り線を挟んだ「世界」(人物に属さない事実。`Icon name="globe"` 16px を24px枠に置く。クラス `fact-world-row`)。「帯をクリックすると値が変わったシーンを選択」の案内は、表の「項目」見出しと帯のツールチップに載せる。
- 720px未満は本文を先にした1列と共通スクロールへ戻す。`scene-detail` のコンテナクエリで画面全体ではなくパネル幅を判定する。列内余白は12px（シーン・章の左側の補助情報は16px）、項目間は12px、列の境界は `--border`。
- 詳細欄の挿絵は列の全幅・縦横比維持で表示し、高さ上限は設けない。本文との境界をドラッグまたは左右キーで調整でき、幅の割合（25〜65%）を保存する。本文は最小320px、補助情報は最小280pxを確保する。未設定のドロップ枠は `px-3 py-2`。画像関連モーダルはPortalで画面全体に表示する。
- 章詳細はシーンと共通の `DetailSplit` を使い、左に表紙・シーン一覧、右にまとめを置く(2026-10-13 に `aside` を使う3列へ変更。上のシーンタブの項を参照)。章名は上部、まとめの保存は下端に固定する。表紙は列の全幅・高さ制限なし。列幅は章とシーンで別々に保存する。
- 清書・キャラ・関係図も `DetailSplit` を使い、列幅をタブ別に保存する。清書はシーンタブと同じく `mainOnRight` で、左の列に上から スタイルプリセット(人称と文体)+ 編集・新規 / POV / 分量 / 清書ボタン を 1 項目 1 行で縦に積み、その下に統計(2026-10-15 ユーザー指定。以前は左に本文、右に条件を折り返して並べていた)。プルダウンは中身に「POV:」「分量:」が出るので見出しは付けない。
  その下に別の区切り「表示」(`border-t pt-3`、見出しは `text-[11px] uppercase tracking-[0.14em]`・`--text-faint`)を置き、右の本文のフォント(`FONT_OPTIONS`)と文字の大きさ(`FONT_SIZES`)を横に並べる。**鑑賞モードとは別の、この画面だけの設定**(settings の `render_tab_font` / `render_tab_font_size`。未設定のあいだは鑑賞モードの `reader_font` / `reader_font_size` から始める。2026-10-15 ユーザー指定)。
  右の列は**鑑賞モードの「挿絵分割」と同じ見た目**(2026-10-15 ユーザー指定): 上にシーンのタイトル(鑑賞モードのシーン見出しと同じ `text-[16px] font-semibold`、`--text`。フォントは本文と同じ)、その下に左が挿絵・右が本文の 5:7(間 32px。`index.css` の `render-split`)。
  挿絵は原画。**タイトルと挿絵は動かさず、本文だけをその欄の中でスクロールする**(2026-10-15 ユーザー要望。本文の列 `scene-detail-main` はスクロールさせず、`render-prose` が `overflow-y: auto`。挿絵の高さの上限はタイトルの下の欄の高さ)。
  本文の列が 420px 以下なら挿絵を上に小さく(高さ 140px まで)置き、その下で本文をスクロールする。詳細欄が 1 列になる幅(720px 未満)では欄全体がスクロールするので、固定せずに挿絵(高さ 320px まで)・本文を縦に流す。動画は鑑賞モードと同じ `CrossfadeLoopVideo`(つなぎ目は設定の `video_crossfade_seconds`)。
  本文は左の「表示」で選んだフォント・文字の大きさ、行間 1.9(鑑賞モードの本文と同じ組み方)。挿絵の無いシーンは本文だけを `max-w-2xl` で中央に置く。
  本文の列は `DetailSplit` の `wideMain` で 80ch の制限を外す(上限 64rem)。詳細欄の幅の判定は `@container scene-detail`(本文の列の中も別のコンテナなので名前で指す)。
  2026-07-31 に清書の本文をシーンタブと同じ UI フォント 13px に揃えたが、この変更で鑑賞モードの見た目に合わせ直した(同日の 15px・40em の調整も置き換え)。キャラは上部に選択欄を固定し、左に記憶、右に事実・関係。関係図は左の表示枠を列の全幅・全高に広げ、右に時点・フィルタ・選択した関係の履歴を置く。狭幅では図の枠を高さ280pxとする。図は枠のサイズ変更時に全体を収め直す。
- 事実は対象の選択欄を上部に固定し、表を縦横スクロールする。項目列は140pxで左端固定、シーン列は96pxで見出しを上端固定。背景は `--bg-sidebar`、表の余白は12px。見出しと帯の列幅を揃え、帯クリックによるシーン選択を維持する。

- チャットは構造・資料庫共通の右パネル。既定幅440px、ドラッグは320〜900px、表示上限は画面幅の60%。背景は `--bg-chat`。幅と開閉状態を保存する。
- 上部モードバー右端の「チャット」で開閉。二次ボタンの型を使い、開いている場合は `--accent-soft`。鑑賞ではパネルとボタンを非表示にする。チャットのパネルの中には「閉じる」ボタンを置かない(2026-10-14 に撤去。すぐ上の「チャット」と役割が重なるため)。下段の詳細欄の「閉じる」は残す(開閉の「詳細」ボタンがキャンバス左下にあって欄から離れているため)。
- 構造の詳細欄はキャンバスの下だけに置く。既定高さ340px、ドラッグは最小220px、表示上限70%。背景は `--bg-sidebar`。高さと開閉状態を保存する。
- 分割線は1px・`--border`、当たり判定は線の両側へ3〜4px広げる。右パネルは横方向、詳細欄は縦方向にリサイズする。
- 詳細欄はタブ列末尾の「閉じる」、キャンバス左下の「詳細」で開閉。折りたたんでも編集内容を保持する。
- 相談・制作の会話一覧は共通の `ChatHistoryPanel` を使い、「会話一覧」ボタンの真下にポップオーバーで出す（2026-10-13 に折りたたみの上段から変更。開閉がわかりにくかったため）。外枠はポップオーバーの型（`--bg-card`・`rounded-xl`・`--border-strong`・`shadow-lg shadow-black/40`・`z-50`）で、行の左右8px内側いっぱい(チャット欄とほぼ同じ幅。最大幅は設けない)・最大高さ `min(320px, 60vh)`、一覧は内部でスクロールする。会話の行は、左端に今の会話名、右端に操作のアイコンを置く(2026-10-13 に入れ替え。それまでは左に「会話一覧」の文字のボタン、その右に会話名だった)。アイコンは `h-6 w-6 rounded-md border` の 13px で、左から 会話一覧(`Icon name="list"`)・新しい会話(`Icon name="chatPlus"`。吹き出しに +)。どちらも `aria-label` とツールチップを付ける。会話一覧は開いている間、トグルのオンと同じ `--accent-soft` と `--text`、`aria-expanded` を付ける。新しい会話は一覧の中には置かない。外側のクリック・Escape・ボタンの再クリックで閉じ、会話の選択と新規開始でも閉じる。⋯メニューや名前変更の入力が開いている間のEscapeはそちらだけを閉じ、名前変更・削除では一覧を閉じない。各行の右端に、最終更新からの経過を `text-[10px] tabular-nums`・`--text-faint` で出す(たった今 / N分前 / N時間前 / N日前。30日を過ぎたら日付)。正確な日時は行のツールチップに出す。新規開始、選択、⋯から名前変更・削除を行う。履歴は相談・制作で分離し、処理中は会話の操作を無効にする。本文の横幅を確保するため常設サイドバーにしない。
- 制作の見出し・操作行は `flex-wrap` と `gap-2` で折り返し、狭い幅でも操作に到達できるようにする。
- 制作チャットの外枠は `min-w-0 w-full flex-1` で親パネル幅に収める。長い会話名の内容幅で外枠を拡大せず、一覧内で省略表示する。
- 会話一覧の開閉行には現在の会話名を常時表示する。行は `flex min-w-0 items-center gap-2 px-3 py-1`、ボタンは `shrink-0`、会話名は `min-w-0 flex-1 truncate text-[12px]` と `--text`。相談・制作の切り替えは `px-3 py-1 text-[13px]`(左上の 構造 / 資料庫 / 鑑賞 と同じ大きさ。2026-10-13 に 12px から拡大)。全文は `data-tip` で表示し、新規開始時は「新しい会話」とする。
- シーンの保存欄は `flex flex-wrap items-center justify-between gap-2`。保存の隣に二次ボタンの型で「元に戻す」を置き、未保存変更がない場合と保存・メタ情報の自動生成中は無効にする。対象は選択中シーンの未保存項目のみで、説明は `data-tip` に表示する。
- 資料庫のキャラクター・場所は一覧の名前横と保存ボタン横に `UnsavedBadge` を表示する。シーンの未保存バッジと同じ `shrink-0 rounded-md px-1.5 py-0.5 text-[10px]`、背景 `--accent-soft`、文字 `--text`。一覧名は `min-w-0 flex-1 truncate` でバッジの幅を確保する。保存値との差分がある場合のみ表示する。
- 資料庫の資料(キャラクター・場所・設定資料)には、画面全体の保存欄を置かない。下の「読む表示」で項目ごとに確定して保存する(2026-10-13。同日に一度入れた下端固定の保存欄 `library-save-bar` は、この方式に置き換えて廃止)。
- 資料庫のキャラクター編集は 上段 + 下段(`index.css` の `character-editor`、最大幅 `max-w-4xl`)。上段は左にアイコン・名前・色・読み、右に参照画像を半分ずつ並べ、下段に文章の項目(プロフィール・外見・口調)と読み上げの声を全幅で置く。上段は固定し、下段だけをスクロールする(長い文章を書いているあいだも顔と名前と立ち絵が見えるように)。上段と下段の境は `--border` の線。親の `main` はスクロールさせず、高さいっぱいを 上=上段+下段 / 下=保存欄 に分ける(このため保存欄は sticky ではなく下の段に置かれる)。編集欄が低い(640px未満)か狭い(600px未満)ときは、上段の固定をやめて全体を一緒にスクロールし、狭いときは上段の左右も縦に積む。左右2列(左を固定)の案は、文章欄が狭くなり参照画像の説明文も窮屈だったため不採用(同日に作り直し)。場所・設定資料は1列のまま(ユーザー判断)。
- 資料庫の資料(キャラクター・場所・設定資料)は「読む表示」が既定(2026-10-13。SNS のプロフィールのようにすっきり見せ、見返しやすくする)。部品は `FieldEdit.tsx` の `EditPencil` / `EditActions` / `ReadText` / `editKeys` / `focusEditGroup` を使い、3 種類で同じ見た目と操作に揃える。名前(設定資料はタイトル)は `text-[22px] font-semibold`、その下に補足を `text-[12px]`(キャラクター・場所は読み。未設定は `--text-faint` で「読みは未設定」。設定資料は「分類 ・ 扱い ・ AI: 参照方法」を1行、適用範囲があればもう1行)、文章の項目は見出し(`text-[12px]`・`--text-dim`)の下に `whitespace-pre-wrap text-[13px] leading-relaxed`・`--text` の本文。項目の間は20px。設定資料の本文だけは Markdown を整形して表示する(キャラクター・場所の文章は LLM にそのまま渡す素の文章なので、整形しない)。
  - 編集は項目ごと。見出しの横に鉛筆(`Icon name="pen"` 13px、`rounded-md p-1`、`--text-faint`、hover で `--accent-soft`、`aria-label` と `data-tip` に「〜を編集」)を置き、押した項目だけを従来の入力欄にする。編集に入るのは鉛筆だけで、本文を押しても入らない(2026-10-19 ユーザー指摘「クリックで即編集だと編集ボタンの意味がない」。それまでは本文を押しても編集に入った)。空の項目は「+ 〜を書く」(`text-[12px]`・`--text-faint`)を出す。名前・読み・色(設定資料はタイトル・分類・扱い・AI参照方法・適用範囲)は1つの単位としてまとめて編集する。新規作成の直後だけ全項目を編集状態で開く。編集欄を包む要素には `data-edit-group` を付ける(フォーカスとキー操作の単位。資料の種類ごとに名前を変える)。
  - 編集欄の右下(右寄せ。校正ボタンは見出しの行の右端にある)に、左から `UnsavedBadge`(変更があるとき)・「取り消し」・「確定」の順で置き、主な操作の確定を右端にする。確定は(`accent-action rounded-md border px-2.5 py-1 text-[12px] font-medium`)、取り消しは二次ボタンの型。確定はその項目だけを保存して読む表示へ戻り、取り消しは保存値へ戻して閉じる。Ctrl+Enter で確定、Esc で取り消し(名前の欄は Enter でも確定)。保存エラーは同じ行の下に出す。
  - 削除はページの末尾に区切り線を引いて「このキャラクターを削除」「この場所を削除」「この設定資料を削除」(`delete-action text-[12px]`、右寄せ)。キャラクターの読み上げの声と、キャラクター・場所の画像はこれまでどおり、その場で保存する。設定資料は編集中の「編集 / プレビュー」の切り替えをやめ、読む表示をプレビューの代わりにする。
- 制作の「作業対象を追う」はシーンに加えキャラクター・場所にも適用する。シーンは構造画面、資料は資料庫の該当タブ・編集欄へ移動。資料登録後は一覧の再取得を待って選択する。追従オフ・手動編集中は自動移動せず、未保存の資料編集も保護する。
- 章内キャンバス左上は「作品全体 › 第N章『章名』」のパンくずで表示する。既存の `rounded-xl border px-2 py-1.5 text-[12px]`、背景 `--bg-card`、枠 `--border-strong` を使用。上位は `--text-dim` のボタン、区切りは `--text-faint`、現在地は `--text` と `font-medium`。章名は `min-w-0 max-w-56 truncate` と `data-tip` で省略・全文表示し、ナビゲーションに「現在の階層」、現在地に `aria-current="page"` を付ける。
- パンくず横には操作を置かない(解除ボタンも、名前変更の鉛筆も置かない。2026-10-13 に鉛筆を撤去。パンくずは現在地を示すだけにする)。名前の変更は下段の章の詳細の章名の横(鉛筆は章名のすぐ右に置き、押すか章名をダブルクリックで**その場で**入力欄に変わる。Enter / 欄を離れると保存、Escape で取り消し。入力欄は章名と同じ `text-[14px] font-semibold` のまま入れ替わる欄(`rounded-md border px-1.5 py-1`・地 `--bg-input`・枠 `--accent-border`。見出しの大きさを保つため入力欄の A / B 型の例外)。2026-10-17 にモーダルから変更)と、章カードの右クリック(こちらはモーダル)から行う。「章を解除」は章カードと章内キャンバス背景の右クリックメニューに置き、シーンを残してまとまりを解除することをツールチップで説明する。章内背景メニューの見出しには対象章名を表示する。
- 資料庫の左側は種類タブを使わず、キャラクター・場所・設定資料の順に開閉式の階層メニューを並べる。見出しは `text-[12px] font-medium`、開閉三角と `aria-expanded`・`aria-controls` を付ける。追加は各見出し横の二次ボタン、関係図はキャラクター見出し横の11pxボタン。子一覧は `ml-3 border-l pl-1` と `--border`、資料行は `rounded-lg px-2 py-1.5 text-[12px] gap-2`。人物は共通 `CharAvatar` の24px、場所は24px角の参考画像（`rounded-md border object-cover`、枠 `--border-strong`）。画像がなければ同じ24px枠内に色付きの札を置く。選択は `--accent-soft` と `--text`、名前は省略表示しホバーで全文。開閉は編集対象を変更せず、資料名のクリックで編集対象を切り替える。制作の追従・新規追加では該当種類を展開する。
- 関係図の右の列(資料庫・詳細欄で共通。`RelationGraph.tsx`)の Time は、見出し「Time」の下に今の時点のシーンを出す(2026-10-18 ユーザー要望)。左に挿絵のサムネイル(`h-10 w-16 rounded-md object-cover`、Memories・章のシーン一覧と同じ)、右に番号「7/12」(`text-[11px] tabular-nums`・`--text-faint`)とタイトル(`text-[12px] truncate`・`--text-dim`)を 2 行で。挿絵の無いシーンは同じ大きさの空の枠(地 `--bg-canvas`)にする(動かしている最中に枠が出入りしてスライダーの位置がずれないように)。作品に挿絵が 1 枚も無ければ枠ごと出さない。その下に全幅のスライダー。**Time はシーンだけを数える**(はじまり・章の入口と出口・結末の目印は関係を変えず、動かしても図が変わらないコマになるため。キャラクタービュー・出番の図と同じ数え方。2026-10-18 ユーザー指摘)。開いた直後は最後のシーン。
- 関係の強さのフィルタは「弱い関係を隠す」(`text-[11px]`・`--text-faint`、ツールチップで説明)+ 幅 120px 固定のスライダー + 値(「0.20 未満」/ 0 のときは「なし」)。0〜1 を 0.05 刻みで選ぶだけなので、Time と同じ全幅にしない(2026-10-18 ユーザー指摘)。`.settings-slider` は `width: 100%` を持つので、幅は `style` で上書きする(Tailwind の幅クラスは効かない)。
- 資料庫の関係図(直角の線、2026-10-15)の線のラベルは、線の上に `--bg-canvas` の下地(角丸 3px、高さ 12px、文字幅 + 6px)を敷いて `--text-dim`・8.5px で置く(線はラベルのところで途切れて見える)。線の上に置けないときは線の脇に寄せる。詳細欄の関係図も同じ(2026-10-15 20:50 から直角の線)。線の太さは関係の強さで `1 + |score| × 2`(1〜3px)、矢じりは長さ `6 + 太さ`・幅 `5 + 太さ`(太さに比例させない。2026-10-16)。

- 設定資料は mx-auto max-w-2xl の幅。編集欄の部品の大きさはキャラクター・場所と揃える: ラベルは `mb-1 block text-[12px]`・`--text-dim`、入力欄と選択欄は `rounded-lg border px-3 py-1.5 text-[13px]`、タイトルは名前と同じ `h-11 text-[18px] font-semibold`、本文は入力欄の A 型(`rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed`)、編集欄の中の項目間は16px。扱いとAI参照方法は折り返し可能な横並び。一覧の絞り込み欄には用途を表示する。
- 制作の作業対象追従は設定資料にも適用する。新規作成後は一覧取得を待って選択し、種類を展開して絞り込みを解除する。変更履歴は「設定資料作成」「設定資料編集」と表示。追従オフ・手動編集中・未保存資料の保護は既存の資料と共通にする。

- 警告色 `--warn`(#f59e0b)は、しきい値を超えたなどの警告に使う(使用量リングの `--context-warning` はこれを参照)。中止・危険の `--danger`、エラー文の `--danger-text`、削除の `--delete-*` とは分ける。
- 「制作を実行」の色は `--execute`(#dd88b5。最初の #f472b6 は強かったので、同日に彩度を抑えた)・`--execute-soft`・`--execute-border`(2026-10-13。同日に一度 `--warn` のオレンジを当てたが、警告ではなく「相談より一段重い操作」を示す色として分けた。紫のアクセントとオレンジの組み合わせが強く浮いて見えたため、紫となじむ紫寄りのピンクにした。エラーの赤と紛れないよう、赤寄りのローズ系は使わない)。`accent-action` の実行版は `execute-action`。
- 制作チャットの LLM が動いている間は「書き換えだけ」を止める(2026-10-13。それまでは領域ごとに `inert` を付け、スクロールや選択まで止めていた)。仕組みは `writeLock.ts`: 領域(キャンバスの `main`、下段の詳細、資料庫)に `data-write-locked="true"` を付け、その中の操作部品(button / input / textarea / select / contenteditable と `data-write-action` の要素)への入力を document の capture で捨てる。見るための部品には `data-view-ok` を付けて通す(タブの行、一覧の行、シーンへ移動するボタン、章ビューの切り替え、詳細欄の開閉、関係図、事実タブ)。近いほうの印が勝つので、`data-view-ok` の一覧の中にある「追加」ボタンは `data-write-action` で止める。止めている部品は `opacity: 0.5` と `cursor: not-allowed` で示す。新しい部品を足すとき: 見るだけの操作なら `data-view-ok` を付ける。操作部品でない要素(div や p)で書き換えを始めるものは `data-write-action` を付ける。キャンバスは移動・拡大縮小・選択・矢印キーでの移動ができ、ノードの移動・接続・切断・右クリックメニュー・貼り付け・削除はできない。上のバー(モデルの切り替え・設定)と鑑賞モードは従来どおり操作不可。データを守っているのはサーバー側(制作中の書き込みは 409)で、印の付け漏れがあっても作品は壊れない。
- 制作チャットの会話は、作者の発言を右寄せの吹き出し、制作側(読み取り・操作・報告)を時系列の線と丸で並べる(2026-10-13。それまでは全部が同じ枠付きのカードで、流れを追いにくかった)。項目は `index.css` の `timeline-item`(左 18px、線は `--border-strong` の 1px。項目の下の余白 24px が次の丸との間隔になる。2026-10-14 に 10px から拡大。作者の吹き出しの下も同じ 24px)と `timeline-dot`(9px の丸。`--bg-chat` の縁で線を切る)。見出しは `text-[11px]`・`--text-faint` で、左に種類、右端に時刻(`flex items-baseline gap-2`。時刻は `shrink-0 tabular-nums` で右に揃え、縦に追えるようにする。作者の吹き出しの見出しも同じ)、その下に中身。丸の色で種類を示す: 確定した操作は `--ok`(#3ecf8e。作品が実際に変わった印)、読み取りの手順は `--text-faint`、LLM の文章は `--text-dim`、途中指示の照合・作業メモの通知は `--accent`、失敗は `--danger`、生成中は点滅。読み取りの手順は「シーン本文を読む: シーン名」のように1行で出し、本文は出さない。AI が書いている途中の本文(未確定の編集案)も、時系列の末尾に点滅する `--accent` の丸の項目として出す(見出し「編集案を作成中: シーン名」、本文は `--text-dim` で高さ 320px まで・中でスクロールして末尾を追う)。確定・失敗・終了で消える。入力欄の上に別の箱として出さない(入力欄の位置が動くため)。操作の変更内容は `details` に折りたたむ。相談チャット(編集者との会話)は吹き出しのまま。成功・確定の色 `--ok` を `index.css` に定義した(直値 #3ecf8e を使っている既存箇所は順次寄せる)。
- 制作チャットの発言に添える送信時の条件は、既定でないときだけ出す。「変更範囲 / 保護」は、範囲を絞ったか保護があるときだけ(相談として送った発言には出さない。相談では使われないため)。「送信時の選択」は選択があるときだけ。実行として送った発言には、見出しの「あなた」の横に `--execute` の文字で「制作を実行」と付ける(相談と実行の発言が混ざるので、作品を書き換えた依頼が分かるようにする)。
- 制作チャットの発言欄は、スクロールバーを親の右の余白(16px)へ出し(`-mr-4`)、溝を常に確保したうえで発言との間を 6px 空ける(`pr-1.5`)。発言の右端は、スクロールの有無にかかわらず上のパネルや入力欄と揃う。
- 上のバーのサービスのボタン(TTS / ComfyUI。`ServiceBar`)は、停止中に「停止中」と書かない。稼働中はアクセント色の枠・背景・アイコン、停止中は名前だけを `--text-dim`・アイコンを `--text-faint` で示す。未導入・起動中・起動失敗は文字で出す(色だけでは対処の違いが伝わらないため)。
- 上のバーのボタン(ライブラリ / TTS / ComfyUI)は同じ型にする: `flex min-w-[150px] items-center gap-2 rounded-lg border px-3 py-1`、文字 `text-[12.5px]`、アイコン 15px、枠 `--border-strong`、背景 `--bg-elevated`。文字は `flex-auto text-center` にし、右側に左のアイコンと同じ幅(15px)の要素か空きを置いて、ボタン全体の中央に見せる(2026-10-13)。
- 制作チャットの入力は、入力欄と下の操作の行を1つの箱にまとめる(2026-10-14。`index.css` の `chat-composer`。それまでは「選択中」の行・入力欄・操作の行が別々に縦に並んでいた)。箱は `rounded-lg border`、背景 `--bg-input`、枠 `--border`。上の段は入力欄(`AutoTextarea`。枠も背景も付けず `px-3 pt-2 pb-1 text-[12px]`、`resize-none`)、下の段は `flex items-center gap-2 px-2 pt-1 pb-2`(左右と下が 8px)で、左に「選択中: …」(`min-w-0 flex-1 basis-0 truncate text-[11px]`。選択があれば `--text-dim`、無ければ `--text-faint`。全文と説明はツールチップ)、右に使用量リング・送信モードの切り替え・↑ボタン。折り返さず、長い選択名は省略して送信ボタンを次の行へ落とさない。章カードを選んでいるときは「選択中: なし(章カードは添付されません)」と短く出し、詳しい説明はツールチップへ移す。「Enterで送信・Shift＋Enterで改行」の文は置かず、送信ボタンのツールチップの2行目に書く。入力欄のプレースホルダは `--text-faint` にする(既定の色だと、入力済みの文章のように見える)。フォーカスは入力欄ではなく箱の枠で示す(入力欄の枠は消し、箱に `--accent-border-bright` の 2px を内側に描く)。「制作を実行」を選んでいる間は、箱の枠を `--execute-border`、フォーカスの枠を `--execute` にする。進行状況の文と「制作を実行」を選択中の注意文は、箱の上に置く。進行状況の行は、出すものがあるときだけ表示する(空のときに使い方の説明で埋めない)。使い方の説明は、会話が空のときだけ会話欄の中に `pt-6 text-center text-[12px] leading-relaxed`・`--text-faint` で出す(相談チャットの最初の案内と同じ置き方。2026-10-14)。常設の説明文は面積を取るので、空の状態・ツールチップ・設定画面のどれかへ寄せる。箱とチャット欄の下端の間は 16px 空ける(欄の余白は `px-6 pt-2 pb-4`。8px だとステータスバーに近く詰まって見えた)。この項より前にある「入力欄の直前に『選択中: …』を表示する」「下の行の『Enterで送信…』」の記述は、この項が優先する。
- 制作チャットの下の行の部品(使用量リング・送信モードの切り替え・↑ボタン)は高さ 26px に揃える。処理中の「停止」は、↑と同じ位置・同じ丸い形のまま中身を `Icon name="stop"` 12px に変える(枠 `--border-strong`・`--text-dim`、`aria-label="停止"`。文字のボタンに変えない)。ステータスバーの高さは `h-9`(36px。2026-10-13 に 28px から拡大)。右側のリソース表示(CPU / RAM / GPU / VRAM)は、文字 `text-[11px]`、バーは高さ 4px・幅 52px(同日に 10px・3px・40px から拡大)。リソース表示の右端に切り替えのアイコンボタン(`Icon name="activity"` 13px、`h-6 w-6 rounded-md border`。会話一覧ボタンと同じ型で、オンは `--accent-soft` + `--text`、オフは `--text-faint`。`aria-pressed`)を置き、押すと表示を隠す・戻す(2026-10-17 ユーザー要望。`localStorage` の `statusResourcesVisible` で覚え、隠している間はリソースの問い合わせも止める)。
- 制作チャットの送信は、切り替え「相談する / 制作を実行」+ 丸い↑ボタン(`h-[26px] w-[26px] rounded-full border`、`Icon name="arrowUp"` 14px、`aria-label="送信"`、ツールチップでどちらとして送るかを示す)。既定は相談。実行は1回ごとに選び直す方式で、制作の実行が終わると(完了・停止・エラーのどれでも)自動で相談へ戻す。実行を選んでいる間は、切り替えの枠と選択側・入力欄の枠・↑ボタン(`execute-action`)を実行の色にし、入力欄の上に `--execute` の1行で「送信すると作品を編集する」ことを出す。相談のときは従来のアクセント色(`accent-action`)。下の行の「Enterで送信…」は `min-w-0 flex-1 basis-0 truncate` で省略表示にし、狭い幅でも↑ボタンを次の行へ落とさない。処理中は同じ丸いボタンが停止(■)になる。制作の実行中だけは入力の有無で切り替える: 空なら停止(■)、文字があれば途中指示の送信(↑、`execute-action`、`aria-label="途中指示を送る"`)。文字の「途中指示を送る」ボタンは置かない(2026-10-13 に撤去。Claude Code と同じ切り替え方)。相談の処理中は途中指示を受け付けないので、入力があっても停止のまま。
- チャット欄(相談・制作)の左右の余白は `px-6`(24px。2026-10-13 に 16px から広げた)。上の「相談 / 制作」の切り替えの行、会話名の行、会話・パネル・入力欄をすべて同じ余白に揃える。制作の会話のスクロール領域は `-mr-6 pr-3.5` でスクロールバーを余白の中へ出す(24 = バー10 + 余白14)。
- 制作の依頼候補は会話の末尾に、固定の候補を最大3個、LLM が作る候補を最大3個、折り返しと6px間隔で置く。丸型11pxボタン(`production-suggest-chip rounded-full border px-3 py-1 text-[11px]`)。ラベルに対象と操作を含め、長い名前は折り返す。**クリックでその場で送信する**(2026-10-13 に変更。それまでは入力欄へ入れるだけで、送るまで3手かかっていた)。送り方を色で分ける: 相談として送る候補は `accent-action`(紫)、「制作を実行」として送る候補は `execute-action`(ピンク)。色は `style` ではなくこの2つのクラスで付ける(hover を効かせるため)。Shift＋クリックは送らずに入力欄へ入れ、送信モードも候補に合わせる。入力済みでは無効化して理由をツールチップに表示する。ツールチップには送る文面と、どちらとして送るかを書く。LLM の候補を取っている間は、ボタンの並びの末尾に `text-[11px]`・`--text-faint` で「ほかの候補を考えています…」と出す。LLM が作った候補には、相談チャットの生成された質問と同じ `Icon name="sparkle"`(11px、`shrink-0`)をラベルの前に付ける(ボタンは `inline-flex items-center gap-1`。固定の候補には付けない)。案を進めるボタン(「○○の案で進めて」)は LLM の候補として出し、固定の「この案で進めて」は LLM の候補が使えないときの代わりにだけ出す。取得中には出さない(後から LLM の候補に入れ替わると、押す瞬間に別の実行を押しかねないため。出ているボタンは後から動かさない)。

- シーンタブの「前のシーンからの経過」(見出し `Elapsed`)は、場所の下に1行で置く(2026-10-13。場所と横に並べると、左の列が狭いときに単位の文字が切れるため縦に積む。項目間は12px)。プルダウン(未設定 / 直後 / 同じ日 / 時間後 / 日後 / 週間後 / か月後 / 年後。`min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-[13px]`、未設定のときの文字は `--text-faint`)の左に、数を持つ単位のときだけ数の欄(`type="number"`、`w-16 shrink-0 tabular-nums`、同じ角丸と高さ)を出し、「3」「日後」と読める並びにする。間隔は6px。選択肢の説明は見出しのツールチップに書き、欄の下に説明文は置かない。場所(`Location`)と経過の見出しの右端には、本文から読み取る「推測」ボタンを置く(「LLM を走らせるボタン」の型。`Icon name="sparkle"` 11px、実行中は「推測中… (Ns)」)。タイトルの「自動生成」と違い、本文に書いてあることを読み取るだけなので「推測」と呼ぶ。結果は下書きに入れるだけで保存せず、何と推測したか・根拠・判断できなかったことはステータスバーの一時通知で伝える(欄の下に結果の文は足さない)。場所が1つも登録されていないときの場所の「推測」は無効にし、理由をツールチップに書く。

- 直前の回答がある場合、頻用する「この案で進めて」を制作候補の先頭に置く。最大3件の枠内で優先し、クリック後の入力・送信の扱いは他の候補と共通。

- 選択と章のレビュー候補は会話が空でも出す。シーン選択中は「選択中の…をレビュー」、選択が無く章カードを選択中または章の中を開いているときは「章「章名」をレビュー」を同じ枠に置く（両方は出さない）。依頼文には章名と章IDを含めて対象を固定する。

- 制作の章操作は「章を作成」「章名を変更」「章にシーンを追加」と履歴に表示し、詳細は「章の変更内容」とする。確定後の追従は構造画面の章一覧に切り替えて対象章カードを選択する。既存の追従オフと手動編集の制御に従う。

### キャラクタービュー(人物別の出番表。`CharacterTimeline.tsx`)

構造モードのツールバー「人物」(`Icon name="users"` 14px + 文字。絵文字は使わない)で、キャンバスの上に重ねて出す(2026-10-14)。事実タブの `FactTimeline` と同じ
固定幅の表で、横がシーン(1 列 112px)、縦がキャラクター(1 行 44px)。左の名前の列(168px)と上の見出しは `sticky`。

- 出番のセルは **エンティティの色の描き方**(§1)に従う: 下地 `${color}33`(線が透けないよう、その下に `--bg-canvas` を敷く)、枠 `1.5px solid <color>`。中は空で、
  名前とタイトルは `aria-label` と `data-tip` に持つ。選択中のシーンのセルは `box-shadow: 0 0 0 2px var(--accent-border)`
- 同じ人物が続けて出ているシーンのセルは 1 本の帯にまとめる(2026-10-15 ユーザー要望)。出番が途切れたら切り、章の境目では切らない。
  帯の中の列の境目に区切り線(幅 1px、上下 6px 内側、`${color}80`)を入れて何シーン続いているかを見せる。帯は見た目だけ(`pointer-events-none`)で、
  クリック・ツールチップ・選択の枠は帯の上に重ねたシーンごとの透明なボタンが持つ(選択の枠は帯のうちその列の部分だけを囲む)
- 出番のセルをクリックすると、その人物をそのシーンの時点で詳細欄に出す(2026-10-15 ユーザー要望)。フローチャートのシーンカードで登場人物の札を
  押したときと同じ処理(シーンを選び、詳細欄は人物専用の表示)。シーンの表示にしたいときは列の見出しを押す
- 線は SVG で下に敷く。人物の横線はその人物の色(太さ 2、不透明度 0.6)、同じシーンをつなぐ縦線は `--text-faint`
  (選択中は `--accent`)。レーンの区切りは `--border`
- 章の帯は章の色で、セルと同じ 20% 下地 + 枠 + 文字。`text-[10px] font-medium`。
  色が未設定の章は、フローチャートの章カードと同じ無彩色: 地 `--bg-card`、枠 `--border-strong`、文字 `--text-dim`
  (2026-10-15 ユーザー指摘。以前はフォールバックの `#8a8fa8` の 20% 下地で、灰色が浮いて見えた)。
  帯の行は高さ 30px(帯は上から 2px・高さ 16px)で、下の見出しのサムネイルとの間を 12px 空ける(2026-10-15 ユーザー要望。22px では密着して見えた)。
  帯は `button` で、クリックするとその章を選ぶ(フローチャートで章カードを選んだのと同じく、詳細欄が章の表示になる。2026-10-15 ユーザー要望)。
  選択中の章の帯は `box-shadow: 0 0 0 2px var(--accent-border)`(セルの選択と同じ)と `aria-pressed`
- 列の見出しは `text-[11px]`、選択中だけ `--accent-soft` の下地 + `--text`。その列全体にも `--accent-soft` を薄く敷く
- 列の見出しのタイトルの上に挿絵のサムネイル(`NodeThumb`、幅いっぱい・高さ 54px・`rounded object-cover`)を出す(2026-10-15 ユーザー要望)。
  表の見出しなので高さを揃えて中央で切り抜く(シーンカードのように元の比率では出さない)。挿絵の無いシーンはタイトルだけで、タイトルは下端で揃う
- シーンを選んでいるとき ← / → で前後のシーンへ移る(2026-10-15 ユーザー要望。キャラクタービューの間はフローチャートの矢印キーを止めているので表の側で受ける。文字入力中・表が画面に無いときは効かない。端では止まる)。
  キーで移るときは、表の中で前にクリックしたセル・見出しのフォーカスを外す(残すとキー操作でその `:focus-visible` の枠が出て、選択だけが移り枠が置き去りに見える。クリックで選んだときと同じく選択の強調だけを動かす)
- 表は左ドラッグで上下左右に動かせる(2026-10-15 ユーザー要望。フローチャートの空き地のドラッグと同じ感覚)。4px 動いてからドラッグとみなし、
  それまではクリック(見出しのクリックはそのまま効く。動かしたあとのクリックは捨てる)。出番の帯の上からは始めない(将来の cast の付け替えのドラッグに空けておく)。
  カーソルは表の上で `cursor-grab`、ドラッグ中は表の中すべて `cursor-grabbing`。ドラッグ中に文字が選択されないよう表は `select-none`
- 画面の上の帯(戻るボタン「⊞ フローチャート」+ 見出し + 説明)は `px-3 py-1.5 border-b`。戻るボタンはツールバーの二次ボタンと同じ
  `rounded-lg border px-2.5 py-1 text-[13px]`

### 出番の図(資料庫の人物・場所のページ。`SceneUsage.tsx`)

資料庫の人物のページ(文章の項目と「読み上げの声」の間)と場所のページ(説明・雰囲気の下)に出す、1 行ぶんの出番表
(2026-10-16 19:33。ユーザー要望「背景が使われている場面を知りたい」「人物も登場するシーンを図にして」)。
見出しは他の項目と同じ `text-[12px]`・`--text-dim`(「登場するシーン」/「使われている場面」)で、右に件数を `text-[11px] tabular-nums`・`--text-faint`
(場所は「3(うち引き継ぎ 1)」)。

- 正史のシーンを横一列(1 列 72px)。目印(はじまり・章の入口と出口・結末)は列に出さず、数にも入れない。横に長ければ図だけ横スクロール(`inspector-scrollbar`)。
- 上に章の帯(キャラクタービューと同じ型: 章の色の 20% 下地 + 枠 + 文字、`text-[10px] font-medium leading-[16px]`。色の無い章は `--bg-card`・`--border-strong`・`--text-dim`。帯の行は 22px)。
- 章の帯の下に、各シーンの挿絵のサムネイル(`h-10 w-16 rounded-md object-cover`、地 `--bg-canvas`、行は 44px)を並べる(2026-10-18 ユーザー要望)。キャラクタービューの列の見出しと同じく、帯の上に絵・下に名前。その人物が出ていない・その場所でないシーンにも出す(流れの目印)。挿絵の無いシーンは同じ大きさの空の枠で列を揃え、図に出るシーン(正史と分岐)に挿絵が 1 枚も無ければ行ごと出さない。サムネイルは列のボタンの中にあり、押すとフローチャートでそのシーンを開く。分岐の行にも同じ形で出す。
- 出ていないシーンは「抜け」に見えないようにする(2026-10-18 ユーザー指摘「出番がないと何か抜けている感じ」)。出番の段には全部の列を通す無彩色の線路(`--border-strong`、太さ 2、端は丸)を引き、その上に初登場から最後の出番までの色の線と出番の帯を重ねる。出ていないシーンのサムネイルは `filter: grayscale(1)`・`opacity: 0.45` で控えめにする(同じ行の中での主従。§5 で淡くしてよい場合)。
- 出番はエンティティの色の帯(§1 の描き方。高さ 22px、左右 5px 内側。続けて出ているシーンは 1 本にまとめ、`${color}80` の区切り線で何シーンかを見せる)。
  初登場から最後の出番までをその色の線(太さ 2、不透明度 0.6)で結ぶ。
- **場所の引き継ぎ**(location を空欄にして親から受け継いだシーン)は **破線の帯 + 10% の下地**(`${color}1a`)で区別し、ツールチップに「(場所を親から引き継ぎ)」。
- 下の行にシーン名 `text-[10px]`(番号は `--text-faint`、出ているシーンは `--text`、出ていないシーンは `--text-faint`)。列全体が `button`(`hover:bg-[var(--accent-soft)]`)で、クリックすると `workspace.openScene` でフローチャートに移ってそのシーンを選ぶ。
- 正史から外れた分岐は、その資料が出てくる枝だけを「分岐: 「分岐元」から」(`text-[10px]`・`--text-faint`)の見出し付きで下に 1 本ずつ並べる。
- 最後に `text-[11px]`・`--text-faint` の一言(「クリックでフローチャートで開きます。」。場所は破線の説明も)。出番が 0 なら「まだどのシーンにも登場していません。」。
- 詳細欄の人物専用の表示(フローチャートの札から開く `CharacterEditor`)には出さない(資料庫だけが `usage` を渡す)。

### 詳細欄の人物専用の表示

キャラクタービューの出番のセルか、フローチャートのカードの登場人物の札(`nodrag` の `button` で、hover は `--accent-soft`)をクリックすると、詳細欄のタブバーが人物のものに入れ替わる(2026-10-14 23:10)。
先頭に `CharAvatar` 20px + 名前(`text-[12px] font-medium`)、続けてタブ「プロフィール / 状態 / 関係図 / 事実の履歴」(シーンのタブと同じ部品)。
時点のあるタブ(状態・関係図・事実の履歴)は、中身の上に `border-b px-5 py-1 text-[11px]` / `--text-faint` で「「タイトル」の時点」を出す(章の関係図・事実と同じ型)。
プロフィールは資料庫と同じ `CharacterEditor`(`px-5 pt-3` で囲む。削除ボタンは出さない)。状態は `CharTab` の `lockChar`、事実の履歴は `FactTimeline` の `fixedTarget` で人物を固定し、左の一覧は出さない。
- ヘッダーの各部品は `shrink-0 whitespace-nowrap`、説明文だけ `min-w-0 truncate`(狭い幅で部品が折り返さないように)

### 章の詳細のシーン一覧と右の列(`ChapterTab.tsx`)

一覧で選んだものを右の列に出す(2026-10-19)。一覧は「何を見るか」を選ぶ場所で、選んでも章の中には入らない。

- 先頭に「章のまとめ」の行、続いてシーンの行。行は `rounded-md px-2 py-1 text-[12px]`、選択中は `--accent-soft` + `--text`(`aria-current`)、それ以外は `--text-dim`。サムネイルの列があるときは、まとめの行にも同じ幅(`w-16`)の空きを置いてタイトルの位置を揃える。まとめの行の右端に「未保存」(編集中のカードに確定していない変更があるとき。`--text-dim`)か「要更新」(`--danger-text`)を `text-[10px]` で出す
- ↑↓ キーで行を移り、フォーカスも一緒に移す。シーンを開くのは行のダブルクリック
- シーンを出すときの右の列: 見出しの行に eyebrow(`text-[11px] uppercase tracking-[0.14em]`「シーン 1」/「別の道」)・タイトル(`text-[14px] font-semibold`、`truncate`)・右端に二次ボタン「シーンを開く →」。その下にセグメント「清書 / 本文」(§4 の型)と、清書が無いときの説明(`text-[11px]` / `--text-faint`、「…(本文を表示しています)」)。本文は `whitespace-pre-wrap text-[13px] leading-relaxed` / `--text`。古い清書は清書タブと同じく「要更新」のバッジを付けて `opacity: 0.6`
- 読むだけ。編集の部品は置かない(書き直しはシーンを開いてから)
- まとめの見出しの行(2026-10-19 ユーザー指摘): 「章のまとめ」(eyebrow)・ⓘ(`Icon name="info"` 12px・`--text-faint`、`role="img"`、説明は `data-tip` と `aria-label`)・状態バッジ(最新 / 要更新)、右端(`ml-auto`)に「削除」(`delete-action`)と「⟳ まとめを作り直す / ▶ まとめを作る」(主ボタン)。主な操作を右端に、削除はその左。
  説明文を見出しの下に常に出すのはやめ、ⓘ のツールチップへ移した。まとめがまだ無いときだけ、「まだまとめはありません。」に続けて 1 文の説明を本文に出す(説明が要るのは作る前なので)
- まとめのカード(2026-10-19): **人物ごとに 1 枚**。シーンの Events の記憶カードと同じ型(`flex gap-2.5 rounded-lg border px-3 py-2 text-[12px]`、地 `--bg-elevated`、左に `CharAvatar` 28px、1 行目に名前 `font-medium`・`--text`)。
  項目が 2 件以上ある人物は、名前の横に「2 件」(`text-[11px] tabular-nums`・`--text-faint`)。項目どうしは `mt-1.5 border-t pt-1.5`(`--border`)で区切る。
  人物の順は章カードの登場人物と同じ(`chapterCast`。読む道で出番の多い順、同数は初登場順)、登場人物に入っていない人物はその後ろに保存順。fact_set など人物の要約でない項目は最後に中身をそのまま出す。
  見せ方だけで、保存・編集の単位は項目のまま。
  読む表示が既定で、本文は「」付き・`leading-relaxed`・`--text-dim`、続けて「重要度 0.60」を `text-[11px]`・`--text-faint`・`whitespace-nowrap`。
  各項目の右に `FieldEdit.tsx` の `EditPencil`(「このまとめを編集」。`flex items-start gap-2` で本文の 1 行目に揃える)。編集に入るのは鉛筆だけで、本文のクリックでは入らない(資料庫の読む表示と同じ)。
  編集中はその項目の本文を `AutoTextarea`、その下に「重要度」の数値欄(`w-16`)、右下に `EditActions`(未保存・取り消し・確定)。編集は 1 項目ずつ、確定でその項目を保存する(Ctrl+Enter 確定、Esc 取り消し)。下の帯の保存ボタンは置かない

### 章カードの登場人物(`StructureNodes.tsx` の `ChapterNodeCard`)

章ビューの章カードの「N シーン」の行の下に、その章の登場人物を**シーンカードと同じ札**(アイコン + 名前)で `mt-2 flex flex-wrap items-center gap-1` に並べる(2026-10-18 ユーザー要望)。
札は `nodrag inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] hover:bg-[var(--accent-soft)]`・地 `--bg-elevated`・文字 `--text-dim`。
アイコンはプロフィール画像(`h-3.5 w-3.5 rounded-full object-cover`)、無ければ人物の色の点(`h-2 w-2 rounded-full`)。
当初はアイコン(`CharAvatar`)だけにしていたが、画像の無い人物は頭文字しか出ず誰か分からないので、名前を出す形に揃えた(同日ユーザー判断)。

- 数えるのは**読む道(`route`)のシーンの cast だけ**。章の中の分岐・島のシーンは数えない(試しに書いた枝の人物まで章の顔ぶれに出さない。まとめ・鑑賞と同じ範囲)
- 並びは出るシーンの多い順、同数なら先に出た順。章カードは `w-64` なので、2〜3 文字の名前で 1 行に 3 人ほど入り、それ以上は折り返す
- 6 人を超えた分は「+N」(`text-[11px] tabular-nums`・`--text-faint`)にまとめ、そのツールチップに残りの名前を「、」区切りで出す(2 行に収め、カードを縦に伸ばしすぎない)
- 札をクリックすると、シーンカードの札と同じく詳細欄を人物専用の表示にする。
  時点は**その章の読む道で、その人物が最後に登場するシーン**(そのシーンを選ぶので、章カードの選択は外れる)。ツールチップに名前と、どのシーンの時点になるかを書く。
  クリック・ダブルクリックはカードに伝えない(ダブルクリックは章を開く操作なので、連打で章の中へ入らないように)
- 登場人物が 0 人の章では行ごと出さない

### 人物の状態の Memories(`CharTab.tsx`)

シーンの「キャラ」タブと、人物専用の表示の「状態」タブで共通。記憶はカード(`rounded-lg border px-3 py-1.5 text-[12px] leading-relaxed`、地 `--bg-elevated`、枠 `--border`)で並べる。

- **続けて同じ出どころの記憶は 1 枚のカードにまとめる**(2026-10-18 ユーザー要望)。並び順(新 → 古 / 古 → 新)のまま隣り合うものだけをまとめ、シーンごとに集め直さない。章のまとめの記憶は章ごとにまとめる
- カードは `flex gap-2.5`。左に出どころの挿絵のサムネイル(`NodeThumb`、`h-10 w-16 rounded-md object-cover`。高さを揃えて中央で切り抜き、`self-start` で上端に揃えて記憶が多くても伸ばさない)、右に記憶を縦に並べる。
  記憶どうしの間は `mt-1 border-t pt-1`(`--border`)の区切り線
- サムネイルはシーンならその挿絵、章のまとめなら章の表紙(`chapterCoverNode`)。挿絵が無ければ列ごと出さず、本文を左詰めにする(空の枠は置かない)
- 出どころ「← シーン名」(`text-[10px]`)はカードの末尾に 1 回だけ。サムネイルも同じ行き先のボタンで、同じツールチップを持つ
- 選択中のシーンで得た記憶のカードは、出どころの文字を `--accent` にし「(このシーン)」を添えたうえで、枠を `--accent-border` にする

### シーンの Events(`EventsEditor.tsx`)

詳細欄のシーンタブの Events は、**種類ごとの見出し**で分けて並べる(2026-10-18 ユーザー要望)。

- 見出しは「記憶 / 関係 / 事実 / その他」の順。`flex items-center gap-1.5 text-[11px] font-medium`・`--text-dim` に、`Icon` 12px(記憶 `recall`・関係 `relation`・事実 `fact`・その他 `more`)と件数(`tabular-nums`・`--text-faint`)。見出しどうしは `mt-3`。
  記憶には記憶の圧縮、その他には退場・手動上書きなどが入る。**件数 0 の見出しは出さない**
- 色分けはしない(色だけの区別はキャラ色と混ざる。§5)。見出しの文字とアイコン、それに種類ごとの見た目の密度で分ける
- 見出しの中は保存順のまま(同じ事実を 2 回設定したら後が勝つので、順番に意味がある)。違う種類どうしは状態の別の部分を変えるだけなので、分けて並べても結果は同じ
- **すべてカード**(`rounded-lg border px-3 py-2`、地 `--bg-elevated`)。左に `CharAvatar` 28px(世界の事実は `h-7 w-7 rounded-full border`・`--border-strong` の枠に `Icon name="globe"` 15px)、
  1 行目に だれ(`font-medium`・`--text`)+ 出どころのバッジ(`LLM` / `USER`)+ 右端に鉛筆(`EditPencil`。編集中は隠す)と ✕、本文は下に幅いっぱい(2026-10-18。最初は関係・事実を枠の無い 1 行にしたが、
  「キー = 値」「-0.20」のような書き出しの文と合わせてデバッグ表示に見えたので、カードに揃えて中身を読む形にした)。
  1 行目は、関係なら「ケン → (ア)アヤ」、世界の事実なら「世界」。種類の名前は混ざる「その他」と記憶の圧縮、編集中だけ出す
  関係の相手は、矢印(`--text-faint`)の後ろ・名前の前に `CharAvatar` 18px で出す(2026-10-18 ユーザー要望。左の 28px は関係を持つ側のまま、ほかのカードと左の列を揃える)。
  相手が勢力のときはアイコンも色も無いので、`GET /factions` から引いた勢力の名前だけを出す(ID のまま出さない)
- **記憶**: 本文を「」付きで、続けて重要度・感情を `text-[11px]`・`--text-faint`・`whitespace-nowrap` で添える
- **関係**: 関係の一言(相関図の矢印に出る文)を「」付きで主役にし、その下に**今の関係と今回の変化を分けて**出す。符号付きの数だけでは、変化の向きと関係の良し悪しが区別できないため。
  - バー: 共通部品 `RelationBar`(下の「関係のバー」)。直前の値を `before` に渡して薄い塗りで敷く。両端に「反感」「好意」(`text-[10px]`・`--text-faint`)。ツールチップに「好感度 前 → 後(薄い塗りが前、濃い塗りが今)」
  - 文: 「反感 → ふつう(0.00)」のように段階の言葉で前後を出し(段階は 強い反感 ≤ −0.6 < 反感 ≤ −0.15 < ふつう < 0.15 ≤ 好意 < 0.6 ≤ 強い好意。言葉は好意を `--rel-positive`、反感を `--rel-negative`、ふつうを `--text-faint`)、
    続けて「▲ 良くなった」(`--rel-positive`)/「▼ 悪くなった」(`--rel-negative`)/「変わらず」。色だけにせず、言葉と ▲▼ でも向きが分かる。関係がまだ無かったときは「なし → …」
  - 直前の値は `GET /nodes/{id}/state_before`(パス上の 1 つ前のノードの状態)から引き、そのシーンの関係イベントを保存順に当てて 1 件ごとに出す(-1〜+1 に丸めるのは fold と同じ)。
    読めるまではイベントの数だけ(「▼ 0.20」「関係を 0.60 に」)を出す
- **事実**: 「キー = 値」にせず、項目名を `text-[11px]`・`--text-faint` のラベル、値を本文(`--text-dim`)にして `flex flex-wrap items-baseline gap-x-2` で並べる(短ければ横に、長ければ折り返す)
- 見出しの右端の「+」(`h-5 w-5 rounded-md text-[13px]`、hover `--accent-soft`)で、その種類の手動イベントのフォームを**その見出しの下に**開く(記憶 `memory_add`・関係 `relationship_update`・事実 `fact_set`。その他には無い)。開いている間は ✕ になり、もう一度押すと閉じる。
  フォームの中で種類を選び直しても、開いた場所からは動かさない。上の「+ 手動イベント」は残す(件数 0 の種類は見出しが無いので、最初の 1 件はこちらから足す)

### 関係のバー(`RelationBar.tsx`)

人物どうしの関係の値(-1〜+1)を出すバー。キャラタブの Relationships と、シーンの Events の関係で共用する(2026-10-18 ユーザー指摘「中央がどこだか分からない」を受けて作り直した)。

- 地は `h-1.5 rounded-full`・`--bg-input`。0 を中心に、好意は右へ `--rel-positive`、反感は左へ `--rel-negative` で塗る
- **塗りは中央側を角ばらせ、外側の端だけ丸くする**(好意は `rounded-r-full`、反感は `rounded-l-full`)。どちらから伸びているかが形で分かる
- **0 の目盛りはバーより上下に 2px はみ出す**(`-inset-y-0.5 w-0.5 rounded-full`・`--text-faint`)。塗りの上に描く。地の外へ出すので、地に `overflow-hidden` を付けない
- 直前の値は**線ではなく、同じ色の薄い塗り**(`color-mix(in srgb, <色> 30%, transparent)`)で今の塗りの下に敷く。縦線を足すと中央の目盛りと紛れるため。伸びた・縮んだ・向きが変わったが面積で分かる

### VRAM の目安(設定の推論パラメータ。`settings/VramEstimate.tsx`)

Context Length のスライダーの目盛りの下に出す(2026-10-18 ユーザー要望)。`mt-1.5 flex flex-col gap-0.5 text-[12px]`。

- 1 行目: 「VRAM の目安 **約 28.8 GB**」(見出しは `--text-dim`、値は `font-medium tabular-nums`・`--text`)+ 内訳「重み 23.5 + KV 4.8 + 作業 0.6 / 搭載 47.8 GB」(`text-[11px] tabular-nums`・`--text-faint`、ツールチップで各項目の意味)
- 注意は文で出す(色だけにしない): 搭載量を超える → `--danger-text`「⚠ GPU の搭載量を超えます…」/ 9 割を超える → `#f59e0b`「⚠ …ComfyUI・TTS・Embedding と同時に使うと足りない可能性」/ モデルの最大コンテキスト長を超える → `#f59e0b`
- 目盛りぶんの目安を 1 回で受け取り、スライダーを動かすとその場で切り替える(動かすたびに問い合わせない)。ヘッダーを読めないときは `settings-field-hint` で「モデルのヘッダーを読めませんでした」(理由はツールチップ)
