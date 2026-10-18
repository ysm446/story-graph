import { useEffect, useRef, useState } from 'react'
import {
  api,
  comfyInstallStream,
  isAbortError,
  type ComfyRelease,
  type ComfyReleaseVariant,
  type ComfyStatus,
  type LlamaInstallProgress,
  type WorkflowVariant
} from '../../api'
import AutoTextarea from '../../AutoTextarea'
import { useElapsedSeconds } from '../../useElapsed'
import { describeProgress, fmtBytes } from './format'

const COMFY_DEFAULT_NEGATIVE = 'text, watermark, signature, blurry, low quality, extra limbs, deformed hands'

// ComfyUI の稼働・モデルフォルダ・既定のワークフロー・ネガティブプロンプト・インストール
// (docs/design/image-gen.md)。llama の「推論エンジン」と同じ並びにしてある。
// モデル名と steps / cfg / shift はワークフローの組(workflows/variants.json)が持つので、ここでは選ばない
export default function ImageGenSection({
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
  // ワークフローの組と、組ごとに足りないモデル(ComfyUI が止まっていれば missing は null)
  const [workflows, setWorkflows] = useState<WorkflowVariant[]>([])
  const [defaultWorkflow, setDefaultWorkflow] = useState('')
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
      setStatus(await api.comfyStatus())
    } catch {
      setStatus(null)
    }
    try {
      const r = await api.comfyWorkflows(true)
      setWorkflows(r.variants)
      setDefaultWorkflow(r.default)
    } catch {
      setWorkflows([])
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

  const selectedWorkflow = workflows.find((w) => w.id === defaultWorkflow)
  const autoToggles: [string, string][] = [
    ['comfy_auto_character_images', '人物を作ったら画像も作る'],
    ['comfy_auto_place_images', '場所を作ったら画像も作る']
  ]
  const missingOf = (w: WorkflowVariant): Set<string> => new Set((w.missing ?? []).map((m) => `${m.folder}/${m.key}`))

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
              className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
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
              className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
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
            <p className="text-[12px]" style={{ color: 'var(--danger-text)' }}>
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
            className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
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
            <span className="settings-field-label">既定のワークフロー</span>
            <div className="settings-field-controls">
              <button
                onClick={() => void refresh()}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="workflows/variants.json を読み直し、モデルがそろっているかを確かめ直す"
              >
                ⟳ 確かめる
              </button>
            </div>
          </div>
          <select
            value={selectedWorkflow?.id ?? ''}
            onChange={(e) => {
              setDefaultWorkflow(e.target.value)
              void save({ comfy_workflow: e.target.value })
            }}
            disabled={workflows.length === 0}
            aria-label="既定のワークフロー"
            className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none disabled:opacity-50"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          >
            {workflows.length === 0 && <option value="">(ワークフローの一覧を読めません)</option>}
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
                {w.missing && w.missing.length > 0 ? '(モデルが足りません)' : ''}
              </option>
            ))}
          </select>
          {selectedWorkflow?.models && selectedWorkflow.models.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-[12px]" aria-label="このワークフローが使うモデル">
              {selectedWorkflow.models.map((m) => {
                const missing = missingOf(selectedWorkflow).has(`${m.folder}/${m.key}`)
                return (
                  <li key={`${m.folder}/${m.key}`} className="flex min-w-0 items-baseline gap-2">
                    <span className="w-28 shrink-0" style={{ color: 'var(--text-faint)' }}>
                      {m.folder}
                    </span>
                    <span className="min-w-0 truncate" style={{ color: missing ? 'var(--danger-text)' : 'var(--text-dim)' }} data-tip={m.name || undefined}>
                      {m.name || `(${m.key} が variants.json に書かれていません)`}
                    </span>
                    {missing && m.name && (
                      <span className="shrink-0" style={{ color: 'var(--danger-text)' }}>
                        見つかりません
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {selectedWorkflow && selectedWorkflow.missing === null && (
            <p className="settings-field-hint">ComfyUI が止まっているので、モデルがそろっているかは確かめていません(起動すると確かめます)。</p>
          )}
          <p className="settings-field-hint">
            新しく描くとき、生成ウインドウで最初に選ばれている組です(その場で別の組に変えられます)。描いたことのある絵は、そのとき使った組で開きます。
            使うモデルや steps・CFG は組ごとに workflows/variants.json に書いてあります。
          </p>
        </div>
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">制作モードの自動生成</span>
            <div className="settings-field-controls">
              {autoToggles.map(([key, label]) => {
                const on = (values[key] ?? '') === '1'
                return (
                  <button
                    key={key}
                    onClick={() => {
                      const next = on ? '' : '1'
                      setValues((v) => ({ ...v, [key]: next }))
                      void save({ [key]: next })
                    }}
                    aria-pressed={on}
                    className="rounded-md border px-2 py-0.5 text-[11px]"
                    style={
                      on
                        ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                        : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
                    }
                  >
                    {on ? '☑' : '☐'} {label}
                  </button>
                )
              })}
            </div>
          </div>
          <p className="settings-field-hint">
            制作チャットが人物・場所を作ると、作業の終わりに画像を描きます。人物は外見から参照画像(全身)を描いてストックに入れ、それを手本に顔のアップを描いてプロフィール画像にします。
            場所は説明から全景を描いてストックに入れます。既定のワークフローで描き、1 件あたり 30〜60 秒かかります。
            オフでも、制作チャットに「〇〇の画像を作って」と頼めば描きます(画像があっても描き直し、前の画像はストックに残ります)。
          </p>
        </div>
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
            className="w-full rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none"
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
                className="delete-action shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
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
              className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
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
                className="w-full rounded-lg border px-3 py-1.5 text-[13px]"
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
                    <span className="text-[12px]" style={{ color: progress?.phase === 'error' ? 'var(--danger-text)' : 'var(--text-dim)' }}>
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
                  className="self-start rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
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
