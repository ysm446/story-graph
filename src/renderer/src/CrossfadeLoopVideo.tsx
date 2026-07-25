import { useEffect, useRef } from 'react'

/** 動画ループのクロスディゾルブ秒数のデフォルト(設定 video_crossfade_seconds で変更可能) */
export const DEFAULT_VIDEO_CROSSFADE_SECONDS = 0.5

/**
 * ループの継ぎ目をクロスディゾルブで繋ぐ動画プレイヤー(story-flow から移植)。
 * 同じ動画を 2 枚重ね、終端 fadeSeconds 手前でもう 1 枚を頭から再生開始する。
 *
 * 暗転対策: 2 枚を同時にフェード(1→0 と 0→1)すると中間点で合成不透明度が
 * 1 を下回り背景の黒が透ける(0.5 + 0.5×0.5 = 0.75)。そのため
 * 「下の動画は不透明のまま残し、上に重ねた新しい動画だけをフェードイン」する。
 * フェードの 2 倍より短い動画は通常ループにフォールバック。
 *
 * レイアウトは 2 通り:
 * - fill=false(既定): 1 枚目を通常フローに置いて自然サイズで箱を決め、2 枚目を
 *   その箱に重ねる。scroll / split モードのように内容サイズで表示する場所向け。
 * - fill=true: 親要素いっぱいに広げて object-contain で収める。ページモードの
 *   挿絵領域(高さ 42% 固定)のように領域が先に決まっている場所向け。
 */
export function CrossfadeLoopVideo({
  src,
  fadeSeconds,
  fill = false,
  className = '',
  videoClassName = ''
}: {
  src: string
  fadeSeconds: number
  fill?: boolean
  className?: string
  videoClassName?: string
}): React.JSX.Element {
  const videoARef = useRef<HTMLVideoElement | null>(null)
  const videoBRef = useRef<HTMLVideoElement | null>(null)
  const activeIndex = useRef(0)
  const switching = useRef(false)

  const crossfadeEnabled = fadeSeconds > 0.05
  const refOf = (index: number): React.RefObject<HTMLVideoElement | null> =>
    index === 0 ? videoARef : videoBRef

  useEffect(() => {
    activeIndex.current = 0
    switching.current = false
    const first = videoARef.current
    const second = videoBRef.current
    if (first) {
      first.style.transition = 'none'
      first.style.opacity = '1'
      first.style.zIndex = '2'
      first.currentTime = 0
      void first.play().catch(() => undefined)
    }
    if (second) {
      second.style.transition = 'none'
      second.style.opacity = '0'
      second.style.zIndex = '1'
      second.pause()
    }
  }, [src, crossfadeEnabled])

  const handleTimeUpdate = (index: number): void => {
    if (index !== activeIndex.current || switching.current) return
    const current = refOf(index).current
    const next = refOf(1 - index).current
    if (!current || !next) return

    const { duration, currentTime } = current
    if (!Number.isFinite(duration) || duration <= fadeSeconds * 2) return // 短尺は onEnded の通常ループ
    // timeupdate の発火間隔(〜250ms)で取りこぼさないよう少し余裕を持って開始する
    if (duration - currentTime > fadeSeconds + 0.3) return

    switching.current = true
    activeIndex.current = 1 - index

    // 旧側: 不透明のまま下に残す(フェードさせない = 黒が透けない)
    current.style.transition = 'none'
    current.style.zIndex = '1'
    current.style.opacity = '1'

    // 新側: 上に重ねて透明から不透明へフェードイン
    next.style.transition = 'none'
    next.style.opacity = '0'
    next.style.zIndex = '2'
    next.currentTime = 0
    void next.play().catch(() => undefined)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        next.style.transition = `opacity ${fadeSeconds}s linear`
        next.style.opacity = '1'
      })
    })

    // フェード完了後に旧側を止める
    window.setTimeout(() => {
      current.pause()
      switching.current = false
    }, fadeSeconds * 1000 + 150)
  }

  const handleEnded = (index: number): void => {
    // クロスディゾルブ対象外(短尺)の動画はここで頭出しループ
    if (index !== activeIndex.current) return
    const video = refOf(index).current
    if (!video) return
    video.currentTime = 0
    void video.play().catch(() => undefined)
  }

  const fillVideoClass = `absolute inset-0 h-full w-full object-contain ${videoClassName}`

  if (!crossfadeEnabled) {
    // クロスディゾルブ無効(0秒)は素のループ再生
    return (
      <div className={`${fill ? 'relative h-full w-full' : 'relative max-w-full'} ${className}`}>
        <video
          key={src}
          src={src}
          autoPlay
          muted
          loop
          playsInline
          className={fill ? fillVideoClass : `block max-w-full ${videoClassName}`}
        />
      </div>
    )
  }

  // isolate: 動画の z-index をこのコンテナ内に閉じ込める(本文・コントロールより上に出さない)
  return (
    <div className={`isolate relative ${fill ? 'h-full w-full' : 'max-w-full'} ${className}`}>
      {[0, 1].map((index) => (
        <video
          key={index}
          ref={refOf(index)}
          src={src}
          muted
          playsInline
          preload="auto"
          onTimeUpdate={() => handleTimeUpdate(index)}
          onEnded={() => handleEnded(index)}
          className={
            fill
              ? fillVideoClass
              : index === 0
                ? `relative block max-w-full ${videoClassName}` // フローに残してサイズの基準にする
                : `absolute inset-0 h-full w-full ${videoClassName}`
          }
          style={index === 0 ? { opacity: 1, zIndex: 2 } : { opacity: 0, zIndex: 1 }}
        />
      ))}
    </div>
  )
}
