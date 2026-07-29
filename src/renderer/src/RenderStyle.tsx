import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Character, StylePreset } from './types'

/** 清書の条件(スタイルプリセット / POV / 本文フォント)を、鑑賞モードと
 *  構造モードの清書タブで共有するための部品。
 *
 *  選択はライブラリごとの settings(`reader_*`)に保存する。モードを切り替えても、
 *  どちらの画面から変えても同じ条件が使われる(= 同じ `renders` 行を指す)。
 */

// 本文フォント(ローカルにインストール済みのものが使われる。無ければ後続へフォールバック)
export const FONT_OPTIONS = [
  { id: 'sans', label: 'ゴシック(標準)', stack: '"Inter", "Segoe UI", "Noto Sans JP", system-ui, sans-serif' },
  {
    id: 'mincho',
    label: 'しっぽり明朝 / 明朝',
    stack: '"Shippori Mincho", "しっぽり明朝", "Yu Mincho", "游明朝", "Hiragino Mincho ProN", "MS PMincho", serif'
  },
  {
    id: 'serif',
    label: 'Reading Serif',
    stack: 'Georgia, "Times New Roman", "Yu Mincho", "游明朝", serif'
  }
] as const

export const FONT_SIZES = [
  { value: 13, label: '小' },
  { value: 14, label: '標準' },
  { value: 16, label: '中' },
  { value: 18, label: '大' },
  { value: 20, label: '特大' }
]

/** 1 シーンあたりの目安の字数。0 = 指定なし(モデルに任せる)。
 *  ここに無い値は「字数を指定」として数値入力で扱う */
export const LENGTH_PRESETS = [
  { value: 600, label: '短め(~600字)' },
  { value: 1200, label: '標準(~1200字)' },
  { value: 2000, label: '長め(~2000字)' }
]
const LENGTH_MIN = 100
const LENGTH_MAX = 5000

/** 字数の呼び名(「共通に従う」の補足表示などに使う) */
export function lengthLabel(chars: number): string {
  if (!chars) return 'おまかせ'
  return LENGTH_PRESETS.find((p) => p.value === chars)?.label ?? `${chars}字`
}

/** 目安の字数を選ぶプルダウン(+「字数を指定」の数値入力)。
 *
 *  共通の設定(鑑賞モードのバー)とシーン個別の指定(構造モードの清書タブ)で
 *  同じものを使う。違いは先頭の選択肢だけ:
 *  - 共通: 「おまかせ」(= 分量の指示をしない)
 *  - 個別: 「共通に従う」(= 共通の設定値を使う)
 *  どちらも内部表現は 0 なので、扱いは同じ。
 */
export function LengthSelect({
  value,
  onChange,
  zeroLabel,
  className = '',
  title
}: {
  value: number
  onChange: (chars: number) => void
  /** 0 のときの選択肢の文言 */
  zeroLabel: string
  className?: string
  title?: string
}): React.JSX.Element {
  const isCustom = value > 0 && !LENGTH_PRESETS.some((p) => p.value === value)
  const [customOpen, setCustomOpen] = useState(isCustom)
  const [customText, setCustomText] = useState(String(value || 1200))
  const showCustom = customOpen || isCustom
  // 別のシーンへ移ったときなど、外から値が変わったら入力欄も追従させる
  useEffect(() => {
    setCustomOpen(value > 0 && !LENGTH_PRESETS.some((p) => p.value === value))
    setCustomText(String(value || 1200))
  }, [value])

  const commit = (): void => {
    const parsed = Number(customText)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setCustomText(String(value || 1200))
      return
    }
    const clamped = Math.min(Math.max(Math.round(parsed), LENGTH_MIN), LENGTH_MAX)
    setCustomText(String(clamped))
    if (clamped !== value) onChange(clamped)
  }

  return (
    <>
      <select
        value={showCustom ? 'custom' : String(value)}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustomOpen(true)
            setCustomText(String(value || 1200))
            if (!value) onChange(1200)
            return
          }
          setCustomOpen(false)
          onChange(Number(e.target.value))
        }}
        className={`rounded-lg border px-2 py-1 text-[12px] ${className}`}
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
        title={title}
      >
        <option value={0}>{zeroLabel}</option>
        {LENGTH_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            分量: {p.label}
          </option>
        ))}
        <option value="custom">分量: 字数を指定…</option>
      </select>
      {showCustom && (
        <span className="flex shrink-0 items-center gap-1">
          <input
            type="number"
            value={customText}
            min={LENGTH_MIN}
            max={LENGTH_MAX}
            step={100}
            onChange={(e) => setCustomText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className="w-20 rounded-lg border px-2 py-1 text-[12px] tabular-nums outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            title={`${LENGTH_MIN}〜${LENGTH_MAX} 字`}
          />
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            字
          </span>
        </span>
      )}
    </>
  )
}

