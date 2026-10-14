import { useEffect } from 'react'
import { showStatusNotice } from '../../statusNotice'
import { useStableCallback } from '../../useStableCallback'
import { isWriteLocked } from '../../writeLock'

/** Ctrl+S(mac は ⌘S)で、渡した保存ボタンと同じ保存を行う(章のまとめ)。
 *  シーンは下書きがシーンごとに残るので、StructureModeInner がまとめて保存する(saveSelectedDrafts)。
 *
 * 判断は保存ボタンに合わせる: ボタンが押せないとき(変更なし・保存中)と、制作中で書き換えを
 * 止めているときは何もしない。構造モードは資料庫・鑑賞の間も裏に残っているので、ボタンが
 * 画面に無い間は反応しない(詳細欄を畳んでいるだけなら保存する)。
 * 入力欄にフォーカスがあっても効く。run は保存できたら true を返す。
 */
export function useSaveShortcut(
  buttonRef: React.RefObject<HTMLButtonElement | null>,
  run: () => Promise<boolean>,
  savedNotice: string
): void {
  const save = useStableCallback(run)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 's' || event.isComposing) return
      const button = buttonRef.current
      if (!button || button.getClientRects().length === 0) return
      event.preventDefault()
      if (event.repeat || button.disabled || isWriteLocked(button)) return
      void save().then((ok) => {
        if (ok) showStatusNotice(savedNotice)
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [buttonRef, save, savedNotice])
}
