import { useEffect, useState } from 'react'
import { assetUrl, type GeneratedImage } from './api'

/** 生成した画像の候補と seed の操作(場面の挿絵 / キャラの参照画像で共用)。
 *
 *  生成しても即決定にはしない。プレビューを見て「決定」で採用、気に入らなければ
 *  seed を変えて(-1 でランダム、数値を直接入れて再現)もう一度生成する。 */
export function SeedField({
  seed,
  onChange,
  disabled
}: {
  /** null = ランダム。欄には -1 と表示する(ComfyUI などの慣例) */
  seed: number | null
  onChange: (seed: number | null) => void
  disabled: boolean
}): React.JSX.Element {
  // 入力中は文字列のまま持つ(消した瞬間に -1 へ戻ると打ち直せない)。blur / Enter で解釈する
  const [text, setText] = useState(String(seed ?? -1))
  useEffect(() => {
    setText(String(seed ?? -1))
  }, [seed])
  const commit = (): void => {
    const n = Number(text.trim())
    if (text.trim() === '' || !Number.isFinite(n) || n < 0) {
      onChange(null)
      setText('-1')
      return
    }
    onChange(Math.floor(n))
  }
  return (
    <label className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
      seed
      <input
        value={text}
        inputMode="numeric"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="w-36 rounded-md border px-2 py-0.5 text-[11px] tabular-nums outline-none disabled:opacity-50"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
        data-tip="-1 でランダム。同じ seed と同じプロンプトで同じ絵になります"
      />
      <button
        onClick={() => {
          onChange(null)
          setText('-1')
        }}
        disabled={disabled || seed === null}
        className="rounded-md border px-1.5 py-0.5 text-[11px] disabled:opacity-40"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        data-tip="seed を -1(ランダム)に戻す"
        aria-label="seed を -1 に"
      >
        🎲
      </button>
    </label>
  )
}

export function CandidatePreview({
  candidate,
  aspect
}: {
  candidate: GeneratedImage | null
  /** プレビュー枠の縦横比(CSS の aspect-ratio。場面は横長、参照画像は縦長) */
  aspect: string
}): React.JSX.Element {
  const url = assetUrl(candidate?.image_path)
  return (
    <div
      className="flex w-full items-center justify-center overflow-hidden rounded-xl border"
      style={{ aspectRatio: aspect, background: 'var(--bg-canvas)', borderColor: 'var(--border)', maxHeight: '48vh' }}
    >
      {url ? (
        <img src={url} className="h-full w-full object-contain" />
      ) : (
        <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          生成するとここにプレビューが出ます
        </span>
      )}
    </div>
  )
}
