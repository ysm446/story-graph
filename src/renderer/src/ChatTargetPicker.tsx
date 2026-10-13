import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CharAvatar from './CharAvatar'
import { Icon } from './icons'
import type { Character } from './types'

/** 相談チャットで話す相手を選ぶメニュー(相談(編集者)/ キャラ同士の会話 / キャラ本人)。
 *
 * 標準の select は option に画像を置けないので、キャラをアイコンと名前で選べるよう自前で持つ。
 * チャット欄のスクロール領域の中にあるため、メニューは body へ出して fixed で置く
 * (absolute だと領域の端で切り取られる。docs/design/style-guide.md のポップオーバーの項)。
 *
 * value: '' = 相談(編集者)、'room' = キャラ同士の会話、それ以外はキャラ ID。
 */
export default function ChatTargetPicker({
  value,
  characters,
  disabled,
  onChange
}: {
  value: string
  characters: Character[]
  disabled: boolean
  onChange: (next: string | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const active = characters.find((c) => c.id === value) ?? null

  // 実寸を測ってから置く。下に入りきらなければボタンの上へ、右にはみ出すなら左へ寄せる
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const button = buttonRef.current?.getBoundingClientRect()
    const menu = menuRef.current?.getBoundingClientRect()
    if (!button || !menu) return
    const below = button.bottom + 4
    const top = below + menu.height <= window.innerHeight - 8 ? below : Math.max(8, button.top - menu.height - 4)
    const left = Math.max(8, Math.min(button.left, window.innerWidth - menu.width - 8))
    setPosition({ left, top })
  }, [open, characters.length])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      close()
      buttonRef.current?.focus()
    }
    // メニューの中のスクロールでは閉じない(人数が多いとき)。外側が動いたら位置がずれるので閉じる
    const onScroll = (event: Event): void => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const pick = (next: string): void => {
    setOpen(false)
    if (next !== value) onChange(next || null)
  }

  // 行の左の印は 24px の枠に揃える(キャラのアイコンと、編集者・会話室の線画アイコンの位置を合わせる)
  const mark = (target: string, size: number): React.JSX.Element => {
    const char = characters.find((c) => c.id === target)
    if (char) return <CharAvatar char={char} size={size} />
    return (
      <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size, color: 'var(--text-dim)' }}>
        <Icon name={target === 'room' ? 'users' : 'chat'} size={Math.round(size * 0.7)} />
      </span>
    )
  }
  const label = (target: string): string =>
    target === '' ? '相談(編集者)' : target === 'room' ? 'キャラ同士の会話' : (characters.find((c) => c.id === target)?.name ?? target)

  const row = (target: string): React.JSX.Element => (
    <button
      key={target || 'editor'}
      type="button"
      role="option"
      aria-selected={target === value}
      onClick={() => pick(target)}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[var(--accent-soft)]"
      style={target === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
    >
      {mark(target, 24)}
      <span className="min-w-0 flex-1 truncate">{label(target)}</span>
    </button>
  )

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`話す相手: ${label(value)}`}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border py-0.5 pl-1 pr-1.5 text-[11px] disabled:opacity-50"
        style={{
          background: open ? 'var(--accent-soft)' : 'var(--bg-input)',
          borderColor: active?.color || 'var(--border)',
          color: open ? 'var(--text)' : 'var(--text-dim)'
        }}
        data-tip={
          disabled
            ? '返事が終わるか停止してから切り替えられます'
            : '話す相手。キャラを選ぶと、アンカー時点のそのキャラ本人と話せます。「キャラ同士の会話」は作者は参加せず、演出の指示だけ出します'
        }
      >
        {mark(value, 20)}
        <span className="min-w-0 truncate">{active ? `${active.name}と話す` : label(value)}</span>
        <span aria-hidden className="shrink-0 text-[9px]" style={{ color: 'var(--text-faint)' }}>▾</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="話す相手"
            className="inspector-scrollbar fixed z-50 w-60 overflow-y-auto rounded-xl border p-1.5 shadow-lg shadow-black/40"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              // 位置が決まるまでの 1 フレームは見せない(左上に一瞬出るのを防ぐ)
              visibility: position ? 'visible' : 'hidden',
              maxHeight: 'min(320px, 60vh)',
              background: 'var(--bg-card)',
              borderColor: 'var(--border-strong)'
            }}
          >
            {row('')}
            {row('room')}
            {characters.length > 0 && <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />}
            {characters.map((c) => row(c.id))}
          </div>,
          document.body
        )}
    </>
  )
}
