import { useEffect, useRef, useState } from 'react'
import { api, isAbortError, nodeImagePromptStream, type GeneratedImage, type SceneImagePromptMeta } from './api'
import { CandidatePreview, SeedField } from './ImageCandidate'
import type { Character, StoryNode } from './types'
import { useElapsedSeconds } from './useElapsed'

const MAX_REFS = 3

/** 場面の挿絵を生成するモーダル(docs/design/image-gen.md §6)。
 *
 *  - LLM がビート・場所・cast(+ 作者の追加指示)から英語プロンプトを書く(参照画像のあるキャラは image1.. で参照)
 *  - cast のトグルで「誰の参照画像を渡すか」を選べる(最大 3 人。参照画像が無いキャラは文章のみ)
 *  - 参照画像の選び方や追加指示を変えるとプロンプトと食い違うので、「書き直す」を押すまで生成を止める
 *  - 生成しても即決定にはしない: プレビューを見て「決定」で挿絵にする。seed を変えて何度でも引き直せる
 *  - プロンプト・追加指示・seed・参照キャラはシーンに保存し、次に開いたとき復元する(保存済みなら LLM は呼ばない) */
export default function SceneImageModal({
  node,
  characters,
  onGenerated,
  onClose
}: {
  node: StoryNode
  characters: Character[]
  /** 「決定」で挿絵に設定したあとに呼ぶ(再読み込み用) */
  onGenerated: () => void
  onClose: () => void
}): React.JSX.Element {
  const saved = !!node.image_prompt
  const [data, setData] = useState<SceneImagePromptMeta | null>(null)
  const [prompt, setPrompt] = useState(node.image_prompt ?? '')
  const [instructions, setInstructions] = useState(node.image_instructions ?? '')
  // 参照画像を渡すキャラ(cast 順)。null = 初回は自動選択
  const [selected, setSelected] = useState<string[] | null>(
    node.image_ref_chars ? node.image_ref_chars.filter((id) => node.cast.includes(id)) : null
  )
  const [phase, setPhase] = useState<null | 'prompt' | 'generate' | 'apply'>(null)
  const [error, setError] = useState<string | null>(null)
  // プロンプトを書いたときの入力(選択・追加指示)。今の入力とずれていたら書き直しが要る
  const [promptBasis, setPromptBasis] = useState<{ selection: string[]; instructions: string }>({
    selection: node.image_ref_chars ?? [],
    instructions: node.image_instructions ?? ''
  })
  const [seed, setSeed] = useState<number | null>(node.image_seed ?? null)
  const [candidate, setCandidate] = useState<GeneratedImage | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const elapsed = useElapsedSeconds(phase !== null)

  const charById = new Map(characters.map((c) => [c.id, c]))

  const buildPrompt = async (charIds: string[] | null): Promise<void> => {
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('prompt')
    setError(null)
    try {
      // 冒頭の meta で「誰が image1.. か」が決まり、あとは delta を欄に流し込む
      setPrompt('')
      let failed: string | null = null
      await nodeImagePromptStream(
        node.id,
        charIds,
        instructions.trim() || null,
        (ev) => {
          if (ev.meta) {
            setData(ev.meta)
            const ids = ev.meta.refs.map((x) => x.char_id)
            setSelected(ids)
            setPromptBasis({ selection: ids, instructions })
          }
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

  // 保存済みの状態があればそれを出す(LLM は呼ばない)。無ければ開いたときに一度だけ書かせる
  useEffect(() => {
    if (!saved) void buildPrompt(null)
    return () => abortRef.current?.abort()
  }, [])

  const generate = async (): Promise<void> => {
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('generate')
    setError(null)
    try {
      // 生成に使ったプロンプト・追加指示・seed・参照キャラは、サーバがストックの行とシーンの
      // 保存状態に 1 セットで書く(再現性。閉じる / 決定では保存しない)
      const r = await api.nodeImageGenerate(
        node.id,
        prompt,
        selected ?? [],
        instructions.trim() || null,
        seed,
        controller.signal
      )
      setCandidate(r)
      // 使った seed を欄に入れておく。そのまま「生成」すれば同じ絵、-1 で別の絵
      setSeed(r.seed)
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
      await api.selectMedia(candidate.media_id)
      onGenerated()
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setPhase(null)
    }
  }

  const close = (): void => {
    abortRef.current?.abort()
    onGenerated() // 生成のたびに保存した設定を node に反映させる(次に開いたときの復元用)
    onClose()
  }

  const toggle = (id: string): void => {
    setSelected((cur) => {
      const list = cur ?? []
      if (list.includes(id)) return list.filter((x) => x !== id)
      if (list.length >= MAX_REFS) return list
      // cast 順を保つ(ラベル image1.. は cast 順で振られる)
      const order = node.cast
      return [...list, id].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    })
  }

  const sel = selected ?? []
  const selectionChanged =
    sel.length !== promptBasis.selection.length || sel.some((id, i) => promptBasis.selection[i] !== id)
  const instructionsChanged = instructions.trim() !== promptBasis.instructions.trim()
  const stale = prompt.trim() !== '' && (selectionChanged || instructionsChanged)
  const busy = phase !== null

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
        className="inspector-scrollbar max-h-[92vh] w-[720px] max-w-[92vw] overflow-y-auto rounded-2xl border p-4"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-[14px] font-semibold">この場面の画像を生成</h3>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          ビート・場所・登場人物・追加指示から LLM が英語のプロンプトを書きます。参照画像を渡す人物は image1〜 で参照されます。
          生成した画像はストックに残り、「決定」を押すまで挿絵にはなりません。プロンプト・追加指示・seed・参照キャラは「生成」したときの組み合わせでこのシーンに保存されます(閉じるだけでは保存しません)。
        </p>

        {/* 参照画像を渡すキャラ(cast 順) */}
        {node.cast.length > 0 && (
          <div className="mb-3">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              参照画像を渡す人物(最大 {MAX_REFS} 人)
            </span>
            <div className="flex flex-wrap gap-1.5">
              {node.cast.map((id) => {
                const c = charById.get(id)
                if (!c) return null
                const hasRef = !!c.ref_image_path
                const on = sel.includes(id)
                const idx = on ? sel.indexOf(id) + 1 : 0
                const full = !on && sel.length >= MAX_REFS
                return (
                  <button
                    key={id}
                    onClick={() => hasRef && !full && toggle(id)}
                    disabled={busy || !hasRef || full}
                    className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                    style={
                      on
                        ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                        : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
                    }
                    data-tip={
                      !hasRef
                        ? `${c.name} には参照画像がありません(資料庫で作るか置くと選べます)。文章での描写になります`
                        : full
                          ? `参照画像は ${MAX_REFS} 人までです`
                          : on
                            ? `image${idx} として渡します。クリックで外す`
                            : 'クリックで参照画像を渡す'
                    }
                  >
                    {on ? '☑' : '☐'} {c.name}
                    {on ? ` (image${idx})` : ''}
                    {!hasRef ? '(参照なし)' : ''}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* 作者の追加指示。LLM に渡してプロンプトへ織り込む(案 A。docs/design/image-gen.md §6) */}
        <label className="mb-3 block">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            追加指示(日本語可。構図・時間帯・表情・服装など)
          </span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={busy}
            rows={2}
            className="w-full rounded-md border px-2 py-1.5 text-[12px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
        </label>

        <span className="mb-1 block text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          プロンプト(英語。手直しできます)
        </span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
          rows={5}
          placeholder={phase === 'prompt' ? 'プロンプトを作成中…' : ''}
          className="w-full rounded-md border px-2 py-1.5 text-[12px] outline-none"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
        />
        {data && (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            後ろに自動で足す指示: {data.suffix}
          </p>
        )}
        {stale && (
          <p className="mt-1 text-[11px]" style={{ color: '#f2a3a3' }}>
            {selectionChanged
              ? '参照画像の選び方が変わったので、image のラベルが合いません。'
              : '追加指示が変わりました。'}
            「書き直す」でプロンプトを作り直してください。
          </p>
        )}

        {/* 生成 → プレビュー。ここで気に入らなければ seed を変えて引き直す */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void generate()}
            disabled={busy || !prompt.trim() || stale}
            className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
            data-tip={
              stale
                ? '先にプロンプトを書き直してください'
                : candidate
                  ? '同じ seed なら同じ絵になります。seed を -1 にすると別の絵を引きます'
                  : 'ComfyUI で画像を生成します(挿絵にはまだ設定しません)'
            }
          >
            {phase === 'generate' ? '生成中…' : candidate ? 'もう一度生成' : '生成'}
          </button>
          <SeedField seed={seed} onChange={setSeed} disabled={busy} />
          <button
            onClick={() => void buildPrompt(selected)}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip="今の選択と追加指示で LLM にプロンプトを書き直させます"
          >
            書き直す
          </button>
          {phase && phase !== 'apply' && (
            <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {phase === 'prompt' ? 'プロンプトを作成中…' : 'ComfyUI で生成中…'}
              <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>({elapsed}s)</span>
            </span>
          )}
        </div>
        <div className="mt-3">
          <CandidatePreview candidate={candidate} current={node.image_path} currentLabel="いまの挿絵" aspect="1216 / 832" />
        </div>
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: '#f2a3a3' }}>
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void apply()}
            disabled={busy || !candidate}
            className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
            data-tip={candidate ? 'この画像をシーンの挿絵にして閉じます' : '先に生成してください'}
          >
            {phase === 'apply' ? '設定中…' : '決定'}
          </button>
          {candidate && (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
              seed {candidate.seed}
            </span>
          )}
          <button
            onClick={close}
            className="ml-auto rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip={candidate ? '生成した画像は挿絵にせずに閉じます(候補はストックに残ります)' : '閉じるだけでは設定を保存しません(生成したときに保存されます)'}
          >
            {phase === 'generate' ? 'キャンセル' : '閉じる'}
          </button>
        </div>
      </div>
    </div>
  )
}
