import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import {
  closeBulkUpdate,
  loadBulkUpdateOptions,
  saveBulkUpdateOptions,
  showLastBulkUpdateResult,
  startBulkUpdate,
  useBulkUpdateUi,
  type BulkUpdateOptions,
  type BulkUpdateResult
} from './bulkUpdate'
import type { BulkUpdatePlan } from './types'

/** まとめて更新(docs/design/bulk-update.md)のダイアログ。
 *  選ぶ画面と結果の画面を、開いている間だけ出す。App に 1 つ置く(結果は、走らせた画面を離れていても出すため)。 */
export default function BulkUpdateHost(): React.JSX.Element | null {
  const { view, result } = useBulkUpdateUi()
  if (view === 'choose') return <ChooseDialog />
  if (view === 'result' && result) return <ResultDialog result={result} />
  return null
}

const secondary = 'rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50'
const secondaryStyle = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }

function Frame({
  titleId,
  title,
  description,
  onClose,
  children
}: {
  titleId: string
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[520px] max-w-[92vw] rounded-2xl border p-4 shadow-xl shadow-black/50"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className={`${description ? 'mb-1' : 'mb-3'} text-[14px] font-semibold`}>
          {title}
        </h3>
        {description && (
          <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {description}
          </p>
        )}
        {children}
      </div>
    </div>,
    document.body
  )
}

/** チェックで選ぶ行。左に ☑ / ☐、右に件数。押せない行は理由を data-tip に出す */
function CheckRow({
  name,
  label,
  checked,
  count,
  disabledReason,
  tip,
  onToggle
}: {
  name: string
  label: string
  checked: boolean
  count?: number
  disabledReason?: string | null
  tip?: string
  onToggle: () => void
}): React.JSX.Element {
  const disabled = !!disabledReason
  const on = checked && !disabled
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-bulk-row={name}
      disabled={disabled}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] disabled:opacity-50"
      style={{ color: on ? 'var(--text)' : 'var(--text-faint)' }}
      data-tip={disabledReason ?? tip}
    >
      <span className="w-4 shrink-0 text-center">{on ? '☑' : '☐'}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 tabular-nums">{count} 件</span>}
    </button>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-0.5 mt-2 truncate text-[12px] first:mt-0" style={{ color: 'var(--text-dim)' }}>
      {children}
    </div>
  )
}

