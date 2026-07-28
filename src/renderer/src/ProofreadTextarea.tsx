import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isAbortError, proofreadStream } from './api'
import { useElapsedSeconds } from './useElapsed'

/** 校正つきテキストエリア(アプリ共通)。
 *
 * - 内容に合わせて高さが伸びる(rows は最小の高さとして効く)
 * - テキストを選択すると「✎ 校正」ボタンが出る。選択がなければ全文が対象
 * - 結果はポップアップにストリーミング表示し、「置換」で本文に反映する
 *   (反映後は「↩ 元に戻す」で校正前に戻せる)
 *
 * 校正プリセットの選択は localStorage('proofreadPreset')でアプリ全体で共有する。
 */
export default function ProofreadTextarea({
  value,
  onChange,
  rows = 3,
  placeholder,
  className = '',
  style,
  withContext = false,
  disabled = false
}: {
  value: string
  onChange: (next: string) => void
  rows?: number
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  /** 選択範囲の前後を文脈として LLM に渡す(長文の一部を直すときに使う) */
  withContext?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([])
  const [presetId, setPresetId] = useState(() => localStorage.getItem('proofreadPreset') ?? 'standard')
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const elapsed = useElapsedSeconds(busy)
  const [error, setError] = useState<string | null>(null)
  const [backup, setBackup] = useState<string | null>(null)
  // 選択範囲の上端・下端(px)。ポップアップをこれに重ねないように置く
  const [anchor, setAnchor] = useState<{ top: number; bottom: number } | null>(null)
  const popupRef = useRef<HTMLSpanElement | null>(null)
  const [popupHeight, setPopupHeight] = useState(0)
  // 校正結果。base はリクエスト時点の全文(座標ズレを防ぐため)
  const [result, setResult] = useState<{
    value: string
    base: string
    start: number
    end: number
    done: boolean
  } | null>(null)

  useEffect(() => {
    void api
      .listProofreadPresets()
      .then((list) => setPresets(list.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setPresets([]))
  }, [])

  const autosize = useCallback((): void => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [])

  useEffect(() => {
    autosize()
  }, [value, autosize])

  // 幅が変わると折り返しが変わるので、幅の変化でも再計算する
  useEffect(() => {
    const el = areaRef.current
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

  const syncSelection = (): void => {
    const el = areaRef.current
    if (!el) return
    const { selectionStart: start, selectionEnd: end } = el
    setSelection(end > start && value.slice(start, end).trim() !== '' ? { start, end } : null)
  }

  /** 選択範囲が何 px 目の行にあるかを測る(ポップアップを重ねないため)。
   *
   * textarea は中の座標を教えてくれないので、同じ幅・フォント・行間の隠し要素に
   * 同じテキストを流し込んで、目印の位置を読む(定番のミラー方式)。
   */
  const measureSelection = (range: { start: number; end: number }): { top: number; bottom: number } | null => {
    const el = areaRef.current
    if (!el) return null
    const style = window.getComputedStyle(el)
    const mirror = document.createElement('div')
    for (const prop of [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderTopWidth',
      'borderLeftWidth',
      'textIndent',
      'whiteSpace',
      'wordBreak',
      'overflowWrap'
    ] as const) {
      mirror.style[prop] = style[prop]
    }
    mirror.style.position = 'absolute'
    mirror.style.visibility = 'hidden'
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.wordBreak = 'break-word'
    mirror.style.width = `${el.clientWidth}px`
    document.body.appendChild(mirror)
    const markerAt = (index: number): number => {
      mirror.textContent = value.slice(0, index)
      const marker = document.createElement('span')
      marker.textContent = '​'
      mirror.appendChild(marker)
      return marker.offsetTop
    }
    const top = markerAt(range.start)
    const endTop = markerAt(range.end)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
    document.body.removeChild(mirror)
    return { top, bottom: endTop + lineHeight }
  }

  const run = (): void => {
    if (!value.trim() || busy) return
    const range = selection ?? { start: 0, end: value.length }
    const target = value.slice(range.start, range.end)
    if (!target.trim()) return
    setAnchor(selection ? measureSelection(range) : null)
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    setResult({ value: '', base: value, start: range.start, end: range.end, done: false })
    const partial = withContext && selection !== null
    void proofreadStream(
      {
        text: target,
        preset_id: presetId,
        context_before: partial ? value.slice(0, range.start) : '',
        context_after: partial ? value.slice(range.end) : ''
      },
      (e) => {
        if (e.delta) {
          setResult((c) => (c ? { ...c, value: c.value + e.delta } : c))
        } else if (e.done) {
          const corrected = (e.value ?? '').trim()
          if (!corrected || corrected === target) {
            setResult(null)
            setError('直すところは見つかりませんでした')
          } else {
            setResult((c) => (c ? { ...c, value: corrected, done: true } : c))
          }
        } else if (e.error) {
          setError(e.error)
          setResult(null)
        }
      },
      controller.signal
    )
      .catch((e) => {
        if (!isAbortError(e)) setError(String(e))
        setResult(null)
      })
      .finally(() => {
        abortRef.current = null
        setBusy(false)
      })
  }

  const apply = (): void => {
    if (!result?.done) return
    setBackup(result.base)
    onChange(result.base.slice(0, result.start) + result.value + result.base.slice(result.end))
    setResult(null)
    setSelection(null)
    setAnchor(null)
  }

  const close = (): void => {
    abortRef.current?.abort()
    setResult(null)
    setAnchor(null)
  }

  const partialLabel = result && result.end - result.start < result.base.length ? '選択範囲' : '全文'

  // ポップアップの位置。選択範囲の下に置き、テキストエリアの下端を超えるなら
  // 選択範囲の上へ回す(選択中のテキストには重ねない)
  const areaHeight = areaRef.current?.offsetHeight ?? 0
  const popupTop = ((): number => {
    if (!anchor) return 0 // 全文校正のときは上端(隠すテキストが特にない)
    const below = anchor.bottom + 6
    if (popupHeight === 0 || below + popupHeight <= areaHeight) return below
    const above = anchor.top - popupHeight - 6
    return above >= 0 ? above : below // 上にも入らなければ下へ(はみ出しは許容)
  })()

  useEffect(() => {
    if (!result) {
      setPopupHeight(0)
      return
    }
    const height = popupRef.current?.offsetHeight ?? 0
    if (height !== popupHeight) setPopupHeight(height)
  }, [result, popupHeight])

  return (
    <span className="relative block">
      <textarea
        ref={areaRef}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onSelect={syncSelection}
        onKeyUp={syncSelection}
        onMouseUp={syncSelection}
        className={`w-full resize-none overflow-hidden rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none ${className}`}
        style={style}
      />
      {/* 選択中に出る校正ボタン(選択が無いときは全文校正として使える) */}
      {selection && !result && !busy && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()} // 選択を保ったまま押せるように
          onClick={run}
          className="absolute bottom-2 right-2 rounded-md border px-2 py-0.5 text-[11px] shadow-lg shadow-black/30"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
          title="選択した範囲を校正する"
        >
          ✎ 校正
        </button>
      )}
      {/* 本文に重ねると 1 行目が読めなくなるので、テキストエリアの下に出す */}
      {backup !== null && !result && (
        <span className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => {
              onChange(backup)
              setBackup(null)
            }}
            className="rounded-md border px-1.5 py-px text-[10px]"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
            title="校正前の文章に戻す"
          >
            ↩ 元に戻す
          </button>
        </span>
      )}
      {error && (
        <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {error}
        </span>
      )}
      {/* 校正結果のポップアップ */}
      {result && (
        <span
          ref={popupRef}
          className="absolute inset-x-0 z-20 block rounded-lg border p-2 shadow-xl shadow-black/50"
          style={{ top: popupTop, background: 'var(--bg-card)', borderColor: 'var(--accent-border)' }}
        >
          <span className="mb-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-faint)' }}>
            <span>校正結果({partialLabel})</span>
            <select
              value={presetId}
              onChange={(e) => {
                setPresetId(e.target.value)
                localStorage.setItem('proofreadPreset', e.target.value)
              }}
              disabled={busy}
              className="rounded-md border px-1 py-px text-[10px]"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
              title="校正のプリセット(変更後にもう一度校正すると反映されます)"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
          <span
            className="inspector-scrollbar block max-h-56 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed"
            style={{ color: 'var(--text)' }}
          >
            {result.value}
            {!busy && !result.done && '…'}
            {busy && (
              <span
                className="ml-0.5 inline-block h-3 w-1 align-middle"
                style={{ background: 'var(--accent)' }}
              />
            )}
          </span>
          <span className="mt-1.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md px-2 py-0.5 text-[11px]"
              style={{ color: 'var(--text-dim)' }}
            >
              {busy ? `■ 中止 (${elapsed}s)` : '閉じる'}
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!result.done}
              className="rounded-md px-3 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              置換
            </button>
          </span>
        </span>
      )}
    </span>
  )
}
