import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

interface ModelEntry {
  name: string
  path: string
  size: number
}

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** ファイル名から量子化ラベル(Q6_K, Q4_K_M, IQ4_XS 等)を抽出 */
function quantLabel(name: string): string | null {
  const m = name.match(/(?:^|[-_ ])((?:IQ|Q)\d(?:_[A-Z0-9]+)*)(?:$|[-_ .])/i)
  return m ? m[1].toUpperCase() : null
}

/** ファイル名からパラメータ規模(27B, 1.5B 等)を抽出 */
function paramLabel(name: string): string | null {
  const m = name.match(/(\d+(?:\.\d+)?)\s*[Bb](?:[-_ .]|$)/)
  return m ? `${m[1]}B` : null
}

/** パスの親フォルダ名(models 直下なら 'models/') */
function parentDir(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : 'models'
}

function CpuIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  )
}

function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

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

function ModelModal({
  models,
  selected,
  loadingPath,
  error,
  onSelect,
  onClose
}: {
  models: ModelEntry[]
  selected: string
  loadingPath: string | null
  error: string | null
  onSelect: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const busy = loadingPath !== null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-xl rounded-2xl border p-4 shadow-2xl"
        style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
            モデルを選択
          </span>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[13px] disabled:opacity-40"
            style={{ color: 'var(--text-dim)' }}
          >
            閉じる
          </button>
        </div>
        {models.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-8 text-center text-[12px]" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}>
            models/ フォルダに GGUF がありません。
          </div>
        ) : (
          <div className="inspector-scrollbar max-h-[360px] space-y-1 overflow-y-auto pr-1">
            {models.map((m) => {
              const active = m.path === selected
              const isLoading = m.path === loadingPath
              const quant = quantLabel(m.name)
              const param = paramLabel(m.name)
              return (
                <button
                  key={m.path}
                  onClick={() => onSelect(m.path)}
                  disabled={busy}
                  className="flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed"
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    borderColor: active ? 'var(--accent-border)' : 'var(--border)',
                    opacity: busy && !isLoading ? 0.5 : 1
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12.5px] font-medium" style={{ color: 'var(--text)' }}>
                      {m.name}
                    </div>
                    <div className="truncate text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                      {parentDir(m.path)}
                    </div>
                  </div>
                  {isLoading ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px]" style={{ color: 'var(--accent)' }}>
                      <SpinnerIcon />
                      読み込み中…
                    </span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                      {param && (
                        <span className="rounded px-1.5 py-0.5" style={{ background: 'var(--bg-elevated)' }}>
                          {param}
                        </span>
                      )}
                      {quant && (
                        <span className="rounded px-1.5 py-0.5" style={{ background: 'var(--bg-elevated)' }}>
                          {quant}
                        </span>
                      )}
                      <span className="tabular-nums">{fmtGb(m.size)}</span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
        {error ? (
          <p className="mt-3 text-[11px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        ) : (
          <p className="mt-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            選択するとモデルの読み込みを開始します(数分かかることがあります)。
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * 上部バー中央のモデル選択バー(lm-graph 風)。
 * ボタンを押すとモーダルでモデルを選べる。選択は llm_model_path 設定に保存する。
 * 左のドットは llama-server の稼働状態。refreshKey が変わると再取得する。
 */
export default function ModelBar({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [selected, setSelected] = useState<string>('') // path
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [r, settings] = await Promise.all([api.listModels(), api.getSettings()])
      setModels(r.models)
      setSelected(settings.llm_model_path || r.current || '')
    } catch {
      setModels([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const s = await api.llmStatus()
        if (!cancelled) setHealthy(s.healthy)
      } catch {
        if (!cancelled) setHealthy(false)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const currentName = models.find((m) => m.path === selected)?.name ?? (selected ? selected.split(/[\\/]/).pop() ?? '' : '')
  const switching = loadingPath !== null

  const handleSelect = async (path: string): Promise<void> => {
    // 即モーダルを閉じ、バー上でバックグラウンドにロードする(他の作業を続けられる)
    setError(null)
    setSelected(path) // 楽観的に選択名を表示
    setLoadingPath(path)
    setOpen(false)
    try {
      await api.putSettings({ llm_model_path: path })
      await api.llmLoad()
      setHealthy(true)
    } catch (e) {
      setHealthy(false)
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setLoadingPath(null)
    }
  }

  const handleEject = async (): Promise<void> => {
    try {
      await api.llmStop()
      setHealthy(false)
    } catch {
      // 停止失敗は無視(次のポーリングで状態が反映される)
    }
  }

  // 読み込み済みはアクセント枠で示す(赤ドットは廃止)
  const active = healthy === true
  const hasError = !!error && !switching
  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => {
            if (switching) return
            setError(null)
            void load()
            setOpen(true)
          }}
          className={`flex min-w-[220px] max-w-[420px] items-center gap-2 rounded-lg border px-3 py-1 transition-colors ${switching ? 'node-busy-ring' : ''}`}
          style={{
            background: active ? 'var(--accent-soft)' : 'var(--bg-elevated)',
            borderColor: hasError ? 'var(--danger)' : active ? 'var(--accent-border)' : 'var(--border-strong)',
            color: 'var(--text)',
            // 読み込み中のリング(ノードと同じ時計まわりの光)。バーは小さいので細めにする
            ...(switching
              ? ({
                  '--sg-ring-inset': '3px',
                  '--sg-ring-corner': '0.5rem', // rounded-lg
                  '--sg-ring-width': '2px',
                  '--sg-ring-glow': '10px'
                } as React.CSSProperties)
              : null)
          }}
          title={hasError ? error! : 'モデルを選択'}
        >
          <span className="shrink-0" style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}>
            {switching ? <SpinnerIcon /> : <CpuIcon />}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-center text-[12.5px]"
            style={hasError ? { color: 'var(--danger)' } : undefined}
          >
            {switching
              ? `読み込み中… ${currentName}`
              : hasError
                ? '読み込み失敗'
                : active
                  ? currentName || 'モデルを選択してください'
                  : selected
                    ? 'モデルをロードしてください'
                    : 'モデルを選択してください'}
          </span>
          <span className="shrink-0" style={{ color: 'var(--text-faint)' }}>
            <ChevronDownIcon />
          </span>
        </button>
        {active && !switching && (
          <button
            onClick={() => void handleEject()}
            className="rounded-lg border p-1.5 transition-colors"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            title="モデルをアンロード(停止)"
          >
            <EjectIcon />
          </button>
        )}
      </div>
      {open && (
        <ModelModal
          models={models}
          selected={selected}
          loadingPath={loadingPath}
          error={error}
          onSelect={(p) => void handleSelect(p)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
