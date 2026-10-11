import { api, assetUrl, isVideoAsset, uploadAsset } from './api'
import type { StoryNode } from './types'

/** 挿絵のサムネイル生成(動画・静止画の両方)。
 *
 * 構造モードのカードは高さ 160px の静止画 1 枚あれば足りる。
 * - 動画: これまで動画ノードの数だけ `<video>` を並べていた。モードを開くたびにデコードが
 *   走り、Chromium の同時動画要素数の上限にも当たる。先頭付近のフレームを 1 枚切り出す
 * - 静止画: 生成画像は 1200px 前後・1〜2MB の PNG で、100 枚を原寸のまま `<img>` に
 *   並べるとデコード済みの画像だけで数百 MB になり、パン・ズームの描画も重くなる。
 *   縮小版(長辺 576px の WebP)を作る。もとから小さい画像は原画をそのまま使う
 *
 * どちらもアセットとして保存して `nodes.thumb_path` に載せ、カードはそれを `<img>` で出す。
 * 生成はここに集約する(カードの描画からは切り離す)。既存データは
 * 構造モードを開いたときに 1 件ずつ埋まる(遅延バックフィル)。
 */

const CAPTURE_SECONDS = 0.2 // 0 秒は真っ黒なことがあるので少し進める
const MAX_EDGE = 576 // カード幅 288 の 2 倍あれば足りる
const JPEG_QUALITY = 0.8
const WEBP_QUALITY = 0.82
const LOAD_TIMEOUT_MS = 15000

// 生成できなかった挿絵(コーデック非対応など)を覚えて、開くたびの再試行を防ぐ。
// キーは id + パス(挿絵を差し替えたら再試行できるように)
const failed = new Set<string>()
let running = false

function failKey(node: StoryNode): string {
  return `${node.id}:${node.image_path ?? ''}`
}

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

/** 静止画の縮小版。`'original'` = 長辺が MAX_EDGE 以下で縮小が要らない。null = 読めなかった */
function shrinkImage(url: string): Promise<Blob | 'original' | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    let settled = false
    const finish = (result: Blob | 'original' | null): void => {
      if (settled) return
      settled = true
      img.src = ''
      resolve(result)
    }
    const timer = window.setTimeout(() => finish(null), LOAD_TIMEOUT_MS)
    img.onload = () => {
      window.clearTimeout(timer)
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h) return finish(null)
      if (Math.max(w, h) <= MAX_EDGE) return finish('original')
      const scale = MAX_EDGE / Math.max(w, h)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return finish(null)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      // 透過を保てるので WebP(JPEG だと透過部分が黒く潰れる)
      canvas.toBlob((blob) => finish(blob), 'image/webp', WEBP_QUALITY)
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      finish(null)
    }
    img.src = url
  })
}

/** サムネイルが未生成の挿絵付きノードを 1 件ずつ埋める。
 *  同時に走らせない(デコードを重ねない)。1 件でも作れたら true を返す。 */
export async function backfillThumbs(nodes: StoryNode[]): Promise<boolean> {
  if (running) return false
  const targets = nodes.filter((n) => !!n.image_path && !n.thumb_path && !failed.has(failKey(n)))
  if (targets.length === 0) return false
  running = true
  let created = false
  try {
    for (const node of targets) {
      const url = assetUrl(node.image_path)
      if (!url) continue
      const isVideo = isVideoAsset(node.image_path)
      const result = isVideo ? await captureFrame(url) : await shrinkImage(url)
      if (!result) {
        failed.add(failKey(node))
        continue
      }
      try {
        if (result === 'original') {
          // 縮小が要らない画像は原画をサムネイルとして登録する(次回から対象外になる)
          await api.setNodeThumb(node.id, node.image_path)
        } else {
          const file = isVideo
            ? new File([result], 'thumb.jpg', { type: 'image/jpeg' })
            : new File([result], 'thumb.webp', { type: 'image/webp' })
          const { path } = await uploadAsset(file)
          await api.setNodeThumb(node.id, path)
        }
        created = true
      } catch {
        failed.add(failKey(node)) // 保存に失敗したら諦める(次回開いたときに再試行)
      }
    }
  } finally {
    running = false
  }
  return created
}
