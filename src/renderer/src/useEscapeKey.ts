import { useEffect } from 'react'

/** Escape で閉じる。ダイアログ・拡大表示で共用する。
 *
 *  exclusive = true は、ほかの Escape の処理(下にある画面のキー操作など)より先に受け取って止める形。
 *  入力欄で変換中(IME)の Escape は閉じる合図にしない。false は window に届いた Escape でそのまま閉じる。 */
export function useEscapeKey(onEscape: () => void, exclusive = false): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (exclusive) {
        if (e.isComposing) return
        e.stopPropagation()
      }
      onEscape()
    }
    window.addEventListener('keydown', onKey, exclusive)
    return () => window.removeEventListener('keydown', onKey, exclusive)
  }, [onEscape, exclusive])
}
