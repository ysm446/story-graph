import { useEffect, useRef, useState } from 'react'
import {
  api,
  isAbortError,
  llamaInstallStream,
  type LlamaInstallProgress,
  type LlamaRelease,
  type LlamaReleaseVariant,
  type LlamaServerInstall,
  type LlamaServerStatus
} from '../../api'
import { describeProgress, fmtBytes } from './format'

// llama.cpp(llama-server)を GitHub リリースから自動ダウンロード/インストールする
export default function LlamaInstaller(): React.JSX.Element {
  const [serverStatus, setServerStatus] = useState<LlamaServerStatus | null>(null)
  const [releases, setReleases] = useState<LlamaRelease[]>([])
  const [selectedTag, setSelectedTag] = useState<string>('')
  const [selectedVariantKey, setSelectedVariantKey] = useState<string>('')
  const [loadingReleases, setLoadingReleases] = useState(false)
  // null = 自動判定(システムに CUDA ランタイムがあれば同梱しない)
  const [cudartChoice, setCudartChoice] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)
  const [removingDir, setRemovingDir] = useState<string | null>(null)
  const [progress, setProgress] = useState<LlamaInstallProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshStatus = async (): Promise<void> => {
    try {
      setServerStatus(await api.llamaServerStatus())
    } catch {
      setServerStatus(null)
    }
  }

  useEffect(() => {
    void refreshStatus()
    // セクションを離れたら進行中のダウンロードを止める(残すと画面から見えない
    // まま何 GB も落とし続け、止める手段もなくなる)
    return () => abortRef.current?.abort()
  }, [])

  const selectedRelease = releases.find((r) => r.tag === selectedTag) ?? releases[0]
  const selectedVariant: LlamaReleaseVariant | undefined =
    selectedRelease?.variants.find((v) => v.key === selectedVariantKey) ?? selectedRelease?.variants[0]

  const cudartSize = selectedVariant?.cudart_size_bytes ?? null
  const hasCudartAsset = selectedVariant?.family === 'cuda' && selectedVariant.cudart_url != null
  // 同じメジャーバージョンの CUDA ランタイムが PATH にあれば、DLL の同梱は要らない
  const systemHasCudart =
    selectedVariant?.cuda_version != null &&
    (serverStatus?.system_cudart ?? []).includes(selectedVariant.cuda_version)
  const includeCudart = hasCudartAsset ? cudartChoice ?? !systemHasCudart : false
  // 選択中のバリアントが既に入っていて、DLL だけ足りない状態か
  const selectedInstall = selectedVariant
    ? serverStatus?.installs.find(
        (i) =>
          (i.dir.split(/[\\/]/).pop() || '').toLowerCase() ===
          selectedVariant.asset_name.replace(/\.zip$/i, '').toLowerCase()
      )
    : undefined
  const canAddCudart = hasCudartAsset && selectedInstall != null && !selectedInstall.has_cudart

  const handleFetch = async (): Promise<void> => {
    setLoadingReleases(true)
    setError(null)
    try {
      const { releases: list } = await api.llamaReleases()
      setReleases(list)
      const first = list.find((r) => r.variants.length > 0) ?? list[0]
      if (first) {
        setSelectedTag(first.tag)
        setSelectedVariantKey(first.variants[0]?.key ?? '')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingReleases(false)
    }
  }

  const handleInstall = async (cudartOnly = false): Promise<void> => {
    if (!selectedVariant) return
    const controller = new AbortController()
    abortRef.current = controller
    setInstalling(true)
    setError(null)
    setDoneMsg(null)
    setProgress(null)
    try {
      await llamaInstallStream(
        selectedVariant,
        (p) => {
          setProgress(p)
          if (p.phase === 'error') setError(p.message)
          if (p.phase === 'done') setDoneMsg(`インストールが完了しました(${p.build ?? selectedVariant.label})`)
        },
        controller.signal,
        { includeCudart, cudartOnly }
      )
      await refreshStatus()
    } catch (e) {
      if (!isAbortError(e)) setError(String(e))
    } finally {
      abortRef.current = null
      setInstalling(false)
      // 進捗表示を畳んでボタン列へ戻す。ここで消さないと、中止・エラーの後に
      // 進捗ブロックだけが残ってインストールし直せなくなる(ボタンが出ない)
      setProgress(null)
    }
  }

  const handleUninstall = async (install: LlamaServerInstall): Promise<void> => {
    const name = install.dir.split(/[\\/]/).pop() || install.dir
    const freed = install.size_bytes != null ? `${fmtBytes(install.size_bytes)} を空けます。` : ''
    if (!window.confirm(`「${name}」を削除しますか?\n${freed}\n必要になったら同じビルドを入れ直せます。`)) return
    setRemovingDir(install.dir)
    setError(null)
    try {
      setServerStatus(await api.llamaUninstall(install.dir))
    } catch (e) {
      setError(String(e))
      await refreshStatus()
    } finally {
      setRemovingDir(null)
    }
  }

  const totalSize = selectedVariant ? selectedVariant.size_bytes + (includeCudart ? cudartSize ?? 0 : 0) : 0

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">llama-server の自動インストール</span>
        <div className="settings-field-controls">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: serverStatus?.installed ? '#3ecf8e' : 'var(--text-faint)' }}
          />
          <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            {serverStatus?.installed ? `導入済み(${serverStatus.build ?? '?'})` : '未導入'}
          </span>
        </div>
      </div>
      {serverStatus && serverStatus.installs.length > 0 && (
        <div className="flex flex-col gap-1">
          {serverStatus.installs.map((ins) => {
            const name = ins.dir.split(/[\\/]/).pop() || ins.dir
            const isDefault = ins.path === serverStatus.path
            return (
              <div
                key={ins.path}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
                style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
              >
                {isDefault && (
                  <span
                    className="shrink-0 rounded px-1 text-[10px]"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                    data-tip="実行ファイルのパスが未入力のとき、このビルドが使われます"
                  >
                    既定
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }} data-tip={ins.path}>
                  {name}
                </span>
                {ins.is_cuda && !ins.has_cudart && (
                  <span
                    className="shrink-0 rounded px-1 text-[10px]"
                    style={{ background: 'var(--bg-input)', color: 'var(--text-faint)' }}
                    data-tip={
                      serverStatus.system_cudart.includes(ins.cuda_version ?? '')
                        ? `CUDA ランタイム DLL は同梱していません(この PC の CUDA ${ins.cuda_version} を使います)`
                        : 'CUDA ランタイム DLL は同梱していません。起動に失敗するときは、リリース一覧から同じビルドを選んで「CUDA ランタイムだけ追加」してください'
                    }
                  >
                    DLL 未同梱
                  </span>
                )}
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                  {fmtBytes(ins.size_bytes ?? null)}
                </span>
                <button
                  onClick={() => void handleUninstall(ins)}
                  disabled={!ins.removable || installing || removingDir !== null}
                  className="delete-action shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                  data-tip={
                    ins.removable
                      ? 'このフォルダを丸ごと消して容量を空けます'
                      : `自動インストール先(${serverStatus.runtime_dir})の外にあるので、このアプリからは消しません`
                  }
                >
                  {removingDir === ins.dir ? '削除中…' : '削除'}
                </button>
              </div>
            )
          })}
          <p className="settings-field-hint">
            インストール済み {serverStatus.installs.length} 件・合計 {fmtBytes(serverStatus.total_size_bytes)}。
            起動中のサーバは削除できません(先に停止してください)。
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void handleFetch()}
          disabled={loadingReleases || installing}
          className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        >
          {loadingReleases ? '取得中…' : releases.length ? '⟳ リリース一覧を更新' : 'リリース一覧を取得'}
        </button>
      </div>

      {releases.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <select
              value={selectedRelease?.tag ?? ''}
              onChange={(e) => {
                setSelectedTag(e.target.value)
                const rel = releases.find((r) => r.tag === e.target.value)
                setSelectedVariantKey(rel?.variants[0]?.key ?? '')
                setCudartChoice(null)
              }}
              disabled={installing}
              className="rounded-lg border px-2 py-1.5 text-[13px]"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            >
              {releases.map((r) => (
                <option key={r.tag} value={r.tag}>
                  {r.tag}
                  {r.published_at ? `(${r.published_at.slice(0, 10)})` : ''}
                </option>
              ))}
            </select>
            <select
              value={selectedVariant?.key ?? ''}
              onChange={(e) => {
                setSelectedVariantKey(e.target.value)
                setCudartChoice(null)
              }}
              disabled={installing}
              className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-[13px]"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            >
              {selectedRelease?.variants.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label}・{fmtBytes(v.size_bytes)}
                </option>
              ))}
            </select>
          </div>
          {hasCudartAsset && (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setCudartChoice(!includeCudart)}
                disabled={installing}
                className="self-start rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                style={
                  includeCudart
                    ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                    : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
                }
                data-tip="CUDA ランタイム DLL(cudart / cublas)を llama-server.exe と同じフォルダに置きます"
              >
                {includeCudart ? '☑' : '☐'} CUDA ランタイム DLL も一緒に落とす({fmtBytes(cudartSize)})
              </button>
              <p className="settings-field-hint">
                {systemHasCudart
                  ? `CUDA ${selectedVariant?.cuda_version} のランタイムがこの PC の PATH にあるので、通常は不要です。動かないときだけ入れてください。`
                  : 'CUDA Toolkit を入れている場合は外せます。外して起動に失敗したら、あとから DLL だけ追加できます。'}
              </p>
            </div>
          )}

          {installing || progress ? (
            <div className="flex flex-col gap-1.5">
              <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border-strong)' }}>
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${progress?.phase === 'download' ? progress.percent ?? 0 : progress ? 100 : 0}%`,
                    background: 'var(--accent)'
                  }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: progress?.phase === 'error' ? 'var(--danger)' : 'var(--text-dim)' }}>
                  {progress ? describeProgress(progress) : '準備中…'}
                </span>
                {installing && (
                  <button
                    onClick={() => abortRef.current?.abort()}
                    className="rounded-md border px-2 py-0.5 text-[12px]"
                    style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                  >
                    中止
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void handleInstall()}
                disabled={!selectedVariant}
                className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                ⬇ インストール({totalSize ? fmtBytes(totalSize) : '—'})
              </button>
              {canAddCudart && (
                <button
                  onClick={() => void handleInstall(true)}
                  className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip="このビルドはインストール済みです。本体は落とし直さず、CUDA ランタイム DLL だけ同じフォルダに足します"
                >
                  CUDA ランタイムだけ追加({fmtBytes(cudartSize)})
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {doneMsg && !error && (
        <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          ✓ {doneMsg}
        </p>
      )}
      <p className="settings-field-hint">
        GitHub の ggml-org/llama.cpp から Windows 版をダウンロードし、<code>runtime/</code> 配下に配置します。
        導入後は手入力の実行ファイルパスが空でも自動で検出されます。
      </p>
    </div>
  )
}
