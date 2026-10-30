import { useEffect, useRef } from 'react'

/** 入力欄の ↑ / ↓ で、この会話で前に送った文章を呼び出す(シェルのコマンド履歴と同じ)。
 *
 *  - 入力欄が空のときに ↑ で直前の送信文、続けて ↑ でさらに前へ。↓ で新しい方へ戻り、
 *    いちばん新しいものより先へ ↓ すると空に戻る
 *  - 文字を打っている途中(空でない)の ↑↓ は、通常のカーソル移動のまま(置き換えない)
 *  - 呼び出した文章を書き換えたら、そこで巡回は止まる(新しい下書きとして扱う)
 *  - 日本語変換中のキーは無視する
 *
 *  履歴は保存済みの会話の自分の発言(entries。古い順)をそのまま使う。別に保存しない
 *  (再起動後も会話を開けば呼び出せる。2026-10-15 ユーザー判断)。
 *  一時的に持つのは「履歴の何番目を見ているか」だけで、送信や会話の切り替え(entries の数の変化)で捨てる。
 */
export function useInputHistory(
  entries: string[],
  value: string,
  setValue: (value: string) => void
): { onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean } {
  // index = entries の位置(entries.length = 履歴の外 = 空)。shown = 呼び出して入力欄に入れた文章
  const state = useRef<{ index: number; shown: string } | null>(null)
  useEffect(() => {
    state.current = null
  }, [entries.length])

  /** 処理したら true(呼び出し側は何もしない)。false なら通常のキー操作に任せる */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
    const active = state.current !== null && state.current.shown === value
    if (!active) {
      // 空のときの ↑ だけが入口。打ちかけ・書き換えた文章の ↑↓ はカーソル移動
      if (value !== '' || event.key !== 'ArrowUp' || entries.length === 0) {
        state.current = null
        return false
      }
      state.current = { index: entries.length, shown: '' }
    }
    const current = state.current!
    const next = event.key === 'ArrowUp' ? current.index - 1 : current.index + 1
    event.preventDefault()
    if (next < 0) return true // いちばん古いものより前は無い
    if (next >= entries.length) {
      current.index = entries.length
      current.shown = ''
      setValue('')
    } else {
      current.index = next
      current.shown = entries[next]
      setValue(entries[next])
    }
    return true
  }
  return { onKeyDown }
}

/** 自分の発言から履歴(entries)を作る。空の発言は飛ばし、続けて同じ文を送ったものは 1 つにまとめる */
export function sentHistory(texts: Iterable<string>): string[] {
  const sent: string[] = []
  for (const text of texts) if (text.trim() && sent[sent.length - 1] !== text) sent.push(text)
  return sent
}

/** チャットの入力欄の Enter で送信する(Shift+Enter は改行。日本語変換の確定は素通しし、キーリピートでは送らない)。
 *  送信の Enter として扱ったら true */
export function submitOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
  event.preventDefault()
  if (!event.repeat) submit()
  return true
}