export interface RenderStyleState {
  presets: StylePreset[]
  preset: StylePreset | null
  presetId: string | null
  characters: Character[]
  povChar: string | null
  /** 1 シーンあたりの目安の字数(0 = 指定なし) */
  targetChars: number
  fontId: string
  fontSize: number
  /** fontId から解決した font-family */
  proseFont: string
  setPresetId: (id: string) => void
  setPovChar: (id: string | null) => void
  setTargetChars: (chars: number) => void
  setFontId: (id: string) => void
  setFontSize: (size: number) => void
  /** プリセットを取り直す。selectId を渡すとそれを選択して保存する */
  reloadPresets: (selectId?: string) => Promise<void>
}

export function useRenderStyle(): RenderStyleState {
  const [presets, setPresets] = useState<StylePreset[]>([])
  const [presetId, setPresetIdState] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [povChar, setPovCharState] = useState<string | null>(null)
  const [targetChars, setTargetCharsState] = useState<number>(0)
  const [fontId, setFontIdState] = useState<string>('sans')
  const [fontSize, setFontSizeState] = useState<number>(14)

  const reloadPresets = useCallback(async (selectId?: string): Promise<void> => {
    const p = await api.listPresets()
    setPresets(p)
    if (selectId) {
      setPresetIdState(selectId)
      void api.putSettings({ reader_preset_id: selectId })
    } else {
      setPresetIdState((prev) => (prev && p.some((x) => x.id === prev) ? prev : p[0]?.id ?? null))
    }
  }, [])

  useEffect(() => {
    void Promise.all([api.listPresets(), api.listCharacters(), api.getSettings()]).then(
      ([p, chars, settings]) => {
        setPresets(p)
        setCharacters(chars)
        // 前回の選択を復元(ライブラリごとの settings に保存)
        const savedPreset = settings.reader_preset_id
        setPresetIdState(savedPreset && p.some((x) => x.id === savedPreset) ? savedPreset : p[0]?.id ?? null)
        const savedPov = settings.reader_pov_char
        if (savedPov && chars.some((c) => c.id === savedPov)) setPovCharState(savedPov)
        const savedChars = Number(settings.reader_target_chars)
        if (Number.isFinite(savedChars) && savedChars > 0) setTargetCharsState(Math.round(savedChars))
        if (FONT_OPTIONS.some((f) => f.id === settings.reader_font)) setFontIdState(settings.reader_font)
        const savedSize = Number(settings.reader_font_size)
        if (FONT_SIZES.some((s) => s.value === savedSize)) setFontSizeState(savedSize)
      }
    )
  }, [])

  const setPresetId = useCallback((id: string): void => {
    setPresetIdState(id)
    void api.putSettings({ reader_preset_id: id })
  }, [])

  const setPovChar = useCallback((id: string | null): void => {
    setPovCharState(id)
    void api.putSettings({ reader_pov_char: id ?? '' })
  }, [])

  const setTargetChars = useCallback((chars: number): void => {
    setTargetCharsState(chars)
    void api.putSettings({ reader_target_chars: String(chars) })
  }, [])

  const setFontId = useCallback((id: string): void => {
    setFontIdState(id)
    void api.putSettings({ reader_font: id })
  }, [])

  const setFontSize = useCallback((size: number): void => {
    setFontSizeState(size)
    void api.putSettings({ reader_font_size: String(size) })
  }, [])

  return {
    presets,
    preset: presets.find((p) => p.id === presetId) ?? null,
    presetId,
    characters,
    povChar,
    targetChars,
    fontId,
    fontSize,
    proseFont: FONT_OPTIONS.find((f) => f.id === fontId)?.stack ?? FONT_OPTIONS[0].stack,
    setPresetId,
    setPovChar,
    setTargetChars,
    setFontId,
    setFontSize,
    reloadPresets
  }
}

