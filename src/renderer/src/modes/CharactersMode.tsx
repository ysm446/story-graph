import { useCallback, useEffect, useRef, useState } from 'react'
import { api, assetUrl, uploadAsset } from '../api'
import ImageCropModal, { type CropState } from '../ImageCropModal'
import ProofreadTextarea from '../ProofreadTextarea'
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
  const rowRef = useRef<HTMLDivElement | null>(null)
  // 左サイドバーの幅(ドラッグで変更。localStorage に保存)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('charactersSidebarWidth'))
    return saved >= 180 && saved <= 520 ? saved : 256
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
    <div ref={rowRef} className="flex h-full">
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
        className="flex shrink-0 flex-col"
        style={{ background: 'var(--bg-sidebar)', width: sidebarWidth }}
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
              className="mb-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[15px]"
              style={
                c.id === selectedId
                  ? { background: 'rgba(124, 90, 247, 0.18)', color: 'var(--text)' }
                  : { color: 'var(--text-dim)' }
              }
            >
              {assetUrl(c.portrait_path) ? (
                <img
                  src={assetUrl(c.portrait_path)!}
                  className="h-10 w-10 shrink-0 rounded-full object-cover"
                  style={{ border: `1.5px solid ${c.color ?? '#8a8fa8'}` }}
                />
              ) : (
                // 画像が無いキャラも同じ大きさの丸で並べる(頭文字入り)
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold"
                  style={{
                    background: `${c.color ?? '#8a8fa8'}33`,
                    border: `1.5px solid ${c.color ?? '#8a8fa8'}`,
                    color: c.color ?? '#8a8fa8'
                  }}
                >
                  {c.name.slice(0, 1)}
                </span>
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
      {/* サイドバー幅のリサイズハンドル(構造モードのインスペクタと同じ作り) */}
      <div
        onPointerDown={beginSidebarResize}
        className="group relative w-1 shrink-0 cursor-col-resize"
        title="ドラッグで幅を変更"
      >
        <div
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-[var(--accent-border)]"
          style={{ background: 'var(--border)' }}
        />
      </div>
      <main className="inspector-scrollbar min-w-0 flex-1 overflow-y-auto p-6">
        {selected ? (
          <div className="mx-auto max-w-2xl">
            {/* 画像 → 画像操作 → 名前 の順に縦に積む(色は名前の隣に項目として置く) */}
            <div className="mb-4 flex flex-col items-start gap-1.5">
              {/* プロフィール画像(装飾専用。無くても成り立つ) */}
              <button
                onClick={() => {
                  if (draft.portrait_source_path) openRecrop()
                  else fileInputRef.current?.click()
                }}
                className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-full border-2"
                style={{ borderColor: draft.color ?? '#8a8fa8', background: 'var(--bg-input)' }}
                title={draft.portrait_source_path ? 'クリックで切り抜き直し' : 'クリックで画像を設定'}
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
                  if (!file || !selectedId) return
                  // 直接アップロードせず、切り抜きモーダルを挟む(元画像も保存される)
                  setCropTarget({ source: file, isNewFile: true, initial: null })
                }}
              />
              {/* 画像のすぐ下に画像操作(画像があるときだけ) */}
              {draft.portrait_path && (
                <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  <button onClick={() => fileInputRef.current?.click()} title="別の画像に差し替える">
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
                    title="画像を外す"
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
                    title="ノード・関係図・チャットで使われるキャラの色"
                  />
                </label>
              </div>
            </div>
            {FIELD_DEFS.map((f) => (
              <label key={f.key} className="mb-4 block">
                <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  {f.label}
                </span>
                {/* 高さの自動調整と「選択して校正」は共通コンポーネントに任せる */}
                <ProofreadTextarea
                  rows={f.rows}
                  value={(draft[f.key] as string | null) ?? ''}
                  onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
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
