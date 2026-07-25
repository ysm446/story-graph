import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, uploadAsset } from '../api'
import ImageCropModal, { type CropState } from '../ImageCropModal'
import type { Character } from '../types'

const FIELD_DEFS: Array<{ key: 'profile' | 'appearance' | 'voice'; label: string; rows: number }> = [
  { key: 'profile', label: 'プロフィール(性格の基調・背景)', rows: 5 },
  { key: 'appearance', label: '外見', rows: 3 },
  { key: 'voice', label: '口調・一人称', rows: 3 }
]

export default function CharactersMode(): React.JSX.Element {
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<Character>>({})
  const [saving, setSaving] = useState(false)
  const [cropTarget, setCropTarget] = useState<{
    source: File | string
    isNewFile: boolean
    initial: CropState | null
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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
    setCropTarget(null)
    if (!target || !selectedId) return
    const sourcePath = target.isNewFile
      ? (await uploadAsset(target.source as File)).path
      : draft.portrait_source_path
    const cropped = new File([blob], 'portrait.png', { type: 'image/png' })
    const { path } = await uploadAsset(cropped)
    const patch = {
      portrait_path: path,
      portrait_source_path: sourcePath,
      portrait_crop: JSON.stringify(state)
    }
    await api.updateCharacter(selectedId, patch)
    setDraft((d) => ({ ...d, ...patch }))
    await reload()
  }

  const selected = characters.find((c) => c.id === selectedId) ?? null

  const reload = async (): Promise<void> => {
    const list = await api.listCharacters()
    setCharacters(list)
  }

  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    setDraft(selected ?? {})
  }, [selectedId, selected?.id])

  const handleCreate = async (): Promise<void> => {
    const created = await api.createCharacter({ name: '新しいキャラクター', color: '#7c5af7' })
    await reload()
    setSelectedId(created.id)
  }

  const handleSave = async (): Promise<void> => {
    if (!selectedId) return
    setSaving(true)
    try {
      await api.updateCharacter(selectedId, draft)
      await reload()
    } finally {
      setSaving(false)
    }
  }

  // 下書きが保存値と異なるか(シーンエディタと同じ判定方式)。画像は
  // 切り抜き確定時にその場で保存されるので、ここでは判定に含めない
  const dirty =
    selected !== null &&
    (['name', 'color', 'profile', 'appearance', 'voice'] as const).some(
      (key) => (draft[key] ?? '') !== (selected[key] ?? '')
    )

  const handleDelete = async (): Promise<void> => {
    if (!selectedId) return
    if (!window.confirm(`「${selected?.name}」を削除しますか?`)) return
    await api.deleteCharacter(selectedId)
    setSelectedId(null)
    await reload()
  }

  return (
    <div className="flex h-full">
      {cropTarget && (
        <ImageCropModal
          source={cropTarget.source}
          initial={cropTarget.initial}
          title="プロフィール画像の切り抜き"
          onCancel={() => setCropTarget(null)}
          onCropped={(blob, state) => void handleCropped(blob, state)}
        />
      )}
      <aside
        className="flex w-64 shrink-0 flex-col border-r"
        style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: 'var(--text-faint)' }}>
            Characters
          </span>
          <button
            onClick={() => void handleCreate()}
            className="rounded-md px-2 py-0.5 text-[12px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}
          >
            + 追加
          </button>
        </div>
        <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]"
              style={
                c.id === selectedId
                  ? { background: 'rgba(124, 90, 247, 0.18)', color: 'var(--text)' }
                  : { color: 'var(--text-dim)' }
              }
            >
              {assetUrl(c.portrait_path) ? (
                <img
                  src={assetUrl(c.portrait_path)!}
                  className="h-6 w-6 shrink-0 rounded-full object-cover"
                  style={{ border: `1.5px solid ${c.color ?? '#8a8fa8'}` }}
                />
              ) : (
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full"
                  style={{ background: c.color ?? '#8a8fa8' }}
                />
              )}
              <span className="truncate">{c.name}</span>
            </button>
          ))}
          {characters.length === 0 && (
            <div className="px-2 py-4 text-[12px]" style={{ color: 'var(--text-faint)' }}>
              まだキャラクターがいません
            </div>
          )}
        </div>
      </aside>
      <main className="inspector-scrollbar min-w-0 flex-1 overflow-y-auto p-6">
        {selected ? (
          <div className="mx-auto max-w-2xl">
            <div className="mb-4 flex items-center gap-3">
              {/* プロフィール画像(装飾専用。無くても成り立つ) */}
              <button
                onClick={() => {
                  if (draft.portrait_source_path) openRecrop()
                  else fileInputRef.current?.click()
                }}
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full border-2"
                style={{ borderColor: draft.color ?? '#8a8fa8', background: 'var(--bg-input)' }}
                title={draft.portrait_source_path ? 'クリックで切り抜き直し' : 'クリックで画像を設定'}
              >
                {assetUrl(draft.portrait_path) ? (
                  <img src={assetUrl(draft.portrait_path)!} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[20px]" style={{ color: 'var(--text-faint)' }}>
                    {(draft.name ?? '?').slice(0, 1)}
                  </span>
                )}
                <span
                  className="absolute inset-0 hidden items-center justify-center bg-black/50 text-[10px] text-white group-hover:flex"
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
                  if (!file || !selectedId) return
                  // 直接アップロードせず、切り抜きモーダルを挟む(元画像も保存される)
                  setCropTarget({ source: file, isNewFile: true, initial: null })
                }}
              />
              <input
                type="color"
                value={draft.color ?? '#7c5af7'}
                onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                className="h-9 w-9 cursor-pointer rounded-lg border-0 bg-transparent p-0"
              />
              <input
                value={draft.name ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-[16px] font-semibold outline-none"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
              />
              {draft.portrait_path && (
                <span className="flex shrink-0 flex-col gap-1">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-[11px]"
                    style={{ color: 'var(--text-faint)' }}
                    title="別の画像に差し替える"
                  >
                    画像を差し替え
                  </button>
                  <button
                    onClick={() => {
                      if (!selectedId) return
                      const patch = { portrait_path: null, portrait_source_path: null, portrait_crop: null }
                      void api.updateCharacter(selectedId, patch).then(async () => {
                        setDraft((d) => ({ ...d, ...patch }))
                        await reload()
                      })
                    }}
                    className="text-[11px]"
                    style={{ color: 'var(--text-faint)' }}
                    title="画像を外す"
                  >
                    画像を外す
                  </button>
                </span>
              )}
            </div>
            {FIELD_DEFS.map((f) => (
              <label key={f.key} className="mb-4 block">
                <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  {f.label}
                </span>
                <textarea
                  rows={f.rows}
                  value={(draft[f.key] as string | null) ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                />
              </label>
            ))}
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
        ) : (
          <div className="flex h-full items-center justify-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
            左のリストからキャラクターを選択、または追加してください
          </div>
        )}
      </main>
    </div>
  )
}
