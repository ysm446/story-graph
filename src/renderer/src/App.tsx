import { useEffect, useRef, useState } from 'react'
import { api, initApi } from './api'
import ModelBar from './ModelBar'
import StatusBar from './StatusBar'
import StructureMode from './modes/StructureMode'
import ReaderMode from './modes/ReaderMode'
import CharactersMode from './modes/CharactersMode'
import SettingsMode from './modes/SettingsMode'

type Mode = 'structure' | 'reader' | 'characters'

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'structure', label: '構造' },
  { id: 'characters', label: '資料庫' },
  { id: 'reader', label: '鑑賞' }
]

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function LibraryMenu(): React.JSX.Element {
  const [current, setCurrent] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.storyGraph.getLibraryInfo().then((info) => {
      setCurrent(info.current)
      setRecents(info.recents)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const applyRoot = async (root: string): Promise<void> => {
    await window.storyGraph.switchLibrary(root)
    await api.switchLibrary(root)
    window.location.reload()
  }

  const handleChoose = async (): Promise<void> => {
    const root = await window.storyGraph.chooseLibrary()
    if (root) await applyRoot(root)
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px]"
        style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}
        title={current ?? ''}
      >
        <span className="flex" style={{ color: 'var(--text-faint)' }}>
          <FolderIcon />
        </span>
        <span className="max-w-40 truncate">{current ? baseName(current) : '…'}</span>
        <span style={{ color: 'var(--text-faint)' }}>▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 top-8 z-50 w-72 rounded-xl border p-1.5 shadow-lg shadow-black/40"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            Library
          </div>
          {recents.map((root) => {
            const isCurrent = current !== null && normalizePath(root) === normalizePath(current)
            return (
              <button
                key={root}
                onClick={() => {
                  setOpen(false)
                  if (!isCurrent) void applyRoot(root)
                }}
                className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-[12px]"
                style={isCurrent ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
                title={root}
              >
                {baseName(root)}
                <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                  {root}
                </span>
              </button>
            )
          })}
          <button
            onClick={() => {
              setOpen(false)
              void handleChoose()
            }}
            className="mt-1 block w-full rounded-lg border border-dashed px-2 py-1.5 text-left text-[12px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            + フォルダを選択…
          </button>
        </div>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('structure')
  // 構造モードで選んでいたシーン。鑑賞モードを開いたときにそこへ飛ぶ
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // 構造モードで範囲選択している数。ステータスバーに出す(2 件以上のときだけ)
  const [selectedCount, setSelectedCount] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 設定ポップアップを閉じるたびに増える。設定を読んでいる画面の再取得トリガー
  const [settingsVersion, setSettingsVersion] = useState(0)
  const [backendReady, setBackendReady] = useState<boolean | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  // 右下の通知。path があるとクリックで保存先を開ける
  const [toast, setToast] = useState<{ title: string; detail?: string; path?: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 設定ポップアップを閉じるとき、設定を読んでいる画面(モデルバー・構造モード)を同期させる
  const closeSettings = (): void => {
    setSettingsOpen(false)
    setSettingsVersion((v) => v + 1)
  }

  useEffect(() => {
    // ドロップゾーン外への誤ドロップでウィンドウがファイル表示に遷移するのを防ぐ
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  useEffect(() => {
    // F12 スクリーンショット保存の通知。クリックする余裕を持たせるため長めに出す
    const off = window.storyGraph.onScreenshotSaved((path) => {
      setToast({ title: '📷 スクリーンショットを保存', detail: baseName(path), path })
      if (toastTimer.current) clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToast(null), 6000)
    })
    return off
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  const dismissToast = (): void => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(null)
  }

  // 通知クリック: 保存先フォルダをエクスプローラーで開き、通知を閉じる
  const openToastPath = (): void => {
    if (!toast?.path) return
    void window.storyGraph.revealInFolder(toast.path)
    dismissToast()
  }

  useEffect(() => {
    let cancelled = false
    const tryInit = async (attempt: number): Promise<void> => {
      // initApi 自体の例外(IPC 失敗など)もリトライ / エラー表示の経路に乗せる
      let baseUrl: string | null = null
      let error: string | null = null
      try {
        ;({ baseUrl, error } = await initApi())
      } catch (e) {
        error = String(e)
      }
      if (cancelled) return
      if (baseUrl) {
        // 再利用した sidecar が別のライブラリを開いている場合に備えて同期する
        try {
          const [info, lib] = await Promise.all([window.storyGraph.getLibraryInfo(), api.getLibrary()])
          if (lib.root === null || normalizePath(lib.root) !== normalizePath(info.current)) {
            await api.switchLibrary(info.current)
          }
        } catch (e) {
          console.error('library sync failed:', e)
        }
        if (cancelled) return
        setBackendReady(true)
        setBackendError(null)
        return
      }
      if (attempt < 20) {
        setTimeout(() => void tryInit(attempt + 1), 1000)
      } else {
        setBackendReady(false)
        setBackendError(error)
      }
    }
    void tryInit(0)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg)' }}>
      {/* 上部バー: 左=ライブラリ / 中央=モデル選択 / 右=backend状態 + 設定 */}
      <header
        className="relative z-30 flex h-10 shrink-0 items-center border-b px-3"
        style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
      >
        <div className="absolute left-3 top-1/2 -translate-y-1/2">
          {backendReady === true && <LibraryMenu />}
        </div>
        <div className="mx-auto flex items-center">
          {backendReady === true && <ModelBar refreshKey={settingsVersion} />}
        </div>
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-3">
          <button
            onClick={() => setSettingsOpen(true)}
            disabled={backendReady !== true}
            className="rounded-lg p-1.5 transition-colors disabled:opacity-40"
            style={{ color: 'var(--text-dim)' }}
            title="設定"
          >
            <GearIcon />
          </button>
        </div>
      </header>
      {/* 下段メニューバー: モード切替 */}
      <nav
        className="flex h-9 shrink-0 items-center gap-1 border-b px-3"
        style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className="rounded-lg px-3 py-1 text-[13px] transition-colors"
            style={
              mode === m.id
                ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                : { color: 'var(--text-dim)' }
            }
          >
            {m.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {backendReady === false ? (
          <div className="flex h-full items-center justify-center">
            <div
              className="max-w-lg rounded-2xl border p-6 text-[13px] leading-relaxed"
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              バックエンドの起動に失敗しました。
              <br />
              {backendError}
            </div>
          </div>
        ) : backendReady === null ? (
          <div className="flex h-full items-center justify-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
            バックエンドを起動しています…
          </div>
        ) : (
          <>
            {mode === 'structure' && (
              <StructureMode
                settingsVersion={settingsVersion}
                onSelectedNodeChange={setSelectedNodeId}
                onSelectionCountChange={setSelectedCount}
              />
            )}
            {mode === 'reader' && <ReaderMode focusNodeId={selectedNodeId} />}
            {mode === 'characters' && <CharactersMode />}
          </>
        )}
      </div>
      <StatusBar backendReady={backendReady === true} selectedCount={selectedCount} />
      {/* 設定ポップアップ */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={closeSettings}
        >
          <div
            className="flex h-[85vh] w-[900px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center justify-between border-b px-4 py-2.5"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                設定
              </span>
              <button
                onClick={closeSettings}
                className="rounded-md px-2 py-1 text-[15px] leading-none"
                style={{ color: 'var(--text-dim)' }}
                title="閉じる"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <SettingsMode />
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div
          className="fixed bottom-10 right-4 z-50 flex w-[300px] items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[12px] shadow-lg shadow-black/40"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text)' }}
        >
          <button
            onClick={openToastPath}
            disabled={!toast.path}
            className="min-w-0 flex-1 text-left"
            title={toast.path ?? undefined}
          >
            <div className="truncate font-medium">{toast.title}</div>
            {toast.detail && (
              <div className="truncate text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {toast.detail}
              </div>
            )}
            {toast.path && (
              <div className="mt-1 text-[11px]" style={{ color: 'var(--accent)' }}>
                クリックで保存先を開く
              </div>
            )}
          </button>
          <button
            onClick={dismissToast}
            className="shrink-0 rounded-md px-1 leading-none"
            style={{ color: 'var(--text-faint)' }}
            title="閉じる"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
