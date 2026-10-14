import { useEffect, useState } from 'react'
import { api } from '../../api'

/** 埋め込みモデルのいまの状態(読み込み済みか)。読み込み中は 2 秒ごとに見直す。 */
export default function EmbeddingStatusLine(): React.JSX.Element {
  const [status, setStatus] = useState<{ state: 'ready' | 'loading' | 'failed' | 'idle'; model: string } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let stale = false
    let timer: number | undefined
    const check = (): void => {
      api
        .embeddingStatus()
        .then((next) => {
          if (stale) return
          setStatus(next)
          setFailed(false)
          if (next.state === 'loading') timer = window.setTimeout(check, 2000)
        })
        .catch(() => {
          if (!stale) setFailed(true)
        })
    }
    check()
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [])
  const text = failed
    ? '状態を取得できませんでした'
    : status === null
      ? '確認しています…'
      : {
          ready: '読み込み済み(検索に使われています)',
          loading: '読み込んでいます…',
          failed: '読み込みに失敗しました(検索は文字の一致だけで行われます。アプリを再起動すると、もう一度試します)',
          idle: 'まだ読み込んでいません(最初の検索のときに読み込みます)'
        }[status.state]
  const color = status?.state === 'ready' && !failed ? 'var(--ok)' : status?.state === 'failed' || failed ? 'var(--danger)' : 'var(--text-faint)'
  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">いまの状態</span>
        <span role="status" className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
          {text}
        </span>
      </div>
      {status && <p className="settings-field-hint">モデル: {status.model}</p>}
    </div>
  )
}
