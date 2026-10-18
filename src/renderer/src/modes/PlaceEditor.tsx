import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, uploadAsset } from '../api'
import { EditActions, EditPencil, ReadText, editKeys, focusEditGroup } from '../FieldEdit'
import { Icon } from '../icons'
import MediaPicker from '../MediaPicker'
import PlaceImageModal from '../PlaceImageModal'
import ProofreadTextarea from '../ProofreadTextarea'
import type { Place } from '../types'
import SceneUsage, { type SceneUsageProps } from '../SceneUsage'

/** 新しい場所の色。色の欄の「既定の色に戻す」もこの色にする */
export const DEFAULT_PLACE_COLOR = '#5a8fa7'

const EDITABLE_FIELDS = ['name', 'color', 'description', 'atmosphere', 'reading'] as const

const FIELD_DEFS: Array<{ key: 'description' | 'atmosphere'; label: string; short: string; rows: number }> = [
  { key: 'description', label: '説明(地形・規模・成り立ち)', short: '説明', rows: 5 },
  { key: 'atmosphere', label: '雰囲気・空気感', short: '雰囲気', rows: 3 }
]

/** 編集の単位(キャラクターと同じ考え方)。名前・読み・色はまとめて編集する */
type EditGroup = 'identity' | 'description' | 'atmosphere'
const GROUP_FIELDS: Record<EditGroup, ReadonlyArray<(typeof EDITABLE_FIELDS)[number]>> = {
  identity: ['name', 'reading', 'color'],
  description: ['description'],
  atmosphere: ['atmosphere']
}
const ALL_GROUPS: EditGroup[] = ['identity', 'description', 'atmosphere']
/** data-edit-group の値。キャラクターの編集欄と名前が重ならないようにする */
const groupName = (group: EditGroup): string => `place-${group}`

/** 場所のページ(キャラクターと同じ構成)。読む表示が既定で、鉛筆か本文を押した項目だけを編集欄にし、項目ごとに確定して保存する。
 *  説明と雰囲気は清書プロンプトに毎回渡るので、背景描写の一貫性に直結する。 */
