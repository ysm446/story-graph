# UI スタイルガイド(色・タイポ・余白・部品)

作成日時: 2026-08-09 16:00
更新日時: 2026-10-13 14:20

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

スクロール領域(`overflow-y-auto`)の中から出すメニューは、`absolute` だと領域の端で切り取られる。
`createPortal` で `document.body` へ出し、`fixed` でボタンの位置(`getBoundingClientRect()`)に置く。
下に入りきらないときは上へ出し、領域がスクロールしたら閉じる(例: `ChatHistoryPanel.tsx` の行の ⋯ メニュー)。

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
- 効く範囲が項目ごとに違う設定は、見出しの直下に `settings-field-hint` で「適用先: …」を 1 行書く(`Section` の `scope`)。
- 設定で変えられずに必ず付く指示は、読み取り専用の枠(`rounded-lg border px-3 py-2 text-[12px]`、背景 `--bg-elevated`、
  文字 `--text-faint`)で見せる(`FixedPrompt`。組み込みの校正プリセットと同じ見た目)。ラベルに「(編集不可)」を付け、
  長いものは `details` の「全文を表示」に畳む。編集欄と食い違ったときにどちらが残るかをヒントに書く。

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
- シーンタブは `DetailSplit` の `aside` を使う3列(2026-10-13。上の2列の記述のうちシーンタブの列の中身はこちらが優先)。パネル幅1100px以上で、左から 挿絵・登場人物・場所・時刻・削除(既定264px、200〜440px) / イベント(既定34%、最小260px) / タイトル・本文・感情の核(最小360px)。下段は横に広く縦に短いので、横に並べて縦スクロールを減らす。720px以上1100px未満は、挿絵・設定とイベントを左の1列に縦に重ねて1つのスクロールにし、本文を右に置く。左から右の順は幅が変わっても保ち、720px未満の1列だけ本文を先頭にする。境界は2本とも動かせる。イベントと本文の間は割合で `sceneDetailEventsWidth` に、左の列の右の境界は px で `sceneDetailEventsWidthAside` に保存する(左の列は挿絵と短い設定項目なので、パネルを広げても間延びしないよう px で持つ)。本文360px・イベント260pxを先に確保し、左の列はその残りまでしか広がらない。左の境界は3列のときだけ操作でき、縦に重なる幅では横線になる。列内余白は16px。章の詳細も同じ3列で、左から 表紙 / シーン一覧(目次) / まとめ(幅は `chapterDetailListWidth` と `…Aside` に保存。表紙が無いときは左の列に「まだ表紙がありません」の説明を出し、列を空にしない)。キャラ・清書・関係図は2列のまま。
- 下段の詳細エリアの左右の余白は 20px(`px-5`)で揃える(2026-10-13 に 12〜16px から拡大。この項より前に書いてある下段の列内余白 12px・16px は、左右については 20px に読み替える。上下は従来どおり)。対象はタブの行、`DetailSplit` の各列、保存欄・章名の行、時点の表示、事実の表。スクロールする列は、スクロールバー(10px)の溝を `scrollbar-gutter: stable` で常に確保し、右の余白をその分減らす(`pl-5 pr-2.5`)。こうすると中身の右端が、スクロールの有無にかかわらず、タブの行の「閉じる」や下の保存欄のボタンと同じ 20px の位置に揃う(溝を確保しないと、スクロールバーが出たときだけ中身が 10px 内側へずれる)。キャラ・事実の左の一覧は左 12px + 行の内側 8px で、アイコンの左端が 20px に揃う。
- 下段のタブは、シーンを選んでいるとき「シーン / 清書 / キャラ / 関係図 / 事実」、章を指しているとき(章カードを選択、または章の中で何も選んでいない)は「章 / 関係図 / 事実」。清書・キャラはシーンに結びついた画面なので章では出さない。章のときの関係図・事実は章の最後のシーンまでを表示し、タブの下に `shrink-0 border-b px-3 py-1 text-[11px]`・`--text-faint` で「第N章「章名」の終わり(「最後のシーン名」)まで」と時点を出す。シーンの無い章では空の案内を出す。清書・キャラを開いたまま章を選んだら章の詳細を見せ、シーンに戻れば元のタブに戻す。
- キャラタブは、左に登場人物の一覧(`index.css` の `char-detail-list`、固定188px)、右に選んだ人物の状態(記憶 / 事実・関係の2列)。一覧の行は資料庫の一覧と同じ型(`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]`、`CharAvatar` 24px + 省略表示の名前、選択は `--accent-soft` と `--text`、`aria-pressed`)。パネル幅720px未満では一覧を上の横並び(折り返し)へ戻す。関係(Relationships)の相手の名前にも `CharAvatar` 24px を付ける(一覧と同じ大きさ。名前の欄は `w-32`)。
- 事実タブもキャラタブと同じ左の一覧(`char-detail-list`)で対象を選ぶ(プルダウンは使わない)。並べるのは登録済みの人物の全員と、末尾に区切り線を挟んだ「世界」(人物に属さない事実。`Icon name="globe"` 16px を24px枠に置く。クラス `fact-world-row`)。「帯をクリックすると値が変わったシーンを選択」の案内は、表の「項目」見出しと帯のツールチップに載せる。
- 720px未満は本文を先にした1列と共通スクロールへ戻す。`scene-detail` のコンテナクエリで画面全体ではなくパネル幅を判定する。列内余白は12px（シーン・章の左側の補助情報は16px）、項目間は12px、列の境界は `--border`。
- 詳細欄の挿絵は列の全幅・縦横比維持で表示し、高さ上限は設けない。本文との境界をドラッグまたは左右キーで調整でき、幅の割合（25〜65%）を保存する。本文は最小320px、補助情報は最小280pxを確保する。未設定のドロップ枠は `px-3 py-2`。画像関連モーダルはPortalで画面全体に表示する。
- 章詳細はシーンと共通の `DetailSplit` を使い、左に表紙・シーン一覧、右にまとめを置く(2026-10-13 に `aside` を使う3列へ変更。上のシーンタブの項を参照)。章名は上部、まとめの保存は下端に固定する。表紙は列の全幅・高さ制限なし。列幅は章とシーンで別々に保存する。
- 清書・キャラ・関係図も `DetailSplit` を使い、列幅をタブ別に保存する。清書は左に本文（最大80ch）、右に生成条件・実行・統計。キャラは上部に選択欄を固定し、左に記憶、右に事実・関係。関係図は左の表示枠を列の全幅・全高に広げ、右に時点・フィルタ・選択した関係の履歴を置く。狭幅では図の枠を高さ280pxとする。図は枠のサイズ変更時に全体を収め直す。
- 事実は対象の選択欄を上部に固定し、表を縦横スクロールする。項目列は140pxで左端固定、シーン列は96pxで見出しを上端固定。背景は `--bg-sidebar`、表の余白は12px。見出しと帯の列幅を揃え、帯クリックによるシーン選択を維持する。

