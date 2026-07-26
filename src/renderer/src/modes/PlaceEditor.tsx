import { useEffect, useState } from 'react'
import { api } from '../api'
import ProofreadTextarea from '../ProofreadTextarea'
import type { Place } from '../types'

const FIELD_DEFS: Array<{ key: 'description' | 'atmosphere'; label: string; rows: number }> = [
  { key: 'description', label: '説明(地形・規模・成り立ち)', rows: 5 },
  { key: 'atmosphere', label: '雰囲気・空気感', rows: 3 }
]

/** 場所の編集ペイン(キャラクター編集と同じ構成)。
 *  説明と雰囲気は清書プロンプトに毎回渡るので、背景描写の一貫性に直結する。 */
export default function PlaceEditor({
  place,
  onChanged,
  onDeleted
}: {
  place: Place
  onChanged: () => Promise<void>
  onDeleted: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Partial<Place>>(place)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(place)
  }, [place.id])

  const dirty = (['name', 'color', 'description', 'atmosphere'] as const).some(
    (key) => (draft[key] ?? '') !== (place[key] ?? '')
  )

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.updatePlace(place.id, draft)
      await onChanged()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm(`「${place.name}」を削除しますか?\nこの場所を使っているシーンは「引き継ぐ」に戻ります。`))
      return
    await api.deletePlace(place.id)
    onDeleted()
    await onChanged()
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex w-full items-end gap-2">
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
            名前
          </span>
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
            value={draft.color ?? '#5a8fa7'}
            onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
            className="color-swatch block h-11 w-12 cursor-pointer"
            title="シーンカードの場所表示に使う色"
          />
        </label>
      </div>
      {FIELD_DEFS.map((f) => (
        <label key={f.key} className="mb-4 block">
          <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
            {f.label}
          </span>
          <ProofreadTextarea
            rows={f.rows}
            value={(draft[f.key] as string | null) ?? ''}
            onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
        </label>
      ))}
      <p className="mb-4 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        説明と雰囲気は、この場所を舞台にするシーンの清書に毎回渡されます。
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          style={{ background: saving ? 'var(--accent-hover)' : 'var(--accent)' }}
          title={dirty ? undefined : '変更はありません'}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          onClick={() => void handleDelete()}
          className="ml-auto rounded-lg px-3 py-1.5 text-[13px]"
          style={{ color: 'var(--danger)' }}
        >
          削除
        </button>
      </div>
    </div>
  )
}
