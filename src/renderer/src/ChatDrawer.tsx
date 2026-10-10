import ChatRulesPanel from './ChatRulesPanel'
import ContextUsageRing from './ContextUsageRing'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  chatApi,
  chatSendStream,
  roomSendStream,
  isAbortError,
  type ChatStats,
  type ChatStreamEvent,
  type ChatSummary
} from './api'
import CharAvatar from './CharAvatar'
import { MsgActionButton, StatsLine, SystemPromptModal } from './GenMeta'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { useChatVoice } from './useChatVoice'
import type { Character, StoryNode } from './types'
import { useElapsedSeconds } from './useElapsed'

// 旧形式の会話履歴に保存された提案を文章として復元するための型。
interface LegacyProposal {
  title: string
  beat: string
  emotional_core?: string
  cast?: string[]
  location?: string
}

// turn = その項目が属する往復の開始位置(user 発言の messages 内インデックス)。
// 編集 / 再生成 / 削除はこの位置を使ってサーバー側の履歴を操作する。
// ストリーミング中に増えた項目は位置が未確定なので undefined。
// キャラ同士の会話室(docs/design/chat.md §8)では往復の区切りが無いので、turn は
// その項目自身の messages 内インデックス(削除は 1 件単位)。
type DisplayItem =
  | { kind: 'user'; text: string; turn?: number; ts?: string }
  | {
      kind: 'assistant'
      text: string
      stats?: ChatStats | null
      turn?: number
      ts?: string
      /** この返事の生成時に LLM へ実際に送った内容の控え(system + 履歴 + ツール結果) */
      promptMessages?: Array<Record<string, unknown>>
      /** 会話室の発言者(キャラ ID)。相談 / キャラチャットでは無い */
      speaker?: string
    }
  | { kind: 'tool'; name: string; turn?: number; speaker?: string }

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
      data-tip={date.toLocaleString()}
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
    const speaker = m.speaker as string | undefined
    if (speaker) {
      // 会話室の発言。recall の往復は保存されず tools_used に名前だけ残る
      for (const name of (m.tools_used as string[] | undefined) ?? []) {
        display.push({ kind: 'tool', name, turn: index, speaker })
      }
      display.push({
        kind: 'assistant',
        text: String(m.content ?? ''),
        stats: (m.meta as ChatStats | undefined) ?? null,
        turn: index,
        ts: m.ts as string | undefined,
        promptMessages: m.prompt_messages as Array<Record<string, unknown>> | undefined,
        speaker
      })
      return
    }
    const toolCalls = m.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined
    for (const tc of toolCalls ?? []) {
      const name = tc.function?.name ?? ''
      if (name === 'propose_beats') {
        try {
          const args = JSON.parse(tc.function?.arguments ?? '{}') as { proposals?: LegacyProposal[] }
          if (args.proposals?.length) {
            const text = args.proposals
              .map((p) =>
                [
                  p.title,
                  p.beat,
                  p.emotional_core ? `感情の核: ${p.emotional_core}` : '',
                  p.cast?.length ? `登場人物: ${p.cast.join(', ')}` : '',
                  p.location ? `場所: ${p.location}` : ''
                ].filter(Boolean).join('\n\n')
              )
              .join('\n\n')
            display.push({ kind: 'assistant', text, turn })
          }
        } catch {
          // 引数が壊れている場合は無視
        }
      } else if (name) {
        display.push({ kind: 'tool', name, turn })
      }
    }
    if (m.content) {
      // meta は保存時に付けた生成統計、prompt_messages は生成時に送った内容の
      // 控え(どちらも LLM には渡していない)。system_prompt は控えを system
      // だけにしていた旧形式で、その頃の履歴も見られるようにしておく
      const promptMessages =
        (m.prompt_messages as Array<Record<string, unknown>> | undefined) ??
        (m.system_prompt ? [{ role: 'system', content: m.system_prompt }] : undefined)
      display.push({
        kind: 'assistant',
        text: String(m.content),
        stats: (m.meta as ChatStats | undefined) ?? null,
        turn,
        ts: m.ts as string | undefined,
        promptMessages
      })
    }
  })
  return display
}

