import { useSyncExternalStore } from 'react'
import { api, isAbortError, renderStream, errorText } from './api'
import { enqueueTask, notifyGraphChanged, setNodeBusy, type Task } from './tasks'

/** まとめて更新の実行の本体(docs/design/bulk-update.md)。
 *
 *  古くなった章のまとめ → 清書 → 台本(話者と感情)の順に、1 件ずつ作り直す。人が席にいない間に走るので、
 *  - 始める前に状態を保存する(保存できなければ始めない)
 *  - 1 件失敗しても次へ進む(続けて失敗したら、サーバーが落ちていると見て止める)
 *  - 終わったら結果を残す(戻ってきたときに読めるように、閉じるまで出したままにする)
 *
 *  ダイアログを閉じても、モードを切り替えても続くよう、状態はコンポーネントではなくここに持つ
 *  (tasks.ts と同じ考え方)。
 */

export interface BulkUpdateOptions {
  digests: boolean
  rendersStale: boolean
  rendersMissing: boolean
  scriptsStale: boolean
  scriptsMissing: boolean
  includeBranches: boolean
  releaseModel: boolean
}

export interface BulkUpdateFailure {
  kind: 'digest' | 'render' | 'script'
  title: string
  error: string
}

export interface BulkUpdateResult {
  startedAt: number
  finishedAt: number
  /** 選ばなかった項目は null(結果に行を出さない) */
  digests: { done: number; failed: number } | null
  renders: { done: number; failed: number } | null
  /** 台本を足す前の版が残した結果には無い */
  scripts?: { done: number; failed: number } | null
  failures: BulkUpdateFailure[]
  /** 最後まで行かなかった理由。null = 最後まで終わった */
  stopped: 'cancelled' | 'failures' | 'error' | null
  stopReason: string | null
  /** 終わったあとにモデルを解放したか */
  released: boolean
}

export const BULK_UPDATE_KIND = 'bulk-update'
export const isBulkUpdateTask = (task: Task): boolean => task.kind === BULK_UPDATE_KIND

/** 続けてこの件数だけ失敗したら止める(サーバーが落ちたまま、残りを全部失敗させない) */
const MAX_CONSECUTIVE_FAILURES = 3

const OPTIONS_KEY = 'bulkUpdateOptions'
const RESULT_KEY = 'bulkUpdateLastResult'

const DEFAULT_OPTIONS: BulkUpdateOptions = {
  digests: true,
  rendersStale: true,
  rendersMissing: true,
  // 清書を作り直したシーンの台本に付け直すのは既定でオン。まだ付けていないシーンは、読み上げを使うかどうかで
  // 要るかが分かれる(件数も多くなりがち)ので既定でオフ
  scriptsStale: true,
  scriptsMissing: false,
  includeBranches: false,
  releaseModel: true
}

export function loadBulkUpdateOptions(): BulkUpdateOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<BulkUpdateOptions>
    const merged = { ...DEFAULT_OPTIONS }
    for (const key of Object.keys(DEFAULT_OPTIONS) as Array<keyof BulkUpdateOptions>) {
      if (typeof saved[key] === 'boolean') merged[key] = saved[key]
    }
    return merged
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

export function saveBulkUpdateOptions(options: BulkUpdateOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options))
  } catch {
    // 覚えられなくても実行には関わらない
  }
}

// ---- 画面の状態(選ぶダイアログ / 結果のダイアログ) -------------------

type View = 'closed' | 'choose' | 'result'

interface UiState {
  view: View
  /** 結果のダイアログに出しているもの */
  result: BulkUpdateResult | null
  /** 最後に終わった実行の結果(次に開いたとき「前回の結果」として見られる) */
  last: BulkUpdateResult | null
}

const loadLast = (): BulkUpdateResult | null => {
  try {
    const raw = localStorage.getItem(RESULT_KEY)
    return raw ? (JSON.parse(raw) as BulkUpdateResult) : null
  } catch {
    return null
  }
}

let ui: UiState = { view: 'closed', result: null, last: loadLast() }
const listeners = new Set<() => void>()

function setUi(patch: Partial<UiState>): void {
  ui = { ...ui, ...patch }
  for (const listener of listeners) listener()
}

export function useBulkUpdateUi(): UiState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => ui
  )
}

export const openBulkUpdate = (): void => setUi({ view: 'choose' })
export const closeBulkUpdate = (): void => setUi({ view: 'closed', result: null })
export const showLastBulkUpdateResult = (): void => {
  if (ui.last) setUi({ view: 'result', result: ui.last })
}

function finish(result: BulkUpdateResult): void {
  try {
    localStorage.setItem(RESULT_KEY, JSON.stringify(result))
  } catch {
    // 残せなくても、いまの結果はこのまま出す
  }
  setUi({ view: 'result', result, last: result })
}

// ---- 実行 -------------------------------------------------------------


/** まとめて更新をキューに積む。対象は、各段の直前に数え直して決める
 *  (まとめを作り直すと、その先の清書が要更新になり、清書を作り直すと台本が付け直しになるため) */
