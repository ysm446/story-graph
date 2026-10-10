import { useEffect, useRef, useState } from 'react'
import { isAbortError, ttsSpeak, uploadVoiceRef, voiceApi, voiceFileUrl, type VoiceProfile } from './api'
import AutoTextarea from './AutoTextarea'
import { Icon } from './icons'
import { enqueueTask, useTasks } from './tasks'
import { useElapsedSeconds } from './useElapsed'

const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }
const secondaryStyle = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }
const labelClass = 'mb-1 block text-[12px]'
const hintClass = 'mt-1 text-[11px] leading-relaxed'

// 試し読みの既定の文。気に入れば、そのまま参照音声(声の手本)にできるよう、手本に向く文にしてある:
// 10〜15 秒(50〜70 字。落ち着いた声ほどゆっくり読むので 1 秒 4〜5 字)、感情を込めない平らな調子、いろいろな音を含む、「……」・ささやき・叫びを入れない。
// 「」なしは地の文(ナレーション調)で読むので、語り手向け。キャラ向けは台詞(「」付き)で読む
export const DEFAULT_SAMPLE_TEXT =
  '朝の駅は、いつもより少しだけ静かだった。改札を抜けると、冷たい風が頬をなでる。私は深く息を吸って、ゆっくりと歩き出した。'
export const characterSampleText = (name: string): string =>
  `「はじめまして、${name}です。最近は朝の散歩が楽しみで、少し早起きするようになりました。今日はどうぞ、よろしくお願いします」`
// 参照音声にするときの目安。これより短いと、手本として声が安定しにくい
const MIN_REF_SECONDS = 8

/** 声(voice_profiles)1 つの編集欄。設定の「音声読み上げ」とキャラクター画面の両方で使う。
 *  欄ごとに、欄外へフォーカスが移ったときに保存する(設定画面の他の欄と同じ約束)。 */
