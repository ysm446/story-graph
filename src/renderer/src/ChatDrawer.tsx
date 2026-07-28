import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  assetUrl,
  chatApi,
  chatSendStream,
  isAbortError,
  type ChatStats,
  type ChatStreamEvent,
  type ChatSummary
} from './api'
import { Icon } from './icons'
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

// turn = その項目が属する往復の開始位置(user 発言の messages 内インデックス)。
// 編集 / 再生成 / 削除はこの位置を使ってサーバー側の履歴を操作する。
// ストリーミング中に増えた項目は位置が未確定なので undefined。
type DisplayItem =
  | { kind: 'user'; text: string; turn?: number; ts?: string }
  | { kind: 'assistant'; text: string; stats?: ChatStats | null; turn?: number; ts?: string }
  | { kind: 'tool'; name: string; turn?: number }
  | { kind: 'proposals'; proposals: Proposal[]; turn?: number }

/** 発言時刻(保存は UTC の ISO 8601)を「7/20 12:05」の形にする。
 *  古い履歴には時刻が無いので、その場合は何も出さない。 */
function TimeLabel({
  ts,
  align,
  indent = 0
}: {
  ts?: string
  align: 'left' | 'right'
  /** アイコンぶんの字下げ(px)。吹き出しの真上に来るように使う */
  indent?: number
}): React.JSX.Element | null {
  if (!ts) return null
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return null
  const label = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`
  return (
    <div
      className={`mb-0.5 text-[10px] ${align === 'right' ? 'text-right' : ''}`}
      style={{ color: 'var(--text-faint)', marginLeft: indent || undefined }}
      title={date.toLocaleString()}
    >
      {label}
    </div>
  )
}

/** 保存済みメッセージ配列から表示用の項目を組み立てる */
function buildDisplay(messages: Array<Record<string, unknown>>): DisplayItem[] {
  const display: DisplayItem[] = []
  let turn = 0
  messages.forEach((m, index) => {
    const role = m.role as string
    if (role === 'user') {
      const text = String(m.content ?? '')
      if (text.startsWith('(これ以上ツールは使えません')) return // 内部指示は隠す
      turn = index
      display.push({ kind: 'user', text, turn, ts: m.ts as string | undefined })
      return
    }
    if (role !== 'assistant') return
    const toolCalls = m.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined
    for (const tc of toolCalls ?? []) {
      const name = tc.function?.name ?? ''
      if (name === 'propose_beats') {
        try {
          const args = JSON.parse(tc.function?.arguments ?? '{}') as { proposals?: Proposal[] }
          if (args.proposals?.length) display.push({ kind: 'proposals', proposals: args.proposals, turn })
        } catch {
          // 引数が壊れている場合は無視
        }
      } else if (name) {
        display.push({ kind: 'tool', name, turn })
      }
    }
    if (m.content) {
      // meta は保存時に付けた生成統計(LLM には渡していない)
      display.push({
        kind: 'assistant',
        text: String(m.content),
        stats: (m.meta as ChatStats | undefined) ?? null,
        turn,
        ts: m.ts as string | undefined
      })
    }
  })
  return display
}

/** ホバーで出るメッセージ操作アイコン(lm-chat の msg-action-btn を移植) */
function MsgActionButton({
  kind,
  title,
  onClick
}: {
  kind: 'edit' | 'regenerate' | 'delete'
  title: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded p-0.5 hover:bg-[var(--accent-soft)]"
      style={{ color: 'var(--text-faint)' }}
    >
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
        {kind === 'edit' && (
          <>
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </>
        )}
        {kind === 'regenerate' && (
          <>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
            <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
          </>
        )}
        {kind === 'delete' && (
          <>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </>
        )}
      </svg>
    </button>
  )
}

/** 返事の下に出す生成統計(lm-chat の qa-meta と同じ並び) */
function StatsLine({ stats }: { stats: ChatStats }): React.JSX.Element {
  const parts: React.JSX.Element[] = []
  const item = (key: string, icon: React.JSX.Element | null, text: string): React.JSX.Element => (
    <span key={key} className="inline-flex items-center gap-1">
      {icon}
      {text}
    </span>
  )
  if (stats.tokens_per_sec) {
    parts.push(item('speed', <Icon name="zap" size={11} />, `${stats.tokens_per_sec.toFixed(1)} tok/sec`))
  }
  if (stats.tokens) {
    parts.push(item('tokens', <Icon name="tokens" size={11} />, `${stats.tokens.toLocaleString()} tokens`))
  }
  if (stats.elapsed_sec) {
    parts.push(item('elapsed', <Icon name="clock" size={11} />, `${stats.elapsed_sec.toFixed(2)}s`))
  }
  if (stats.steps > 1) {
    parts.push(item('steps', <Icon name="tool" size={11} />, `${stats.steps} ステップ`))
  }
  if (stats.finish_reason) parts.push(item('finish', null, `Finish reason: ${stats.finish_reason}`))
  return (
    <div
      className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] tabular-nums"
      style={{ color: 'var(--text-faint)' }}
    >
      {parts.map((part, i) => (
        <span key={part.key} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  )
}

// 定型質問。読み取り3ツール(get_beats / get_state / search_memories)と
// propose_beats が一通り使われる並びにしている。詳細は docs/design/chat.md
const TEMPLATES: { label: string; text: string }[] = [
  { label: '流れを要約', text: 'ここまでの流れを3行で要約して。' },
  { label: '状態を要約', text: '現在の各キャラの状態(facts と関係)を要約して。' },
  { label: '関係の変化', text: '関係値が大きく動いたところと、その理由を挙げて。' },
  { label: '未回収の伏線', text: '未回収の伏線・約束・謎を洗い出して。' },
  { label: '矛盾チェック', text: 'キャラの言動と facts に矛盾がないか点検して。' },
  { label: '展開を提案', text: 'この先の展開を3案提案して。' },
  { label: '山場', text: 'ここまでで一番の山場はどこですか。理由も添えて。' },
  { label: '弱いところ', text: '盛り上がりに欠けるシーンを挙げて、理由と直し方を教えて。' },
  { label: '各人の望み', text: '各キャラがいま何を求めているか整理して。' },
  { label: '場所の使い方', text: 'これまでに出た場所と、それぞれの使われ方を整理して。' }
]
// キャラモード用の定型質問(インタビューの入り口。docs/design/chat.md §6)
const CHAR_TEMPLATES: { label: string; text: string }[] = [
  { label: '気がかり', text: 'いま一番気がかりなことは何ですか?' },
  { label: '心に残る', text: '最近の出来事で心に残っていることを聞かせてください。' },
  { label: 'これから', text: 'これからどうするつもりですか?' },
  { label: '後悔', text: '後悔していることはありますか?' },
  { label: '信頼と警戒', text: '誰を信頼していて、誰を警戒していますか?' },
  { label: '大切なもの', text: 'あなたにとって一番大切なものは何ですか?' },
  { label: '知っていること', text: 'いま自分が知っていることを整理して話してください。' },
  { label: '言えていないこと', text: '誰か一人に言えていないことがあるなら、聞かせてください。' },
  { label: 'この場所', text: 'いまいる場所について、どう感じていますか?' },
  { label: '変わったこと', text: '出会ったころの自分と、いまの自分で変わったことは?' }
]
// 候補は会話と一緒にスクロールするので、固定枠だった頃より多めに出せる
const TEMPLATE_WINDOW = 5 // 同時に見せる件数
const MAX_DYNAMIC = 3 // うち、内容から生成された質問に使う枠(生成側の上限も 3 件)
const SIDEBAR_MIN = 140 // 会話一覧の最小幅(見出しが読める下限)
const SIDEBAR_MAX = 420 // 同・最大幅。会話エリアを潰さない上限
const RING_RADIUS = 10 // コンテキスト使用量リング(26px の SVG 内)
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** キャラのアイコン。画像が無いときは色付きの頭文字で代替する
 *  (プロフィール画像は装飾専用なので、無くても成り立つのが前提) */
function CharAvatar({ char, size }: { char: Character; size: number }): React.JSX.Element {
  const src = assetUrl(char.portrait_path)
  const color = char.color ?? '#8a8fa8'
  const style = { width: size, height: size, border: `1.5px solid ${color}` }
  if (src) {
    return (
      <img
        src={src}
        alt={char.name}
        title={char.name}
        className="shrink-0 rounded-full object-cover"
        style={style}
      />
    )
  }
  return (
    <span
      title={char.name}
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ ...style, background: `${color}33`, color, fontSize: Math.round(size * 0.45) }}
    >
      {char.name.slice(0, 1)}
    </span>
  )
}

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
  // キャラモード: charId 設定時は「その時系列のキャラ本人」と話す(null = 相談)
  const [charId, setCharId] = useState<string | null>(null)
  const [roleplay, setRoleplay] = useState(false) // false = インタビュー
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
  // 左サイドバー(会話一覧)の幅。分割線のドラッグで変えられる。モードを
  // 切り替えるとこのコンポーネントは破棄されるので localStorage に覚えておく
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('chatSidebarWidth'))
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : 208 // 208px = 旧 w-52
  })
  // 左サイドバー(会話一覧)の ⋯ メニューと会話名の編集
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  // 発言の編集(ホバーアクションの ✎)。turn = messages 上の位置
  const [editingTurn, setEditingTurn] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  // 内容から作られた質問(最大 2 件。固定の候補の下=入力欄側に出す)
  const [dynamicQuestions, setDynamicQuestions] = useState<string[]>([])
  // コンテキスト使用量(lm-chat のドーナツリング相当)
  const [usage, setUsage] = useState<{ tokens: number; ctx: number; estimated: boolean } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null) // 入力欄の高さの上限を決めるのに使う
  const rootRef = useRef<HTMLDivElement | null>(null) // 会話一覧の最大幅を決めるのに使う
  const busyElapsed = useElapsedSeconds(busy)

  // 分割線のドラッグで会話一覧の幅を変える(構造モードの分割線と同じ作り)。
  // 会話エリアは最低 320px 残す
  const beginSidebarResize = useCallback(
    (event: React.PointerEvent): void => {
      event.preventDefault()
      const startX = event.clientX
      const startW = sidebarWidth
      const rootWidth = rootRef.current?.clientWidth ?? 0
      const maxW = rootWidth > 0 ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, rootWidth - 320)) : SIDEBAR_MAX
      const onMove = (ev: PointerEvent): void => {
        const next = Math.min(maxW, Math.max(SIDEBAR_MIN, startW + (ev.clientX - startX)))
        setSidebarWidth(next)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setSidebarWidth((w) => {
          localStorage.setItem('chatSidebarWidth', String(Math.round(w)))
          return w
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sidebarWidth]
  )

  // 入力欄は内容に合わせて縦に伸ばす(1 行から始めて、書いた分だけ広がる)。
  // 会話が潰れないようドロワーの高さの 40% を上限にし、超えたらスクロールする
  const autosizeInput = useCallback((): void => {
    const el = inputRef.current
    if (!el) return
    const panelHeight = panelRef.current?.clientHeight ?? 0
    const max = panelHeight > 0 ? Math.max(64, panelHeight * 0.4) : 160
    el.style.height = 'auto'
    const wanted = el.scrollHeight + 2
    el.style.height = `${Math.min(wanted, max)}px`
    el.style.overflowY = wanted > max ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    autosizeInput()
  }, [input, open, autosizeInput])

  // 幅が変わると折り返しが変わり(インスペクタのリサイズ等)、ドロワーの高さが
  // 変わると上限が変わる(分割ペインのドラッグ)。どちらでも計算し直す
  useEffect(() => {
    const el = inputRef.current
    const panel = panelRef.current
    if (!el || !panel) return
    let lastWidth = el.clientWidth
    let lastPanelHeight = panel.clientHeight
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth && panel.clientHeight === lastPanelHeight) return
      lastWidth = el.clientWidth
      lastPanelHeight = panel.clientHeight
      autosizeInput()
    })
    observer.observe(el)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [autosizeInput])

  // リングの色は lm-chat と同じ閾値(70% で警告、90% で危険)
  const usagePct = usage ? Math.min((usage.tokens / Math.max(usage.ctx, 1)) * 100, 100) : 0
  const ringColor = usagePct >= 90 ? '#ef4444' : usagePct >= 70 ? '#f59e0b' : 'var(--accent)'

  const activeChar = charId ? characters.find((c) => c.id === charId) ?? null : null
  // キャラモードは固定テンプレを差し替え、内容ベースの生成は使わない
  const templates = charId ? CHAR_TEMPLATES : TEMPLATES
  const dynamicShown = dynamicSuggestions && !charId ? dynamicQuestions.slice(0, MAX_DYNAMIC) : []
  // 固定の候補で残りの枠を埋める(固定が上、生成された質問が下)
  const chips = [
    ...Array.from(
      { length: Math.max(TEMPLATE_WINDOW - dynamicShown.length, 0) },
      (_, i) => ({ text: templates[(templateOffset + i) % templates.length].text, dynamic: false })
    ),
    ...dynamicShown.map((text) => ({ text, dynamic: true }))
  ]
  const chipsKey = chips.map((c) => c.text).join('\n')

  // 内容ベースの質問候補を取り直す。失敗・未起動・設定オフはすべて無視して
  // 固定の候補のまま(バックエンドが空配列を返す)。キャラモードでは使わない
  const refreshSuggestions = async (cid: string | null, anchor: string | null): Promise<void> => {
    if (!dynamicSuggestions || charId) return
    try {
      const res = await chatApi.suggestQuestions({ chat_id: cid, anchor_node: anchor, scope })
      if (res.questions.length > 0) setDynamicQuestions(res.questions)
    } catch {
      /* 候補は無くても困らないので黙って諦める */
    }
  }

  // コンテキスト使用量を取り直す(会話トークン / ctx_size)
  const refreshUsage = async (
    cid: string | null,
    anchor: string | null,
    charOverride?: string | null
  ): Promise<void> => {
    const c = charOverride !== undefined ? charOverride : charId
    try {
      const res = await chatApi.tokenUsage({
        chat_id: cid,
        anchor_node: anchor,
        scope: c ? 'upto' : scope,
        char_id: c,
        mode: roleplay ? 'roleplay' : 'interview'
      })
      setUsage({ tokens: res.token_count, ctx: res.ctx_size, estimated: res.estimated })
    } catch {
      setUsage(null)
    }
  }

  // 履歴一覧の取り直し。回答が終わるたびに呼ぶ(開いた時だけだと、いま話した
  // チャットが「履歴…」に出てこない)
  const refreshHistory = async (): Promise<void> => {
    try {
      setHistory(await chatApi.list())
    } catch {
      /* 一覧が取れなくても会話は続けられる */
    }
  }

  useEffect(() => {
    if (open) void refreshHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

  // 開いたタイミング(と設定変更時)に候補と使用量を取っておく
  useEffect(() => {
    if (!open) return
    const anchor = anchorNode ?? selectedId ?? canonTailId
    void refreshUsage(chatId, anchor)
    if (dynamicSuggestions) void refreshSuggestions(chatId, anchor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dynamicSuggestions])

  // 候補チップも会話の中(末尾)にあるので、チップが差し替わったときも下端へ寄せる
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items, status, liveText, chipsKey])

  // サイドバーの見出し。会話名が無ければ冒頭の発言、それも無ければアンカー名
  const chatLabel = (h: ChatSummary | undefined): string => {
    if (!h) return '(会話)'
    return h.title || h.snippet || h.anchor_title || '(新しい会話)'
  }

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
    void refreshUsage(null, anchor)
  }

  // 相談 ⇄ キャラの切替。会話の前提(システムプロンプト)が変わるので新規チャット扱い
  const switchTarget = (nextCharId: string | null): void => {
    setCharId(nextCharId)
    setChatId(null)
    setItems([])
    setInsertedTitles(new Set())
    setDynamicQuestions([])
    setTemplateOffset(0)
    const anchor = anchorNode ?? selectedId ?? canonTailId
    setAnchorNode(anchor)
    void refreshUsage(null, anchor, nextCharId)
  }

  const loadChat = async (id: string): Promise<void> => {
    const chat = await chatApi.get(id)
    setChatId(chat.id)
    setAnchorNode(chat.anchor_node)
    setScope(chat.scope === 'all' ? 'all' : 'upto')
    setCharId(chat.char_id ?? null)
    setRoleplay(chat.mode === 'roleplay')
    setInsertedTitles(new Set())
    setDynamicQuestions([])
    if (!chat.char_id) void refreshSuggestions(chat.id, chat.anchor_node)
    void refreshUsage(chat.id, chat.anchor_node, chat.char_id ?? null)
    setItems(buildDisplay(chat.messages))
  }

  // 保存済みの履歴から表示を組み直す。ストリーミングで積んだ項目には
  // messages 上の位置が無いので、往復が終わるたびにこれで揃える
  const syncItems = async (id: string | null): Promise<void> => {
    if (!id) return
    try {
      setItems(buildDisplay((await chatApi.get(id)).messages))
    } catch {
      /* 取得に失敗しても画面上の会話はそのまま使える */
    }
  }

  const send = async (override?: string, replaceFrom?: number): Promise<void> => {
    const message = (override ?? input).trim()
    if (!message || busy) return
    // 編集・再生成: 画面上もその往復以降を消してから送り直す
    if (replaceFrom !== undefined) {
      setItems((prev) => prev.filter((it) => it.turn === undefined || it.turn < replaceFrom))
    }
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setInput('')
    // 送信直後の吹き出しにも時刻を出す(保存側の ts と同じ形式)。
    // 再読み込み後はサーバーが付けた ts に置き換わる
    setItems((prev) => [...prev, { kind: 'user', text: message, ts: new Date().toISOString() }])
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
      setItems((prev) => [...prev, { kind: 'assistant', text, ts: new Date().toISOString() }])
    }
    try {
      await chatSendStream(
        {
          chat_id: chatId,
          anchor_node: effectiveAnchor,
          scope: charId ? 'upto' : scope,
          message,
          char_id: charId,
          mode: roleplay ? 'roleplay' : 'interview',
          replace_from: replaceFrom ?? null
        },
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
            setStatus(name === 'recall' ? '記憶をたどっています…' : `調査中: ${name}`)
            if (name !== 'propose_beats') setItems((prev) => [...prev, { kind: 'tool', name }])
          }
          if (e.proposals?.length) {
            setItems((prev) => [...prev, { kind: 'proposals', proposals: e.proposals! }])
          }
          if (e.answer !== undefined) {
            setStatus(null)
            live = ''
            setLiveText('')
            if (e.answer) {
              setItems((prev) => [...prev, { kind: 'assistant', text: e.answer!, stats: e.stats ?? null, ts: new Date().toISOString() }])
            } else if (e.stats) {
              // ストリーミングで確定済みの吹き出しに統計だけ後付けする
              setItems((prev) => {
                const last = prev[prev.length - 1]
                if (last?.kind !== 'assistant') return prev
                return [...prev.slice(0, -1), { ...last, stats: e.stats ?? null }]
              })
            }
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
      // 回答後に、会話を踏まえたフォローアップ質問へ差し替え、使用量も更新する。
      // 履歴一覧も取り直して、いま話したチャットを選び直せるようにする
      void refreshSuggestions(latestChatId, effectiveAnchor)
      void refreshUsage(latestChatId, effectiveAnchor)
      void refreshHistory()
      void syncItems(latestChatId) // 各項目に messages 上の位置を持たせ直す
    }
  }

  // ---- 個々のメッセージの操作(lm-chat のホバーアクション) ----------
  const regenerateTurn = (turn: number, text: string): void => {
    if (busy) return
    void send(text, turn)
  }

  const deleteTurn = async (turn: number, keepUser: boolean): Promise<void> => {
    if (!chatId || busy) return
    const label = keepUser ? 'この返事を削除しますか?' : 'このやり取りを削除しますか?'
    if (!window.confirm(label)) return
    try {
      setItems(buildDisplay((await chatApi.deleteTurn(chatId, turn, keepUser)).messages))
    } catch {
      return
    }
    void refreshUsage(chatId, anchorNode)
    void refreshHistory()
  }

  const startEditTurn = (turn: number, text: string): void => {
    setEditingTurn(turn)
    setEditText(text)
  }

  // サイドバーの ⋯ メニューから削除。表示中のチャットを消したら新規に戻す
  const deleteChat = async (id: string): Promise<void> => {
    if (busy) return
    const target = history.find((h) => h.id === id)
    if (!window.confirm(`「${chatLabel(target)}」を削除しますか?`)) return
    setMenuOpenId(null)
    try {
      await chatApi.delete(id)
    } catch {
      // 未保存(空)のチャットなどは無視して画面だけ整える
    }
    setHistory((prev) => prev.filter((h) => h.id !== id))
    if (id === chatId) startNewChat()
  }

  const commitRename = async (id: string): Promise<void> => {
    const title = renameText.trim()
    setRenamingId(null)
    try {
      await chatApi.rename(id, title)
    } catch {
      return // 失敗時は一覧をそのままにしておく
    }
    setHistory((prev) => prev.map((h) => (h.id === id ? { ...h, title: title || null } : h)))
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
    <div ref={rootRef} className="flex h-full min-h-0" style={{ background: 'var(--bg-chat)' }}>
      {/* 左サイドバー: これまでの会話。各項目の ⋯ で名前の変更と削除。
          幅は右端の分割線をドラッグして変えられる */}
      <aside className="flex shrink-0 flex-col" style={{ width: sidebarWidth }}>
        <button
          onClick={startNewChat}
          className="m-2 rounded-lg border px-2 py-1 text-[12px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          title="選択中のシーンをアンカーに新しい会話を始める"
        >
          + 新しい会話
        </button>
        <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
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
                    onBlur={() => void commitRename(h.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void commitRename(h.id)
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
                      onClick={() => void loadChat(h.id)}
                      disabled={busy}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left disabled:opacity-50"
                      title={`${h.char_name ? h.char_name + ' / ' : ''}${h.anchor_title || '(シーンなし)'} まで`}
                    >
                      {/* 相手の目印。キャラ会話はアバター、相談チャットは吹き出し。
                          幅を揃えて見出しの開始位置がずれないようにする */}
                      <span
                        className="flex w-5 shrink-0 items-center justify-center"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        {char ? (
                          <CharAvatar char={char} size={20} />
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
                          {h.char_name ? `${h.char_name} / ` : ''}
                          {h.anchor_title || '(シーンなし)'}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation() // window の click(外側クリックで閉じる)より先に処理する
                        setMenuOpenId((v) => (v === h.id ? null : h.id))
                      }}
                      className="shrink-0 rounded px-1 text-[13px] opacity-0 group-hover:opacity-100"
                      style={{ color: 'var(--text-faint)', opacity: menuOpenId === h.id ? 1 : undefined }}
                      title="この会話の操作"
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
                      onClick={() => void deleteChat(h.id)}
                      className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--accent-soft)]"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      削除
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>
      {/* リサイズハンドル(見た目は 1px の境界線、当たり判定は幅 4px) */}
      <div
        onPointerDown={beginSidebarResize}
        className="group relative w-1 shrink-0 cursor-col-resize"
        title="ドラッグで幅を変更"
      >
        <div
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-[var(--accent-border)]"
          style={{ background: 'var(--border)' }}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={panelRef} className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-2">
          {/* ヘッダー: 相手 / アンカー / スコープ */}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {/* 話す相手: 相談(編集者) or キャラ本人。切替は新規チャット扱い */}
            {activeChar ? <CharAvatar char={activeChar} size={20} /> : <Icon name="chat" size={14} />}
            <select
              value={charId ?? ''}
              onChange={(e) => switchTarget(e.target.value || null)}
              disabled={busy}
              className="rounded-md border px-1.5 py-0.5 text-[11px]"
              style={{
                background: 'var(--bg-input)',
                borderColor: activeChar?.color || 'var(--border)',
                color: 'var(--text-dim)'
              }}
              title="話す相手。キャラを選ぶと、アンカー時点のそのキャラ本人と話せます"
            >
              {/* option には SVG を置けないので、ここだけは文字だけで区別する */}
              <option value="">相談(編集者)</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}と話す
                </option>
              ))}
            </select>
            <span>
              アンカー: <span style={{ color: 'var(--text-dim)' }}>{anchorTitle(chatId ? anchorNode : anchorNode ?? selectedId ?? canonTailId)}</span> まで
            </span>
            {charId ? (
              <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
                {([false, true] as const).map((rp) => (
                  <button
                    key={String(rp)}
                    onClick={() => !chatId && setRoleplay(rp)}
                    disabled={!!chatId}
                    className="px-2 py-0.5 disabled:cursor-not-allowed"
                    style={
                      roleplay === rp
                        ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                        : { color: 'var(--text-faint)' }
                    }
                    title={
                      chatId
                        ? '枠組みはチャット開始時に固定されます(変えるには新規)'
                        : rp
                          ? '劇中の一場面として話す(あなたは見知らぬ相手。会話は本編に含まれない)'
                          : '物語の外から、作者としてキャラにインタビューする'
                    }
                  >
                    {rp ? '劇中会話' : 'インタビュー'}
                  </button>
                ))}
              </div>
            ) : (
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
            )}
            <button
              onClick={onClose}
              className="ml-auto rounded-md border px-2 py-0.5"
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
                {activeChar ? (
                  <>
                    <div className="mb-2 flex justify-center">
                      <CharAvatar char={activeChar} size={56} />
                    </div>
                    アンカー時点の {activeChar.name} 本人と話せます。
                    {roleplay ? '劇中の一場面として(本編には含まれません)。' : 'インタビュー形式で。'}
                    <br />
                    本人が知らないこと・まだ起きていないことは答えられません。
                  </>
                ) : (
                  <>
                    物語の状態について質問したり、「この先の展開を提案して」と頼めます。
                    <br />
                    アンカーより先の情報は見えません(ネタバレ防止)。
                  </>
                )}
              </div>
            )}
            {items.map((item, i) => {
              if (item.kind === 'user') {
                const turn = item.turn
                if (turn !== undefined && editingTurn === turn) {
                  // 編集中: その場で書き換えて送り直す(以降のやり取りは作り直し)
                  return (
                    <div key={i} className="mb-2 flex justify-end">
                      <div className="w-[70%]">
                        <textarea
                          autoFocus
                          rows={3}
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingTurn(null)
                          }}
                          className="w-full resize-none rounded-2xl border px-3 py-1.5 text-[13px] outline-none"
                          style={{ background: 'var(--bg-input)', borderColor: 'var(--accent-border)' }}
                        />
                        <div className="mt-1 flex justify-end gap-2 text-[11px]">
                          <button onClick={() => setEditingTurn(null)} style={{ color: 'var(--text-faint)' }}>
                            取消
                          </button>
                          <button
                            onClick={() => {
                              const text = editText.trim()
                              setEditingTurn(null)
                              if (text) void send(text, turn)
                            }}
                            disabled={!editText.trim()}
                            className="rounded-md px-2 py-0.5 font-medium text-white disabled:opacity-40"
                            style={{ background: 'var(--accent)' }}
                          >
                            送り直す
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={i} className="group mb-2 flex flex-col items-end">
                    <TimeLabel ts={item.ts} align="right" />
                    <div
                      className="max-w-[70%] whitespace-pre-wrap rounded-2xl rounded-br-md px-3 py-1.5 text-[13px]"
                      style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}
                    >
                      {item.text}
                    </div>
                    {turn !== undefined && !busy && (
                      <div className="mt-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <MsgActionButton
                          kind="edit"
                          title="この発言を編集して送り直す"
                          onClick={() => startEditTurn(turn, item.text)}
                        />
                        <MsgActionButton
                          kind="regenerate"
                          title="この発言から返事を作り直す"
                          onClick={() => regenerateTurn(turn, item.text)}
                        />
                        <MsgActionButton
                          kind="delete"
                          title="このやり取りを削除"
                          onClick={() => void deleteTurn(turn, false)}
                        />
                      </div>
                    )}
                  </div>
                )
              }
              if (item.kind === 'assistant') {
                return (
                  <div key={i} className="group mb-2">
                    {/* 時刻は行の外に出す。中に入れるとアイコンが時刻の高さに
                        引っ張られて吹き出しとずれる。アイコンぶん字下げして
                        吹き出しの真上に来るようにする */}
                    <TimeLabel ts={item.ts} align="left" indent={activeChar ? 64 : 0} />
                    <div className="flex items-start gap-2">
                      {/* キャラモードでは発言者のアイコンを添える */}
                      {activeChar && <CharAvatar char={activeChar} size={56} />}
                      <div className="min-w-0 max-w-[80%]">
                        <div
                          className="rounded-2xl rounded-bl-md border px-3 py-1.5 text-[13px] leading-relaxed"
                          style={{
                            background: 'var(--bg-card)',
                            // キャラモードはキャラ色の枠で「本人の発言」を示す
                            borderColor: activeChar?.color || 'var(--border)',
                            color: 'var(--text)'
                          }}
                        >
                          <Markdown text={item.text} />
                        </div>
                        <div className="flex items-center gap-2">
                          {item.stats && <StatsLine stats={item.stats} />}
                          {item.turn !== undefined && !busy && (
                            <div className="mt-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              <MsgActionButton
                                kind="delete"
                                title="この返事を削除(発言は残す)"
                                onClick={() => void deleteTurn(item.turn!, true)}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              }
              if (item.kind === 'tool') {
                return (
                  <div
                    key={i}
                    className="mb-1 flex items-center gap-1 text-[11px]"
                    style={{ color: 'var(--text-faint)' }}
                  >
                    {item.name === 'recall' ? (
                      <>
                        <Icon name="recall" size={12} /> 記憶をたどった
                      </>
                    ) : (
                      <>
                        <Icon name="search" size={12} /> {item.name}
                      </>
                    )}
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
              <div className="mb-2 flex items-start gap-2">
                {activeChar && <CharAvatar char={activeChar} size={56} />}
                <div
                  className="max-w-[80%] rounded-2xl rounded-bl-md border px-3 py-1.5 text-[13px] leading-relaxed"
                  style={{
                    background: 'var(--bg-card)',
                    borderColor: activeChar?.color || 'var(--border)',
                    color: 'var(--text)'
                  }}
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
            {/* 候補チップ(会話の一番下に置いて一緒にスクロールする。クリックで即送信)。
                固定枠にすると、その高さぶん会話エリアが常に狭くなるため中に入れている */}
            <div className="mt-2 flex flex-col items-end gap-1.5">
              {chips.map((c) => (
                <button
                  key={c.text}
                  onClick={() => void send(c.text)}
                  disabled={busy}
                  className="chat-suggest-chip flex max-w-full items-center gap-1 rounded-full border px-3 py-1 text-[11px] disabled:opacity-40"
                  style={{
                    background: 'var(--bg-card)',
                    borderColor: c.dynamic ? 'var(--accent-border)' : 'var(--border-strong)',
                    color: c.dynamic ? 'var(--text)' : 'var(--text-dim)'
                  }}
                  title={c.dynamic ? `${c.text}(物語の内容から作られた質問)` : c.text}
                >
                  {c.dynamic && <Icon name="sparkle" size={11} className="shrink-0" />}
                  <span className="truncate">{c.text}</span>
                </button>
              ))}
              {/* 候補の入れ替え。チップの並びの延長なので、入力欄ではなくここに置く */}
              <button
                // 送るのは表示中の並び(キャラモードは CHAR_TEMPLATES)なので、
                // 送り幅もその配列の長さで折り返す
                onClick={() => setTemplateOffset((v) => (v + TEMPLATE_WINDOW) % templates.length)}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                style={{ color: 'var(--text-faint)' }}
                title="ほかの候補を見る"
              >
                ⟳ ほかの候補
              </button>
            </div>
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
              placeholder={
                activeChar ? `${activeChar.name} に話しかける…(Enter で送信)` : '物語について相談…(Enter で送信)'
              }
              className="min-w-0 flex-1 resize-none rounded-lg border px-3 py-1.5 text-[13px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            />
            {/* コンテキスト使用量のリング(lm-chat の token-ring を移植) */}
            {usage && (
              <div
                className="flex shrink-0 items-center gap-1"
                title={
                  `会話トークン: ${usage.tokens.toLocaleString()}${usage.estimated ? '(概算)' : ''}\n` +
                  `コンテキスト上限: ${usage.ctx.toLocaleString()}\n` +
                  `${usagePct.toFixed(1)}% 使用中(${(100 - usagePct).toFixed(1)}% 残り)`
                }
              >
                <svg width="26" height="26" viewBox="0 0 26 26">
                  <circle cx="13" cy="13" r={RING_RADIUS} fill="none" stroke="var(--border-strong)" strokeWidth="2.2" />
                  <circle
                    cx="13"
                    cy="13"
                    r={RING_RADIUS}
                    fill="none"
                    stroke={ringColor}
                    strokeWidth="2.2"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={RING_CIRCUMFERENCE * (1 - usagePct / 100)}
                    strokeLinecap="round"
                    transform="rotate(-90 13 13)"
                    style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s' }}
                  />
                </svg>
                <span className="text-[11px] tabular-nums" style={{ color: ringColor }}>
                  {usage.estimated ? '≈' : ''}
                  {Math.round(usagePct)}%
                </span>
              </div>
            )}
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
    </div>
  )
}
