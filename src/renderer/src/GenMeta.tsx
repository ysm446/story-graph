import { useEffect } from 'react'
import type { ChatStats } from './api'
import { Icon } from './icons'

// LLM 生成のメタ情報(統計・送信内容)を見せる共有部品。
// もともと ChatDrawer 内の部品だったが、清書タブでも使うため切り出した。

/** ホバーで出るメッセージ操作アイコン(lm-chat の msg-action-btn を移植) */
export function MsgActionButton({
  kind,
  title,
  onClick
}: {
  kind: 'edit' | 'regenerate' | 'delete' | 'prompt'
  title: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded p-0.5 hover:bg-[var(--accent-soft)]"
      style={{ color: 'var(--text-faint)' }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === 'edit' && (
          <>
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </>
        )}
        {kind === 'regenerate' && (
          <>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
            <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
          </>
        )}
        {kind === 'delete' && (
          <>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </>
        )}
        {kind === 'prompt' && (
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </>
        )}
      </svg>
    </button>
  )
}

/** 生成統計の 1 行(lm-chat の qa-meta と同じ並び)。チャットの返事と清書で使う */
export function StatsLine({ stats }: { stats: ChatStats }): React.JSX.Element {
  const parts: React.JSX.Element[] = []
  const item = (key: string, icon: React.JSX.Element | null, text: string): React.JSX.Element => (
    <span key={key} className="inline-flex items-center gap-1">
      {icon}
      {text}
    </span>
  )
  if (stats.tokens_per_sec) {
    parts.push(item('speed', <Icon name="zap" size={11} />, `${stats.tokens_per_sec.toFixed(1)} tok/sec`))
  }
  if (stats.tokens) {
    parts.push(item('tokens', <Icon name="tokens" size={11} />, `${stats.tokens.toLocaleString()} tokens`))
  }
  if (stats.elapsed_sec) {
    parts.push(item('elapsed', <Icon name="clock" size={11} />, `${stats.elapsed_sec.toFixed(2)}s`))
  }
  if (stats.steps && stats.steps > 1) {
    parts.push(item('steps', <Icon name="tool" size={11} />, `${stats.steps} ステップ`))
  }
  if (stats.finish_reason) parts.push(item('finish', null, `Finish reason: ${stats.finish_reason}`))
  return (
    <div
      className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] tabular-nums"
      style={{ color: 'var(--text-faint)' }}
    >
      {parts.map((part, i) => (
        <span key={part.key} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  )
}

/** 生成時に LLM へ実際に送った内容(システムプロンプト + 履歴 + ツール結果)を
 *  見るモーダル(読み取り専用)。設定画面の「プロンプトログ」と同じ role ごとの
 *  表示で、チャットの返事や清書から直接開けるようにする */
export function SystemPromptModal({
  messages,
  onClose
}: {
  messages: Array<Record<string, unknown>>
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[720px] max-w-[92vw] flex-col rounded-2xl border p-5"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          生成に送った内容
        </h3>
        <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto">
          {messages.map((m, i) => {
            // assistant のツール呼び出しは content が無いことがあるので、呼び出し内容を行にして見せる
            const toolCalls =
              (m.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined) ?? []
            const lines = [
              ...(m.content ? [String(m.content)] : []),
              ...toolCalls.map((tc) => `→ ${tc.function?.name ?? ''}(${tc.function?.arguments ?? ''})`)
            ]
            return (
              <div key={i} className="mb-2">
                <div className="mb-0.5 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
                  {String(m.role ?? '')}
                </div>
                <pre
                  className="whitespace-pre-wrap rounded-md border p-2 font-mono text-[11px] leading-relaxed"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                >
                  {lines.join('\n')}
                </pre>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg border px-3 py-1 text-[12px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
