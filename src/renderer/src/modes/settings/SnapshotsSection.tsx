import { useEffect, useState } from 'react'
import { api } from '../../api'
import { showStatusNotice } from '../../statusNotice'
import type { Snapshot } from '../../types'
import { fmtSize } from './format'

// スナップショット(バックアップ)。危険な操作の前の自動保存 + 手動保存と復元
// (docs/design/snapshots.md)
export default function SnapshotsSection(): React.JSX.Element {
  const [items, setItems] = useState<Snapshot[]>([])
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setItems((await api.listSnapshots()).snapshots)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const handleCreate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await api.createSnapshot(label)
      setLabel('')
      await reload()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = async (snap: Snapshot): Promise<void> => {
    if (busy) return
    const when = new Date(snap.created_at).toLocaleString('ja-JP')
    if (
      !window.confirm(
        `「${snap.label}」(${when})の時点に戻しますか?\n` +
          '現在の状態は「復元の前」として自動保存されます。'
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await api.restoreSnapshot(snap.id)
      window.location.reload() // ライブラリ切替と同じ作法で全体を読み直す
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    if (busy || items.length === 0) return
    const targets = [...items]
    if (!window.confirm(
      `一覧のスナップショット ${targets.length} 件をすべて削除しますか?\n` +
      '自動・手動・制作チャットの作業前保存が対象です。削除すると、これらの時点には戻せません。\n' +
      '現在の作品・資料庫・会話は削除されません。'
    )) return
    setBusy(true)
    setError(null)
    let deleted = 0
    let failure: string | null = null
    try {
      // 確認時に表示していた分だけ削除し、後から作られた保存は残す。
      for (const snap of targets) {
        try {
          await api.deleteSnapshot(snap.id)
          deleted += 1
        } catch (e) {
          failure = `${deleted} / ${targets.length} 件を削除しました。「${snap.label}」の削除で停止しました: ${String(e)}`
          break
        }
      }
      await reload()
      if (failure) setError(failure)
      else showStatusNotice(`スナップショット ${deleted} 件を削除しました`)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (snap: Snapshot): Promise<void> => {
    if (busy) return
    if (!window.confirm(`スナップショット「${snap.label}」を削除しますか?`)) return
    setBusy(true) // 連打すると 2 発目の DELETE が 404 でエラー表示になる
    try {
      await api.deleteSnapshot(snap.id)
      await reload()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">スナップショット({items.length}件)</span>
        <div className="flex items-center gap-1.5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="名前(任意)"
            className="w-40 rounded-md border px-2 py-0.5 text-[12px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
          <button
            onClick={() => void handleCreate()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            今の状態を保存
          </button>
          <button
            onClick={() => void handleClear()}
            disabled={busy || items.length === 0}
            className="delete-action rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            data-tip={busy ? 'スナップショットの処理中です' : items.length === 0 ? '削除するスナップショットがありません' : '一覧のスナップショットをすべて削除します。現在の作品は残ります'}
          >
            一括クリア
          </button>
        </div>
      </div>
      <p className="settings-field-hint">
        シーンの削除・正史切替・イベント作り直しなどの前には自動で保存されます(自動分は直近 30 件まで)。
        復元するとライブラリ全体(シーン・イベント・清書・チャット)がその時点に戻ります。
      </p>
      {error && (
        <p className="settings-field-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {items.map((snap) => (
        <div
          key={snap.id}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
        >
          <span
            className="shrink-0 rounded px-1 text-[10px]"
            style={{
              background: snap.kind === 'manual' ? 'var(--accent-soft)' : 'var(--bg-input)',
              color: snap.kind === 'manual' ? 'var(--text)' : 'var(--text-faint)'
            }}
          >
            {snap.kind === 'manual' ? '手動' : '自動'}
          </span>
          <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
            {snap.label}
          </span>
          <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
            {new Date(snap.created_at).toLocaleString('ja-JP')} / {fmtSize(snap.size)}
          </span>
          <button
            onClick={() => void handleRestore(snap)}
            disabled={busy}
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            復元
          </button>
          <button
            onClick={() => void handleDelete(snap)}
            disabled={busy}
            className="delete-action shrink-0 rounded-md px-1 text-[11px] disabled:opacity-50"
            aria-label="このスナップショットを削除"
            data-tip="このスナップショットを削除"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
