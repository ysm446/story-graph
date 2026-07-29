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
  // ボタンの状態表示用の目印(useTaskFor)。単一シーンを対象にする処理だけが持つ
  kind?: string // 'extract' など処理の種類
  nodeId?: string // 対象シーン
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
  kind?: string
  nodeId?: string
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
        kind: spec.kind,
        nodeId: spec.nodeId,
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

/** 指定シーンに積まれている指定種類のタスク(無ければ null)。
 *
 * ボタンの「待機中…/処理中…」はローカル state ではなく**キューから引く**。
 * ローカルに持つと、シーンを切り替えたときに別のシーンのボタンが待機中になり、
 * ステータスバーから取り消しても表示が戻らない。
 */
export function useTaskFor(kind: string, nodeId: string | null | undefined): Task | null {
  const tasks = useTasks()
  if (!nodeId) return null
  return tasks.find((t) => t.kind === kind && t.nodeId === nodeId) ?? null
}

// ---- グラフ変更通知と busy ノード集合(モジュールレベル) -------------
// runner のクロージャは積んだ時点のコンポーネントの関数を握るため、モードを
// 離れて戻る(再マウント)と旧インスタンスの reload や setState に届いてしまう。
// 完了通知と busy 表示はここで持ち、マウント中のコンポーネントが購読する

const graphChangeListeners = new Set<() => void>()

/** グラフが変わったときの通知を購読する(戻り値で解除) */
export function subscribeGraphChanged(listener: () => void): () => void {
  graphChangeListeners.add(listener)
  return () => {
    graphChangeListeners.delete(listener)
  }
}

/** runner がグラフを変えたときに呼ぶ(購読側が reload する) */
export function notifyGraphChanged(): void {
  for (const listener of graphChangeListeners) listener()
}

// LLM 処理中のノード(枠が時計まわりに光る)。再マウントしても復元される
let busyNodeIds: ReadonlySet<string> = new Set<string>()
const busyListeners = new Set<() => void>()

export function setNodeBusy(nodeId: string | null, busy: boolean): void {
  if (!nodeId) return
  if (busy === busyNodeIds.has(nodeId)) return
  const next = new Set(busyNodeIds)
  if (busy) next.add(nodeId)
  else next.delete(nodeId)
  busyNodeIds = next
  for (const listener of busyListeners) listener()
}

export function useBusyNodeIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      busyListeners.add(listener)
      return () => busyListeners.delete(listener)
    },
    () => busyNodeIds,
    () => busyNodeIds
  )
}
