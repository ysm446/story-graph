import { applyVoiceRate } from './voiceRate'

/** 鑑賞モードの読み上げ(useReadAloud)と返答の読み上げ(useChatVoice)が共有する再生の部品 */

export function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError')
}

/** signal の abort で fn を 1 回呼ぶ。返り値で登録を外す(同じ signal を長く使い回すとリスナーが溜まるため) */
export function onAbort(signal: AbortSignal, fn: () => void): () => void {
  signal.addEventListener('abort', fn, { once: true })
  return () => signal.removeEventListener('abort', fn)
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const off = onAbort(signal, () => {
      clearTimeout(timer)
      reject(abortError())
    })
    const timer = setTimeout(() => {
      off()
      resolve()
    }, ms)
  })
}

/** 再生中の音声の置き場。paused なら鳴らさずに待つ(再開する側が audio.play() する) */
export interface PlaybackSlot {
  audio: HTMLAudioElement | null
  paused?: boolean
}

/** blob を 1 回鳴らし終えるまで待つ。読み上げの速さ(voiceRate)を反映する */
export function playBlob(blob: Blob, signal: AbortSignal, slot: PlaybackSlot): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    const release = applyVoiceRate(audio)
    slot.audio = audio
    let finished = false
    const done = (err?: unknown): void => {
      if (finished) return
      finished = true
      off()
      audio.pause()
      release()
      if (slot.audio === audio) slot.audio = null
      URL.revokeObjectURL(url)
      if (err) reject(err)
      else resolve()
    }
    const off = onAbort(signal, () => done(abortError()))
    audio.onended = () => done()
    audio.onerror = () => done(new Error('音声を再生できませんでした'))
    if (!slot.paused) audio.play().catch((e) => done(e))
  })
}
