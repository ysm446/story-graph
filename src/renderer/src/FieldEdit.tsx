import { Icon } from './icons'
import { Markdown } from './Markdown'
import UnsavedBadge from './UnsavedBadge'

/**
 * 資料庫の「読む表示」の部品。資料は読む表示が既定で、鉛筆(または本文)を押した項目だけを
 * 編集欄にし、項目ごとに確定・取り消しする(docs/design/style-guide.md)。
 * 編集欄を包む要素には data-edit-group を付ける(フォーカスとキー操作の単位)。
 */

/** 見出しの横に置く鉛筆。小さいので、本文側(ReadText)からも編集に入れるようにする */
export function EditPencil({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-label={`${label}を編集`}
      data-tip={`${label}を編集`}
      className="shrink-0 rounded-md p-1 hover:bg-[var(--accent-soft)]"
      style={{ color: 'var(--text-faint)' }}
    >
      <Icon name="pen" size={13} />
    </button>
  )
}

/** 編集欄の右下に置く(校正ボタンの下の段)。主な操作の「確定」を右端にする */
export function EditActions({ dirty, saving, blocked, error, onCommit, onCancel }: {
  dirty: boolean
  saving: boolean
  /** 確定できない理由(名前が空など)。あれば確定を無効にしてツールチップに出す */
  blocked?: string
  error?: string
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
      {dirty && <UnsavedBadge />}
      <button
        onClick={onCancel}
        disabled={saving}
        className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        data-tip="この項目の変更を取り消して閉じます(Esc)"
      >
        取り消し
      </button>
      <button
        onClick={onCommit}
        disabled={saving || !!blocked}
        className="accent-action rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
        data-tip={blocked || 'この項目を保存します(Ctrl+Enter)'}
      >
        {saving ? '保存中…' : '確定'}
      </button>
      {error && (
        <p role="alert" className="w-full text-right text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>
      )}
    </div>
  )
}

/** 読む表示の本文。押すと編集に入る(文字を選択してコピーするときは開かない)。空なら書き始める案内を出す */
export function ReadText({ value, emptyLabel, onEdit, markdown = false }: {
  value: string
  emptyLabel: string
  onEdit: () => void
  markdown?: boolean
}): React.JSX.Element {
  if (!value) {
    return (
      <button onClick={onEdit} className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
        + {emptyLabel}を書く
      </button>
    )
  }
  const open = (): void => {
    if (!window.getSelection()?.toString()) onEdit()
  }
  return markdown ? (
    <div data-write-action onClick={open} className="cursor-text text-[13px] leading-relaxed" style={{ color: 'var(--text)' }}>
      <Markdown text={value} />
    </div>
  ) : (
    <p data-write-action onClick={open} className="cursor-text whitespace-pre-wrap text-[13px] leading-relaxed" style={{ color: 'var(--text)' }}>
      {value}
    </p>
  )
}

/** 編集欄を開いた直後に、その単位の最初の入力欄へフォーカスする */
export function focusEditGroup(group: string): void {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-edit-group="${group}"] textarea, [data-edit-group="${group}"] input:not([type="color"]):not([type="file"])`)
      ?.focus()
  })
}

/** 編集欄の中のキー操作。Ctrl+Enter で確定、Esc で取り消し(変換中の Esc は IME に任せる) */
export function editKeys(active: boolean, onCommit: () => void, onCancel: () => void) {
  return (event: React.KeyboardEvent): void => {
    if (!active || event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      onCommit()
    }
  }
}
