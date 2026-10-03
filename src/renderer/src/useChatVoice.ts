import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isAbortError, ttsSpeak, voiceApi, type VoiceLine } from './api'
import { applyVoiceRate, scaledPause } from './voiceRate'

/** 再生中に数行先まで合成しておく(鑑賞モードの読み上げと同じ) */
const PREFETCH_AHEAD = 2
// 2 文目以降は、読める所がこの字数まで溜まってから送る。台本の地の文と同じく、1 回の合成に
// 複数の文をまとめて継ぎ目(= 声色が揺れる所)を減らす。最初の 1 文だけは溜めずにすぐ読み始める
const MERGE_CHARS = 80
const STORAGE_KEY = 'chatVoice'
// 括弧の中では切らない。（）はキャラとの会話のト書き(途中で切ると、閉じていない切れ端がト書きと
// 見分けられず、キャラの声で読まれてしまう)
const OPEN_QUOTES = '「『（'
const CLOSE_QUOTES = '」』）'
const SENTENCE_END = '。！？!?\n'
// 文末の直後にこれが続く間は切らない(「……!?」や「ね。」の閉じ括弧を割らない)
const TRAILING = '。！？!?」』）)'

export interface ChatVoiceContext {
  charId: string | null
  mode: 'interview' | 'roleplay' | null
}

/** ストリーミングで届く返答から、いま読んでよい所まで(文の切れ目)を切り出す位置。
 *  括弧の中とコードブロックの中では切らない。切れなければ 0 */
export function safeBoundary(text: string): number {
  let depth = 0
  let fence = false
  let boundary = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith('```', i)) {
      fence = !fence
      i += 2
      continue
    }
    if (fence) continue
    const ch = text[i]
    if (OPEN_QUOTES.includes(ch)) depth += 1
    else if (CLOSE_QUOTES.includes(ch) && depth > 0) {
      depth -= 1
      if (depth === 0 && i + 1 < text.length && !TRAILING.includes(text[i + 1])) boundary = i + 1
    } else if (depth === 0 && SENTENCE_END.includes(ch) && i + 1 < text.length && !TRAILING.includes(text[i + 1])) {
      boundary = i + 1
    }
  }
  return fence ? Math.min(boundary, text.lastIndexOf('```')) : boundary
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}

/** 返答の読み上げの列。文の塊を行に分けて(/tts/chat_lines)順に積み、先読みしながら 1 行ずつ鳴らす。
 *  stop で合成待ち・再生中・未処理の塊をまとめて捨てる(使い捨て。止めたら新しく作る) */
class SpeechQueue {
  private lines: VoiceLine[] = []
  private next = 0
  private synth = new Map<number, Promise<Blob | null>>()
  private running = false
  private chunks: Promise<void> = Promise.resolve()
  private pendingChunks = 0
  private audio: HTMLAudioElement | null = null
  private readonly controller = new AbortController()

  constructor(
    private readonly ctx: ChatVoiceContext,
    private readonly onActive: (active: boolean) => void,
    private readonly onError: (message: string) => void
  ) {}

  get stopped(): boolean {
    return this.controller.signal.aborted
  }

  addText(text: string): void {
    if (!text.trim() || this.stopped) return
    this.pendingChunks += 1
    this.onActive(true)
    // 塊の順番を保つため、行への分割も 1 つずつ順に行う
    this.chunks = this.chunks.then(async () => {
      try {
        const { lines } = await voiceApi.chatLines(text, this.ctx.charId, this.ctx.mode, this.controller.signal)
        if (this.stopped) return
        this.lines.push(...lines)
        this.kick()
      } catch (e) {
        if (!isAbortError(e)) this.fail(e)
      } finally {
        this.pendingChunks -= 1
        this.settle()
      }
    })
  }

  stop(): void {
    this.controller.abort()
    this.audio?.pause()
    this.audio = null
    this.onActive(false)
  }

  private fetchLine(i: number): Promise<Blob | null> {
    let p = this.synth.get(i)
    if (!p) {
      p = ttsSpeak(this.lines[i], this.controller.signal)
      p.catch(() => undefined) // 先読みの失敗は、その行を待つときに拾う
      this.synth.set(i, p)
    }
    return p
  }

  private kick(): void {
    if (this.running || this.stopped) return
    this.running = true
    void this.loop().finally(() => {
      this.running = false
      if (!this.stopped && this.next < this.lines.length) this.kick()
      else this.settle()
    })
  }

  private async loop(): Promise<void> {
    const { signal } = this.controller
    try {
      while (this.next < this.lines.length && !this.stopped) {
        const i = this.next
        const blob = await this.fetchLine(i)
        for (let a = 1; a <= PREFETCH_AHEAD && i + a < this.lines.length; a += 1) void this.fetchLine(i + a)
        this.synth.delete(i)
        if (blob) await this.play(blob, signal) // null = エンジンが鳴らせない効果音(間だけ置く)
        await sleep(scaledPause(Math.min(this.lines[i].pause_after_ms, 600)), signal)
        this.next += 1
      }
    } catch (e) {
      if (!isAbortError(e) && !this.stopped) this.fail(e)
    }
  }

