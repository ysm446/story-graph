import { useCallback, useEffect, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'

const OUTPUT_SIZE = 512

export interface CropState {
  crop: { x: number; y: number }
  zoom: number
}

async function cropToBlob(imageUrl: string, area: Area): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    if (imageUrl.startsWith('http')) img.crossOrigin = 'anonymous' // canvas 汚染防止
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = imageUrl
  })
  const canvas = document.createElement('canvas')
  const size = Math.min(OUTPUT_SIZE, Math.max(64, Math.round(area.width)))
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, size, size)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('crop failed'))), 'image/png')
  })
}

export default function ImageCropModal({
  source,
  title,
  initial,
  onCancel,
  onCropped
}: {
  /** File(新規選択)または画像 URL(保存済み元画像の再クロップ) */
  source: File | string
  title: string
  initial?: CropState | null
  onCancel: () => void
  onCropped: (blob: Blob, state: CropState) => void
}): React.JSX.Element {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [crop, setCrop] = useState(initial?.crop ?? { x: 0, y: 0 })
  const [zoom, setZoom] = useState(initial?.zoom ?? 1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof source === 'string') {
      setImageUrl(source)
      return
    }
    const url = URL.createObjectURL(source)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [source])

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedArea(areaPixels)
  }, [])

  const handleConfirm = async (): Promise<void> => {
    if (!imageUrl || !croppedArea || busy) return
    setBusy(true)
    setError(null)
    try {
      const blob = await cropToBlob(imageUrl, croppedArea)
      onCropped(blob, { crop, zoom })
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onCancel}
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-2xl border p-4"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          {title}
        </h3>
        <div className="relative h-[340px] w-full overflow-hidden rounded-xl" style={{ background: 'var(--bg-canvas)' }}>
          {imageUrl && (
            <Cropper
              image={imageUrl}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
            />
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            Zoom
          </span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="settings-slider active min-w-0 flex-1"
          />
        </div>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          ドラッグで位置調整 / ホイールまたはスライダーで拡大縮小。元画像は保持され、後から切り抜き直せます。
        </p>
        {error && (
          <p className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            キャンセル
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={busy}
            className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {busy ? '処理中…' : 'この範囲で設定'}
          </button>
        </div>
      </div>
    </div>
  )
}
