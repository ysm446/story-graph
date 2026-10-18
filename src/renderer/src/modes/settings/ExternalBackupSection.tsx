import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { BackupConfig } from '../../types'
import { fmtSize } from './format'

// 外部バックアップ(zip 書き出し。docs/design/backup.md)。
// スナップショットがライブラリの中に置かれるのに対し、こちらは外へ持ち出して
// フォルダ消失・ディスク障害に備える。パス選択はネイティブダイアログ(Electron)、
// zip の読み書きはバックエンドが行う
export default function ExternalBackupSection(): React.JSX.Element {
  const [config, setConfig] = useState<BackupConfig | null>(null)
  const [includeSnapshots, setIncludeSnapshots] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setConfig(await api.getBackupConfig())
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const patchConfig = async (values: Parameters<typeof api.putBackupConfig>[0]): Promise<void> => {
    try {
      setConfig(await api.putBackupConfig(values))
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleExport = async (): Promise<void> => {
    if (busy) return
    try {
      const { name } = await api.suggestedBackupName()
      const path = await window.storyGraph.chooseBackupSaveFile(name, config?.dir ?? '')
      if (!path) return
      setBusy(true)
      setStatus('書き出しています…')
      const result = await api.exportBackup(path, includeSnapshots)
      setStatus(`書き出しました: ${result.path}(${fmtSize(result.size)} / 画像 ${result.assets} 件)`)
      setError(null)
      await reload()
    } catch (e) {
      setStatus(null)
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleBackupNow = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus('バックアップしています…')
    try {
      const result = await api.runAutoBackup()
      setStatus(result.path ? `保存しました: ${result.path}` : 'バックアップしました')
      setError(null)
      await reload()
    } catch (e) {
      setStatus(null)
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleChooseDir = async (): Promise<void> => {
    const dir = await window.storyGraph.chooseFolder('自動バックアップの保存先を選択')
    if (dir) await patchConfig({ dir })
  }

  // 保存先を開く。まだ無いフォルダは main 側で作ってから開くので、
  // 「押しても何も起きない」ようには見せない(開けなければ理由を出す)
  const handleOpenDir = async (dir: string): Promise<void> => {
    if (await window.storyGraph.openFolder(dir)) {
      setError(null)
      return
    }
    setError(`保存先フォルダを開けませんでした: ${dir}`)
  }

  const handleReveal = async (path: string): Promise<void> => {
    if (await window.storyGraph.revealInFolder(path)) {
      setError(null)
      return
    }
    setError(`ファイルが見つかりませんでした: ${path}`)
  }

  const handleRestore = async (): Promise<void> => {
    if (busy) return
    const zipPath = await window.storyGraph.chooseBackupZip()
    if (!zipPath) return
    setBusy(true)
    try {
      const info = await api.inspectBackup(zipPath)
      if (!info.has_db) {
        setError('story-graph のバックアップではないようです(story-graph.db が入っていません)')
        return
      }
      const when = info.created_at ? new Date(info.created_at).toLocaleString('ja-JP') : '不明'
      if (
        !window.confirm(
          `「${info.library_name ?? '(名前不明)'}」(${when} / 画像 ${info.assets} 件)を` +
            '新しいライブラリとして展開します。\n' +
            '次に展開先の空フォルダを選んでください。展開後はそのライブラリに切り替わります' +
            '(今のライブラリは変更されません)。'
        )
      ) {
        return
      }
      const dest = await window.storyGraph.chooseFolder('展開先のフォルダを選択(空のフォルダ)')
      if (!dest) return
      setStatus('展開しています…')
      const result = await api.restoreBackup(zipPath, dest)
      await window.storyGraph.switchLibrary(result.root)
      await api.switchLibrary(result.root)
      window.location.reload() // ライブラリ切替と同じ作法で全体を読み直す
      return
    } catch (e) {
      setStatus(null)
      setError(
        String(e).includes('409')
          ? '展開先に既にライブラリがあります。空のフォルダを選んでください'
          : String(e)
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">外部バックアップ(zip)</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIncludeSnapshots((v) => !v)}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={
              includeSnapshots
                ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
            }
            data-tip="スナップショット(ライブラリ内の時点保存)も zip に含めます。サイズが数十倍になります"
          >
            {includeSnapshots ? '☑' : '☐'} スナップショットも含める
          </button>
          <button
            onClick={() => void handleExport()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            zip に書き出す
          </button>
          <button
            onClick={() => void handleRestore()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip="zip を新しいライブラリとして展開して開きます(今のライブラリは変更しません)"
          >
            zip から復元
          </button>
        </div>
      </div>
      <p className="settings-field-hint">
        ライブラリ(シーン・イベント・清書・チャットの入った story-graph.db と、挿絵・立ち絵)を
        1 つの zip にまとめて<b>ライブラリの外へ</b>持ち出します。下のスナップショットは
        ライブラリの中にあるので、フォルダごと消えた・ディスクが壊れたという事故には
        こちらが要ります。復元は<b>新しいライブラリとして展開</b>するので、今のデータは上書きされません。
      </p>

      {config && (
        <>
          <div className="settings-field-header">
            <span className="settings-field-label">自動バックアップ(1 日 1 回)</span>
            <div className="settings-field-controls">
              <div
                className="flex overflow-hidden rounded-md border"
                style={{ borderColor: 'var(--border-strong)' }}
              >
                {(
                  [
                    [true, 'オン'],
                    [false, 'オフ']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={label}
                    onClick={() => void patchConfig({ enabled: value })}
                    className="px-2.5 py-0.5 text-[12px]"
                    style={
                      config.enabled === value
                        ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                        : { color: 'var(--text-faint)' }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                残す数
              </span>
              <input
                type="number"
                min={1}
                max={99}
                value={config.keep}
                onChange={(e) => setConfig({ ...config, keep: Number(e.target.value) })}
                // min/max はスピナーにしか効かない。空欄(Number('') = 0)や範囲外を
                // そのまま送ると、保持数 0 = 自動バックアップが全部消える
                onBlur={(e) => {
                  const keep = Math.min(99, Math.max(1, Math.round(Number(e.target.value)) || 1))
                  setConfig({ ...config, keep })
                  void patchConfig({ keep })
                }}
                className="w-14 rounded-md border px-2 py-0.5 text-[12px] outline-none"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
              />
              <button
                onClick={() => void handleBackupNow()}
                disabled={busy}
                className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              >
                今すぐバックアップ
              </button>
            </div>
          </div>
          <p className="settings-field-hint">
            <b>既定はオフ</b>です。オンにすると、アプリを開いたときに前回から 24 時間以上経っていれば
            このライブラリを zip にします(シーンが 1 つも無いライブラリは対象外)。
            古いものは「残す数」まで自動で消えます(手動の書き出しは消しません)。
            「今すぐバックアップ」はオフのままでも使えます。
            {config.last_at
              ? ` 最後のバックアップ: ${new Date(config.last_at).toLocaleString('ja-JP')}`
              : ' まだ一度も実行していません。'}
          </p>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="shrink-0" style={{ color: 'var(--text-faint)' }}>
              保存先
            </span>
            <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }} data-tip={config.dir}>
              {config.dir}
            </span>
            <button
              onClick={() => void patchConfig({ inside: !config.inside })}
              className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
              style={
                config.inside
                  ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                  : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
              }
              data-tip="既定はオン。ライブラリの中(<ライブラリ>/backups/)に置くので、ライブラリを切り替えても付いてきます"
            >
              {config.inside ? '☑' : '☐'} ライブラリの中
            </button>
            <button
              onClick={() => void handleChooseDir()}
              disabled={config.inside}
              className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip={
                config.inside
                  ? 'ライブラリの中に置く設定です。外のフォルダを使うにはオフにしてください'
                  : '保存先のフォルダを選びます'
              }
            >
              変更
            </button>
            <button
              onClick={() => void handleOpenDir(config.dir)}
              className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="保存先フォルダをエクスプローラーで開く"
            >
              開く
            </button>
          </div>
          <p className="settings-field-hint">
            <b>既定は「ライブラリの中」</b>です。`&lt;ライブラリ&gt;/backups/` に貯まるので、
            フォルダを丸ごと運べばバックアップも一緒に付いてきます(ライブラリを切り替えても迷子になりません)。
            ただし<b>フォルダごと失う事故には効かない</b>ので、そこまで備えるなら外のフォルダ
            (別ドライブやクラウド同期フォルダ)を選んでください。zip には画像・動画も入るため、
            中に置くとライブラリのサイズがその分ふくらみます。
          </p>
          {config.entries.map((entry) => (
            <div
              key={entry.path}
              className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
            >
              <span
                className="shrink-0 rounded px-1 text-[10px]"
                style={{
                  background: entry.kind === 'manual' ? 'var(--accent-soft)' : 'var(--bg-input)',
                  color: entry.kind === 'manual' ? 'var(--text)' : 'var(--text-faint)'
                }}
              >
                {entry.kind === 'manual' ? '手動' : '自動'}
              </span>
              <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
                {entry.name}
              </span>
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                {new Date(entry.modified_at).toLocaleString('ja-JP')} / {fmtSize(entry.size)}
              </span>
              <button
                onClick={() => void handleReveal(entry.path)}
                className="shrink-0 rounded-md px-1 text-[11px]"
                style={{ color: 'var(--text-faint)' }}
                aria-label="このファイルの場所を開く"
                data-tip="このファイルの場所を開く"
              >
                ⧉
              </button>
            </div>
          ))}
        </>
      )}
      {status && (
        <p className="settings-field-hint" style={{ color: 'var(--text-dim)' }}>
          {status}
        </p>
      )}
      {error && (
        <p className="settings-field-hint" style={{ color: 'var(--danger-text)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
