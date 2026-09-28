import { useEffect, useRef, useState } from 'react'
import { api, isAbortError, ttsInstallStream, ttsSpeak, type TtsInstallProgress, type TtsStatus } from './api'
import AutoTextarea from './AutoTextarea'
import { useElapsedSeconds } from './useElapsed'

function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

const SAMPLE_TEXT = '雨は夜更け過ぎに、雪へと変わった。「……ねえ、起きてる?」'
const CAPTION_PLACEHOLDER = '落ち着いた大人の女性の声。静かな部屋で、柔らかく丁寧に物語を読み聞かせている'

// 設定 →「音声読み上げ」。TTS サーバーの稼働・接続先・モデルフォルダ・語り手の声・インストール・
// 音声キャッシュ(docs/design/voice.md)。画像生成(ComfyUI)のセクションと同じ並びにしてある
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
  const [sample, setSample] = useState(SAMPLE_TEXT)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const busyElapsed = useElapsedSeconds(busy !== null)
  const installElapsed = useElapsedSeconds(installing)
  const testElapsed = useElapsedSeconds(testing)

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
      audioRef.current?.pause()
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
      else setStep('中止しました(途中まで入ったフォルダは、次のインストールで消してからやり直します)')
    } finally {
      abortRef.current = null
      setInstalling(false)
      void refresh()
    }
  }

  const handleUninstall = async (): Promise<void> => {
    if (!status) return
    const size = status.installed ? `(${fmtBytes(status.size_bytes)})` : ''
    if (!window.confirm(`${status.install_dir}${size} を削除しますか?\nモデルフォルダは消しません。`)) return
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

  const handleTest = async (): Promise<void> => {
    if (!sample.trim()) return
    audioRef.current?.pause()
    setTesting(true)
    setTestError(null)
    try {
      const blob = await ttsSpeak({
        speaker: 'narrator',
        kind: sample.trim().startsWith('「') ? 'dialogue' : 'narration',
        text: sample.trim(),
        emotion: 'neutral',
        intensity: 0.5,
        pause_after_ms: 0,
        edited: false
      })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      audioRef.current = audio
      await audio.play()
    } catch (e) {
      setTestError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setTesting(false)
      void refresh()
    }
  }

  const handleClearCache = async (): Promise<void> => {
    try {
      await api.ttsClearCache()
    } catch (e) {
      setError(String(e))
    } finally {
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
        className={`${width} rounded-lg border px-3 py-2 text-[13px] outline-none`}
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
      />
      <p className="settings-field-hint">{hint}</p>
    </div>
  )

  const engineLabel = status?.engine.label ?? 'TTS'
  const modes = status?.engine.voice_modes ?? []
  const canStart = !!status && !status.healthy && (status.installed || !!values.tts_base_url)

  return (
    <>
      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">{engineLabel}</span>
            <div className="settings-field-controls">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: status?.healthy ? '#3ecf8e' : 'var(--danger)' }}
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
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
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
              className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
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
            <p className="whitespace-pre-wrap text-[12px]" style={{ color: '#f2a3a3' }}>
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
              className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
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
            <span className="settings-field-label">語り手の声</span>
          </div>
          <p className="settings-field-hint">地の文を読む声です。いまは台詞もこの声で読みます(キャラクターごとの声はこれから対応します)。</p>
        </div>
        {modes.includes('caption') && (
          <div className="settings-field">
            <div className="settings-field-header">
              <span className="settings-field-label">声の説明(キャプション)</span>
            </div>
            <AutoTextarea
              minRows={2}
              value={values.tts_narrator_caption ?? ''}
              placeholder={CAPTION_PLACEHOLDER}
              onChange={(next) => setValues((v) => ({ ...v, tts_narrator_caption: next }))}
              onBlur={() => void save({ tts_narrator_caption: values.tts_narrator_caption ?? '' })}
              className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            />
            <p className="settings-field-hint">
              どんな声か・どんな場面でどう話しているかを日本語で書きます。参照音声と両方あるときは、参照音声の声に説明の話し方を重ねます。
            </p>
          </div>
        )}
        {modes.includes('reference') &&
          textField(
            'tts_narrator_ref',
            '参照音声(任意)',
            'D:\\voices\\narrator.wav',
            'この声を真似て読みます。wav などの絶対パス。実在の人の声を無断で使わないでください。'
          )}
        {textField(
          'tts_narrator_seed',
          'seed',
          '1234',
          '同じ seed だと行ごとの声の揺れが小さくなります。キャプションだけで声を作るときは固定してください。',
          'w-32'
        )}
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
            className="w-full rounded-lg border px-3 py-2 font-mono text-[12px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
          <p className="settings-field-hint">
            /v1/audio/speech の本文にそのまま重ねます(エンジン固有のパラメータ用)。ステップ数を減らすと速く、増やすと丁寧になります。
          </p>
        </div>
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">試しに読む</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-[13px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            />
            <button
              onClick={() => void handleTest()}
              disabled={testing || !sample.trim()}
              className="shrink-0 rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="いまの声の設定で合成して再生します(止まっていればサーバーを起動します)"
            >
              {testing ? `合成しています…(${testElapsed}s)` : '▶ 再生'}
            </button>
          </div>
          {testError && (
            <p className="whitespace-pre-wrap text-[12px]" style={{ color: '#f2a3a3' }}>
              {testError}
            </p>
          )}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">{engineLabel} の自動インストール</span>
            <div className="settings-field-controls">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: status?.installed ? '#3ecf8e' : 'var(--text-faint)' }}
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
              <button
                onClick={() => void handleUninstall()}
                disabled={installing || removing || status.spawned}
                className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                data-tip={status.spawned ? '起動中は削除できません(先に停止してください)' : 'このフォルダを丸ごと消して容量を空けます'}
              >
                {removing ? '削除しています…' : '削除'}
              </button>
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
              disabled={!status || status.spawned}
              className="self-start rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-tip={status?.spawned ? '起動中は入れ替えられません(先に停止してください)' : undefined}
            >
              {status?.installed ? '⟳ 入れ直す' : '⬇ インストール'}
            </button>
          )}
          <p className="settings-field-hint">
            エンジンのサーバーを git で取得して <code>runtime/tts/{status?.engine.id ?? '<engine>'}/</code> に置き、uv で専用の Python
            環境(PyTorch 込みで数 GB)を作ります。git が必要です。uv が無ければアプリの .venv に入れて使います。モデルは初回の起動時に取得します。
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">音声キャッシュ</span>
            <div className="settings-field-controls">
              <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {status ? `${status.cache.files} 件・${fmtBytes(status.cache.bytes)}` : '—'}
              </span>
              <button
                onClick={() => void handleClearCache()}
                disabled={!status || status.cache.files === 0}
                className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="合成済みの音声を消します。次に読むときに合成し直します"
              >
                キャッシュを消す
              </button>
            </div>
          </div>
          <p className="settings-field-hint">
            読み上げた行の音声をライブラリの assets/audio/ に残し、同じ行・同じ声なら合成し直しません。
            清書の上書き・声や台本の変更・シーンの削除で使われなくなった音声は自動で消します(作り直した清書でも、変わらなかった文の音声は使い回します)。
            バックアップには含めません。
          </p>
        </div>
      </div>
    </>
  )
}
