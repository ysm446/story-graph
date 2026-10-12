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
import { Icon } from '../icons'
import SettingDocumentEditor, { type SettingDocumentEdits } from './SettingDocumentEditor'
import type { SettingDocument } from '../types'

const EDITABLE_FIELDS = ['name', 'color', 'profile', 'appearance', 'voice', 'reading'] as const

const FIELD_DEFS: Array<{ key: 'profile' | 'appearance' | 'voice'; label: string; short: string; rows: number }> = [
  { key: 'profile', label: 'プロフィール(性格の基調・背景)', short: 'プロフィール', rows: 5 },
  { key: 'appearance', label: '外見', short: '外見', rows: 3 },
  { key: 'voice', label: '口調・一人称', short: '口調・一人称', rows: 3 }
]

/** 編集の単位。読む表示が既定で、鉛筆(または本文)を押した単位だけを編集欄にし、単位ごとに確定して保存する。
 *  名前・読み・色は「誰か」を決めるひとまとまりなので一緒に編集する。 */
type EditGroup = 'identity' | 'profile' | 'appearance' | 'voice'
const GROUP_FIELDS: Record<EditGroup, ReadonlyArray<(typeof EDITABLE_FIELDS)[number]>> = {
  identity: ['name', 'reading', 'color'],
  profile: ['profile'],
  appearance: ['appearance'],
  voice: ['voice']
}
const ALL_GROUPS: EditGroup[] = ['identity', 'profile', 'appearance', 'voice']

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
  const [draft, setDraft] = useState<Partial<Character>>({})
  const [draftReset, setDraftReset] = useState(0)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<ReadonlySet<EditGroup>>(new Set())
  const [saveError, setSaveError] = useState<{ group: EditGroup; message: string } | null>(null)
  // 新規作成の直後だけ、全項目を編集状態で開く(空の項目の鉛筆を1つずつ押させない)
  const editAllFor = useRef<string | null>(null)
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
    setEditing(new Set(selected && editAllFor.current === selected.id ? ALL_GROUPS : []))
    setSaveError(null)
    if (selected) editAllFor.current = null
  }, [selectedId, selected?.id])


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
      setDraft(character)
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
        setSelectedDocumentId(created.id)
        setTab('settings')
        setDocumentQuery('')
        setExpanded((value) => ({ ...value, settings: true }))
      } catch (error) { setCreateError(`設定資料を追加できませんでした: ${String(error)}`) }
      finally { setCreating(false) }
      return
    }
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
    editAllFor.current = created.id
    setSelectedId(created.id)
  }

  const groupDirty = (group: EditGroup): boolean =>
    selected !== null && GROUP_FIELDS[group].some((key) => (draft[key] ?? '') !== (selected[key] ?? ''))

  const closeEdit = (group: EditGroup): void => {
    setEditing((current) => {
      const next = new Set(current)
      next.delete(group)
      return next
    })
    setSaveError((current) => (current?.group === group ? null : current))
  }

  const startEdit = (group: EditGroup): void => {
    if (!selected || saving || editing.has(group)) return
    // 下書きは選択時点のコピー。その後に制作チャットなどが保存した値を取りこぼさないよう、開く単位だけ読み直す
    const saved = Object.fromEntries(GROUP_FIELDS[group].map((key) => [key, selected[key]]))
    setDraft((current) => ({ ...current, ...saved }))
    setEditing((current) => new Set(current).add(group))
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-edit-group="${group}"] textarea, [data-edit-group="${group}"] input:not([type="color"])`)?.focus()
    })
  }

  const cancelEdit = (group: EditGroup): void => {
    if (!selected || saving) return
    const saved = Object.fromEntries(GROUP_FIELDS[group].map((key) => [key, selected[key]]))
    setDraft((current) => ({ ...current, ...saved }))
    setDraftReset((value) => value + 1)
    closeEdit(group)
  }

  const commitEdit = async (group: EditGroup): Promise<void> => {
    if (!selectedId || !selected || saving) return
    if (group === 'identity' && !(draft.name ?? '').trim()) return
    // 変えた項目だけ送る。draft を丸ごと PATCH すると、選択後にその場で保存された項目(参照画像・
    // 関係図の座標など)を古い値で巻き戻す。未設定(null)の項目を '' に変えて送ると色の既定値
    // (char.color ?? …)が効かなくなるので、空にしたときは name 以外 null にする
    const patch = Object.fromEntries(
      GROUP_FIELDS[group].filter((k) => (draft[k] ?? '') !== (selected[k] ?? ''))
        .map((k) => [k, k === 'name' ? (draft[k] ?? '') : (draft[k] || null)])
    )
    setSaving(true)
    try {
      if (Object.keys(patch).length > 0) {
        await api.updateCharacter(selectedId, patch)
        await reload()
      }
      closeEdit(group)
    } catch (e) {
      setSaveError({ group, message: `保存できませんでした: ${String(e)}` })
    } finally {
      setSaving(false)
    }
  }

  /** 編集欄の中のキー操作。Ctrl+Enter で確定、Esc で取り消し(変換中の Esc は IME に任せる) */
  const editKeys = (group: EditGroup) => (event: React.KeyboardEvent): void => {
    if (!editing.has(group) || event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      cancelEdit(group)
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void commitEdit(group)
    }
  }

  const editButton = (group: EditGroup, label: string): React.JSX.Element => (
    <button
      onClick={() => startEdit(group)}
      aria-label={`${label}を編集`}
      data-tip={`${label}を編集`}
      className="shrink-0 rounded-md p-1 hover:bg-[var(--accent-soft)]"
      style={{ color: 'var(--text-faint)' }}
    >
      <Icon name="pen" size={13} />
    </button>
  )

  const editActions = (group: EditGroup): React.JSX.Element => (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button
        onClick={() => void commitEdit(group)}
        disabled={saving || (group === 'identity' && !(draft.name ?? '').trim())}
        className="accent-action rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
        data-tip={group === 'identity' && !(draft.name ?? '').trim() ? '名前を入力してください' : 'この項目を保存します(Ctrl+Enter)'}
      >
        {saving ? '保存中…' : '確定'}
      </button>
      <button
        onClick={() => cancelEdit(group)}
        disabled={saving}
        className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        data-tip="この項目の変更を取り消して閉じます(Esc)"
      >
        取り消し
      </button>
      {groupDirty(group) && <UnsavedBadge />}
      {saveError?.group === group && (
        <p role="alert" className="w-full text-[12px]" style={{ color: 'var(--danger)' }}>{saveError.message}</p>
      )}
    </div>
  )

  // 下書きが保存値と異なるか(シーンエディタと同じ判定方式)。画像は
  // 切り抜き確定時にその場で保存されるので、ここでは判定に含めない
  const dirty =
    selected !== null &&
    EDITABLE_FIELDS.some(
      (key) => (draft[key] ?? '') !== (selected[key] ?? '')
    )

  useEffect(() => {
    workspace.libraryDirty.current = dirty || placeDirty || saving || cropTarget !== null || documentEdits.ids.length > 0 || documentEdits.busy || creating
    return () => { workspace.libraryDirty.current = false }
  }, [dirty, placeDirty, saving, cropTarget, documentEdits, creating, workspace.libraryDirty])

  useEffect(() => {
    if (workspace.mode === 'characters') void reload(!(dirty || placeDirty || saving))
  }, [workspace.revision, workspace.mode])

  // アイコンの頭文字と縁の色。名前・色を編集している間は下書きを映し、それ以外は保存値
  const shownName = editing.has('identity') ? draft.name : selected?.name
  const shownColor = editing.has('identity') ? draft.color : selected?.color

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
        {createError && <p role="alert" className="px-3 text-[11px]" style={{ color: 'var(--danger)' }}>{createError}</p>}
        <nav aria-label="資料の種類と一覧" className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
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
                <button onClick={() => void handleCreate(kind)} aria-label={`${label}を追加`}
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
            onDirty={setDocumentEdits} onDeleted={() => setSelectedDocumentId(null)} />
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
          <div className="character-editor mx-auto max-w-4xl">
            {/* 読む表示が既定(SNS のプロフィールのように)。鉛筆か本文を押した項目だけ編集欄になり、項目ごとに確定して保存する。
                上段(固定): 左にアイコン・名前・読み、右に参照画像。下段: 文章の項目と声(スクロール)。配置は index.css の character-editor */}
            <div className="character-editor-scroll inspector-scrollbar">
            <div className="character-editor-head">
            <div className="character-editor-id">
            <div className="mb-4 flex items-start gap-4">
              <div className="flex shrink-0 flex-col items-center gap-1.5">
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
                className="group relative h-36 w-36 shrink-0 overflow-hidden rounded-full border-2 transition-colors"
                style={{
                  borderColor: shownColor ?? '#8a8fa8',
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
                  <span className="flex h-full w-full items-center justify-center text-[46px]" style={{ color: 'var(--text-faint)' }}>
                    {(shownName || '?').slice(0, 1)}
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
              </div>
              <div className="min-w-0 flex-1 pt-1" data-edit-group="identity" onKeyDown={editKeys('identity')}>
                {editing.has('identity') ? (
                  <>
                    {/* 名前と色。色はキャラの識別に使うので名前の隣に項目として並べる */}
                    <div className="flex w-full items-end gap-2">
                      <label className="min-w-0 flex-1 block">
                        <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                          名前
                        </span>
                        {/* 色のスウォッチと高さを揃えるため、padding ではなく高さで指定する */}
                        <input
                          value={draft.name ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.ctrlKey && !e.metaKey) void commitEdit('identity')
                          }}
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
                    <label className="mt-3 block">
                      <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                        読み(ひらがな)
                      </span>
                      <input
                        value={draft.reading ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, reading: e.target.value }))}
                        className="block w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
                        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                        data-tip={[
                          '読み上げで、このキャラの名前をこの読みで読ませます(台本や本文の表示は漢字のまま)。',
                          '名前と読みを同じように空白で区切ると、姓だけ・名だけも正しく読みます(2 文字以上の部分だけ)。'
                        ].join('\n')}
                      />
                    </label>
                    {editActions('identity')}
                  </>
                ) : (
                  <>
                    <div className="flex items-start gap-1.5">
                      <h2 data-character-name className="min-w-0 text-[22px] font-semibold leading-tight [overflow-wrap:anywhere]" style={{ color: 'var(--text)' }}>
                        {selected.name || '(名前なし)'}
                      </h2>
                      {editButton('identity', '名前・読み・色')}
                    </div>
                    <p className="mt-1 text-[12px]" style={{ color: selected.reading ? 'var(--text-dim)' : 'var(--text-faint)' }}>
                      {selected.reading || '読みは未設定'}
                    </p>
                  </>
                )}
              </div>
            </div>
            </div>
            <div className="character-editor-ref">
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
            </div>
            </div>
            <div className="character-editor-body inspector-scrollbar">
            {FIELD_DEFS.map((f) => {
              const saved = selected[f.key] ?? ''
              return (
                <section key={f.key} className="mb-5" data-edit-group={f.key} onKeyDown={editKeys(f.key)}>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      {f.label}
                    </span>
                    {!editing.has(f.key) && editButton(f.key, f.short)}
                  </div>
                  {editing.has(f.key) ? (
                    <>
                      {/* 高さの自動調整と校正ボタン(本文の下に常に出る)は共通コンポーネントに任せる */}
                      <ProofreadTextarea
                        key={`${selected.id}:${f.key}:${draftReset}`}
                        rows={f.rows}
                        value={(draft[f.key] as string | null) ?? ''}
                        onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
                        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                      />
                      {editActions(f.key)}
                    </>
                  ) : saved ? (
                    // 本文を押しても編集に入れる(鉛筆は小さいので)。文字を選択してコピーするときは開かない
                    <p
                      onClick={() => {
                        if (!window.getSelection()?.toString()) startEdit(f.key)
                      }}
                      className="cursor-text whitespace-pre-wrap text-[13px] leading-relaxed"
                      style={{ color: 'var(--text)' }}
                    >
                      {saved}
                    </p>
                  ) : (
                    <button onClick={() => startEdit(f.key)} className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                      + {f.short}を書く
                    </button>
                  )}
                </section>
              )
            })}
            {/* 読み上げの声(docs/design/voice.md §5)。選んだその場で保存する */}
            <CharacterVoicePanel character={selected} onChanged={reload} />
            <div className="mt-6 flex border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => void handleDelete()} className="delete-action ml-auto text-[12px]">
                このキャラクターを削除
              </button>
            </div>
            </div>
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
