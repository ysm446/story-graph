import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** アプリ共通のツールチップ。
 *
 * ネイティブの `title` は見た目を変えられず、出るまでの間も約 1 秒で固定されるうえ、
 * **無効なボタンでは出ない**(disabled はイベントを出さないので、押せない理由がいちばん
 * 読みたいときに読めない)。そこで自前に置き換えた。呼ぶ側は `data-tip="…"` を書くだけ。
 *
 * 軽さのための作り(2026-08-14):
 * - ホストは `App` に **1 つだけ**置く。購読するリスナも document 1 本だけで、
 *   ボタン側に state もエフェクトも増えない(= 再レンダーが増えない)
 * - ポップアップの DOM は**出ている間だけ** portal に 1 個作る
 * - hit-test は {@link MOVE_INTERVAL} で間引く。`pointerover` の委譲ではなく座標から
 *   引くのは、disabled のボタンがイベントを出さないため(それだと拾えない)
 *
 * 改行で複数行、行頭 `・` は箇条書きとして字下げして折り返す。
 */

const OPEN_DELAY = 400 // 出るまでの間(ネイティブの約 1 秒より短め)
const REOPEN_DELAY = 80 // 既に出ているとき隣のボタンへ移ったら素早く出す
const MOVE_INTERVAL = 60 // hit-test の間引き(ms)
const GAP = 8 // アンカーとの隙間
const MARGIN = 8 // 画面端との余白
const MAX_WIDTH = 340

type Anchor = { text: string; rect: DOMRect }

export default function TooltipHost(): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  // 実測して決めた最終位置。決まるまでは描くが見せない(位置が飛ぶのを防ぐ)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<Element | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trailingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMoveRef = useRef(0)
  const lastPointRef = useRef({ x: 0, y: 0 })
  const shownRef = useRef(false)

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const hide = (): void => {
      clearTimer()
      targetRef.current = null
      shownRef.current = false
      setAnchor(null)
      setPos(null)
    }

    const hitTest = (x: number, y: number): void => {
      const hit = document.elementFromPoint(x, y)
      const el = hit?.closest<HTMLElement>('[data-tip]') ?? null
      if (el === targetRef.current) return
      targetRef.current = el
      clearTimer()
      const text = el?.dataset.tip
      if (!el || !text) {
        if (shownRef.current) hide()
        return
      }
      timerRef.current = setTimeout(
        () => {
          // 待っている間にボタンが消えた(タスク完了などで DOM が変わった)ら出さない。
          // 外れた要素の rect は (0,0) の 0×0 になり、画面の左上に出てしまう
          if (!el.isConnected) {
            targetRef.current = null
            return
          }
          shownRef.current = true
          setPos(null)
          setAnchor({ text, rect: el.getBoundingClientRect() })
        },
        shownRef.current ? REOPEN_DELAY : OPEN_DELAY
      )
    }

    const onMove = (e: PointerEvent): void => {
      lastPointRef.current = { x: e.clientX, y: e.clientY }
      const now = performance.now()
      const wait = MOVE_INTERVAL - (now - lastMoveRef.current)
      if (wait > 0) {
        // 間引きで捨てた**最後の 1 発**は遅延して実行する。捨てたままだと、
        // 止まった位置と違うボタンの文が出たり、離れたのに消え残ったりする
        if (trailingRef.current == null) {
          trailingRef.current = setTimeout(() => {
            trailingRef.current = null
            lastMoveRef.current = performance.now()
            hitTest(lastPointRef.current.x, lastPointRef.current.y)
          }, wait)
        }
        return
      }
      lastMoveRef.current = now
      hitTest(e.clientX, e.clientY)
    }

    // 押した / 巻いた / 打った / 窓から出た ときは引っ込める。スクロールは capture で
    // 拾う(構造モードのインスペクタなど内側の要素が動いてもアンカーがずれるため)
    document.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('wheel', hide, { capture: true, passive: true })
    document.addEventListener('scroll', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('mouseleave', hide) // カーソルがウィンドウの外へ出た
    window.addEventListener('blur', hide)
    return () => {
      clearTimer()
      if (trailingRef.current) clearTimeout(trailingRef.current)
      trailingRef.current = null
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('wheel', hide, true)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('mouseleave', hide)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // 実寸を測ってから位置を決める(下に入らなければ上へ回し、左右は画面内に寄せる)
  useLayoutEffect(() => {
    if (!anchor || !boxRef.current) return
    const box = boxRef.current.getBoundingClientRect()
    const r = anchor.rect
    let top = r.bottom + GAP
    if (top + box.height > window.innerHeight - MARGIN) {
      const above = r.top - GAP - box.height
      top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - MARGIN - box.height)
    }
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - MARGIN - box.width))
    setPos({ left, top })
  }, [anchor])

  if (!anchor) return null

  return createPortal(
    <div
      ref={boxRef}
      role="tooltip"
      // z-50 はモーダル・ポップオーバーが使うので、その上に出るよう z-[100]
      className="pointer-events-none fixed z-[100] rounded-xl border px-3 py-2 text-[11px] leading-relaxed shadow-lg shadow-black/40"
      style={{
        background: 'var(--bg-card)',
        borderColor: 'var(--border-strong)',
        color: 'var(--text)',
        maxWidth: MAX_WIDTH,
        left: pos?.left ?? anchor.rect.left,
        top: pos?.top ?? anchor.rect.bottom + GAP,
        // 位置が決まるまでは見せない(1 フレームだけ左上に出るのを防ぐ)
        opacity: pos ? undefined : 0,
        animation: pos ? 'tip-in 0.12s ease' : undefined
      }}
    >
      {anchor.text.split('\n').map((line, i) =>
        line === '' ? (
          <div key={i} className="h-1.5" />
        ) : line.startsWith('・') ? (
          <div key={i} style={{ paddingLeft: 12, textIndent: -12, color: 'var(--text-dim)' }}>
            {line}
          </div>
        ) : (
          <div key={i}>{line}</div>
        )
      )}
    </div>,
    document.body
  )
}
