import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { EditActions, EditPencil, ReadText, editKeys, focusEditGroup } from '../FieldEdit'
import type { SettingDocument } from '../types'

const fields = ['title', 'category', 'body', 'status', 'scope', 'ai_mode'] as const
type Field = (typeof fields)[number]
// 入力欄・ラベルの大きさはキャラクター・場所の編集と揃える
const inputClass = 'block w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none'
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }
const labelClass = 'mb-1 block text-[12px]'
const labelStyle = { color: 'var(--text-dim)' }
const STATUS_LABELS: Record<SettingDocument['status'], string> = { draft: '構想', confirmed: '確定設定', reference: '参考資料' }
const AI_MODE_LABELS: Record<SettingDocument['ai_mode'], string> = { search: '必要に応じて検索', always: '常に参照', never: '参照しない' }
export interface SettingDocumentEdits { ids: string[]; busy: boolean }

/** 編集の単位。タイトル・分類・扱い・AI参照方法・適用範囲は「どんな資料か」を決めるひとまとまり */
type EditGroup = 'meta' | 'body'
const GROUP_FIELDS: Record<EditGroup, readonly Field[]> = {
  meta: ['title', 'category', 'status', 'ai_mode', 'scope'],
  body: ['body']
}
const ALL_GROUPS: EditGroup[] = ['meta', 'body']
const groupName = (group: EditGroup): string => `doc-${group}`

/** 編集中の下書き。変えた項目だけを持ち、revision は読み始めた版(保存時に照合して、
 *  編集中に制作チャットなどが同じ資料を更新していたら 409 で気づけるようにする) */
type Overlay = { revision: number; open: EditGroup[]; values: Partial<Record<Field, string>> }

const isChanged = (item: SettingDocument, edited: Overlay | undefined, keys: readonly Field[]): boolean =>
  !!edited && keys.some((key) => key in edited.values && edited.values[key] !== item[key])

/** 設定資料のページ。読む表示が既定で、鉛筆か本文を押した単位だけを編集欄にし、単位ごとに確定して保存する。
 *  種類・資料を切り替えても、開いた編集欄と下書きは保持する。 */
