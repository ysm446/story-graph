import { useEffect, useState } from 'react'
import { api, type ComfyStatus } from './api'
import { Icon } from './icons'

function SpinnerIcon(): React.JSX.Element {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-6.2-8.5" />
    </svg>
  )
}

function EjectIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5l7 10H5z" />
      <path d="M5 19h14" />
    </svg>
  )
}

/** ヘッダー右の ComfyUI(画像生成)の状態バー。ModelBar と同じ見た目・同じ約束:
 *  稼働中はアクセント枠 + 停止ボタン、起動中はスピナー + 時計まわりのリング、停止中はクリックで起動。
 *  画像生成の自動起動(ensure_running)で始まった起動もポーリングで拾う。 */
export default function ComfyBar(): React.JSX.Element {
  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async (): Promise<void> => {
      let interval = 5000
      try {
        const s = await api.comfyStatus()
        if (!cancelled) setStatus(s)
        if (s.loading) interval = 1500
      } catch {
        if (!cancelled) setStatus(null)
      }
      if (!cancelled) timer = setTimeout(() => void poll(), interval)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const healthy = status?.healthy === true
  const loading = starting || status?.loading === true
  const installed = status?.installed === true
  const hasError = !!error && !loading

  const handleStart = async (): Promise<void> => {
    setError(null)
    setStarting(true)
    try {
      await api.comfyStart()
      setStatus((s) => (s ? { ...s, healthy: true, spawned: true, loading: false } : s))
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    try {
      await api.comfyStop()
      setStatus((s) => (s ? { ...s, healthy: false, spawned: false, loading: false } : s))
    } catch {
      // 次のポーリングで状態が反映される
    }
  }

  const canStart = !healthy && !loading && (installed || !!status?.base_url)
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => {
          if (canStart) void handleStart()
        }}
        disabled={!canStart && !healthy}
        className={`flex min-w-[150px] items-center gap-2 rounded-lg border px-3 py-1 transition-colors ${loading ? 'node-busy-ring' : ''}`}
        style={{
          background: healthy ? 'var(--accent-soft)' : 'var(--bg-elevated)',
          borderColor: hasError ? 'var(--danger)' : healthy ? 'var(--accent-border-bright)' : 'var(--border-strong)',
          color: 'var(--text)',
          cursor: healthy ? 'default' : undefined,
          ...(loading
            ? ({
                '--sg-ring-inset': '3px',
                '--sg-ring-corner': '0.5rem',
                '--sg-ring-width': '2px',
                '--sg-ring-glow': '10px'
              } as React.CSSProperties)
            : null)
        }}
        data-tip={
          hasError
            ? error!
            : loading
              ? 'ComfyUI を起動しています'
              : healthy
                ? `ComfyUI 稼働中(${status?.base_url ?? ''})`
                : installed
                  ? 'クリックで ComfyUI を起動(画像生成時は自動でも起動します)'
                  : 'ComfyUI が未導入です。設定 →「画像生成」からインストールしてください'
        }
      >
        <span className="shrink-0" style={{ color: healthy ? 'var(--accent)' : 'var(--text-faint)' }}>
          {loading ? <SpinnerIcon /> : <Icon name="image" size={15} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-center text-[12.5px]" style={hasError ? { color: 'var(--danger)' } : undefined}>
          {loading ? '起動中… ComfyUI' : hasError ? '起動失敗' : healthy ? 'ComfyUI' : installed ? 'ComfyUI 停止中' : 'ComfyUI 未導入'}
        </span>
      </button>
      {healthy && !loading && (
        <button
          onClick={() => void handleStop()}
          className="rounded-lg border p-1.5 transition-colors"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          aria-label="ComfyUI を停止"
          data-tip="ComfyUI を停止(VRAM を解放)"
        >
          <EjectIcon />
        </button>
      )}
    </div>
  )
}
