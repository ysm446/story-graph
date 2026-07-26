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

  const run = (): void => {
    if (!value.trim() || busy) return
    const range = selection ?? { start: 0, end: value.length }
    const target = value.slice(range.start, range.end)
    if (!target.trim()) return
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
  }

  const close = (): void => {
    abortRef.current?.abort()
    setResult(null)
  }

  const partialLabel = result && result.end - result.start < result.base.length ? '選択範囲' : '全文'

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
      {backup !== null && !result && (
        <button
          type="button"
          onClick={() => {
            onChange(backup)
            setBackup(null)
          }}
          className="absolute right-2 top-2 rounded-md border px-1.5 py-px text-[10px]"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          title="校正前の文章に戻す"
        >
          ↩ 元に戻す
        </button>
      )}
      {error && (
        <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {error}
        </span>
      )}
      {/* 校正結果のポップアップ */}
      {result && (
        <span
          className="absolute inset-x-0 top-0 z-20 block rounded-lg border p-2 shadow-xl shadow-black/50"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--accent-border)' }}
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