// 定型質問。読み取り3ツール(get_beats / get_state / search_memories)と
// 文章での展開提案を含む並びにしている。詳細は docs/design/chat.md
const TEMPLATES: { label: string; text: string }[] = [
  { label: '流れを要約', text: 'ここまでの流れを3行で要約して。' },
  { label: '状態を要約', text: '現在の各キャラの状態(facts と関係)を要約して。' },
  { label: '関係の変化', text: '関係値が大きく動いたところと、その理由を挙げて。' },
  { label: '未回収の伏線', text: '未回収の伏線・約束・謎を洗い出して。' },
  { label: '矛盾チェック', text: 'キャラの言動と facts に矛盾がないか点検して。' },
  { label: '展開を提案', text: 'この先の展開を提案して。' },
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
// 会話室用の演出指示の候補(作者は参加せず指示だけ出す。docs/design/chat.md §8)
const ROOM_TEMPLATES: { label: string; text: string }[] = [
  { label: '挨拶から', text: 'まず挨拶から。互いの距離感が分かるように。' },
  { label: '最近の出来事', text: '最近あった出来事について、それぞれの見方を話し合って。' },
  { label: '探り合い', text: '相手が何を知っているか探り合って。知らないことは知らないままで。' },
  { label: '言い合い', text: '意見が食い違う話題を見つけて、言い合いになって。' },
  { label: '印象の変化', text: '相手の第一印象と、いまの印象がどう違うかを話して。' },
  { label: '頼みごと', text: '相手に何か頼みごとをして。相手は気持ちに沿って応じるか断る。' },
  { label: '本音', text: 'ふだん言えていない本音を、一つだけ漏らして。' },
  { label: '締める', text: '別れの挨拶。会話を締めて。' }
]
const ROOM_TURN_OPTIONS = [1, 2, 4, 6] // 1 回で続けて話させる発言数の選択肢(サーバー上限は 8)
// 候補は会話と一緒にスクロールするので、固定枠だった頃より多めに出せる
const TEMPLATE_WINDOW = 5 // 同時に見せる件数
const MAX_DYNAMIC = 3 // うち、内容から生成された質問に使う枠(生成側の上限も 3 件)
const SIDEBAR_MIN = 140 // 会話一覧の最小幅(見出しが読める下限)
const SIDEBAR_MAX = 420 // 同・最大幅。会話エリアを潰さない上限
const SIDEBAR_DEFAULT = 264 // 会話名 + キャラ名 / シーン名の 2 行が切れにくい幅
// アンカーが動いてから使用量を取り直すまでの待ち。選択が落ち着いてから 1 回だけ
// 投げるための間で、矢印キーの連打(1 回 60ms 程度)は十分に吸収できる長さ
const USAGE_DEBOUNCE_MS = 400

export default function ChatDrawer({
  anchorCandidateId,
  canonTailId,
  nodesById,
  characters,
  open,
  onClose,
  dynamicSuggestions
}: {
  /** 新しい会話のアンカーにするシーン(構造モードの選択。章カードを選んでいる
   *  ときはその章の末尾シーン)。会話が始まるまではこれに追従する */
  anchorCandidateId: string | null
  canonTailId: string | null
  nodesById: Record<string, StoryNode>
  characters: Character[]
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
  // いま効いているアンカー。**会話が始まるまでは構造モードの選択に追従**し、
  // 始まったら(chats に保存されたら)そこで固定される — スコープと同じ扱い。
  // 会話を始める前に anchorNode を先に埋めていた頃は、シーンを選び直しても
  // ヘッダーのアンカー表示が変わらなかった
  const liveAnchor = chatId ? anchorNode : (anchorNode ?? anchorCandidateId ?? canonTailId)
  // キャラモード: charId 設定時は「その時系列のキャラ本人」と話す(null = 相談)
  const [charId, setCharId] = useState<string | null>(null)
  const [roleplay, setRoleplay] = useState(false) // false = インタビュー
  // 会話室モード: キャラ同士に会話させ、作者は演出の指示だけ出す(docs/design/chat.md §8)。
  // 参加者は会話が始まったら固定(chats.participants)
  const [room, setRoom] = useState(false)
  const [participants, setParticipants] = useState<string[]>([])
  const [nextSpeaker, setNextSpeaker] = useState<string | null>(null) // null = 前の話者の次
  const [turns, setTurns] = useState(2) // 1 回「進める」で続けて話させる発言数
  const [liveSpeaker, setLiveSpeaker] = useState<string | null>(null) // 会話室でいま話している人
  const [items, setItems] = useState<DisplayItem[]>([])
  const [liveText, setLiveText] = useState('') // ストリーミング中の回答(確定前)
  // 再生成中はこの項目の直後に書きかけの吹き出しを出す(null = 一番下)
  const [liveAfter, setLiveAfter] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [rulesDirty, setRulesDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [history, setHistory] = useState<ChatSummary[]>([])
  // 候補チップは常に入力欄の右上に積む。全部出すと縦を食うので窓を 3 件に
  // 絞り、⟳ で次の 3 件へ送る(ランダムではなく決まった順。docs/design/chat.md)
  const [templateOffset, setTemplateOffset] = useState(0)
  // 左サイドバー(会話一覧)の幅。分割線のドラッグで変えられる。モードを
  // 切り替えるとこのコンポーネントは破棄されるので localStorage に覚えておく
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('chatSidebarWidth'))
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT
  })
  // 左サイドバー(会話一覧)の ⋯ メニューと会話名の編集
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  // 発言の編集(ホバーアクションの ✎)。turn = messages 上の位置
  const [editingTurn, setEditingTurn] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  // 返事の生成に送った内容をモーダルで見る(null = 閉じている)
  const [promptView, setPromptView] = useState<Array<Record<string, unknown>> | null>(null)
  // 内容から作られた質問(最大 2 件。固定の候補の下=入力欄側に出す)
  const [dynamicQuestions, setDynamicQuestions] = useState<string[]>([])
  // コンテキスト使用量(lm-chat のドーナツリング相当)
  const [usage, setUsage] = useState<{ tokens: number; ctx: number; estimated: boolean } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 自動スクロールは下端付近にいるときだけ追従する(過去ログを読んでいる最中に飛ばさない)
  const stickToBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null) // 入力欄の高さの上限を決めるのに使う
  const rootRef = useRef<HTMLDivElement | null>(null) // 会話一覧の最大幅を決めるのに使う
  const usageSeqRef = useRef(0) // 使用量の取得は追い越しがあるので最後の応答だけ採用する
  const busyElapsed = useElapsedSeconds(busy)
  // 返答の読み上げ(docs/design/voice.md §6.1)。キャラとの会話はキャラの声、相談は相談相手の声
  const voice = useChatVoice({ charId, mode: charId ? (roleplay ? 'roleplay' : 'interview') : null })
  const stopVoice = voice.stop
  useEffect(() => {
    if (!open) stopVoice()
  }, [open, stopVoice])
  useEffect(() => {
    if (voice.error) setStatus(`読み上げに失敗しました: ${voice.error}`)
  }, [voice.error])

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

  const activeChar = charId ? characters.find((c) => c.id === charId) ?? null : null
  const charById = (id: string | null | undefined): Character | null =>
    id ? characters.find((c) => c.id === id) ?? null : null
  const roomChars = participants.map((id) => charById(id)).filter((c): c is Character => c !== null)
  const roomReady = participants.length >= 2
  // キャラモード・会話室は固定テンプレを差し替え、内容ベースの生成は使わない
  const templates = room ? ROOM_TEMPLATES : charId ? CHAR_TEMPLATES : TEMPLATES
  const dynamicShown = dynamicSuggestions && !charId && !room ? dynamicQuestions.slice(0, MAX_DYNAMIC) : []
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
    if (!dynamicSuggestions || charId || room) return
    try {
      const res = await chatApi.suggestQuestions({ chat_id: cid, anchor_node: anchor, scope })
      if (res.questions.length > 0) setDynamicQuestions(res.questions)
    } catch {
      /* 候補は無くても困らないので黙って諦める */
    }
  }

  // コンテキスト使用量を取り直す(会話トークン / ctx_size)。
  // 追い越しがあるので、最後に投げた分の応答だけを採用する
  const refreshUsage = async (
    cid: string | null,
    anchor: string | null,
    charOverride?: string | null,
    participantsOverride?: string[] | null
  ): Promise<void> => {
    const c = charOverride !== undefined ? charOverride : charId
    const p = participantsOverride !== undefined ? participantsOverride : room ? participants : null
    const seq = ++usageSeqRef.current
    if (p && p.length < 2) {
      // 参加者が揃うまでは数えるものが無い
      setUsage(null)
      return
    }
    try {
      const res = await chatApi.tokenUsage({
        chat_id: cid,
        anchor_node: anchor,
        scope: c || p ? 'upto' : scope,
        char_id: c,
        mode: p ? 'room' : roleplay ? 'roleplay' : 'interview',
        participants: p
      })
      if (seq !== usageSeqRef.current) return // 新しい要求に追い越された
      setUsage({ tokens: res.token_count, ctx: res.ctx_size, estimated: res.estimated })
    } catch {
      if (seq !== usageSeqRef.current) return
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

  // 開いたタイミング(と設定変更時)に質問候補を取っておく
  useEffect(() => {
    if (!open) return
    if (dynamicSuggestions) void refreshSuggestions(chatId, liveAnchor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dynamicSuggestions])

  /** 使用量リングの取り直し。会話が始まるまではアンカーが選択に追従するので、
   *  その間はアンカー(とスコープ・相手)が変わるたびに取り直す必要がある。
   *
   *  ただし /chat/token_usage は「見える範囲の fold + llama-server の /tokenize」
   *  を通るので 1 選択 1 リクエストにはしない。**選択が落ち着いてから 1 回だけ**
   *  投げる(矢印キーでシーンを渡り歩く間ずっと叩かないため)。
   *  会話が始まったあと(chatId あり)はアンカーが固定されるので、ここでは何もせず
   *  送信・履歴読み込み・ターン削除の各所からの明示的な呼び出しに任せる。 */
  useEffect(() => {
    if (!open || chatId) return
    const timer = window.setTimeout(() => void refreshUsage(null, liveAnchor), USAGE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatId, liveAnchor, scope, charId, roleplay, room, participants.join(',')])

  // 候補チップも会話の中(末尾)にあるので、チップが差し替わったときも下端へ寄せる
  useEffect(() => {
    if (!stickToBottomRef.current) return
    if (liveAfter !== null) return // 途中の返事を作り直している間は差し込み位置から目を離さない
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items, status, liveText, chipsKey, liveAfter])

  // アンマウント時に進行中のストリーミングを中止する
  useEffect(() => () => abortRef.current?.abort(), [])

  // サイドバーの見出し。会話名が無ければ冒頭の発言、それも無ければアンカー名
  const chatLabel = (h: ChatSummary | undefined): string => {
    if (!h) return '(会話)'
    // 会話室は指示なしで始まることもある(snippet が空)ので、参加者の名前を見出しにする
    const names = h.participant_names?.length ? h.participant_names.join('と') : ''
    return h.title || h.snippet || names || h.anchor_title || '(新しい会話)'
  }

  const anchorTitle = (id: string | null): string => {
    if (!id) return '(シーンなし)'
    const node = nodesById[id]
    return node ? node.title || '(無題)' : id
  }

  const startNewChat = (): void => {
    voice.stop()
    if (busy) return
    setChatId(null)
    setItems([])
    setEditingTurn(null) // 開きっぱなしの編集欄を前の会話から持ち越さない
    // アンカーは空に戻す(= 選択に追従する)。ここで埋めてしまうと、会話を
    // 始める前にシーンを選び直してもアンカーが動かなくなる
    setAnchorNode(null)
    const anchor = anchorCandidateId ?? canonTailId
    setDynamicQuestions([]) // 新しいアンカーの候補を取り直す
    void refreshSuggestions(null, anchor)
    void refreshUsage(null, anchor)
  }

  // 相談 ⇄ キャラ ⇄ 会話室の切替。会話の前提(システムプロンプト)が変わるので新規チャット扱い。
  // value は '' = 相談、'room' = キャラ同士の会話、それ以外はキャラ ID
  const switchTarget = (value: string | null): void => {
    voice.stop()
    const nextRoom = value === 'room'
    const nextCharId = nextRoom ? null : value || null
    setRoom(nextRoom)
    setCharId(nextCharId)
    setChatId(null)
    setItems([])
    setDynamicQuestions([])
    setEditingTurn(null)
    setTemplateOffset(0)
    setNextSpeaker(null)
    // 会話の途中で相手を変えたときは、その会話の時点(アンカー)を引き継ぐ。
    // まだ会話が始まっていなければ空に戻して選択に追従させる
    const carried = chatId ? anchorNode : null
    setAnchorNode(carried)
    void refreshUsage(null, carried ?? anchorCandidateId ?? canonTailId, nextCharId, nextRoom ? participants : null)
  }

  // 会話室の参加者の出し入れ(会話が始まる前だけ)
  const toggleParticipant = (id: string): void => {
    if (chatId || busy) return
    setParticipants((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
    setNextSpeaker((s) => (s === id ? null : s))
  }

  const loadChat = async (id: string): Promise<void> => {
    let chat
    try {
      chat = await chatApi.get(id)
    } catch {
      setStatus('会話の読み込みに失敗しました')
      return
    }
    voice.stop()
    const isRoom = chat.mode === 'room' && !!chat.participants
    setChatId(chat.id)
    setAnchorNode(chat.anchor_node)
    setScope(chat.scope === 'all' ? 'all' : 'upto')
    setCharId(chat.char_id ?? null)
    setRoleplay(chat.mode === 'roleplay')
    setRoom(isRoom)
    if (isRoom) setParticipants(chat.participants ?? [])
    setNextSpeaker(null)
    setDynamicQuestions([])
    // turn は会話ごとの添字なので、別の会話に持ち越すと同じ位置のメッセージに
    // 前の会話の編集欄(と本文)が現れてしまう
    setEditingTurn(null)
    if (!chat.char_id && !isRoom) void refreshSuggestions(chat.id, chat.anchor_node)
    void refreshUsage(chat.id, chat.anchor_node, chat.char_id ?? null, isRoom ? chat.participants : null)
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

  /** 会話室: 演出の指示(空でもよい)を積んでから、話者を決めて turns 人ぶん話させる。
   *  speakerOverride は「この人に話させる」(再生成でも使う)。count は発言数の上書き */
  const sendRoom = async (
    override?: string,
    speakerOverride?: string | null,
    count?: number,
    replaceFrom?: number
  ): Promise<void> => {
    const instruction = (override ?? input).trim()
    if (busy || !roomReady) return
    // 演出指示の編集・作り直し: 画面上もその位置以降を消してから進める
    if (replaceFrom !== undefined) {
      setItems((prev) => prev.filter((it) => it.turn === undefined || it.turn < replaceFrom))
    }
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    if (override === undefined) setInput('')
    if (instruction) {
      setItems((prev) => [...prev, { kind: 'user', text: instruction, ts: new Date().toISOString() }])
    }
    setStatus('考え中…')
    // 読み上げの列は 1 回の「進める」で 1 本。発言ごとに声の主だけ替える(発言ごとに列を
    // 作り直すと、前の人の読み上げがまだ鳴っている途中で止まり、最後の人しか聞こえなかった)
    voice.begin()
    const effectiveAnchor = liveAnchor
    if (!chatId) setAnchorNode(effectiveAnchor)
    const speaker = speakerOverride !== undefined ? speakerOverride : nextSpeaker
    setNextSpeaker(null) // 指名は 1 回きり(以降は順に回る)
    let live = ''
    let latestChatId = chatId
    const nameOf = (id: string): string => charById(id)?.name ?? id
    try {
      await roomSendStream(
        {
          chat_id: chatId,
          anchor_node: effectiveAnchor,
          participants: chatId ? null : participants,
          instruction: instruction || null,
          speaker,
          turns: count ?? turns,
          replace_from: replaceFrom ?? null
        },
        (e: ChatStreamEvent) => {
          if (e.chat_id && !e.done) {
            latestChatId = e.chat_id
            setChatId(e.chat_id)
          }
          if (e.turn !== undefined && e.speaker) {
            // 発言の始まり。この発言は本人の声で読む(（）のト書きは語り手)
            live = ''
            setLiveText('')
            setLiveSpeaker(e.speaker)
            setStatus(`${nameOf(e.speaker)} が考え中…`)
            voice.setSpeaker({ charId: e.speaker, mode: 'roleplay' })
          }
          if (e.stage === 'thinking' && e.speaker) setStatus(`${nameOf(e.speaker)} が考え中…`)
          if (e.delta) {
            live += e.delta
            setLiveText(live)
            setStatus(null)
            voice.feed(e.delta)
          }
          if (e.tool_call && e.speaker) {
            setStatus(`${nameOf(e.speaker)} が記憶をたどっています…`)
            setItems((prev) => [...prev, { kind: 'tool', name: e.tool_call!.name, speaker: e.speaker }])
          }
          if (e.utterance) {
            const u = e.utterance
            voice.finish(u.text || undefined)
            live = ''
            setLiveText('')
            setLiveSpeaker(null)
            setItems((prev) => [
              ...prev,
              { kind: 'assistant', text: u.text, stats: u.stats, speaker: u.speaker, turn: u.index, ts: new Date().toISOString() }
            ])
          }
          if (e.done) setStatus(null)
          if (e.error) setStatus(`エラー: ${e.error}`)
        },
        controller.signal
      )
    } catch (err) {
      if (isAbortError(err)) voice.stop()
      setStatus(isAbortError(err) ? '止めました(話し終えた発言までは保存されています)' : String(err))
    } finally {
      abortRef.current = null
      setBusy(false)
      setLiveText('')
      setLiveSpeaker(null)
      if (!latestChatId) setAnchorNode(null)
      void refreshUsage(latestChatId, effectiveAnchor)
      void refreshHistory()
      void syncItems(latestChatId)
    }
  }

  // replaceTurn: その発言の返事だけ作り直す(以降の往復は残す。ユーザー決定 2026-10-09)。
  // 画面上はその往復の返事・ツール行を消し、新しい項目を発言の直後に差し込んでいく
  const send = async (override?: string, replaceTurn?: number): Promise<void> => {
    if (room) return sendRoom(override)
    const message = (override ?? input).trim()
    if (!message || busy) return
    if (!charId && rulesDirty) { setStatus('AIへのルールを保存するか、元に戻してから送信してください。'); return }
    let insertPos: number | null = null
    if (replaceTurn !== undefined) {
      const kept = items.filter((it) => !(it.turn === replaceTurn && it.kind !== 'user'))
      const userIdx = kept.findIndex((it) => it.kind === 'user' && it.turn === replaceTurn)
      if (userIdx < 0) return
      insertPos = userIdx + 1
      setItems(kept)
      setLiveAfter(userIdx)
    }
    // 新しい項目を積む。再生成中は差し込み位置を進める(それ以外は末尾)
    const pushItem = (it: DisplayItem): void => {
      if (insertPos === null) {
        setItems((prev) => [...prev, it])
        return
      }
      const at = insertPos++
      setItems((prev) => [...prev.slice(0, at), it, ...prev.slice(at)])
      setLiveAfter(at)
    }
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    // 候補チップや再生成(override あり)では入力欄の書きかけを消さない
    if (override === undefined) setInput('')
    // 送信直後の吹き出しにも時刻を出す(保存側の ts と同じ形式)。
    // 再読み込み後はサーバーが付けた ts に置き換わる。再生成では発言は既にある
    if (replaceTurn === undefined) pushItem({ kind: 'user', text: message, ts: new Date().toISOString() })
    setStatus('考え中…')
    voice.begin() // オンなら、この返答を書き上がった文から読んでいく
    // 会話が始まる = ここでアンカーが確定する(以後は選択に追従しない)
    const effectiveAnchor = liveAnchor
    if (!chatId) setAnchorNode(effectiveAnchor)
    // ストリーミング中のテキストは closure 変数で持ち、確定時に items へ移す
    let live = ''
    let latestChatId = chatId
    const flushLive = (): void => {
      if (!live) return
      const text = live
      live = ''
      setLiveText('')
      pushItem({ kind: 'assistant', text, ts: new Date().toISOString() })
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
          replace_turn: replaceTurn ?? null
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
            voice.feed(e.delta)
          }
          if (e.tool_call) {
            const name = e.tool_call.name
            flushLive() // ツール実行前までの途中テキストを確定させる
            setStatus(name === 'recall' ? '記憶をたどっています…' : `調査中: ${name}`)
            pushItem({ kind: 'tool', name })
          }
          if (e.answer !== undefined) {
            voice.finish(e.answer || undefined)
            setStatus(null)
            live = ''
            setLiveText('')
            if (e.answer) {
              pushItem({ kind: 'assistant', text: e.answer!, stats: e.stats ?? null, ts: new Date().toISOString() })
            } else if (e.stats) {
              // ストリーミングで確定済みの吹き出し(直前に積んだもの)に統計だけ後付けする
              const at = insertPos === null ? -1 : insertPos - 1
              setItems((prev) => {
                const idx = at < 0 ? prev.length - 1 : at
                const target = prev[idx]
                if (target?.kind !== 'assistant') return prev
                return [...prev.slice(0, idx), { ...target, stats: e.stats ?? null }, ...prev.slice(idx + 1)]
              })
            }
          }
          if (e.error) setStatus(`エラー: ${e.error}`)
        },
        controller.signal
      )
    } catch (err) {
      if (isAbortError(err)) voice.stop()
      setStatus(isAbortError(err) ? 'キャンセルしました(途中の回答は保存されません)' : String(err))
    } finally {
      abortRef.current = null
      setBusy(false)
      setLiveText('')
      setLiveAfter(null)
      // 最初の送信が失敗して会話が作られなかったら、確定しかけたアンカーを
      // 解いて選択への追従に戻す(凍ったままだと以後の送信が古いアンカーを使う)
      if (!latestChatId) setAnchorNode(null)
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
      setStatus('削除に失敗しました')
      return
    }
    void refreshUsage(chatId, anchorNode)
    void refreshHistory()
  }

  // 本文をクリップボードへ(lm-chat 移植)。返事は Markdown のまま写す
  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('コピーしました')
      // 状態行は次の送信まで残るので、合図だけ出して自分で消す
      window.setTimeout(() => setStatus((s) => (s === 'コピーしました' ? null : s)), 1500)
    } catch {
      setStatus('コピーに失敗しました')
    }
  }

  // ここで分岐(lm-chat 移植): 履歴をその位置まで複製した新しい会話を作って、そちらへ移る。
  // 元の会話は残るので、同じ所から別の聞き方・別の展開を試せる。
  // wholeTurn は返事の位置で分岐するとき(返事は往復の開始位置しか持たないので、往復ごと写す)
  const branchChat = async (index: number, wholeTurn: boolean): Promise<void> => {
    if (!chatId || busy) return
    let branched
    try {
      branched = await chatApi.branch(chatId, index, wholeTurn)
    } catch {
      setStatus('分岐に失敗しました')
      return
    }
    await loadChat(branched.id)
    void refreshHistory()
  }

  const startEditTurn = (turn: number, text: string): void => {
    setEditingTurn(turn)
    setEditText(text)
  }

  // 編集の保存: 本文だけ書き換えて返事は残す(lm-chat の Save)。作り直したいときは
  // 保存してから隣の ⟳ を押す流れ(ユーザー決定 2026-10-09)。以前は保存 = 送り直しだった
  const saveEditTurn = async (turn: number): Promise<void> => {
    const text = editText.trim()
    if (!chatId || !text) return
    try {
      setItems(buildDisplay((await chatApi.updateMessage(chatId, turn, text)).messages))
    } catch {
      setStatus('保存に失敗しました')
      return
    }
    setEditingTurn(null)
    void refreshHistory() // 冒頭の発言を直したら一覧の見出しも変わる
  }

  // 会話室: 履歴の 1 件(発言 / 演出指示)だけを消す
  const deleteRoomMessage = async (index: number, label: string): Promise<void> => {
    if (!chatId || busy) return
    if (!window.confirm(label)) return
    try {
      setItems(buildDisplay((await chatApi.deleteMessage(chatId, index)).messages))
    } catch {
      setStatus('削除に失敗しました')
      return
    }
    void refreshUsage(chatId, anchorNode)
    void refreshHistory()
  }

  // 会話室: 最後の発言を消して、同じ人にもう一度話させる
  const redoLastUtterance = async (index: number, speaker: string): Promise<void> => {
    if (!chatId || busy) return
    try {
      setItems(buildDisplay((await chatApi.deleteMessage(chatId, index)).messages))
    } catch {
      setStatus('作り直しに失敗しました')
      return
    }
    void sendRoom('', speaker, 1)
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

  if (!open) return null

  // ストリーミング中の吹き出し。再生成中はその発言の直後(liveAfter)に、通常は一番下に出す
  const liveBubble = liveText ? (
    <div className="mb-2 flex items-start gap-2">
      {(charById(liveSpeaker) ?? activeChar) && (
        <CharAvatar char={(charById(liveSpeaker) ?? activeChar)!} size={56} />
      )}
      <div
        className="max-w-[80%] rounded-2xl rounded-bl-md border px-3 py-1.5 text-[13px] leading-relaxed"
        style={{
          background: 'var(--bg-card)',
          borderColor: (charById(liveSpeaker) ?? activeChar)?.color || 'var(--border)',
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
  
  ) : null

  return (
    <div ref={rootRef} className="flex h-full min-h-0" style={{ background: 'var(--bg-chat)' }}>
      {/* 左サイドバー: これまでの会話。各項目の ⋯ で名前の変更と削除。
          幅は右端の分割線をドラッグして変えられる */}
      <aside className="flex shrink-0 flex-col" style={{ width: sidebarWidth }}>
        <button
          onClick={startNewChat}
          disabled={busy}
          className="m-2 rounded-lg border px-2 py-1 text-[12px] disabled:opacity-50"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          data-tip="選択中のシーンをアンカーに新しい会話を始める"
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
            if (!chatId) return
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
                      data-tip={`${isRoom ? subLabel + ' / ' : h.char_name ? h.char_name + ' / ' : ''}${h.anchor_title || '(シーンなし)'} まで`}
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
      </aside>
      {/* リサイズハンドル: 線はレイアウト実体の 1px、当たり判定だけ左右 3px はみ出させる */}
      <div
        className="relative w-px shrink-0 cursor-col-resize transition-colors hover:bg-[var(--accent-border)]"
        style={{ background: 'var(--border)' }}
        data-tip="ドラッグで幅を変更"
      >
        <div
          onPointerDown={beginSidebarResize}
          className="absolute inset-y-0 z-10 cursor-col-resize"
          style={{ left: -3, right: -3 }}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={panelRef} className="inspector-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-3 pt-2">
          {!charId && !room && <div className="mb-2"><ChatRulesPanel busy={busy} onDirty={setRulesDirty} onSaved={() => { void refreshUsage(chatId, liveAnchor) }} /></div>}
          {/* ヘッダー: 相手 / アンカー / スコープ */}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {/* 話す相手: 相談(編集者) or キャラ本人。切替は新規チャット扱い */}
            {activeChar ? (
              <CharAvatar char={activeChar} size={20} />
            ) : room ? (
              <Icon name="users" size={15} />
            ) : (
              <Icon name="chat" size={14} />
            )}
            <select
              value={room ? 'room' : charId ?? ''}
              onChange={(e) => switchTarget(e.target.value || null)}
              disabled={busy}
              className="rounded-md border px-1.5 py-0.5 text-[11px]"
              style={{
                background: 'var(--bg-input)',
                borderColor: activeChar?.color || 'var(--border)',
                color: 'var(--text-dim)'
              }}
              data-tip="話す相手。キャラを選ぶと、アンカー時点のそのキャラ本人と話せます。「キャラ同士の会話」は作者は参加せず、演出の指示だけ出します"
            >
              {/* option には SVG を置けないので、ここだけは文字だけで区別する */}
              <option value="">相談(編集者)</option>
              <option value="room">キャラ同士の会話</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}と話す
                </option>
              ))}
            </select>
            <span>
              アンカー: <span style={{ color: 'var(--text-dim)' }}>{anchorTitle(liveAnchor)}</span> まで
            </span>
            {room ? (
              // 参加者。会話が始まるまでは出し入れでき、始まったら固定(chats.participants)
              <div className="flex flex-wrap items-center gap-1">
                {(chatId ? roomChars : characters).map((c) => {
                  const on = participants.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleParticipant(c.id)}
                      disabled={!!chatId || busy}
                      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed"
                      style={
                        on
                          ? { borderColor: c.color || 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                          : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
                      }
                      data-tip={
                        chatId
                          ? '参加者は会話の開始時に固定されます(変えるには新規)'
                          : on
                            ? `${c.name} を会話から外す`
                            : `${c.name} を会話に加える`
                      }
                    >
                      <CharAvatar char={c} size={14} />
                      {c.name}
                    </button>
                  )
                })}
                {!chatId && !roomReady && <span>2 人以上選んでください</span>}
              </div>
            ) : charId ? (
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
                    data-tip={
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
                    data-tip={chatId ? 'スコープはチャット開始時に固定されます(変えるには新規)' : s === 'upto' ? 'アンカーまでの情報のみ' : '物語全体'}
                  >
                    {s === 'upto' ? 'ここまで' : '全体'}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => voice.setEnabled(!voice.enabled)}
              className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5"
              style={
                voice.enabled
                  ? { borderColor: 'var(--accent-border)', background: 'var(--accent-soft)', color: 'var(--text)' }
                  : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
              }
              aria-label={voice.enabled ? '返事の読み上げをオフにする' : '返事の読み上げをオンにする'}
              data-tip={
                voice.enabled
                  ? `返事を声で読みます(${activeChar ? `${activeChar.name}の声` : room ? '話す人それぞれの声' : '相談相手の声'})。クリックでオフ`
                  : '返事を声で読みます。キャラとの会話はキャラの声、相談は設定の「相談チャットの声」で読みます'
              }
            >
              <Icon name="speaker" size={12} />
              {voice.enabled ? '声 オン' : '声 オフ'}
            </button>
            {voice.speaking && (
              <button
                onClick={voice.stop}
                className="rounded-md border px-2 py-0.5"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="いまの読み上げを止める"
              >
                ■ 停止
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md border px-2 py-0.5"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
              data-tip="相談チャットを閉じる(履歴は残ります)"
            >
              ✕ 閉じる
            </button>
          </div>
          {/* メッセージ */}
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
            }}
            className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto pr-1"
          >
            {items.length === 0 && (
              <div className="pt-6 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                {room ? (
                  <>
                    <div className="mb-2 flex justify-center gap-2">
                      {roomChars.map((c) => (
                        <CharAvatar key={c.id} char={c} size={44} />
                      ))}
                    </div>
                    アンカー時点のキャラ同士に会話をさせます。あなたは会話に参加せず、演出の指示だけ出します。
                    <br />
                    記憶と関係の確かめ用で、この会話は物語には含まれません。指示を空にして「進める」だけでも話し始めます。
                  </>
                ) : activeChar ? (
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
              const el = ((): React.JSX.Element | null => {
                if (item.kind === 'user') {
                  const turn = item.turn
                  if (turn !== undefined && editingTurn === turn) {
                    // 編集中: その場で本文だけ書き換える(返事は残る。作り直しは ⟳ で)
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
                              if (e.key === 'Enter' && e.ctrlKey) {
                                e.preventDefault()
                                void saveEditTurn(turn)
                              }
                            }}
                            className="w-full resize-none rounded-2xl border px-3 py-1.5 text-[13px] outline-none"
                            style={{ background: 'var(--bg-input)', borderColor: 'var(--accent-border)' }}
                          />
                          <div className="mt-1 flex justify-end gap-2 text-[11px]">
                            <button onClick={() => setEditingTurn(null)} style={{ color: 'var(--text-faint)' }}>
                              取消
                            </button>
                            <button
                              onClick={() => void saveEditTurn(turn)}
                              disabled={!editText.trim()}
                              className="rounded-md px-2 py-0.5 font-medium text-white disabled:opacity-40"
                              style={{ background: 'var(--accent)' }}
                            >
                              保存
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
                      {turn !== undefined && !busy && room && (
                        <div className="mt-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <MsgActionButton
                            kind="branch"
                            tip="ここで分岐(この指示までを写した新しい会話を作る)"
                            onClick={() => void branchChat(turn, false)}
                          />
                          <MsgActionButton
                            kind="copy"
                            tip="本文をコピー"
                            onClick={() => void copyText(item.text)}
                          />
                          <MsgActionButton
                            kind="edit"
                            tip="この指示を書き換える(発言はそのまま。作り直しは隣の ⟳)"
                            onClick={() => startEditTurn(turn, item.text)}
                          />
                          <MsgActionButton
                            kind="regenerate"
                            tip={`この指示から以降の発言を作り直す(${turns} 発言)`}
                            onClick={() => void sendRoom('', undefined, undefined, turn + 1)}
                          />
                          <MsgActionButton
                            kind="delete"
                            tip="この指示を削除(発言は残す)"
                            onClick={() => void deleteRoomMessage(turn, 'この指示を削除しますか?')}
                          />
                        </div>
                      )}
                      {turn !== undefined && !busy && !room && (
                        <div className="mt-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <MsgActionButton
                            kind="branch"
                            tip="ここで分岐(この発言までを写した新しい会話を作る)"
                            onClick={() => void branchChat(turn, false)}
                          />
                          <MsgActionButton
                            kind="copy"
                            tip="本文をコピー"
                            onClick={() => void copyText(item.text)}
                          />
                          <MsgActionButton
                            kind="edit"
                            tip="この発言を書き換える(返事はそのまま。作り直しは隣の ⟳)"
                            onClick={() => startEditTurn(turn, item.text)}
                          />
                          <MsgActionButton
                            kind="regenerate"
                            tip="この発言の返事だけ作り直す(以降のやり取りは残る)"
                            onClick={() => regenerateTurn(turn, item.text)}
                          />
                          <MsgActionButton
                            kind="delete"
                            tip="このやり取りを削除"
                            onClick={() => void deleteTurn(turn, false)}
                          />
                        </div>
                      )}
                    </div>
                  )
                }
                if (item.kind === 'assistant') {
                  // 会話室では発言者ごとにアバターと枠色が替わる(相談 / キャラチャットは相手固定)
                  const speakerChar = item.speaker ? charById(item.speaker) : activeChar
                  const speakerName = speakerChar?.name ?? item.speaker
                  const isLast = i === items.length - 1
                  return (
                    <div key={i} className="group mb-2">
                      {/* 時刻は行の外に出す。中に入れるとアイコンが時刻の高さに
                          引っ張られて吹き出しとずれる。アイコンぶん字下げして
                          吹き出しの真上に来るようにする */}
                      <div className="flex items-baseline gap-2" style={{ marginLeft: speakerChar || item.speaker ? 64 : 0 }}>
                        {item.speaker && (
                          <span className="text-[10px]" style={{ color: speakerChar?.color || 'var(--text-dim)' }}>
                            {speakerName}
                          </span>
                        )}
                        <TimeLabel ts={item.ts} align="left" />
                      </div>
                      <div className="flex items-start gap-2">
                        {/* キャラモード・会話室では発言者のアイコンを添える */}
                        {speakerChar && <CharAvatar char={speakerChar} size={56} />}
                        <div className="min-w-0 max-w-[80%]">
                          <div
                            className="rounded-2xl rounded-bl-md border px-3 py-1.5 text-[13px] leading-relaxed"
                            style={{
                              background: 'var(--bg-card)',
                              // キャラモードはキャラ色の枠で「本人の発言」を示す
                              borderColor: speakerChar?.color || 'var(--border)',
                              color: 'var(--text)'
                            }}
                          >
                            <Markdown text={item.text} />
                          </div>
                          <div className="flex items-center gap-2">
                            {item.stats && <StatsLine stats={item.stats} />}
                            {(item.promptMessages || !busy) && (
                              <div className="mt-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                {item.turn !== undefined && !busy && (
                                  <MsgActionButton
                                    kind="branch"
                                    tip={
                                      item.speaker
                                        ? 'ここで分岐(この発言までを写した新しい会話を作る)'
                                        : 'ここで分岐(この返事までを写した新しい会話を作る)'
                                    }
                                    onClick={() => void branchChat(item.turn!, !item.speaker)}
                                  />
                                )}
                                <MsgActionButton kind="copy" tip="本文をコピー" onClick={() => void copyText(item.text)} />
                                {!busy && (
                                  <MsgActionButton
                                    kind="speak"
                                    tip={`この返事を声で読む(${speakerChar ? `${speakerChar.name}の声` : '相談相手の声'})`}
                                    onClick={() =>
                                      voice.speakText(
                                        item.text,
                                        item.speaker ? { charId: item.speaker, mode: 'roleplay' } : undefined
                                      )
                                    }
                                  />
                                )}
                                {item.promptMessages && (
                                  <MsgActionButton
                                    kind="prompt"
                                    tip="この返事の生成に送った内容(システムプロンプトと履歴)を見る"
                                    onClick={() => setPromptView(item.promptMessages!)}
                                  />
                                )}
                                {item.speaker && item.turn !== undefined && !busy && isLast && (
                                  <MsgActionButton
                                    kind="regenerate"
                                    tip={`この発言を消して、${speakerName} にもう一度話させる`}
                                    onClick={() => void redoLastUtterance(item.turn!, item.speaker!)}
                                  />
                                )}
                                {item.speaker && item.turn !== undefined && !busy && (
                                  <MsgActionButton
                                    kind="delete"
                                    tip="この発言を削除"
                                    onClick={() => void deleteRoomMessage(item.turn!, 'この発言を削除しますか?')}
                                  />
                                )}
                                {!item.speaker && item.turn !== undefined && !busy && (
                                  <MsgActionButton
                                    kind="delete"
                                    tip="この返事を削除(発言は残す)"
                                    onClick={() => void deleteTurn(item.turn!, true)}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                }
                if (item.kind === 'tool') {
                  const who = item.speaker ? charById(item.speaker)?.name ?? item.speaker : null
                  return (
                    <div
                      key={i}
                      className="mb-1 flex items-center gap-1 text-[11px]"
                      style={{ color: 'var(--text-faint)', marginLeft: item.speaker ? 64 : 0 }}
                    >
                      {item.name === 'recall' ? (
                        <>
                          <Icon name="recall" size={12} /> {who ? `${who} が記憶をたどった` : '記憶をたどった'}
                        </>
                      ) : (
                        <>
                          <Icon name="search" size={12} /> {item.name}
                        </>
                      )}
                    </div>
                  )
                }
                return null
              })()
              if (liveAfter !== i || !liveBubble) return el
              return (
                <Fragment key={`live-${i}`}>
                  {el}
                  {liveBubble}
                </Fragment>
              )
            })}
            {liveAfter === null && liveBubble}
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
                  key={`${c.dynamic ? 'dyn' : 'fix'}:${c.text}`}
                  onClick={() => void send(c.text)}
                  disabled={busy}
                  className="chat-suggest-chip flex max-w-full items-center gap-1 rounded-full border px-3 py-1 text-[11px] disabled:opacity-40"
                  style={{
                    background: 'var(--bg-card)',
                    borderColor: c.dynamic ? 'var(--accent-border)' : 'var(--border-strong)',
                    color: c.dynamic ? 'var(--text)' : 'var(--text-dim)'
                  }}
                  data-tip={c.dynamic ? `${c.text}(物語の内容から作られた質問)` : c.text}
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
                data-tip="ほかの候補を見る"
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
                room
                  ? '演出の指示(空のまま進めてもよい)…(Enter で進める)'
                  : activeChar
                    ? `${activeChar.name} に話しかける…(Enter で送信)`
                    : '物語について相談…(Enter で送信)'
              }
              className="min-w-0 flex-1 resize-none rounded-lg border px-3 py-1.5 text-[13px] outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
            />
            {room && (
              <>
                {/* 次に話す人の指名(1 回きり)と、続けて話させる発言数 */}
                <select
                  value={nextSpeaker ?? ''}
                  onChange={(e) => setNextSpeaker(e.target.value || null)}
                  disabled={busy || !roomReady}
                  className="shrink-0 rounded-md border px-1.5 py-1 text-[11px] disabled:opacity-50"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                  data-tip="次に話す人。「順に」は前に話した人の次"
                >
                  <option value="">順に</option>
                  {roomChars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}から
                    </option>
                  ))}
                </select>
                <select
                  value={turns}
                  onChange={(e) => setTurns(Number(e.target.value))}
                  disabled={busy}
                  className="shrink-0 rounded-md border px-1.5 py-1 text-[11px]"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                  data-tip="1 回「進める」で続けて話させる発言数"
                >
                  {ROOM_TURN_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n} 発言
                    </option>
                  ))}
                </select>
              </>
            )}
            {/* コンテキスト使用量のリング(lm-chat の token-ring を移植) */}
            {usage && <ContextUsageRing usage={{ token_count: usage.tokens, ctx_size: usage.ctx, estimated: usage.estimated }} />}
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
                disabled={room ? !roomReady : !input.trim()}
                className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
                data-tip={room ? (roomReady ? `${turns} 発言ぶん会話を進める` : '参加者を 2 人以上選んでください') : undefined}
              >
                {room ? '進める' : '送信'}
              </button>
            )}
          </div>
        </div>
      </div>
      {promptView !== null && <SystemPromptModal messages={promptView} onClose={() => setPromptView(null)} />}
    </div>
  )
}
