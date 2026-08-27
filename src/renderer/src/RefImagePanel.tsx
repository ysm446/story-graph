import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, characterRefImagePromptStream, isAbortError, uploadAsset, type GeneratedImage } from './api'
import { CandidatePreview, SeedField } from './ImageCandidate'
import { Icon } from './icons'
import Lightbox from './Lightbox'
import MediaPicker from './MediaPicker'
import type { Character } from './types'
import { useElapsedSeconds } from './useElapsed'

/** キャラクターの参照画像(全身の立ち絵)。
 *
 *  - 外見の記述 → LLM が英語プロンプトを作る → 確認・手直し → ComfyUI で生成、の 2 段
 *  - 手持ちの画像のドロップ / ファイル選択も同じ枠で受ける(内部生成と外部読み込みの両立)
 *  - 参照画像から顔を切り抜いてプロフィール画像にする導線を持つ(逆方向は無い)
 *  場面画像の編集モデルへ input として渡す前提なので、生成側は無地背景・全身・正面に固定している。 */
export default function RefImagePanel({
  character,
  appearance,
  onChanged,
  onCropPortrait
}: {
  character: Character | null
  /** 編集中(未保存)の外見。生成前の注意表示にだけ使う */
  appearance: string
  onChanged: (patch: Partial<Character>) => Promise<void>
  onCropPortrait: (path: string) => void
}): React.JSX.Element | null {
  const [modal, setModal] = useState<null | { prompt: string; suffix: string }>(null)
  // 作者の追加指示(日本語可)。LLM に渡してプロンプトへ織り込む。キャラに保存して次回復元
  const [instructions, setInstructions] = useState('')
  // プロンプトを書いたときの追加指示。今の追加指示とずれていたら書き直しが要る
  const [promptBasis, setPromptBasis] = useState('')
  const [phase, setPhase] = useState<null | 'prompt' | 'generate' | 'apply'>(null)
  const [seed, setSeed] = useState<number | null>(null)
  // 生成した候補。「決定」を押すまでキャラには設定しない
  const [candidate, setCandidate] = useState<GeneratedImage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // 参照画像をクリックしたときの拡大表示
  const [lightboxOpen, setLightboxOpen] = useState(false)
  // ストック(候補の一覧)ウインドウ
  const [stockOpen, setStockOpen] = useState(false)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const elapsed = useElapsedSeconds(phase !== null)

  // 別のキャラへ移ったら途中の処理は捨てる(結果が前のキャラに書かれることはない。
  // サーバ側はキャラ ID で保存するが、モーダルが残ると紛らわしい)
  useEffect(() => {
    abortRef.current?.abort()
    setModal(null)
    setCandidate(null)
    setSeed(null)
    setPhase(null)
    setError(null)
    setInstructions('')
    setStockOpen(false)
  }, [character?.id])

  if (!character) return null
  const path = character.ref_image_path
  const url = assetUrl(path)

  const acceptFile = async (file: File | undefined): Promise<void> => {
    if (!file || !file.type.startsWith('image/')) return
    setError(null)
    try {
      const { path: uploaded } = await uploadAsset(file)
      await api.addMedia('character', character.id, uploaded) // ストックに足して、そのまま参照画像にする
      await onChanged({ ref_image_path: uploaded })
    } catch (e) {
      setError(`画像の保存に失敗しました: ${String(e)}`)
    }
  }

  const openGenerate = async (): Promise<void> => {
    setError(null)
    // 保存済みのプロンプト・追加指示・seed があればそのまま復元する(LLM は呼ばない)。
    // 外見を書き換えたときは「外見から書き直す」で LLM に書き直させる
    const savedInstructions = character.ref_image_instructions ?? ''
    setInstructions(savedInstructions)
    setSeed(character.ref_image_seed ?? null)
    if (character.ref_image_prompt) {
      setPromptBasis(savedInstructions)
      setModal({ prompt: character.ref_image_prompt, suffix: '' })
      return
    }
    await buildPrompt(savedInstructions)
  }

  const buildPrompt = async (withInstructions: string = instructions): Promise<void> => {
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('prompt')
    try {
      // モーダルを先に開き、delta をプロンプト欄へ流し込む
      setPromptBasis(withInstructions)
      setModal({ prompt: '', suffix: '' })
      let failed: string | null = null
      await characterRefImagePromptStream(
        character.id,
        withInstructions.trim() || null,
        (ev) => {
          if (ev.meta) setModal((m) => (m ? { ...m, suffix: ev.meta!.suffix } : m))
          if (ev.delta) setModal((m) => (m ? { ...m, prompt: m.prompt + ev.delta } : m))
          if (ev.done && ev.prompt != null) setModal((m) => (m ? { ...m, prompt: ev.prompt! } : m))
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

  const generate = async (): Promise<void> => {
    if (!modal) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('generate')
    setError(null)
    try {
      // 生成に使ったプロンプト・追加指示・seed は、サーバがストックの行とキャラの保存状態に
      // 1 セットで書く(再現性。閉じる / 決定では保存しない)
      const trimmed = instructions.trim() || null
      const r = await api.characterRefImageGenerate(character.id, modal.prompt, trimmed, seed, controller.signal)
      setCandidate(r)
      setSeed(r.seed) // そのまま「生成」なら同じ絵、-1 で別の絵
      await onChanged({ ref_image_prompt: modal.prompt, ref_image_instructions: trimmed, ref_image_seed: r.seed })
    } catch (e) {
      if (!isAbortError(e)) setError(String(e))
    } finally {
      abortRef.current = null
      setPhase(null)
    }
  }

  const apply = async (): Promise<void> => {
    if (!modal || !candidate) return
    setPhase('apply')
    setError(null)
    try {
      // 決定したときだけストックに入れる(生成に使ったセット付き)。決定しなかった候補は捨てる
      const m = await api.addMedia('character', character.id, candidate.image_path, true, candidate)
      setModal(null)
      setCandidate(null)
      await onChanged({
        ref_image_path: m.path,
        ref_image_prompt: m.prompt,
        ref_image_instructions: m.instructions,
        ref_image_seed: m.seed
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setPhase(null)
    }
  }

  /** 閉じる(不採用)。保存しない: 手直しや書き直し途中の欄で、生成時に保存したセットを崩さない */
  const closeModal = (): void => {
    abortRef.current?.abort()
    setModal(null)
    setCandidate(null)
  }

  const remove = async (): Promise<void> => {
    await api.updateCharacter(character.id, { ref_image_path: null })
    await onChanged({ ref_image_path: null })
  }

  return (
    <div className="mb-4">
      <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
        参照画像(全身の立ち絵。場面の画像を作るときの手本)
      </span>
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
        <button
          onClick={() => {
            // 画像があればクリックで拡大。差し替えは隅のアイコンかドロップで
            if (url) setLightboxOpen(true)
            else fileInputRef.current?.click()
          }}
          onDragEnter={(e) => {
            e.preventDefault()
            dragDepth.current += 1
            setDragOver(true)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            dragDepth.current -= 1
            if (dragDepth.current <= 0) {
              dragDepth.current = 0
              setDragOver(false)
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            dragDepth.current = 0
            setDragOver(false)
            void acceptFile(e.dataTransfer.files?.[0])
          }}
          className={`group relative h-48 w-32 shrink-0 overflow-hidden rounded-lg border ${url ? 'cursor-zoom-in' : ''}`}
          style={{
            borderColor: 'var(--border-strong)',
            background: 'var(--bg-canvas)',
            ...(dragOver ? { outline: '2px dashed var(--accent)', outlineOffset: 2 } : {})
          }}
          data-tip={url ? 'クリックで拡大 / 画像をドロップで差し替え' : 'クリックで画像を選ぶ / 画像をドロップ'}
        >
          {url ? (
            <img src={url} className="h-full w-full object-cover" />
          ) : (
            <>
              <span className="flex h-full w-full items-center justify-center px-2 text-center text-[11px]" style={{ color: 'var(--text-faint)' }}>
                未設定
              </span>
              <span className="absolute inset-0 hidden items-center justify-center bg-black/50 text-[11px] text-white group-hover:flex">
                画像を選ぶ
              </span>
            </>
          )}
        </button>
        {/* 差し替えの導線は枠の隅のアイコン(枠のクリックは拡大に譲る) */}
        {url && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-md border"
            style={{ background: 'rgba(28,31,43,0.85)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip="別の画像に差し替える(ドロップでも可)"
            aria-label="別の画像に差し替える"
          >
            <Icon name="image" size={12} />
          </button>
        )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            void acceptFile(file)
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setStockOpen(true)}
              className="rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="生成した候補と手持ちの画像の一覧。ここから 1 枚を選び直したり、いらない候補を削除したりできます"
            >
              ストック
            </button>
            <button
              onClick={() => void openGenerate()}
              disabled={phase !== null}
              className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
              data-tip={
                character.ref_image_prompt
                  ? '保存済みのプロンプト・追加指示・seed を開きます(外見を変えたら中の「外見から書き直す」で作り直せます)'
                  : '保存済みの外見・プロフィールから英語のプロンプトを作り(確認・手直しできます)、ComfyUI で全身の立ち絵を生成します'
              }
            >
              <Icon name="sparkle" size={12} /> {url ? '作り直す' : '外見から生成'}
            </button>
            {url && (
              <>
                <button
                  onClick={() => path && onCropPortrait(path)}
                  className="rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip="この画像から顔を切り抜いてプロフィール画像にします"
                >
                  顔をプロフィール画像に
                </button>
                <button
                  onClick={() => void remove()}
                  className="rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip="参照画像を外す(ストックとプロンプトは残るので、選び直しや作り直しに使えます)"
                >
                  外す
                </button>
              </>
            )}
          </div>
          {phase === 'prompt' && (
            <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              外見の記述からプロンプトを作成中…
              <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>({elapsed}s)</span>
            </span>
          )}
          {appearance !== (character.appearance ?? '') && (
            <p className="text-[11px]" style={{ color: '#f2a3a3' }}>
              外見に未保存の変更があります。プロンプトは保存済みの内容から作るので、先に「保存」を押してください。
            </p>
          )}
          {!appearance.trim() && !url && (
            <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              「外見」が空のままだと、プロンプトは無難な既定の姿になります。先に外見を書いて保存してから生成すると狙いどおりになります。
            </p>
          )}
          {error && (
            <p className="text-[12px]" style={{ color: '#f2a3a3' }}>
              {error}
            </p>
          )}
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            無地背景・全身・正面の 1 枚が最も効きます。手持ちの画像を使うときも同じ条件に近いものを。
          </p>
        </div>
      </div>

      {lightboxOpen && url && path && <Lightbox src={url} path={path} onClose={() => setLightboxOpen(false)} />}
      {stockOpen && (
        <MediaPicker
          ownerType="character"
          ownerId={character.id}
          aspect="832 / 1216"
          accept="image/png,image/jpeg,image/webp"
          onChanged={() => void onChanged({})}
          onClose={() => setStockOpen(false)}
        />
      )}
      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => {
            if (phase === 'generate' || phase === 'apply') return
            closeModal()
          }}
        >
          <div
            className="inspector-scrollbar max-h-[92vh] w-[640px] max-w-[92vw] overflow-y-auto rounded-2xl border p-4"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-[14px] font-semibold">参照画像を生成</h3>
            <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              人物の見た目(英語)。手直しできます。全身・正面・無地背景の指示は後ろに自動で足されます。
              生成した画像は「決定」を押すまで参照画像にはなりません(決定した画像だけがストックに残ります)。プロンプト・追加指示・seed は「生成」したときの組み合わせでキャラに保存されます(閉じるだけでは保存しません)。
            </p>
            <label className="mb-3 block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                追加指示(日本語可。外見欄を変えるほどではない一時的な指示)
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
              value={modal.prompt}
              onChange={(e) => setModal((m) => (m ? { ...m, prompt: e.target.value } : m))}
              disabled={phase === 'generate' || phase === 'apply'}
              rows={5}
              className="w-full rounded-md border px-2 py-1.5 text-[12px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            />
            {instructions.trim() !== promptBasis.trim() && (
              <p className="mt-1 text-[11px]" style={{ color: '#f2a3a3' }}>
                追加指示が変わりました。「外見から書き直す」でプロンプトを作り直してください。
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void generate()}
                disabled={phase !== null || !modal.prompt.trim() || instructions.trim() !== promptBasis.trim()}
                className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
                data-tip={
                  candidate
                    ? '同じ seed なら同じ絵になります。seed を -1 にすると別の絵を引きます'
                    : 'ComfyUI で画像を生成します(参照画像にはまだ設定しません)'
                }
              >
                {phase === 'generate' ? '生成中…' : candidate ? 'もう一度生成' : '生成'}
              </button>
              <SeedField seed={seed} onChange={setSeed} disabled={phase !== null} />
              <button
                onClick={() => void buildPrompt()}
                disabled={phase !== null}
                className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="今の外見・プロフィール・追加指示から LLM にプロンプトを書き直させます"
              >
                外見から書き直す
              </button>
              {phase === 'generate' && (
                <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  ComfyUI で生成中…
                  <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>({elapsed}s)</span>
                </span>
              )}
            </div>
            <div className="mx-auto mt-3 w-[280px] max-w-full">
              <CandidatePreview candidate={candidate} current={path} currentLabel="いまの参照画像" aspect="832 / 1216" />
            </div>
            {error && (
              <p className="mt-2 text-[12px]" style={{ color: '#f2a3a3' }}>
                {error}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => void apply()}
                disabled={phase !== null || !candidate}
                className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
                data-tip={candidate ? 'この画像を参照画像にして閉じます' : '先に生成してください'}
              >
                {phase === 'apply' ? '設定中…' : '決定'}
              </button>
              {candidate && (
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                  seed {candidate.seed}
                </span>
              )}
              <button
                onClick={closeModal}
                className="ml-auto rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip={candidate ? '生成した画像は採用せずに閉じます(ストックには残りません)' : '閉じるだけでは設定を保存しません(生成したときに保存されます)'}
              >
                {phase === 'generate' ? 'キャンセル' : '閉じる'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
