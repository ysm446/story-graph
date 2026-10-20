import { useEffect, useRef, useState } from 'react'
import { api, isAbortError, isVideoAsset, type GeneratedImage } from './api'
import { CandidatePreview, SeedField, WorkflowSelect } from './ImageCandidate'
import type { MediaItem } from './types'
import { useElapsedSeconds } from './useElapsed'

export type ImageWindowMode = 'generate' | 'effect'

// 前回の加工の指示(同じ加工を別の画像にも掛けやすいように。この PC だけの覚え)
const LAST_PROMPT_KEY = 'imageEffectLastPrompt'

/** 生成ウインドウの見出しの右に置く「生成 | 加工」の切り替え(セグメントの型)。
 *  加工できない(画像が無い・動画)ときは「加工」を押せなくし、理由を data-tip に書く */
export function ImageModeSwitch({
  mode,
  onChange,
  disabled,
  source
}: {
  mode: ImageWindowMode
  onChange: (mode: ImageWindowMode) => void
  disabled: boolean
  /** いまの画像(加工の元)。null なら加工できない */
  source: string | null
}): React.JSX.Element {
  const effectBlocked = !source ? '加工する画像がありません(先に生成するか、画像を置いてください)' : isVideoAsset(source) ? '動画は加工できません' : null
  const options: Array<[ImageWindowMode, string, string | null]> = [
    ['generate', '生成', null],
    ['effect', '加工', effectBlocked]
  ]
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
      {options.map(([value, label, blocked]) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          disabled={disabled || (!!blocked && mode !== value)}
          className="px-2.5 py-0.5 text-[12px] disabled:opacity-50"
          style={mode === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
          aria-pressed={mode === value}
          data-tip={
            blocked ??
            (value === 'generate'
              ? 'プロンプトから新しく描きます'
              : 'いまの画像に加工を掛けます(鉛筆画にする・モノクロにする など)')
          }
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** できた画像の加工ウインドウ(docs/design/image-gen.md §15)。生成ウインドウの「加工」側。
 *
 *  - 元の画像は開いたときのいまの画像。「この結果をさらに加工」で候補を次の元にできる(重ね掛け)
 *  - 指示は日本語のまま ComfyUI に渡す(LLM で書き直さない)
 *  - 生成と同じく「決定」でストックに入れて選ぶ。元の画像はストックに残るので、選び直せば戻せる
 *  - 生成ウインドウの保存状態(プロンプト・seed)には書かない */
export function ImageEffectModal({
  ownerType,
  ownerId,
  title,
  source: initialSource,
  sourceLabel,
  targetLabel,
  aspect,
  widthClass,
  previewClass,
  modeSwitch,
  onBusyChange,
  onApplied,
  onClose
}: {
  ownerType: MediaItem['owner_type']
  ownerId: string
  /** 見出し(「この場面の画像を加工」など) */
  title: string
  /** 開いたときのいまの画像 */
  source: string
  /** いまの画像のラベル(「いまの挿絵」など) */
  sourceLabel: string
  /** 決定したときに何になるか(「挿絵」「参照画像」「場所の画像」) */
  targetLabel: string
  /** プレビュー枠の縦横比(生成ウインドウと同じもの) */
  aspect: string
  /** モーダルの幅(生成ウインドウと同じもの) */
  widthClass: string
  /** 左右のプレビューを包む枠のクラス(縦長の参照画像は幅を絞る) */
  previewClass?: string
  /** 見出しの右に置く切り替え(ImageModeSwitch) */
  modeSwitch: React.ReactNode
  /** 加工中・決定中は親が切り替えを止める */
  onBusyChange: (busy: boolean) => void
  /** 決定でストックに入れて選んだあとに呼ぶ(ウインドウは親が閉じる) */
  onApplied: (m: MediaItem) => void | Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [source, setSource] = useState(initialSource)
  const [prompt, setPrompt] = useState(() => {
    try {
      return localStorage.getItem(LAST_PROMPT_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [seed, setSeed] = useState<number | null>(null)
  const [workflow, setWorkflow] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<GeneratedImage | null>(null)
  const [phase, setPhase] = useState<null | 'effect' | 'apply'>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const elapsed = useElapsedSeconds(phase !== null)

  useEffect(() => {
    onBusyChange(phase !== null)
  }, [phase])
  useEffect(() => () => abortRef.current?.abort(), [])

  const run = async (): Promise<void> => {
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('effect')
    setError(null)
    try {
      const text = prompt.trim()
      try {
        localStorage.setItem(LAST_PROMPT_KEY, text)
      } catch {
        // 覚えられなくても加工はできる
      }
      const r = await api.imageEffect(ownerType, ownerId, source, text, seed, workflow, controller.signal)
      setCandidate(r)
      setSeed(r.seed) // そのまま「もう一度加工」なら同じ絵、-1 で別の絵
      setWorkflow(r.workflow)
    } catch (e) {
      if (!isAbortError(e)) setError(String(e))
    } finally {
      abortRef.current = null
      setPhase(null)
    }
  }

  const apply = async (): Promise<void> => {
    if (!candidate) return
    setPhase('apply')
    setError(null)
    try {
      // 決定したときだけストックに入れる(加工の指示・seed・元の画像付き)。決定しなかった候補は捨てる
      const m = await api.addMedia(ownerType, ownerId, candidate.image_path, true, candidate)
      await onApplied(m)
    } catch (e) {
      setError(String(e))
      setPhase(null)
    }
  }

  /** 候補を次の元にする(重ね掛け)。途中の候補はストックに入らない */
  const chain = (): void => {
    if (!candidate) return
    setSource(candidate.image_path)
    setCandidate(null)
    setSeed(null)
  }

  const close = (): void => {
    abortRef.current?.abort()
    onClose()
  }

  const busy = phase !== null
  const chained = source !== initialSource

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => {
        if (busy) return
        close()
      }}
    >
      <div
        className={`inspector-scrollbar max-h-[92vh] ${widthClass} max-w-[92vw] overflow-y-auto rounded-2xl border p-4 shadow-xl shadow-black/50`}
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          <div className="ml-auto">{modeSwitch}</div>
        </div>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          いまの画像に、指示どおりの加工を掛けます。指示は日本語のまま渡します(LLM で書き直しません)。
          加工した画像は「決定」を押すまで{targetLabel}にはなりません。元の画像はストックに残るので、選び直せば戻せます。
        </p>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            加工の指示(日本語可)
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="例: モノクロの鉛筆画にして。クロスハッチングを入れて"
            className="w-full rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
        </label>

        {/* 作業の順に左から: 組 → seed → 加工 */}
        <div className="flex flex-wrap items-center gap-2">
          <WorkflowSelect value={workflow} onChange={setWorkflow} disabled={busy} effect />
          <SeedField seed={seed} onChange={setSeed} disabled={busy} />
          <button
            onClick={() => void run()}
            disabled={busy || !prompt.trim()}
            className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
            data-tip={
              !prompt.trim()
                ? '先に加工の指示を書いてください'
                : candidate
                  ? '同じ seed なら同じ絵になります。seed を -1 にすると別の絵を引きます'
                  : `ComfyUI で加工します(${targetLabel}にはまだ設定しません)`
            }
          >
            {phase === 'effect' ? '加工中…' : candidate ? 'もう一度加工' : '加工'}
          </button>
          {phase === 'effect' && (
            <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              ComfyUI で加工中…
              <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>({elapsed}s)</span>
            </span>
          )}
        </div>

        {/* 元 ⇄ 加工後を並べて見比べる */}
        <div className={`mt-3 grid grid-cols-2 gap-3 ${previewClass ?? ''}`}>
          <div>
            <CandidatePreview
              candidate={null}
              current={source}
              currentLabel={chained ? '元の画像(加工した候補)' : sourceLabel}
              aspect={aspect}
            />
            {chained && (
              <button
                onClick={() => setSource(initialSource)}
                disabled={busy}
                className="mt-1.5 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip={`ウインドウを開いたときの${sourceLabel}に戻します`}
              >
                最初の画像に戻す
              </button>
            )}
          </div>
          <CandidatePreview
            candidate={candidate}
            current={null}
            currentLabel=""
            aspect={aspect}
            candidateLabel="加工した候補(未決定)"
            placeholder="加工するとここにプレビューが出ます"
          />
        </div>
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--danger-text)' }}>
            {error}
          </p>
        )}

        {/* 最後に押す「決定」は右端 */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={close}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip={candidate ? '加工した画像は採用せずに閉じます(ストックには残りません)' : '閉じます'}
          >
            {phase === 'effect' ? '取り消し' : '閉じる'}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {candidate && (
              <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                seed {candidate.seed}
              </span>
            )}
            <button
              onClick={chain}
              disabled={busy || !candidate}
              className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip={
                candidate
                  ? 'この候補を元の画像にして、続けて別の加工を掛けます(途中の候補はストックに残りません)'
                  : '先に加工してください'
              }
            >
              この結果をさらに加工
            </button>
            <button
              onClick={() => void apply()}
              disabled={busy || !candidate}
              className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-tip={candidate ? `この画像を${targetLabel}にして閉じます` : '先に加工してください'}
            >
              {phase === 'apply' ? '設定中…' : '決定'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
