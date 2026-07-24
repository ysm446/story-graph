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

function PromptLogViewer(): React.JSX.Element {
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
              {entry.error && <span style={{ color: 'var(--danger)' }}>エラー</span>}
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
                    <div className="mb-0.5 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
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
                    <div className="mb-0.5 text-[10px] uppercase tracking-[0.14em]" style={{ color: '#3ecf8e' }}>
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
                  <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
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

export default function SettingsMode(): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [savedMsg, setSavedMsg] = useState(false)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [currentModel, setCurrentModel] = useState<string>('')
  const [genPromptDefault, setGenPromptDefault] = useState('')
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
    void api.getGenerationPrompt().then((r) => setGenPromptDefault(r.default))
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

        {/* シーン生成プロンプト */}
        <div className="flex flex-col gap-2.5">
          <div className="settings-group-title">シーン生成プロンプト</div>
          <div className="settings-card">
            <div className="settings-field">
              <div className="settings-field-header">
                <span className="settings-field-label">システムプロンプト(構成作家の指示)</span>
                <div className="settings-field-controls">
                  {(values.generation_system_prompt ?? '') !== '' && (
                    <button
                      className="settings-reset-btn"
                      title="デフォルトに戻す"
                      onClick={() => void save({ generation_system_prompt: '' })}
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
                </div>
              </div>
              <textarea
                rows={6}
                value={values.generation_system_prompt ?? ''}
                placeholder={genPromptDefault}
                onChange={(e) => setValues((v) => ({ ...v, generation_system_prompt: e.target.value }))}
                onBlur={() => void save({})}
                className="w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
              />
              <p className="settings-field-hint">
                空欄ならプレースホルダのデフォルトが使われます。末尾に JSON 形式の指定と
                イベント発行ルール(char_introduce 必須 / delta 範囲 等)が自動で追加されます。
              </p>
            </div>
          </div>
        </div>

        {/* プロンプトログ */}
        <div className="flex flex-col gap-2.5">
          <div className="settings-group-title">プロンプトログ</div>
          <div className="settings-card">
            <PromptLogViewer />
          </div>
        </div>

        <p className="h-4 text-[11px]" style={{ color: 'var(--accent)' }}>
          {savedMsg ? '保存しました' : ''}
        </p>
      </div>
    </div>
  )
}
