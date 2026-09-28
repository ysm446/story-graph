import { useEffect, useRef, useState } from 'react'
import { api, isAbortError, ttsSpeak, VOICE_EMOTIONS, type VoiceLine, type VoiceScript } from './api'
import { Icon } from './icons'
import { enqueueTask, useTasks } from './tasks'
import type { Character, SceneEntry } from './types'
import { useElapsedSeconds } from './useElapsed'

const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }
const secondaryStyle = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }

/** 朗読台本の確認と手直し(docs/design/voice.md §4)。清書は読み取るだけで、台本だけを保存する。
 *  行ごとに話者・感情・強さ・読む文・後ろの間を直せる。直した行は edited になり、
 *  LLM で付け直しても上書きされず、作り直した清書へも引き継がれる。 */
export default function VoiceScriptModal({
  scene,
  onClose,
  onPlayFrom
}: {
  scene: SceneEntry
  onClose: () => void
  /** 保存済みの台本を、この行から読み上げる */
  onPlayFrom: (lineIndex: number) => void
}): React.JSX.Element {
  const render = scene.render!
  const title = scene.node.title || '(無題)'
  const [script, setScript] = useState<VoiceScript | null>(null)
  const [lines, setLines] = useState<VoiceLine[]>([])
  const [dirty, setDirty] = useState(false)
  const [characters, setCharacters] = useState<Character[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewing, setPreviewing] = useState<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // 閉じた後に LLM の結果が届いても、画面の状態には書かない
  const openRef = useRef(true)
  const annotating = useTasks().some((t) => t.kind === 'voice-script' && t.nodeId === render.id)
  const annotateElapsed = useElapsedSeconds(annotating)

  const apply = (s: VoiceScript): void => {
    setScript(s)
    setLines(s.lines)
    setDirty(false)
  }

  useEffect(() => {
    openRef.current = true
    api.voiceScript(render.id).then(apply).catch((e) => setError(String(e)))
    api.listCharacters().then(setCharacters).catch(() => undefined)
    return () => {
      openRef.current = false
      audioRef.current?.pause()
    }
  }, [render.id])

  const update = (index: number, patch: Partial<VoiceLine>): void => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch, edited: true } : l)))
    setDirty(true)
  }

  const handleSave = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      apply(await api.saveVoiceScript(render.id, lines))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async (): Promise<void> => {
    if (!window.confirm('清書から台本を作り直しますか?\n話者・感情・読みの手直しはすべて消えます。')) return
    setBusy(true)
    setError(null)
    try {
      apply(await api.resetVoiceScript(render.id))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  // LLM を使うのでタスクキューに積む(llama-server は 1 件ずつしか処理できない)
  const handleAnnotate = (): void => {
    setError(null)
    const draft = lines
    enqueueTask({
      label: '台本',
      detail: `話者と感情: ${title}`,
      kind: 'voice-script',
      nodeId: render.id,
      runner: async ({ signal }) => {
        try {
          const result = await api.annotateVoiceScript(render.id, draft, signal)
          if (openRef.current) apply(result)
        } catch (e) {
          if (!isAbortError(e) && openRef.current) setError(String(e))
        }
      }
    })
  }

  const handlePreview = async (index: number): Promise<void> => {
    audioRef.current?.pause()
    setPreviewing(index)
    setError(null)
    try {
      const blob = await ttsSpeak(lines[index])
      if (!blob) {
        setError('この行は効果音ですが、いまのエンジンでは鳴らせないので間になります')
        return
      }
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      audioRef.current = audio
      await audio.play()
    } catch (e) {
      setError(`試聴に失敗しました: ${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setPreviewing(null)
    }
  }

  const handleClose = (): void => {
    if (dirty && !window.confirm('保存していない直しがあります。閉じますか?')) return
    onClose()
  }

  const speakerLabel = (speaker: string): string => {
    if (speaker === 'narrator') return '語り手'
    const id = speaker.replace(/^char:/, '')
    return characters.find((c) => c.id === id)?.name ?? id
  }
  // 話者の候補: 語り手 + 登録キャラ全員(台本に残っている未登録の ID も落とさない)
  const speakerOptions = [
    'narrator',
    ...characters.map((c) => `char:${c.id}`),
    ...lines.map((l) => l.speaker).filter((s, i, all) => s !== 'narrator' && all.indexOf(s) === i && !characters.some((c) => `char:${c.id}` === s))
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={handleClose}>
      <div
        className="flex max-h-[92vh] w-[920px] max-w-[92vw] flex-col rounded-2xl border p-4"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <h3 className="min-w-0 truncate text-[14px] font-semibold">朗読台本 — {title}</h3>
          {script && (
            <span className="shrink-0 rounded px-1.5 py-px text-[10px]" style={{ background: 'var(--bg-input)', color: 'var(--text-faint)' }}>
              {script.source === 'llm' ? 'LLM で付けた' : '規則のみ'}
              {script.saved ? '' : '・未保存'}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              onClick={handleAnnotate}
              disabled={annotating || busy || lines.length === 0}
              className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
              data-tip="LLM で、台詞の話者と各行の感情・強さを付けます。手で直した行はそのまま残します"
            >
              <Icon name="sparkle" size={12} />
              {annotating ? `付けています…(${annotateElapsed}s)` : '話者と感情を付ける'}
            </button>
            <button
              onClick={() => void handleReset()}
              disabled={annotating || busy}
              className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
              style={secondaryStyle}
              data-tip="清書から規則で作り直します(話者・感情・手直しを捨てます)"
            >
              清書から作り直す
            </button>
          </div>
        </div>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          清書は変えずに、読み上げ用の台本だけを直します。読みにくい語はひらがなに開いてください。直した行は LLM で付け直しても上書きされず、
          清書を作り直しても同じ文なら引き継がれます。
          {script && !script.saved && script.carried > 0 && ` 前の清書の台本から ${script.carried} 行を引き継いでいます。`}
          台詞は、話者のキャラクターに割り当てた声で読みます(割り当てが無ければ語り手の声)。
        </p>

        <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {!script && !error && (
            <div className="py-10 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
              読み込んでいます…
            </div>
          )}
          <div className="flex flex-col gap-1">
            {lines.map((line, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]"
                style={{ background: 'var(--bg-elevated)', borderColor: line.edited ? 'var(--accent-border)' : 'var(--border)' }}
              >
                <span className="w-6 shrink-0 text-right tabular-nums text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {i + 1}
                </span>
                <span
                  className="shrink-0 rounded px-1 text-[10px]"
                  style={{ background: 'var(--bg-input)', color: 'var(--text-faint)' }}
                  data-tip={
                    line.effect
                      ? '効果音(言葉ではなく息を呑む音として鳴らします。鳴らせないエンジンでは間になります)'
                      : line.kind === 'dialogue'
                        ? '「」の台詞'
                        : '地の文'
                  }
                >
                  {line.effect ? '音' : line.kind === 'dialogue' ? '台詞' : '地'}
                </span>
                <select
                  value={line.speaker}
                  onChange={(e) => update(i, { speaker: e.target.value })}
                  className="w-24 shrink-0 rounded-md border px-1 py-0.5 text-[11px] outline-none"
                  style={inputStyle}
                  data-tip="話者"
                >
                  {speakerOptions.map((s) => (
                    <option key={s} value={s}>
                      {speakerLabel(s)}
                    </option>
                  ))}
                </select>
                <select
                  value={line.emotion}
                  onChange={(e) => update(i, { emotion: e.target.value })}
                  className="w-20 shrink-0 rounded-md border px-1 py-0.5 text-[11px] outline-none"
                  style={inputStyle}
                  data-tip="読むときの感情"
                >
                  {VOICE_EMOTIONS.map((em) => (
                    <option key={em.id} value={em.id}>
                      {em.label}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={line.intensity}
                  onChange={(e) => update(i, { intensity: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })}
                  className="w-12 shrink-0 rounded-md border px-1 py-0.5 text-[11px] tabular-nums outline-none"
                  style={inputStyle}
                  data-tip="感情の強さ(0〜1)。0.8 以上で強めに演じます"
                />
                <input
                  value={line.text}
                  onChange={(e) => update(i, { text: e.target.value })}
                  className="min-w-0 flex-1 rounded-md border px-2 py-0.5 text-[12px] outline-none"
                  style={inputStyle}
                  data-tip={line.source_text && line.source_text !== line.text ? `清書の文: ${line.source_text}` : undefined}
                />
                <input
                  type="number"
                  min={0}
                  max={5000}
                  step={50}
                  value={line.pause_after_ms}
                  onChange={(e) => update(i, { pause_after_ms: Math.min(5000, Math.max(0, Number(e.target.value) || 0)) })}
                  className="w-16 shrink-0 rounded-md border px-1 py-0.5 text-[11px] tabular-nums outline-none"
                  style={inputStyle}
                  data-tip="この行の後の間(ミリ秒)"
                />
                <button
                  onClick={() => void handlePreview(i)}
                  disabled={previewing !== null}
                  className="shrink-0 rounded-md border p-1 disabled:opacity-40"
                  style={secondaryStyle}
                  aria-label="この行を試聴"
                  data-tip="この行だけ合成して聞きます(保存していない直しも反映します)"
                >
                  {previewing === i ? <span className="block h-3 w-3 text-center text-[10px] leading-3">…</span> : <Icon name="speaker" size={12} />}
                </button>
                <button
                  onClick={() => onPlayFrom(i)}
                  disabled={dirty}
                  className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] disabled:opacity-40"
                  style={secondaryStyle}
                  data-tip={dirty ? '保存してから読み上げられます' : 'この行から最後まで読み上げます'}
                >
                  ここから
                </button>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <p className="mt-2 whitespace-pre-wrap text-[12px]" style={{ color: '#f2a3a3' }}>
            {error}
          </p>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {lines.length} 行{lines.some((l) => l.edited) ? `・手直し ${lines.filter((l) => l.edited).length} 行` : ''}
          </span>
          <button onClick={handleClose} className="rounded-md border px-3 py-1 text-[12px]" style={secondaryStyle}>
            閉じる
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={!dirty || busy || annotating}
            className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
