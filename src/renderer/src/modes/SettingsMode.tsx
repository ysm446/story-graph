import { useEffect, useState } from 'react'
import { api } from '../api'

const SETTING_DEFS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'llm_base_url', label: 'LLM エンドポイント (llama.cpp server)', placeholder: 'http://127.0.0.1:8080' },
  {
    key: 'llm_model_path',
    label: 'モデルパス (GGUF)',
    placeholder: 'D:\\GitHub\\story-graph\\models\\gemma-4-31B-it-GGUF\\gemma-4-31B-it-Q6_K.gguf'
  },
  {
    key: 'llama_server_path',
    label: 'llama-server.exe のパス',
    placeholder: 'D:\\GitHub\\lm-graph\\bin\\llama-server\\b9496-win-cuda13-x64\\llama-server.exe'
  },
  { key: 'llm_ctx_size', label: 'コンテキストサイズ (--ctx-size)', placeholder: '16384' }
]

interface LlmStatus {
  base_url: string
  healthy: boolean
  spawned: boolean
  model_path: string | null
}

export default function SettingsMode(): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)

  const refreshStatus = async (): Promise<void> => {
    try {
      setStatus(await api.llmStatus())
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    void api.getSettings().then(setValues)
    void refreshStatus()
  }, [])

  const handleSave = async (): Promise<void> => {
    await api.putSettings(values)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    void refreshStatus()
  }

  const handleLlmStart = async (): Promise<void> => {
    setBusy('モデルをロード中…(数分かかることがあります)')
    setLlmError(null)
    try {
      await api.llmStart()
    } catch (e) {
      setLlmError(String(e))
    } finally {
      setBusy(null)
      void refreshStatus()
    }
  }

  const handleLlmStop = async (): Promise<void> => {
    setBusy('停止中…')
    try {
      await api.llmStop()
    } finally {
      setBusy(null)
      void refreshStatus()
    }
  }

  return (
    <div className="inspector-scrollbar h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h2 className="mb-4 text-[15px] font-semibold">設定</h2>

        <section
          className="mb-6 rounded-2xl border p-4"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: status?.healthy ? '#3ecf8e' : 'var(--danger)' }}
            />
            <span className="text-[13px] font-medium">
              llama-server: {status?.healthy ? '稼働中' : '停止'}
            </span>
            <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
              {status?.base_url}
            </span>
          </div>
          {status?.model_path && (
            <div className="mb-2 break-all text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {status.model_path}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleLlmStart()}
              disabled={busy !== null || status?.healthy}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              起動
            </button>
            <button
              onClick={() => void handleLlmStop()}
              disabled={busy !== null || !status?.spawned}
              className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            >
              停止
            </button>
            {busy && (
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {busy}
              </span>
            )}
          </div>
          {llmError && (
            <div className="mt-2 text-[12px]" style={{ color: 'var(--danger)' }}>
              {llmError}
            </div>
          )}
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            ビート生成時に停止していれば自動起動します。外部で起動済みの llama-server があればそれを優先します。
          </p>
        </section>

        {SETTING_DEFS.map((def) => (
          <label key={def.key} className="mb-4 block">
            <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {def.label}
            </span>
            <input
              value={values[def.key] ?? ''}
              placeholder={def.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [def.key]: e.target.value }))}
              className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            />
          </label>
        ))}
        <button
          onClick={() => void handleSave()}
          className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          {saved ? '保存しました' : '保存'}
        </button>
        <p className="mt-4 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          空欄はデフォルト値(プレースホルダの値)が使われます。
        </p>
      </div>
    </div>
  )
}
