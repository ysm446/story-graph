import { useEffect, useRef, useState, type ReactNode } from 'react'

const ASIDE_DEFAULT = 264
const ASIDE_MIN = 200
const ASIDE_MAX = 440

/**
 * シーン・章で共用する、幅を保存できる下段詳細の2列。
 * aside を渡すと3列(aside | secondary | main)になり、幅が足りないときは aside と secondary を
 * 左の1列に縦に重ねる(index.css の detail-three)。3列のときは aside の右の境界も動かせる(幅は px で保存)。
 */
export default function DetailSplit({ storageKey, main, secondary, aside, mainScrollRef, fillMain = false, wideMain = false, mainOnRight = false, defaultWidth = 42 }: {
  storageKey: string
  main: ReactNode
  secondary: ReactNode
  aside?: ReactNode
  mainScrollRef?: React.RefObject<HTMLDivElement | null>
  fillMain?: boolean
  /** 本文の列の中身を 80ch に絞らない(清書タブの挿絵 + 本文の 2 列のように、横に並べるもの) */
  wideMain?: boolean
  mainOnRight?: boolean
  defaultWidth?: number
}): React.JSX.Element {
  const three = aside !== undefined
  const onRight = mainOnRight || three
  const detailLayoutRef = useRef<HTMLDivElement>(null)
  const metaRef = useRef<HTMLDivElement>(null)
  const detailResizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => detailResizeCleanup.current?.(), [])
  const [metaWidth, setMetaWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return saved >= 25 && saved <= 65 ? saved : defaultWidth
  })
  const changeMetaWidth = (value: number): void => {
    const next = Math.max(25, Math.min(65, value))
    setMetaWidth(next)
    localStorage.setItem(storageKey, String(next))
  }
  // aside は挿絵と短い設定項目なので、割合ではなく px で持つ(パネルを広げても間延びさせない)
  const asideKey = `${storageKey}Aside`
  const [asideWidth, setAsideWidth] = useState(() => {
    const saved = Number(localStorage.getItem(asideKey))
    return saved >= ASIDE_MIN && saved <= ASIDE_MAX ? saved : ASIDE_DEFAULT
  })
  const changeAsideWidth = (value: number): void => {
    const next = Math.round(Math.max(ASIDE_MIN, Math.min(ASIDE_MAX, value)))
    setAsideWidth(next)
    localStorage.setItem(asideKey, String(next))
  }
  /** 境界のドラッグ。move にはポインタの位置が届く */
  const startResize = (event: React.PointerEvent, move: (pointer: PointerEvent) => void): void => {
    if (event.button !== 0) return
    event.preventDefault()
    detailResizeCleanup.current?.()
    const previousSelect = document.body.style.userSelect
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
  }
  return (
    <div ref={detailLayoutRef} className={`scene-detail-layout min-h-0 flex-1${three ? ' detail-three' : mainOnRight ? ' detail-main-right' : ''}`}
      style={{ '--detail-meta-width': `${metaWidth}%`, '--detail-aside-width': `${asideWidth}px` } as React.CSSProperties}>
      <div ref={mainScrollRef} className={`scene-detail-main inspector-scrollbar min-w-0 py-3 pl-5 pr-2.5${fillMain ? ' detail-fill' : ''}${wideMain ? ' detail-wide' : ''}`}>
        <div className="flex flex-col gap-3">{main}</div>
      </div>
        <div className="scene-detail-divider relative cursor-col-resize"
          role="separator" aria-label="詳細の左右の幅" aria-orientation="vertical"
          aria-valuemin={25} aria-valuemax={65} aria-valuenow={Math.round(metaWidth)}
          tabIndex={0} data-tip="ドラッグで左右の幅を変更（矢印キーでも調整できます）"
          style={{ background: 'var(--border)', touchAction: 'none' }}
          onPointerDown={(event) => startResize(event, (pointer) => {
            const rect = detailLayoutRef.current?.getBoundingClientRect()
            // 3列では aside の右から測る(動かすのは secondary の幅)
            const left = metaRef.current?.getBoundingClientRect().left ?? rect?.left ?? 0
            if (rect?.width) changeMetaWidth((onRight ? pointer.clientX - left : rect.right - pointer.clientX) / rect.width * 100)
          })}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            event.stopPropagation()
            changeMetaWidth(metaWidth + (event.key === 'ArrowLeft' ? 2 : -2) * (onRight ? -1 : 1))
          }}>
          <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
        </div>
      {three ? (
        <div className="scene-detail-side inspector-scrollbar">
          <div className="scene-detail-aside inspector-scrollbar min-w-0 py-4 pl-5 pr-2.5">
            <div className="flex flex-col gap-3">{aside}</div>
          </div>
          {/* 3列のときだけ縦の境界になる。縦に重なる幅では横線になり、操作は CSS で止める */}
          <div className="scene-detail-aside-divider"
            role="separator" aria-label="挿絵と設定の列の幅" aria-orientation="vertical"
            aria-valuemin={ASIDE_MIN} aria-valuemax={ASIDE_MAX} aria-valuenow={asideWidth}
            tabIndex={0} data-tip="ドラッグで左の列の幅を変更（矢印キーでも調整できます）"
            style={{ touchAction: 'none' }}
            onPointerDown={(event) => startResize(event, (pointer) => {
              const rect = detailLayoutRef.current?.getBoundingClientRect()
              if (rect) changeAsideWidth(pointer.clientX - rect.left)
            })}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              event.stopPropagation()
              changeAsideWidth(asideWidth + (event.key === 'ArrowLeft' ? -8 : 8))
            }}>
            <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
          </div>
          <div ref={metaRef} className="scene-detail-meta inspector-scrollbar min-w-0 py-4 pl-5 pr-2.5">
            <div className="flex flex-col gap-3">{secondary}</div>
          </div>
        </div>
      ) : (
        <div ref={metaRef} className={`scene-detail-meta inspector-scrollbar min-w-0 pl-5 pr-2.5 ${mainOnRight ? 'py-4' : 'py-3'}`}>
          <div className="flex flex-col gap-3">{secondary}</div>
        </div>
      )}
    </div>
  )
}
