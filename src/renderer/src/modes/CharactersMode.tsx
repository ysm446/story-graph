import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, assetUrl, uploadAsset } from '../api'
import CharacterVoicePanel from '../CharacterVoicePanel'
import ImageCropModal, { type CropState } from '../ImageCropModal'
import PlaceEditor from './PlaceEditor'
import RefImagePanel from '../RefImagePanel'
import ProofreadTextarea from '../ProofreadTextarea'
import RelationGraph from '../RelationGraph'
import type { Character, Place, StoryGraph, StoryNode } from '../types'
import { useWorkspace } from '../Workspace'
import UnsavedBadge from '../UnsavedBadge'
import CharAvatar from '../CharAvatar'

const EDITABLE_FIELDS = ['name', 'color', 'profile', 'appearance', 'voice', 'reading'] as const

const FIELD_DEFS: Array<{ key: 'profile' | 'appearance' | 'voice'; label: string; rows: number }> = [
  { key: 'profile', label: 'プロフィール(性格の基調・背景)', rows: 5 },
  { key: 'appearance', label: '外見', rows: 3 },
  { key: 'voice', label: '口調・一人称', rows: 3 }
]

/** 資料の種類。「関係図」はキャラクターの表示方法として扱う。 */
type Tab = 'characters' | 'places'

/** 資料庫。キャラクターと場所を同じシェル(リサイズ可能なサイドバー + 編集ペイン)で扱う。
 *  場所も登録制のエンティティなので、庫としては同じ性格のもの(docs/design/places.md)。 */
// memo: 非表示(display: none)でもマウントされたままなので、App の再レンダーに巻き込まない
export default memo(CharactersMode)