export function startBulkUpdate(options: BulkUpdateOptions): void {
  const wantsRenders = options.rendersStale || options.rendersMissing
  const wantsScripts = options.scriptsStale || options.scriptsMissing
  enqueueTask({
    label: 'まとめて更新',
    detail: '準備中',
    kind: BULK_UPDATE_KIND,
    runner: async ({ update, signal }) => {
      const result: BulkUpdateResult = {
        startedAt: Date.now(),
        finishedAt: 0,
        digests: options.digests ? { done: 0, failed: 0 } : null,
        renders: wantsRenders ? { done: 0, failed: 0 } : null,
        scripts: wantsScripts ? { done: 0, failed: 0 } : null,
        failures: [],
        stopped: null,
        stopReason: null,
        released: false
      }
      let consecutive = 0
      // 1 件の結果を記録する。false を返したら、これ以上続けない
      const record = (kind: BulkUpdateFailure['kind'], title: string, error: string | null): boolean => {
        const counter =
          kind === 'digest' ? result.digests! : kind === 'render' ? result.renders! : result.scripts!
        if (error === null) {
          counter.done += 1
          consecutive = 0
          return true
        }
        counter.failed += 1
        result.failures.push({ kind, title, error })
        consecutive += 1
        if (consecutive < MAX_CONSECUTIVE_FAILURES) return true
        result.stopped = 'failures'
        result.stopReason = `${MAX_CONSECUTIVE_FAILURES} 件続けて失敗したので止めました(llama-server が止まっている可能性があります)`
        return false
      }
      const cancelled = (): boolean => {
        if (!signal.aborted) return false
        result.stopped = 'cancelled'
        return true
      }

      void window.storyGraph.setSleepBlocked(true).catch(() => false)
      try {
        // 始める前の状態を保存する。保存できなければ何も書き替えない
        await api.bulkUpdateStart()

        if (options.digests && !cancelled()) {
          const plan = await api.bulkUpdatePlan(options.includeBranches)
          for (const [index, chapter] of plan.digests.entries()) {
            if (cancelled()) break
            update({ done: index + 1, total: plan.digests.length, detail: `章のまとめ: ${chapter.title}` })
            let error: string | null = null
            try {
              await api.bulkUpdateDigest(chapter.id, signal)
            } catch (e) {
              if (isAbortError(e)) {
                result.stopped = 'cancelled'
                break
              }
              error = errorText(e)
            }
            notifyGraphChanged()
            if (!record('digest', chapter.title, error)) break
          }
        }

        if (wantsRenders && result.stopped === null && !cancelled()) {
          // まとめの更新で要更新になった清書も拾うため、ここで数え直す
          const plan = await api.bulkUpdatePlan(options.includeBranches)
          const scenes = plan.renders.filter((r) =>
            r.status === 'stale' ? options.rendersStale : options.rendersMissing
          )
          for (const [index, scene] of scenes.entries()) {
            if (cancelled() || !plan.preset) break
            update({ done: index + 1, total: scenes.length, detail: `清書: ${scene.title}` })
            setNodeBusy(scene.id, true)
            let saved = false
            let error: string | null = null
            try {
              // 1 シーンずつ呼ぶ。/render は 1 件の失敗で残りを止めるため
              await renderStream(
                {
                  preset_id: plan.preset.id,
                  pov_char: plan.pov?.id ?? null,
                  node_ids: [scene.id],
                  target_chars: plan.target_chars
                },
                (e) => {
                  if (e.scene_done) saved = true
                  if (e.error) error = e.error
                },
                signal
              )
            } catch (e) {
              if (isAbortError(e)) {
                result.stopped = 'cancelled'
                break
              }
              error = errorText(e)
            } finally {
              setNodeBusy(scene.id, false)
            }
            if (!saved && error === null) error = '清書が保存されませんでした'
            if (!record('render', scene.title, saved ? null : error)) break
          }
        }

        if (wantsScripts && result.stopped === null && !cancelled()) {
          // 清書の作り直しで付け直しになった台本も拾うため、ここで数え直す
          const plan = await api.bulkUpdatePlan(options.includeBranches)
          const scenes = plan.scripts.filter((s) =>
            s.status === 'stale' ? options.scriptsStale : options.scriptsMissing
          )
          for (const [index, scene] of scenes.entries()) {
            if (cancelled()) break
            update({ done: index + 1, total: scenes.length, detail: `台本: ${scene.title}` })
            setNodeBusy(scene.id, true)
            let error: string | null = null
            try {
              // 作者が台本で手直しした行(edited)には触らない(annotate の決まり)
              await api.annotateVoiceScript(scene.render_id, null, signal)
            } catch (e) {
              if (isAbortError(e)) {
                result.stopped = 'cancelled'
                break
              }
              error = errorText(e)
            } finally {
              setNodeBusy(scene.id, false)
            }
            if (!record('script', scene.title, error)) break
          }
        }
      } catch (e) {
        // 保存や数え直しそのものの失敗(バックエンドに届かない、など)
        if (isAbortError(e)) result.stopped = 'cancelled'
        else {
          result.stopped = 'error'
          result.stopReason = errorText(e)
        }
      } finally {
        // 自分で止めたとき(人が席にいる)は、モデルをそのままにする
        if (options.releaseModel && result.stopped !== 'cancelled') {
          try {
            // 外部で起動したサーバーは止めない(アプリが起動したものだけ)
            if ((await api.llmStatus()).spawned) {
              await api.llmStop()
              result.released = true
            }
          } catch {
            // 解放できなくても結果は出す
          }
        }
        void window.storyGraph.setSleepBlocked(false).catch(() => false)
        result.finishedAt = Date.now()
        notifyGraphChanged()
        finish(result)
      }
    }
  })
}
