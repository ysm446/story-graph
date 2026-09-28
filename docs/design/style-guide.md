# UI スタイルガイド(色・タイポ・余白・部品)

作成日時: 2026-08-09 16:00
更新日時: 2026-09-28 23:04

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
| `--text` | `#e2e4ef` | 本文・主要な値 |
| `--text-dim` | `#9499b0` | ラベル、二次ボタンの文字 |
| `--text-faint` | `#5c6078` | 補足、無効、単位、eyebrow |
| `--accent` | `#7c5af7` | 選択中・実行ボタン・リンク |
| `--accent-hover` | `#6d4de6` | アクセントの hover |
| `--accent-soft` | `rgba(124,90,247,0.12)` | 選択中の背景、hover の背景 |
| `--accent-border` | `rgba(124,90,247,0.35)` | 選択中の枠 |
| `--accent-border-bright` | `rgba(140,110,255,0.75)` | 状態を強く示す枠(モデル読み込み済みのバー等) |
| `--danger` | `#ef4444` | 削除・失敗・危険な操作 |

### 意味のある色(現状は直値。変数化はこれから)

| 値 | 意味 | 例 |
|---|---|---|
| `#3ecf8e` | 正常・稼働中・正の関係 | サーバー稼働の点、関係スコアのプラス |
| `#f2a3a3` | **エラーの文字色**(赤字を読みやすくした色) | 検証 NG、失敗メッセージ |
| `rgba(239,68,68,0.12)` | エラーの下地 | 警告バッジ、NG のカード |
| `#f59e0b` | 警告(しきい値 70%) | チャットのトークン使用率リング |
| `#ef4444` | 危険(しきい値 90%) | 同上・削除ボタン |

> 直値のまま散っているので、増やすときは `--ok` / `--warn` / `--danger-text` として
> `index.css` に足すほうがよい(既存を一括で置き換える必要はない)。

### エンティティの色(作者が選ぶ色)

キャラクター・場所・派閥は**自分の色**を持つ。既定値と描き方は決まっている。

- 新規キャラの既定 `#7c5af7`、新規の場所の既定 `#5a8fa7`、**色未設定のフォールバックは `#8a8fa8`**
- 塗りに使うときは **16 進に `33` を足して 20% の下地**にする(`` `${color}33` ``)
- 枠は `1.5px solid <color>`、文字色はその色のまま。**背景を不透明に塗らない**
  (キャラ色が自由なので、コントラストが壊れる)
- 点(凡例)は `inline-block h-2 w-2 rounded-full` に背景色

## 2. タイポグラフィ

フォントは `:root` の 1 スタックのみ:
`"Inter", "Segoe UI", "Noto Sans JP", system-ui, sans-serif`。等幅は `Consolas, monospace`
(コードとトークン数)。

| サイズ | 用途 | 実測 |
|---|---|---|
| `text-[10px]` | eyebrow(`uppercase tracking-[0.14em]`)、単位、スライダーの目盛 | 43 |
| `text-[11px]` | 補助テキスト、ヒント、小さいボタン、バッジ | 105 |
| `text-[12px]` | **既定の本文**。一覧・入力・ほとんどのボタン | 126 |
| `text-[13px]` | 見出しラベル(`settings-field-label`)、少し目立たせる本文 | 58 |
| `text-[14px]` | セクション見出し、モーダルのタイトル | 5 |
| `text-[15px]` 以上 | 鑑賞モードの本文・数値の強調のみ | 少数 |

- **太さは `font-medium`(500)か `font-semibold`(600)だけ。** `font-bold` は使わない
  (`settings-group-title` の 700 が唯一の例外)
- **eyebrow(小見出し)は `text-[10px] uppercase tracking-[0.14em]` + `--text-faint`。**
  英字の短い語(`Library`、`Model`)に使う
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

### 主ボタン(実行・確定。1 画面に 1 つが目安)

```tsx
<button
  className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
  style={{ background: 'var(--accent)' }}
>
  追加
</button>
```

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
- 大きさの目安: ラベルの横 `text-[11px] px-2 py-0.5` / 単独で置くもの `text-[12px] px-2.5 py-1` /
  パネル内の横幅いっぱい `text-[13px] px-3 py-1.5`
- **塗りつぶし固定(主ボタン)にはしない。** 同じ画面に何個も並ぶので、「保存」「まとめを作る」
  のような 1 つだけの主ボタンと強さが並んでしまう
- hover を CSS 側に置くのは、**インラインの `style` が `:hover` より強い**ため。
  `style={{ color: ... }}` と書くと hover の色が効かない

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

```tsx
<input
  className="rounded-md border px-2 py-0.5 text-[12px] outline-none"
  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
/>
```

`textarea` は `resize: vertical` が既定(`index.css`)。
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

