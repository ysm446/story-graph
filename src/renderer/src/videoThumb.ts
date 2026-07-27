import { api, assetUrl, isVideoAsset, uploadAsset } from './api'
import type { StoryNode } from './types'

/** 動画挿絵のサムネイル生成。
 *
 * 構造モードのカードは静止画 1 枚あれば足りるのに、これまで動画ノードの数だけ
 * `<video>` を並べていた。モードを開くたびにデコードが走り、Chromium の同時
 * 動画要素数の上限にも当たる。そこで先頭付近のフレームを 1 枚切り出して
 * アセットとして保存し(`nodes.thumb_path`)、以降はそれを `<img>` で出す。
 *
 * 生成はここに集約する(カードの描画からは切り離す)。既存データは
 * 構造モードを開いたときに 1 件ずつ埋まる(遅延バックフィル)。
 */

const CAPTURE_SECONDS = 0.2 // 0 秒は真っ黒なことがあるので少し進める
const MAX_EDGE = 576 // カード幅 288 の 2 倍あれば足りる
const JPEG_QUALITY = 0.8
const LOAD_TIMEOUT_MS = 15000

// 生成できなかった動画(コーデック非対応など)を覚えて、開くたびの再試行を防ぐ
const failed = new Set<string>()
let running = false

function captureFrame(url: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'

    let settled = false
    const finish = (blob: Blob | null): void => {
      if (settled) return
      settled = true
      video.removeAttribute('src')
      video.load() // デコーダを確実に手放す
      resolve(blob)
    }
    const timer = window.setTimeout(() => finish(null), LOAD_TIMEOUT_MS)

    video.onloadeddata = () => {
      // 動画が短いときは先頭のまま切り出す
      video.currentTime = Math.min(CAPTURE_SECONDS, Math.max(0, (video.duration || 0) - 0.05))
    }
    video.onseeked = () => {
      window.clearTimeout(timer)
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return finish(null)
      const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return finish(null)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => finish(blob), 'image/jpeg', JPEG_QUALITY)
    }
    video.onerror = () => {
      window.clearTimeout(timer)
      finish(null)
    }
    video.src = url
  })
}

/** サムネイルが未生成の動画ノードを 1 件ずつ埋める。
 *  同時に走らせない(デコードを重ねない)。1 件でも作れたら true を返す。 */
export async function backfillVideoThumbs(nodes: StoryNode[]): Promise<boolean> {
  if (running) return false
  const targets = nodes.filter(
    (n) => isVideoAsset(n.image_path) && !n.thumb_path && !failed.has(n.id)
  )
  if (targets.length === 0) return false
  running = true
  let created = false
  try {
    for (const node of targets) {
      const url = assetUrl(node.image_path)
      if (!url) continue
      const blob = await captureFrame(url)
      if (!blob) {
        failed.add(node.id)
        continue
      }
      try {
        const file = new File([blob], 'thumb.jpg', { type: 'image/jpeg' })
        const { path } = await uploadAsset(file)
        await api.setNodeThumb(node.id, path)
        created = true
      } catch {
        failed.add(node.id) // 保存に失敗したら諦める(次回開いたときに再試行)
      }
    }
  } finally {
    running = false
  }
  return created
}