interface PresetDraft {
  id?: string
  name: string
  person: string
  tone: string
}

function PresetEditorModal({
  draft,
  onClose,
  onSaved,
  onDeleted
}: {
  draft: PresetDraft
  onClose: () => void
  onSaved: (id: string) => void
  onDeleted: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<PresetDraft>(draft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

  const handleSave = async (): Promise<void> => {
    if (!form.name.trim()) {
      setError('名前を入力してください')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await api.upsertPreset({
        id: form.id,
        name: form.name.trim(),
        person: form.person,
        tone: form.tone
      })
      onSaved(saved.id)
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!form.id) return
    if (!window.confirm(`プリセット「${form.name}」を削除しますか?`)) return
    setBusy(true)
    try {
      await api.deletePreset(form.id)
      onDeleted()
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-2xl border p-5"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          {form.id ? 'スタイルプリセットを編集' : 'スタイルプリセットを新規作成'}
        </h3>
        <div className="mb-3 flex gap-2">
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="プリセット名"
            className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-[13px] outline-none"
            style={inputStyle}
          />
          <select
            value={form.person}
            onChange={(e) => setForm((f) => ({ ...f, person: e.target.value }))}
            className="rounded-lg border px-2 py-1.5 text-[13px]"
            style={inputStyle}
          >
            <option value="third">三人称</option>
            <option value="first">一人称(POV必須)</option>
          </select>
        </div>
        <label className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          システムプロンプト
        </label>
        <textarea
          rows={10}
          value={form.tone}
          onChange={(e) => setForm((f) => ({ ...f, tone: e.target.value }))}
          placeholder={
            'あなたはプロの小説家です。与えられたシーン(出来事の仕様書)を散文に仕上げます。\n背景や空気感の描写、人物の仕草と表情、会話の間を丁寧に肉付けしてください。\n硬質で乾いた文体。短いセンテンスを重ね、比喩は最小限に。'
          }
          className="mb-2 w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
          style={inputStyle}
        />
        <p className="mb-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          ここに書いた全文がそのままシステムプロンプトになります。末尾に「人称(POV 指定)」と厳守事項
          (シーンにある出来事以外を発生させない / POV キャラが知らない情報を書かない 等)だけが自動で追加されます。
        </p>
        {error && (
          <p className="mb-2 text-[12px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          {form.id && (
            <button onClick={() => void handleDelete()} disabled={busy} className="text-[12px]" style={{ color: 'var(--danger)' }}>
              削除
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-[13px]" style={{ color: 'var(--text-dim)' }}>
              キャンセル
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={busy}
              className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** スタイルプリセットと POV のプルダウン(+ プリセットの編集・新規)。
 *
 *  レイアウトは呼び出し側に任せるためフラグメントを返す。親は flex コンテナで包む。
 *  - `variant='full'`(鑑賞モード): プリセットの書き出し・読み込みも出す
 *  - `variant='compact'`(構造モードのインスペクタ): 幅が狭いので選択と編集だけ
 */
export function RenderStyleControls({
  style,
  variant = 'full',
  showLength = true,
  onStatus
}: {
  style: RenderStyleState
  variant?: 'full' | 'compact'
  /** 分量のプルダウンを出すか。構造モードの清書タブは**シーン個別**の分量を
   *  自前で出すので、共通のほうは畳む(同じ列に 2 つ並ぶと意味を取り違える) */
  showLength?: boolean
  onStatus?: (message: string) => void
}): React.JSX.Element {
  const [editor, setEditor] = useState<PresetDraft | null>(null)
  const importRef = useRef<HTMLInputElement | null>(null)
  const compact = variant === 'compact'

  const selectStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }
  const buttonClass = 'shrink-0 rounded-lg border px-2 py-1 text-[12px] disabled:opacity-40'
  const buttonStyle = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }

  const exportPresets = (): void => {
    const custom = style.presets.filter((p) => !p.builtin)
    if (custom.length === 0) {
      onStatus?.('書き出せるカスタムプリセットがありません(組み込みは対象外)')
      return
    }
    const payload = {
      kind: 'story-graph-style-presets',
      version: 1,
      presets: custom.map((p) => ({ name: p.name, person: p.person, tone: p.tone }))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'style-presets.json'
    a.click()
    URL.revokeObjectURL(url)
    onStatus?.(`${custom.length} 件のプリセットを書き出しました`)
  }

  const importPresets = async (file: File): Promise<void> => {
    try {
      const data = JSON.parse(await file.text())
      const list: unknown = Array.isArray(data) ? data : data?.presets
      if (!Array.isArray(list)) throw new Error('プリセット配列が見つかりません')
      let imported = 0
      let lastId: string | undefined
      for (const item of list as Array<Record<string, unknown>>) {
        const name = String(item?.name ?? '').trim()
        if (!name) continue
        // id は付けない(常に新規プリセットとして取り込み、既存・組み込みを壊さない)
        const saved = await api.upsertPreset({
          name,
          person: item?.person === 'first' ? 'first' : 'third',
          tone: String(item?.tone ?? '')
        })
        lastId = saved.id
        imported += 1
      }
      if (imported === 0) throw new Error('取り込めるプリセットがありませんでした')
      await style.reloadPresets(lastId)
      onStatus?.(`${imported} 件のプリセットを取り込みました`)
    } catch (e) {
      onStatus?.(`インポート失敗: ${String(e)}`)
    }
  }

  return (
    <>
      <select
        value={style.presetId ?? ''}
        onChange={(e) => style.setPresetId(e.target.value)}
        className={`rounded-lg border px-2 py-1 text-[12px] ${compact ? 'min-w-0 flex-1' : ''}`}
        style={selectStyle}
        title="スタイルプリセット(人称と文体)"
      >
        {style.presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          const current = style.preset
          if (!current) return
          if (current.builtin) {
            // 組み込みは編集不可 → 複製して新規プリセットとして開く
            setEditor({ name: `${current.name} のコピー`, person: current.person, tone: current.tone })
          } else {
            setEditor({ id: current.id, name: current.name, person: current.person, tone: current.tone })
          }
        }}
        disabled={!style.presetId}
        className={buttonClass}
        style={buttonStyle}
        title={
          style.preset?.builtin
            ? '組み込みプリセットは編集できません。複製して新規作成します'
            : '選択中のプリセットを編集'
        }
      >
        {style.preset?.builtin ? (compact ? '⧉' : '⧉ 複製して編集') : compact ? '✎' : '✎ 編集'}
      </button>
      <button
        onClick={() => setEditor({ name: '', person: 'third', tone: '' })}
        className={buttonClass}
        style={buttonStyle}
        title="スタイルプリセットを新規作成"
      >
        {compact ? '+' : '+ 新規'}
      </button>
      {!compact && (
        <>
          <button
            onClick={exportPresets}
            className={buttonClass}
            style={buttonStyle}
            title="カスタムのスタイルプリセット(散文用システムプロンプト)を JSON に書き出す"
          >
            ⬆ 書き出し
          </button>
          <button
            onClick={() => importRef.current?.click()}
            className={buttonClass}
            style={buttonStyle}
            title="JSON からスタイルプリセットを取り込む(新規プリセットとして追加)"
          >
            ⬇ 読み込み
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void importPresets(file)
            }}
          />
        </>
      )}
      <select
        value={style.povChar ?? ''}
        onChange={(e) => style.setPovChar(e.target.value || null)}
        className={`rounded-lg border px-2 py-1 text-[12px] ${compact ? 'min-w-0 flex-1 basis-40' : ''}`}
        style={selectStyle}
        title="視点キャラクター(そのキャラが知らないことは書かれない)"
      >
        <option value="">三人称(POVなし)</option>
        {style.characters.map((c) => (
          <option key={c.id} value={c.id}>
            POV: {c.name}
          </option>
        ))}
      </select>
      {showLength && (
        <LengthSelect
          value={style.targetChars}
          onChange={style.setTargetChars}
          zeroLabel="分量: おまかせ"
          className={compact ? 'min-w-0 flex-1 basis-40' : ''}
          title="全シーン共通の目安の字数。シーンごとの指定があればそちらが優先する"
        />
      )}
      {editor && (
        <PresetEditorModal
          draft={editor}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null)
            void style.reloadPresets(id)
          }}
          onDeleted={() => {
            setEditor(null)
            void style.reloadPresets()
          }}
        />
      )}
    </>
  )
}