export default function VoiceProfileEditor({
  profile,
  onChanged,
  onDeleted,
  draftFromCharId,
  sampleText = DEFAULT_SAMPLE_TEXT,
  usedBy
}: {
  profile: VoiceProfile
  onChanged: (profile: VoiceProfile) => void
  /** 渡すと「この声を削除」を出す */
  onDeleted?: () => void
  /** 渡すと「資料から下書き」(キャラの資料から声の説明を LLM で作る)を出す */
  draftFromCharId?: string
  sampleText?: string
  /** この声を使っているもの(語り手 / キャラ名)。2 つ以上なら、直すと全部に効くことを添える */
  usedBy?: string[]
}): React.JSX.Element {
  const [name, setName] = useState(profile.name)
  const [caption, setCaption] = useState(profile.caption ?? '')
  const [seed, setSeed] = useState(profile.seed == null ? '' : String(profile.seed))
  const [params, setParams] = useState(profile.params ? JSON.stringify(profile.params) : '')
  const [sample, setSample] = useState(sampleText)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [testing, setTesting] = useState(false)
  // 最後に試し読みした文と、そのときの声(updated_at)。声を直さずに同じ文なら、それを参照音声にできる
  const [lastTested, setLastTested] = useState<{
    text: string
    kind: 'narration' | 'dialogue'
    version: string
    /** 試し読みの音声の長さ(秒)。取れなければ null */
    seconds: number | null
  } | null>(null)
  const [pinning, setPinning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const testElapsed = useElapsedSeconds(testing)
  const drafting = useTasks().some((t) => t.kind === 'voice-caption' && t.nodeId === profile.id)
  const draftElapsed = useElapsedSeconds(drafting)

  // 別の声に切り替わったら欄を読み直す(同じ声の保存結果では、入力中の欄を巻き戻さない)
  useEffect(() => {
    setName(profile.name)
    setCaption(profile.caption ?? '')
    setSeed(profile.seed == null ? '' : String(profile.seed))
    setParams(profile.params ? JSON.stringify(profile.params) : '')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  useEffect(() => () => audioRef.current?.pause(), [])

  const save = async (patch: Parameters<typeof voiceApi.update>[1]): Promise<void> => {
    setError(null)
    try {
      onChanged(await voiceApi.update(profile.id, patch))
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const saveSeed = (): void => {
    const text = seed.trim()
    if (text === '') {
      if (profile.seed != null) void save({ seed: null })
      return
    }
    if (!/^-?\d+$/.test(text)) {
      setError(`seed は整数で入れてください: ${text}`)
      return
    }
    if (Number(text) !== profile.seed) void save({ seed: Number(text) })
  }

  const saveParams = (): void => {
    const text = params.trim()
    if (text === '') {
      if (profile.params) void save({ params: null })
      return
    }
    try {
      const value = JSON.parse(text) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('オブジェクト({...})で書いてください')
      void save({ params: value as Record<string, unknown> })
    } catch (e) {
      setError(`追加パラメータの JSON が読めません: ${String(e).replace(/^\w*Error:\s*/, '')}`)
    }
  }

  const handleUpload = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      onChanged(await uploadVoiceRef(profile.id, file))
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setUploading(false)
    }
  }

  const play = (url: string | null): void => {
    if (!url) return
    audioRef.current?.pause()
    const audio = new Audio(url)
    audioRef.current = audio
    void audio.play().catch((e) => setError(`再生できませんでした: ${String(e)}`))
  }

  const handleTest = async (): Promise<void> => {
    if (!sample.trim()) return
    audioRef.current?.pause()
    setTesting(true)
    setError(null)
    setNotice(null)
    try {
      const text = sample.trim()
      const kind = text.startsWith('「') ? 'dialogue' : 'narration'
      const blob = await ttsSpeak(
        {
          speaker: 'narrator',
          kind,
          text,
          emotion: 'neutral',
          intensity: 0.5,
          pause_after_ms: 0,
          edited: false
        },
        undefined,
        profile.id
      )
      if (!blob) throw new Error('音声が返りませんでした')
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      audioRef.current = audio
      await audio.play()
      setLastTested({
        text,
        kind,
        version: profile.updated_at,
        seconds: Number.isFinite(audio.duration) ? audio.duration : null
      })
    } catch (e) {
      setError(`試し読みに失敗しました: ${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setTesting(false)
    }
  }

  // 気に入った試し読みを参照音声にする。説明文だけの声は文ごとに声色が揺れるので、録音を手本にして固定する
  const handlePin = async (): Promise<void> => {
    if (!lastTested) return
    setPinning(true)
    setError(null)
    try {
      const updated = await voiceApi.refFromSample(profile.id, lastTested.text, lastTested.kind)
      setLastTested(null)
      setNotice('参照音声にしました。これからはこの声を手本に読みます(説明文の話し方も効きます)')
      onChanged(updated)
    } catch (e) {
      setError(`参照音声にできませんでした: ${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setPinning(false)
    }
  }

  // LLM を使うのでタスクキューに積む。できた下書きは欄に入れて保存する(気に入らなければ書き直せばよい)
  const handleDraft = (): void => {
    if (!draftFromCharId) return
    const profileId = profile.id
    enqueueTask({
      label: '声の説明',
      detail: name,
      kind: 'voice-caption',
      nodeId: profileId,
      runner: async ({ signal }) => {
        try {
          const { caption: drafted } = await voiceApi.draftCaption(draftFromCharId, signal)
          const updated = await voiceApi.update(profileId, { caption: drafted })
          setCaption(drafted)
          onChanged(updated)
        } catch (e) {
          if (!isAbortError(e)) setError(`下書きに失敗しました: ${String(e).replace(/^Error:\s*/, '')}`)
        }
      }
    })
  }

  const handleDelete = async (): Promise<void> => {
    const users = usedBy?.length ? `\n使っているもの(${usedBy.join('、')})は語り手の声で読むようになります。` : ''
    if (!window.confirm(`声「${profile.name}」を削除しますか?${users}`)) return
    try {
      await voiceApi.remove(profile.id)
      onDeleted?.()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="block">
        <span className={labelClass} style={{ color: 'var(--text-dim)' }}>
          声の名前
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== profile.name && void save({ name: name.trim() })}
          className="w-full rounded-md border px-2 py-1 text-[12px] outline-none"
          style={inputStyle}
        />
        {usedBy && usedBy.length > 1 && (
          <p className={hintClass} style={{ color: 'var(--text-faint)' }}>
            {usedBy.join('、')} がこの声を使っています。直すと全員に効きます。
          </p>
        )}
      </label>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            声の説明
          </span>
          {draftFromCharId && (
            <button
              onClick={handleDraft}
              disabled={drafting}
              className="accent-action ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
              data-tip="プロフィール・外見・口調から、声の説明の下書きを LLM で作ります(いまの説明は置き換わります)"
            >
              <Icon name="sparkle" size={11} />
              {drafting ? `作っています…(${draftElapsed}s)` : '資料から下書き'}
            </button>
          )}
        </div>
        <AutoTextarea
          minRows={2}
          value={caption}
          placeholder="落ち着いた大人の女性の声。静かな部屋で、柔らかく丁寧に話している"
          onChange={setCaption}
          onBlur={() => caption !== (profile.caption ?? '') && void save({ caption: caption.trim() || null })}
          className="w-full rounded-md border px-2 py-1 text-[12px] outline-none"
          style={inputStyle}
        />
        <p className={hintClass} style={{ color: 'var(--text-faint)' }}>
          性別・年代、声の高さと質感、話す速さと調子を書きます。参照音声もあるときは、その声に説明の話し方を重ねます。
        </p>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            参照音声(任意)
          </span>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="ml-auto rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
            style={secondaryStyle}
            data-tip="この声を真似る音声を取り込みます(wav / mp3 / flac / ogg。ライブラリの assets/voices に置きます)"
          >
            {uploading ? '取り込んでいます…' : '+ 取り込む'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".wav,.mp3,.flac,.ogg,audio/wav,audio/mpeg,audio/flac,audio/ogg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              void handleUpload(file)
            }}
          />
        </div>
        {profile.ref_paths.length > 0 ? (
          <div className="flex flex-col gap-1">
            {profile.ref_paths.map((file, i) => (
              <div
                key={file}
                className="flex items-center gap-2 rounded-lg border px-2 py-1 text-[12px]"
                style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
              >
                <button
                  onClick={() => play(voiceFileUrl(file))}
                  className="shrink-0 rounded-md border p-1"
                  style={secondaryStyle}
                  aria-label="参照音声を再生"
                  data-tip="参照音声を再生"
                >
                  <Icon name="speaker" size={11} />
                </button>
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
                  参照音声 {i + 1}
                </span>
                <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {file}
                </span>
                <button
                  onClick={() => void save({ ref_paths: profile.ref_paths.filter((p) => p !== file) })}
                  className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]"
                  style={secondaryStyle}
                  data-tip="この声から外します"
                >
                  外す
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            なし(声の説明だけで声を作ります)
          </p>
        )}
        <p className={hintClass} style={{ color: 'var(--text-faint)' }}>
          数秒〜数十秒の、雑音の少ない 1 人の声。複数入れると声が安定します。実在の人の声を無断で使わないでください。
        </p>
      </div>

      <div className="flex gap-3">
        <label className="block">
          <span className={labelClass} style={{ color: 'var(--text-dim)' }}>
            seed
          </span>
          <input
            value={seed}
            placeholder="1234"
            onChange={(e) => setSeed(e.target.value)}
            onBlur={saveSeed}
            className="w-28 rounded-md border px-2 py-1 text-[12px] tabular-nums outline-none"
            style={inputStyle}
          />
        </label>
        <label className="block min-w-0 flex-1">
          <span className={labelClass} style={{ color: 'var(--text-dim)' }}>
            この声だけの追加パラメータ(JSON)
          </span>
          <input
            value={params}
            placeholder='{"irodori": {"num_steps": 24}}'
            onChange={(e) => setParams(e.target.value)}
            onBlur={saveParams}
            className="w-full rounded-md border px-2 py-1 font-mono text-[12px] outline-none"
            style={inputStyle}
          />
        </label>
      </div>
      <p className="-mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        seed を変えると別の声になります。気に入った声が出たら、その seed のまま使ってください。
      </p>

      <div>
        <span className={labelClass} style={{ color: 'var(--text-dim)' }}>
          試し読み
        </span>
        <div className="flex items-center gap-2">
          <input
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px] outline-none"
            style={inputStyle}
          />
          <button
            onClick={() => void handleTest()}
            disabled={testing || !sample.trim()}
            className="shrink-0 rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-40"
            style={secondaryStyle}
            data-tip="この声で合成して再生します(止まっていれば TTS サーバーを起動します)"
          >
            {testing ? `合成しています…(${testElapsed}s)` : '▶ 再生'}
          </button>
        </div>
        {lastTested && lastTested.text === sample.trim() && lastTested.version === profile.updated_at && (
          <button
            onClick={() => void handlePin()}
            disabled={pinning}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
            style={secondaryStyle}
            data-tip="いま聞いた声を録音として取り込み、この声の参照音声にします。文ごとの声色の揺れが小さくなります"
          >
            <Icon name="speaker" size={11} />
            {pinning ? '取り込んでいます…' : 'この声を参照音声にして固定'}
            {lastTested.seconds !== null && (
              <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>
                ({lastTested.seconds.toFixed(1)} 秒)
              </span>
            )}
          </button>
        )}
        {lastTested &&
          lastTested.text === sample.trim() &&
          lastTested.version === profile.updated_at &&
          lastTested.seconds !== null &&
          lastTested.seconds < MIN_REF_SECONDS && (
            <p className={hintClass} style={{ color: '#f59e0b' }}>
              手本にするには少し短めです({lastTested.seconds.toFixed(1)} 秒)。10 秒前後になるよう文を足すと、声が安定しやすくなります。
            </p>
          )}
        {notice && (
          <p className={hintClass} style={{ color: 'var(--text-dim)' }}>
            {notice}
          </p>
        )}
        <p className={hintClass} style={{ color: 'var(--text-faint)' }}>
          説明文だけの声は、文ごとに声色が少し揺れます。気に入った声が出たら参照音声にして固定してください。
          手本には、感情を込めない平らな文で 10 秒前後(50〜70 字)が向いています。「……」やささやき・叫びは避けてください。
          「」なしは地の文(ナレーション調)、「」で囲むと台詞(会話調)で読むので、キャラの声は「」付きの文で固定するのがおすすめです。
        </p>
      </div>

      {error && (
        <p className="whitespace-pre-wrap text-[12px]" style={{ color: '#f2a3a3' }}>
          {error}
        </p>
      )}
      {onDeleted && (
        <div>
          <button
            onClick={() => void handleDelete()}
            className="delete-action rounded-md border px-2 py-0.5 text-[11px]"
          >
            この声を削除
          </button>
        </div>
      )}
    </div>
  )
}
