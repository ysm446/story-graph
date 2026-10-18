import DetailSplit from '../../DetailSplit'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, assetUrl, isVideoAsset, uploadAsset } from '../../api'
import { showStatusNotice } from '../../statusNotice'
import EventsEditor from '../../EventsEditor'
import { Icon } from '../../icons'
import ProofreadTextarea from '../../ProofreadTextarea'
import Lightbox from '../../Lightbox'
import MediaPicker from '../../MediaPicker'
import SceneImageModal from '../../SceneImageModal'
import { useElapsedSeconds } from '../../useElapsed'
import type { Character, ElapsedUnit, Place, StoryNode } from '../../types'
import { beatDraftCache, deleteBeatDraft, savedBeatDraft, setBeatDraft } from './beatDrafts'
import { latestEventInputs } from './events'

// ---- ビートタブ ------------------------------------------------------

// 前のシーンからの経過の選択肢(backend/story_clock.py の単位と同じ並び)。空 = 未設定
const ELAPSED_OPTIONS: [string, string][] = [
  ['', '未設定'],
  ['immediate', '直後'],
  ['same_day', '同じ日'],
  ['hour', '時間後'],
  ['day', '日後'],
  ['week', '週間後'],
  ['month', 'か月後'],
  ['year', '年後']
]
const COUNTED_ELAPSED = ['hour', 'day', 'week', 'month', 'year']

