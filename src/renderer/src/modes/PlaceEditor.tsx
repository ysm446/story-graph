import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, uploadAsset } from '../api'
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
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // 参考画像へのドラッグ&ドロップ。子要素をまたぐと dragleave が誤発火するので、
  // 深さを数えて 0 になったときだけハイライトを消す(シーンの挿絵と同じ作り)
  const [imageDragOver, setImageDragOver] = useState(false)
  const imageDragDepth = useRef(0)

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

  /** 参考画像を設定・差し替える。装飾専用(LLM には渡らない)なので清書は stale にならない。
   *  名前や説明と違って保存ボタンは待たず、キャラのプロフィール画像と同じく即保存する。 */
  const acceptImageFile = async (file: File | undefined): Promise<void> => {
    if (!file || !file.type.startsWith('image/')) return
    setUploading(true)
    try {
      const { path } = await uploadAsset(file)
      await api.updatePlace(place.id, { image_path: path })
      // draft は place.id が変わるまで同期しないので、ここでも反映する
      setDraft((d) => ({ ...d, image_path: path }))
      await onChanged()
    } catch (e) {
      window.alert(`画像の保存に失敗しました: ${String(e)}`)
    } finally {
      setUploading(false)
    }
  }

  const removeImage = async (): Promise<void> => {
    await api.updatePlace(place.id, { image_path: null })
    setDraft((d) => ({ ...d, image_path: null }))
    await onChanged()
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
      {/* 参考画像(装飾専用。景色なので丸く切り抜かず、横長のまま置く) */}
      <div className="mb-4 flex flex-col items-start gap-1.5">
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
            void acceptImageFile(e.dataTransfer.files?.[0])
          }}
          onClick={() => {
            if (!draft.image_path) fileInputRef.current?.click()
          }}
          className="w-full overflow-hidden rounded-xl border transition-colors"
          style={{
            borderColor: draft.color ?? 'var(--border)',
            background: 'var(--bg-input)',
            ...(imageDragOver ? { outline: '2px dashed var(--accent)', outlineOffset: 2 } : {})
          }}
          data-tip={draft.image_path ? '画像をドロップで差し替え' : 'クリックで画像を設定 / 画像をドロップ'}
        >
          {assetUrl(draft.image_path) ? (
            <img src={assetUrl(draft.image_path)!} className="block max-h-72 w-full object-cover" />
          ) : (
            <div
              className="flex h-28 cursor-pointer items-center justify-center text-[12px]"
              style={{ color: 'var(--text-faint)' }}
            >
              {uploading ? 'アップロード中…' : 'クリックで画像を設定、またはここに画像をドロップ'}
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            void acceptImageFile(file)
          }}
        />
        {draft.image_path && (
          <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            <button onClick={() => fileInputRef.current?.click()} data-tip="別の画像に差し替える">
              {uploading ? 'アップロード中…' : '画像を差し替え'}
            </button>
            <span>・</span>
            <button onClick={() => void removeImage()} data-tip="画像を外す">
              画像を外す
            </button>
          </div>
        )}
      </div>
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
            data-tip="シーンカードの場所表示に使う色"
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
          data-tip={dirty ? undefined : '変更はありません'}
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
