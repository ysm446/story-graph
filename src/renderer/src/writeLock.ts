/**
 * 制作チャットの LLM が動いている間の「書き換えだけを止める」ロック。
 *
 * 以前は画面の領域ごとに inert を付けて、見るだけの操作(スクロール・選択・タブ切り替え)まで
 * 止めていた。ここでは領域に `data-write-locked="true"` を付け、その中の「書き換えにつながる
 * 操作部品」への入力だけを捨てる。見るための部品には `data-view-ok` を付けて通す。
 *
 * - 止める部品: button / input / textarea / select / contenteditable と、`data-write-action` を付けた要素
 * - 通す部品: `data-view-ok` の中にあるもの(タブ、一覧の行、シーンへ移動するリンクなど)
 * - 近いほうの印が勝つ(view-ok の一覧の中にある「追加」ボタンに write-action を付ければ止まる)
 *
 * データを守っているのはサーバー側(制作中の書き込みは 409 で拒否)。ここは、押せないものを
 * 押せないと分かるようにする画面側の層で、印の付け漏れがあっても作品が壊れることはない。
 */

const REGION = '[data-write-locked="true"]'
const CONTROL = 'button, input, textarea, select, [contenteditable="true"], [data-write-action]'
const MARK = '[data-view-ok], [data-write-action]'

/** その要素への操作を止めるべきか(ロック中の領域にある書き換え用の部品か)。 */
export function isWriteLocked(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const region = target.closest(REGION)
  if (!region) return false
  const control = target.closest(CONTROL)
  if (!control || !region.contains(control)) return false
  // 近いほうの印で決める。印が無ければ、操作部品は止める
  const mark = target.closest(MARK)
  if (mark && region.contains(mark)) return mark.hasAttribute('data-write-action')
  return true
}

/** アプリの起動時に一度だけ呼ぶ。document の capture で拾うので、React のハンドラより先に止まる。 */
export function installWriteLockGuard(): () => void {
  const block = (event: Event): void => {
    if (!isWriteLocked(event.target)) return
    event.preventDefault()
    event.stopPropagation()
  }
  // マウスで押せなくても Tab で入れてしまうので、フォーカスも外す
  const unfocus = (event: FocusEvent): void => {
    if (isWriteLocked(event.target) && event.target instanceof HTMLElement) event.target.blur()
  }
  // 貼り付け・ドロップは、対象が操作部品でなくても領域の中なら止める(画像のドロップ枠など)
  const blockInRegion = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.closest(REGION)) return
    event.preventDefault()
    event.stopPropagation()
  }
  // input も止める: 変換(IME)の入力は beforeinput で取り消せないことがあるので、入っても React の状態へは届かせない
  const blocked = ['click', 'dblclick', 'mousedown', 'pointerdown', 'keydown', 'keypress', 'beforeinput', 'input', 'change'] as const
  for (const type of blocked) document.addEventListener(type, block, true)
  document.addEventListener('focusin', unfocus, true)
  document.addEventListener('paste', blockInRegion, true)
  document.addEventListener('drop', blockInRegion, true)
  return () => {
    for (const type of blocked) document.removeEventListener(type, block, true)
    document.removeEventListener('focusin', unfocus, true)
    document.removeEventListener('paste', blockInRegion, true)
    document.removeEventListener('drop', blockInRegion, true)
  }
}
