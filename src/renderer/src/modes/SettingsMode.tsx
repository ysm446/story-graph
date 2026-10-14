import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import AutoTextarea from '../AutoTextarea'
import { CHAT_RULES_EVENT } from '../ChatRulesPanel'
import { DEFAULT_VIDEO_CROSSFADE_SECONDS } from '../CrossfadeLoopVideo'
import { useElapsedSeconds } from '../useElapsed'
import VoiceSettingsSection from '../VoiceSettings'
import EmbeddingStatusLine from './settings/EmbeddingStatusLine'
import ExternalBackupSection from './settings/ExternalBackupSection'
import ImageGenSection from './settings/ImageGenSection'
import ImportSection from './settings/ImportSection'
import LlamaInstaller from './settings/LlamaInstaller'
import PromptIoSection from './settings/PromptIoSection'
import PromptLogViewer from './settings/PromptLogViewer'
import { BuiltinProofreadPrompts, FixedPrompt } from './settings/prompts'
import SnapshotsSection from './settings/SnapshotsSection'
import StylePresetsSection from './settings/StylePresetsSection'

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

// 左ナビの項目。id は表示するセクションの識別子(localStorage に覚える)。
// group は保存先: app = この PC のアプリ単位(どのライブラリでも共通。backend/app_settings.py)、
// work = 今開いているライブラリ(作品)。同じ group の項目は連続して並べる
const SECTIONS = [
  { id: 'engine', label: '推論エンジン', group: 'app' },
  { id: 'params', label: '推論パラメータ', group: 'app' },
  { id: 'image', label: '画像生成', group: 'app' },
  { id: 'voice', label: '音声読み上げ', group: 'app' },
  { id: 'chat', label: '相談チャット', group: 'app' },
  { id: 'embedding', label: 'Embedding', group: 'app' },
  { id: 'generation', label: 'シーン生成', group: 'work' },
  { id: 'presets', label: '清書(スタイルプリセット)', group: 'work' },
  { id: 'proofread', label: '校正', group: 'work' },
  { id: 'agent', label: '制作エージェントへの指示', group: 'work' },
  { id: 'promptio', label: '書き出し / 読み込み', group: 'work' },
  { id: 'memory', label: '記憶の検索', group: 'work' },
  { id: 'import', label: '取り込み', group: 'work' },
  { id: 'structure', label: '構造モード', group: 'work' },
  { id: 'reader', label: '鑑賞モード', group: 'work' },
  { id: 'backup', label: 'バックアップ', group: 'work' },
  { id: 'promptlog', label: 'プロンプトログ', group: 'work' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']
type SectionGroup = (typeof SECTIONS)[number]['group']

const GROUP_LABEL: Record<SectionGroup, string> = { app: '環境設定(この PC)', work: 'この作品(ライブラリ)' }
// 記憶の検索の半減期(backend/retrieval.py の HALF_LIFE_CHOICES と同じ並び)。'0' は古さを点数に反映しない
const MEMORY_HALF_LIFE_OPTIONS: [string, string][] = [
  ['0', '下げない'],
  ['20', '20 シーンで半分'],
  ['50', '50 シーンで半分'],
  ['100', '100 シーンで半分(既定)'],
  ['200', '200 シーンで半分']
]

// 見出しの下に出す保存先の説明。group の既定と違うセクションだけ SAVED_HINT_OVERRIDE に書く(null は出さない)
const SAVED_HINT: Record<SectionGroup, string> = {
  app: 'この PC に保存します。どのライブラリを開いても同じ設定です。',
  work: '今開いているライブラリ(作品)に保存します。'
}
const SAVED_HINT_OVERRIDE: Partial<Record<SectionId, string | null>> = {
  voice: 'サーバー・エンジン・モデルの置き場は、この PC に保存します(どのライブラリでも同じ)。声のプロファイル・声の割り当て・読みの辞書は、今開いているライブラリ(作品)に保存します。',
  promptio: null,
  promptlog: null
}

// 左ナビで「システムプロンプト」の見出しの下にまとめる項目(SECTIONS では連続して並べる)。
// LLM への指示がどこに書いてあるかを 1 か所で探せるようにする
const PROMPT_GROUP_LABEL = 'システムプロンプト'
const PROMPT_GROUP: ReadonlySet<SectionId> = new Set<SectionId>(['generation', 'presets', 'proofread', 'agent', 'promptio'])

/** 選択中のセクションだけを描く(見出し + 中身)。
 *  非表示のセクションはマウントしないので、一覧の取得も開いたときだけ走る */
function Section({
  id,
  current,
  title,
  scope,
  children
}: {
  id: SectionId
  current: SectionId
  title: string
  /** この設定がどの機能に効くか(プロンプト系は効く範囲が項目ごとに違うので明記する) */
  scope?: string
  children: React.ReactNode
}): React.JSX.Element | null {
  if (id !== current) return null
  const override = SAVED_HINT_OVERRIDE[id]
  const saved = override !== undefined ? override : SAVED_HINT[SECTIONS.find((s) => s.id === id)!.group]
  return (
    <div className="flex flex-col gap-2.5">
      <div className="settings-group-title">{title}</div>
      {saved && <p className="settings-field-hint">保存先: {saved}</p>}
      {scope && <p className="settings-field-hint">適用先: {scope}</p>}
      {children}
    </div>
  )
}

export default function SettingsMode({ onImported }: {
  /** 取り込みが終わったとき(画面を読み直して、取り込んだ作品を見せる)。message は結果の要約 */
  onImported?: (message: string) => void
} = {}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  // 左ナビで選んでいるセクション。開き直したときに同じ場所へ戻れるよう覚える
  const [section, setSection] = useState<SectionId>(() => {
    const saved = localStorage.getItem('settingsSection')
    return SECTIONS.some((s) => s.id === saved) ? (saved as SectionId) : 'engine'
  })
  const [savedMsg, setSavedMsg] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [currentModel, setCurrentModel] = useState<string>('')
  // モデルを探しているフォルダ(バックエンドが解決した実際のパス)と、その既定値
  const [modelsDir, setModelsDir] = useState<{ dir: string; fallback: string; exists: boolean } | null>(null)
  const [modelsDirError, setModelsDirError] = useState<string | null>(null)
  const [genPromptDefault, setGenPromptDefault] = useState('')
  const [fixedPrompts, setFixedPrompts] = useState<Awaited<ReturnType<typeof api.getFixedPrompts>> | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyElapsed = useElapsedSeconds(busy !== null)

  const ctxSize = Number(values.llm_ctx_size || DEFAULT_CTX_SIZE)
  const ctxIndex = getNearestCtxPresetIndex(ctxSize, CTX_SIZE_PRESETS)

  const videoFade = values.video_crossfade_seconds
    ? Math.min(Math.max(Number(values.video_crossfade_seconds) || 0, 0), 2)
    : DEFAULT_VIDEO_CROSSFADE_SECONDS
  const minimapVisible = values.minimap_visible !== '0' // 既定は表示
  const gridSnap = values.grid_snap !== '0' // 既定はスナップする
  const chatDynamicSuggestions = values.chat_dynamic_suggestions !== '0' // 既定は生成する
  const embeddingOnStartup = values.embedding_load_on_startup !== '0' // 既定は起動時に読み込む
  const memoryHalfLife = MEMORY_HALF_LIFE_OPTIONS.some(([value]) => value === values.memory_half_life)
    ? values.memory_half_life
    : '100' // 既定は 100 シーンで半分

  const refreshStatus = async (): Promise<void> => {
    try {
      setStatus(await api.llmStatus())
    } catch {
      setStatus(null)
    }
  }

  // モデルフォルダを変えるたびに取り直すので関数にしてある
  const loadModels = async (): Promise<void> => {
    const r = await api.listModels()
    setModels(r.models)
    setCurrentModel(r.current)
    setModelsDir({ dir: r.models_dir, fallback: r.default_models_dir, exists: r.models_dir_exists })
  }

  useEffect(() => {
    // 読み込めなかったときは空の画面のまま黙らず、保存の合図と同じ場所に出す
    const report = (what: string) => (e: unknown) => setSaveError(`${what}を読み込めませんでした: ${String(e)}`)
    void api.getSettings().then(setValues).catch(report('設定'))
    void refreshStatus()
    void loadModels().catch(report('モデル一覧'))
    void api.getGenerationPrompt().then((r) => setGenPromptDefault(r.default)).catch(report('生成プロンプト'))
    void api.getFixedPrompts().then(setFixedPrompts).catch(() => undefined)
  }, [])

  const showSaved = (): void => {
    setSavedMsg(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSavedMsg(false), 1500)
  }

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    },
    []
  )

  // 変更されたキーだけ送る(PUT /settings はマージ)。全設定を書き戻すと、
  // 開いている間に他所(ModelBar 等)で変わった設定が巻き戻ってしまう
  const save = async (patch: Record<string, string>): Promise<void> => {
    setValues((v) => ({ ...v, ...patch }))
    setSaveError(null)
    try {
      if (Object.keys(patch).length > 0) await api.putSettings(patch)
    } catch (e) {
      // 呼び出し側はほぼ void save(...) なので、ここで出さないと失敗が見えない
      setSaveError(`保存できませんでした: ${String(e)}`)
      return
    }
    showSaved()
    void refreshStatus()
  }

  // モデルフォルダを選び直す。llm_model_path はそのまま残す(新しいフォルダに
  // 無ければ一覧では「外部パス」として出るので、選び直すまで今のモデルで動く)
  const handleChooseModelsDir = async (): Promise<void> => {
    const dir = await window.storyGraph.chooseFolder('GGUF モデルのフォルダを選択')
    if (!dir) return
    setModelsDirError(null)
    await save({ models_dir: dir })
    await loadModels()
  }

  const handleResetModelsDir = async (): Promise<void> => {
    setModelsDirError(null)
    await save({ models_dir: '' })
    await loadModels()
  }

  const handleOpenModelsDir = async (): Promise<void> => {
    const dir = modelsDir?.dir
    if (!dir) return
    if (await window.storyGraph.openFolder(dir)) {
      setModelsDirError(null)
      return
    }
    setModelsDirError(`モデルフォルダを開けませんでした: ${dir}`)
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
    } catch (e) {
      setLlmError(String(e))
    } finally {
      setBusy(null)
      void refreshStatus()
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左: セクション一覧。右: 選んだセクションの設定 */}
      <aside className="flex w-48 shrink-0 flex-col" style={{ background: 'var(--bg-sidebar)' }}>
        <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {SECTIONS.map(({ id, label, group }, index) => {
            const grouped = PROMPT_GROUP.has(id)
            const previousGrouped = index > 0 && PROMPT_GROUP.has(SECTIONS[index - 1].id)
            const groupStart = index === 0 || SECTIONS[index - 1].group !== group
            return (
              <div key={id} className={!grouped && previousGrouped ? 'mt-2' : undefined}>
                {/* 保存先の区切り(この PC / この作品)。2つ目からは線で分ける */}
                {groupStart && (
                  <div className={`px-2.5 pb-1 text-[10px] tracking-[0.14em] ${index > 0 ? 'mt-3 border-t pt-3' : 'pt-1'}`}
                    style={{ borderColor: 'var(--border)', color: 'var(--text-faint)' }}>
                    {GROUP_LABEL[group]}
                  </div>
                )}
                {grouped && !previousGrouped && (
                  <div className={`${groupStart ? '' : 'mt-2 '}px-2.5 pb-1 text-[11px] font-medium`} style={{ color: 'var(--text-dim)' }}>
                    {PROMPT_GROUP_LABEL}
                  </div>
                )}
                <button
                  onClick={() => {
                    setSection(id)
                    localStorage.setItem('settingsSection', id)
                  }}
                  className={`mb-0.5 block w-full rounded-md py-1.5 pr-2.5 text-left text-[12px] transition-colors ${grouped ? 'pl-5' : 'pl-2.5'}`}
                  style={
                    section === id
                      ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                      : { color: 'var(--text-faint)' }
                  }
                >
                  {label}
                </button>
              </div>
            )
          })}
        </div>
        {/* 保存の合図はどのセクションでも同じ場所に出す */}
        <p
          className="min-h-5 px-3 pb-2 text-[11px]"
          role={saveError ? 'alert' : undefined}
          style={{ color: saveError ? 'var(--danger)' : 'var(--accent)' }}
        >
          {saveError ?? (savedMsg ? '保存しました' : '')}
        </p>
      </aside>
      <div className="w-px shrink-0" style={{ background: 'var(--border)' }} />
      <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          <Section id="engine" current={section} title="推論エンジン(llama.cpp)">
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
                      <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                        ({busyElapsed}s)
                      </span>
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
                  <span className="settings-field-label">モデルフォルダ</span>
                  <div className="settings-field-controls">
                    {(values.models_dir ?? '') !== '' && (
                      <button
                        onClick={() => void handleResetModelsDir()}
                        className="rounded-md border px-2 py-0.5 text-[11px]"
                        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                        data-tip="既定のフォルダ(アプリの models/)に戻します"
                      >
                        既定に戻す
                      </button>
                    )}
                    <button
                      onClick={() => void handleChooseModelsDir()}
                      className="rounded-md border px-2 py-0.5 text-[11px]"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                      data-tip="GGUF を探すフォルダを選びます"
                    >
                      変更
                    </button>
                    <button
                      onClick={() => void handleOpenModelsDir()}
                      className="rounded-md border px-2 py-0.5 text-[11px]"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                      data-tip="モデルフォルダをエクスプローラーで開く"
                    >
                      開く
                    </button>
                  </div>
                </div>
                <div className="text-[12px]">
                  <span className="block truncate" style={{ color: 'var(--text)' }} data-tip={modelsDir?.dir}>
                    {modelsDir?.dir ?? ''}
                  </span>
                </div>
                {modelsDir && !modelsDir.exists && (
                  <p className="text-[12px]" style={{ color: '#f2a3a3' }}>
                    フォルダが見つかりません: {modelsDir.dir}
                  </p>
                )}
                {modelsDirError && (
                  <p className="text-[12px]" style={{ color: '#f2a3a3' }}>
                    {modelsDirError}
                  </p>
                )}
                <p className="settings-field-hint">
                  このフォルダの下(サブフォルダも含む)から .gguf を探します。指定しなければ既定の
                  {` ${modelsDir?.fallback ?? 'models/'} `}
                  を使います。
                </p>
              </div>
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">モデル(モデルフォルダから選択)</span>
                </div>
                <select
                  value={values.llm_model_path || currentModel}
                  onChange={(e) => void save({ llm_model_path: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                >
                  {models.length === 0 && (
                    <option value="">モデルフォルダに GGUF がありません</option>
                  )}
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
                    onBlur={() => void save({ [def.key]: values[def.key] ?? '' })}
                    className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
                    style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                  />
                </div>
              ))}
              <p className="settings-field-hint">空欄はデフォルト値(プレースホルダの値)が使われます。欄外クリックで保存されます。</p>
              <LlamaInstaller />
            </div>
          </Section>

          <Section id="params" current={section} title="推論パラメータ">
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span
                    className="settings-field-label"
                    data-tip="一度に扱える最大トークン数です。大きいほど長いコンテキストを保持できますが、VRAM 使用量も増えます。"
                  >
                    Context Length
                  </span>
                  <div className="settings-field-controls">
                    {ctxSize !== DEFAULT_CTX_SIZE && (
                      <button
                        className="settings-reset-btn"
                        aria-label="デフォルトに戻す"
                        data-tip="デフォルトに戻す"
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
                  onPointerUp={() => void save({ llm_ctx_size: String(ctxSize) })}
                  onKeyUp={() => void save({ llm_ctx_size: String(ctxSize) })}
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
          </Section>

          <Section id="generation" current={section} title="シーン生成プロンプト"
            scope="構造モードの「生成」(シーン本文と出来事の下書き)。制作チャットと清書には使いません。">
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">システムプロンプト(構成作家の指示)</span>
                  <div className="settings-field-controls">
                    {(values.generation_system_prompt ?? '') !== '' && (
                      <button
                        className="settings-reset-btn"
                        aria-label="デフォルトに戻す"
                        data-tip="デフォルトに戻す"
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
                  onBlur={() => void save({ generation_system_prompt: values.generation_system_prompt ?? '' })}
                  className="w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                />
                <p className="settings-field-hint">
                  空欄ならプレースホルダのデフォルトが使われます。
                </p>
              </div>
              <FixedPrompt
                label="必ず付くルール(編集不可)"
                text={fixedPrompts?.generation}
                hint="上のプロンプトの後ろに必ず付きます。上のプロンプトに食い違う指示を書いても、このルールは残ります。"
              />
            </div>
          </Section>

          <Section id="proofread" current={section} title="校正" scope="シーンタブの「校正」。">
            <div className="settings-card">
              <BuiltinProofreadPrompts />
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">カスタム校正プロンプト</span>
                </div>
                {/* 長い指示でも中でスクロールさせず、内容に合わせて伸ばす */}
                <AutoTextarea
                  minRows={4}
                  value={values.proofread_custom_prompt ?? ''}
                  placeholder={'例: あなたはハードボイルド小説の編集者です。感傷的な表現を削り、\n短く乾いた文に整えてください。修正後の文章だけを返してください。'}
                  onChange={(v) => setValues((prev) => ({ ...prev, proofread_custom_prompt: v }))}
                  onBlur={() => void save({ proofread_custom_prompt: values.proofread_custom_prompt ?? '' })}
                  className="w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                />
                <p className="settings-field-hint">
                  入力すると、シーンタブの校正プリセットに「カスタム」が追加されます(組み込み: 軽く / 標準 / 積極的)。
                </p>
              </div>
            </div>
          </Section>

          <Section id="presets" current={section} title="スタイルプリセット(清書の文体指示)"
            scope="鑑賞モードと清書タブの清書。選んだプリセットの本文が、そのままシステムプロンプトになります。">
            <div className="settings-card">
              <StylePresetsSection />
              <FixedPrompt
                label="必ず付く厳守事項(編集不可)"
                text={fixedPrompts?.rendering}
                hint="プリセット本文の後ろに、人称の行・分量の指定(指定したとき)とあわせて必ず付きます。視点キャラを指定した清書では「視点キャラが知らないことは地の文にも書かない」が加わります。"
              />
            </div>
          </Section>

          <Section id="agent" current={section} title="制作エージェントへの指示"
            scope="制作チャット(「相談する」「制作を実行」の両方)。相談チャット・キャラクターとの会話・シーン生成・清書には使いません。">
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">作者からの指示</span>
                  <div className="settings-field-controls">
                    <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                      {(values.author_chat_rules ?? '').length} / 6000
                    </span>
                  </div>
                </div>
                <AutoTextarea
                  ariaLabel="制作エージェントへの指示(設定)"
                  minRows={4}
                  maxLength={6000}
                  value={values.author_chat_rules ?? ''}
                  placeholder={'・シーン本文は、1シーンあたり600文字程度に収める。\n・シーン本文は小説調ではなく、出来事と人物の行動が分かる指示書形式で書く。'}
                  onChange={(v) => setValues((prev) => ({ ...prev, author_chat_rules: v }))}
                  onBlur={() =>
                    void save({ author_chat_rules: values.author_chat_rules ?? '' }).then(() =>
                      window.dispatchEvent(new Event(CHAT_RULES_EVENT))
                    )
                  }
                  className="w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                />
                <p className="settings-field-hint">
                  制作チャットの「制作エージェントへの指示」と同じ内容です。どちらで保存しても反映され、次の送信から適用します。
                  「回答」「1シーンの本文」など対象を明記してください。空にすると解除できます。この作品だけの設定です。
                </p>
              </div>
              <FixedPrompt
                label="実行モードの固定の指示(編集不可)"
                text={fixedPrompts?.production_execute}
                hint="「制作を実行」で送ったときに必ず付きます。上の指示はこの後ろに入ります。編集の許可・保護・参照範囲は上の指示では解除できません。"
                collapsed
              />
              <FixedPrompt
                label="相談モードの固定の指示(編集不可)"
                text={fixedPrompts?.production_consult}
                hint="「相談する」で送ったときに必ず付きます。どちらのモードでも、この前に相談チャットと共通の基本指示(物語の読み方とツールの使い方)が付きます。"
                collapsed
              />
            </div>
          </Section>

          <Section id="promptio" current={section} title="プロンプトの書き出し / 読み込み"
            scope="シーン生成プロンプト・カスタム校正プロンプト・スタイルプリセット。制作エージェントへの指示は含みません。">
            <div className="settings-card">
              <PromptIoSection values={values} save={save} />
            </div>
          </Section>

          <Section
            id="memory"
            current={section}
            title="記憶の検索"
            scope="登場人物が会話の途中で思い出す記憶(recall)、相談・制作チャットの記憶の検索、シーン生成で各キャラが思い出す記憶"
          >
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">古い記憶の点数を下げる速さ</span>
                  <div className="settings-field-controls">
                    <select
                      aria-label="古い記憶の点数を下げる速さ"
                      value={memoryHalfLife}
                      onChange={(e) => void save({ memory_half_life: e.target.value })}
                      className="rounded-lg border px-2 py-1.5 text-[13px]"
                      style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                    >
                      {MEMORY_HALF_LIFE_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="settings-field-hint">
                  記憶の検索では、言葉の近さと重要度に加えて、古い記憶ほど点数を下げます。古さは「何シーン前か」で測ります。
                  ここで選ぶのは、点数が半分になるまでのシーン数です。大きくするほど、古い記憶が出やすくなります。
                  長い作品で序盤の記憶が出てこないときは大きくし、最近の出来事を優先したいときは小さくします。
                  「下げない」を選ぶと、古さを使わず、言葉の近さと重要度だけで順位を決めます。
                </p>
                <p className="settings-field-hint">
                  目安: 150 シーン前の記憶の点数は、20 シーンで半分だと約 180 分の 1、100 シーンで半分だと約 3 分の 1 になります。
                  会話の最初に渡す記憶の選び方と、章のまとめには効きません。切り替えは次の検索から反映されます。
                </p>
              </div>
            </div>
          </Section>

          <Section id="import" current={section} title="取り込み">
            <div className="settings-card">
              <ImportSection onImported={onImported} />
            </div>
          </Section>

          <Section id="structure" current={section} title="構造モード">
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">ミニマップ</span>
                  <div className="settings-field-controls">
                    <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
                      {(
                        [
                          ['1', '表示'],
                          ['0', '非表示']
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          onClick={() => void save({ minimap_visible: value })}
                          className="px-2.5 py-0.5 text-[12px]"
                          style={
                            minimapVisible === (value === '1')
                              ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                              : { color: 'var(--text-faint)' }
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="settings-field-hint">ノードエリアの右下に表示される全体図です。</p>
              </div>
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">グリッドにスナップ</span>
                  <div className="settings-field-controls">
                    <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
                      {(
                        [
                          ['1', 'オン'],
                          ['0', 'オフ']
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          onClick={() => void save({ grid_snap: value })}
                          className="px-2.5 py-0.5 text-[12px]"
                          style={
                            gridSnap === (value === '1')
                              ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                              : { color: 'var(--text-faint)' }
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="settings-field-hint">
                  ノードをドラッグしたとき、背景のドットと同じ 20px の目に合わせて置きます。
                  整列(⟲)や新しいシーンの自動配置も同じ目に乗ります。
                </p>
              </div>
            </div>
          </Section>

          <Section id="embedding" current={section} title="Embedding">
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">起動時に Embedding を読み込む</span>
                  <div className="settings-field-controls">
                    <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
                      {(
                        [
                          ['1', 'オン'],
                          ['0', 'オフ']
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          aria-pressed={embeddingOnStartup === (value === '1')}
                          onClick={() => void save({ embedding_load_on_startup: value })}
                          className="px-2.5 py-0.5 text-[12px]"
                          style={
                            embeddingOnStartup === (value === '1')
                              ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                              : { color: 'var(--text-faint)' }
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="settings-field-hint">
                  Embedding は、登場人物の記憶と設定資料を「意味の近さ」で探すためのモデルです(メモリを約 1.2GB 使います。GPU は使いません)。
                  オンにすると、アプリの起動と同時に裏で読み込み、起動直後の検索から効きます。
                  オフにすると、最初に検索が必要になったときに読み込みます。読み込みが終わるまでの検索は、文字の一致だけで行われます。
                  切り替えは次の起動から反映されます。
                </p>
              </div>
              <EmbeddingStatusLine />
            </div>
          </Section>

          <Section id="chat" current={section} title="相談チャット">
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span className="settings-field-label">内容から質問候補を作る</span>
                  <div className="settings-field-controls">
                    <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
                      {(
                        [
                          ['1', 'オン'],
                          ['0', 'オフ']
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          onClick={() => void save({ chat_dynamic_suggestions: value })}
                          className="px-2.5 py-0.5 text-[12px]"
                          style={
                            chatDynamicSuggestions === (value === '1')
                              ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                              : { color: 'var(--text-faint)' }
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="settings-field-hint">
                  オンにすると、チャットを開いたときと回答のあとに、LLM が物語の内容から質問候補を作って
                  候補チップの下段に ✨ 付きで並べます(最大2件。固定の候補は常に残ります)。
                  生成は軽い1回の呼び出しですが、回答直後に少し待ち時間が増えます。LLM 未起動時は何もしません。
                  制作チャットでも、回答のあとに「案Bで進めて」のような依頼の候補を最大2件足します。
                </p>
              </div>
            </div>
          </Section>

          <Section id="reader" current={section} title="鑑賞モード">
            <div className="settings-card">
              <div className="settings-field">
                <div className="settings-field-header">
                  <span
                    className="settings-field-label"
                    data-tip="動画の挿絵をループ再生するとき、終端と先頭をクロスディゾルブで重ねて継ぎ目を目立たなくします。"
                  >
                    動画ループのつなぎ(クロスディゾルブ)
                  </span>
                  <div className="settings-field-controls">
                    {videoFade !== DEFAULT_VIDEO_CROSSFADE_SECONDS && (
                      <button
                        className="settings-reset-btn"
                        aria-label="デフォルトに戻す"
                        data-tip="デフォルトに戻す"
                        onClick={() => void save({ video_crossfade_seconds: String(DEFAULT_VIDEO_CROSSFADE_SECONDS) })}
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
                    <span className="settings-value-badge">{videoFade === 0 ? 'なし' : `${videoFade.toFixed(1)}秒`}</span>
                  </div>
                </div>
                <input
                  className={`settings-slider${videoFade !== DEFAULT_VIDEO_CROSSFADE_SECONDS ? ' active' : ''}`}
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={videoFade}
                  onChange={(e) => setValues((v) => ({ ...v, video_crossfade_seconds: e.target.value }))}
                  onPointerUp={() => void save({ video_crossfade_seconds: String(videoFade) })}
                  onKeyUp={() => void save({ video_crossfade_seconds: String(videoFade) })}
                />
                <p className="settings-field-hint">
                  0 にするとクロスディゾルブなしの通常ループになります。フェード時間の2倍より短い動画は自動的に通常ループになります。
                </p>
              </div>
            </div>
          </Section>

          <Section id="image" current={section} title="画像生成(ComfyUI)">
            <ImageGenSection values={values} setValues={setValues} save={save} />
          </Section>

          <Section id="voice" current={section} title="音声読み上げ(TTS)">
            <VoiceSettingsSection values={values} setValues={setValues} save={save} />
          </Section>

          <Section id="backup" current={section} title="バックアップ">
            <div className="settings-card">
              <ExternalBackupSection />
            </div>
            <div className="settings-card">
              <SnapshotsSection />
            </div>
          </Section>

          <Section id="promptlog" current={section} title="プロンプトログ">
            <div className="settings-card">
              <PromptLogViewer />
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
