import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CharAvatar from './CharAvatar'
import { Icon, type IconName } from './icons'
import type { Character } from './types'

/** メニューの 1 項目。char があればそのキャラのアイコン、無ければ icon の線画を出す。 */
export interface IconPickerItem {
  value: string
  /** メニューの行に出す名前 */
  label: string
  /** ボタンに出す文言(省略時は label) */
  buttonLabel?: string
  char?: Character
  icon?: IconName
}

/** アイコンと名前で 1 つ選ぶメニュー(標準の select の代わり)。
 *
 * 標準の select は option に画像を置けないので、キャラをアイコンと名前で選べるよう自前で持つ。
 * チャット欄のスクロール領域の中で使うため、メニューは body へ出して fixed で置く
 * (absolute だと領域の端で切り取られる。docs/design/style-guide.md の「アイコン付きの選択メニュー」)。
 *
 * items は上から並べる順。キャラでない項目(icon)からキャラの項目(char)へ変わるところに区切り線を引く。
 */
export function IconPicker({
  name,
  value,
  items,
  disabled,
  tip,
  disabledTip,
  tall = false,
  onChange
}: {
  /** 何を選ぶ欄か(読み上げ用。「話す相手」など) */
  name: string
  value: string
  items: IconPickerItem[]
  disabled: boolean
  tip: string
  /** 無効のときに出す理由 */
  disabledTip: string
  /** 入力欄の行に置くときの高さ(py-1)。既定は見出しの行の高さ(py-0.5) */
  tall?: boolean
  onChange: (next: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const current = items.find((item) => item.value === value) ?? items[0]

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
  }, [open, items.length])

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
    if (next !== value) onChange(next)
  }

  // 行の左の印は 24px の枠に揃える(キャラのアイコンと、キャラでない項目の線画アイコンの位置を合わせる)
  const mark = (item: IconPickerItem, size: number): React.JSX.Element =>
    item.char ? (
      <CharAvatar char={item.char} size={size} />
    ) : (
      <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size, color: 'var(--text-dim)' }}>
        <Icon name={item.icon ?? 'chat'} size={Math.round(size * 0.7)} />
      </span>
    )

  const row = (item: IconPickerItem, index: number): React.JSX.Element => (
    <div key={item.value || '-'}>
      {index > 0 && item.char && !items[index - 1].char && <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />}
      <button
        type="button"
        role="option"
        aria-selected={item.value === value}
        onClick={() => pick(item.value)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[var(--accent-soft)]"
        style={item.value === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
      >
        {mark(item, 24)}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
    </div>
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
        aria-label={`${name}: ${current.label}`}
        className={`inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md border pl-1 pr-1.5 text-[11px] disabled:opacity-50 ${tall ? 'py-1' : 'py-0.5'}`}
        style={{
          background: open ? 'var(--accent-soft)' : 'var(--bg-input)',
          borderColor: current.char?.color || 'var(--border)',
          color: open ? 'var(--text)' : 'var(--text-dim)'
        }}
        data-tip={disabled ? disabledTip : tip}
      >
        {mark(current, 20)}
        <span className="min-w-0 truncate">{current.buttonLabel ?? current.label}</span>
        <span aria-hidden className="shrink-0 text-[9px]" style={{ color: 'var(--text-faint)' }}>▾</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={name}
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
            {items.map(row)}
          </div>,
          document.body
        )}
    </>
  )
}

/** 相談チャットで話す相手を選ぶ(相談(編集者)/ キャラ同士の会話 / キャラ本人)。
 *  value: '' = 相談(編集者)、'room' = キャラ同士の会話、それ以外はキャラ ID。 */
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
  return (
    <IconPicker
      name="話す相手"
      value={value}
      disabled={disabled}
      onChange={(next) => onChange(next || null)}
      tip="話す相手。キャラを選ぶと、アンカー時点のそのキャラ本人と話せます。「キャラ同士の会話」は作者は参加せず、演出の指示だけ出します"
      disabledTip="返事が終わるか停止してから切り替えられます"
      items={[
        { value: '', label: '相談(編集者)', icon: 'chat' },
        { value: 'room', label: 'キャラ同士の会話', icon: 'users' },
        ...characters.map((c) => ({ value: c.id, label: c.name, buttonLabel: `${c.name}と話す`, char: c }))
      ]}
    />
  )
}
