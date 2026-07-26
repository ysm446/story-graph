import { useSyncExternalStore } from 'react'

/** LLM を使う長い処理のキュー(アプリ全体で 1 本)。
 *
 * - llama-server は 1 リクエストずつしか処理しないので、**同時に走らせない**。
 *   積んだ順に 1 件ずつ実行する
 * - モードを切り替えるとページのコンポーネントは破棄されるが、キューは残るので
 *   進捗と中止はステータスバーから常に手が届く
 * - 待機中の処理は取り消せる(実行中は AbortSignal で中止)
 */
export interface Task {
  id: string
  label: string // 「清書」「イベント作り直し」など短い名前
  detail?: string // いま処理しているシーン名など
  done?: number // 進捗(件数)。total と併せて N/M 表示に使う
  total?: number
  status: 'pending' | 'running'
  enqueuedAt: number
  startedAt?: number
}

export type TaskPatch = Partial<Pick<Task, 'detail' | 'done' | 'total'>>

/** 実処理。update で進捗を伝え、signal で中止を受ける */
export type TaskRunner = (ctx: { update: (patch: TaskPatch) => void; signal: AbortSignal }) => Promise<void>

interface Entry {
  task: Task
  runner: TaskRunner
  controller: AbortController
}

let entries: Entry[] = []
const listeners = new Set<() => void>()
let snapshot: Task[] = []
let seq = 0

function publish(): void {
  snapshot = entries.map((e) => e.task)
  for (const listener of listeners) listener()
}

function patchTask(id: string, patch: Partial<Task>): void {
  entries = entries.map((e) => (e.task.id === id ? { ...e, task: { ...e.task, ...patch } } : e))
  publish()
}

async function pump(): Promise<void> {
  if (entries.some((e) => e.task.status === 'running')) return
  const next = entries.find((e) => e.task.status === 'pending')
  if (!next) return
  patchTask(next.task.id, { status: 'running', startedAt: Date.now() })
  try {
    await next.runner({
      update: (patch) => patchTask(next.task.id, patch),
      signal: next.controller.signal
    })
  } catch {
    // 個々の失敗は呼び出し側で扱う(キューは止めない)
  } finally {
    entries = entries.filter((e) => e.task.id !== next.task.id)
    publish()
    void pump()
  }
}

/** 処理をキューに積む。戻り値はタスク ID */
export function enqueueTask(spec: {
  label: string
  detail?: string
  total?: number
  runner: TaskRunner
}): string {
  const id = `task-${++seq}`
  entries = [
    ...entries,
    {
      task: {
        id,
        label: spec.label,
        detail: spec.detail,
        total: spec.total,
        status: 'pending',
        enqueuedAt: Date.now()
      },
      runner: spec.runner,
      controller: new AbortController()
    }
  ]
  publish()
  // 実行は必ず次のマイクロタスクから。同期で走らせると、呼び出し側が
  // enqueueTask の戻り値(タスク ID)を受け取る前に runner が動いてしまう
  queueMicrotask(() => void pump())
  return id
}

/** 実行中なら中止、待機中ならキューから取り除く */
export function cancelTask(id: string): void {
  const entry = entries.find((e) => e.task.id === id)
  if (!entry) return
  if (entry.task.status === 'running') {
    entry.controller.abort()
    return
  }
  entries = entries.filter((e) => e.task.id !== id)
  publish()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTasks(): Task[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  )
}