export function BeatTab({
  node,
  characters,
  places,
  inheritedPlaceName,
  validation,
  onSaved,
  onDeleted,
  onNodeBusyChange,
  aiProtected,
  protectionLocked,
  onToggleProtection
}: {
  aiProtected: boolean
  protectionLocked: boolean
  onToggleProtection: () => void
  node: StoryNode
  characters: Character[]
  places: Place[]
  /** location が空欄のとき親から引き継がれる場所の名前(無ければ null) */
  inheritedPlaceName: string | null
  validation: string[]
  onSaved: () => void
  onDeleted: () => void
  onNodeBusyChange: (nodeId: string, busy: boolean) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Partial<StoryNode>>({})
  // draft がどのシーンのものか。node が切り替わった直後の 1 レンダーでは draft が
  // まだ前のシーンの値なので、取り違えて退避しないよう突き合わせに使う
  const [draftNodeId, setDraftNodeId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [draftReset, setDraftReset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState<'title' | 'emotional_core' | 'elapsed' | 'location' | null>(null)
  // 退場の入力中(理由をインラインで入力する。Electron は window.prompt が使えない)
  const [retireTarget, setRetireTarget] = useState<string | null>(null)
  const [retireReason, setRetireReason] = useState('death')
  const [imageDragOver, setImageDragOver] = useState(false)
  const [sceneImageOpen, setSceneImageOpen] = useState(false)
  // 挿絵のストック(候補の一覧)ウインドウ
  const [stockOpen, setStockOpen] = useState(false)
  // 挿絵のサムネイルをクリックしたときの拡大表示
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const suggestElapsed = useElapsedSeconds(suggesting !== null)
  const imageDragDepth = useRef(0) // 子要素との境界で dragleave が発火してもチラつかないよう深さを数える
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const coreTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  // いま表示しているシーン。自動生成の応答が別のシーンの下書きに混ざらないよう突き合わせる
  const shownNodeId = useRef(node.id)
  shownNodeId.current = node.id

  const handleImageFile = (file: File): void => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      setError('画像または動画ファイルをドロップしてください')
      return
    }
    // ストックに足して、そのまま挿絵にする(前の挿絵はストックに残る)
    void uploadAsset(file)
      .then(({ path }) => api.addMedia('node', node.id, path))
      .then(onSaved)
      .catch((err) => setError(String(err)))
  }

  // 感情の核はスクロールさせず、内容に合わせて高さを自動調整する
  // (シーン本文は ProofreadTextarea が自前で行う)
  const autosize = useCallback((textarea: HTMLTextAreaElement | null): void => {
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight + 2}px`
  }, [])

  useEffect(() => {
    autosize(coreTextareaRef.current)
  }, [draft.emotional_core, node.id, autosize])

  // サイドバーのリサイズ等で幅が変わると折り返しが変わるため、幅の変化でも再計算する
  useEffect(() => {
    const textarea = coreTextareaRef.current
    if (!textarea) return
    let lastWidth = textarea.clientWidth
    const observer = new ResizeObserver(() => {
      const width = textarea.clientWidth
      if (width !== lastWidth) {
        lastWidth = width
        autosize(textarea)
      }
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [node.id, autosize])

  const suggestField = (field: 'title' | 'emotional_core'): void => {
    const beat = (draft.beat ?? '').trim()
    if (!beat || suggesting) return
    const targetId = node.id // 応答が返るまでに別のシーンへ移っていたら捨てる
    setSuggesting(field)
    setError(null)
    api
      .suggestSceneMeta(beat, field)
      .then(({ value }) => {
        if (value && shownNodeId.current === targetId) setDraft((d) => ({ ...d, [field]: value }))
      })
      .catch((e) => {
        if (shownNodeId.current === targetId) setError(String(e))
      })
      .finally(() => {
        if (shownNodeId.current === targetId) setSuggesting(null)
      })
  }

  // 経過 / 場所を本文から読み取って下書きに入れる(保存はしない)。本文に手がかりが無ければ何も変えない
  const suggestSetting = (field: 'elapsed' | 'location'): void => {
    const beat = (draft.beat ?? '').trim()
    if (!beat || suggesting) return
    const targetId = node.id // 応答が返るまでに別のシーンへ移っていたら捨てる
    const name = field === 'elapsed' ? '経過' : '場所'
    setSuggesting(field)
    setError(null)
    api
      .suggestSceneSetting(targetId, field, beat)
      .then((result) => {
        if (shownNodeId.current !== targetId) return
        if (!result.found) {
          showStatusNotice(`本文からは${name}を判断できませんでした(値は変えていません)`)
          return
        }
        const basis = result.evidence ? `(根拠: ${result.evidence})` : ''
        if (field === 'elapsed') {
          setDraft((d) => ({ ...d, elapsed_unit: result.elapsed_unit ?? null, elapsed_count: result.elapsed_count ?? null }))
        } else if (!draft.location && result.label === inheritedPlaceName) {
          // 前のシーンから引き継いでいる場所と同じなら、引き継ぎのままにする(場所が変わらない限り書かない)
          showStatusNotice(`場所は前のシーンと同じ「${result.label}」です(引き継ぎのまま)${basis}`)
          return
        } else {
          setDraft((d) => ({ ...d, location: result.location ?? null }))
        }
        showStatusNotice(`${name}を「${result.label}」と推測しました。保存すると確定します${basis}`)
      })
      .catch((e) => {
        if (shownNodeId.current === targetId) setError(String(e))
      })
      .finally(() => {
        if (shownNodeId.current === targetId) setSuggesting(null)
      })
  }

  useEffect(() => {
    // 退避済みの未保存下書きがあれば復元、無ければ保存値で初期化する
    const cached = beatDraftCache.get(node.id)
    setDraft(cached ?? savedBeatDraft(node))
    setDraftNodeId(node.id)
    setError(null)
    setSuggesting(null) // 前のシーンで押した自動生成の表示を引き継がない
    setRetireTarget(null) // 前のシーンで開いた退場理由の入力を残さない
  }, [node.id, node.updated_at])

  const toggleCast = (charId: string): void => {
    setDraft((d) => {
      const cast = d.cast ?? []
      return { ...d, cast: cast.includes(charId) ? cast.filter((c) => c !== charId) : [...cast, charId] }
    })
  }

  // このシーンで退場するキャラ(char_retire イベントを持っているキャラ)
  const retiredHere = node.events
    .filter((e) => e.type === 'char_retire')
    .map((e) => String((e.payload as { char?: string }).char ?? ''))

  // 退場は作者が決める。char_retire イベントの付け外しで表現する。
  // Electron では window.prompt が使えないので、理由の入力はインラインで行う
  const saveRetire = async (charId: string, reason: string): Promise<void> => {
    try {
      const events = await latestEventInputs(node.id, node.events)
      await api.putEvents(node.id, [
        ...events,
        { type: 'char_retire', payload: { char: charId, reason: reason.trim() || 'death' }, source: 'user' }
      ])
      setRetireTarget(null)
      onSaved()
    } catch (e) {
      setError(String(e))
    }
  }

  const cancelRetire = async (charId: string): Promise<void> => {
    try {
      const events = (await latestEventInputs(node.id, node.events)).filter(
        (e) => !(e.type === 'char_retire' && (e.payload as { char?: string }).char === charId)
      )
      await api.putEvents(node.id, events)
      onSaved()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleSave = async (): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    const sent = draft
    try {
      await api.updateNode(node.id, sent)
      // 保存できたら退避を破棄する。ただし保存中に打った分は退避に残っている
      // (下の effect が入力のたびに積む)ので、送った内容と同じときだけ消す。
      // 残した退避は再読込後の初期化(beatDraftCache から復元)で引き継がれる
      const latest = beatDraftCache.get(node.id)
      if (!latest || latest === sent) deleteBeatDraft(node.id)
      onSaved()
      return true
    } catch (e) {
      setError(String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  const resetDraft = (): void => {
    if (saving || suggesting || draftNodeId !== node.id) return
    setDraft(savedBeatDraft(node))
    deleteBeatDraft(node.id)
    setDraftReset((value) => value + 1)
    setError(null)
  }

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm('このシーンを削除しますか?(後続シーンは前のシーンに繋がります)')) return
    try {
      await api.deleteNode(node.id)
      deleteBeatDraft(node.id)
      onDeleted()
    } catch (e) {
      setError(`削除できません: ${String(e)}`)
    }
  }

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }
  const labelClass = 'mb-1 block text-[11px] uppercase tracking-[0.14em]'

  // 下書きがノードの保存値と異なるか(未初期化 / 前のシーンの下書きのままの間は false)
  const dirty =
    draftNodeId === node.id &&
    draft.beat !== undefined &&
    ((draft.title ?? '') !== (node.title ?? '') ||
      (draft.beat ?? '') !== (node.beat ?? '') ||
      (draft.emotional_core ?? '') !== (node.emotional_core ?? '') ||
      (draft.location ?? '') !== (node.location ?? '') ||
      (draft.elapsed_unit ?? null) !== (node.elapsed_unit ?? null) ||
      (draft.elapsed_count ?? null) !== (node.elapsed_count ?? null) ||
      JSON.stringify(draft.cast ?? []) !== JSON.stringify(node.cast ?? []))

  // 未保存の変更があればノード ID ごとに退避、変更が無ければ退避を掃除する。
  // シーンを切り替えた直後の 1 レンダーでは draft がまだ前のシーンのものなので、
  // 初期化(setDraft)が届くまで何もしない。ここで書いてしまうと、矢印キーで
  // 続けて移動したときに前のシーンの内容が移動先の下書きとして残ってしまう
  useEffect(() => {
    if (draftNodeId !== node.id) return // 初期化前(draft はまだ前のシーンのもの)
    if (draft.beat === undefined) return
    if (dirty) setBeatDraft(node.id, draft)
    else deleteBeatDraft(node.id)
  }, [draft, dirty, node.id, draftNodeId])

  return (
    <div className="scene-detail flex min-h-0 flex-1 flex-col">
      <DetailSplit storageKey="sceneDetailEventsWidth" defaultWidth={34} main={<>
          {/* 「★ このブランチを正史にする」は置かない(2026-08-02 ユーザー判断)。
              正史は**アクティブな結末から遡った道**なので、決めることは「どの結末を
              アクティブにするか」だけ。道を直接選ぶ操作があると概念が二重になるうえ、
              中身の make_canon は枝の先に結末が無いと黙って結末を作っていた。
              切替は結末ノードの右クリック「🏁 この結末にする」で行う。
              「ここから先のイベントを作り直す」も右クリックと同じ操作なので置かない */}
          {validation.length > 0 && (
            <div
              className="rounded-lg border px-3 py-2 text-[12px] leading-relaxed"
              style={{ borderColor: 'rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)', color: '#f2a3a3' }}
            >
              {validation.map((v, i) => (
                <div key={i}>⚠ {v}</div>
              ))}
            </div>
          )}
          <label className="block">
            <span className="mb-1 flex items-center justify-between">
              <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}>
                Title
              </span>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  suggestField('title')
                }}
                disabled={suggesting !== null || !(draft.beat ?? '').trim()}
                // 色は index.css の .accent-action(校正ボタンなど LLM を走らせるボタン共通)
                className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
                data-tip="シーン本文からタイトルを自動生成"
              >
                {suggesting === 'title' ? (
                  `生成中… (${suggestElapsed}s)`
                ) : (
                  <>
                    <Icon name="sparkle" size={11} />
                    自動生成
                  </>
                )}
              </button>
            </span>
            <input
              value={draft.title ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
              style={inputStyle}
            />
          </label>
          <label className="block">
            {/* 高さの自動調整と校正ボタンは共通コンポーネント側で行う(ボタンは見出しの右端に常に出る)。
                長いシーン本文の一部を直すことがあるので、前後を文脈として渡す */}
            <ProofreadTextarea
              label={
                <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}>
                  シーン(出来事の仕様書)
                </span>
              }
              key={`${node.id}:${draftReset}`}
              rows={4}
              value={draft.beat ?? ''}
              onChange={(next) => setDraft((d) => ({ ...d, beat: next }))}
              style={inputStyle}
              withContext
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between">
              <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}>
                Emotional core
              </span>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  suggestField('emotional_core')
                }}
                disabled={suggesting !== null || !(draft.beat ?? '').trim()}
                // 色は index.css の .accent-action(校正ボタンなど LLM を走らせるボタン共通)
                className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
                data-tip="シーン本文から感情の核を自動生成"
              >
                {suggesting === 'emotional_core' ? (
                  `生成中… (${suggestElapsed}s)`
                ) : (
                  <>
                    <Icon name="sparkle" size={11} />
                    自動生成
                  </>
                )}
              </button>
            </span>
            {/* 長い一文になることがあるので、input ではなく自動で高さが伸びる textarea */}
            <textarea
              ref={coreTextareaRef}
              rows={1}
              value={draft.emotional_core ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, emotional_core: e.target.value }))}
              className="w-full resize-none overflow-hidden rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none"
              style={inputStyle}
            />
          </label>
      </>} aside={<>
          {/* 挿絵(画像/動画。装飾専用。LLM には渡さない) */}
          {createPortal(<>
          {lightboxOpen && node.image_path && assetUrl(node.image_path) && (
            <Lightbox src={assetUrl(node.image_path)!} path={node.image_path} onClose={() => setLightboxOpen(false)} />
          )}
          {sceneImageOpen && (
            <SceneImageModal
              node={node}
              characters={characters}
              onGenerated={onSaved}
              onClose={() => setSceneImageOpen(false)}
            />
          )}
          {stockOpen && (
            <MediaPicker
              ownerType="node"
              ownerId={node.id}
              aspect="1216 / 832"
              accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm"
              onChanged={onSaved}
              onClose={() => setStockOpen(false)}
            />
          )}
          </>, document.body)}
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                挿絵
              </span>
              {/* 左から確かめて、最後に押す「生成」は右端(生成ウインドウと同じ並び) */}
              <div className="flex flex-1 flex-wrap gap-1.5">
                <button
                  onClick={() => setStockOpen(true)}
                  className="rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip="生成した候補と手持ちの画像・動画の一覧。ここから 1 枚を選び直したり、いらない候補を削除したりできます"
                >
                  ストック
                </button>
                <button
                  onClick={() => imageInputRef.current?.click()}
                  className="rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                >
                  {node.image_path ? '変更' : '+ 画像/動画を添付'}
                </button>
                {node.image_path && (
                  <button
                    onClick={() => void api.setNodeImage(node.id, null).then(onSaved)}
                    className="rounded-md border px-2 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                    data-tip="挿絵を外します(ストックには残るので、あとから選び直せます)"
                  >
                    外す
                  </button>
                )}
                <button
                  onClick={() => setSceneImageOpen(true)}
                  className="accent-action ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium"
                  data-tip="ビート・場所・登場人物(参照画像)から ComfyUI でこの場面の画像を生成します"
                >
                  <Icon name="sparkle" size={11} /> 生成
                </button>
              </div>
            </div>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) handleImageFile(file)
              }}
            />
            <div
              onDragEnter={(e) => {
                e.preventDefault()
                imageDragDepth.current += 1
                setImageDragOver(true)
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => {
                imageDragDepth.current -= 1
                if (imageDragDepth.current <= 0) {
                  imageDragDepth.current = 0
                  setImageDragOver(false)
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                imageDragDepth.current = 0
                setImageDragOver(false)
                const file = e.dataTransfer.files?.[0]
                if (file) handleImageFile(file)
              }}
              onClick={() => {
                // 挿絵が無ければファイル選択、あれば拡大表示
                if (!node.image_path) imageInputRef.current?.click()
                else setLightboxOpen(true)
              }}
              className="relative cursor-zoom-in rounded-xl transition-colors"
              data-tip={node.image_path ? 'クリックで拡大 / ドロップで差し替え' : undefined}
              style={imageDragOver ? { outline: '2px dashed var(--accent)', outlineOffset: 2 } : undefined}
            >
              {assetUrl(node.image_path) ? (
                <>
                  {isVideoAsset(node.image_path) ? (
                    <video
                      src={assetUrl(node.image_path)!}
                      autoPlay
                      muted
                      loop
                      playsInline
                      className="pointer-events-none h-auto w-full rounded-xl"
                    />
                  ) : (
                    <img
                      src={assetUrl(node.image_path)!}
                      draggable={false}
                      className="pointer-events-none h-auto w-full rounded-xl"
                    />
                  )}
                  {imageDragOver && (
                    <span
                      className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl text-[12px] font-medium"
                      style={{ background: 'rgba(13,15,20,0.7)', color: 'var(--accent)' }}
                    >
                      ドロップで差し替え
                    </span>
                  )}
                </>
              ) : (
                <div
                  data-write-action
                  className="cursor-pointer rounded-xl border border-dashed px-3 py-2 text-center text-[12px]"
                  style={{
                    borderColor: imageDragOver ? 'var(--accent)' : 'var(--border-strong)',
                    color: imageDragOver ? 'var(--accent)' : 'var(--text-faint)'
                  }}
                >
                  ここに画像/動画をドロップ(またはクリックで選択)
                </div>
              )}
            </div>
          </div>
          <div>
            <span className={labelClass} style={{ color: 'var(--text-faint)' }}>
              Cast
            </span>
            <div className="flex flex-wrap gap-1.5">
              {characters.map((c) => {
                const active = (draft.cast ?? []).includes(c.id)
                const retired = retiredHere.includes(c.id)
                return (
                  <span
                    key={c.id}
                    // ⊗ が出る(cast 入り)ときだけ右の余白を詰める。出ないときは左右対称に
                    className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 text-[12px] ${
                      active ? 'pr-1' : 'pr-2.5'
                    }`}
                    style={
                      active
                        ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--text)' }
                        : { background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-faint)' }
                    }
                  >
                    <button onClick={() => toggleCast(c.id)} className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color ?? '#8a8fa8' }} />
                      <span className={retired ? 'line-through' : undefined}>{c.name}</span>
                    </button>
                    {/* 退場は作者が決める(LLM には出させない)。このシーンで退場させる */}
                    {active && (
                      <button
                        onClick={() => {
                          if (retired) void cancelRetire(c.id)
                          else {
                            setRetireReason('death')
                            setRetireTarget(c.id)
                          }
                        }}
                        className="rounded-full px-1 text-[11px]"
                        style={{ color: retired ? 'var(--accent)' : 'var(--text-faint)' }}
                        data-tip={
                          retired
                            ? 'このシーンでの退場を取り消す'
                            : 'このシーンで退場させる(以降 cast に入れると警告)'
                        }
                      >
                        {retired ? '⏎' : '⊗'}
                      </button>
                    )}
                  </span>
                )
              })}
            </div>
            {/* 退場の理由を入力(Electron では prompt が使えないためインラインで) */}
            {retireTarget && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                <span style={{ color: 'var(--text-dim)' }}>
                  {characters.find((c) => c.id === retireTarget)?.name} を退場させる理由:
                </span>
                <input
                  autoFocus
                  value={retireReason}
                  onChange={(e) => setRetireReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void saveRetire(retireTarget, retireReason)
                    }
                    if (e.key === 'Escape') setRetireTarget(null)
                  }}
                  placeholder="death / departure など"
                  className="w-40 rounded-md border px-1.5 py-0.5 outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--accent-border)' }}
                />
                <button
                  onClick={() => void saveRetire(retireTarget, retireReason)}
                  className="rounded-md px-2 py-0.5 text-[12px] font-medium text-white"
                  style={{ background: 'var(--accent)' }}
                >
                  退場させる
                </button>
                <button onClick={() => setRetireTarget(null)} style={{ color: 'var(--text-faint)' }}>
                  取消
                </button>
              </div>
            )}
            {retiredHere.length > 0 && (
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                このシーンで退場: {retiredHere.map((id) => characters.find((c) => c.id === id)?.name ?? id).join(', ')}
              </p>
            )}
          </div>
          {/* 縦に積む: 左の列は 200px まで狭くなり、横に並べると経過の単位(「か月後」)が切れる */}
          <div className="grid gap-3">
            <label className="block">
              <span className="mb-1 flex items-center justify-between">
              <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}>
                Location
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  suggestSetting('location')
                }}
                disabled={suggesting !== null || !(draft.beat ?? '').trim() || places.length === 0}
                className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
                data-tip={places.length === 0 ? '場所が登録されていません。資料庫で場所を登録すると推測できます'
                  : 'シーン本文から、登録済みの場所のどれに当たるかを推測(保存するまで確定しません。本文に手がかりが無ければ変えません)'}
              >
                {suggesting === 'location' ? (
                  `推測中… (${suggestElapsed}s)`
                ) : (
                  <>
                    <Icon name="sparkle" size={11} />
                    推測
                  </>
                )}
              </button>
              </span>
              {/* 場所は登録制。未指定なら親から引き継ぐ(docs/design/places.md) */}
              <select
                value={draft.location ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value || null }))}
                className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
                style={{
                  ...inputStyle,
                  color: draft.location ? 'var(--text)' : 'var(--text-faint)'
                }}
              >
                <option value="">
                  {inheritedPlaceName ? `引き継ぎ(${inheritedPlaceName})` : '指定しない'}
                </option>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {places.length === 0 && (
                <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-faint)' }}>
                  資料庫の「場所」タブで登録できます
                </span>
              )}
            </label>
            <div>
              <span className="mb-1 flex items-center justify-between">
              <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}
                data-tip={['前のシーンからどれだけ時間が経ったか。清書と登場人物との会話に渡ります。',
                  '・未設定 — 決めていない(直後とは限らないものとして扱う)',
                  '・直後 — 前のシーンからひとつながり',
                  '・同じ日 — 場面は変わるが、日はまたがない(何時間後かは決めない)',
                  '・時間後 / 日後 … — はっきり分かるときに、数を入れる'].join('\n')}>
                Elapsed
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  suggestSetting('elapsed')
                }}
                disabled={suggesting !== null || !(draft.beat ?? '').trim()}
                className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
                data-tip="前のシーンの終わりとこのシーンの本文から、経過を推測(保存するまで確定しません。本文に手がかりが無ければ未設定のままにします)"
              >
                {suggesting === 'elapsed' ? (
                  `推測中… (${suggestElapsed}s)`
                ) : (
                  <>
                    <Icon name="sparkle" size={11} />
                    推測
                  </>
                )}
              </button>
              </span>
              {/* 数は「時間後」以降だけが持つ。単位を選ぶと左に数の欄が出る(「3」「日後」と読める並び) */}
              <div className="flex gap-1.5">
                {COUNTED_ELAPSED.includes(draft.elapsed_unit ?? '') && (
                  <input
                    type="number" min={1} max={9999} aria-label="経過の数"
                    value={draft.elapsed_count ?? 1}
                    onChange={(e) => {
                      const count = Math.min(9999, Math.max(1, Math.floor(Number(e.target.value)) || 1))
                      setDraft((d) => ({ ...d, elapsed_count: count }))
                    }}
                    className="w-16 shrink-0 rounded-lg border px-2 py-1.5 text-[13px] tabular-nums outline-none"
                    style={inputStyle}
                  />
                )}
                <select
                  aria-label="前のシーンからの経過"
                  value={draft.elapsed_unit ?? ''}
                  onChange={(e) => {
                    const unit = (e.target.value || null) as ElapsedUnit | null
                    setDraft((d) => ({
                      ...d,
                      elapsed_unit: unit,
                      elapsed_count: COUNTED_ELAPSED.includes(unit ?? '') ? (d.elapsed_count ?? 1) : null
                    }))
                  }}
                  className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-[13px] outline-none"
                  style={{ ...inputStyle, color: draft.elapsed_unit ? 'var(--text)' : 'var(--text-faint)' }}
                >
                  {ELAPSED_OPTIONS.map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void handleDelete()} className="delete-action ml-auto text-[12px]">
              削除
            </button>
          </div>
      </>} secondary={<>
          <EventsEditor
            node={node}
            characters={characters}
            onChanged={onSaved}
            onBusyChange={(busy: boolean) => onNodeBusyChange(node.id, busy)}
          />
      </>} />
      <div className="shrink-0 border-t px-5 py-2" style={{ borderColor: 'var(--border)', background: 'var(--bg-sidebar)' }}>
        {error && <div role="alert" className="mb-1 text-[12px]" style={{ color: 'var(--danger)' }}>{error}</div>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {dirty && <span role="status" className="min-w-0 text-[11px]" style={{ color: 'var(--text-dim)' }}>
            未保存の変更があります
          </span>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              onClick={onToggleProtection}
              aria-label="AI編集から保護"
              aria-pressed={aiProtected}
              disabled={protectionLocked}
              className="rounded-md border px-2 py-0.5 disabled:opacity-50"
              style={{ borderColor: 'var(--border-strong)', ...(aiProtected
                ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                : { color: 'var(--text-faint)' }) }}
              data-tip={protectionLocked ? 'AI編集から保護：制作を停止してから変更できます' : `${aiProtected ? 'AI編集から保護中（クリックで解除）' : 'クリックでAI編集から保護'}。制作LLMによる変更・削除・直接の接続変更を防ぎます。手動編集はできます。保存操作なしで反映されます`}
            >
              <Icon name={aiProtected ? 'robotLock' : 'robotUnlock'} size={20} strokeWidth={1.6} />
            </button>
            <button
              onClick={resetDraft}
              disabled={!dirty || saving || suggesting !== null}
              className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip={saving || suggesting !== null ? '保存・自動生成が終わるまでお待ちください' : dirty ? 'このシーンの未保存の変更を取り消します' : '変更はありません'}
            >元に戻す</button>
          <button
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="shrink-0 rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
            data-tip={dirty ? 'シーンの変更を保存します(Ctrl+S。複数のシーンを選択していれば、未保存のものをまとめて保存します)' : '変更はありません'}
          >
            保存
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}