  private play(blob: Blob, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      const release = applyVoiceRate(audio)
      this.audio = audio
      const done = (err?: unknown): void => {
        audio.pause()
        release()
        URL.revokeObjectURL(url)
        if (err) reject(err)
        else resolve()
      }
      audio.onended = () => done()
      audio.onerror = () => done(new Error('音声を再生できませんでした'))
      signal.addEventListener('abort', () => done(new DOMException('aborted', 'AbortError')))
      audio.play().catch((e) => done(e))
    })
  }

  private settle(): void {
    if (!this.running && this.pendingChunks === 0 && this.next >= this.lines.length) this.onActive(false)
  }

  private fail(e: unknown): void {
    this.stop()
    this.onError(String(e).replace(/^Error:\s*/, ''))
  }
}

/** 相談チャット / キャラとの会話の返答を声で読む(docs/design/voice.md §6.1)。
 *  オン・オフは localStorage に覚える。返答のストリーミング中は feed で差分を渡し、終わったら finish。
 *  過去の発言は speakText で読み直す。新しい読み上げを始めると前のものは止まる */
export function useChatVoice(ctx: ChatVoiceContext): {
  enabled: boolean
  setEnabled: (on: boolean) => void
  speaking: boolean
  error: string | null
  /** 新しい返答の読み上げを始める(前の読み上げは止める)。オフなら何もしない。
   *  override は発言ごとに声の主が替わる会話室用(その発言だけ別のキャラの声で読む) */
  begin: (override?: ChatVoiceContext) => void
  feed: (delta: string) => void
  finish: (fullText?: string) => void
  speakText: (text: string, override?: ChatVoiceContext) => void
  stop: () => void
} {
  const [enabled, setEnabledState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queueRef = useRef<SpeechQueue | null>(null)
  const bufferRef = useRef('')
  const fedRef = useRef(false) // この返答で差分を受け取ったか(受け取っていなければ finish で全文を読む)
  const sentFirstRef = useRef(false) // この返答の最初の塊を送ったか
  const ctxRef = useRef(ctx)
  useEffect(() => {
    ctxRef.current = ctx
  }, [ctx])

  const stop = useCallback((): void => {
    queueRef.current?.stop()
    queueRef.current = null
    bufferRef.current = ''
    setSpeaking(false)
  }, [])

  const start = useCallback((override?: ChatVoiceContext): SpeechQueue => {
    stop()
    setError(null)
    const queue = new SpeechQueue(
      { ...(override ?? ctxRef.current) },
      (active) => {
        if (queueRef.current === queue) setSpeaking(active)
      },
      (message) => setError(message)
    )
    queueRef.current = queue
    return queue
  }, [stop])

  const setEnabled = useCallback(
    (on: boolean): void => {
      setEnabledState(on)
      try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
      } catch {
        // 覚えられなくても、この画面の間はオンのまま使える
      }
      if (on) {
        // 最初の返事で TTS の起動(十数秒)を待たないよう、オンにした時点で起こしておく
        void api.ttsStart().catch(() => undefined)
      } else {
        stop()
      }
    },
    [stop]
  )

  // 会話の相手が変わる・画面を離れるときは止める
  useEffect(() => stop, [ctx.charId, ctx.mode, stop])

  const begin = useCallback(
    (override?: ChatVoiceContext): void => {
      fedRef.current = false
      sentFirstRef.current = false
      if (enabled) start(override)
      else stop()
    },
    [enabled, start, stop]
  )

  const feed = useCallback((delta: string): void => {
    fedRef.current = true
    const queue = queueRef.current
    if (!queue || queue.stopped) return
    bufferRef.current += delta
    const cut = safeBoundary(bufferRef.current)
    if (cut > 0 && (!sentFirstRef.current || cut >= MERGE_CHARS)) {
      sentFirstRef.current = true
      queue.addText(bufferRef.current.slice(0, cut))
      bufferRef.current = bufferRef.current.slice(cut)
    }
  }, [])

  const finish = useCallback((fullText?: string): void => {
    const queue = queueRef.current
    if (!queue || queue.stopped) return
    // 差分が来ずに全文だけ届いた返答(ツールを使った後の確定など)は全文を読む
    const rest = fedRef.current ? bufferRef.current : (fullText ?? '')
    bufferRef.current = ''
    queue.addText(rest)
  }, [])

  const speakText = useCallback(
    (text: string, override?: ChatVoiceContext): void => {
      start(override).addText(text)
    },
    [start]
  )

  return { enabled, setEnabled, speaking, error, begin, feed, finish, speakText, stop }
}