- チャットは構造・資料庫共通の右パネル。既定幅440px、ドラッグは320〜900px、表示上限は画面幅の60%。背景は `--bg-chat`。幅と開閉状態を保存する。
- 上部モードバー右端の「チャット」で開閉。二次ボタンの型を使い、開いている場合は `--accent-soft`。鑑賞ではパネルとボタンを非表示にする。
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
  - 編集は項目ごと。見出しの横に鉛筆(`Icon name="pen"` 13px、`rounded-md p-1`、`--text-faint`、hover で `--accent-soft`、`aria-label` と `data-tip` に「〜を編集」)を置き、押した項目だけを従来の入力欄にする。鉛筆は小さいので本文を押しても編集に入る(文字を選択しているときは入らない)。空の項目は「+ 〜を書く」(`text-[12px]`・`--text-faint`)を出す。名前・読み・色(設定資料はタイトル・分類・扱い・AI参照方法・適用範囲)は1つの単位としてまとめて編集する。新規作成の直後だけ全項目を編集状態で開く。編集欄を包む要素には `data-edit-group` を付ける(フォーカスとキー操作の単位。資料の種類ごとに名前を変える)。
  - 編集欄の右下(校正ボタンの下の段、右寄せ)に、左から `UnsavedBadge`(変更があるとき)・「取り消し」・「確定」の順で置き、主な操作の確定を右端にする。確定は(`accent-action rounded-md border px-2.5 py-1 text-[12px] font-medium`)、取り消しは二次ボタンの型。確定はその項目だけを保存して読む表示へ戻り、取り消しは保存値へ戻して閉じる。Ctrl+Enter で確定、Esc で取り消し(名前の欄は Enter でも確定)。保存エラーは同じ行の下に出す。
  - 削除はページの末尾に区切り線を引いて「このキャラクターを削除」「この場所を削除」「この設定資料を削除」(`delete-action text-[12px]`、右寄せ)。キャラクターの読み上げの声と、キャラクター・場所の画像はこれまでどおり、その場で保存する。設定資料は編集中の「編集 / プレビュー」の切り替えをやめ、読む表示をプレビューの代わりにする。
