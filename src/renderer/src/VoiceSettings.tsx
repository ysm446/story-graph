import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { api, isAbortError, ttsInstallStream, type TtsInstallProgress, type TtsStatus } from './api'
import AutoTextarea from './AutoTextarea'
import { useElapsedSeconds } from './useElapsed'
import { fmtBytes } from './modes/settings/format'
import { askConfirm } from './ConfirmDialog'

// 設定 →「音声読み上げ」。この PC に持つ TTS の環境: サーバーの稼働・接続先・モデルフォルダ・追加パラメータ・
// インストール(docs/design/voice.md)。画像生成(ComfyUI)のセクションと同じ並びにしてある。
// 声・読み辞書・読み方・音声キャッシュ(作品ごと)は「読み上げの声」(VoiceLibrarySettings.tsx)に置く
export default function VoiceSettingsSection({
  values,
  setValues,
  save
}: {
  values: Record<string, string>
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  save: (patch: Record<string, string>) => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = useState<TtsStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [removing, setRemoving] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const busyElapsed = useElapsedSeconds(busy !== null)
  const installElapsed = useElapsedSeconds(installing)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await api.ttsStatus())
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    void refresh()
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const handleStart = async (): Promise<void> => {
    setBusy('起動しています…(初回はモデルの取得で数分かかります)')
    setError(null)
    try {
      await api.ttsStart()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const handleStop = async (): Promise<void> => {
    setBusy('停止しています…')
    try {
      await api.ttsStop()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const handleChooseModelsDir = async (): Promise<void> => {
    const dir = await window.storyGraph.chooseFolder('TTS のモデルフォルダを選択')
    if (!dir) return
    await save({ tts_models_dir: dir })
    void refresh()
  }

  // サーバー本体の置き場(エンジンごと)。ほかのアプリと共用する実行環境を指すための設定で、
  // 指した先はアプリからは消さない(外すのは「既定に戻す」。フォルダは残る)
  const serverDirKey = status ? `tts_server_dir_${status.engine.id}` : null

  const handleChooseServerDir = async (): Promise<void> => {
    if (!serverDirKey) return
    const dir = await window.storyGraph.chooseFolder('TTS サーバーの置き場を選択')
    if (!dir) return
    await save({ [serverDirKey]: dir })
    void refresh()
  }

  const handleInstall = async (): Promise<void> => {
    const controller = new AbortController()
    abortRef.current = controller
    setInstalling(true)
    setError(null)
    setStep(null)
    setLogLines([])
    try {
      await ttsInstallStream((p: TtsInstallProgress) => {
        if (p.phase === 'step') setStep(p.label)
        else if (p.phase === 'log') setLogLines((lines) => [...lines, p.line].slice(-8))
        else if (p.phase === 'done') setStep(`インストールしました(${p.seconds} 秒)`)
        else if (p.phase === 'error') setError(p.message)
      }, controller.signal)
    } catch (e) {
      if (!isAbortError(e)) setError(String(e))
      else
        setStep(
          status?.install_external
            ? '中止しました(途中まで入ったフォルダは残っています。やり直すときは手で空にしてください)'
            : '中止しました(途中まで入ったフォルダは、次のインストールで消してからやり直します)'
        )
    } finally {
      abortRef.current = null
      setInstalling(false)
      void refresh()
    }
  }

  const handleUninstall = async (): Promise<void> => {
    if (!status) return
    const size = status.installed ? `(${fmtBytes(status.size_bytes)})` : ''
    if (!(await askConfirm(`${status.install_dir}${size} を削除しますか?\nモデルフォルダは消しません。`, '削除'))) return
    setRemoving(true)
    setError(null)
    try {
      await api.ttsUninstall()
    } catch (e) {
      setError(String(e))
    } finally {
      setRemoving(false)
      void refresh()
    }
  }

  const textField = (key: string, label: string, placeholder: string, hint: string, width = 'w-full'): React.JSX.Element => (
    <div className="settings-field" key={key}>
      <div className="settings-field-header">
        <span className="settings-field-label">{label}</span>
      </div>
      <input
        value={values[key] ?? ''}
        placeholder={placeholder}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
        onBlur={() => void save({ [key]: values[key] ?? '' })}
        className={`${width} rounded-lg border px-3 py-1.5 text-[13px] outline-none`}
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
      />
      <p className="settings-field-hint">{hint}</p>
    </div>
  )

  const engineLabel = status?.engine.label ?? 'TTS'
  const canStart = !!status && !status.healthy && (status.installed || !!values.tts_base_url)

  return (
    <>
      <p className="settings-field-hint">
        声の作成と割り当て・読み辞書・読み上げの速さは、「この作品」の「読み上げの声」にあります。
      </p>
      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">{engineLabel}</span>
            <div className="settings-field-controls">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: status?.healthy ? 'var(--ok)' : 'var(--danger)' }}
              />
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {status?.healthy ? (status.external ? '稼働中(外部で起動)' : '稼働中') : status?.loading ? '起動中' : '停止'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleStart()}
              disabled={busy !== null || !canStart}
              className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-tip={
                status && !status.installed && !values.tts_base_url
                  ? '下の「自動インストール」で入れるか、起動済みの TTS サーバーの URL を設定してください'
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
              data-tip={status?.external ? '外部で起動したサーバーは止めません' : 'プロセスごと止めて VRAM を解放します'}
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
            <p className="whitespace-pre-wrap text-[12px]" style={{ color: 'var(--danger-text)' }}>
              {error}
            </p>
          )}
          <p className="settings-field-hint">
            鑑賞モードで読み上げるときに停止していれば自動で起動します。ComfyUI と同時に使うと VRAM が足りなくなるので、
            画像生成の前には右上の ⏏ で止めてください。
          </p>
        </div>
        {status && status.engines.length > 1 && (
          <div className="settings-field">
            <div className="settings-field-header">
              <span className="settings-field-label">エンジン</span>
            </div>
            <select
              value={status.engine.id}
              onChange={(e) => void save({ tts_engine: e.target.value }).then(refresh)}
              className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            >
              {status.engines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <p className="settings-field-hint">
              エンジンは <code>tts_engines/*.json</code> の定義から選びます。切り替えると、動いている別のエンジンは止めてから起動します。
            </p>
          </div>
        )}
        {textField(
          'tts_base_url',
          'TTS サーバーの URL',
          status?.base_url ?? 'http://127.0.0.1:8088',
          '空欄ならエンジンの既定のポート。自動起動もこのポートで行います。OpenAI 互換の /v1/audio/speech を持つサーバーならつなげます。'
        )}
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">モデルフォルダ</span>
            <div className="settings-field-controls">
              {(values.tts_models_dir ?? '') !== '' && (
                <button
                  onClick={() => void save({ tts_models_dir: '' }).then(refresh)}
                  className="rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip={`既定(${status?.default_models_dir ?? ''}。無ければエンジンの既定のキャッシュ)に戻します`}
                >
                  既定に戻す
                </button>
              )}
              <button
                onClick={() => void handleChooseModelsDir()}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="モデルを置くフォルダを選びます"
              >
                変更
              </button>
            </div>
          </div>
          <span className="block truncate text-[12px]" style={{ color: 'var(--text)' }} data-tip={status?.models_dir}>
            {status?.models_dir || '(エンジンの既定のキャッシュ)'}
          </span>
          <p className="settings-field-hint">
            初回の起動時に Hugging Face から取得したモデルを、このフォルダの hf-cache/ に溜めます。変更は次回の起動から反映されます。
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">追加パラメータ(JSON)</span>
          </div>
          <AutoTextarea
            minRows={2}
            value={values.tts_extra_body ?? ''}
            placeholder='{"irodori": {"num_steps": 24}}'
            onChange={(next) => setValues((v) => ({ ...v, tts_extra_body: next }))}
            onBlur={() => void save({ tts_extra_body: values.tts_extra_body ?? '' })}
            className="w-full rounded-lg border px-3 py-1.5 font-mono text-[13px] leading-relaxed outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
          <p className="settings-field-hint">
            /v1/audio/speech の本文にそのまま重ねます(エンジン固有のパラメータ用)。ステップ数を減らすと速く、増やすと丁寧になります。
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">{engineLabel} の自動インストール</span>
            <div className="settings-field-controls">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: status?.installed ? 'var(--ok)' : 'var(--text-faint)' }}
              />
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {status?.installed
                  ? `導入済み(${status.install?.commit ?? '?'}・${status.install?.installed_at ?? ''})`
                  : status?.incomplete
                    ? '途中で止まっています'
                    : '未導入'}
              </span>
            </div>
          </div>
          {(status?.installed || status?.incomplete) && (
            <div
              className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
            >
              <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }} data-tip={status.install_dir}>
                {status.install_dir}
              </span>
              {status.installed && (
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                  {fmtBytes(status.size_bytes)}
                </span>
              )}
              {!status.install_external && (
                <button
                  onClick={() => void handleUninstall()}
                  disabled={installing || removing || status.spawned}
                  className="delete-action shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                  data-tip={status.spawned ? '起動中は削除できません(先に停止してください)' : 'このフォルダを丸ごと消して容量を空けます'}
                >
                  {removing ? '削除しています…' : '削除'}
                </button>
              )}
            </div>
          )}
          {installing || step ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  {step ?? '準備しています…'}
                  {installing && (
                    <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                      ({installElapsed}s)
                    </span>
                  )}
                </span>
                {installing && (
                  <button
                    onClick={() => abortRef.current?.abort()}
                    className="shrink-0 rounded-md border px-2 py-0.5 text-[12px]"
                    style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                  >
                    中止
                  </button>
                )}
              </div>
              {logLines.length > 0 && (
                <pre
                  className="overflow-hidden whitespace-pre-wrap break-all rounded-lg border px-3 py-2 text-[11px]"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-faint)', fontFamily: 'Consolas, monospace' }}
                >
                  {logLines.join('\n')}
                </pre>
              )}
            </div>
          ) : null}
          {!installing && (
            <button
              onClick={() => void handleInstall()}
              disabled={!status || status.spawned || status.install_blocked}
              className="inline-flex items-center gap-1 self-start rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-tip={
                status?.spawned
                  ? '起動中は入れ替えられません(先に停止してください)'
                  : status?.install_blocked
                    ? '指定した置き場に中身があるので、ここへは入れません(アプリからは消しません)。空のフォルダを選ぶか、置き場を既定に戻してください'
                    : undefined
              }
            >
              {status?.installed ? '⟳ 入れ直す' : <><Icon name="download" size={12} /> インストール</>}
            </button>
          )}
          <p className="settings-field-hint">
            エンジンのサーバーを git で取得して下の「サーバーの置き場」に置き、uv で専用の Python
            環境(PyTorch 込みで数 GB)を作ります。git が必要です。uv が無ければアプリの .venv に入れて使います。モデルは初回の起動時に取得します。
          </p>
        </div>
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">サーバーの置き場</span>
            <div className="settings-field-controls">
              {serverDirKey && (values[serverDirKey] ?? '') !== '' && (
                <button
                  onClick={() => void save({ [serverDirKey]: '' }).then(refresh)}
                  disabled={installing || status?.spawned}
                  className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip={`既定(${status?.default_install_dir ?? ''})に戻します。いまの置き場のフォルダは消さずに残します`}
                >
                  既定に戻す
                </button>
              )}
              <button
                onClick={() => void handleChooseServerDir()}
                disabled={!status || installing || status.spawned}
                className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip={
                  status?.spawned
                    ? '起動中は変えられません(先に停止してください)'
                    : 'インストール済みのサーバーのフォルダ、またはこれから入れる空のフォルダを選びます'
                }
              >
                変更
              </button>
            </div>
          </div>
          <span className="block truncate text-[12px]" style={{ color: 'var(--text)' }} data-tip={status?.install_dir}>
            {status?.install_dir ?? ''}
            {status && !status.install_external && (
              <span className="ml-1" style={{ color: 'var(--text-faint)' }}>
                (既定)
              </span>
            )}
          </span>
          <p className="settings-field-hint">
            ほかのアプリと共用している実行環境など、別の場所にあるサーバーを使うときに指定します。インストール済みのフォルダを選べば、そのまま使います。
            指定した置き場はアプリからは消しません(削除と入れ直しはできません。外すときは「既定に戻す」)。
          </p>
        </div>
      </div>
    </>
  )
}
