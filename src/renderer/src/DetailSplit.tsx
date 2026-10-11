import { useEffect, useRef, useState, type ReactNode } from 'react'

/** シーン・章で共用する、幅を保存できる下段詳細の2列。 */
export default function DetailSplit({ storageKey, main, secondary }: {
  storageKey: string
  main: ReactNode
  secondary: ReactNode
}): React.JSX.Element {
  const detailLayoutRef = useRef<HTMLDivElement>(null)
  const detailResizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => detailResizeCleanup.current?.(), [])
  const [metaWidth, setMetaWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return saved >= 25 && saved <= 65 ? saved : 42
  })
  const changeMetaWidth = (value: number): void => {
    const next = Math.max(25, Math.min(65, value))
    setMetaWidth(next)
    localStorage.setItem(storageKey, String(next))
  }
  return (
    <div ref={detailLayoutRef} className="scene-detail-layout min-h-0 flex-1"
      style={{ '--detail-meta-width': `${metaWidth}%` } as React.CSSProperties}>
      <div className="scene-detail-main inspector-scrollbar min-w-0 p-3">
        <div className="flex flex-col gap-3">{main}</div>
      </div>
        <div className="scene-detail-divider relative cursor-col-resize"
          role="separator" aria-label="詳細の左右の幅" aria-orientation="vertical"
          aria-valuemin={25} aria-valuemax={65} aria-valuenow={Math.round(metaWidth)}
          tabIndex={0} data-tip="ドラッグで左右の幅を変更（矢印キーでも調整できます）"
          style={{ background: 'var(--border)', touchAction: 'none' }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            detailResizeCleanup.current?.()
            const previousSelect = document.body.style.userSelect
            const move = (pointer: PointerEvent): void => {
              const rect = detailLayoutRef.current?.getBoundingClientRect()
              if (rect?.width) changeMetaWidth((rect.right - pointer.clientX) / rect.width * 100)
            }
            const cleanup = (): void => {
              document.body.style.userSelect = previousSelect
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', cleanup)
              window.removeEventListener('pointercancel', cleanup)
              detailResizeCleanup.current = null
            }
            detailResizeCleanup.current = cleanup
            document.body.style.userSelect = 'none'
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', cleanup)
            window.addEventListener('pointercancel', cleanup)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            event.stopPropagation()
            changeMetaWidth(metaWidth + (event.key === 'ArrowLeft' ? 2 : -2))
          }}>
          <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
        </div>
      <div className="scene-detail-meta inspector-scrollbar min-w-0 p-3">
        <div className="flex flex-col gap-3">{secondary}</div>
      </div>
    </div>
  )
}
