import { useEffect } from 'react'
import { isVideoAsset } from './api'

/** 画像 / 動画の拡大表示(ライトボックス)。
 *  オーバーレイのクリックか Esc で閉じる。中身はビューポートに収まる最大サイズ(等倍を超えない)。 */
export default function Lightbox({
  src,
  path,
  onClose
}: {
  src: string
  /** 動画かどうかの判定に使うアセットのパス */
  path: string
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={onClose}
      data-tip="クリックか Esc で閉じる"
    >
      {isVideoAsset(path) ? (
        <video
          src={src}
          autoPlay
          muted
          loop
          controls
          playsInline
          className="max-h-full max-w-full rounded-xl"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img src={src} draggable={false} className="max-h-full max-w-full rounded-xl object-contain" />
      )}
    </div>
  )
}