- 制作の「作業対象を追う」はシーンに加えキャラクター・場所にも適用する。シーンは構造画面、資料は資料庫の該当タブ・編集欄へ移動。資料登録後は一覧の再取得を待って選択する。追従オフ・手動編集中は自動移動せず、未保存の資料編集も保護する。
- 章内キャンバス左上は「作品全体 › 第N章『章名』」のパンくずで表示する。既存の `rounded-xl border px-2 py-1.5 text-[12px]`、背景 `--bg-card`、枠 `--border-strong` を使用。上位は `--text-dim` のボタン、区切りは `--text-faint`、現在地は `--text` と `font-medium`。章名は `min-w-0 max-w-56 truncate` と `data-tip` で省略・全文表示し、ナビゲーションに「現在の階層」、現在地に `aria-current="page"` を付ける。
- パンくず横には操作を置かない(解除ボタンも、名前変更の鉛筆も置かない。2026-10-13 に鉛筆を撤去。パンくずは現在地を示すだけにする)。名前の変更は下段の章の詳細の章名の横と、章カードの右クリックから行う。「章を解除」は章カードと章内キャンバス背景の右クリックメニューに置き、シーンを残してまとまりを解除することをツールチップで説明する。章内背景メニューの見出しには対象章名を表示する。
- 資料庫の左側は種類タブを使わず、キャラクター・場所・設定資料の順に開閉式の階層メニューを並べる。見出しは `text-[12px] font-medium`、開閉三角と `aria-expanded`・`aria-controls` を付ける。追加は各見出し横の二次ボタン、関係図はキャラクター見出し横の11pxボタン。子一覧は `ml-3 border-l pl-1` と `--border`、資料行は `rounded-lg px-2 py-1.5 text-[12px] gap-2`。人物は共通 `CharAvatar` の24px、場所は24px角の参考画像（`rounded-md border object-cover`、枠 `--border-strong`）。画像がなければ同じ24px枠内に色付きの札を置く。選択は `--accent-soft` と `--text`、名前は省略表示しホバーで全文。開閉は編集対象を変更せず、資料名のクリックで編集対象を切り替える。制作の追従・新規追加では該当種類を展開する。

- 設定資料は mx-auto max-w-2xl の幅。編集欄の部品の大きさはキャラクター・場所と揃える: ラベルは `mb-1 block text-[12px]`・`--text-dim`、入力欄と選択欄は `rounded-lg border px-3 py-1.5 text-[13px]`、タイトルは名前と同じ `h-11 text-[18px] font-semibold`、本文は `rounded-lg border px-3 py-2 text-[13px] leading-relaxed`、編集欄の中の項目間は16px。扱いとAI参照方法は折り返し可能な横並び。一覧の絞り込み欄には用途を表示する。
- 制作の作業対象追従は設定資料にも適用する。新規作成後は一覧取得を待って選択し、種類を展開して絞り込みを解除する。変更履歴は「設定資料作成」「設定資料編集」と表示。追従オフ・手動編集中・未保存資料の保護は既存の資料と共通にする。

