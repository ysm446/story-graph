import { useEffect, useRef, useState } from 'react'
import {
  api,
  comfyInstallStream,
  isAbortError,
  llamaInstallStream,
  type ComfyRelease,
  type ComfyReleaseVariant,
  type ComfyStatus,
  type LlamaInstallProgress,
  type LlamaRelease,
  type LlamaReleaseVariant,
  type LlamaServerInstall,
  type LlamaServerStatus
} from '../api'
import AutoTextarea from '../AutoTextarea'
import { DEFAULT_VIDEO_CROSSFADE_SECONDS } from '../CrossfadeLoopVideo'
import { PresetEditorModal, type PresetDraft } from '../RenderStyle'
import type { BackupConfig, Snapshot, StylePreset } from '../types'
import { useElapsedSeconds } from '../useElapsed'
import VoiceSettingsSection from '../VoiceSettings'

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

// 左ナビの項目。id は表示するセクションの識別子(localStorage に覚える)
const SECTIONS = [
  { id: 'engine', label: '推論エンジン' },
  { id: 'params', label: '推論パラメータ' },
  { id: 'generation', label: 'シーン生成プロンプト' },
  { id: 'proofread', label: '校正' },
  { id: 'presets', label: 'スタイルプリセット' },
  { id: 'promptio', label: 'プロンプト入出力' },
  { id: 'structure', label: '構造モード' },
  { id: 'chat', label: '相談チャット' },
  { id: 'reader', label: '鑑賞モード' },
  { id: 'image', label: '画像生成' },
  { id: 'voice', label: '音声読み上げ' },
  { id: 'backup', label: 'バックアップ' },
  { id: 'promptlog', label: 'プロンプトログ' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** 選択中のセクションだけを描く(見出し + 中身)。
 *  非表示のセクションはマウントしないので、一覧の取得も開いたときだけ走る */
function Section({
  id,
  current,
  title,
  children
}: {
  id: SectionId
  current: SectionId
  title: string
  children: React.ReactNode
}): React.JSX.Element | null {
  if (id !== current) return null
  return (
    <div className="flex flex-col gap-2.5">
      <div className="settings-group-title">{title}</div>
      {children}
    </div>
  )
}

// 清書の文体指示(スタイルプリセット)の一覧と編集。編集モーダルは鑑賞モード・
// 清書タブの ✎ と同じもの(RenderStyle.tsx)を使う
// 組み込みの校正プリセット(軽く / 標準 / 積極的)の中身。どれを選ぶかは
// プロンプトの文面を見ないと判断できないので、読み取り専用で表示する
function BuiltinProofreadPrompts(): React.JSX.Element {
  const [presets, setPresets] = useState<Array<{ id: string; name: string; prompt: string }>>([])
  useEffect(() => {
    let ignore = false
    void api
      .listProofreadPresets()
      .then((list) => {
        // カスタムは下の編集欄そのものなので、ここには出さない
        if (!ignore) setPresets(list.filter((p) => p.id !== 'custom'))
      })
      .catch(() => undefined)
    return () => {
      ignore = true
    }
  }, [])
  if (presets.length === 0) return <></>
  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">組み込みプリセット</span>
      </div>
      <div className="flex flex-col gap-2">
        {presets.map((p) => (
          <div
            key={p.id}
            className="rounded-lg border px-3 py-2"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="mb-1 text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
              {p.name}
            </div>
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
              {p.prompt}
            </p>
          </div>
        ))}
      </div>
      <p className="settings-field-hint">
        組み込みは編集できません。文面を変えたいときは下のカスタム校正プロンプトを使ってください。
      </p>
    </div>
  )
}

function StylePresetsSection(): React.JSX.Element {
  const [presets, setPresets] = useState<StylePreset[]>([])
  const [editor, setEditor] = useState<PresetDraft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setPresets(await api.listPresets())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">スタイルプリセット({presets.length}件)</span>
        <button
          onClick={() => setEditor({ name: '', person: 'third', tone: '' })}
          className="rounded-md border px-2 py-0.5 text-[11px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        >
          + 新規
        </button>
      </div>
      <p className="settings-field-hint">
        清書(散文化)のシステムプロンプト。ここで書いた全文がそのまま使われ、人称と厳守事項だけが
        自動で追加されます。どれを使うかは鑑賞モードと構造モードの清書タブで選びます。
        組み込みの 2 つは編集できないので、複製して育ててください。
      </p>
      {error && (
        <p className="settings-field-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {presets.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
        >
          <span
            className="shrink-0 rounded px-1 text-[10px]"
            style={{
              background: p.builtin ? 'var(--bg-input)' : 'var(--accent-soft)',
              color: p.builtin ? 'var(--text-faint)' : 'var(--text)'
            }}
          >
            {p.builtin ? '組み込み' : 'カスタム'}
          </span>
          <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
            {p.name}
          </span>
          <span className="shrink-0" style={{ color: 'var(--text-faint)' }}>
            {p.person === 'first' ? '一人称' : '三人称'}
          </span>
          <button
            onClick={() =>
              setEditor(
                p.builtin
                  ? { name: `${p.name} のコピー`, person: p.person, tone: p.tone }
                  : { id: p.id, name: p.name, person: p.person, tone: p.tone }
              )
            }
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip={p.builtin ? '組み込みは編集できません。複製して新規作成します' : 'このプリセットを編集'}
          >
            {p.builtin ? '⧉ 複製して編集' : '✎ 編集'}
          </button>
        </div>
      ))}
      {editor && (
        <PresetEditorModal
          draft={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            void reload()
          }}
          onDeleted={() => {
            setEditor(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}

// プロンプトの書き出し / 読み込み。シーン生成・校正・スタイルプリセット
// (散文用システムプロンプト)を 1 ファイルにまとめて扱う。
// プロンプトはライブラリごとの設定なので、別のストーリーへ持ち込むのに使う
const PROMPT_FILE_KIND = 'story-graph-prompts'

function PromptIoSection({
  values,
  save
}: {
  values: Record<string, string>
  save: (patch: Record<string, string>) => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const importRef = useRef<HTMLInputElement | null>(null)

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const custom = (await api.listPresets()).filter((p) => !p.builtin)
      const payload = {
        kind: PROMPT_FILE_KIND,
        version: 1,
        exported_at: new Date().toISOString(),
        generation_system_prompt: values.generation_system_prompt ?? '',
        proofread_custom_prompt: values.proofread_custom_prompt ?? '',
        presets: custom.map((p) => ({ name: p.name, person: p.person, tone: p.tone }))
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8'
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'story-graph-prompts.json'
      a.click()
      URL.revokeObjectURL(url)
      setStatus(`書き出しました(スタイルプリセット ${custom.length} 件 + シーン生成 / 校正)`)
    } catch (e) {
      setStatus(`書き出しに失敗しました: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (file: File): Promise<void> => {
    setBusy(true)
    try {
      const data = JSON.parse(await file.text())
      // 旧形式(style-presets.json: 配列 or {presets})も読める
      const list = Array.isArray(data) ? data : data?.presets
      const presets: Array<Record<string, unknown>> = Array.isArray(list) ? list : []
      const patch: Record<string, string> = {}
      for (const key of ['generation_system_prompt', 'proofread_custom_prompt'] as const) {
        if (typeof data?.[key] === 'string') patch[key] = data[key]
      }
      if (presets.length === 0 && Object.keys(patch).length === 0) {
        throw new Error('プロンプトが見つかりません')
      }
      const parts = [
        presets.length > 0 ? `スタイルプリセット ${presets.length} 件を追加` : null,
        patch.generation_system_prompt !== undefined ? 'シーン生成プロンプトを置き換え' : null,
        patch.proofread_custom_prompt !== undefined ? '校正プロンプトを置き換え' : null
      ].filter(Boolean)
      if (!window.confirm(`次の内容を読み込みます。\n\n・${parts.join('\n・')}\n\nよろしいですか?`)) {
        return
      }
      let imported = 0
      for (const item of presets) {
        const name = String(item?.name ?? '').trim()
        if (!name) continue
        // id は付けない(常に新規プリセットとして取り込み、既存・組み込みを壊さない)
        await api.upsertPreset({
          name,
          person: item?.person === 'first' ? 'first' : 'third',
          tone: String(item?.tone ?? '')
        })
        imported += 1
      }
      if (Object.keys(patch).length > 0) await save(patch)
      setStatus(`読み込みました(プリセット ${imported} 件${Object.keys(patch).length > 0 ? ' + プロンプト' : ''})`)
    } catch (e) {
      setStatus(`読み込みに失敗しました: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">プロンプトをまとめて書き出す / 読み込む</span>
        <div className="settings-field-controls">
          <button
            onClick={() => void handleExport()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            ⬆ 書き出し
          </button>
          <button
            onClick={() => importRef.current?.click()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            ⬇ 読み込み
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void handleImport(file)
            }}
          />
        </div>
      </div>
      <p className="settings-field-hint">
        シーン生成プロンプト・校正プロンプト・カスタムのスタイルプリセット(清書の文体指示)を
        1 つの JSON にまとめます。プロンプトはライブラリごとの設定なので、別のストーリーに
        持ち込むときに使います。読み込むとスタイルプリセットは<b>新規として追加</b>され
        (既存・組み込みは変わりません)、シーン生成・校正のプロンプトは<b>置き換え</b>られます。
        以前の `style-presets.json` もそのまま読み込めます。
      </p>
      {status && (
        <p className="settings-field-hint" style={{ color: 'var(--text-dim)' }}>
          {status}
        </p>
      )}
    </div>
  )
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// 外部バックアップ(zip 書き出し。docs/design/backup.md)。
// スナップショットがライブラリの中に置かれるのに対し、こちらは外へ持ち出して
// フォルダ消失・ディスク障害に備える。パス選択はネイティブダイアログ(Electron)、
// zip の読み書きはバックエンドが行う
function ExternalBackupSection(): React.JSX.Element {
  const [config, setConfig] = useState<BackupConfig | null>(null)
  const [includeSnapshots, setIncludeSnapshots] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setConfig(await api.getBackupConfig())
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const patchConfig = async (values: Parameters<typeof api.putBackupConfig>[0]): Promise<void> => {
    try {
      setConfig(await api.putBackupConfig(values))
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleExport = async (): Promise<void> => {
    if (busy) return
    try {
      const { name } = await api.suggestedBackupName()
      const path = await window.storyGraph.chooseBackupSaveFile(name, config?.dir ?? '')
      if (!path) return
      setBusy(true)
      setStatus('書き出しています…')
      const result = await api.exportBackup(path, includeSnapshots)
      setStatus(`書き出しました: ${result.path}(${fmtSize(result.size)} / 画像 ${result.assets} 件)`)
      setError(null)
      await reload()
    } catch (e) {
      setStatus(null)
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleBackupNow = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus('バックアップしています…')
    try {
      const result = await api.runAutoBackup()
      setStatus(result.path ? `保存しました: ${result.path}` : 'バックアップしました')
      setError(null)
      await reload()
    } catch (e) {
      setStatus(null)
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleChooseDir = async (): Promise<void> => {
    const dir = await window.storyGraph.chooseFolder('自動バックアップの保存先を選択')
    if (dir) await patchConfig({ dir })
  }

  // 保存先を開く。まだ無いフォルダは main 側で作ってから開くので、
  // 「押しても何も起きない」ようには見せない(開けなければ理由を出す)
  const handleOpenDir = async (dir: string): Promise<void> => {
    if (await window.storyGraph.openFolder(dir)) {
      setError(null)
      return
    }
    setError(`保存先フォルダを開けませんでした: ${dir}`)
  }

  const handleReveal = async (path: string): Promise<void> => {
    if (await window.storyGraph.revealInFolder(path)) {
      setError(null)
      return
    }
    setError(`ファイルが見つかりませんでした: ${path}`)
  }

  const handleRestore = async (): Promise<void> => {
    if (busy) return
    const zipPath = await window.storyGraph.chooseBackupZip()
    if (!zipPath) return
    setBusy(true)
    try {
      const info = await api.inspectBackup(zipPath)
      if (!info.has_db) {
        setError('story-graph のバックアップではないようです(story-graph.db が入っていません)')
        return
      }
      const when = info.created_at ? new Date(info.created_at).toLocaleString('ja-JP') : '不明'
      if (
        !window.confirm(
          `「${info.library_name ?? '(名前不明)'}」(${when} / 画像 ${info.assets} 件)を` +
            '新しいライブラリとして展開します。\n' +
            '次に展開先の空フォルダを選んでください。展開後はそのライブラリに切り替わります' +
            '(今のライブラリは変更されません)。'
        )
      ) {
        return
      }
      const dest = await window.storyGraph.chooseFolder('展開先のフォルダを選択(空のフォルダ)')
      if (!dest) return
      setStatus('展開しています…')
      const result = await api.restoreBackup(zipPath, dest)
      await window.storyGraph.switchLibrary(result.root)
      await api.switchLibrary(result.root)
      window.location.reload() // ライブラリ切替と同じ作法で全体を読み直す
      return
    } catch (e) {
      setStatus(null)
      setError(
        String(e).includes('409')
          ? '展開先に既にライブラリがあります。空のフォルダを選んでください'
          : String(e)
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">外部バックアップ(zip)</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIncludeSnapshots((v) => !v)}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={
              includeSnapshots
                ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
            }
            data-tip="スナップショット(ライブラリ内の時点保存)も zip に含めます。サイズが数十倍になります"
          >
            {includeSnapshots ? '☑' : '☐'} スナップショットも含める
          </button>
          <button
            onClick={() => void handleExport()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            zip に書き出す
          </button>
          <button
            onClick={() => void handleRestore()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip="zip を新しいライブラリとして展開して開きます(今のライブラリは変更しません)"
          >
            zip から復元
          </button>
        </div>
      </div>
      <p className="settings-field-hint">
        ライブラリ(シーン・イベント・清書・チャットの入った story-graph.db と、挿絵・立ち絵)を
        1 つの zip にまとめて<b>ライブラリの外へ</b>持ち出します。下のスナップショットは
        ライブラリの中にあるので、フォルダごと消えた・ディスクが壊れたという事故には
        こちらが要ります。復元は<b>新しいライブラリとして展開</b>するので、今のデータは上書きされません。
      </p>

      {config && (
        <>
          <div className="settings-field-header">
            <span className="settings-field-label">自動バックアップ(1 日 1 回)</span>
            <div className="settings-field-controls">
              <div
                className="flex overflow-hidden rounded-md border"
                style={{ borderColor: 'var(--border-strong)' }}
              >
                {(
                  [
                    [true, 'オン'],
                    [false, 'オフ']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={label}
                    onClick={() => void patchConfig({ enabled: value })}
                    className="px-2.5 py-0.5 text-[12px]"
                    style={
                      config.enabled === value
                        ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                        : { color: 'var(--text-faint)' }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                残す数
              </span>
              <input
                type="number"
                min={1}
                max={99}
                value={config.keep}
                onChange={(e) => setConfig({ ...config, keep: Number(e.target.value) })}
                // min/max はスピナーにしか効かない。空欄(Number('') = 0)や範囲外を
                // そのまま送ると、保持数 0 = 自動バックアップが全部消える
                onBlur={(e) => {
                  const keep = Math.min(99, Math.max(1, Math.round(Number(e.target.value)) || 1))
                  setConfig({ ...config, keep })
                  void patchConfig({ keep })
                }}
                className="w-14 rounded-md border px-2 py-0.5 text-[12px] outline-none"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
              />
              <button
                onClick={() => void handleBackupNow()}
                disabled={busy}
                className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              >
                今すぐバックアップ
              </button>
            </div>
          </div>
          <p className="settings-field-hint">
            <b>既定はオフ</b>です。オンにすると、アプリを開いたときに前回から 24 時間以上経っていれば
            このライブラリを zip にします(シーンが 1 つも無いライブラリは対象外)。
            古いものは「残す数」まで自動で消えます(手動の書き出しは消しません)。
            「今すぐバックアップ」はオフのままでも使えます。
            {config.last_at
              ? ` 最後のバックアップ: ${new Date(config.last_at).toLocaleString('ja-JP')}`
              : ' まだ一度も実行していません。'}
          </p>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="shrink-0" style={{ color: 'var(--text-faint)' }}>
              保存先
            </span>
            <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }} data-tip={config.dir}>
              {config.dir}
            </span>
            <button
              onClick={() => void patchConfig({ inside: !config.inside })}
              className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
              style={
                config.inside
                  ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                  : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
              }
              data-tip="既定はオン。ライブラリの中(<ライブラリ>/backups/)に置くので、ライブラリを切り替えても付いてきます"
            >
              {config.inside ? '☑' : '☐'} ライブラリの中
            </button>
            <button
              onClick={() => void handleChooseDir()}
              disabled={config.inside}
              className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip={
                config.inside
                  ? 'ライブラリの中に置く設定です。外のフォルダを使うにはオフにしてください'
                  : '保存先のフォルダを選びます'
              }
            >
              変更
            </button>
            <button
              onClick={() => void handleOpenDir(config.dir)}
              className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="保存先フォルダをエクスプローラーで開く"
            >
              開く
            </button>
          </div>
          <p className="settings-field-hint">
            <b>既定は「ライブラリの中」</b>です。`&lt;ライブラリ&gt;/backups/` に貯まるので、
            フォルダを丸ごと運べばバックアップも一緒に付いてきます(ライブラリを切り替えても迷子になりません)。
            ただし<b>フォルダごと失う事故には効かない</b>ので、そこまで備えるなら外のフォルダ
            (別ドライブやクラウド同期フォルダ)を選んでください。zip には画像・動画も入るため、
            中に置くとライブラリのサイズがその分ふくらみます。
          </p>
          {config.entries.map((entry) => (
            <div
              key={entry.path}
              className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
            >
              <span
                className="shrink-0 rounded px-1 text-[10px]"
                style={{
                  background: entry.kind === 'manual' ? 'var(--accent-soft)' : 'var(--bg-input)',
                  color: entry.kind === 'manual' ? 'var(--text)' : 'var(--text-faint)'
                }}
              >
                {entry.kind === 'manual' ? '手動' : '自動'}
              </span>
              <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
                {entry.name}
              </span>
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                {new Date(entry.modified_at).toLocaleString('ja-JP')} / {fmtSize(entry.size)}
              </span>
              <button
                onClick={() => void handleReveal(entry.path)}
                className="shrink-0 rounded-md px-1 text-[11px]"
                style={{ color: 'var(--text-faint)' }}
                aria-label="このファイルの場所を開く"
                data-tip="このファイルの場所を開く"
              >
                ⧉
              </button>
            </div>
          ))}
        </>
      )}
      {status && (
        <p className="settings-field-hint" style={{ color: 'var(--text-dim)' }}>
          {status}
        </p>
      )}
      {error && (
        <p className="settings-field-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}

// スナップショット(バックアップ)。危険な操作の前の自動保存 + 手動保存と復元
// (docs/design/snapshots.md)
function SnapshotsSection(): React.JSX.Element {
  const [items, setItems] = useState<Snapshot[]>([])
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setItems((await api.listSnapshots()).snapshots)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const handleCreate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await api.createSnapshot(label)
      setLabel('')
      await reload()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = async (snap: Snapshot): Promise<void> => {
    if (busy) return
    const when = new Date(snap.created_at).toLocaleString('ja-JP')
    if (
      !window.confirm(
        `「${snap.label}」(${when})の時点に戻しますか?\n` +
          '現在の状態は「復元の前」として自動保存されます。'
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await api.restoreSnapshot(snap.id)
      window.location.reload() // ライブラリ切替と同じ作法で全体を読み直す
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  const handleDelete = async (snap: Snapshot): Promise<void> => {
    if (busy) return
    if (!window.confirm(`スナップショット「${snap.label}」を削除しますか?`)) return
    setBusy(true) // 連打すると 2 発目の DELETE が 404 でエラー表示になる
    try {
      await api.deleteSnapshot(snap.id)
      await reload()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">スナップショット({items.length}件)</span>
        <div className="flex items-center gap-1.5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="名前(任意)"
            className="w-40 rounded-md border px-2 py-0.5 text-[12px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
          <button
            onClick={() => void handleCreate()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            今の状態を保存
          </button>
        </div>
      </div>
      <p className="settings-field-hint">
        シーンの削除・正史切替・イベント作り直しなどの前には自動で保存されます(自動分は直近 30 件まで)。
        復元するとライブラリ全体(シーン・イベント・清書・チャット)がその時点に戻ります。
      </p>
      {error && (
        <p className="settings-field-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {items.map((snap) => (
        <div
          key={snap.id}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
        >
          <span
            className="shrink-0 rounded px-1 text-[10px]"
            style={{
              background: snap.kind === 'manual' ? 'var(--accent-soft)' : 'var(--bg-input)',
              color: snap.kind === 'manual' ? 'var(--text)' : 'var(--text-faint)'
            }}
          >
            {snap.kind === 'manual' ? '手動' : '自動'}
          </span>
          <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
            {snap.label}
          </span>
          <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
            {new Date(snap.created_at).toLocaleString('ja-JP')} / {fmtSize(snap.size)}
          </span>
          <button
            onClick={() => void handleRestore(snap)}
            disabled={busy}
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            復元
          </button>
          <button
            onClick={() => void handleDelete(snap)}
            disabled={busy}
            className="shrink-0 rounded-md px-1 text-[11px] disabled:opacity-50"
            style={{ color: 'var(--danger)' }}
            aria-label="このスナップショットを削除"
            data-tip="このスナップショットを削除"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
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

function fmtBytes(bytes: number | null): string {
  if (bytes == null) return '?'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

function describeProgress(p: LlamaInstallProgress): string {
  if (p.phase === 'download') {
    const pct = p.percent != null ? ` ${p.percent}%` : ''
    return `${p.file_label} をダウンロード中${pct}(${fmtBytes(p.received)}${p.total ? ` / ${fmtBytes(p.total)}` : ''})`
  }
  if (p.phase === 'extract') return `${p.file_label} を展開中…`
  if (p.phase === 'done') return `インストール完了(${p.build ?? '?'})`
  return `エラー: ${p.message}`
}

// llama.cpp(llama-server)を GitHub リリースから自動ダウンロード/インストールする
function LlamaInstaller(): React.JSX.Element {
  const [serverStatus, setServerStatus] = useState<LlamaServerStatus | null>(null)
  const [releases, setReleases] = useState<LlamaRelease[]>([])
  const [selectedTag, setSelectedTag] = useState<string>('')
  const [selectedVariantKey, setSelectedVariantKey] = useState<string>('')
  const [loadingReleases, setLoadingReleases] = useState(false)
  // null = 自動判定(システムに CUDA ランタイムがあれば同梱しない)
  const [cudartChoice, setCudartChoice] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)
  const [removingDir, setRemovingDir] = useState<string | null>(null)
  const [progress, setProgress] = useState<LlamaInstallProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshStatus = async (): Promise<void> => {
    try {
      setServerStatus(await api.llamaServerStatus())
    } catch {
      setServerStatus(null)
    }
  }

  useEffect(() => {
    void refreshStatus()
    // セクションを離れたら進行中のダウンロードを止める(残すと画面から見えない
    // まま何 GB も落とし続け、止める手段もなくなる)
    return () => abortRef.current?.abort()
  }, [])

  const selectedRelease = releases.find((r) => r.tag === selectedTag) ?? releases[0]
  const selectedVariant: LlamaReleaseVariant | undefined =
    selectedRelease?.variants.find((v) => v.key === selectedVariantKey) ?? selectedRelease?.variants[0]

  const cudartSize = selectedVariant?.cudart_size_bytes ?? null
  const hasCudartAsset = selectedVariant?.family === 'cuda' && selectedVariant.cudart_url != null
  // 同じメジャーバージョンの CUDA ランタイムが PATH にあれば、DLL の同梱は要らない
  const systemHasCudart =
    selectedVariant?.cuda_version != null &&
    (serverStatus?.system_cudart ?? []).includes(selectedVariant.cuda_version)
  const includeCudart = hasCudartAsset ? cudartChoice ?? !systemHasCudart : false
  // 選択中のバリアントが既に入っていて、DLL だけ足りない状態か
  const selectedInstall = selectedVariant
    ? serverStatus?.installs.find(
        (i) =>
          (i.dir.split(/[\\/]/).pop() || '').toLowerCase() ===
          selectedVariant.asset_name.replace(/\.zip$/i, '').toLowerCase()
      )
    : undefined
  const canAddCudart = hasCudartAsset && selectedInstall != null && !selectedInstall.has_cudart

  const handleFetch = async (): Promise<void> => {
    setLoadingReleases(true)
    setError(null)
    try {
      const { releases: list } = await api.llamaReleases()
      setReleases(list)
      const first = list.find((r) => r.variants.length > 0) ?? list[0]
      if (first) {
        setSelectedTag(first.tag)
        setSelectedVariantKey(first.variants[0]?.key ?? '')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingReleases(false)
    }
  }

  const handleInstall = async (cudartOnly = false): Promise<void> => {
    if (!selectedVariant) return
    const controller = new AbortController()
    abortRef.current = controller
    setInstalling(true)
    setError(null)
    setDoneMsg(null)
    setProgress(null)
    try {
      await llamaInstallStream(
        selectedVariant,
        (p) => {
          setProgress(p)
          if (p.phase === 'error') setError(p.message)
          if (p.phase === 'done') setDoneMsg(`インストールが完了しました(${p.build ?? selectedVariant.label})`)
        },
        controller.signal,
        { includeCudart, cudartOnly }
      )
      await refreshStatus()
    } catch (e) {
      if (!isAbortError(e)) setError(String(e))
    } finally {
      abortRef.current = null
      setInstalling(false)
      // 進捗表示を畳んでボタン列へ戻す。ここで消さないと、中止・エラーの後に
      // 進捗ブロックだけが残ってインストールし直せなくなる(ボタンが出ない)
      setProgress(null)
    }
  }

  const handleUninstall = async (install: LlamaServerInstall): Promise<void> => {
    const name = install.dir.split(/[\\/]/).pop() || install.dir
    const freed = install.size_bytes != null ? `${fmtBytes(install.size_bytes)} を空けます。` : ''
    if (!window.confirm(`「${name}」を削除しますか?\n${freed}\n必要になったら同じビルドを入れ直せます。`)) return
    setRemovingDir(install.dir)
    setError(null)
    try {
      setServerStatus(await api.llamaUninstall(install.dir))
    } catch (e) {
      setError(String(e))
      await refreshStatus()
    } finally {
      setRemovingDir(null)
    }
  }

  const totalSize = selectedVariant ? selectedVariant.size_bytes + (includeCudart ? cudartSize ?? 0 : 0) : 0

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">llama-server の自動インストール</span>
        <div className="settings-field-controls">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: serverStatus?.installed ? '#3ecf8e' : 'var(--text-faint)' }}
          />
          <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            {serverStatus?.installed ? `導入済み(${serverStatus.build ?? '?'})` : '未導入'}
          </span>
        </div>
      </div>
      {serverStatus && serverStatus.installs.length > 0 && (
        <div className="flex flex-col gap-1">
          {serverStatus.installs.map((ins) => {
            const name = ins.dir.split(/[\\/]/).pop() || ins.dir
            const isDefault = ins.path === serverStatus.path
            return (
              <div
                key={ins.path}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
                style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
              >
                {isDefault && (
                  <span
                    className="shrink-0 rounded px-1 text-[10px]"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                    data-tip="実行ファイルのパスが未入力のとき、このビルドが使われます"
                  >
                    既定
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }} data-tip={ins.path}>
                  {name}
                </span>
                {ins.is_cuda && !ins.has_cudart && (
                  <span
                    className="shrink-0 rounded px-1 text-[10px]"
                    style={{ background: 'var(--bg-input)', color: 'var(--text-faint)' }}
                    data-tip={
                      serverStatus.system_cudart.includes(ins.cuda_version ?? '')
                        ? `CUDA ランタイム DLL は同梱していません(この PC の CUDA ${ins.cuda_version} を使います)`
                        : 'CUDA ランタイム DLL は同梱していません。起動に失敗するときは、リリース一覧から同じビルドを選んで「CUDA ランタイムだけ追加」してください'
                    }
                  >
                    DLL 未同梱
                  </span>
                )}
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                  {fmtBytes(ins.size_bytes ?? null)}
                </span>
                <button
                  onClick={() => void handleUninstall(ins)}
                  disabled={!ins.removable || installing || removingDir !== null}
                  className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                  style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                  data-tip={
                    ins.removable
                      ? 'このフォルダを丸ごと消して容量を空けます'
                      : `自動インストール先(${serverStatus.runtime_dir})の外にあるので、このアプリからは消しません`
                  }
                >
                  {removingDir === ins.dir ? '削除中…' : '削除'}
                </button>
              </div>
            )
          })}
          <p className="settings-field-hint">
            インストール済み {serverStatus.installs.length} 件・合計 {fmtBytes(serverStatus.total_size_bytes)}。
            起動中のサーバは削除できません(先に停止してください)。
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void handleFetch()}
          disabled={loadingReleases || installing}
          className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        >
          {loadingReleases ? '取得中…' : releases.length ? '⟳ リリース一覧を更新' : 'リリース一覧を取得'}
        </button>
      </div>

      {releases.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <select
              value={selectedRelease?.tag ?? ''}
              onChange={(e) => {
                setSelectedTag(e.target.value)
                const rel = releases.find((r) => r.tag === e.target.value)
                setSelectedVariantKey(rel?.variants[0]?.key ?? '')
                setCudartChoice(null)
              }}
              disabled={installing}
              className="rounded-lg border px-2 py-1.5 text-[13px]"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            >
              {releases.map((r) => (
                <option key={r.tag} value={r.tag}>
                  {r.tag}
                  {r.published_at ? `(${r.published_at.slice(0, 10)})` : ''}
                </option>
              ))}
            </select>
            <select
              value={selectedVariant?.key ?? ''}
              onChange={(e) => {
                setSelectedVariantKey(e.target.value)
                setCudartChoice(null)
              }}
              disabled={installing}
              className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-[13px]"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            >
              {selectedRelease?.variants.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label}・{fmtBytes(v.size_bytes)}
                </option>
              ))}
            </select>
          </div>
          {hasCudartAsset && (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setCudartChoice(!includeCudart)}
                disabled={installing}
                className="self-start rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                style={
                  includeCudart
                    ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                    : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
                }
                data-tip="CUDA ランタイム DLL(cudart / cublas)を llama-server.exe と同じフォルダに置きます"
              >
                {includeCudart ? '☑' : '☐'} CUDA ランタイム DLL も一緒に落とす({fmtBytes(cudartSize)})
              </button>
              <p className="settings-field-hint">
                {systemHasCudart
                  ? `CUDA ${selectedVariant?.cuda_version} のランタイムがこの PC の PATH にあるので、通常は不要です。動かないときだけ入れてください。`
                  : 'CUDA Toolkit を入れている場合は外せます。外して起動に失敗したら、あとから DLL だけ追加できます。'}
              </p>
            </div>
          )}

          {installing || progress ? (
            <div className="flex flex-col gap-1.5">
              <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border-strong)' }}>
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${progress?.phase === 'download' ? progress.percent ?? 0 : progress ? 100 : 0}%`,
                    background: 'var(--accent)'
                  }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: progress?.phase === 'error' ? 'var(--danger)' : 'var(--text-dim)' }}>
                  {progress ? describeProgress(progress) : '準備中…'}
                </span>
                {installing && (
                  <button
                    onClick={() => abortRef.current?.abort()}
                    className="rounded-md border px-2 py-0.5 text-[12px]"
                    style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                  >
                    中止
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void handleInstall()}
                disabled={!selectedVariant}
                className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                ⬇ インストール({totalSize ? fmtBytes(totalSize) : '—'})
              </button>
              {canAddCudart && (
                <button
                  onClick={() => void handleInstall(true)}
                  className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip="このビルドはインストール済みです。本体は落とし直さず、CUDA ランタイム DLL だけ同じフォルダに足します"
                >
                  CUDA ランタイムだけ追加({fmtBytes(cudartSize)})
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {doneMsg && !error && (
        <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          ✓ {doneMsg}
        </p>
      )}
      <p className="settings-field-hint">
        GitHub の ggml-org/llama.cpp から Windows 版をダウンロードし、<code>runtime/</code> 配下に配置します。
        導入後は手入力の実行ファイルパスが空でも自動で検出されます。
      </p>
    </div>
  )
}

// 画像生成の既定値(backend/comfy.py と同じ。Qwen-Image Rapid AIO の推奨値)
const COMFY_DEFAULTS = { steps: '4', cfg: '1', shift: '3.1' } as const
const COMFY_DEFAULT_NEGATIVE = 'text, watermark, signature, blurry, low quality, extra limbs, deformed hands'

// ComfyUI の稼働・モデルフォルダ・チェックポイント・生成パラメータ・インストール
// (docs/design/image-gen.md)。llama の「推論エンジン」と同じ並びにしてある
function ImageGenSection({
  values,
  setValues,
  save
}: {
  values: Record<string, string>
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  save: (patch: Record<string, string>) => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkpoints, setCheckpoints] = useState<string[]>([])
  const [releases, setReleases] = useState<ComfyRelease[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [loadingReleases, setLoadingReleases] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<LlamaInstallProgress | null>(null)
  const [removing, setRemoving] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const busyElapsed = useElapsedSeconds(busy !== null)

  const refresh = async (): Promise<void> => {
    try {
      const s = await api.comfyStatus()
      setStatus(s)
      if (s.healthy) {
        const r = await api.comfyModels('checkpoints')
        setCheckpoints(r.models)
      }
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    void refresh()
    return () => abortRef.current?.abort()
  }, [])

  const handleStart = async (): Promise<void> => {
    setBusy('ComfyUI を起動中…(初回は 1 分ほどかかります)')
    setError(null)
    try {
      await api.comfyStart()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const handleStop = async (): Promise<void> => {
    setBusy('停止中…')
    try {
      await api.comfyStop()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const handleChooseModelsDir = async (): Promise<void> => {
    const dir = await window.storyGraph.chooseFolder('ComfyUI のモデルフォルダ(checkpoints / loras … の親)を選択')
    if (!dir) return
    await save({ comfy_models_dir: dir })
    void refresh()
  }

  const handleFetch = async (): Promise<void> => {
    setLoadingReleases(true)
    setError(null)
    try {
      const { releases: list } = await api.comfyReleases()
      setReleases(list)
      const first = list.find((r) => r.variants.length > 0)
      setSelectedKey(first?.variants[0]?.key ?? '')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingReleases(false)
    }
  }

  const allVariants = releases.flatMap((r) => r.variants.map((v) => ({ ...v, tag: r.tag })))
  const selectedVariant: (ComfyReleaseVariant & { tag: string }) | undefined =
    allVariants.find((v) => v.key === selectedKey) ?? allVariants[0]

  const handleInstall = async (): Promise<void> => {
    if (!selectedVariant) return
    const controller = new AbortController()
    abortRef.current = controller
    setInstalling(true)
    setError(null)
    setProgress(null)
    try {
      await comfyInstallStream(
        selectedVariant,
        (p) => {
          setProgress(p)
          if (p.phase === 'error') setError(p.message)
        },
        controller.signal
      )
      await refresh()
    } catch (e) {
      if (!isAbortError(e)) setError(String(e))
    } finally {
      abortRef.current = null
      setInstalling(false)
      setProgress(null)
    }
  }

  const handleUninstall = async (): Promise<void> => {
    if (!status?.installed) return
    if (!window.confirm(`runtime/comfyui(${fmtBytes(status.size_bytes)})を削除しますか?\nモデルフォルダは消しません。`)) return
    setRemoving(true)
    setError(null)
    try {
      await api.comfyUninstall()
    } catch (e) {
      setError(String(e))
    } finally {
      setRemoving(false)
      void refresh()
    }
  }

  const currentCkpt = values.comfy_checkpoint ?? ''
  const numField = (key: 'comfy_steps' | 'comfy_cfg' | 'comfy_shift', label: string, fallback: string, hint: string) => (
    <div className="settings-field" key={key}>
      <div className="settings-field-header">
        <span className="settings-field-label">{label}</span>
      </div>
      <input
        value={values[key] ?? ''}
        placeholder={fallback}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
        onBlur={() => void save({ [key]: values[key] ?? '' })}
        className="w-32 rounded-md border px-2 py-0.5 text-[12px] outline-none"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
      />
      <p className="settings-field-hint">{hint}</p>
    </div>
  )

  return (
    <>
      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">ComfyUI</span>
            <div className="settings-field-controls">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: status?.healthy ? '#3ecf8e' : 'var(--danger)' }}
              />
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {status?.healthy ? '稼働中' : status?.loading ? '起動中' : '停止'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleStart()}
              disabled={busy !== null || status?.healthy || (!status?.installed && !values.comfy_base_url)}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-tip={
                !status?.installed && !values.comfy_base_url
                  ? '下の「自動インストール」で ComfyUI を入れるか、起動済みの ComfyUI の URL を設定してください'
                  : undefined
              }
            >
              起動
            </button>
            <button
              onClick={() => void handleStop()}
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
          {error && (
            <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}
          <p className="settings-field-hint">
            キャラクターの参照画像を作るときに停止していれば自動起動します。外部で起動済みの ComfyUI があればそれを優先します。
            LLM(31B)と同時に載せるので、VRAM が足りないときは先に LLM を停止してください。
          </p>
        </div>
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">ComfyUI の URL</span>
          </div>
          <input
            value={values.comfy_base_url ?? ''}
            placeholder="http://127.0.0.1:8188"
            onChange={(e) => setValues((v) => ({ ...v, comfy_base_url: e.target.value }))}
            onBlur={() => void save({ comfy_base_url: values.comfy_base_url ?? '' })}
            className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
          <p className="settings-field-hint">空欄なら既定(127.0.0.1:8188)。自動起動もこのポートで行います。</p>
        </div>
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">モデルフォルダ</span>
            <div className="settings-field-controls">
              {(values.comfy_models_dir ?? '') !== '' && (
                <button
                  onClick={() => void save({ comfy_models_dir: '' }).then(refresh)}
                  className="rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip={`既定(${status?.default_models_dir ?? ''}。無ければ ComfyUI 同梱の models/)に戻します`}
                >
                  既定に戻す
                </button>
              )}
              <button
                onClick={() => void handleChooseModelsDir()}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="checkpoints / loras / vae … が並ぶフォルダを選びます"
              >
                変更
              </button>
            </div>
          </div>
          <span className="block truncate text-[12px]" style={{ color: 'var(--text)' }} data-tip={status?.models_dir}>
            {status?.models_dir || '(ComfyUI 同梱の models/ のみ)'}
          </span>
          <p className="settings-field-hint">
            コピーやリンクはせず、ComfyUI の extra_model_paths.yaml にこのフォルダを書いて読ませます。変更は次回の起動から反映されます。
          </p>
        </div>
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">チェックポイント(Qwen-Image 系 AIO)</span>
            <div className="settings-field-controls">
              <button
                onClick={() => void refresh()}
                disabled={!status?.healthy}
                className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip={status?.healthy ? 'ComfyUI が見つけているモデルを取り直す' : '一覧は ComfyUI の稼働中だけ取れます'}
              >
                ⟳ 一覧
              </button>
            </div>
          </div>
          <select
            value={currentCkpt}
            onChange={(e) => void save({ comfy_checkpoint: e.target.value })}
            className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          >
            <option value="">{checkpoints.length ? '(選んでください)' : status?.healthy ? 'checkpoints にモデルがありません' : '(ComfyUI を起動すると一覧が出ます)'}</option>
            {checkpoints.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {currentCkpt && !checkpoints.includes(currentCkpt) && <option value={currentCkpt}>{currentCkpt}</option>}
          </select>
          <p className="settings-field-hint">
            VAE とテキストエンコーダを 1 ファイルにまとめた AIO 版(Qwen-Rapid-AIO など)を前提にしています。
          </p>
        </div>
        {numField('comfy_steps', 'ステップ数', COMFY_DEFAULTS.steps, 'Rapid AIO は 4〜8。多いほど遅くなります。')}
        {numField('comfy_cfg', 'CFG', COMFY_DEFAULTS.cfg, '蒸留モデルは 1 固定が前提。上げると破綻しやすくなります。')}
        {numField('comfy_shift', 'シフト(ModelSamplingAuraFlow)', COMFY_DEFAULTS.shift, 'Qwen-Image の推奨は 3 前後。')}
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">ネガティブプロンプト</span>
          </div>
          <AutoTextarea
            minRows={2}
            value={values.comfy_negative ?? ''}
            placeholder={COMFY_DEFAULT_NEGATIVE}
            onChange={(next) => setValues((v) => ({ ...v, comfy_negative: next }))}
            onBlur={() => void save({ comfy_negative: values.comfy_negative ?? '' })}
            className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
          <p className="settings-field-hint">空欄はプレースホルダの値。欄外クリックで保存されます。</p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">ComfyUI の自動インストール</span>
            <div className="settings-field-controls">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: status?.installed ? '#3ecf8e' : 'var(--text-faint)' }}
              />
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {status?.installed ? `導入済み(${status.install?.version ?? '?'})` : '未導入'}
              </span>
            </div>
          </div>
          {status?.installed && status.install && (
            <div
              className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
            >
              <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }} data-tip={status.install.root}>
                {status.install.dir.split(/[\\/]/).pop()}
                {status.install.backend ? `(${status.install.backend})` : ''}
              </span>
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                {fmtBytes(status.size_bytes)}
              </span>
              <button
                onClick={() => void handleUninstall()}
                disabled={installing || removing || status.spawned}
                className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                data-tip={status.spawned ? '起動中は削除できません(先に停止してください)' : 'このフォルダを丸ごと消して容量を空けます'}
              >
                {removing ? '削除中…' : '削除'}
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void handleFetch()}
              disabled={loadingReleases || installing}
              className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            >
              {loadingReleases ? '取得中…' : releases.length ? '⟳ リリース一覧を更新' : 'リリース一覧を取得'}
            </button>
          </div>
          {allVariants.length > 0 && (
            <div className="mt-1 flex flex-col gap-2">
              <select
                value={selectedVariant?.key ?? ''}
                onChange={(e) => setSelectedKey(e.target.value)}
                disabled={installing}
                className="w-full rounded-lg border px-2 py-1.5 text-[13px]"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
              >
                {allVariants.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.tag}・{v.label}・{fmtBytes(v.size_bytes)}
                  </option>
                ))}
              </select>
              {installing || progress ? (
                <div className="flex flex-col gap-1.5">
                  <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border-strong)' }}>
                    <div
                      className="h-full rounded-full transition-[width] duration-300"
                      style={{
                        width: `${progress?.phase === 'download' ? progress.percent ?? 0 : progress ? 100 : 0}%`,
                        background: 'var(--accent)'
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: progress?.phase === 'error' ? 'var(--danger)' : 'var(--text-dim)' }}>
                      {progress ? describeProgress(progress) : '準備中…'}
                    </span>
                    {installing && (
                      <button
                        onClick={() => abortRef.current?.abort()}
                        className="rounded-md border px-2 py-0.5 text-[12px]"
                        style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                      >
                        中止
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => void handleInstall()}
                  disabled={!selectedVariant || status?.spawned}
                  className="self-start rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}
                  data-tip={status?.spawned ? '起動中は入れ替えられません(先に停止してください)' : undefined}
                >
                  ⬇ インストール({selectedVariant ? fmtBytes(selectedVariant.size_bytes) : '—'})
                </button>
              )}
            </div>
          )}
          <p className="settings-field-hint">
            GitHub の Comfy-Org/ComfyUI から Windows portable 版(Python 同梱、約 2GB。展開後 5GB 級)をダウンロードし、
            <code>runtime/comfyui/</code> に配置します。展開には数分かかります。モデルは含まれないので、上のモデルフォルダから読みます。
          </p>
        </div>
      </div>
    </>
  )
}

export default function SettingsMode(): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  // 左ナビで選んでいるセクション。開き直したときに同じ場所へ戻れるよう覚える
  const [section, setSection] = useState<SectionId>(() => {
    const saved = localStorage.getItem('settingsSection')
    return SECTIONS.some((s) => s.id === saved) ? (saved as SectionId) : 'engine'
  })
  const [savedMsg, setSavedMsg] = useState(false)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [currentModel, setCurrentModel] = useState<string>('')
  // モデルを探しているフォルダ(バックエンドが解決した実際のパス)と、その既定値
  const [modelsDir, setModelsDir] = useState<{ dir: string; fallback: string; exists: boolean } | null>(null)
  const [modelsDirError, setModelsDirError] = useState<string | null>(null)
  const [genPromptDefault, setGenPromptDefault] = useState('')
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
    void api.getSettings().then(setValues)
    void refreshStatus()
    void loadModels()
    void api.getGenerationPrompt().then((r) => setGenPromptDefault(r.default))
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
    if (Object.keys(patch).length > 0) await api.putSettings(patch)
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
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => {
                setSection(id)
                localStorage.setItem('settingsSection', id)
              }}
              className="mb-0.5 block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors"
              style={
                section === id
                  ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                  : { color: 'var(--text-faint)' }
              }
            >
              {label}
            </button>
          ))}
        </div>
        {/* 保存の合図はどのセクションでも同じ場所に出す */}
        <p className="h-5 px-3 pb-2 text-[11px]" style={{ color: 'var(--accent)' }}>
          {savedMsg ? '保存しました' : ''}
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

          <Section id="generation" current={section} title="シーン生成プロンプト">
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
                  空欄ならプレースホルダのデフォルトが使われます。末尾に JSON 形式の指定と
                  イベント発行ルール(char_introduce 必須 / delta 範囲 等)が自動で追加されます。
                </p>
              </div>
            </div>
          </Section>

          <Section id="proofread" current={section} title="校正">
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

          <Section id="presets" current={section} title="スタイルプリセット(清書の文体指示)">
            <div className="settings-card">
              <StylePresetsSection />
            </div>
          </Section>

          <Section id="promptio" current={section} title="プロンプトの書き出し / 読み込み">
            <div className="settings-card">
              <PromptIoSection values={values} save={save} />
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
