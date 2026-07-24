import { useEffect, useState } from 'react'
import { api } from '../api'

const SETTING_DEFS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'llm_base_url', label: 'LLM エンドポイント (llama.cpp server)', placeholder: 'http://127.0.0.1:8080' },
  { key: 'llm_model_path', label: 'モデルパス (GGUF)', placeholder: 'models/gemma-4-31B-it-GGUF/gemma-4-31B-it-Q6_K.gguf' },
  { key: 'context_budget_generation', label: 'ビート生成のコンテキスト予算 (tokens)', placeholder: '8192' }
]

export default function SettingsMode(): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void api.getSettings().then(setValues)
  }, [])

  const handleSave = async (): Promise<void> => {
    await api.putSettings(values)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="inspector-scrollbar h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h2 className="mb-4 text-[15px] font-semibold">設定</h2>
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
        <p className="mt-6 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          llama-server の起動管理・検証パスの ON/OFF は Phase 1 M4 で実装します。
        </p>
      </div>
    </div>
  )
}
