import { useEffect, useRef, useState } from 'react'
import { api, chatApi, chatSendStream, isAbortError, type ChatStreamEvent, type ChatSummary } from './api'
import { Markdown } from './Markdown'
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

// 定型質問。読み取り3ツール(get_beats / get_state / search_memories)と
// propose_beats が一通り使われる並びにしている。詳細は docs/design/chat.md
const TEMPLATES: { label: string; text: string }[] = [
  { label: '流れを要約', text: 'ここまでの流れを3行で要約して。' },
  { label: '状態を要約', text: '現在の各キャラの状態(facts と関係)を要約して。' },
  { label: '関係の変化', text: '関係値が大きく動いたところと、その理由を挙げて。' },
  { label: '未回収の伏線', text: '未回収の伏線・約束・謎を洗い出して。' },
  { label: '矛盾チェック', text: 'キャラの言動と facts に矛盾がないか点検して。' },
  { label: '展開を提案', text: 'この先の展開を3案提案して。' }
]
const TEMPLATE_WINDOW = 3 // 同時に見せる件数
const MAX_DYNAMIC = 2 // うち、内容から生成された質問に使う枠

export default function ChatDrawer({
  selectedId,
  canonTailId,
  nodesById,
  characters,
  onGraphChanged,
  open,
  onClose,
  dynamicSuggestions
}: {
  selectedId: string | null
  canonTailId: string | null
  nodesById: Record<string, StoryNode>
  characters: Character[]
  onGraphChanged: () => void
  // 開閉と高さは親(構造モード)が持つ。相談チャットはノードエリアとの
  // 分割ペインなので、レイアウトの権限を親側に集約している
  open: boolean
  onClose: () => void
  // 設定「内容から質問候補を作る」。オフなら生成も表示もしない
  dynamicSuggestions: boolean
}): React.JSX.Element | null {
  const [chatId, setChatId] = useState<string | null>(null)
  const [anchorNode, setAnchorNode] = useState<string | null>(null)
  const [scope, setScope] = useState<'upto' | 'all'>('upto')
  const [items, setItems] = useState<DisplayItem[]>([])
  const [liveText, setLiveText] = useState('') // ストリーミング中の回答(確定前)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [history, setHistory] = useState<ChatSummary[]>([])
  const [insertedTitles, setInsertedTitles] = useState<Set<string>>(new Set())
  // 候補チップは常に入力欄の右上に積む。全部出すと縦を食うので窓を 3 件に
  // 絞り、⟳ で次の 3 件へ送る(ランダムではなく決まった順。docs/design/chat.md)
  const [templateOffset, setTemplateOffset] = useState(0)
  // 内容から作られた質問(最大 2 件。固定の候補の下=入力欄側に出す)
  const [dynamicQuestions, setDynamicQuestions] = useState<string[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const busyElapsed = useElapsedSeconds(busy)

  const dynamicShown = dynamicSuggestions ? dynamicQuestions.slice(0, MAX_DYNAMIC) : []
  // 固定の候補で残りの枠を埋める(固定が上、生成された質問が下)
  const chips = [
    ...Array.from(
      { length: Math.max(TEMPLATE_WINDOW - dynamicShown.length, 0) },
      (_, i) => ({ text: TEMPLATES[(templateOffset + i) % TEMPLATES.length].text, dynamic: false })
    ),
    ...dynamicShown.map((text) => ({ text, dynamic: true }))
  ]

  // 内容ベースの質問候補を取り直す。失敗・未起動・設定オフはすべて無視して
  // 固定の候補のまま(バックエンドが空配列を返す)
  const refreshSuggestions = async (cid: string | null, anchor: string | null): Promise<void> => {
    if (!dynamicSuggestions) return
    try {
      const res = await chatApi.suggestQuestions({ chat_id: cid, anchor_node: anchor, scope })
      if (res.questions.length > 0) setDynamicQuestions(res.questions)
    } catch {
      /* 候補は無くても困らないので黙って諦める */
    }
  }

  useEffect(() => {
    if (open) void chatApi.list().then(setHistory).catch(() => setHistory([]))
  }, [open])

  // 開いたタイミング(と設定変更時)に一度生成しておく
  useEffect(() => {
    if (!open || !dynamicSuggestions) return
    void refreshSuggestions(chatId, anchorNode ?? selectedId ?? canonTailId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dynamicSuggestions])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items, status, liveText])

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
    const anchor = selectedId ?? canonTailId
    setAnchorNode(anchor)
    setDynamicQuestions([]) // 新しいアンカーの候補を取り直す
    void refreshSuggestions(null, anchor)
  }

  const loadChat = async (id: string): Promise<void> => {
    const chat = await chatApi.get(id)
    setChatId(chat.id)
    setAnchorNode(chat.anchor_node)
    setScope(chat.scope === 'all' ? 'all' : 'upto')
    setInsertedTitles(new Set())
    setDynamicQuestions([])
    void refreshSuggestions(chat.id, chat.anchor_node)
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

  const send = async (override?: string): Promise<void> => {
    const message = (override ?? input).trim()
    if (!message || busy) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setInput('')
    setItems((prev) => [...prev, { kind: 'user', text: message }])
    setStatus('考え中…')
    const effectiveAnchor = chatId ? anchorNode : anchorNode ?? selectedId ?? canonTailId
    if (!chatId) setAnchorNode(effectiveAnchor)
    // ストリーミング中のテキストは closure 変数で持ち、確定時に items へ移す
    let live = ''
    let latestChatId = chatId
    const flushLive = (): void => {
      if (!live) return
      const text = live
      live = ''
      setLiveText('')
      setItems((prev) => [...prev, { kind: 'assistant', text }])
    }
    try {
      await chatSendStream(
        { chat_id: chatId, anchor_node: effectiveAnchor, scope, message },
        (e: ChatStreamEvent) => {
          if (e.chat_id) {
            latestChatId = e.chat_id
            setChatId(e.chat_id)
          }
          if (e.stage === 'thinking') setStatus('考え中…')
          if (e.delta) {
            live += e.delta
            setLiveText(live)
            setStatus(null)
          }
          if (e.tool_call) {
            const name = e.tool_call.name
            flushLive() // ツール実行前までの途中テキストを確定させる
            setStatus(`調査中: ${name}`)
            if (name !== 'propose_beats') setItems((prev) => [...prev, { kind: 'tool', name }])
          }
          if (e.proposals?.length) {
            setItems((prev) => [...prev, { kind: 'proposals', proposals: e.proposals! }])
          }
          if (e.answer !== undefined) {
            setStatus(null)
            live = ''
            setLiveText('')
            if (e.answer) setItems((prev) => [...prev, { kind: 'assistant', text: e.answer! }])
          }
          if (e.error) setStatus(`エラー: ${e.error}`)
        },
        controller.signal
      )
    } catch (err) {
      setStatus(isAbortError(err) ? 'キャンセルしました(途中の回答は保存されません)' : String(err))
    } finally {
      abortRef.current = null
      setBusy(false)
      setLiveText('')
      // 回答後に、会話を踏まえたフォローアップ質問へ差し替える
      void refreshSuggestions(latestChatId, effectiveAnchor)
    }
  }

  const deleteCurrentChat = async (): Promise<void> => {
    if (!chatId || busy) return
    if (!window.confirm('このチャット履歴を削除しますか?')) return
    try {
      await chatApi.delete(chatId)
    } catch {
      // 未保存(空)のチャットなどは無視して画面だけリセット
    }
    setHistory((prev) => prev.filter((h) => h.id !== chatId))
    startNewChat()
  }

  const clearAllChats = async (): Promise<void> => {
    if (busy) return
    const list = await chatApi.list().catch(() => history)
    if (list.length === 0 && !chatId) return
    if (!window.confirm(`保存済みのチャット履歴をすべて削除しますか?(${list.length}件)`)) return
    await Promise.all(list.map((h) => chatApi.delete(h.id).catch(() => undefined)))
    setHistory([])
    startNewChat()
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

  if (!open) return null

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-chat)' }}>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-2">
          {/* ヘッダー: アンカー / スコープ / 履歴 */}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            <span style={{ color: 'var(--text-dim)' }}>💬 相談チャット</span>
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
            {chatId && (
              <button
                onClick={() => void deleteCurrentChat()}
                disabled={busy}
                className="rounded-md border px-2 py-0.5 disabled:opacity-40"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--danger)' }}
                title="表示中のチャット履歴を削除"
              >
                削除
              </button>
            )}
            {(history.length > 0 || chatId) && (
              <button
                onClick={() => void clearAllChats()}
                disabled={busy}
                className="rounded-md border px-2 py-0.5 disabled:opacity-40"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                title="保存済みのチャット履歴をすべて削除"
              >
                全クリア
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md border px-2 py-0.5"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
              title="相談チャットを閉じる(履歴は残ります)"
            >
              ✕ 閉じる
            </button>
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
                      className="max-w-[80%] rounded-2xl rounded-bl-md border px-3 py-1.5 text-[13px] leading-relaxed"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
                    >
                      <Markdown text={item.text} />
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
            {liveText && (
              <div className="mb-2 flex">
                <div
                  className="max-w-[80%] rounded-2xl rounded-bl-md border px-3 py-1.5 text-[13px] leading-relaxed"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
                >
                  <Markdown text={liveText} />
                  <span
                    className="ml-0.5 inline-block h-3.5 w-1.5 align-middle"
                    style={{ background: 'var(--accent)' }}
                  />
                </div>
              </div>
            )}
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
          {/* 候補チップ(常時表示。右下に縦積み。クリックで即送信) */}
          <div className="mt-2 flex flex-col items-end gap-1.5">
            {chips.map((c) => (
              <button
                key={c.text}
                onClick={() => void send(c.text)}
                disabled={busy}
                className="chat-suggest-chip max-w-full truncate rounded-full border px-3 py-1 text-[11px] disabled:opacity-40"
                style={{
                  background: 'var(--bg-card)',
                  borderColor: c.dynamic ? 'var(--accent-border)' : 'var(--border-strong)',
                  color: c.dynamic ? 'var(--text)' : 'var(--text-dim)'
                }}
                title={c.dynamic ? `${c.text}(物語の内容から作られた質問)` : c.text}
              >
                {c.dynamic ? `✨ ${c.text}` : c.text}
              </button>
            ))}
          </div>
          {/* 入力 */}
          <div className="mt-1.5 flex items-end gap-2">
            <textarea
              ref={inputRef}
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
            <button
              onClick={() => setTemplateOffset((v) => (v + TEMPLATE_WINDOW) % TEMPLATES.length)}
              className="shrink-0 rounded-lg border px-2.5 py-1.5 text-[13px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
              title="ほかの候補を見る"
            >
              ⟳
            </button>
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
    </div>
  )
}
