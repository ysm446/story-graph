import { useEffect, useRef, useState } from 'react'
import { api, isAbortError, placeImagePromptStream, type GeneratedImage } from './api'
import { CandidatePreview, SeedField, WorkflowSelect } from './ImageCandidate'
import type { Place } from './types'
import { useElapsedSeconds } from './useElapsed'

/** 場所の画像の生成ウインドウ(キャラの参照画像と同じ 2 段: LLM が英語プロンプト → 確認・手直し → ComfyUI)。
 *
 *  人物なし・横長の全景に固定する(後で場面生成の背景の手本にも回せるように)。生成した候補は
 *  「決定」を押すまで場所の画像にしない。プロンプト・追加指示・seed・組は「生成」したときに
 *  場所の保存状態へ 1 セットで書かれ(サーバ側)、次に開いたときに復元する。 */
export default function PlaceImageModal({
  place,
  onChanged,
  onClose
}: {
  place: Place
  /** 生成・決定で場所の画像や保存状態が変わったあとに呼ぶ(再読み込み用) */
  onChanged: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  // 作者の追加指示(日本語可)。LLM に渡してプロンプトへ織り込む
  const [instructions, setInstructions] = useState(place.image_instructions ?? '')
  // プロンプトを書いたときの追加指示。今の追加指示とずれていたら書き直しが要る
  const [promptBasis, setPromptBasis] = useState(place.image_instructions ?? '')
  const [phase, setPhase] = useState<null | 'prompt' | 'generate' | 'apply'>(null)
  const [seed, setSeed] = useState<number | null>(place.image_seed ?? null)
  const [workflow, setWorkflow] = useState<string | null>(place.image_workflow ?? null)
  const [candidate, setCandidate] = useState<GeneratedImage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const elapsed = useElapsedSeconds(phase !== null)

  const buildPrompt = async (withInstructions: string = instructions): Promise<void> => {
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('prompt')
    setError(null)
    try {
      setPromptBasis(withInstructions)
      setPrompt('')
      let failed: string | null = null
      await placeImagePromptStream(
        place.id,
        withInstructions.trim() || null,
        (ev) => {
          if (ev.delta) setPrompt((p) => p + ev.delta)
          if (ev.done && ev.prompt != null) setPrompt(ev.prompt)
          if (ev.error) failed = ev.error
        },
        controller.signal
      )
      if (failed) throw new Error(failed)
    } catch (e) {
      if (!isAbortError(e)) setError(String(e))
    } finally {
      abortRef.current = null
      setPhase(null)
    }
  }

  // 開いたとき: 保存済みのプロンプトがあればそのまま復元する(LLM は呼ばない)。
  // 無ければ説明・雰囲気から書かせる。閉じたら進行中の処理を止める
  useEffect(() => {
    if (place.image_prompt) setPrompt(place.image_prompt)
    else void buildPrompt(place.image_instructions ?? '')
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const generate = async (): Promise<void> => {
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('generate')
    setError(null)
    try {
      const r = await api.placeImageGenerate(place.id, prompt, instructions.trim() || null, seed, workflow, controller.signal)
      setCandidate(r)
      setSeed(r.seed) // そのまま「生成」なら同じ絵、-1 で別の絵
      setWorkflow(r.workflow)
      await onChanged()
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
      // 決定したときだけストックに入れる(生成に使ったセット付き)。決定しなかった候補は捨てる
      await api.addMedia('place', place.id, candidate.image_path, true, candidate)
      await onChanged()
      onClose()
    } catch (e) {
      setError(String(e))
      setPhase(null)
    }
  }

  /** 閉じる(不採用)。保存しない: 手直しや書き直し途中の欄で、生成時に保存したセットを崩さない */
  const close = (): void => {
    abortRef.current?.abort()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => {
        if (phase === 'generate' || phase === 'apply') return
        close()
      }}
    >
      <div
        className="inspector-scrollbar max-h-[92vh] w-[640px] max-w-[92vw] overflow-y-auto rounded-2xl border p-4"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-[14px] font-semibold">場所の画像を生成</h3>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          景色の見た目(英語)。手直しできます。人物なし・横長の全景の指示は後ろに自動で足されます。
          生成した画像は「決定」を押すまで場所の画像にはなりません(決定した画像だけがストックに残ります)。プロンプト・追加指示・seed は「生成」したときの組み合わせで場所に保存されます(閉じるだけでは保存しません)。
        </p>
        <label className="mb-3 block">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            追加指示(日本語可。説明欄を変えるほどではない一時的な指示。例: 夜、雨上がり)
          </span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={phase !== null}
            rows={2}
            className="w-full rounded-md border px-2 py-1.5 text-[12px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
        </label>
        <span className="mb-1 block text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          プロンプト(英語)
        </span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={phase !== null}
          rows={5}
          className="w-full rounded-md border px-2 py-1.5 text-[12px] outline-none"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
        />
        {instructions.trim() !== promptBasis.trim() && (
          <p className="mt-1 text-[11px]" style={{ color: '#f2a3a3' }}>
            追加指示が変わりました。「説明から書き直す」でプロンプトを作り直してください。
          </p>
        )}
        {/* 作業の順に左から: プロンプトの書き直し → 組 → seed → 生成 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void buildPrompt()}
            disabled={phase !== null}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip="今の説明・雰囲気・追加指示から LLM にプロンプトを書き直させます"
          >
            説明から書き直す
          </button>
          <WorkflowSelect value={workflow} onChange={setWorkflow} disabled={phase !== null} />
          <SeedField seed={seed} onChange={setSeed} disabled={phase !== null} />
          <button
            onClick={() => void generate()}
            disabled={phase !== null || !prompt.trim() || instructions.trim() !== promptBasis.trim()}
            className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
            data-tip={
              candidate
                ? '同じ seed なら同じ絵になります。seed を -1 にすると別の絵を引きます'
                : 'ComfyUI で画像を生成します(場所の画像にはまだ設定しません)'
            }
          >
            {phase === 'generate' ? '生成中…' : candidate ? 'もう一度生成' : '生成'}
          </button>
          {phase === 'prompt' && (
            <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              説明からプロンプトを作成中…
              <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>({elapsed}s)</span>
            </span>
          )}
          {phase === 'generate' && (
            <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              ComfyUI で生成中…
              <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>({elapsed}s)</span>
            </span>
          )}
        </div>
        <div className="mt-3">
          <CandidatePreview candidate={candidate} current={place.image_path} currentLabel="いまの場所の画像" aspect="1216 / 832" />
        </div>
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: '#f2a3a3' }}>
            {error}
          </p>
        )}
        {/* 最後に押す「決定」は右端 */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={close}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip={candidate ? '生成した画像は採用せずに閉じます(ストックには残りません)' : '閉じるだけでは設定を保存しません(生成したときに保存されます)'}
          >
            {phase === 'generate' ? '取り消し' : '閉じる'}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {candidate && (
              <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                seed {candidate.seed}
              </span>
            )}
            <button
              onClick={() => void apply()}
              disabled={phase !== null || !candidate}
              className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-tip={candidate ? 'この画像を場所の画像にして閉じます' : '先に生成してください'}
            >
              {phase === 'apply' ? '設定中…' : '決定'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
