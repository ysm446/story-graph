import { useEffect, useRef, useState } from 'react'
import type { ChatSummary } from './api'
import type { Character } from './types'
import CharAvatar from './CharAvatar'
import { Icon } from './icons'

/** 相談・制作で共用する会話一覧。ボタンの真下にポップオーバーで出す。履歴の保存処理は呼び出し側が持つ。 */
export default function ChatHistoryPanel({ history, chatId, busy, characters = [], production = false,
  chatLabel, startNewChat, loadChat, deleteChat, commitRename, newChatTip }: {
  history: ChatSummary[]
  chatId: string | null
  busy: boolean
  characters?: Character[]
  production?: boolean
  chatLabel: (chat: ChatSummary) => string
  startNewChat: () => void
  loadChat: (id: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  commitRename: (id: string, title: string) => Promise<void>
  newChatTip: string
}): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const activeChat = history.find((chat) => chat.id === chatId)
  const activeChatLabel = activeChat ? chatLabel(activeChat) : chatId ? '会話を読み込み中…' : '新しい会話'
  const finishRename = async (id: string): Promise<void> => {
    if (busy || renamingId !== id) return
    setRenamingId(null)
    await commitRename(id, renameText.trim())
  }
  useEffect(() => { if (busy) { setMenuOpenId(null); setRenamingId(null) } }, [busy])
  // サイドバーの ⋯ メニューは、外側クリックと Escape で閉じる
  useEffect(() => {
    if (!menuOpenId) return
    const close = (): void => setMenuOpenId(null)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close()
    }
    // メニュー項目の onClick より後に閉じたいので click(bubble)で拾う
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpenId])
  // 一覧のポップオーバーは、外側のクリックと Escape で閉じる。行の ⋯ メニューや名前変更の
  // 入力が開いている間の Escape はそちらを閉じるだけにする
  const rootRef = useRef<HTMLDivElement>(null)
  const innerOpen = !!menuOpenId || !!renamingId
  useEffect(() => {
    if (!historyOpen) return
    const onDown = (ev: MouseEvent): void => {
      if (!rootRef.current?.contains(ev.target as Node)) setHistoryOpen(false)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && !innerOpen) setHistoryOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [historyOpen, innerOpen])
  return <>
      <div ref={rootRef} className="relative flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-1" style={{ borderColor: 'var(--border)' }}>
        <button onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen} aria-haspopup="dialog"
          className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
          style={historyOpen
            ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
            : { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          data-tip={historyOpen ? '会話一覧を閉じる' : '会話一覧を開く'}>会話一覧</button>
        <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--text)' }}
          data-tip={activeChatLabel}>{activeChatLabel}</span>
      {historyOpen && <aside role="dialog" aria-label="会話一覧"
        className="absolute left-2 right-2 top-full z-50 mt-1 flex max-w-[360px] flex-col rounded-xl border shadow-lg shadow-black/40"
        style={{ maxHeight: 'min(320px, 60vh)', background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}>
        <button
          onClick={() => { setHistoryOpen(false); startNewChat() }}
          disabled={busy}
          className="m-2 rounded-lg border px-2 py-1 text-[12px] disabled:opacity-50"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          data-tip={newChatTip}
        >
          + 新しい会話
        </button>
        <div
          className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          onKeyDown={(e) => {
            // 会話一覧にフォーカスがあるときの Delete は選択中の会話の削除。
            // stopPropagation で構造モードの Delete(ノード削除)に届かせない
            if (e.key !== 'Delete') return
            const target = e.target as HTMLElement
            if (target.tagName === 'INPUT') return // 名前変更中は文字の削除に任せる
            if (!chatId || busy) return
            e.preventDefault()
            e.stopPropagation()
            void deleteChat(chatId)
          }}
        >
          {history.length === 0 && (
            <div className="px-1 py-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              まだ会話がありません
            </div>
          )}
          {history.map((h) => {
            const active = h.id === chatId
            // キャラ会話は本人のアイコンで示す。線画の仮面だと小さくて見分けが
            // つきにくいので、色と顔がそのまま出るアバターを使う
            const char = h.char_id ? characters.find((c) => c.id === h.char_id) ?? null : null
            const isRoom = h.mode === 'room'
            const subLabel = isRoom
              ? h.participant_names?.join('・') ?? ''
              : h.char_name
                ? `${h.char_name} / `
                : ''
            return (
              <div
                key={h.id}
                className="group relative mb-0.5 flex items-center gap-1 rounded-md pr-1"
                style={active ? { background: 'var(--accent-soft)' } : undefined}
              >
                {renamingId === h.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => void finishRename(h.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void finishRename(h.id)
                      }
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    placeholder="会話名(空で既定に戻す)"
                    className="min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[11px] outline-none"
                    style={{ background: 'var(--bg-input)', borderColor: 'var(--accent-border)' }}
                  />
                ) : (
                  <>
                    <button
                      onClick={() => { setHistoryOpen(false); void loadChat(h.id) }}
                      disabled={busy}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left disabled:opacity-50"
                      data-tip={production ? chatLabel(h) : `${isRoom ? subLabel + ' / ' : h.char_name ? h.char_name + ' / ' : ''}${production ? '制作' : h.anchor_title || '(シーンなし)'} まで`}
                    >
                      {/* 相手の目印。キャラ会話はアバター、会話室は二人のアイコン、相談チャットは吹き出し。
                          幅を揃えて見出しの開始位置がずれないようにする */}
                      <span
                        className="flex w-5 shrink-0 items-center justify-center"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        {char ? (
                          <CharAvatar char={char} size={20} />
                        ) : isRoom ? (
                          <Icon name="users" size={15} />
                        ) : h.char_name ? (
                          <Icon name="mask" size={16} />
                        ) : (
                          <Icon name="chat" size={14} className="opacity-70" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-[12px]"
                          style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}
                        >
                          {chatLabel(h)}
                        </span>
                        <span
                          className="block truncate text-[10px]"
                          style={{ color: 'var(--text-faint)' }}
                        >
                          {isRoom ? `${subLabel} / ` : subLabel}
                          {production ? '制作' : h.anchor_title || '(シーンなし)'}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation() // window の click(外側クリックで閉じる)より先に処理する
                        setMenuOpenId((v) => (v === h.id ? null : h.id))
                      }}
                      className="shrink-0 rounded px-1 text-[13px] opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
                      style={{ color: 'var(--text-faint)', opacity: menuOpenId === h.id ? 1 : undefined }}
                      disabled={busy}
                      aria-label="この会話の操作"
                      data-tip="この会話の操作"
                    >
                      ⋯
                    </button>
                  </>
                )}
                {menuOpenId === h.id && (
                  <div
                    className="absolute right-1 top-full z-20 w-36 overflow-hidden rounded-lg border py-1 shadow-xl shadow-black/40"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
                  >
                    <button
                      disabled={busy}
                      onClick={() => {
                        setMenuOpenId(null)
                        setRenameText(h.title ?? '')
                        setRenamingId(h.id)
                      }}
                      className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--accent-soft)]"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      名前を変更
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => { setMenuOpenId(null); void deleteChat(h.id) }}
                      className="delete-action block w-full px-3 py-1.5 text-left text-[12px]"
                    >
                      削除
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>}
      </div>
  </>
}