export default function PlaceEditor({
  place,
  usage,
  onChanged,
  onDirty,
  onUnsavedChange,
  onDeleted,
  startEditing = false,
  onStartedEditing
}: {
  place: Place
  /** 出番の図(使われている場面。引き継ぎを含む)。資料庫だけが渡す */
  usage?: SceneUsageProps
  onChanged: () => Promise<void>
  onDirty?: (dirty: boolean) => void
  onUnsavedChange?: (dirty: boolean) => void
  onDeleted: () => void
  /** 新規作成の直後だけ true。全項目を編集状態で開く */
  startEditing?: boolean
  onStartedEditing?: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Partial<Place>>(place)
  const [draftReset, setDraftReset] = useState(0)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<ReadonlySet<EditGroup>>(() => new Set(startEditing ? ALL_GROUPS : []))
  const [saveError, setSaveError] = useState<{ group: EditGroup; message: string } | null>(null)
  useEffect(() => {
    if (startEditing) onStartedEditing?.()
  }, [])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // 参考画像へのドラッグ&ドロップ。子要素をまたぐと dragleave が誤発火するので、
  // 深さを数えて 0 になったときだけハイライトを消す(シーンの挿絵と同じ作り)
  const [imageDragOver, setImageDragOver] = useState(false)
  const imageDragDepth = useRef(0)
  // 画像のストック(候補の一覧)と生成ウインドウ
  const [stockOpen, setStockOpen] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)

  useEffect(() => {
    setDraft(place)
    setStockOpen(false)
    setGenerateOpen(false)
  }, [place.id])

  const dirty = EDITABLE_FIELDS.some(
    (key) => (draft[key] ?? '') !== (place[key] ?? '')
  )

  const groupDirty = (group: EditGroup): boolean =>
    GROUP_FIELDS[group].some((key) => (draft[key] ?? '') !== (place[key] ?? ''))

  const closeEdit = (group: EditGroup): void => {
    setEditing((current) => {
      const next = new Set(current)
      next.delete(group)
      return next
    })
    setSaveError((current) => (current?.group === group ? null : current))
  }

  const startEdit = (group: EditGroup): void => {
    if (saving || editing.has(group)) return
    // 開く単位だけ保存値から読み直す(制作チャットなどが保存した値を取りこぼさない)
    const saved = Object.fromEntries(GROUP_FIELDS[group].map((key) => [key, place[key]]))
    setDraft((current) => ({ ...current, ...saved }))
    setEditing((current) => new Set(current).add(group))
    focusEditGroup(groupName(group))
  }

  const cancelEdit = (group: EditGroup): void => {
    if (saving) return
    const saved = Object.fromEntries(GROUP_FIELDS[group].map((key) => [key, place[key]]))
    setDraft((current) => ({ ...current, ...saved }))
    setDraftReset((value) => value + 1)
    closeEdit(group)
  }

  useEffect(() => {
    onDirty?.(dirty || saving || uploading)
    return () => onDirty?.(false)
  }, [dirty, saving, uploading, onDirty])

  useEffect(() => {
    onUnsavedChange?.(dirty)
    return () => onUnsavedChange?.(false)
  }, [dirty, onUnsavedChange])

  const commitEdit = async (group: EditGroup): Promise<void> => {
    if (saving) return
    if (group === 'identity' && !(draft.name ?? '').trim()) return
    setSaving(true)
    try {
      // 変えた項目だけ送る。draft は選択時点の丸ごとコピーなので、そのまま PATCH すると
      // 編集中に別の経路(制作チャットなど)で保存された項目を古い値で巻き戻す
      const patch = Object.fromEntries(
        GROUP_FIELDS[group].filter((k) => (draft[k] ?? '') !== (place[k] ?? ''))
          .map((k) => [k, k === 'name' ? (draft[k] ?? '') : (draft[k] || null)])
      )
      if (Object.keys(patch).length > 0) {
        await api.updatePlace(place.id, patch)
        await onChanged()
      }
      closeEdit(group)
    } catch (e) {
      setSaveError({ group, message: `保存できませんでした: ${String(e)}` })
    } finally {
      setSaving(false)
    }
  }

  const actions = (group: EditGroup): React.JSX.Element => (
    <EditActions
      dirty={groupDirty(group)}
      saving={saving}
      blocked={group === 'identity' && !(draft.name ?? '').trim() ? '名前を入力してください' : undefined}
      error={saveError?.group === group ? saveError.message : undefined}
      onCommit={() => void commitEdit(group)}
      onCancel={() => cancelEdit(group)}
    />
  )
  const keys = (group: EditGroup): ((event: React.KeyboardEvent) => void) =>
    editKeys(editing.has(group), () => void commitEdit(group), () => cancelEdit(group))
  // 画像の枠の色。名前・色を編集している間は下書きを映し、それ以外は保存値
  const shownColor = editing.has('identity') ? draft.color : place.color

  /** 参考画像を設定・差し替える。装飾専用(LLM には渡らない)なので清書は stale にならない。
   *  名前や説明と違って保存ボタンは待たず、キャラのプロフィール画像と同じく即保存する。
   *  前の画像はストックに残る(手持ちの画像としてストックに足し、そのまま選択する) */
  const acceptImageFile = async (file: File | undefined): Promise<void> => {
    if (!file || !file.type.startsWith('image/')) return
    setUploading(true)
    try {
      const { path } = await uploadAsset(file)
      await api.addMedia('place', place.id, path)
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

  // 画像は即保存なので、保存値が変わったら(ストックの選び直し・生成の決定など)下書きにも写す
  useEffect(() => {
    setDraft((d) => ({ ...d, image_path: place.image_path }))
  }, [place.image_path])
  // 生成のプロンプトは保存済みの説明・雰囲気から作るので、編集中の変更があれば知らせる
  const unsavedDescription = (['description', 'atmosphere'] as const).some(
    (key) => editing.has(key) && groupDirty(key)
  )

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
          data-write-action
          onClick={() => {
            if (!draft.image_path) fileInputRef.current?.click()
          }}
          className="w-full overflow-hidden rounded-xl border transition-colors"
          style={{
            borderColor: shownColor ?? 'var(--border)',
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
        <div className="flex w-full flex-wrap items-center gap-2">
          <button
            onClick={() => setStockOpen(true)}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip="生成した候補と手持ちの画像の一覧。ここから 1 枚を選び直したり、いらない候補を削除したりできます"
          >
            ストック
          </button>
          {draft.image_path && (
            <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              <button onClick={() => fileInputRef.current?.click()} data-tip="別の画像に差し替える(前の画像はストックに残ります)">
                {uploading ? 'アップロード中…' : '画像を差し替え'}
              </button>
              <span>・</span>
              <button onClick={() => void removeImage()} data-tip="画像を外す(ストックとプロンプトは残ります)">
                画像を外す
              </button>
            </div>
          )}
          {/* 左から確かめて、最後に押す「生成」は右端(生成ウインドウと同じ並び) */}
          <button
            onClick={() => setGenerateOpen(true)}
            className="accent-action ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium"
            data-tip={
              place.image_prompt
                ? '保存済みのプロンプト・追加指示・seed を開きます(説明を変えたら中の「説明から書き直す」で作り直せます)'
                : '保存済みの説明・雰囲気から英語のプロンプトを作り(確認・手直しできます)、ComfyUI で人物なしの全景を生成します'
            }
          >
            <Icon name="sparkle" size={12} /> {draft.image_path ? '作り直す' : '説明から生成'}
          </button>
        </div>
        {unsavedDescription && (
          <p className="text-[11px]" style={{ color: '#f2a3a3' }}>
            説明・雰囲気に未保存の変更があります。プロンプトは保存済みの内容から作るので、先に「確定」してください。
          </p>
        )}
        {!(place.description ?? '').trim() && !(place.atmosphere ?? '').trim() && !draft.image_path && (
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            説明・雰囲気が空のままだと、名前だけから景色を想像して描きます。先に説明を書いて確定してから生成すると狙いどおりになります。
          </p>
        )}
      </div>
      {stockOpen && (
        <MediaPicker
          ownerType="place"
          ownerId={place.id}
          aspect="1216 / 832"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChanged={() => void onChanged()}
          onClose={() => setStockOpen(false)}
        />
      )}
      {generateOpen && (
        <PlaceImageModal place={place} onChanged={onChanged} onClose={() => setGenerateOpen(false)} />
      )}
      <div className="mb-5" data-edit-group={groupName('identity')} onKeyDown={keys('identity')}>
        {editing.has('identity') ? (
          <>
            <div className="flex w-full items-end gap-2">
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  名前
                </span>
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
              {/* 戻すボタンを label の中に置くと、押したときに色の選択も開くので div で包む */}
              <div className="shrink-0">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    色
                  </span>
                  <button
                    onClick={() => setDraft((d) => ({ ...d, color: DEFAULT_PLACE_COLOR }))}
                    disabled={(draft.color ?? '').toLowerCase() === DEFAULT_PLACE_COLOR}
                    aria-label="既定の色に戻す"
                    data-tip={`既定の色(${DEFAULT_PLACE_COLOR})に戻す`}
                    className="rounded-md p-0.5 hover:bg-[var(--accent-soft)] disabled:opacity-50 disabled:hover:bg-transparent"
                    style={{ color: 'var(--text-faint)' }}
                  >
                    <Icon name="rotateCcw" size={12} />
                  </button>
                </div>
                <input
                  type="color"
                  value={draft.color ?? DEFAULT_PLACE_COLOR}
                  onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                  className="color-swatch block h-11 w-12 cursor-pointer"
                  data-tip="シーンカードの場所表示に使う色"
                />
              </div>
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
                data-tip="読み上げで、この場所の名前を指定した読みで読ませます。台本や本文の表記は変わりません。"
              />
            </label>
            {actions('identity')}
          </>
        ) : (
          <>
            <div className="flex items-start gap-1.5">
              <h2 data-place-name className="min-w-0 text-[22px] font-semibold leading-tight [overflow-wrap:anywhere]" style={{ color: 'var(--text)' }}>
                {place.name || '(名前なし)'}
              </h2>
              <EditPencil label="名前・読み・色" onClick={() => startEdit('identity')} />
            </div>
            <p className="mt-1 text-[12px]" style={{ color: place.reading ? 'var(--text-dim)' : 'var(--text-faint)' }}>
              {place.reading || '読みは未設定'}
            </p>
          </>
        )}
      </div>
      {FIELD_DEFS.map((f) => (
        <section key={f.key} className="mb-5" data-edit-group={groupName(f.key)} onKeyDown={keys(f.key)}>
          {!editing.has(f.key) && (
            <div className="mb-1 flex items-center gap-1.5">
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {f.label}
              </span>
              <EditPencil label={f.short} onClick={() => startEdit(f.key)} />
            </div>
          )}
          {editing.has(f.key) ? (
            <>
              <ProofreadTextarea
                label={<span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{f.label}</span>}
                key={`${place.id}:${f.key}:${draftReset}`}
                rows={f.rows}
                value={(draft[f.key] as string | null) ?? ''}
                onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
              />
              {actions(f.key)}
            </>
          ) : (
            <ReadText value={place[f.key] ?? ''} emptyLabel={f.short} onEdit={() => startEdit(f.key)} />
          )}
        </section>
      ))}
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        説明と雰囲気は、この場所を舞台にするシーンの清書に毎回渡されます。
      </p>
      {usage && (
        <div className="mt-5">
          <SceneUsage kind="place" entityId={place.id} name={place.name || '(名前なし)'} color={place.color} {...usage} />
        </div>
      )}
      <div className="mt-6 flex border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <button onClick={() => void handleDelete()} className="delete-action ml-auto text-[12px]">
          この場所を削除
        </button>
      </div>
    </div>
  )
}
