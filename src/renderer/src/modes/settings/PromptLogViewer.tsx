import { useEffect, useState } from 'react'
import { api } from '../../api'

interface PromptLogEntry {
  id: number
  time: string
  label: string
  messages: Array<{ role: string; content: string }>
  temperature: number
  max_tokens: number
  response: string | null
  finish_reason: string | null
  usage: { prompt_tokens?: number; completion_tokens?: number } | null
  error: string | null
}

export default function PromptLogViewer(): React.JSX.Element {
  const [logs, setLogs] = useState<PromptLogEntry[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setLogs(await api.debugPrompts())
    } catch {
      setLogs([])
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">直近の LLM 送信プロンプト({logs.length}件)</span>
        <button
          onClick={() => void reload()}
          className="rounded-md border px-2 py-0.5 text-[11px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        >
          ⟳ 更新
        </button>
      </div>
      {logs.length === 0 && (
        <p className="settings-field-hint">まだ記録がありません。シーン生成や清書を実行すると、ここに実際のプロンプトが表示されます。</p>
      )}
      {logs.map((entry) => {
        const expanded = expandedId === entry.id
        const time = new Date(entry.time).toLocaleTimeString('ja-JP')
        return (
          <div
            key={entry.id}
            className="rounded-lg border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <button
              onClick={() => setExpandedId(expanded ? null : entry.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]"
            >
              <span style={{ color: 'var(--text)' }}>{entry.label}</span>
              {entry.error && <span style={{ color: 'var(--danger-text)' }}>エラー</span>}
              <span className="ml-auto tabular-nums" style={{ color: 'var(--text-faint)' }}>
                {time} / T={entry.temperature}
                {entry.usage?.prompt_tokens !== undefined &&
                  ` / in ${entry.usage.prompt_tokens} out ${entry.usage.completion_tokens ?? '?'}`}
              </span>
              <span style={{ color: 'var(--text-faint)' }}>{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded && (
              <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                {entry.messages.map((m, i) => (
                  <div key={i} className="mb-2">
                    <div className="mb-0.5 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                      {m.role}
                    </div>
                    <pre
                      className="inspector-scrollbar max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border p-2 font-mono text-[11px] leading-relaxed"
                      style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                    >
                      {m.content}
                    </pre>
                  </div>
                ))}
                {entry.response !== null && entry.response !== '' && (
                  <div className="mb-1">
                    <div className="mb-0.5 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                      response{entry.finish_reason ? `(${entry.finish_reason})` : ''}
                    </div>
                    <pre
                      className="inspector-scrollbar max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border p-2 font-mono text-[11px] leading-relaxed"
                      style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                    >
                      {entry.response}
                    </pre>
                  </div>
                )}
                {entry.error && (
                  <p className="text-[12px]" style={{ color: 'var(--danger-text)' }}>
                    {entry.error}
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
