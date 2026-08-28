import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, isVideoAsset, uploadAsset } from './api'
import type { MediaItem } from './types'

/** 挿絵 / 参照画像のストック(docs/design/image-gen.md §7)。
 *
 *  持ち主(シーン / キャラ)に溜まった候補を並べ、クリックで 1 枚を「選択中」にする。
 *  差し替えで前の画像が消えることはなく、消すのはここの「削除」だけ。選択中の 1 枚は消せない
 *  (先に別の候補を選ぶか、インスペクタで画像を外す)。生成物は seed とプロンプトを持つので、
 *  選び直すと生成ウインドウの保存状態もその画像のセットに戻る。 */
export default function MediaPicker({
  ownerType,
  ownerId,
  aspect,
  accept,
  onChanged,
  onClose
}: {
  ownerType: MediaItem['owner_type']
  ownerId: string
  /** カードの縦横比(場面は横長、参照画像は縦長) */
  aspect: string
  /** 追加できるファイル(input の accept) */
  accept: string
  /** 選択 / 削除で持ち主の画像や保存状態が変わったあとに呼ぶ(再読み込み用) */
  onChanged: () => void
  onClose: () => void
}): React.JSX.Element {
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const reload = async (): Promise<void> => {
    try {
      const r = await api.listMedia(ownerType, ownerId)
      setItems(r.items)
      setSelected(r.selected)
    } catch (e) {
      setError(String(e))
    }
  }
  useEffect(() => {
    void reload()
  }, [ownerType, ownerId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const select = (m: MediaItem): void => {
    if (m.path === selected) return
    void run(async () => {
      await api.selectMedia(m.id)
    })
  }
  const remove = (m: MediaItem): void => {
    void run(async () => {
      await api.deleteMedia(m.id)
    })
  }
  const removeUnselected = (): void => {
    void run(async () => {
      await api.deleteUnselectedMedia(ownerType, ownerId)
    })
  }
  const addFile = (file: File | undefined): void => {
    if (!file) return
    void run(async () => {
      const { path } = await uploadAsset(file)
      await api.addMedia(ownerType, ownerId, path, false)
    })
  }

  const unselectedCount = items ? items.filter((m) => m.path !== selected).length : 0
  const label = ownerType === 'node' ? '挿絵' : '参照画像'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="inspector-scrollbar max-h-[92vh] w-[720px] max-w-[92vw] overflow-y-auto rounded-2xl border p-4"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold">{label}のストック</h3>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="手持ちのファイルをストックに足します(選択はしません)"
            >
              + 追加
            </button>
            <button
              onClick={removeUnselected}
              disabled={busy || unselectedCount === 0}
              className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="選択中の 1 枚だけ残して、ほかの候補をすべて削除します"
            >
              選んでいない候補を削除{unselectedCount > 0 ? `(${unselectedCount})` : ''}
            </button>
          </div>
        </div>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          クリックで{label}にします。生成した候補は seed とプロンプトを一緒に持っていて、選び直すと生成ウインドウもその設定に戻ります。
          選択中の 1 枚は削除できません。
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            addFile(file)
          }}
        />
        {items === null ? (
          <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </p>
        ) : items.length === 0 ? (
          <div
            className="rounded-xl border border-dashed px-4 py-8 text-center text-[12px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          >
            まだ候補がありません。生成して「決定」するか、「+ 追加」で手持ちのファイルを足してください。
          </div>
        ) : (
          <div className={`grid gap-3 ${ownerType === 'node' ? 'grid-cols-3' : 'grid-cols-4'}`}>
            {items.map((m) => {
              const isSelected = m.path === selected
              const url = assetUrl(m.thumb_path ?? m.path)
              const tip = [
                isSelected ? `選択中の${label}` : `クリックで${label}にする`,
                m.seed !== null ? `seed ${m.seed}` : '手持ちの画像(プロンプトなし)',
                m.workflow && m.workflow !== 'default' ? `ワークフロー: ${m.workflow}` : null,
                m.instructions ? `追加指示: ${m.instructions}` : null,
                m.prompt ? `prompt: ${m.prompt.length > 160 ? `${m.prompt.slice(0, 160)}…` : m.prompt}` : null
              ]
                .filter((x): x is string => !!x)
                .join('\n')
              return (
                <div key={m.id} className="flex flex-col gap-1">
                  <button
                    onClick={() => select(m)}
                    disabled={busy}
                    className="relative w-full overflow-hidden rounded-xl border disabled:opacity-60"
                    style={{
                      aspectRatio: aspect,
                      background: 'var(--bg-canvas)',
                      borderColor: isSelected ? 'var(--accent)' : 'var(--border-strong)',
                      boxShadow: isSelected ? '0 0 0 1px var(--accent)' : undefined
                    }}
                    data-tip={tip}
                    aria-label={isSelected ? `選択中の${label}` : `この画像を${label}にする`}
                  >
                    {url ? (
                      isVideoAsset(m.thumb_path ?? m.path) ? (
                        <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                      ) : (
                        <img src={url} draggable={false} className="h-full w-full object-cover" />
                      )
                    ) : null}
                    {isSelected && (
                      <span
                        className="absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ background: 'var(--accent)', color: '#fff' }}
                      >
                        選択中
                      </span>
                    )}
                    {isVideoAsset(m.path) && (
                      <span
                        className="absolute bottom-1.5 right-1.5 rounded px-1 text-[10px]"
                        style={{ background: 'rgba(28,31,43,0.85)', color: 'var(--text-dim)' }}
                      >
                        動画
                      </span>
                    )}
                  </button>
                  <div className="flex items-center justify-between gap-1 px-0.5">
                    <span className="truncate text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                      {m.seed !== null ? `seed ${m.seed}` : '手持ち'}
                    </span>
                    <button
                      onClick={() => remove(m)}
                      disabled={busy || isSelected}
                      className="rounded-md border px-1.5 py-0.5 text-[11px] disabled:opacity-40"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                      data-tip={isSelected ? '選択中の画像は削除できません。先に別の候補を選んでください' : 'ストックから削除します(元に戻せません)'}
                    >
                      削除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: '#f2a3a3' }}>
            {error}
          </p>
        )}
        <div className="mt-3 flex items-center">
          <button
            onClick={onClose}
            className="ml-auto rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
