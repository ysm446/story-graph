import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isAbortError, ttsSpeak, type VoiceLine } from './api'
import type { SceneEntry } from './types'

/** 再生中に数行先まで合成しておく(サーバーは 1 件ずつ合成するので、積みすぎても速くならない) */
const PREFETCH_AHEAD = 2

export interface ReadAloudState {
  /** 読み上げ中のシーン(null = 止まっている) */
  nodeId: string | null
  title: string
  lineIndex: number
  lineCount: number
  /** 'synth' = 合成待ち(初回はサーバー起動・モデル取得を含む)/ 'play' = 再生中 */
  phase: 'synth' | 'play' | null
  paused: boolean
  error: string | null
}

const IDLE: ReadAloudState = {
  nodeId: null,
  title: '',
  lineIndex: 0,
  lineCount: 0,
  phase: null,
  paused: false,
  error: null
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError')
}

/** 一時停止の仕組み。再生中の音声を止め、行の合間では再開まで待つ */
class PauseGate {
  paused = false
  audio: HTMLAudioElement | null = null
  private waiters: Array<() => void> = []

  pause(): void {
    this.paused = true
    this.audio?.pause()
  }

  resume(): void {
    this.paused = false
    void this.audio?.play().catch(() => undefined)
    this.waiters.splice(0).forEach((w) => w())
  }

  wait(signal: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve)
      signal.addEventListener('abort', () => reject(abortError()))
    })
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(abortError())
    })
  })
}

function playBlob(blob: Blob, gate: PauseGate, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    gate.audio = audio
    const done = (err?: unknown): void => {
      audio.pause()
      gate.audio = null
      URL.revokeObjectURL(url)
      if (err) reject(err)
      else resolve()
    }
    audio.onended = () => done()
    audio.onerror = () => done(new Error('音声を再生できませんでした'))
    signal.addEventListener('abort', () => done(abortError()))
    // 合成を待っている間に一時停止されていたら、鳴らさずに再開を待つ(resume が play する)
    if (!gate.paused) audio.play().catch((e) => done(e))
  })
}

/** 鑑賞モードの読み上げ(docs/design/voice.md §6)。清書 → 朗読台本 → 1 行ずつ合成して順に再生する。
 *  LLM のタスクキュー(tasks.ts)には積まない(TTS は llama-server と別のプロセスなので、
 *  読み上げ中もビート生成などを止めない)。 */
export function useReadAloud(onSceneStart?: (nodeId: string) => void): {
  state: ReadAloudState
  /** fromIndex のシーンの fromLine 行目から、清書済みのシーンを順に読む */
  play: (scenes: SceneEntry[], fromIndex: number, fromLine?: number) => void
  stop: () => void
  pause: () => void
  resume: () => void
} {
  const [state, setState] = useState<ReadAloudState>(IDLE)
  const abortRef = useRef<AbortController | null>(null)
  const gateRef = useRef<PauseGate | null>(null)
  const onSceneStartRef = useRef(onSceneStart)
  useEffect(() => {
    onSceneStartRef.current = onSceneStart
  }, [onSceneStart])

  const stop = useCallback((): void => {
    abortRef.current?.abort()
    abortRef.current = null
    gateRef.current = null
    setState(IDLE)
  }, [])

  const pause = useCallback((): void => {
    gateRef.current?.pause()
    setState((s) => (s.nodeId ? { ...s, paused: true } : s))
  }, [])

  const resume = useCallback((): void => {
    gateRef.current?.resume()
    setState((s) => ({ ...s, paused: false }))
  }, [])

  // モードを離れたら止める
  useEffect(() => () => abortRef.current?.abort(), [])

  const play = useCallback((scenes: SceneEntry[], fromIndex: number, fromLine = 0): void => {
    abortRef.current?.abort()
    const controller = new AbortController()
    const gate = new PauseGate()
    abortRef.current = controller
    gateRef.current = gate
    const { signal } = controller

    const run = async (): Promise<void> => {
      for (let si = fromIndex; si < scenes.length; si += 1) {
        const scene = scenes[si]
        if (!scene.render) continue // 未清書のシーンは飛ばす
        const title = scene.node.title || '(無題)'
        const { lines } = await api.voiceScript(scene.render.id)
        if (signal.aborted) return
        const first = si === fromIndex ? Math.min(fromLine, lines.length) : 0
        if (first >= lines.length) continue
        onSceneStartRef.current?.(scene.node.id)

        const pending = new Map<number, Promise<Blob>>()
        const fetchLine = (i: number): Promise<Blob> => {
          let p = pending.get(i)
          if (!p) {
            p = ttsSpeak(lines[i] as VoiceLine, signal)
            p.catch(() => undefined) // 先読みの失敗は、その行を待つときに拾う
            pending.set(i, p)
          }
          return p
        }

        for (let li = first; li < lines.length; li += 1) {
          setState((s) => ({ ...s, nodeId: scene.node.id, title, lineIndex: li, lineCount: lines.length, phase: 'synth', error: null }))
          const blob = await fetchLine(li)
          for (let ahead = 1; ahead <= PREFETCH_AHEAD && li + ahead < lines.length; ahead += 1) void fetchLine(li + ahead)
          pending.delete(li)
          if (signal.aborted) return
          setState((s) => ({ ...s, phase: 'play' }))
          await playBlob(blob, gate, signal)
          await sleep(lines[li].pause_after_ms, signal)
          await gate.wait(signal)
        }
      }
    }

    setState({ ...IDLE, nodeId: scenes[fromIndex]?.node.id ?? null, title: scenes[fromIndex]?.node.title || '(無題)', phase: 'synth' })
    void run()
      .then(() => {
        if (abortRef.current === controller) {
          abortRef.current = null
          gateRef.current = null
          setState(IDLE)
        }
      })
      .catch((e) => {
        if (isAbortError(e) || signal.aborted) return
        abortRef.current = null
        gateRef.current = null
        setState({ ...IDLE, error: String(e).replace(/^Error:\s*/, '') })
      })
  }, [])

  return { state, play, stop, pause, resume }
}
