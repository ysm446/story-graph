import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, assetUrl } from '../api'
import CharacterEditor from './CharacterEditor'
import PlaceEditor from './PlaceEditor'
import RelationGraph from '../RelationGraph'
import type { Character, Place, StoryGraph, StoryNode } from '../types'
import { useWorkspace } from '../Workspace'
import UnsavedBadge from '../UnsavedBadge'
import CharAvatar from '../CharAvatar'
import SettingDocumentEditor, { type SettingDocumentEdits } from './SettingDocumentEditor'
import type { SettingDocument } from '../types'

/** 資料の種類。「関係図」はキャラクターの表示方法として扱う。 */
type Tab = 'characters' | 'places' | 'settings'

/** 資料庫。キャラクターと場所を同じシェル(リサイズ可能なサイドバー + 編集ペイン)で扱う。
 *  場所も登録制のエンティティなので、庫としては同じ性格のもの(docs/design/places.md)。 */
// memo: 非表示(display: none)でもマウントされたままなので、App の再レンダーに巻き込まない
export default memo(CharactersMode)

function CharactersMode(): React.JSX.Element {
  const workspace = useWorkspace()
  const [placeDirty, setPlaceDirty] = useState(false)
  const [placeUnsaved, setPlaceUnsaved] = useState(false)
  const [documents, setDocuments] = useState<SettingDocument[]>([])
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [documentEdits, setDocumentEdits] = useState<SettingDocumentEdits>({ ids: [], busy: false })
  const [documentQuery, setDocumentQuery] = useState('')
  // 絞り込みは資料と検索語が変わったときだけ(本文全体を小文字化するので、毎レンダーは重い)
  const filteredDocuments = useMemo(() => {
    const query = documentQuery.toLocaleLowerCase()
    if (!query) return documents
    return documents.filter((document) => `${document.title}\n${document.category}\n${document.body}`.toLocaleLowerCase().includes(query))
  }, [documents, documentQuery])
  const [createError, setCreateError] = useState('')
  // 新規作成した直後の場所・設定資料。全項目を編集状態で開かせ、開いたら消す
  const [newPlaceId, setNewPlaceId] = useState<string | null>(null)
  const [newDocumentId, setNewDocumentId] = useState<string | null>(null)
  const clearNewPlace = useCallback(() => setNewPlaceId(null), [])
  const clearNewDocument = useCallback(() => setNewDocumentId(null), [])
  const [creating, setCreating] = useState(false)
  const [libraryVersion, setLibraryVersion] = useState(0)
  const reloadSequence = useRef(0)
  const [tab, setTab] = useState<Tab>('characters')
  const [expanded, setExpanded] = useState({ characters: true, places: true, settings: true })
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
  // キャラクター編集(CharacterEditor)の未保存・保存中・切り抜き中(未保存ガードに使う)
  const [charDirty, setCharDirty] = useState(false)
  // 新規作成の直後だけ、全項目を編集状態で開く(空の項目の鉛筆を1つずつ押させない)
  // 作ったばかりの人物(全部の項目を編集状態で開く)
  const [newCharId, setNewCharId] = useState<string | null>(null)
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

  const selected = characters.find((c) => c.id === selectedId) ?? null
  const selectedPlace = places.find((p) => p.id === selectedPlaceId) ?? null

  const reload = async (refreshDraft = false): Promise<void> => {
    const sequence = ++reloadSequence.current
    const [chars, placeList, g, documentList] = await Promise.all([
      api.listCharacters(),
      api.listPlaces(),
      api.getGraph(),
      api.listSettingDocuments()
    ])
    if (sequence !== reloadSequence.current) return
    setCharacters(chars)
    setPlaces(placeList)
    setDocuments(documentList)
    setGraph(g)
    // 未保存が無ければ編集欄を作り直して最新の値にする(PlaceEditor と同じ作法)
    if (refreshDraft && selectedId === selectedIdRef.current && !workspace.libraryDirty.current) {
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

  // 関係図はキャラクターの見せ方なので、場所を見ている間は出さない
  const relationsView = tab === 'characters' && showRelations

  const followedTarget = useRef(workspace.productionTarget)
  useEffect(() => {
    const target = workspace.productionTarget
    if (!target || target.kind === 'scene' || target.kind === 'chapter' || followedTarget.current === target || workspace.libraryDirty.current) return
    if (target.kind === 'character') {
      const character = characters.find((item) => item.id === target.id)
      if (!character) return
      setTab('characters')
      setExpanded((value) => ({ ...value, characters: true }))
      setShowRelations(false)
      setSelectedId(target.id)
    } else if (target.kind === 'setting_document') {
      if (!documents.some((item) => item.id === target.id)) return
      setTab('settings')
      setExpanded((value) => ({ ...value, settings: true }))
      setDocumentQuery('')
      setSelectedDocumentId(target.id)
    } else {
      if (!places.some((item) => item.id === target.id)) return
      setTab('places')
      setExpanded((value) => ({ ...value, places: true }))
      setSelectedPlaceId(target.id)
    }
    followedTarget.current = target
  }, [workspace.productionTarget, characters, places, documents, workspace.libraryDirty])

  const handleCreate = async (kind: Tab): Promise<void> => {
    if (kind === 'settings') {
      if (creating) return
      setCreating(true); setCreateError('')
      try {
        const created = await api.createSettingDocument('新しい設定資料')
        await reload()
        setNewDocumentId(created.id)
        setSelectedDocumentId(created.id)
        setTab('settings')
        setDocumentQuery('')
        setExpanded((value) => ({ ...value, settings: true }))
      } catch (error) { setCreateError(`設定資料を追加できませんでした: ${String(error)}`) }
      finally { setCreating(false) }
      return
    }
    // 設定資料と同じく、連打の二重作成を防ぎ、失敗は一覧の上に出す
    if (creating) return
    setCreating(true); setCreateError('')
    try {
      if (kind === 'places') {
        const created = await api.createPlace({ name: '新しい場所', color: '#5a8fa7' })
        await reload()
        setTab('places')
        setExpanded((value) => ({ ...value, places: true }))
        setNewPlaceId(created.id)
        setSelectedPlaceId(created.id)
        return
      }
      const created = await api.createCharacter({ name: '新しいキャラクター', color: '#7c5af7' })
      await reload()
      setTab('characters')
      setShowRelations(false)
      setExpanded((value) => ({ ...value, characters: true }))
      setNewCharId(created.id)
      setSelectedId(created.id)
    } catch (error) {
      setCreateError(`${kind === 'places' ? '場所' : 'キャラクター'}を追加できませんでした: ${String(error)}`)
    } finally {
      setCreating(false)
    }
  }

  const dirty = charDirty

  useEffect(() => {
    workspace.libraryDirty.current = dirty || placeDirty || documentEdits.ids.length > 0 || documentEdits.busy || creating
    return () => { workspace.libraryDirty.current = false }
  }, [dirty, placeDirty, documentEdits, creating, workspace.libraryDirty])

  useEffect(() => {
    if (workspace.mode === 'characters') void reload(!(dirty || placeDirty))
  }, [workspace.revision, workspace.mode])

  return (
    <div ref={rowRef} className="flex h-full">
      <aside
        className="flex shrink-0 flex-col"
        style={{ background: 'var(--bg-sidebar)', width: sidebarWidth }}
      >
        <div className="px-3 py-2 text-[13px] font-medium" style={{ color: 'var(--text)' }}>資料庫</div>
        {createError && <p role="alert" className="px-3 text-[11px]" style={{ color: 'var(--danger)' }}>{createError}</p>}
        <nav aria-label="資料の種類と一覧" data-view-ok className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {([['characters', 'キャラクター'], ['places', '場所'], ['settings', '設定資料']] as const).map(([kind, label]) => (
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
                <button data-write-action onClick={() => void handleCreate(kind)} aria-label={`${label}を追加`}
                  disabled={creating}
                  className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip={`${label}を追加`}>+</button>
              </div>
              <div id={`library-${kind}`} hidden={!expanded[kind]} className="ml-3 border-l pl-1" style={{ borderColor: 'var(--border)' }}>
                {kind === 'settings' && <input aria-label="設定資料を絞り込む" placeholder="設定資料を絞り込む" value={documentQuery} onChange={(e) => setDocumentQuery(e.target.value)}
                  className="my-1 w-full min-w-0 rounded-md border px-2 py-0.5 text-[12px] outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }} data-tip="タイトル・分類・本文から設定資料を絞り込みます" />}
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
                )) : kind === 'places' ? places.map((place) => (
                  <button key={place.id} onClick={() => { setTab('places'); setSelectedPlaceId(place.id) }}
                    className="mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]"
                    style={{ background: tab === 'places' && place.id === selectedPlaceId ? 'var(--accent-soft)' : undefined, color: tab === 'places' && place.id === selectedPlaceId ? 'var(--text)' : 'var(--text-dim)' }}
                    data-tip={place.name}>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                      {assetUrl(place.image_path) ? (
                        <img src={assetUrl(place.image_path)!} alt="" loading="lazy" decoding="async"
                          className="h-6 w-6 rounded-md border object-cover" style={{ borderColor: 'var(--border-strong)' }} />
                      ) : (
                        <span className="h-6 w-1.5 rounded-full" style={{ background: place.color ?? 'var(--text-dim)' }} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{place.name}</span>
                    {place.id === selectedPlaceId && placeUnsaved && <UnsavedBadge />}
                  </button>
                )) : filteredDocuments.map((document) => (
                  <button key={document.id} onClick={() => { setTab('settings'); setSelectedDocumentId(document.id) }}
                    className="mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]"
                    style={{ background: tab === 'settings' && document.id === selectedDocumentId ? 'var(--accent-soft)' : undefined, color: 'var(--text)' }} data-tip={document.title}>
                    <span className="min-w-0 flex-1 truncate">{document.title}</span>
                    {documentEdits.ids.includes(document.id) && <UnsavedBadge />}
                  </button>
                ))}
                {(kind === 'characters' ? characters : kind === 'places' ? places : documents).length === 0 && <p className="px-2 py-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>まだ{label}がありません</p>}
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
        <div hidden={tab !== 'settings'}>
          <SettingDocumentEditor documents={documents} selectedId={selectedDocumentId} onChanged={reload}
            onDirty={setDocumentEdits} onDeleted={() => setSelectedDocumentId(null)}
            newId={newDocumentId} onOpenedNew={clearNewDocument} />
        </div>
        <div hidden={tab !== 'places'}>
          {selectedPlace ? (
            <PlaceEditor
              key={`${selectedPlace.id}:${libraryVersion}`}
              place={selectedPlace}
              onChanged={reload}
              onDirty={setPlaceDirty}
              onUnsavedChange={setPlaceUnsaved}
              onDeleted={() => setSelectedPlaceId(null)}
              startEditing={newPlaceId === selectedPlace.id}
              onStartedEditing={clearNewPlace}
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
        ) : tab !== 'characters' ? null : selected ? (
          <CharacterEditor
            key={`${selected.id}:${libraryVersion}`}
            character={selected}
            onChanged={() => reload()}
            onDirty={setCharDirty}
            onDeleted={() => setSelectedId(null)}
            startEditing={newCharId === selected.id}
            onStartedEditing={() => setNewCharId(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
            左のリストからキャラクターを選択、または追加してください
          </div>
        )}
      </main>
    </div>
  )
}
