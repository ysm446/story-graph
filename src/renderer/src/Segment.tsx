import type { ReactNode } from 'react'

export type SegmentOption<T> = { value: T; label: ReactNode; tip?: string }

export const ON_OFF: SegmentOption<boolean>[] = [
  { value: true, label: 'オン' },
  { value: false, label: 'オフ' }
]

export const SHOW_HIDE: SegmentOption<boolean>[] = [
  { value: true, label: '表示' },
  { value: false, label: '非表示' }
]

/** セグメント(オン/オフ、モード切替)。外枠 1 本の中にボタンを並べ、選択中だけ --accent-soft を敷く。
 *  大きさは buttonClassName で変える(既定はスタイルガイド §4 の型)。 */
export function Segment<T extends string | boolean>({
  options,
  value,
  onChange,
  disabled = false,
  buttonClassName = 'px-2.5 py-0.5 text-[12px]'
}: {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  buttonClassName?: string
}) {
  return (
    <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          aria-pressed={value === option.value}
          className={buttonClassName}
          style={value === option.value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
          data-tip={option.tip}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
