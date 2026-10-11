# UI スタイルガイド(色・タイポ・余白・部品)

作成日時: 2026-08-09 16:00
更新日時: 2026-10-12 05:39

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

### 削除ボタン

削除操作は共通クラス `delete-action` を使う。通常は文字 `--text-dim`、枠 `--border-strong`。
有効なボタンの hover / focus-visible だけ文字 `--delete-hover` (`#cf9393`)、
枠 `--delete-border` (`rgba(207, 147, 147, 0.4)`) にする。無効時は色を変えない。
サイズ・余白は既存のボタンの型を使い、インラインで文字色・枠色を指定しない。
エラー・状態警告・処理中止の `--danger` は別用途として維持する。
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
- 既定は要素の**下**(入らなければ上)。祖先に `data-tip-side="right"` があれば**右**(入らなければ左)に出す。
  縦に並ぶ行(右クリックメニュー)で次の行に被らないようにするための指定
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

折りたたみ枠は作業メモと同じ `rounded-lg border px-3 py-1.5 text-[12px]`、背景 `--bg-elevated`。
入力は共通の `AutoTextarea` を使い、最小3行から文章量と折り返しに合わせて自動伸縮する。
入力欄自体には高さの上限や内部スクロールを設けず、設定内容全体に `max-h-[50vh] overflow-y-auto inspector-scrollbar` を適用する。
長文でも保存操作へ到達できるようにし、相談・制作の外側にも必要時の縦スクロールを許可する。

## 共通チャットと下段の詳細欄

- シーン詳細は実際のパネル幅720px以上で2列。右はタイトル・本文・感情の核、左は既定42%の幅で挿絵・登場人物・場所・時刻・イベント。`DetailSplit` の `mainOnRight` を指定する。各列を独立スクロールし、保存欄は下端に固定する。本文の横幅は最大80ch。
- 720px未満は本文を先にした1列と共通スクロールへ戻す。`scene-detail` のコンテナクエリで画面全体ではなくパネル幅を判定する。列内余白は12px（シーン・章の左側の補助情報は16px）、項目間は12px、列の境界は `--border`。
- 詳細欄の挿絵は列の全幅・縦横比維持で表示し、高さ上限は設けない。本文との境界をドラッグまたは左右キーで調整でき、幅の割合（25〜65%）を保存する。本文は最小320px、補助情報は最小280pxを確保する。未設定のドロップ枠は `px-3 py-2`。画像関連モーダルはPortalで画面全体に表示する。
- 章詳細はシーンと共通の `DetailSplit` に `mainOnRight` を指定し、左に表紙・シーン一覧、右にまとめを置く。章名は上部、まとめの保存は下端に固定する。表紙は列の全幅・高さ制限なし。列幅は章とシーンで別々に保存する。
- 清書・キャラ・関係図も `DetailSplit` を使い、列幅をタブ別に保存する。清書は左に本文（最大80ch）、右に生成条件・実行・統計。キャラは上部に選択欄を固定し、左に記憶、右に事実・関係。関係図は左の表示枠を列の全幅・全高に広げ、右に時点・フィルタ・選択した関係の履歴を置く。狭幅では図の枠を高さ280pxとする。図は枠のサイズ変更時に全体を収め直す。
- 事実は対象の選択欄を上部に固定し、表を縦横スクロールする。項目列は140pxで左端固定、シーン列は96pxで見出しを上端固定。背景は `--bg-sidebar`、表の余白は12px。見出しと帯の列幅を揃え、帯クリックによるシーン選択を維持する。