function CharactersMode(): React.JSX.Element {
  const workspace = useWorkspace()
  const [placeDirty, setPlaceDirty] = useState(false)
  const [placeUnsaved, setPlaceUnsaved] = useState(false)
  const [libraryVersion, setLibraryVersion] = useState(0)
  const reloadSequence = useRef(0)
  const [tab, setTab] = useState<Tab>('characters')
  const [expanded, setExpanded] = useState({ characters: true, places: true })
  // キャラクターの見せ方(一覧+編集 ⇄ 関係図)。場所には無い切り替えなので、タブとは別に持つ
  const [showRelations, setShowRelations] = useState(false)
  const [characters, setCharacters] = useState<Character[]>([])
  const [places, setPlaces] = useState<Place[]>([])
  // 関係図用: ノードグラフ(正史パスの導出と履歴表示に使う)とエゴ選択
  const [graph, setGraph] = useState<StoryGraph | null>(null)
  const [egoCharId, setEgoCharId] = useState<string | null>(null)
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [draft, setDraft] = useState<Partial<Character>>({})
  const [draftReset, setDraftReset] = useState(0)
  const [saving, setSaving] = useState(false)
  const [cropTarget, setCropTarget] = useState<{
    source: File | string
    isNewFile: boolean
    initial: CropState | null
    /** 保存済みアセットから切り抜くときの元画像パス(参照画像からの顔切り抜き用。省略時は今の元画像) */
    sourcePath?: string
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // プロフィール画像へのドラッグ&ドロップ。子要素をまたぐと dragleave が誤発火するので、
  // 深さを数えて 0 になったときだけハイライトを消す(シーンの挿絵と同じ作り)
  const [portraitDragOver, setPortraitDragOver] = useState(false)
  const portraitDragDepth = useRef(0)
  const rowRef = useRef<HTMLDivElement | null>(null)
  // 左サイドバーの幅(ドラッグで変更。localStorage に保存)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('charactersSidebarWidth'))
    // 種類の見出しと資料名が読める既定幅
    return saved >= 180 && saved <= 520 ? saved : 288
  })

  const beginSidebarResize = useCallback((event: React.PointerEvent): void => {
    event.preventDefault()
    const onMove = (ev: PointerEvent): void => {
      const rect = rowRef.current?.getBoundingClientRect()
      if (!rect) return
      setSidebarWidth(Math.min(520, Math.max(180, ev.clientX - rect.left)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setSidebarWidth((w) => {
        localStorage.setItem('charactersSidebarWidth', String(Math.round(w)))
        return w
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  /** 選択・ドロップされた画像を切り抜きモーダルへ渡す(既に画像があれば差し替え)。
   *  アイコンなので画像のみ受け付ける(挿絵と違って動画は扱わない)。 */
  const acceptPortraitFile = (file: File | undefined): void => {
    if (!file || !selectedId) return
    if (!file.type.startsWith('image/')) return
    setCropTarget({ source: file, isNewFile: true, initial: null })
  }

  const openRecrop = (): void => {
    // 保存済みの元画像から切り抜き直す(前回の位置・ズームを復元)
    const sourcePath = draft.portrait_source_path
    const url = assetUrl(sourcePath)
    if (!url) return
    let initial: CropState | null = null
    try {
      initial = draft.portrait_crop ? (JSON.parse(draft.portrait_crop) as CropState) : null
    } catch {
      initial = null
    }
    setCropTarget({ source: url, isNewFile: false, initial })
  }

  const handleCropped = async (blob: Blob, state: CropState): Promise<void> => {
    const target = cropTarget
    if (!target || !selectedId) {
      setCropTarget(null)
      return
    }
    // 失敗時はモーダルを残す(切り抜き結果を黙って捨てない)
    try {
      const sourcePath = target.isNewFile
        ? (await uploadAsset(target.source as File)).path
        : target.sourcePath ?? draft.portrait_source_path
      const cropped = new File([blob], 'portrait.png', { type: 'image/png' })
      const { path } = await uploadAsset(cropped)
      const patch = {
        portrait_path: path,
        portrait_source_path: sourcePath,
        portrait_crop: JSON.stringify(state)
      }
      await api.updateCharacter(selectedId, patch)
      setCropTarget(null)
      setDraft((d) => ({ ...d, ...patch }))
      await reload()
    } catch (e) {
      window.alert(`画像の保存に失敗しました: ${String(e)}`)
    }
  }

  const selected = characters.find((c) => c.id === selectedId) ?? null
  const selectedPlace = places.find((p) => p.id === selectedPlaceId) ?? null

  const reload = async (refreshDraft = false): Promise<void> => {
    const sequence = ++reloadSequence.current
    const [chars, placeList, g] = await Promise.all([
      api.listCharacters(),
      api.listPlaces(),
      api.getGraph()
    ])
    if (sequence !== reloadSequence.current) return
    setCharacters(chars)
    setPlaces(placeList)
    setGraph(g)
    if (refreshDraft && selectedId === selectedIdRef.current && !workspace.libraryDirty.current) {
      setDraft(chars.find((c) => c.id === selectedId) ?? {})
      setLibraryVersion((value) => value + 1)
    }
  }

  // 正史パス(canon エッジを根から辿る。StructureMode と同じ導出)
  const canonPath = useMemo(() => {
    if (!graph) return [] as StoryNode[]
    const canonChildren = new Map(graph.edges.filter((e) => e.is_canon).map((e) => [e.from_node, e.to_node]))
    const hasParent = new Set(graph.edges.map((e) => e.to_node))
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
    const root = graph.nodes.find((n) => !hasParent.has(n.id))
    if (!root) return [] as StoryNode[]
    const path: StoryNode[] = [root]
    const seen = new Set([root.id])
    let current = root.id
    while (canonChildren.has(current)) {
      const next = canonChildren.get(current)!
      if (seen.has(next)) break
      const node = nodeById.get(next)
      if (!node) break
      path.push(node)
      seen.add(next)
      current = next
    }
    return path
  }, [graph])

  useEffect(() => {
    setDraft(selected ?? {})
  }, [selectedId, selected?.id])


  // 関係図はキャラクターの見せ方なので、場所を見ている間は出さない
  const relationsView = tab === 'characters' && showRelations

  const followedTarget = useRef(workspace.productionTarget)
  useEffect(() => {
    const target = workspace.productionTarget
    if (!target || target.kind === 'scene' || followedTarget.current === target || workspace.libraryDirty.current) return
    if (target.kind === 'character') {
      const character = characters.find((item) => item.id === target.id)
      if (!character) return
      setTab('characters')
      setExpanded((value) => ({ ...value, characters: true }))
      setShowRelations(false)
      setSelectedId(target.id)
      setDraft(character)
    } else {
      if (!places.some((item) => item.id === target.id)) return
      setTab('places')
      setExpanded((value) => ({ ...value, places: true }))
      setSelectedPlaceId(target.id)
    }
    followedTarget.current = target
  }, [workspace.productionTarget, characters, places, workspace.libraryDirty])

  const handleCreate = async (kind: Tab): Promise<void> => {
    if (kind === 'places') {
      const created = await api.createPlace({ name: '新しい場所', color: '#5a8fa7' })
      await reload()
      setTab('places')
      setExpanded((value) => ({ ...value, places: true }))
      setSelectedPlaceId(created.id)
      return
    }
    const created = await api.createCharacter({ name: '新しいキャラクター', color: '#7c5af7' })
    await reload()
    setTab('characters')
    setShowRelations(false)
    setExpanded((value) => ({ ...value, characters: true }))
    setSelectedId(created.id)
  }

  const handleSave = async (): Promise<void> => {
    if (!selectedId) return
    setSaving(true)
    try {
      // 編集欄の項目だけ送る。draft は選択時点の丸ごとコピーなので、そのまま PATCH すると
      // 選択後にその場で保存された項目(参照画像・関係図の座標など)を古い値で巻き戻す
      const patch = Object.fromEntries(
        EDITABLE_FIELDS.map((k) => [k, draft[k] ?? ''])
      )
      await api.updateCharacter(selectedId, patch)
      await reload()
    } finally {
      setSaving(false)
    }
  }

  // 下書きが保存値と異なるか(シーンエディタと同じ判定方式)。画像は
  // 切り抜き確定時にその場で保存されるので、ここでは判定に含めない
  const dirty =
    selected !== null &&
    EDITABLE_FIELDS.some(
      (key) => (draft[key] ?? '') !== (selected[key] ?? '')
    )

  const resetDraft = (): void => {
    if (!selected || saving || cropTarget !== null || !dirty) return
    const saved = Object.fromEntries(EDITABLE_FIELDS.map((key) => [key, selected[key] ?? '']))
    setDraft((current) => ({ ...current, ...saved }))
    setDraftReset((value) => value + 1)
  }

  useEffect(() => {
    workspace.libraryDirty.current = dirty || placeDirty || saving || cropTarget !== null
    return () => { workspace.libraryDirty.current = false }
  }, [dirty, placeDirty, saving, cropTarget, workspace.libraryDirty])

  useEffect(() => {
    if (workspace.mode === 'characters') void reload(!(dirty || placeDirty || saving))
  }, [workspace.revision, workspace.mode])

  const handleDelete = async (): Promise<void> => {
    if (!selectedId) return
    if (!window.confirm(`「${selected?.name}」を削除しますか?`)) return
    await api.deleteCharacter(selectedId)
    setSelectedId(null)
    await reload()
  }

  return (
    <div ref={rowRef} className="flex h-full">
      {cropTarget && (
        <ImageCropModal
          source={cropTarget.source}
          initial={cropTarget.initial}
          title="プロフィール画像の切り抜き"
          onCancel={() => setCropTarget(null)}
          onCropped={handleCropped}
        />
      )}
      <aside
        className="flex shrink-0 flex-col"
        style={{ background: 'var(--bg-sidebar)', width: sidebarWidth }}
      >
        <div className="px-3 py-2 text-[13px] font-medium" style={{ color: 'var(--text)' }}>資料庫</div>
        <nav aria-label="資料の種類と一覧" className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {([['characters', 'キャラクター'], ['places', '場所']] as const).map(([kind, label]) => (
            <section key={kind} className="mb-2">
              <div className="flex flex-wrap items-center gap-1">
                <button onClick={() => setExpanded((value) => ({ ...value, [kind]: !value[kind] }))}
                  aria-expanded={expanded[kind]} aria-controls={`library-${kind}`}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium hover:bg-[var(--accent-soft)]"
                  style={{ color: 'var(--text)' }} data-tip={`${label}の一覧を開閉します`}>
                  <span aria-hidden="true" className="shrink-0">{expanded[kind] ? '▾' : '▸'}</span>
                  <span className="truncate">{label}</span>
                </button>
                {kind === 'characters' && <button
                  onClick={() => { setTab('characters'); setShowRelations(!relationsView); setExpanded((value) => ({ ...value, characters: true })) }}
                  aria-pressed={relationsView}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] hover:bg-[var(--accent-soft)]"
                  style={{ color: relationsView ? 'var(--text)' : 'var(--text-dim)', background: relationsView ? 'var(--accent-soft)' : undefined }}
                  data-tip={relationsView ? 'キャラクターの編集に戻す' : 'キャラクターどうしの関係図を開く'}>関係図</button>}
                <button onClick={() => void handleCreate(kind)} aria-label={`${label}を追加`}
                  className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip={`${label}を追加`}>+</button>
              </div>
              <div id={`library-${kind}`} hidden={!expanded[kind]} className="ml-3 border-l pl-1" style={{ borderColor: 'var(--border)' }}>
                {kind === 'characters' ? characters.map((character) => (
                  <button key={character.id}
                    onClick={() => { setTab('characters'); setShowRelations(false); setSelectedId(character.id) }}
                    className="mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]"
                    style={{ background: tab === 'characters' && !relationsView && character.id === selectedId ? 'var(--accent-soft)' : undefined, color: character.id === selectedId && tab === 'characters' ? 'var(--text)' : 'var(--text-dim)' }}
                    data-tip={character.name}>
                    <CharAvatar char={character} size={24} />
                    <span className="min-w-0 flex-1 truncate">{character.name}</span>
                    {character.id === selectedId && dirty && <UnsavedBadge />}
                  </button>
                )) : places.map((place) => (
                  <button key={place.id} onClick={() => { setTab('places'); setSelectedPlaceId(place.id) }}
                    className="mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]"
                    style={{ background: tab === 'places' && place.id === selectedPlaceId ? 'var(--accent-soft)' : undefined, color: tab === 'places' && place.id === selectedPlaceId ? 'var(--text)' : 'var(--text-dim)' }}
                    data-tip={place.name}>
                    <span className="h-6 w-1.5 shrink-0 rounded-full" style={{ background: place.color ?? 'var(--text-dim)' }} />
                    <span className="min-w-0 flex-1 truncate">{place.name}</span>
                    {place.id === selectedPlaceId && placeUnsaved && <UnsavedBadge />}
                  </button>
                ))}
                {(kind === 'characters' ? characters : places).length === 0 && <p className="px-2 py-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>まだ{label}がありません</p>}
              </div>
            </section>
          ))}
        </nav>
      </aside>
      {/* サイドバー幅のリサイズハンドル(構造モードのインスペクタと同じ作り) */}
      <div
        className="relative w-px shrink-0 cursor-col-resize transition-colors hover:bg-[var(--accent-border)]"
        style={{ background: 'var(--border)' }}
        data-tip="ドラッグで幅を変更"
      >
        <div
          onPointerDown={beginSidebarResize}
          className="absolute inset-y-0 z-10 cursor-col-resize"
          style={{ left: -3, right: -3 }}
        />
      </div>
      <main className="inspector-scrollbar min-w-0 flex-1 overflow-y-auto p-6">
        <div hidden={tab !== 'places'}>
          {selectedPlace ? (
            <PlaceEditor
              key={`${selectedPlace.id}:${libraryVersion}`}
              place={selectedPlace}
              onChanged={reload}
              onDirty={setPlaceDirty}
              onUnsavedChange={setPlaceUnsaved}
              onDeleted={() => setSelectedPlaceId(null)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
              左のリストから場所を選択、または追加してください
            </div>
          )}
        </div>
        {relationsView ? (
          <div className="mx-auto max-w-5xl">
            <RelationGraph
              characters={characters}
              path={canonPath}
              allNodes={graph?.nodes ?? []}
              onCharactersChanged={() => void reload()}
              orthogonal
              showAllChars
              autoFit
              width={880}
              height={620}
              egoCharId={egoCharId}
              onEgoChange={setEgoCharId}
            />
          </div>
        ) : tab === 'places' ? null : selected ? (
          <div className="mx-auto max-w-2xl">
            {/* 画像 → 画像操作 → 名前 の順に縦に積む(色は名前の隣に項目として置く) */}
            <div className="mb-4 flex flex-col items-start gap-1.5">
              {/* プロフィール画像(装飾専用。無くても成り立つ) */}
              <button
                onClick={() => {
                  if (draft.portrait_source_path) openRecrop()
                  else fileInputRef.current?.click()
                }}
                onDragEnter={(e) => {
                  e.preventDefault()
                  portraitDragDepth.current += 1
                  setPortraitDragOver(true)
                }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={() => {
                  portraitDragDepth.current -= 1
                  if (portraitDragDepth.current <= 0) {
                    portraitDragDepth.current = 0
                    setPortraitDragOver(false)
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  portraitDragDepth.current = 0
                  setPortraitDragOver(false)
                  acceptPortraitFile(e.dataTransfer.files?.[0])
                }}
                className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-full border-2 transition-colors"
                style={{
                  borderColor: draft.color ?? '#8a8fa8',
                  background: 'var(--bg-input)',
                  ...(portraitDragOver ? { outline: '2px dashed var(--accent)', outlineOffset: 2 } : {})
                }}
                data-tip={
                  draft.portrait_source_path
                    ? 'クリックで切り抜き直し / 画像をドロップで差し替え'
                    : 'クリックで画像を設定 / 画像をドロップ'
                }
              >
                {assetUrl(draft.portrait_path) ? (
                  <img src={assetUrl(draft.portrait_path)!} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[36px]" style={{ color: 'var(--text-faint)' }}>
                    {(draft.name ?? '?').slice(0, 1)}
                  </span>
                )}
                <span
                  className="absolute inset-0 hidden items-center justify-center bg-black/50 text-[11px] text-white group-hover:flex"
                >
                  {draft.portrait_source_path ? '調整' : '設定'}
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  // 直接アップロードせず、切り抜きモーダルを挟む(元画像も保存される)
                  acceptPortraitFile(file)
                }}
              />
              {/* 画像のすぐ下に画像操作(画像があるときだけ) */}
              {draft.portrait_path && (
                <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  <button onClick={() => fileInputRef.current?.click()} data-tip="別の画像に差し替える">
                    画像を差し替え
                  </button>
                  <span>・</span>
                  <button
                    onClick={() => {
                      if (!selectedId) return
                      const patch = { portrait_path: null, portrait_source_path: null, portrait_crop: null }
                      void api.updateCharacter(selectedId, patch).then(async () => {
                        setDraft((d) => ({ ...d, ...patch }))
                        await reload()
                      })
                    }}
                    data-tip="画像を外す"
                  >
                    画像を外す
                  </button>
                </div>
              )}
              {/* 名前と色。色はキャラの識別に使うので名前の隣に項目として並べる */}
              <div className="mt-1.5 flex w-full items-end gap-2">
                <label className="min-w-0 flex-1 block">
                  <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    名前
                  </span>
                  {/* 色のスウォッチと高さを揃えるため、padding ではなく高さで指定する */}
                  <input
                    value={draft.name ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    className="block h-11 w-full rounded-lg border px-3 text-[18px] font-semibold outline-none"
                    style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                  />
                </label>
                <label className="block shrink-0">
                  <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    色
                  </span>
                  <input
                    type="color"
                    value={draft.color ?? '#7c5af7'}
                    onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                    className="color-swatch block h-11 w-12 cursor-pointer"
                    data-tip="ノード・関係図・チャットで使われるキャラの色"
                  />
                </label>
              </div>
            </div>
            <label className="mb-4 block">
              <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                読み(ひらがな)
              </span>
              <input
                value={draft.reading ?? ''}
                placeholder="やまざき まこと"
                onChange={(e) => setDraft((d) => ({ ...d, reading: e.target.value }))}
                className="block w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                data-tip={[
                  '読み上げで、このキャラの名前をこの読みで読ませます(台本や本文の表示は漢字のまま)。',
                  '名前と読みを同じように空白で区切ると、姓だけ・名だけも正しく読みます(2 文字以上の部分だけ)。'
                ].join('\n')}
              />
            </label>
            {/* 参照画像(全身の立ち絵)。外見の記述から生成するか、手持ちの画像を置く。
                場面画像を作るときに編集モデルの入力として渡す(docs/design/image-gen.md) */}
            <RefImagePanel
              character={selected}
              appearance={draft.appearance ?? ''}
              onChanged={async (patch) => {
                setDraft((d) => ({ ...d, ...patch }))
                await reload()
              }}
              onCropPortrait={(path) => {
                const url = assetUrl(path)
                if (!url) return
                setCropTarget({ source: url, isNewFile: false, initial: null, sourcePath: path })
              }}
            />
            {FIELD_DEFS.map((f) => (
              <label key={f.key} className="mb-4 block">
                <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  {f.label}
                </span>
                {/* 高さの自動調整と校正ボタン(本文の下に常に出る)は共通コンポーネントに任せる */}
                <ProofreadTextarea
                  key={`${selected.id}:${f.key}:${draftReset}`}
                  rows={f.rows}
                  value={(draft[f.key] as string | null) ?? ''}
                  onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                />
              </label>
            ))}
            {/* 読み上げの声(docs/design/voice.md §5)。選んだその場で保存する */}
            <CharacterVoicePanel character={selected} onChanged={reload} />
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
                style={{ background: saving ? 'var(--accent-hover)' : 'var(--accent)' }}
                data-tip={dirty ? undefined : '変更はありません'}
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button onClick={resetDraft} disabled={!dirty || saving || cropTarget !== null}
                className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip={saving || cropTarget !== null ? '保存・画像の調整が終わるまでお待ちください' : dirty ? 'このキャラクターの未保存の変更を取り消します' : '変更はありません'}>
                元に戻す
              </button>
              {dirty && <UnsavedBadge />}
              <button
                onClick={() => void handleDelete()}
                className="delete-action ml-auto rounded-lg px-3 py-1.5 text-[13px]"
              >
                削除
              </button>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
            左のリストからキャラクターを選択、または追加してください
          </div>
        )}
      </main>
    </div>
  )
}