- 警告色 `--warn`(#f59e0b)は、しきい値を超えたなどの警告に使う(使用量リングの `--context-warning` はこれを参照)。エラー・中止の `--danger`、削除の `--delete-*` とは分ける。
- 「制作を実行」の色は `--execute`(#dd88b5。最初の #f472b6 は強かったので、同日に彩度を抑えた)・`--execute-soft`・`--execute-border`(2026-10-13。同日に一度 `--warn` のオレンジを当てたが、警告ではなく「相談より一段重い操作」を示す色として分けた。紫のアクセントとオレンジの組み合わせが強く浮いて見えたため、紫となじむ紫寄りのピンクにした。エラーの赤と紛れないよう、赤寄りのローズ系は使わない)。`accent-action` の実行版は `execute-action`。
- 制作チャットの LLM が動いている間は「書き換えだけ」を止める(2026-10-13。それまでは領域ごとに `inert` を付け、スクロールや選択まで止めていた)。仕組みは `writeLock.ts`: 領域(キャンバスの `main`、下段の詳細、資料庫)に `data-write-locked="true"` を付け、その中の操作部品(button / input / textarea / select / contenteditable と `data-write-action` の要素)への入力を document の capture で捨てる。見るための部品には `data-view-ok` を付けて通す(タブの行、一覧の行、シーンへ移動するボタン、章ビューの切り替え、詳細欄の開閉、関係図、事実タブ)。近いほうの印が勝つので、`data-view-ok` の一覧の中にある「追加」ボタンは `data-write-action` で止める。止めている部品は `opacity: 0.5` と `cursor: not-allowed` で示す。新しい部品を足すとき: 見るだけの操作なら `data-view-ok` を付ける。操作部品でない要素(div や p)で書き換えを始めるものは `data-write-action` を付ける。キャンバスは移動・拡大縮小・選択・矢印キーでの移動ができ、ノードの移動・接続・切断・右クリックメニュー・貼り付け・削除はできない。上のバー(モデルの切り替え・設定)と鑑賞モードは従来どおり操作不可。データを守っているのはサーバー側(制作中の書き込みは 409)で、印の付け漏れがあっても作品は壊れない。
- 制作チャットの会話は、作者の発言を右寄せの吹き出し、制作側(読み取り・操作・報告)を時系列の線と丸で並べる(2026-10-13。それまでは全部が同じ枠付きのカードで、流れを追いにくかった)。項目は `index.css` の `timeline-item`(左 18px、線は `--border-strong` の 1px)と `timeline-dot`(9px の丸。`--bg-chat` の縁で線を切る)。見出しは `text-[11px]`・`--text-faint` で、左に種類、右端に時刻(`flex items-baseline gap-2`。時刻は `shrink-0 tabular-nums` で右に揃え、縦に追えるようにする。作者の吹き出しの見出しも同じ)、その下に中身。丸の色で種類を示す: 確定した操作は `--ok`(#3ecf8e。作品が実際に変わった印)、読み取りの手順は `--text-faint`、LLM の文章は `--text-dim`、途中指示の照合・作業メモの通知は `--accent`、失敗は `--danger`、生成中は点滅。読み取りの手順は「シーン本文を読む: シーン名」のように1行で出し、本文は出さない。AI が書いている途中の本文(未確定の編集案)も、時系列の末尾に点滅する `--accent` の丸の項目として出す(見出し「編集案を作成中: シーン名」、本文は `--text-dim` で高さ 320px まで・中でスクロールして末尾を追う)。確定・失敗・終了で消える。入力欄の上に別の箱として出さない(入力欄の位置が動くため)。操作の変更内容は `details` に折りたたむ。相談チャット(編集者との会話)は吹き出しのまま。成功・確定の色 `--ok` を `index.css` に定義した(直値 #3ecf8e を使っている既存箇所は順次寄せる)。
- 制作チャットの発言に添える送信時の条件は、既定でないときだけ出す。「変更範囲 / 保護」は、範囲を絞ったか保護があるときだけ(相談として送った発言には出さない。相談では使われないため)。「送信時の選択」は選択があるときだけ。実行として送った発言には、見出しの「あなた」の横に `--execute` の文字で「制作を実行」と付ける(相談と実行の発言が混ざるので、作品を書き換えた依頼が分かるようにする)。
- 制作チャットの発言欄は、スクロールバーを親の右の余白(16px)へ出し(`-mr-4`)、溝を常に確保したうえで発言との間を 6px 空ける(`pr-1.5`)。発言の右端は、スクロールの有無にかかわらず上のパネルや入力欄と揃う。
- 上のバーのサービスのボタン(TTS / ComfyUI。`ServiceBar`)は、停止中に「停止中」と書かない。稼働中はアクセント色の枠・背景・アイコン、停止中は名前だけを `--text-dim`・アイコンを `--text-faint` で示す。未導入・起動中・起動失敗は文字で出す(色だけでは対処の違いが伝わらないため)。
- 制作チャットの下の行の部品(使用量リング・送信モードの切り替え・↑ボタン)は高さ 26px に揃える。処理中の「停止」は、↑と同じ位置・同じ丸い形のまま中身を `Icon name="stop"` 12px に変える(枠 `--border-strong`・`--text-dim`、`aria-label="停止"`。文字のボタンに変えない)。ステータスバーの高さは `h-9`(36px。2026-10-13 に 28px から拡大)。右側のリソース表示(CPU / RAM / GPU / VRAM)は、文字 `text-[11px]`、バーは高さ 4px・幅 52px(同日に 10px・3px・40px から拡大)。
- 制作チャットの送信は、切り替え「相談する / 制作を実行」+ 丸い↑ボタン(`h-[26px] w-[26px] rounded-full border`、`Icon name="arrowUp"` 14px、`aria-label="送信"`、ツールチップでどちらとして送るかを示す)。既定は相談。実行は1回ごとに選び直す方式で、制作の実行が終わると(完了・停止・エラーのどれでも)自動で相談へ戻す。実行を選んでいる間は、切り替えの枠と選択側・入力欄の枠・↑ボタン(`execute-action`)を実行の色にし、入力欄の上に `--execute` の1行で「送信すると作品を編集する」ことを出す。相談のときは従来のアクセント色(`accent-action`)。下の行の「Enterで送信…」は `min-w-0 flex-1 basis-0 truncate` で省略表示にし、狭い幅でも↑ボタンを次の行へ落とさない。
- 制作の依頼候補は会話の末尾に最大3個、折り返しと6px間隔で置く。既存の chat-suggest-chip と丸型11pxボタンを用い、配色はアクセント背景・枠、補助文字色。ラベルに対象と操作を含め、長い名前は折り返す。クリックで入力欄へ依頼文を入れてフォーカスし、自動送信やモード変更はしない。入力済みでは無効化して理由をツールチップに表示する。

- 直前の回答がある場合、頻用する「この案で進めて」を制作候補の先頭に置く。最大3件の枠内で優先し、クリック後の入力・送信の扱いは他の候補と共通。

- 選択と章のレビュー候補は会話が空でも出す。シーン選択中は「選択中の…をレビュー」、選択が無く章カードを選択中または章の中を開いているときは「章「章名」をレビュー」を同じ枠に置く（両方は出さない）。依頼文には章名と章IDを含めて対象を固定する。

- 制作の章操作は「章を作成」「章名を変更」「章にシーンを追加」と履歴に表示し、詳細は「章の変更内容」とする。確定後の追従は構造画面の章一覧に切り替えて対象章カードを選択する。既存の追従オフと手動編集の制御に従う。
