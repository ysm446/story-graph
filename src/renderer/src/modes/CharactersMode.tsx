import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, uploadAsset } from '../api'
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
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  const handleDelete = async (): Promise<void> => {
    if (!selectedId) return
    if (!window.confirm(`「${selected?.name}」を削除しますか?`)) return
    await api.deleteCharacter(selectedId)
    setSelectedId(null)
    await reload()
  }

  return (
    <div className="flex h-full">
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
                onClick={() => fileInputRef.current?.click()}
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full border-2"
                style={{ borderColor: draft.color ?? '#8a8fa8', background: 'var(--bg-input)' }}
                title="クリックで画像を設定"
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
                  変更
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
                  void uploadAsset(file).then(async ({ path }) => {
                    await api.updateCharacter(selectedId, { portrait_path: path })
                    setDraft((d) => ({ ...d, portrait_path: path }))
                    await reload()
                  })
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
                <button
                  onClick={() => {
                    if (!selectedId) return
                    void api.updateCharacter(selectedId, { portrait_path: null }).then(async () => {
                      setDraft((d) => ({ ...d, portrait_path: null }))
                      await reload()
                    })
                  }}
                  className="shrink-0 text-[11px]"
                  style={{ color: 'var(--text-faint)' }}
                  title="画像を外す"
                >
                  画像を外す
                </button>
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
                disabled={saving}
                className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white"
                style={{ background: saving ? 'var(--accent-hover)' : 'var(--accent)' }}
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