function ChooseDialog(): React.JSX.Element {
  const { last } = useBulkUpdateUi()
  const [options, setOptions] = useState<BulkUpdateOptions>(loadBulkUpdateOptions)
  const [plan, setPlan] = useState<BulkUpdatePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 外部で起動した llama-server はアプリから止めない(ServiceBar と同じ決まり)
  const [external, setExternal] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .bulkUpdatePlan(options.includeBranches)
      .then((p) => !cancelled && setPlan(p))
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [options.includeBranches])

  useEffect(() => {
    let cancelled = false
    api
      .llmStatus()
      .then((s) => !cancelled && setExternal(s.healthy && !s.spawned))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = (key: keyof BulkUpdateOptions): void =>
    setOptions((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      saveBulkUpdateOptions(next)
      return next
    })

  const digestCount = plan?.digests.length ?? 0
  const staleCount = plan?.renders.filter((r) => r.status === 'stale').length ?? 0
  const missingCount = plan?.renders.filter((r) => r.status === 'missing').length ?? 0
  const digestsOn = options.digests && digestCount > 0
  // まとめを作り直すと、その先の清書が要更新になる。いま 0 件でも、まとめを選んでいる間は清書を選べる
  const noPreset = plan && !plan.preset ? '文体プリセットがありません' : null
  const renderReason = (count: number): string | null =>
    noPreset ?? (count === 0 && !digestsOn ? '対象がありません' : null)
  const staleOn = options.rendersStale && !renderReason(staleCount)
  const missingOn = options.rendersMissing && !renderReason(missingCount)
  // 清書を作り直すと、その清書の台本が付け直しになる。いま 0 件でも、清書を選んでいる間は台本を選べる
  const scriptStaleCount = plan?.scripts.filter((s) => s.status === 'stale').length ?? 0
  const scriptMissingCount = plan?.scripts.filter((s) => s.status === 'missing').length ?? 0
  const rendersOn = (staleOn && (digestsOn || staleCount > 0)) || (missingOn && (digestsOn || missingCount > 0))
  const scriptReason = (count: number): string | null =>
    noPreset ?? (count === 0 && !rendersOn ? '対象がありません' : null)
  const scriptStaleOn = options.scriptsStale && !scriptReason(scriptStaleCount)
  const scriptMissingOn = options.scriptsMissing && !scriptReason(scriptMissingCount)
  const nothing =
    !!plan && digestCount + staleCount + missingCount + scriptStaleCount + scriptMissingCount === 0
  const canStart =
    !!plan &&
    (digestsOn ||
      (staleOn && staleCount > 0) ||
      (missingOn && missingCount > 0) ||
      (scriptStaleOn && scriptStaleCount > 0) ||
      (scriptMissingOn && scriptMissingCount > 0))

  const submit = (): void => {
    if (!canStart) return
    startBulkUpdate({
      ...options,
      digests: digestsOn,
      rendersStale: staleOn,
      rendersMissing: missingOn,
      scriptsStale: scriptStaleOn,
      scriptsMissing: scriptMissingOn,
      releaseModel: options.releaseModel && !external
    })
    closeBulkUpdate()
  }

  return (
    <Frame
      titleId="bulk-update-title"
      title="まとめて更新"
      description="古くなった章のまとめ・清書・台本を、選んだものだけ順に作り直します。席を離れている間に回せます。"
      onClose={closeBulkUpdate}
    >
      {!plan && !error && (
        <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          対象を数えています…
        </p>
      )}
      {plan && (
        <div data-bulk-update-plan>
          <Heading>章のまとめ</Heading>
          <CheckRow
            name="digests"
            label="要更新のまとめ"
            checked={options.digests}
            count={digestCount}
            disabledReason={digestCount === 0 ? '対象がありません' : null}
            tip="まとめを一度作った章だけが対象です。まとめの無い章には作りません"
            onToggle={() => toggle('digests')}
          />
          <Heading>
            清書({plan.preset ? plan.preset.name : 'プリセットなし'} / {plan.pov ? `視点: ${plan.pov.name}` : '視点なし'})
          </Heading>
          <CheckRow
            name="rendersStale"
            label="要更新の清書"
            checked={options.rendersStale}
            count={staleCount}
            disabledReason={renderReason(staleCount)}
            onToggle={() => toggle('rendersStale')}
          />
          <CheckRow
            name="rendersMissing"
            label="まだ清書していないシーン"
            checked={options.rendersMissing}
            count={missingCount}
            disabledReason={renderReason(missingCount)}
            tip="本文が空のシーンは対象になりません"
            onToggle={() => toggle('rendersMissing')}
          />
          {digestsOn && (
            <p className="mt-1 px-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              まとめを作り直すと、その先の清書が要更新になり、清書の件数が増えることがあります。
            </p>
          )}
          <Heading>台本(話者と感情)</Heading>
          <CheckRow
            name="scriptsStale"
            label="清書を作り直したシーン"
            checked={options.scriptsStale}
            count={scriptStaleCount}
            disabledReason={scriptReason(scriptStaleCount)}
            tip="前の清書の台本には話者と感情を付けてあったシーンです。台本で手直しした行はそのまま残ります"
            onToggle={() => toggle('scriptsStale')}
          />
          <CheckRow
            name="scriptsMissing"
            label="まだ付けていないシーン"
            checked={options.scriptsMissing}
            count={scriptMissingCount}
            disabledReason={scriptReason(scriptMissingCount)}
            tip="清書のあるシーンのうち、話者と感情をまだ LLM で付けていないものです"
            onToggle={() => toggle('scriptsMissing')}
          />
          {rendersOn && (
            <p className="mt-1 px-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              清書を作り直すと台本も付け直しになり、台本の件数が増えることがあります。
            </p>
          )}
          <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
            <CheckRow
              name="includeBranches"
              label="分岐・島も含める"
              checked={options.includeBranches}
              tip="外すと、正史の道に乗っているシーンと章だけを対象にします"
              onToggle={() => toggle('includeBranches')}
            />
            <CheckRow
              name="releaseModel"
              label="終わったらモデルを解放する"
              checked={options.releaseModel}
              disabledReason={external ? '外部で起動した llama-server は、アプリからは止めません' : null}
              tip="終わったら llama-server を止めて VRAM を空けます。途中で中止したときは止めません"
              onToggle={() => toggle('releaseModel')}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            {nothing
              ? '更新するものはありません。'
              : '章のまとめ → 清書 → 台本の順に実行します。始める前に、いまの状態を保存します(設定の「スナップショット」から戻せます)。実行中はステータスバーから中止できます。'}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 break-all text-[12px]" style={{ color: 'var(--danger-text)' }}>
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        {last && (
          <button
            type="button"
            onClick={showLastBulkUpdateResult}
            className={secondary}
            style={secondaryStyle}
            data-tip={`前回(${formatWhen(last.finishedAt)})の結果を見ます`}
          >
            前回の結果
          </button>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={closeBulkUpdate} className={secondary} style={secondaryStyle}>
            取り消し
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canStart}
            className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            始める
          </button>
        </div>
      </div>
    </Frame>
  )
}

const formatWhen = (time: number): string => {
  const d = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`
}

const RESULT_TITLE: Record<NonNullable<BulkUpdateResult['stopped']> | 'done', string> = {
  done: 'まとめて更新が終わりました',
  cancelled: 'まとめて更新を中止しました',
  failures: 'まとめて更新を途中で止めました',
  error: 'まとめて更新を途中で止めました'
}

const KIND_LABEL = { digest: '章のまとめ', render: '清書', script: '台本' } as const

function ResultDialog({ result }: { result: BulkUpdateResult }): React.JSX.Element {
  const rows: Array<[string, { done: number; failed: number } | null]> = [
    ['章のまとめ', result.digests],
    ['清書', result.renders],
    ['台本', result.scripts ?? null]
  ]
  return (
    <Frame
      titleId="bulk-update-result-title"
      title={RESULT_TITLE[result.stopped ?? 'done']}
      description={`${formatWhen(result.finishedAt)} に終了(${formatDuration(result.finishedAt - result.startedAt)})`}
      onClose={closeBulkUpdate}
    >
      <div data-bulk-update-result className="text-[12px] leading-relaxed tabular-nums" style={{ color: 'var(--text)' }}>
        {rows.map(
          ([label, counts]) =>
            counts && (
              <div key={label} className="flex gap-3">
                <span className="w-20 shrink-0" style={{ color: 'var(--text-dim)' }}>
                  {label}
                </span>
                <span>
                  {counts.done} 件更新{counts.failed > 0 ? ` / 失敗 ${counts.failed} 件` : ''}
                </span>
              </div>
            )
        )}
        {result.released && <div style={{ color: 'var(--text-dim)' }}>モデルを解放しました。</div>}
      </div>
      {result.stopReason && (
        <p role="alert" className="mt-2 break-all text-[12px]" style={{ color: 'var(--danger-text)' }}>
          {result.stopReason}
        </p>
      )}
      {result.failures.length > 0 && (
        <>
          <div className="mb-1 mt-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            失敗したもの
          </div>
          <ul
            data-bulk-update-failures
            className="max-h-48 overflow-y-auto text-[11px] leading-relaxed"
            style={{ color: 'var(--text-dim)' }}
          >
            {result.failures.map((f, i) => (
              <li key={i} className="break-all">
                {KIND_LABEL[f.kind]}「{f.title}」 — {f.error}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        始める前の状態は、設定の「スナップショット」に「まとめて更新の前」として残っています。
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={closeBulkUpdate} className={secondary} style={secondaryStyle}>
          閉じる
        </button>
      </div>
    </Frame>
  )
}
