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
  /** いま読んでいる行が清書の本文のどこにあたるか [開始, 終了)。強調とページ送りに使う */
  span: [number, number] | null
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
  span: null,
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

/** 飛び先。line = -1 は「そのシーンの最後の行」(前のシーンへ戻るとき) */
interface Cursor {
  scene: number
  line: number
}

/** 鑑賞モードの読み上げ(docs/design/voice.md §6)。清書 → 朗読台本 → 1 行ずつ合成して順に再生する。
 *  前へ / 次へで行を飛べる(シーンの境目もまたぐ)。LLM のタスクキュー(tasks.ts)には積まない
 *  (TTS は llama-server と別のプロセスなので、読み上げ中もビート生成などを止めない)。 */
export function useReadAloud(onSceneStart?: (nodeId: string) => void): {
  state: ReadAloudState
  /** fromIndex のシーンの fromLine 行目から、清書済みのシーンを順に読む */
  play: (scenes: SceneEntry[], fromIndex: number, fromLine?: number) => void
  stop: () => void
  pause: () => void
  resume: () => void
  /** 次の行へ(いまの行を途中で打ち切る) */
  next: () => void
  /** 前の行へ(シーンの頭なら前のシーンの最後の行) */
  prev: () => void
} {
  const [state, setState] = useState<ReadAloudState>(IDLE)
  const abortRef = useRef<AbortController | null>(null)
  const gateRef = useRef<PauseGate | null>(null)
  // いま読んでいる位置と、前へ / 次へで決まった飛び先。飛ぶときは行ごとの中断で今の行を打ち切る
  const cursorRef = useRef<Cursor>({ scene: 0, line: 0 })
  const seekRef = useRef<Cursor | null>(null)
  const lineAbortRef = useRef<AbortController | null>(null)
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

  const seek = useCallback((target: Cursor): void => {
    if (!abortRef.current) return
    seekRef.current = target
    lineAbortRef.current?.abort()
  }, [])

  const next = useCallback((): void => {
    const { scene, line } = cursorRef.current
    seek({ scene, line: line + 1 })
  }, [seek])

  const prev = useCallback((): void => {
    const { scene, line } = cursorRef.current
    seek(line > 0 ? { scene, line: line - 1 } : { scene: scene - 1, line: -1 })
  }, [seek])

  // モードを離れたら止める
  useEffect(() => () => abortRef.current?.abort(), [])

  const play = useCallback((scenes: SceneEntry[], fromIndex: number, fromLine = 0): void => {
    abortRef.current?.abort()
    const controller = new AbortController()
    const gate = new PauseGate()
    abortRef.current = controller
    gateRef.current = gate
    seekRef.current = null
    const { signal } = controller
    // シーンごとの台本と、行ごとの合成(先読み)の覚え
    const scripts = new Map<number, Promise<VoiceLine[]>>()
    const synth = new Map<string, Promise<Blob | null>>()

    const scriptOf = (si: number): Promise<VoiceLine[]> => {
      let p = scripts.get(si)
      if (!p) {
        const render = scenes[si]?.render
        p = render ? api.voiceScript(render.id).then((s) => s.lines) : Promise.resolve([])
        scripts.set(si, p)
      }
      return p
    }
    const fetchLine = (si: number, lines: VoiceLine[], li: number): Promise<Blob | null> => {
      const key = `${si}:${li}`
      let p = synth.get(key)
      if (!p) {
        p = ttsSpeak(lines[li], signal)
        p.catch(() => undefined) // 先読みの失敗は、その行を待つときに拾う
        synth.set(key, p)
      }
      return p
    }

    const run = async (): Promise<void> => {
      let si = fromIndex
      let li = fromLine
      let lastScene = -1
      while (si < scenes.length) {
        if (signal.aborted) return
        if (si < 0) {
          // 先頭より前へは戻らない(最初の行を読み直す)
          si = 0
          li = 0
        }
        const lines = await scriptOf(si)
        if (signal.aborted) return
        // 未清書・読む行の無いシーンは、進む向きに飛ばす(前へ戻る途中なら更に前へ)
        if (li === -1) {
          if (lines.length === 0) {
            si -= 1
            continue
          }
          li = lines.length - 1
        }
        if (li >= lines.length) {
          si += 1
          li = 0
          continue
        }
        const scene = scenes[si]
        if (si !== lastScene) {
          lastScene = si
          onSceneStartRef.current?.(scene.node.id)
        }
        cursorRef.current = { scene: si, line: li }
        const line = lines[li]
        setState((s) => ({
          ...s,
          nodeId: scene.node.id,
          title: scene.node.title || '(無題)',
          lineIndex: li,
          lineCount: lines.length,
          span: line.span ?? null,
          phase: 'synth',
          error: null
        }))

        const lineAbort = new AbortController()
        lineAbortRef.current = lineAbort
        const onStop = (): void => lineAbort.abort()
        signal.addEventListener('abort', onStop)
        try {
          const blob = await Promise.race([
            fetchLine(si, lines, li),
            new Promise<never>((_, reject) => lineAbort.signal.addEventListener('abort', () => reject(abortError())))
          ])
          for (let a = 1; a <= PREFETCH_AHEAD && li + a < lines.length; a += 1) void fetchLine(si, lines, li + a)
          setState((s) => ({ ...s, phase: 'play' }))
          if (blob) await playBlob(blob, gate, lineAbort.signal) // null = エンジンが鳴らせない効果音(間だけ置く)
          await sleep(line.pause_after_ms, lineAbort.signal)
          await gate.wait(lineAbort.signal)
        } catch (e) {
          if (signal.aborted) return
          if (!(isAbortError(e) && seekRef.current)) throw e
        } finally {
          signal.removeEventListener('abort', onStop)
        }

        const target = seekRef.current
        seekRef.current = null
        if (target) {
          si = target.scene
          li = target.line
        } else {
          li += 1
        }
      }
    }

    setState({
      ...IDLE,
      nodeId: scenes[fromIndex]?.node.id ?? null,
      title: scenes[fromIndex]?.node.title || '(無題)',
      phase: 'synth'
    })
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

  return { state, play, stop, pause, resume, next, prev }
}
