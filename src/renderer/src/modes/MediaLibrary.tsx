import { useEffect, useMemo, useState } from 'react'
import { api, assetUrl, isVideoAsset } from '../api'
import { Icon } from '../icons'
import Lightbox from '../Lightbox'
import { MEDIA_OWNER_LABEL } from '../MediaPicker'
import type { MediaEntry, MediaItem } from '../types'
import { useWorkspace } from '../Workspace'
import { askConfirm } from '../ConfirmDialog'

/** 同じファイルをまとめた 1 枚(使い回すと、同じファイルを指す行が持ち主ごとにできる) */
type MediaFile = {
  path: string
  thumb_path: string | null
  /** このファイルを持っているストック(新しい順。同じ持ち主は 1 回だけ) */
  owners: MediaEntry[]
  /** どれかの持ち主がいま選んでいる */
  inUse: boolean
}

type KindFilter = MediaItem['owner_type'] | 'all'
type FormatFilter = 'all' | 'image' | 'video'

/** 資料庫のメディアページ(docs/design/image-gen.md §7)。作品全体のストックの画像・動画を一覧する。
 *  クリックで拡大、カードの下の名前でその持ち主(シーン / 人物 / 場所)を開く。
 *  別の持ち主で使うのは、使う側のストックの「作品全体から選ぶ」から。
 *  「削除」はファイルを全部のストックから外す(使用中なら持ち主の画像を外してから)。 */
