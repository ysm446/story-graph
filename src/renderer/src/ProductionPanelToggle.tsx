/** 制作チャットの上段の行に並べる、条件パネル(指示 / 作業メモ / 変更範囲)の開閉ボタン。
 *
 * 以前は 1 つずつ折りたたみ枠(details)で縦に積んでいて、閉じていても 3 段ぶん高さを取っていた。
 * 中身は panelBodyClass の枠で、行(flex-wrap)の中で order-1 + basis-full にしてボタンの並びの下に全幅で開く。
 * 同時に開くのは 1 つだけ(開閉の状態は ProductionChat が持つ)。
 */
export default function ProductionPanelToggle({ open, onToggle, tip, highlight = false, children }: {
  open: boolean
  onToggle: () => void
  tip: string
  /** 既定でない条件(範囲を絞った・保護がある・未保存)のとき、閉じていても目に入るようにする */
  highlight?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return <button type="button" aria-expanded={open} onClick={onToggle} data-tip={tip}
    className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]"
    style={{
      borderColor: highlight ? 'var(--accent-border)' : 'var(--border-strong)',
      ...(open ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: highlight ? 'var(--text)' : 'var(--text-dim)' })
    }}>
    {children}
    <span aria-hidden className="text-[9px]" style={{ color: 'var(--text-faint)' }}>{open ? '▴' : '▾'}</span>
  </button>
}

/** 開いた中身の枠(以前の折りたたみ枠と同じ型)。上段の行の中で、ボタンの並びの下へ全幅で置く */
export const panelBodyClass = 'order-1 basis-full rounded-lg border px-3 py-2 text-[12px]'
export const panelBodyStyle: React.CSSProperties = { borderColor: 'var(--border)', background: 'var(--bg-elevated)' }
