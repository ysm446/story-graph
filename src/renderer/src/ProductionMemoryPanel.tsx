import { memo, useEffect, useRef, useState } from 'react'
import { api, productionApi, type ProductionMemory } from './api'
import { Markdown } from './Markdown'

const memoryDate = (value: string): string => new Date(value).toLocaleString('ja-JP', { hour12: false })

/** ライブラリ共通の方針と、最後に確定した作業の記録。 */
function ProductionMemoryPanel({ busy, refresh, onDirty, onChanged }: {
  busy: boolean; refresh: number; onDirty: (dirty: boolean) => void; onChanged: () => void
}): React.JSX.Element {
  const [memory, setMemory] = useState<ProductionMemory | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const historyEpoch = useRef(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [versions, setVersions] = useState<ProductionMemory[]>([])
  const dirty = editing && draft !== memory?.content
  useEffect(() => { onDirty(dirty || saving) }, [dirty, saving, onDirty])
  useEffect(() => {
    let active = true
    productionApi.memory().then((value) => { if (active) setMemory(value) }).catch((e) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [refresh, busy])
  // 編集を始めた時点の版。編集中に制作がメモを更新して再取得が走っても、保存は
  // この版を基準にして競合(409)を検出させる。
  const editBaseRevision = useRef<number | null>(null)
  const save = async (): Promise<void> => {
    if (!memory) return
    setSaving(true)
    setError('')
    setNotice('')
    historyEpoch.current += 1
    try {
      setMemory(await productionApi.saveMemory(draft, editBaseRevision.current ?? memory.revision))
      setEditing(false)
      setVersions([])
      onChanged()
    } catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }
  const reset = async (): Promise<void> => {
    if (busy || saving || !memory) return
    if (!window.confirm('作業メモをリセットしますか？\nメモ本文・更新履歴・前回の作業記録・照合情報と、編集中のメモを消去し、版番号を初期化します。\nシーン・資料庫・会話履歴・AIへのルール・スナップショットは残ります。')) return
    setSaving(true); setError(''); setNotice('')
    historyEpoch.current += 1
    try {
      setMemory(await productionApi.resetMemory(memory.revision))
      setDraft(''); setEditing(false); setVersions([])
      setNotice('作業メモをリセットしました。')
      onChanged()
    } catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }
  const enabled = !!memory?.enabled
  // 作品ごとの設定。オフでも保存済みのメモと前回の作業記録は残す。
  const toggle = async (): Promise<void> => {
    if (busy || saving || editing || !memory) return
    setSaving(true); setError(''); setNotice('')
    try {
      await api.putSettings({ production_memory_enabled: enabled ? '0' : '1' })
      setMemory(await productionApi.memory())
      onChanged()
    } catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }
  const button = 'rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50'
  const style = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }
  return <details onToggle={(event) => {
    if (event.currentTarget.open) void productionApi.memory().then(setMemory).catch((e) => setError(String(e)))
  }} className="rounded-lg border px-3 py-1.5 text-[12px]" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
    <summary className="cursor-pointer" data-tip="新しい制作の会話でも引き継ぐ方針と、前回の作業記録です">作業メモ{memory && !enabled ? ' · オフ' : memory?.revision ? ` · 第${memory.revision}版` : ''}</summary>
    <div className="inspector-scrollbar mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto">
      <div>
        <button type="button" aria-pressed={enabled} disabled={busy || saving || editing || !memory} onClick={() => void toggle()}
          className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
          style={enabled
            ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
            : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          data-tip={busy ? '制作が終わるか停止してから切り替えられます' : editing ? 'メモの編集を終えてから切り替えられます' : 'オンにすると、メモを制作に渡し、制作中の更新と終了時の見直しを行います。この作品だけの設定です'}>
          {enabled ? '☑' : '☐'} 作業メモを使う</button>
      </div>
      {enabled ? <>
        <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>この作品の制作だけで共有します。現在のシーンと接続を優先し、キャラクターの記憶には含めません。</p>
        <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>制作の終了時に、手動修正を含む差分と照合します。相談中や手動編集直後には自動更新しません。</p>
      </> : <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>オフのあいだは、メモを制作に渡さず、制作中の更新と終了時の見直しも行いません。保存済みのメモは残り、前回の作業記録は引き続き使います。</p>}
      {memory?.created_at && <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>内容更新: {memoryDate(memory.created_at)}</p>}
      {memory?.reviewed_at && <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>最終照合: {memoryDate(memory.reviewed_at)}</p>}
      {enabled && memory?.needs_review && <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>現在の内容との照合が必要です。次の制作で作業メモを見直します。</p>}
      {memory?.review_error && <p role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>{memory.review_error}</p>}
      {editing ? <textarea aria-label="制作の作業メモ" value={draft} disabled={busy || saving} maxLength={6000} rows={9}
        onChange={(e) => setDraft(e.target.value)} className="inspector-scrollbar w-full rounded-md border px-2 py-0.5 text-[12px] outline-none"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }} /> : <Markdown text={memory?.content || (enabled ? 'まだ作業メモはありません。制作中に方針や次の作業を記録します。' : 'まだ作業メモはありません。')} />}
      <div className="flex flex-wrap gap-2">
        {editing ? <>
          <button className={button} style={style} disabled={busy || saving} onClick={() => void save()} data-tip="作業メモを保存します">メモを保存</button>
          <button className={button} style={style} disabled={saving} onClick={() => {
            setEditing(false)
            setError('')
            void productionApi.memory().then(setMemory).catch((e) => setError(String(e)))
          }} data-tip="入力を取り消し、保存済みのメモを読み直します">キャンセル</button>
        </> : <button className={button} style={style} disabled={busy || saving || !memory} onClick={() => { setDraft(memory?.content ?? ''); editBaseRevision.current = memory?.revision ?? null; setEditing(true) }} data-tip={busy ? '制作が終わるか停止してから修正できます' : '方針や決定事項を修正します'}>メモを編集</button>}
        <button className={button} style={style} disabled={saving} onClick={() => {
          const epoch = historyEpoch.current
          void productionApi.memoryHistory().then((value) => { if (epoch === historyEpoch.current) setVersions(value) }).catch((e) => { if (epoch === historyEpoch.current) setError(String(e)) })
        }} data-tip="直近20版のメモと更新理由を表示します">更新履歴</button>
        <button className={button} style={style} disabled={!memory?.content} onClick={() => {
          const url = URL.createObjectURL(new Blob([memory?.content ?? ''], { type: 'text/markdown;charset=utf-8' }))
          const a = document.createElement('a'); a.href = url; a.download = 'production-memory.md'; a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }} data-tip="現在のメモをMarkdownとして書き出します">書き出す</button>
        <button className={`delete-action ${button}`} disabled={busy || saving || !memory} onClick={() => void reset()}
          data-tip={busy ? '制作が終わるか停止してからリセットできます' : 'メモ本文・更新履歴・作業記録・照合情報を消去し、版番号を初期化します'}>作業メモをリセット</button>
      </div>
      {notice && <p role="status" className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{notice}</p>}
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      {memory?.checkpoint && <details>
        <summary className="cursor-pointer">前回の作業記録 · {({ completed: '完了', interrupted: '中断', running: '作業中に保存', limit: '上限で停止', error: 'エラーで停止' } as Record<string, string>)[memory.checkpoint.status]}</summary>
        <p className="mt-1">依頼: {memory.checkpoint.request}</p>
        <p>確定した操作: {memory.checkpoint.changes.length}件</p>
        <Markdown text={memory.checkpoint.report || '確定済みの変更を確認してから続きを依頼してください。'} />
      </details>}
      {versions.map((v) => <details key={v.revision}>
        <summary className="cursor-pointer">第{v.revision}版 · {v.source === 'user' ? '作者' : 'LLM'} · {v.reason}</summary>
        {v.created_at && <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>{memoryDate(v.created_at)}</p>}
        <Markdown text={v.content || '（空のメモ）'} />
      </details>)}
    </div>
  </details>
}

// 親の入力や進捗表示では描き直さない(閉じていても中身は描画されるため)
export default memo(ProductionMemoryPanel)