export default function MediaLibrary({
  onOpenOwner
}: {
  /** 人物・場所のページを開く(シーンはここで workspace.openScene に渡す) */
  onOpenOwner: (ownerType: 'character' | 'place', ownerId: string) => void
}): React.JSX.Element {
  const workspace = useWorkspace()
  const [entries, setEntries] = useState<MediaEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<KindFilter>('all')
  const [format, setFormat] = useState<FormatFilter>('all')
  const [zoom, setZoom] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api.listAllMedia().then(
      (r) => {
        if (alive) setEntries(r.items)
      },
      (e) => {
        if (alive) setError(`メディアの一覧を読めませんでした: ${String(e)}`)
      }
    )
    return () => {
      alive = false
    }
  }, [workspace.revision])

  const files = useMemo(() => {
    const byPath = new Map<string, MediaFile>()
    for (const m of entries ?? []) {
      let f = byPath.get(m.path)
      if (!f) {
        f = { path: m.path, thumb_path: m.thumb_path, owners: [], inUse: false }
        byPath.set(m.path, f)
      }
      f.thumb_path ??= m.thumb_path
      f.inUse ||= m.selected
      if (!f.owners.some((o) => o.owner_type === m.owner_type && o.owner_id === m.owner_id)) f.owners.push(m)
    }
    return [...byPath.values()]
  }, [entries])

  const byFormat = files.filter((f) => format === 'all' || (format === 'video') === isVideoAsset(f.path))
  const kindCount = (k: KindFilter): number =>
    k === 'all' ? byFormat.length : byFormat.filter((f) => f.owners.some((o) => o.owner_type === k)).length
  const shown = kind === 'all' ? byFormat : byFormat.filter((f) => f.owners.some((o) => o.owner_type === kind))
  const videoCount = files.filter((f) => isVideoAsset(f.path)).length

  const openOwner = (o: MediaEntry): void => {
    if (o.owner_type === 'node') workspace.openScene(o.owner_id)
    else onOpenOwner(o.owner_type, o.owner_id)
  }
  const ownerText = (o: MediaEntry): string => `${MEDIA_OWNER_LABEL[o.owner_type]} · ${o.owner_name || '(無題)'}`
  const unusedCount = files.filter((f) => !f.inUse).length

  // 削除のあとは作品全体を読み直させる(挿絵・参照画像を外すと、フローチャートや資料庫のページも変わる)。
  // このページも workspace.revision で読み直す
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      workspace.changed()
    } catch (e) {
      setError(`削除できませんでした: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const GC_NOTE = 'ファイルは次にライブラリを開いたときに片付けます(時点に戻す用のスナップショットや人物のアイコンの元画像が使っているものは残ります)。'
  const removeFile = async (f: MediaFile): Promise<void> => {
    const using = f.owners.filter((o) => o.selected)
    const lines = [
      f.inUse ? 'この画像は使用中です。使っている所から外して削除しますか?' : 'この画像をストックから削除しますか?',
      ...using.map((o) => `・${ownerText(o)} の${o.owner_type === 'node' ? '挿絵' : o.owner_type === 'place' ? '画像' : '参照画像'}が空になります`),
      ...f.owners.filter((o) => !o.selected).map((o) => `・${ownerText(o)} のストックから外れます`),
      '',
      GC_NOTE
    ]
    if (!(await askConfirm(lines.join('\n'), '削除'))) return
    void run(() => api.deleteMediaFile(f.path))
  }
  const removeUnused = async (): Promise<void> => {
    if (!(await askConfirm(`どこでも使われていない画像 ${unusedCount} 件を、すべてのストックから削除しますか?\n\n${GC_NOTE}`, '削除'))) return
    void run(() => api.deleteUnusedMedia())
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          メディア
        </h2>
        {entries !== null && (
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
            {files.length}
            {videoCount > 0 ? `(うち動画 ${videoCount})` : ''}
          </span>
        )}
        <button
          data-write-action
          onClick={() => void removeUnused()}
          disabled={busy || unusedCount === 0}
          className="delete-action ml-auto rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
          data-tip={
            unusedCount === 0
              ? 'どこでも使われていない画像はありません'
              : 'どのシーン・人物・場所でも選ばれていない画像を、すべてのストックから削除します(絞り込みに関係なく作品全体)'
          }
        >
          使われていない画像を削除{unusedCount > 0 ? `(${unusedCount})` : ''}
        </button>
      </div>
      <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        シーンの挿絵・人物の参照画像・場所の画像のストックにある画像と動画です。クリックで拡大、下の名前でそのページを開きます。
        別のシーンや人物で使うときは、使う側のストックの「作品全体から選ぶ」から選びます。
      </p>
      <div data-view-ok className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
          {(['all', 'node', 'character', 'place'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className="px-2.5 py-0.5 text-[12px] tabular-nums"
              style={kind === k ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
              data-tip={k === 'all' ? 'すべての種類を出す' : `${MEDIA_OWNER_LABEL[k]}のストックにあるものだけを出す`}
            >
              {k === 'all' ? 'すべて' : MEDIA_OWNER_LABEL[k]} {kindCount(k)}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
          {(
            [
              ['all', '画像と動画'],
              ['image', '画像'],
              ['video', '動画']
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              onClick={() => setFormat(value)}
              aria-pressed={format === value}
              className="px-2.5 py-0.5 text-[12px]"
              style={format === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
              data-tip={value === 'all' ? '画像と動画の両方を出す' : `${text}だけを出す`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="mb-2 text-[12px]" style={{ color: 'var(--danger-text)' }}>
          {error}
        </p>
      )}
      {entries === null ? (
        !error && (
          <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </p>
        )
      ) : shown.length === 0 ? (
        <div
          className="rounded-xl border border-dashed px-4 py-8 text-center text-[12px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
        >
          {files.length === 0
            ? 'まだ画像がありません。シーン・人物・場所で画像を生成して「決定」するか、手持ちのファイルを足すとここに出ます。'
            : 'この条件に合う画像はありません。'}
        </div>
      ) : (
        // 拡大と持ち主へのリンクは見るだけの操作なので、制作中のロックでも通す(削除は data-write-action で止める)
        <div data-view-ok className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {shown.map((f) => {
            const thumb = assetUrl(f.thumb_path ?? f.path)
            const isVideo = isVideoAsset(f.path)
            const [first, second, ...rest] = f.owners
            return (
              <div key={f.path} className="flex min-w-0 flex-col gap-1">
                <button
                  onClick={() => setZoom(f.path)}
                  className="relative w-full cursor-zoom-in overflow-hidden rounded-xl border"
                  style={{ aspectRatio: '4 / 3', background: 'var(--bg-canvas)', borderColor: 'var(--border-strong)' }}
                  data-tip={`クリックで拡大\n${f.owners.map(ownerText).join('\n')}`}
                  aria-label={`${ownerText(first)}の${isVideo ? '動画' : '画像'}を拡大する`}
                >
                  {thumb &&
                    (isVideoAsset(f.thumb_path ?? f.path) ? (
                      <video src={thumb} muted playsInline preload="metadata" className="h-full w-full object-contain" />
                    ) : (
                      <img src={thumb} draggable={false} loading="lazy" decoding="async" className="h-full w-full object-contain" />
                    ))}
                  {f.inUse && (
                    <span
                      className="absolute left-1.5 top-1.5 rounded px-1 text-[10px]"
                      style={{ background: 'rgba(28,31,43,0.85)', color: 'var(--text-dim)' }}
                    >
                      使用中
                    </span>
                  )}
                  {isVideo && (
                    <span
                      className="absolute bottom-1.5 right-1.5 rounded px-1 text-[10px]"
                      style={{ background: 'rgba(28,31,43,0.85)', color: 'var(--text-dim)' }}
                    >
                      動画
                    </span>
                  )}
                </button>
                <div className="flex min-w-0 items-start gap-1">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {[first, second].filter((o): o is MediaEntry => !!o).map((o) => (
                      <button
                        key={`${o.owner_type}:${o.owner_id}`}
                        onClick={() => openOwner(o)}
                        className="min-w-0 truncate rounded px-0.5 text-left text-[11px] hover:bg-[var(--accent-soft)]"
                        style={{ color: 'var(--text-dim)' }}
                        data-tip={o.owner_type === 'node' ? `フローチャートで「${o.owner_name || '(無題)'}」を開く` : `資料庫で「${o.owner_name || '(無題)'}」を開く`}
                      >
                        {ownerText(o)}
                        {o.selected ? '' : '(候補)'}
                      </button>
                    ))}
                    {rest.length > 0 && (
                      <span className="px-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }} data-tip={rest.map(ownerText).join('\n')}>
                        ほか {rest.length} か所
                      </span>
                    )}
                  </div>
                  <button
                    data-write-action
                    onClick={() => void removeFile(f)}
                    disabled={busy}
                    aria-label="この画像を削除"
                    className="delete-action inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border disabled:opacity-40"
                    data-tip={
                      f.inUse
                        ? '使用中の画像です。使っている所から外して、すべてのストックから削除します(確認が出ます)'
                        : 'すべてのストックから削除します(確認が出ます)'
                    }
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {zoom && assetUrl(zoom) && <Lightbox src={assetUrl(zoom)!} path={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}
