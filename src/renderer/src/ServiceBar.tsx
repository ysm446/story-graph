import { useEffect, useState } from 'react'
import { Icon, type IconName } from './icons'

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

/** ServiceBar が見る状態(/comfy/status・/tts/status の共通部分) */
export interface ServiceStatus {
  healthy: boolean
  loading: boolean
  installed: boolean
  base_url: string
  /** 応答しているが自分で起動していない(外部で起動済み)。止めるボタンを出さない */
  external?: boolean
}

function sameStatus(a: ServiceStatus, b: ServiceStatus): boolean {
  return (
    a.healthy === b.healthy &&
    a.loading === b.loading &&
    a.installed === b.installed &&
    a.base_url === b.base_url &&
    a.external === b.external
  )
}

/** ヘッダー右の外部サービス(ComfyUI / TTS)の状態バー。ModelBar と同じ見た目・同じ約束:
 *  稼働中はアクセント枠 + 停止ボタン、起動中はスピナー + 時計まわりのリング、停止中はクリックで起動。
 *  生成・読み上げの自動起動で始まった起動もポーリングで拾う。 */
export default function ServiceBar({
  name,
  tooltipName = name,
  icon,
  fetchStatus,
  start,
  stop,
  startTip,
  notInstalledTip
}: {
  /** 表示名(ComfyUI / TTS) */
  name: string
  /** ツールチップ用の詳細名。省略時は表示名と同じ */
  tooltipName?: string
  icon: IconName
  fetchStatus: () => Promise<ServiceStatus>
  start: () => Promise<unknown>
  stop: () => Promise<unknown>
  /** 停止中の tip(クリックで起動、に続く補足) */
  startTip: string
  notInstalledTip: string
}): React.JSX.Element {
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async (): Promise<void> => {
      let interval = 5000
      // ウィンドウが隠れている間は問い合わせない(戻ったときに visibilitychange で再開)
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), interval)
        return
      }
      try {
        const s = await fetchStatus()
        // 中身が同じなら state を触らない(毎回新しいオブジェクトを入れると 5 秒ごとに描き直す)
        if (!cancelled) setStatus((prev) => (prev && sameStatus(prev, s) ? prev : s))
        if (s.loading) interval = 1500
      } catch {
        if (!cancelled) setStatus(null)
      }
      if (!cancelled) timer = setTimeout(() => void poll(), interval)
    }
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || cancelled) return
      if (timer) clearTimeout(timer)
      void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchStatus])

  const healthy = status?.healthy === true
  const loading = starting || status?.loading === true
  const installed = status?.installed === true
  const hasError = !!error && !loading

  const handleStart = async (): Promise<void> => {
    setError(null)
    setStarting(true)
    try {
      await start()
      setStatus((s) => (s ? { ...s, healthy: true, loading: false } : s))
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    try {
      await stop()
      setStatus((s) => (s ? { ...s, healthy: false, loading: false } : s))
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
              ? `${tooltipName} を起動しています`
              : healthy
                ? `${tooltipName} 稼働中(${status?.base_url ?? ''})${status?.external ? '。外部で起動したものなので、ここからは止めません' : ''}`
                : installed
                  ? `クリックで ${tooltipName} を起動(${startTip})`
                  : notInstalledTip
        }
      >
        <span className="shrink-0" style={{ color: healthy ? 'var(--accent)' : 'var(--text-faint)' }}>
          {loading ? <SpinnerIcon /> : <Icon name={icon} size={15} />}
        </span>
        {/* 停止中は「停止中」と書かない。アイコンと枠・文字の色(稼働中はアクセント、停止中は淡色)で分かる。
            未導入は、押しても起動できず対処(インストール)が違うので文字で示す */}
        <span className="min-w-0 flex-auto truncate text-center text-[12.5px]"
          style={hasError ? { color: 'var(--danger)' } : !healthy && !loading ? { color: 'var(--text-dim)' } : undefined}>
          {loading ? `起動中… ${name}` : hasError ? '起動失敗' : healthy || installed ? name : `${name} 未導入`}
        </span>
        {/* 左のアイコンと同じ幅の空きを右にも取り、文字をボタン全体の中央に置く(無いとアイコンの分だけ右へ寄って見える)。
            文字が収まらないときは、この空きが先に縮む */}
        <span aria-hidden className="w-[15px] shrink-[9999]" />
      </button>
      {healthy && !loading && !status?.external && (
        <button
          onClick={() => void handleStop()}
          className="rounded-lg border p-1.5 transition-colors"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          aria-label={`${name} を停止`}
          data-tip={`${tooltipName} を停止(VRAM を解放)`}
        >
          <EjectIcon />
        </button>
      )}
    </div>
  )
}
