import { useEffect, useState } from 'react'
import { api } from './api'
import { useTasks } from './tasks'

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

function elapsedLabel(now: number, startedAt: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

export default function StatusBar({ backendReady }: { backendReady: boolean }): React.JSX.Element {
  const [res, setRes] = useState<SystemResources | null>(null)
  const tasks = useTasks()
  const [now, setNow] = useState(() => Date.now())

  // 経過時間の表示用。処理が無いときは動かさない
  useEffect(() => {
    if (tasks.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [tasks.length])

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
    void pollResources()
    const resTimer = setInterval(() => void pollResources(), 2000)
    return () => {
      cancelled = true
      clearInterval(resTimer)
    }
  }, [backendReady])

  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-3 border-t px-3"
      style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)', color: 'var(--text)' }}
    >
      {/* 走っている処理(ページを移動しても消えない) */}
      <div className="flex min-w-0 items-center gap-3">
        {tasks.map((t) => (
          <span key={t.id} className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            <span className="shrink-0" style={{ color: 'var(--text-dim)' }}>
              {t.label}
              {t.total ? ` ${t.done ?? 0}/${t.total}` : ''}
            </span>
            {t.detail && (
              <span className="min-w-0 truncate" style={{ color: 'var(--text-faint)' }}>
                {t.detail}
              </span>
            )}
            <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
              {elapsedLabel(now, t.startedAt)}
            </span>
            {t.abort && (
              <button
                onClick={t.abort}
                className="shrink-0 rounded border px-1"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                title="この処理を中止する"
              >
                ■
              </button>
            )}
          </span>
        ))}
      </div>
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
