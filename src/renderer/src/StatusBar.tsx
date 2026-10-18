import { useEffect, useState } from 'react'
import { api } from './api'
import { cancelTask, useTasks } from './tasks'
import { useStatusNotice } from './statusNotice'
import { Icon } from './icons'

interface SystemResources {
  cpu_usage: number
  ram_used: number
  ram_total: number
  gpu_usage: number | null
  vram_used: number | null
  vram_total: number | null
}

function sameResources(a: SystemResources, b: SystemResources): boolean {
  return (
    a.cpu_usage === b.cpu_usage &&
    a.ram_used === b.ram_used &&
    a.ram_total === b.ram_total &&
    a.gpu_usage === b.gpu_usage &&
    a.vram_used === b.vram_used &&
    a.vram_total === b.vram_total
  )
}

// lm-graph の SystemResourceMonitor と同じ見た目のミニバー
function ResourceBar({ label, pct, detail }: { label: string; pct: number; detail: string }): React.JSX.Element {
  const clampedPct = Math.min(100, Math.max(0, pct))
  // 閾値はコンテキスト使用量のリングと同じ(70% で警告、90% で危険)
  const barColor = clampedPct >= 90 ? 'var(--danger)' : clampedPct >= 70 ? 'var(--warn)' : 'var(--accent)'
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium" style={{ color: 'var(--text-faint)' }}>{label}</span>
      <div className="h-1 w-[52px] overflow-hidden rounded-full" style={{ background: 'var(--border-strong)' }}>
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${clampedPct}%`, backgroundColor: barColor }}
        />
      </div>
      <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-dim)' }}>{detail}</span>
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

export default function StatusBar({
  backendReady,
  selectedCount = 0
}: {
  backendReady: boolean
  /** 構造モードで範囲選択しているシーン数(2 件以上のときだけ表示する) */
  selectedCount?: number
}): React.JSX.Element {
  const [res, setRes] = useState<SystemResources | null>(null)
  // リソース表示(CPU / RAM / GPU / VRAM)を出すか。右端のアイコンで切り替え、覚えておく
  const [resourcesVisible, setResourcesVisible] = useState(() => {
    try {
      return localStorage.getItem('statusResourcesVisible') !== '0'
    } catch {
      return true
    }
  })
  const toggleResources = (): void => {
    setResourcesVisible((v) => {
      try {
        localStorage.setItem('statusResourcesVisible', v ? '0' : '1')
      } catch {
        // 保存できなくても表示の切り替えはする
      }
      return !v
    })
  }
  const tasks = useTasks()
  const notice = useStatusNotice()
  const [now, setNow] = useState(() => Date.now())
  const [queueOpen, setQueueOpen] = useState(false)
  const running = tasks.find((t) => t.status === 'running') ?? null
  const pending = tasks.filter((t) => t.status === 'pending')

  // 経過時間の表示用。処理が無いときは動かさない
  useEffect(() => {
    if (tasks.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [tasks.length])

  // 待機がなくなったら一覧は閉じる
  useEffect(() => {
    if (pending.length === 0) setQueueOpen(false)
  }, [pending.length])

  useEffect(() => {
    if (!backendReady || !resourcesVisible) return // 隠している間は問い合わせもしない
    let cancelled = false
    const pollResources = async (): Promise<void> => {
      // ウィンドウが隠れている間は問い合わせない
      if (document.visibilityState === 'hidden') return
      try {
        const r = await api.systemResources()
        // 値が同じなら state を触らない(2 秒ごとの描き直しを避ける)
        if (!cancelled) setRes((prev) => (prev && sameResources(prev, r) ? prev : r))
      } catch {
        if (!cancelled) setRes(null)
      }
    }
    void pollResources()
    const resTimer = setInterval(() => void pollResources(), 2000)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void pollResources()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(resTimer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [backendReady, resourcesVisible])

  return (
    <footer
      className="flex h-9 shrink-0 items-center gap-3 border-t px-3"
      style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)', color: 'var(--text)' }}
    >
      {/* 処理キュー(ページを移動しても消えない。実行は 1 件ずつ) */}
      <div className="relative flex min-w-0 items-center gap-2">
        {running && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            <span className="shrink-0" style={{ color: 'var(--text-dim)' }}>
              {running.label}
              {running.total ? ` ${running.done ?? 0}/${running.total}` : ''}
            </span>
            {running.detail && (
              <span className="min-w-0 truncate" style={{ color: 'var(--text-faint)' }}>
                {running.detail}
              </span>
            )}
            <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
              {elapsedLabel(now, running.startedAt ?? running.enqueuedAt)}
            </span>
            <button
              onClick={() => cancelTask(running.id)}
              className="shrink-0 rounded border px-1"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
              aria-label="この処理を中止する"
              data-tip="この処理を中止する"
            >
              ■
            </button>
          </span>
        )}
        {pending.length > 0 && (
          <>
            <button
              onClick={() => setQueueOpen((v) => !v)}
              className="shrink-0 rounded border px-1.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
              data-tip="待機中の処理(クリックで一覧)"
            >
              待機 {pending.length} {queueOpen ? '▾' : '▴'}
            </button>
            {queueOpen && (
              <div
                className="absolute bottom-full left-0 z-30 mb-1 w-72 overflow-hidden rounded-lg border py-1 shadow-xl shadow-black/50"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
              >
                {pending.map((t, i) => (
                  <div key={t.id} className="flex items-center gap-2 px-2 py-1 text-[11px]">
                    <span className="shrink-0" style={{ color: 'var(--text-faint)' }}>
                      {i + 1}.
                    </span>
                    <span className="shrink-0" style={{ color: 'var(--text-dim)' }}>
                      {t.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-faint)' }}>
                      {t.detail ?? (t.total ? `${t.total} 件` : '')}
                    </span>
                    <button
                      onClick={() => cancelTask(t.id)}
                      className="shrink-0 rounded border px-1"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                      aria-label="キューから取り消す"
                      data-tip="キューから取り消す"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {/* 範囲選択の状態。1 件はインスペクタが映しているので 2 件以上のときだけ出す */}
      {notice && (
        <span role="status" className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-dim)' }} data-tip={notice}>
          {notice}
        </span>
      )}
      {selectedCount >= 2 && (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px]">
          <span style={{ color: 'var(--accent)' }}>{selectedCount} シーンを選択中</span>
          <span style={{ color: 'var(--text-faint)' }}>・右クリックで一括操作</span>
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        {resourcesVisible && res && (
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
        {/* 右端のトグル。開いている間は会話一覧ボタンと同じオンの見た目(--accent-soft + --text) */}
        <button
          onClick={toggleResources}
          aria-pressed={resourcesVisible}
          aria-label="システムリソースの表示"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border hover:bg-[var(--accent-soft)]"
          style={
            resourcesVisible
              ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
              : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
          }
          data-tip={resourcesVisible ? 'CPU / RAM / GPU / VRAM の表示を隠す' : 'CPU / RAM / GPU / VRAM を表示'}
        >
          <Icon name="activity" size={13} />
        </button>
      </div>
    </footer>
  )
}
