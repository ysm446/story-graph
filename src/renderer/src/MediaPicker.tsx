import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, isVideoAsset, uploadAsset } from './api'
import type { MediaEntry, MediaItem } from './types'
import { Segment } from './Segment'

/** 持ち主の種類の呼び名(作品全体の一覧で「どこの画像か」を示す) */
export const MEDIA_OWNER_LABEL: Record<MediaItem['owner_type'], string> = { node: '挿絵', character: '人物', place: '場所' }

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm'
}

/** input の accept(MIME の並び)で受け付けるファイルか。使い回しの候補を持ち主の形式に絞るのに使う */
function acceptsAsset(accept: string, path: string): boolean {
  const mime = MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? '']
  return !!mime && accept.split(',').map((x) => x.trim()).includes(mime)
}

/** カードの中身(画像 / 動画と、動画の印) */
function CardMedia({ m }: { m: MediaItem }): React.JSX.Element {
  const url = assetUrl(m.thumb_path ?? m.path)
  return (
    <>
      {url ? (
        isVideoAsset(m.thumb_path ?? m.path) ? (
          <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <img src={url} draggable={false} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        )
      ) : null}
      {isVideoAsset(m.path) && (
        <span
          className="absolute bottom-1.5 right-1.5 rounded px-1 text-[10px]"
          style={{ background: 'rgba(28,31,43,0.85)', color: 'var(--text-dim)' }}
        >
          動画
        </span>
      )}
    </>
  )
}

