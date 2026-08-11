import { useCallback, useEffect, useRef } from 'react'

/** 内容に合わせて縦幅が伸びる textarea(中でスクロールさせない)。
 *
 *  ビートタブの「感情の核」と同じ方式で、置き場所の幅の変化でも測り直す。
 *  空のときの高さは `minRows`(rows 属性)で決まるので、プレースホルダが
 *  複数行の欄では行数を渡す。
 */
export default function AutoTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  minRows = 1,
  className,
  style
}: {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  minRows?: number
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const autosize = useCallback((): void => {
    const el = ref.current
    if (!el) return
    // height:auto に戻すと rows 属性の高さになるので、scrollHeight は
    // 「内容の高さ」と「minRows の高さ」の大きい方になる
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [])

  useEffect(() => autosize(), [value, autosize])

  // 折り返しが変わると必要な高さも変わるので、幅の変化でも再計算する
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth
        autosize()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [autosize])

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={className}
      style={{ ...style, overflow: 'hidden', resize: 'none' }}
    />
  )
}
