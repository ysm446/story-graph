import { useLayoutEffect, useRef, useState } from 'react'

/** 右クリックメニューの 1 項目。
 *
 * 説明(`hint`)は行の下に常時出さず、ホバーのツールチップ(`data-tip`)に逃がす。
 * 項目が 15 を超えることがあり、2 行構成だとメニューが画面の半分を占めていたため
 * (2026-10-10 ユーザー要望)。無効な項目では押せない理由を `hint` に書く
 * (ツールチップは disabled でも読める。style-guide §4)。
 */
export type ContextMenuItem = {
  label: string
  /** ホバーで出す説明。無効なら押せない理由 */
  hint: string
  /** 行の右端に薄く出すキー(例: `Ctrl+C`) */
  shortcut?: string
  /** 区切り線のまとまり。前の項目と違う値なら間に線を引く */
  group: string
  disabled?: boolean
  run: () => void
}

const MARGIN = 8 // 画面端との余白

/** 右クリックメニュー。クリック座標に出し、画面の右端・下端にはみ出す分は内側へ寄せる。 */
export default function ContextMenu({
  x,
  y,
  heading,
  items,
  onPick
}: {
  x: number
  y: number
  /** 先頭の薄い見出し(何を選んでいるか) */
  heading: string
  items: ContextMenuItem[]
  /** 項目を押したとき(閉じるのは呼び出し側) */
  onPick: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  // 実寸を測ってから位置を決める。決まるまでは描くが見せない(位置が飛ぶのを防ぐ)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPos({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - MARGIN - box.width)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - MARGIN - box.height))
    })
  }, [x, y, items.length])

  return (
    <div
      ref={ref}
      role="menu"
      // 説明のツールチップは行の下ではなく右に出す(下に出すと次の行に被る)
      data-tip-side="right"
      className="fixed z-50 w-60 overflow-y-auto rounded-xl border py-1 text-[12px] shadow-xl shadow-black/50"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        maxHeight: window.innerHeight - MARGIN * 2,
        opacity: pos ? undefined : 0,
        background: 'var(--bg-card)',
        borderColor: 'var(--border-strong)'
      }}
    >
      <div className="px-3 py-1 text-[10px]" style={{ color: 'var(--text-faint)' }}>
        {heading}
      </div>
      {items.map((item, i) => (
        <div key={item.label}>
          {i > 0 && items[i - 1].group !== item.group && (
            <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />
          )}
          <button
            role="menuitem"
            onClick={() => {
              onPick()
              item.run()
            }}
            disabled={item.disabled ?? false}
            data-tip={item.hint}
            className={`flex w-full items-center gap-3 px-3 py-1.5 text-left disabled:opacity-40 ${item.group === 'danger' ? 'delete-action' : 'hover:bg-[var(--accent-soft)]'}`}
            style={item.group === 'danger' ? undefined : { color: 'var(--text)' }}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className="shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                {item.shortcut}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  )
}
