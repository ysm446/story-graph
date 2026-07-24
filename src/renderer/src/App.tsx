import { useEffect, useRef, useState } from 'react'
import { api, initApi } from './api'
import StatusBar from './StatusBar'
import StructureMode from './modes/StructureMode'
import ReaderMode from './modes/ReaderMode'
import CharactersMode from './modes/CharactersMode'
import SettingsMode from './modes/SettingsMode'

type Mode = 'structure' | 'reader' | 'characters' | 'settings'

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'structure', label: '構造' },
  { id: 'reader', label: '鑑賞' },
  { id: 'characters', label: 'キャラクター庫' },
  { id: 'settings', label: '設定' }
]

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
        <span style={{ color: 'var(--text-faint)' }}>📁</span>
        <span className="max-w-40 truncate">{current ? baseName(current) : '…'}</span>
        <span style={{ color: 'var(--text-faint)' }}>▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-8 z-50 w-72 rounded-xl border p-1.5 shadow-lg shadow-black/40"
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
  const [backendReady, setBackendReady] = useState<boolean | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const tryInit = async (attempt: number): Promise<void> => {
      const { baseUrl, error } = await initApi()
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
      <header
        className="flex h-10 shrink-0 items-center gap-1 border-b px-3"
        style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
      >
        <span
          className="mr-4 text-[11px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--text-dim)' }}
        >
          Story Graph
        </span>
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
        <div className="ml-auto flex items-center gap-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {backendReady === true && <LibraryMenu />}
          <span className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                background:
                  backendReady === true ? '#3ecf8e' : backendReady === false ? 'var(--danger)' : '#8a8fa8'
              }}
            />
            {backendReady === true ? 'backend' : backendReady === false ? 'backend 停止' : '起動中…'}
          </span>
        </div>
      </header>
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
            {mode === 'structure' && <StructureMode />}
            {mode === 'reader' && <ReaderMode />}
            {mode === 'characters' && <CharactersMode />}
            {mode === 'settings' && <SettingsMode />}
          </>
        )}
      </div>
      <StatusBar backendReady={backendReady === true} />
    </div>
  )
}
