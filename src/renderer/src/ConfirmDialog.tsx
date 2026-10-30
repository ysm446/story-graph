import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

/** `window.confirm` / `window.alert` の代わりのアプリ内ダイアログ。
 *
 * ネイティブのダイアログは Electron(Windows)で、閉じたあと Web ページへキーボードの
 * フォーカスが戻らないことがある(入力欄にキャレットは出るのに文字が入らない。Alt+Tab で直る)。
 * ネイティブを出さなければ起きないので、確認・通知はすべてこれを使う(2026-10-30)。
 *
 * 呼ぶ側は `if (!(await askConfirm('…を削除しますか?', '削除'))) return` と書くだけ。ホストは `App` に 1 つだけ置く。
 * Enter で確定、Esc・地のクリックで取り消し。閉じたら開く前にフォーカスがあった要素へ戻す。
 */

type Request = {
  message: string
  confirmLabel: string
  /** false なら通知(閉じるだけ) */
  cancellable: boolean
  resolve: (ok: boolean) => void
}

const queue: Request[] = []
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const notify = (): void => listeners.forEach((listener) => listener())

function open(message: string, confirmLabel: string, cancellable: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ message, confirmLabel, cancellable, resolve })
    notify()
  })
}

/** 確認。確定なら true。文言は「〜しますか?」の問いで書き、改行で説明を足せる。
 *  confirmLabel は確定ボタンの文言で、何が起きるかの動詞(「削除」「戻す」など。スタイルガイド §7) */
export function askConfirm(message: string, confirmLabel: string): Promise<boolean> {
  return open(message, confirmLabel, true)
}

/** 通知。閉じたら解決する(待たなくてよい) */
export function showAlert(message: string): Promise<void> {
  return open(message, '閉じる', false).then(() => undefined)
}

export default function ConfirmDialogHost(): React.JSX.Element | null {
  const current = useSyncExternalStore(subscribe, () => queue[0] ?? null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<Element | null>(null)

  const close = (ok: boolean): void => {
    const req = queue.shift()
    if (!req) return
    req.resolve(ok)
    notify()
    if (queue.length === 0) {
      const back = returnFocusRef.current
      returnFocusRef.current = null
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
  }

  useEffect(() => {
    if (!current) return
    if (returnFocusRef.current === null) returnFocusRef.current = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      // 開いている間は下の画面のショートカット(Delete での削除、Esc で閉じるモーダルなど)へ
      // キーを渡さない。ネイティブの confirm が画面を止めていたのと同じにする。
      // Tab・Space などボタンの既定動作は止めない
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        close(false)
      } else if (e.key === 'Tab') {
        // フォーカスをダイアログのボタンの中で回す(下の画面へ出さない)
        const buttons = [...(dialogRef.current?.querySelectorAll('button') ?? [])]
        if (buttons.length === 0) return
        e.preventDefault()
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus()
      } else if (e.key === 'Enter' && !e.isComposing) {
        // Tab で「取り消し」へ移っていればそのボタンの既定動作(クリック)に任せる
        if (document.activeElement instanceof HTMLButtonElement && dialogRef.current?.contains(document.activeElement)) return
        e.preventDefault()
        close(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [current])

  if (!current) return null
  return createPortal(
    // 開いているモーダル(z-50)の上から出すことがあるので、その上に置く
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => close(false)}
    >
      <div
        ref={dialogRef}
        role={current.cancellable ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        className="w-[420px] max-w-[92vw] rounded-2xl border p-4 shadow-xl shadow-black/50"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed" style={{ color: 'var(--text)' }}>
          {current.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          {current.cancellable && (
            <button
              onClick={() => close(false)}
              className="rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            >
              取り消し
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={() => close(true)}
            className={current.cancellable
              ? 'rounded-md px-3 py-1 text-[12px] font-medium text-white'
              : 'rounded-md border px-2 py-0.5 text-[11px]'}
            style={current.cancellable
              ? { background: 'var(--accent)' }
              : { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