export default function SettingDocumentEditor({ documents, selectedId, onChanged, onDirty, onDeleted, newId, onOpenedNew }: {
  documents: SettingDocument[]
  selectedId: string | null
  onChanged: () => Promise<void>
  onDirty: (value: SettingDocumentEdits) => void
  onDeleted: () => void
  /** 新規作成した直後の資料。全項目を編集状態で開く */
  newId?: string | null
  onOpenedNew?: () => void
}): React.JSX.Element {
  const [overlays, setOverlays] = useState<Record<string, Overlay>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ group: EditGroup | null; message: string } | null>(null)
  const document = documents.find((item) => item.id === selectedId)
  const overlay = document ? overlays[document.id] : undefined
  const draft = document ? ({ ...document, ...overlay?.values } as SettingDocument) : undefined
  const dirtyIds = useMemo(
    () => documents.filter((item) => isChanged(item, overlays[item.id], fields)).map((item) => item.id),
    [documents, overlays]
  )
  useEffect(() => { onDirty({ ids: dirtyIds, busy }) }, [dirtyIds, busy, onDirty])
  useEffect(() => { setError(null) }, [selectedId])
  useEffect(() => () => onDirty({ ids: [], busy: false }), [onDirty])
  useEffect(() => {
    const created = newId ? documents.find((item) => item.id === newId) : undefined
    if (!created) return
    setOverlays((current) => ({ ...current, [created.id]: { revision: created.revision, open: ALL_GROUPS, values: {} } }))
    onOpenedNew?.()
    focusEditGroup(groupName('meta'))
  }, [newId, documents])

  const discard = (id: string): void => {
    setOverlays((current) => { const next = { ...current }; delete next[id]; return next })
    setError(null)
  }
  /** 編集の単位を閉じる。その単位の下書きを捨て、開いた単位が無くなれば下書きごと消す */
  const closeGroup = (id: string, group: EditGroup, revision?: number): void => {
    setOverlays((current) => {
      const edited = current[id]
      if (!edited) return current
      const open = edited.open.filter((item) => item !== group)
      const next = { ...current }
      if (open.length === 0) { delete next[id]; return next }
      const values = { ...edited.values }
      for (const key of GROUP_FIELDS[group]) delete values[key]
      next[id] = { revision: revision ?? edited.revision, open, values }
      return next
    })
    setError((current) => (current?.group === group ? null : current))
  }
  if (!document || !draft) return <p className="py-16 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>左の一覧から設定資料を選択、または追加してください</p>

  const isOpen = (group: EditGroup): boolean => !!overlay?.open.includes(group)
  const groupDirty = (group: EditGroup): boolean => isChanged(document, overlay, GROUP_FIELDS[group])
  const startEdit = (group: EditGroup): void => {
    if (busy || isOpen(group)) return
    setOverlays((current) => {
      const edited = current[document.id] ?? { revision: document.revision, open: [], values: {} }
      return { ...current, [document.id]: { ...edited, open: [...edited.open, group] } }
    })
    focusEditGroup(groupName(group))
  }
  const change = (key: Field, value: string): void => {
    setOverlays((current) => {
      const edited = current[document.id]
      if (!edited) return current
      return { ...current, [document.id]: { ...edited, values: { ...edited.values, [key]: value } } }
    })
  }
  const cancel = (group: EditGroup): void => {
    if (!busy) closeGroup(document.id, group)
  }
  const commit = async (group: EditGroup): Promise<void> => {
    if (busy || !overlay || !isOpen(group)) return
    if (group === 'meta' && !draft.title.trim()) return
    if (!groupDirty(group)) { closeGroup(document.id, group); return }
    setBusy(true); setError(null)
    try {
      // この単位の項目だけを保存する(もう一方の単位の下書きは残す)。版は読み始めた版を照合する
      const changed = Object.fromEntries(GROUP_FIELDS[group].filter((key) => key in overlay.values).map((key) => [key, overlay.values[key]]))
      const saved = await api.updateSettingDocument({ ...document, ...changed, revision: overlay.revision } as SettingDocument)
      // 一覧を読み直してから下書きを捨てる(先に捨てると、読み直すまで保存前の内容が一瞬見える)
      await onChanged()
      closeGroup(document.id, group, saved.revision)
    } catch (e) { setError({ group, message: `保存できませんでした: ${String(e)}` }) }
    finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (busy || !window.confirm(`「${document.title}」を削除しますか？未保存の変更も削除されます。`)) return
    setBusy(true); setError(null)
    try {
      await api.deleteSettingDocument(document.id, document.revision)
      discard(document.id)
      onDeleted()
      await onChanged()
    } catch (e) { setError({ group: null, message: `削除できませんでした: ${String(e)}` }) }
    finally { setBusy(false) }
  }
  const actions = (group: EditGroup): React.JSX.Element => (
    <EditActions
      dirty={groupDirty(group)}
      saving={busy}
      blocked={group === 'meta' && !draft.title.trim() ? 'タイトルを入力してください' : undefined}
      error={error?.group === group ? error.message : undefined}
      onCommit={() => void commit(group)}
      onCancel={() => cancel(group)}
    />
  )
  const keys = (group: EditGroup): ((event: React.KeyboardEvent) => void) =>
    editKeys(isOpen(group), () => void commit(group), () => cancel(group))
  const faint = { color: 'var(--text-faint)' }

  return <div className="mx-auto max-w-2xl" aria-label="設定資料の編集">
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
      <div data-edit-group={groupName('meta')} onKeyDown={keys('meta')}>
        {isOpen('meta') ? <div className="flex flex-col gap-4">
          <label className="block"><span className={labelClass} style={labelStyle}>タイトル</span>
            <input aria-label="設定資料のタイトル" value={draft.title} maxLength={200} onChange={(e) => change('title', e.target.value)}
              className="block h-11 w-full rounded-lg border px-3 text-[18px] font-semibold outline-none" style={inputStyle} />
          </label>
          <label className="block"><span className={labelClass} style={labelStyle}>分類（任意）</span>
            <input aria-label="設定資料の分類" value={draft.category} maxLength={200} list="setting-document-categories" onChange={(e) => change('category', e.target.value)} className={inputClass} style={inputStyle} />
            <datalist id="setting-document-categories">{['社会情勢', '文化・風習', '制度', '歴史', '技術・魔法', '組織'].map((value) => <option key={value} value={value} />)}</datalist>
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="min-w-0 flex-1"><span className={labelClass} style={labelStyle}>資料の扱い</span>
              <select aria-label="資料の扱い" value={draft.status} onChange={(e) => change('status', e.target.value)} className={inputClass} style={inputStyle}>
                {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="min-w-0 flex-1"><span className={labelClass} style={labelStyle}>AIへの参照方法</span>
              <select aria-label="AIへの参照方法" value={draft.ai_mode} onChange={(e) => change('ai_mode', e.target.value)} className={inputClass} style={inputStyle}>
                {Object.entries(AI_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <p className="text-[11px] leading-relaxed" style={faint}>相談・制作チャットが参照します。人物本人の会話には渡しません。「常に参照」は毎回全文を渡すため、重要な前提に絞ってください。</p>
          <label className="block"><span className={labelClass} style={labelStyle}>適用範囲・時点（任意）</span>
            <input aria-label="適用範囲・時点" value={draft.scope} maxLength={2000} onChange={(e) => change('scope', e.target.value)} className={inputClass} style={inputStyle} />
          </label>
          <p className="text-[11px]" style={faint}>地域や物語内の時点を記述できます。検索対象を時点で自動制限する項目ではありません。</p>
          {actions('meta')}
        </div> : <>
          <div className="flex items-start gap-1.5">
            <h2 data-setting-title className="min-w-0 text-[22px] font-semibold leading-tight [overflow-wrap:anywhere]" style={{ color: 'var(--text)' }}>{document.title || '(無題)'}</h2>
            <EditPencil label="タイトル・分類・扱い" onClick={() => startEdit('meta')} />
          </div>
          {/* 分類・扱い・AI参照方法は1行にまとめる。値だけだと意味が取りにくいので、AI参照は「AI: 」を付ける */}
          <p data-setting-meta className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }} data-tip="相談・制作チャットが参照します。人物本人の会話には渡しません。">
            {[document.category, STATUS_LABELS[document.status], `AI: ${AI_MODE_LABELS[document.ai_mode]}`].filter(Boolean).join(' ・ ')}
          </p>
          {document.scope && <p className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>適用範囲・時点: {document.scope}</p>}
        </>}
      </div>
      <section data-edit-group={groupName('body')} onKeyDown={keys('body')}>
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[12px]" style={labelStyle}>本文</span>
          {!isOpen('body') && <EditPencil label="本文" onClick={() => startEdit('body')} />}
        </div>
        {isOpen('body') ? <>
          <textarea aria-label="設定資料の本文" value={draft.body} rows={16} maxLength={100000} onChange={(e) => change('body', e.target.value)}
            className="block w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none" style={inputStyle} />
          <p className="mt-1 text-[11px]" style={faint}>Markdown で書けます。確定すると整形して表示します。</p>
          {actions('body')}
        </> : <ReadText value={document.body} emptyLabel="本文" onEdit={() => startEdit('body')} markdown />}
      </section>
      <p className="text-[11px]" style={faint}>作成: {new Date(document.created_at).toLocaleString('ja-JP')} ／ 更新: {new Date(document.updated_at).toLocaleString('ja-JP')}</p>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        {error?.group === null && <p role="alert" className="w-full text-[12px]" style={{ color: 'var(--danger-text)' }}>{error.message}</p>}
        <button onClick={() => void remove()} className="delete-action ml-auto text-[12px]" data-tip="この設定資料を削除します">この設定資料を削除</button>
      </div>
    </fieldset>
  </div>
}
