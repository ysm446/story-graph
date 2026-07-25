import { useEffect, useRef, useState } from 'react'
import { api, chatApi, chatSendStream, isAbortError, type ChatStreamEvent, type ChatSummary } from './api'
import type { Character, StoryNode } from './types'
import { useElapsedSeconds } from './useElapsed'

interface Proposal {
  title: string
  beat: string
  emotional_core?: string
  cast?: string[]
  location?: string
}

type DisplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'proposals'; proposals: Proposal[] }

export default function ChatDrawer({
  selectedId,
  canonTailId,
  nodesById,
  characters,
  onGraphChanged
}: {
  selectedId: string | null
  canonTailId: string | null
  nodesById: Record<string, StoryNode>
  characters: Character[]
  onGraphChanged: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [chatId, setChatId] = useState<string | null>(null)
  const [anchorNode, setAnchorNode] = useState<string | null>(null)
  const [scope, setScope] = useState<'upto' | 'all'>('upto')
  const [items, setItems] = useState<DisplayItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [history, setHistory] = useState<ChatSummary[]>([])
  const [insertedTitles, setInsertedTitles] = useState<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const busyElapsed = useElapsedSeconds(busy)

  useEffect(() => {
    if (open) void chatApi.list().then(setHistory).catch(() => setHistory([]))
  }, [open])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items, status])

  const nameOf = (id: string): string => characters.find((c) => c.id === id)?.name ?? id
  const anchorTitle = (id: string | null): string => {
    if (!id) return '(シーンなし)'
    const node = nodesById[id]
    return node ? node.title || '(無題)' : id
  }

  const startNewChat = (): void => {
    setChatId(null)
    setItems([])
    setInsertedTitles(new Set())
    setAnchorNode(selectedId ?? canonTailId)
  }

  const loadChat = async (id: string): Promise<void> => {
    const chat = await chatApi.get(id)
    setChatId(chat.id)
    setAnchorNode(chat.anchor_node)
    setScope(chat.scope === 'all' ? 'all' : 'upto')
    setInsertedTitles(new Set())
    const display: DisplayItem[] = []
    for (const m of chat.messages) {
      const role = m.role as string
      if (role === 'user') {
        const text = String(m.content ?? '')
        if (!text.startsWith('(これ以上ツールは使えません')) display.push({ kind: 'user', text })
      } else if (role === 'assistant') {
        const toolCalls = m.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined
        if (toolCalls) {
          for (const tc of toolCalls) {
            const name = tc.function?.name ?? ''
            if (name === 'propose_beats') {
              try {
                const args = JSON.parse(tc.function?.arguments ?? '{}') as { proposals?: Proposal[] }
                if (args.proposals?.length) display.push({ kind: 'proposals', proposals: args.proposals })
              } catch {
                // 引数が壊れている場合は無視
              }
            } else if (name) {
              display.push({ kind: 'tool', name })
            }
          }
        }
        if (m.content) display.push({ kind: 'assistant', text: String(m.content) })
      }
    }
    setItems(display)
  }

  const send = async (): Promise<void> => {
    const message = input.trim()
    if (!message || busy) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setInput('')
    setItems((prev) => [...prev, { kind: 'user', text: message }])
    setStatus('考え中…')
    const effectiveAnchor = chatId ? anchorNode : anchorNode ?? selectedId ?? canonTailId
    if (!chatId) setAnchorNode(effectiveAnchor)
    try {
      await chatSendStream(
        { chat_id: chatId, anchor_node: effectiveAnchor, scope, message },
        (e: ChatStreamEvent) => {
          if (e.chat_id) setChatId(e.chat_id)
          if (e.stage === 'thinking') setStatus('考え中…')
          if (e.tool_call) {
            const name = e.tool_call.name
            setStatus(`調査中: ${name}`)
            if (name !== 'propose_beats') setItems((prev) => [...prev, { kind: 'tool', name }])
          }
          if (e.proposals?.length) {
            setItems((prev) => [...prev, { kind: 'proposals', proposals: e.proposals! }])
          }
          if (e.answer !== undefined) {
            setStatus(null)
            if (e.answer) setItems((prev) => [...prev, { kind: 'assistant', text: e.answer! }])
          }
          if (e.error) setStatus(`エラー: ${e.error}`)
        },
        controller.signal
      )
    } catch (err) {
      setStatus(isAbortError(err) ? 'キャンセルしました' : String(err))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  const insertProposal = async (proposal: Proposal): Promise<void> => {
    // cast は ID or 名前で来る可能性があるため、登録キャラに解決できたものだけ使う
    const cast = (proposal.cast ?? [])
      .map((entry) => characters.find((c) => c.id === entry || c.name === entry)?.id)
      .filter((id): id is string => !!id)
    await api.createNode({
      title: proposal.title,
      beat: proposal.beat,
      emotional_core: proposal.emotional_core,
      cast,
      location: proposal.location,
      parent_id: anchorNode ?? undefined,
      draft: true
    })
    setInsertedTitles((prev) => new Set(prev).add(proposal.title))
    onGraphChanged()
  }

  return (
    <div className="shrink-0 border-t" style={{ background: 'var(--bg-chat)', borderColor: 'var(--border)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-[12px]"
        style={{ color: 'var(--text-faint)' }}
      >
        <span>{open ? '▾' : '▴'}</span> 相談チャット
        {!open && chatId && (
          <span className="truncate" style={{ color: 'var(--text-dim)' }}>
            (継続中: {anchorTitle(anchorNode)} まで)
          </span>
        )}
      </button>
      {open && (
        <div className="flex h-80 flex-col px-4 pb-3">
          {/* ヘッダー: アンカー / スコープ / 履歴 */}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            <span>
              アンカー: <span style={{ color: 'var(--text-dim)' }}>{anchorTitle(chatId ? anchorNode : anchorNode ?? selectedId ?? canonTailId)}</span> まで
            </span>
            <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
              {(['upto', 'all'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => !chatId && setScope(s)}
                  disabled={!!chatId}
                  className="px-2 py-0.5 disabled:cursor-not-allowed"
                  style={
                    scope === s
                      ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                      : { color: 'var(--text-faint)' }
                  }
                  title={chatId ? 'スコープはチャット開始時に固定されます(変えるには新規)' : s === 'upto' ? 'アンカーまでの情報のみ' : '物語全体'}
                >
                  {s === 'upto' ? 'ここまで' : '全体'}
                </button>
              ))}
            </div>
            <button
              onClick={startNewChat}
              className="rounded-md border px-2 py-0.5"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              title="選択中のシーンをアンカーに新しいチャットを開始"
            >
              + 新規
            </button>
            <select
              value={chatId ?? ''}
              onChange={(e) => {
                if (e.target.value) void loadChat(e.target.value)
              }}
              className="ml-auto max-w-56 rounded-md border px-1.5 py-0.5 text-[11px]"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              <option value="">履歴…</option>
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {(h.anchor_title || '(無題)') + ': ' + (h.snippet || '(空)')}
                </option>
              ))}
            </select>
          </div>
          {/* メッセージ */}
          <div ref={scrollRef} className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
            {items.length === 0 && (
              <div className="pt-6 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                物語の状態について質問したり、「この先の展開を提案して」と頼めます。
                <br />
                アンカーより先の情報は見えません(ネタバレ防止)。
              </div>
            )}
            {items.map((item, i) => {
              if (item.kind === 'user') {
                return (
                  <div key={i} className="mb-2 flex justify-end">
                    <div
                      className="max-w-[70%] whitespace-pre-wrap rounded-2xl rounded-br-md px-3 py-1.5 text-[13px]"
                      style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}
                    >
                      {item.text}
                    </div>
                  </div>
                )
              }
              if (item.kind === 'assistant') {
                return (
                  <div key={i} className="mb-2 flex">
                    <div
                      className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-md border px-3 py-1.5 text-[13px] leading-relaxed"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
                    >
                      {item.text}
                    </div>
                  </div>
                )
              }
              if (item.kind === 'tool') {
                return (
                  <div key={i} className="mb-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                    🔍 {item.name}
                  </div>
                )
              }
              return (
                <div key={i} className="mb-2 flex flex-wrap gap-2">
                  {item.proposals.map((p, j) => (
                    <div
                      key={j}
                      className="w-60 rounded-xl border p-2.5"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--accent-border)' }}
                    >
                      <div className="mb-1 text-[12px] font-semibold" style={{ color: 'var(--text)' }}>
                        {p.title}
                      </div>
                      <div className="mb-1.5 line-clamp-4 text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                        {p.beat}
                      </div>
                      {p.cast && p.cast.length > 0 && (
                        <div className="mb-1.5 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                          {p.cast.map(nameOf).join(', ')}
                          {p.location ? ` @${p.location}` : ''}
                        </div>
                      )}
                      <button
                        onClick={() => void insertProposal(p)}
                        disabled={insertedTitles.has(p.title)}
                        className="w-full rounded-md px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                        style={{ background: 'var(--accent)' }}
                      >
                        {insertedTitles.has(p.title) ? '挿入済み' : '⑂ ブランチとして挿入'}
                      </button>
                    </div>
                  ))}
                </div>
              )
            })}
            {status && (
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {status}
                {busy && (
                  <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                    ({busyElapsed}s)
                  </span>
                )}
              </div>
            )}
          </div>
          {/* 入力 */}
          <div className="mt-2 flex gap-2">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="物語について相談…(Enter で送信)"
              className="min-w-0 flex-1 resize-none rounded-lg border px-3 py-1.5 text-[13px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            />
            {busy ? (
              <button
                onClick={() => abortRef.current?.abort()}
                className="rounded-lg border px-3 py-1.5 text-[13px]"
                style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
              >
                ■ 中止
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!input.trim()}
                className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                送信
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
