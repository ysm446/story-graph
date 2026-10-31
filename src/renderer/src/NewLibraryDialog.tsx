import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { libraryNameError } from '../../shared/libraryName'

/** ライブラリの新規作成。場所と名前を入れると、`場所/名前` のフォルダを作って onCreated に渡す。 */
export default function NewLibraryDialog({
  defaultParent,
  onCancel,
  onCreated
}: {
  defaultParent: string
  onCancel: () => void
  onCreated: (root: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [parent, setParent] = useState(defaultParent)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  const trimmedName = name.trim()
  const trimmedParent = parent.trim()
  // 空のうちは「入力してください」を出さない(開いた瞬間からエラーに見えるので)
  const nameError = trimmedName ? libraryNameError(trimmedName) : null
  const canCreate = !!trimmedName && !nameError && !!trimmedParent && !busy
  const destination = `${trimmedParent.replace(/[\\/]+$/, '')}\\${trimmedName}`

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const browse = async (): Promise<void> => {
    const picked = await window.storyGraph.chooseLibraryParent(trimmedParent)
    if (picked) {
      setParent(picked)
      setError(null)
    }
    nameRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    const result = await window.storyGraph.createLibrary(trimmedParent, trimmedName)
    if ('error' in result) {
      setError(result.error)
      setBusy(false)
      return
    }
    onCreated(result.root)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onCancel}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-library-title"
        className="w-[520px] max-w-[92vw] rounded-2xl border p-4 shadow-xl shadow-black/50"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h3 id="new-library-title" className="mb-1 text-[14px] font-semibold">新しいライブラリ</h3>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          物語ごとの作業フォルダを作って開きます。今のライブラリは変更されません。
        </p>
        <label className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }} htmlFor="new-library-name">名前</label>
        <input
          id="new-library-name"
          ref={nameRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          className="w-full rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
        />
        {nameError && <p data-new-library-name-error className="mt-1 text-[12px]" style={{ color: 'var(--danger-text)' }}>{nameError}</p>}
        <label className="mb-1 mt-3 block text-[12px]" style={{ color: 'var(--text-dim)' }} htmlFor="new-library-parent">場所</label>
        <div className="flex items-center gap-2">
          <input
            id="new-library-parent"
            value={parent}
            onChange={(e) => {
              setParent(e.target.value)
              setError(null)
            }}
            className="min-w-0 flex-1 rounded-md border px-2 py-0.5 text-[12px] outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
          />
          <button
            type="button"
            onClick={() => void browse()}
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            参照…
          </button>
        </div>
        {canCreate && (
          <p data-new-library-destination className="mt-2 break-all text-[11px]" style={{ color: 'var(--text-faint)' }}>
            作成先: {destination}
          </p>
        )}
        {error && <p role="alert" className="mt-2 break-all text-[12px]" style={{ color: 'var(--danger-text)' }}>{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            取り消し
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            作成
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
