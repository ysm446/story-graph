import { useEffect, useState } from 'react'
import { initApi } from './api'
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
        <div className="ml-auto flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-faint)' }}>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background:
                backendReady === true ? '#3ecf8e' : backendReady === false ? 'var(--danger)' : '#8a8fa8'
            }}
          />
          {backendReady === true ? 'backend' : backendReady === false ? 'backend 停止' : '起動中…'}
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
    </div>
  )
}