### ポップオーバー / モーダル

```tsx
// ポップオーバー(ボタンの真下)
<div className="absolute left-0 top-8 z-50 w-72 rounded-xl border p-1.5 shadow-lg shadow-black/40"
     style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}>

// モーダル(オーバーレイをクリックで閉じ、中身は stopPropagation)
<div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onCancel}>
  <div className="w-[520px] max-w-[92vw] rounded-2xl border p-4"
       style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
       onClick={(e) => e.stopPropagation()}>
    <h3 className="mb-3 text-[14px] font-semibold">タイトル</h3>
```

幅は `w-[520px] max-w-[92vw]` のように**固定幅 + ビューポート上限**。`z-50` を使う。

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
- 形は用途で変える: プロフィールは丸(`h-28 w-28 rounded-full`、枠色はキャラの色)、
  全身の参照画像は縦長(`h-48 w-32 rounded-lg`)
- 画像の**操作(外す / 生成)は枠の横か下に文字ボタンで並べる**。
  **画像があるときの枠クリックは拡大表示**(`Lightbox`)に使い、差し替えは枠の右下隅の小さなアイコンボタン
  (`h-6 w-6 rounded-md border`、地は `rgba(28,31,43,0.85)`、`Icon name="image"`)とドロップで受ける。
  それ以外の押せるものは枠の中に重ねない

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
- 出るまでの間は 400ms(既に出ているとき隣へ移ったら 80ms)
- 座標から引いているのは、**`disabled` の要素がイベントを出さない**ため。素の `title` は
  押せないボタンで出ないが、押せない理由こそ読みたいので、そこを拾えるようにしてある
- **`data-tip` はアクセシブルな名前にはならない。** アイコンだけのボタンには
  `aria-label` も併記する(文言は同じでよい)
- 部品に文字列を渡して中で `data-tip` にする場合、プロパティ名は **`title` ではなく `tip`**
  にする(`LengthSelect` / `MsgActionButton`)。`title` のままだと素の `title` と紛れる

### 設定画面の枠(`index.css` のクラス)

`settings-card` / `settings-group-title` / `settings-field` / `settings-field-header` /
`settings-field-label` / `settings-field-hint` / `settings-slider` / `settings-value-badge`。
設定画面に何か足すときは **Tailwind で似た見た目を作り直さず、このクラスに乗る**。

### 状態の点・ヒント・エラー

```tsx
<span className="inline-block h-2 w-2 rounded-full" style={{ background: healthy ? '#3ecf8e' : 'var(--danger)' }} />
<p className="settings-field-hint">説明。なぜそうなるかまで書く</p>
<p className="text-[12px]" style={{ color: '#f2a3a3' }}>失敗した理由(パスや原因を含める)</p>
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

## 6. アイコンとアニメーション

- アイコンは `icons.tsx`(lucide 準拠のパス)。既定 `size=14`、`strokeWidth=2`、
  色は `currentColor`。ヘッダーなど大きめの場所は 17px
- **絵文字を UI の恒久的な部品にしない**(トグルの `☑ / ☐` は例外)。
  足りないアイコンは `icons.tsx` に PATHS を 1 行足す
- トランジションは `transition-colors`(0.15s 相当)まで。位置やサイズは動かさない
- 例外的に動くもの: 処理中のリング(1.4s)、チャットの候補チップ(`chip-in` 0.2s)、
  ステータスバーの `animate-pulse`

## 7. 文言(日本語 UI)

- ボタンは**短い動詞**(「開く」「変更」「今すぐバックアップ」)。体言止めでもよいが敬体にしない
- `title` は**説明文**。「オンにするとライブラリの中に置きます」のように、結果を書く
- 完了は「〜しました」、進行中は「〜しています…」(三点リーダは `…` 1 文字)
- エラーは**原因と対象を具体的に**。パス・件数・ID を省かない
  (例: `保存先フォルダを開けませんでした: D:\...`)
- 用語は画面と揃える: シーン / イベント / 章 / 正史 / 清書 / 資料庫 / ライブラリ。
  内部名(node / group / canon / render)を UI に出さない

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

- 意味色(`#3ecf8e` / `#f2a3a3` / `#f59e0b`)が直値で散っている → 変数化の余地
- `hover` の付け方が場所ごとに違う(付いていない押せる要素も多い)
- 構造モードのキャンバスは `disableKeyboardA11y` でノードをタブ順から外している
  (矢印キーの移動を自前で持っているため)。ノードのフォーカス枠は無い
- `text-[12.5px]` `text-[10.5px]` のような半端な値が数か所ある。新規では使わない
- 大きな画面(`StructureMode.tsx`)には、この表に無い一点物の見た目が残っている。
  触るときは近い部品を本書の型に寄せてよいが、**無関係な整形は混ぜない**
