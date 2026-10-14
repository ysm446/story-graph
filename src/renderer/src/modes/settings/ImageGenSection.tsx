import { useEffect, useRef, useState } from 'react'
import {
  api,
  comfyInstallStream,
  isAbortError,
  type ComfyRelease,
  type ComfyReleaseVariant,
  type ComfyStatus,
  type LlamaInstallProgress
} from '../../api'
import AutoTextarea from '../../AutoTextarea'
import { useElapsedSeconds } from '../../useElapsed'
import { describeProgress, fmtBytes } from './format'

// 画像生成の既定値(backend/comfy.py と同じ。Qwen-Image Rapid AIO の推奨値)
const COMFY_DEFAULTS = { steps: '4', cfg: '1', shift: '3.1' } as const
const COMFY_DEFAULT_NEGATIVE = 'text, watermark, signature, blurry, low quality, extra limbs, deformed hands'

// ComfyUI の稼働・モデルフォルダ・チェックポイント・生成パラメータ・インストール
// (docs/design/image-gen.md)。llama の「推論エンジン」と同じ並びにしてある
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
