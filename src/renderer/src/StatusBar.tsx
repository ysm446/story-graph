import { useEffect, useState } from 'react'
import { api } from './api'

interface SystemResources {
  cpu_usage: number
  ram_used: number
  ram_total: number
  gpu_usage: number | null
  vram_used: number | null
  vram_total: number | null
}

// lm-graph の SystemResourceMonitor と同じ見た目のミニバー
function ResourceBar({ label, pct, detail }: { label: string; pct: number; detail: string }): React.JSX.Element {
  const clampedPct = Math.min(100, Math.max(0, pct))
  const barColor = clampedPct > 85 ? '#ef4444' : clampedPct > 65 ? '#f97316' : 'var(--accent)'
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-medium opacity-50">{label}</span>
      <div className="h-[3px] w-10 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${clampedPct}%`, backgroundColor: barColor }}
        />
      </div>
      <span className="text-[10px] tabular-nums opacity-60">{detail}</span>
    </div>
  )
}

function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

export default function StatusBar({ backendReady }: { backendReady: boolean }): React.JSX.Element {
  const [res, setRes] = useState<SystemResources | null>(null)
  const [llmLabel, setLlmLabel] = useState<string | null>(null)

  useEffect(() => {
    if (!backendReady) return
    let cancelled = false
    const pollResources = async (): Promise<void> => {
      try {
        const r = await api.systemResources()
        if (!cancelled) setRes(r)
      } catch {
        if (!cancelled) setRes(null)
      }
    }
    const pollLlm = async (): Promise<void> => {
      try {
        const s = await api.llmStatus()
        if (cancelled) return
        if (s.healthy) {
          const model = s.model_path?.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '')
          setLlmLabel(model ?? '外部 llama-server')
        } else {
          setLlmLabel(null)
        }
      } catch {
        if (!cancelled) setLlmLabel(null)
      }
    }
    void pollResources()
    void pollLlm()
    const resTimer = setInterval(() => void pollResources(), 2000)
    const llmTimer = setInterval(() => void pollLlm(), 5000)
    return () => {
      cancelled = true
      clearInterval(resTimer)
      clearInterval(llmTimer)
    }
  }, [backendReady])

  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-3 border-t px-3"
      style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)', color: 'var(--text)' }}
    >
      <span className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-faint)' }}>
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: llmLabel ? '#3ecf8e' : '#5c6078' }}
        />
        {llmLabel ? `LLM: ${llmLabel}` : 'LLM 停止中'}
      </span>
      <div className="ml-auto flex items-center gap-3">
        {res && (
          <>
            <ResourceBar label="CPU" pct={res.cpu_usage} detail={`${res.cpu_usage}%`} />
            <ResourceBar
              label="RAM"
              pct={(res.ram_used / res.ram_total) * 100}
              detail={`${fmtBytes(res.ram_used)} / ${fmtBytes(res.ram_total)}`}
            />
            {res.gpu_usage !== null && (
              <ResourceBar label="GPU" pct={res.gpu_usage} detail={`${res.gpu_usage}%`} />
            )}
            {res.vram_used !== null && res.vram_total !== null && (
              <ResourceBar
                label="VRAM"
                pct={(res.vram_used / res.vram_total) * 100}
                detail={`${fmtBytes(res.vram_used)} / ${fmtBytes(res.vram_total)}`}
              />
            )}
          </>
        )}
      </div>
    </footer>
  )
}
