import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Markdown } from '../Markdown'
import UnsavedBadge from '../UnsavedBadge'
import type { SettingDocument } from '../types'

const fields = ['title', 'category', 'body', 'status', 'scope', 'ai_mode'] as const
const inputClass = 'w-full rounded-md border px-2 py-0.5 text-[12px] outline-none'
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }
const buttonClass = 'rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50'
const buttonStyle = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }
export interface SettingDocumentEdits { ids: string[]; busy: boolean }

/** 種類・資料の切替でも下書きを保持する。保存時は読み始めた版を照合する。 */
export default function SettingDocumentEditor({ documents, selectedId, onChanged, onDirty, onDeleted }: {
  documents: SettingDocument[]
  selectedId: string | null
  onChanged: () => Promise<void>
  onDirty: (value: SettingDocumentEdits) => void
  onDeleted: () => void
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, SettingDocument>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(false)
  const document = documents.find((item) => item.id === selectedId)
  const draft = document ? drafts[document.id] ?? document : undefined
  const dirtyIds = useMemo(() => documents.filter((item) => {
    const edited = drafts[item.id]
    return edited && fields.some((key) => edited[key] !== item[key])
  }).map((item) => item.id), [documents, drafts])
  const dirty = !!document && dirtyIds.includes(document.id)
  useEffect(() => { onDirty({ ids: dirtyIds, busy }) }, [dirtyIds, busy, onDirty])
  useEffect(() => { setError(''); setPreview(false) }, [selectedId])
  useEffect(() => () => onDirty({ ids: [], busy: false }), [onDirty])
  const discard = (id: string): void => {
    setDrafts((current) => { const next = { ...current }; delete next[id]; return next })
    setError('')
  }
  const save = async (): Promise<void> => {
    if (!draft || busy || !dirty) return
    setBusy(true); setError('')
    try {
      await api.updateSettingDocument(draft)
      discard(draft.id)
      await onChanged()
    } catch (e) { setError(`保存できませんでした: ${String(e)}`) }
    finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!document || busy || !window.confirm(`「${document.title}」を削除しますか？未保存の変更も削除されます。`)) return
    setBusy(true); setError('')
    try {
      await api.deleteSettingDocument(document.id, document.revision)
      discard(document.id)
      onDeleted()
      await onChanged()
    } catch (e) { setError(`削除できませんでした: ${String(e)}`) }
    finally { setBusy(false) }
  }
  if (!document || !draft) return <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>左の一覧から設定資料を選択、または追加してください。</p>
  const change = (key: typeof fields[number], value: string): void => {
    setDrafts((current) => ({ ...current, [document.id]: { ...(current[document.id] ?? document), [key]: value } }))
  }
  return <div className="mx-auto max-w-2xl" aria-label="設定資料の編集">
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
      <label className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>タイトル
        <input aria-label="設定資料のタイトル" value={draft.title} maxLength={200} onChange={(e) => change('title', e.target.value)} className={inputClass} style={inputStyle} />
      </label>
      <label className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>分類（任意）
        <input aria-label="設定資料の分類" value={draft.category} maxLength={200} list="setting-document-categories" onChange={(e) => change('category', e.target.value)} className={inputClass} style={inputStyle} />
        <datalist id="setting-document-categories">{['社会情勢', '文化・風習', '制度', '歴史', '技術・魔法', '組織'].map((value) => <option key={value} value={value} />)}</datalist>
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-0 flex-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>資料の扱い
          <select aria-label="資料の扱い" value={draft.status} onChange={(e) => change('status', e.target.value)} className={inputClass} style={inputStyle}>
            <option value="draft">構想</option><option value="confirmed">確定設定</option><option value="reference">参考資料</option>
          </select>
        </label>
        <label className="min-w-0 flex-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>AIへの参照方法
          <select aria-label="AIへの参照方法" value={draft.ai_mode} onChange={(e) => change('ai_mode', e.target.value)} className={inputClass} style={inputStyle}>
            <option value="search">必要に応じて検索</option><option value="always">常に参照</option><option value="never">参照しない</option>
          </select>
        </label>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>相談・制作チャットが参照します。人物本人の会話には渡しません。「常に参照」は毎回全文を渡すため、重要な前提に絞ってください。</p>
      <label className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>適用範囲・時点（任意）
        <input aria-label="適用範囲・時点" value={draft.scope} maxLength={2000} onChange={(e) => change('scope', e.target.value)} className={inputClass} style={inputStyle} />
      </label>
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>地域や物語内の時点を記述できます。検索対象を時点で自動制限する項目ではありません。</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>本文</span>
        <button onClick={() => setPreview((value) => !value)} className={buttonClass} style={buttonStyle} aria-pressed={preview} data-tip="本文の編集と表示を切り替えます">{preview ? '編集に戻る' : 'プレビュー'}</button>
      </div>
      {preview ? <div className="rounded-lg border p-3 text-[12px]" style={{ borderColor: 'var(--border)' }}><Markdown text={draft.body} /></div>
        : <textarea aria-label="設定資料の本文" value={draft.body} rows={16} maxLength={100000} onChange={(e) => change('body', e.target.value)} className={`${inputClass} leading-relaxed`} style={inputStyle} />}
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>作成: {new Date(document.created_at).toLocaleString('ja-JP')} ／ 更新: {new Date(document.updated_at).toLocaleString('ja-JP')}</p>
      {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void save()} disabled={!dirty || !draft.title.trim()} className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--text)' }} data-tip="設定資料の変更を保存します">{busy ? '保存中…' : '保存'}</button>
        <button onClick={() => discard(document.id)} disabled={!dirty} className={buttonClass} style={buttonStyle} data-tip="この設定資料の未保存の変更を取り消します">元に戻す</button>
        {dirty && <UnsavedBadge />}
        <button onClick={() => void remove()} className={`delete-action ml-auto ${buttonClass}`} data-tip="この設定資料を削除します">削除</button>
      </div>
    </fieldset>
  </div>
}
