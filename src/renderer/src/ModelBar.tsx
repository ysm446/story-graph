import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

interface ModelEntry {
  name: string
  path: string
  size: number
}

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/**
 * 上部バー中央のモデル選択バー(lm-graph 風)。
 * models/ フォルダのモデルを選び、llm_model_path 設定に保存する。
 * 左のドットは llama-server の稼働状態。実際のロードは生成時に自動で行われる。
 * refreshKey が変わると再取得する(設定ポップアップでモデルを変えたとき等の同期用)。
 */
export default function ModelBar({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [selected, setSelected] = useState<string>('') // path
  const [healthy, setHealthy] = useState<boolean | null>(null)

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

  const onChange = (path: string): void => {
    setSelected(path)
    void api.putSettings({ llm_model_path: path })
  }

  const modelName = (path: string): string =>
    models.find((m) => m.path === path)?.name ?? (path ? path.split(/[\\/]/).pop() ?? path : '')

  return (
    <div
      className="flex items-center gap-2 rounded-lg border px-2.5 py-1"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-strong)' }}
    >
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: healthy ? '#3ecf8e' : healthy === false ? 'var(--danger)' : '#8a8fa8' }}
        title={healthy ? 'モデル稼働中' : healthy === false ? 'モデル停止(生成時に自動起動)' : '状態を確認中…'}
      />
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[320px] rounded-md px-1 py-0.5 text-[12px] outline-none"
        style={{ background: 'var(--bg-input)', color: 'var(--text)' }}
        title="使用するモデル(models/ フォルダから選択)"
      >
        {models.length === 0 && <option value="">models/ に GGUF がありません</option>}
        {models.map((m) => (
          <option key={m.path} value={m.path}>
            {m.name}({fmtGb(m.size)})
          </option>
        ))}
        {selected && !models.some((m) => m.path === selected) && (
          <option value={selected}>{modelName(selected)}(外部パス)</option>
        )}
      </select>
    </div>
  )
}
