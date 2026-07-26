import { useSyncExternalStore } from 'react'

/** アプリ全体で走っている長い処理(生成・抽出・清書など)の一覧。
 *
 * モードを切り替えるとページのコンポーネントは破棄されるが、処理そのものは
 * 続いている。進捗をここに集約してステータスバーに出すことで、どのページに
 * いても「何が動いているか」と「中止」に手が届くようにする。
 */
export interface Task {
  id: string
  label: string // 「清書」「イベント作り直し」など短い名前
  detail?: string // いま処理しているシーン名など
  done?: number // 進捗(件数)。total と併せて N/M 表示に使う
  total?: number
  abort?: () => void // 中止できる処理だけ渡す
  startedAt: number
}

let tasks: Task[] = []
const listeners = new Set<() => void>()
let seq = 0

function emit(): void {
  for (const listener of listeners) listener()
}

export function startTask(task: Omit<Task, 'id' | 'startedAt'> & { id?: string }): string {
  const id = task.id ?? `task-${++seq}`
  tasks = [...tasks.filter((t) => t.id !== id), { ...task, id, startedAt: Date.now() }]
  emit()
  return id
}

export function updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'startedAt'>>): void {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
  emit()
}

export function endTask(id: string): void {
  const next = tasks.filter((t) => t.id !== id)
  if (next.length === tasks.length) return
  tasks = next
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTasks(): Task[] {
  return useSyncExternalStore(
    subscribe,
    () => tasks,
    () => tasks
  )
}