/** 挿絵 / 参照画像のストック(docs/design/image-gen.md §7)。
 *
 *  持ち主(シーン / キャラ / 場所)に溜まった候補を並べ、クリックで 1 枚を「選択中」にする。
 *  差し替えで前の画像が消えることはなく、消すのはここの「削除」だけ。選択中の 1 枚は消せない
 *  (先に別の候補を選ぶか、インスペクタで画像を外す)。生成物は seed とプロンプトを持つので、
 *  選び直すと生成ウインドウの保存状態もその画像のセットに戻る。
 *
 *  「作品全体から選ぶ」では、ほかの持ち主のストックから使い回せる(ファイルは共有し、
 *  この持ち主のストックに 1 行写す)。使い回した画像を選んでも生成ウインドウの設定は戻らない。 */
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
  /** 追加できるファイル(input の accept)。作品全体から選ぶときも、この形式だけを出す */
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
  // 見せる一覧: この持ち主のストック / 作品全体(ほかの持ち主のストック)
  const [view, setView] = useState<'stock' | 'all'>('stock')
  const [all, setAll] = useState<MediaEntry[] | null>(null)
  const [allKind, setAllKind] = useState<MediaItem['owner_type'] | 'all'>('all')

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
    if (view !== 'all') return
    setAll(null)
    api.listAllMedia().then(
      (r) => setAll(r.items),
      (e) => setError(String(e))
    )
  }, [view])

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
  const reuse = (m: MediaEntry): void => {
    void run(async () => {
      await api.reuseMedia(m.id, ownerType, ownerId)
      setView('stock')
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
  const label = ownerType === 'node' ? '挿絵' : ownerType === 'place' ? '場所の画像' : '参照画像'

  // 作品全体の候補: ほかの持ち主の 1 枚を、ファイルごとに 1 回だけ(使い回して同じファイルを指す行はまとめる)。
  // この持ち主のストックに既にあるもの・ここで使えない形式は出さない
  const ownPaths = new Set((items ?? []).map((m) => m.path))
  const seen = new Set<string>()
  const candidates: MediaEntry[] = []
  let unusableCount = 0
  for (const m of all ?? []) {
    if (ownPaths.has(m.path) || seen.has(m.path)) continue
    seen.add(m.path)
    if (acceptsAsset(accept, m.path)) candidates.push(m)
    else unusableCount++
  }
  const kindCounts = { node: 0, character: 0, place: 0 }
  for (const m of candidates) kindCounts[m.owner_type]++
  const shownCandidates = allKind === 'all' ? candidates : candidates.filter((m) => m.owner_type === allKind)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="inspector-scrollbar max-h-[92vh] w-[720px] max-w-[92vw] overflow-y-auto rounded-2xl border p-4 shadow-xl shadow-black/50"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold">{label}のストック</h3>
          {view === 'stock' && (
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
                className="delete-action rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                data-tip="選択中の 1 枚だけ残して、ほかの候補をすべて削除します"
              >
                選んでいない候補を削除{unselectedCount > 0 ? `(${unselectedCount})` : ''}
              </button>
            </div>
          )}
        </div>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {view === 'stock'
            ? `クリックで${label}にします。生成した候補は seed とプロンプトを一緒に持っていて、選び直すと生成ウインドウもその設定に戻ります。選択中の 1 枚は削除できません。`
            : `ほかのシーン・人物・場所の画像を、クリックでこの${label}に使います(ストックにも入ります)。ファイルは共有するので、元の画像はそのまま残ります。生成ウインドウの設定は変わりません。`}
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segment
            options={[
              { value: 'stock', label: 'ストック', tip: `この${label}のストックを見る` },
              { value: 'all', label: '作品全体から選ぶ', tip: 'ほかのシーン・人物・場所の画像から選んで使い回す' }
            ]}
            value={view}
            onChange={setView}
          />
          {view === 'all' && candidates.length > 0 && (
            <Segment
              options={(['all', 'node', 'character', 'place'] as const).map((kind) => ({
                value: kind,
                label: kind === 'all' ? `すべて ${candidates.length}` : `${MEDIA_OWNER_LABEL[kind]} ${kindCounts[kind]}`,
                tip: kind === 'all' ? 'すべての種類を出す' : `${MEDIA_OWNER_LABEL[kind]}の画像だけを出す`
              }))}
              value={allKind}
              onChange={setAllKind}
              buttonClassName="px-2.5 py-0.5 text-[12px] tabular-nums"
            />
          )}
        </div>
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
        {view === 'all' ? (
          all === null ? (
            <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
              読み込み中…
            </p>
          ) : candidates.length === 0 ? (
            <div
              className="rounded-xl border border-dashed px-4 py-8 text-center text-[12px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
            >
              使い回せる画像がありません。ほかのシーン・人物・場所のストックに画像があると、ここに出ます。
            </div>
          ) : (
            <div className={`grid gap-3 ${ownerType === 'character' ? 'grid-cols-4' : 'grid-cols-3'}`}>
              {shownCandidates.map((m) => {
                const owner = `${MEDIA_OWNER_LABEL[m.owner_type]} · ${m.owner_name || '(無題)'}`
                const tip = [
                  `クリックでこの${label}に使う`,
                  `元: ${owner}`,
                  m.seed !== null ? `seed ${m.seed}` : null,
                  m.prompt ? `prompt: ${m.prompt.length > 160 ? `${m.prompt.slice(0, 160)}…` : m.prompt}` : null
                ]
                  .filter((x): x is string => !!x)
                  .join('\n')
                return (
                  <div key={m.id} className="flex min-w-0 flex-col gap-1">
                    <button
                      onClick={() => reuse(m)}
                      disabled={busy}
                      className="relative w-full overflow-hidden rounded-xl border disabled:opacity-60"
                      style={{ aspectRatio: aspect, background: 'var(--bg-canvas)', borderColor: 'var(--border-strong)' }}
                      data-tip={tip}
                      aria-label={`${owner}の画像をこの${label}に使う`}
                    >
                      <CardMedia m={m} />
                    </button>
                    <span className="truncate px-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      {owner}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        ) : items === null ? (
          <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </p>
        ) : items.length === 0 ? (
          <div
            className="rounded-xl border border-dashed px-4 py-8 text-center text-[12px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          >
            まだ候補がありません。生成して「決定」するか、「+ 追加」で手持ちのファイルを足すか、「作品全体から選ぶ」でほかの画像を使い回してください。
          </div>
        ) : (
          <div className={`grid gap-3 ${ownerType === 'character' ? 'grid-cols-4' : 'grid-cols-3'}`}>
            {items.map((m) => {
              const isSelected = m.path === selected
              const tip = [
                isSelected ? `選択中の${label}` : `クリックで${label}にする`,
                m.reused_from ? 'ほかの画像から使い回したもの(選んでも生成ウインドウの設定は戻りません)' : null,
                m.seed !== null ? `seed ${m.seed}` : '手持ちの画像(プロンプトなし)',
                m.workflow && m.workflow !== 'default' ? `ワークフロー: ${m.workflow}` : null,
                m.instructions ? `追加指示: ${m.instructions}` : null,
                // 加工した画像の prompt は作者の加工の指示
                m.prompt
                  ? `${m.source_path ? '加工の指示' : 'prompt'}: ${m.prompt.length > 160 ? `${m.prompt.slice(0, 160)}…` : m.prompt}`
                  : null
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
                    <CardMedia m={m} />
                    {isSelected && (
                      <span
                        className="absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ background: 'var(--accent)', color: '#fff' }}
                      >
                        選択中
                      </span>
                    )}
                  </button>
                  <div className="flex items-center justify-between gap-1 px-0.5">
                    <span className="truncate text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                      {m.reused_from
                        ? '使い回し'
                        : m.seed !== null
                          ? `${m.source_path ? '加工 · ' : ''}seed ${m.seed}`
                          : '手持ち'}
                    </span>
                    <button
                      onClick={() => remove(m)}
                      disabled={busy || isSelected}
                      className="delete-action rounded-md border px-1.5 py-0.5 text-[11px] disabled:opacity-40"
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
        {view === 'all' && unusableCount > 0 && (
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {ownerType === 'character'
              ? `動画と GIF は参照画像に使えないので、${unusableCount} 件を出していません。`
              : `動画は場所の画像に使えないので、${unusableCount} 件を出していません。`}
          </p>
        )}
        {error && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--danger-text)' }}>
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
