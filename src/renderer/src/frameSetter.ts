/** state の更新を 1 フレームに 1 回へ間引く setter を作る。
 *
 * SSE のストリーミングはトークンごとにイベントが来るので、そのまま setState すると
 * その回数だけ画面が描き直される(Markdown 変換も毎回)。最新の値だけを次の
 * animation frame で反映する。空文字('')は「消す」操作なので待たずに反映し、
 * 予約中の値も捨てる(消した直後に古い本文が戻らないように)。
 */
export function frameSetter(set: (value: string) => void): (value: string) => void {
  let frame = 0
  let latest = ''
  const apply = (): void => {
    frame = 0
    set(latest)
  }
  return (value: string): void => {
    latest = value
    if (value === '') {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      set('')
      return
    }
    if (frame === 0) frame = requestAnimationFrame(apply)
  }
}