- チャットは構造・資料庫共通の右パネル。既定幅440px、ドラッグは320〜900px、表示上限は画面幅の60%。背景は `--bg-chat`。幅と開閉状態を保存する。
- 上部モードバー右端の「チャット」で開閉。二次ボタンの型を使い、開いている場合は `--accent-soft`。鑑賞ではパネルとボタンを非表示にする。
- 構造の詳細欄はキャンバスの下だけに置く。既定高さ340px、ドラッグは最小220px、表示上限70%。背景は `--bg-sidebar`。高さと開閉状態を保存する。
- 分割線は1px・`--border`、当たり判定は線の両側へ3〜4px広げる。右パネルは横方向、詳細欄は縦方向にリサイズする。
- 詳細欄はタブ列末尾の「閉じる」、キャンバス左下の「詳細」で開閉。折りたたんでも編集内容を保持する。
- 相談・制作の会話一覧は共通の `ChatHistoryPanel` を使い、「会話一覧」で折りたたむ上段に置く。高さ180px・上限35%、枠は `--border`。新規開始、選択、⋯から名前変更・削除を行う。履歴は相談・制作で分離し、処理中は会話の操作を無効にする。本文の横幅を確保するため常設サイドバーにしない。
- 制作の見出し・操作行は `flex-wrap` と `gap-2` で折り返し、狭い幅でも操作に到達できるようにする。
- 制作チャットの外枠は `min-w-0 w-full flex-1` で親パネル幅に収める。長い会話名の内容幅で外枠を拡大せず、一覧内で省略表示する。
- 会話一覧の開閉行には現在の会話名を常時表示する。行は `flex min-w-0 items-center gap-2 px-3 py-1`、ボタンは `shrink-0`、会話名は `min-w-0 flex-1 truncate text-[12px]` と `--text`。全文は `data-tip` で表示し、新規開始時は「新しい会話」とする。
- シーンの保存欄は `flex flex-wrap items-center justify-between gap-2`。保存の隣に二次ボタンの型で「元に戻す」を置き、未保存変更がない場合と保存・メタ情報の自動生成中は無効にする。対象は選択中シーンの未保存項目のみで、説明は `data-tip` に表示する。
- 資料庫のキャラクター・場所は一覧の名前横と保存ボタン横に `UnsavedBadge` を表示する。シーンの未保存バッジと同じ `shrink-0 rounded-md px-1.5 py-0.5 text-[10px]`、背景 `--accent-soft`、文字 `--text`。一覧名は `min-w-0 flex-1 truncate` でバッジの幅を確保する。保存値との差分がある場合のみ表示する。
- 資料庫の保存欄は `flex flex-wrap items-center gap-2`。保存の隣に二次ボタンの型で「元に戻す」を置き、未保存変更がないときと保存・画像操作中は無効にする。ホバーで選択中資料の未保存変更が対象であることを説明する。
- 制作の「作業対象を追う」はシーンに加えキャラクター・場所にも適用する。シーンは構造画面、資料は資料庫の該当タブ・編集欄へ移動。資料登録後は一覧の再取得を待って選択する。追従オフ・手動編集中は自動移動せず、未保存の資料編集も保護する。
- 章内キャンバス左上は「作品全体 › 第N章『章名』」のパンくずで表示する。既存の `rounded-xl border px-2 py-1.5 text-[12px]`、背景 `--bg-card`、枠 `--border-strong` を使用。上位は `--text-dim` のボタン、区切りは `--text-faint`、現在地は `--text` と `font-medium`。章名は `min-w-0 max-w-56 truncate` と `data-tip` で省略・全文表示し、ナビゲーションに「現在の階層」、現在地に `aria-current="page"` を付ける。
- パンくず横に章の解除ボタンは置かない。「章を解除」は章カードと章内キャンバス背景の右クリックメニューに置き、シーンを残してまとまりを解除することをツールチップで説明する。章内背景メニューの見出しには対象章名を表示する。
- 資料庫の左側は種類タブを使わず、キャラクター・場所・設定資料の順に開閉式の階層メニューを並べる。見出しは `text-[12px] font-medium`、開閉三角と `aria-expanded`・`aria-controls` を付ける。追加は各見出し横の二次ボタン、関係図はキャラクター見出し横の11pxボタン。子一覧は `ml-3 border-l pl-1` と `--border`、資料行は `rounded-lg px-2 py-1.5 text-[12px] gap-2`。人物は共通 `CharAvatar` の24px、場所は24px角の参考画像（`rounded-md border object-cover`、枠 `--border-strong`）。画像がなければ同じ24px枠内に色付きの札を置く。選択は `--accent-soft` と `--text`、名前は省略表示しホバーで全文。開閉は編集対象を変更せず、資料名のクリックで編集対象を切り替える。制作の追従・新規追加では該当種類を展開する。

- 設定資料の編集は既存の mx-auto max-w-2xl 相当の幅と12px入力欄、項目間12pxを使う。扱いとAI参照方法は折り返し可能な横並び。本文は編集とMarkdownプレビューを切り替える。保存・元に戻す・未保存表示は共通の型を使い、一覧の絞り込み欄には用途を表示する。
- 制作の作業対象追従は設定資料にも適用する。新規作成後は一覧取得を待って選択し、種類を展開して絞り込みを解除する。変更履歴は「設定資料作成」「設定資料編集」と表示。追従オフ・手動編集中・未保存資料の保護は既存の資料と共通にする。
