import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

// lm-chat の SettingsPanel と同じ刻み
const CTX_SIZE_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144] as const
const DEFAULT_CTX_SIZE = 16384

function formatCtxSizeLabel(value: number): string {
  if (value >= 1024) {
    const asK = value / 1024
    return Number.isInteger(asK) ? `${asK}k` : `${asK.toFixed(1)}k`
  }
  return value.toLocaleString()
}

function getNearestCtxPresetIndex(value: number, presets: readonly number[]): number {
  let nearestIndex = 0
  let nearestDistance = Math.abs(presets[0] - value)
  for (let i = 1; i < presets.length; i += 1) {
    const distance = Math.abs(presets[i] - value)
    if (distance < nearestDistance) {
      nearestIndex = i
      nearestDistance = distance
    }
  }
  return nearestIndex
}

const TEXT_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'llm_base_url', label: 'LLM エンドポイント', placeholder: 'http://127.0.0.1:8080' },
  {
    key: 'llama_server_path',
    label: 'llama-server.exe のパス',
    placeholder: 'D:\\GitHub\\lm-graph\\bin\\llama-server\\b9496-win-cuda13-x64\\llama-server.exe'
  }
]

interface ModelEntry {
  name: string
  path: string
  size: number
}

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

interface LlmStatus {
  base_url: string
  healthy: boolean
  spawned: boolean
  model_path: string | null
}

export default function SettingsMode(): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [savedMsg, setSavedMsg] = useState(false)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [currentModel, setCurrentModel] = useState<string>('')
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ctxSize = Number(values.llm_ctx_size || DEFAULT_CTX_SIZE)
  const ctxIndex = getNearestCtxPresetIndex(ctxSize, CTX_SIZE_PRESETS)

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
    void api.listModels().then((r) => {
      setModels(r.models)
      setCurrentModel(r.current)
    })
  }, [])

  const showSaved = (): void => {
    setSavedMsg(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSavedMsg(false), 1500)
  }

  const save = async (patch: Record<string, string>): Promise<void> => {
    const next = { ...values, ...patch }
    setValues(next)
    await api.putSettings(next)
    showSaved()
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
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        {/* 推論エンジン */}
        <div className="flex flex-col gap-2.5">
          <div className="settings-group-title">推論エンジン(llama.cpp)</div>
          <div className="settings-card">
            <div className="settings-field">
              <div className="settings-field-header">
                <span className="settings-field-label">llama-server</span>
                <div className="settings-field-controls">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: status?.healthy ? '#3ecf8e' : 'var(--danger)' }}
                  />
                  <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    {status?.healthy ? '稼働中' : '停止'}
                  </span>
                </div>
              </div>
              {status?.model_path && (
                <p className="settings-field-hint break-all">{status.model_path}</p>
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
                <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
                  {llmError}
                </p>
              )}
              <p className="settings-field-hint">
                シーン生成・清書時に停止していれば自動起動します。外部で起動済みの llama-server があればそれを優先します。
              </p>
            </div>
            <div className="settings-field">
              <div className="settings-field-header">
                <span className="settings-field-label">モデル (models/ フォルダから選択)</span>
              </div>
              <select
                value={values.llm_model_path || currentModel}
                onChange={(e) => void save({ llm_model_path: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
              >
                {models.length === 0 && <option value="">models/ に GGUF がありません</option>}
                {models.map((m) => (
                  <option key={m.path} value={m.path}>
                    {m.name}({fmtGb(m.size)})
                  </option>
                ))}
                {(values.llm_model_path || currentModel) &&
                  !models.some((m) => m.path === (values.llm_model_path || currentModel)) && (
                    <option value={values.llm_model_path || currentModel}>
                      {(values.llm_model_path || currentModel).split(/[\\/]/).pop()}(外部パス)
                    </option>
                  )}
              </select>
              <p className="settings-field-hint">変更は次回のサーバー起動から反映されます。mmproj は自動で除外しています。</p>
            </div>
            {TEXT_FIELDS.map((def) => (
              <div key={def.key} className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">{def.label}</span>
                </div>
                <input
                  value={values[def.key] ?? ''}
                  placeholder={def.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [def.key]: e.target.value }))}
                  onBlur={() => void save({})}
                  className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                />
              </div>
            ))}
            <p className="settings-field-hint">空欄はデフォルト値(プレースホルダの値)が使われます。欄外クリックで保存されます。</p>
          </div>
        </div>

        {/* 推論パラメータ */}
        <div className="flex flex-col gap-2.5">
          <div className="settings-group-title">推論パラメータ</div>
          <div className="settings-card">
            <div className="settings-field">
              <div className="settings-field-header">
                <span
                  className="settings-field-label"
                  title="一度に扱える最大トークン数です。大きいほど長いコンテキストを保持できますが、VRAM 使用量も増えます。"
                >
                  Context Length
                </span>
                <div className="settings-field-controls">
                  {ctxSize !== DEFAULT_CTX_SIZE && (
                    <button
                      className="settings-reset-btn"
                      title="デフォルトに戻す"
                      onClick={() => void save({ llm_ctx_size: String(DEFAULT_CTX_SIZE) })}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M9 6V4h6v2" />
                      </svg>
                    </button>
                  )}
                  <span className="settings-value-badge">{formatCtxSizeLabel(ctxSize)}</span>
                </div>
              </div>
              <input
                className={`settings-slider${ctxSize !== DEFAULT_CTX_SIZE ? ' active' : ''}`}
                type="range"
                min={0}
                max={CTX_SIZE_PRESETS.length - 1}
                step={1}
                value={ctxIndex}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    llm_ctx_size: String(CTX_SIZE_PRESETS[Number(e.target.value)] ?? ctxSize)
                  }))
                }
                onMouseUp={() => void save({})}
              />
              <div className="settings-slider-labels">
                {CTX_SIZE_PRESETS.map((p) => (
                  <span key={p}>{formatCtxSizeLabel(p)}</span>
                ))}
              </div>
              <p className="settings-field-hint">
                llama-server の <code>--ctx-size</code>。変更は次回のサーバー起動から反映されます。
              </p>
            </div>
          </div>
        </div>

        <p className="h-4 text-[11px]" style={{ color: 'var(--accent)' }}>
          {savedMsg ? '保存しました' : ''}
        </p>
      </div>
    </div>
  )
}
