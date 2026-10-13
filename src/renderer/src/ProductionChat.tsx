import ChatHistoryPanel from './ChatHistoryPanel'
import { productionSuggestions, type ProductionSuggestion } from './productionSuggestions'
import type { ProductionTarget } from './Workspace'
import ChatRulesPanel from './ChatRulesPanel'
import ProductionPreviewPanel from './ProductionPreviewPanel'
import AutoTextarea from './AutoTextarea'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chatApi, isAbortError, productionApi, type ChatSummary, type ProductionInstruction, type ProductionPolicy, type ProductionOperation, type ProductionSelectedNode, type ProductionStep } from './api'
import { Markdown } from './Markdown'
import { showStatusNotice } from './statusNotice'
import { setProductionPreview } from './productionPreview'
import { cancelTask, enqueueTask, notifyGraphChanged, setNodeBusy, useTask } from './tasks'
import { frameSetter } from './frameSetter'
import type { Group, Snapshot, StoryNode } from './types'
import { Icon } from './icons'
import ProductionMemoryPanel from './ProductionMemoryPanel'
import ProductionPolicyPanel, { defaultProductionPolicy, policySummary } from './ProductionPolicyPanel'
import ContextUsageRing, { type ContextUsage } from './ContextUsageRing'

interface Message {
  selected_nodes?: ProductionSelectedNode[]
  created_at?: string
  policy?: ProductionPolicy
  policy_after?: ProductionPolicy
  policy_label?: string
  /** 依頼を「制作を実行」として送ったか(相談なら false。古い履歴には無い) */
  execute?: boolean
  role: string
  content: string
  operation?: ProductionOperation
  snapshot?: Snapshot
  instruction?: ProductionInstruction['instruction']
  /** 読み取りの手順(何を読んだか)。LLM には渡らない、時系列の表示用の記録 */
  step?: ProductionStep
  /** 途中指示の照合・作業メモの更新や見直しの通知 */
  instruction_review?: boolean
  memory_review?: boolean
  memory_revision?: number
}

const operationLabels = { insert_scene: '追加', branch_scene: '分岐を追加', update_scene: '編集', delete_scene: '削除', reconnect_scene: 'つなぎ替え',
  create_character: 'キャラクター登録', update_character: 'キャラクター編集', delete_character: 'キャラクター削除',
  create_place: '場所登録', update_place: '場所編集', delete_place: '場所削除',
  create_setting_document: '設定資料作成', update_setting_document: '設定資料編集',
  create_chapter: '章を作成', rename_chapter: '章名を変更', add_scenes_to_chapter: '章にシーンを追加' }
const libraryFieldLabels: Record<string, string> = {
  name: '名前', profile: 'プロフィール', appearance: '外見', voice: '口調', reading: '読み', color: '色',
  description: '説明', atmosphere: '雰囲気', title: 'タイトル', node_ids: '所属シーンID'
}

function messageTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ja-JP', { hour12: false })
}

/** 完了時に添える経過時間(「45秒」「3分05秒」「1時間02分05秒」)。 */
function elapsedText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(total >= 60 ? 2 : 1, '0')
  if (hours) return `${hours}時間${String(minutes).padStart(2, '0')}分${seconds}秒`
  return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

/** 時系列の1項目(左の線と丸 + 見出し + 中身)。丸の色で種類を示す。配置は index.css の timeline-item */
function TimelineItem({ color, label, time, children, pulse = false }: {
  color: string; label: React.ReactNode; time?: string; children?: React.ReactNode; pulse?: boolean
}): React.JSX.Element {
  return (
    <div className="timeline-item">
      <span className={`timeline-dot${pulse ? ' animate-pulse' : ''}`} style={{ background: color }} />
      {/* 時刻は右端に揃える(見出しの長さで位置がばらつくと、時刻だけを縦に追えない) */}
      <div className="flex items-baseline gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
        {messageTime(time) && <time dateTime={time} className="shrink-0 tabular-nums" data-tip={new Date(time!).toLocaleString('ja-JP')}>{messageTime(time)}</time>}
      </div>
      {children}
    </div>
  )
}

/** 発言の一覧。入力や進捗表示のたびに全発言を描き直さないよう、発言が変わったときだけ更新する。
 *  作者の発言は右寄せの吹き出し、制作側(読み取り・操作・報告)は時系列の線と丸で並べる。 */
const MessageList = memo(function MessageList({ messages, nodes, groups }: {
  messages: Message[]; nodes: StoryNode[]; groups: Group[]
}): React.JSX.Element {
  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'user') return (
          <div key={i} className="mb-2 ml-auto w-fit max-w-[85%] rounded-lg border px-3 py-1.5 [overflow-wrap:anywhere]" style={{
            background: 'var(--accent-soft)', borderColor: 'var(--border)'
          }}>
            <div className="mb-1 flex items-baseline gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              <span className="min-w-0 flex-1">
                {m.instruction ? `途中指示・${({ accepted: '受け付けました', reflected: '次の判断に反映しました', unapplied: '未反映のまま終了しました' })[m.instruction.status]}` : 'あなた'}
                {/* 相談と実行の発言が混ざるので、作品を書き換えた依頼には印を付ける */}
                {m.execute === true && !m.instruction && <span className="ml-2" style={{ color: 'var(--execute)' }}>制作を実行</span>}
              </span>
              {messageTime(m.created_at) && <time dateTime={m.created_at} className="shrink-0 tabular-nums" data-tip={new Date(m.created_at!).toLocaleString('ja-JP')}>{messageTime(m.created_at)}</time>}
            </div>
            {/* 送信時の条件は、既定でないときだけ出す(全体・保護なし・選択なしを毎回出すと本文が読みにくい)。
                変更範囲と保護は相談では使われないので、相談の発言には出さない */}
            {m.policy && m.execute !== false && (m.policy.allowed_ids !== null || m.policy.group_id !== null || m.policy.protected_ids.length > 0) &&
              <p className="mb-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>{m.policy_label || policySummary(m.policy, nodes, groups)}</p>}
            {!!m.selected_nodes?.length && <p className="mb-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
              送信時の選択: {m.selected_nodes.map((node) => node.title).join('、')}
            </p>}
            <Markdown text={m.content} />
          </div>
        )
        // 読み取りの手順: 何を読んだかを1行で。本文は出さない
        if (m.step) return (
          <TimelineItem key={i} time={m.created_at} color={m.step.error ? 'var(--danger)' : 'var(--text-faint)'}
            label={<span data-step={m.step.name} style={{ color: 'var(--text-dim)' }}>{m.step.label}{m.step.detail ? `: ${m.step.detail}` : ''}{m.step.repeated ? '(前回の結果を再利用)' : ''}</span>}>
            {m.step.error && <p className="text-[11px] [overflow-wrap:anywhere]" style={{ color: 'var(--danger)' }}>{m.step.error}</p>}
          </TimelineItem>
        )
        // 確定した操作: 作品が実際に変わった印として緑の丸。変更内容は折りたたむ
        if (m.operation) {
          const operation = m.operation
          return (
            <TimelineItem key={i} time={m.created_at} color="var(--ok)"
              label={<span style={{ color: 'var(--text)' }}>{operationLabels[operation.action]}: {operation.title || '(無題)'}</span>}>
              {'entity_id' in operation && <details className="mb-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                <summary className="cursor-pointer">{operation.entity_type === 'chapter' ? '章の変更内容' : '資料庫の変更内容'}</summary>
                {Object.keys(operation.after ?? operation.before ?? {}).filter((field) => operation.before?.[field] !== operation.after?.[field]).map((field) =>
                  <p key={field} className="whitespace-pre-wrap break-words">{libraryFieldLabels[field] ?? field}: {operation.before?.[field] || '（未設定）'} → {operation.after?.[field] || '（未設定）'}</p>)}
              </details>}
              {operation.connection && <p className="mb-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {operation.connection.mode === 'scene' ? '1シーンを移動' : '枝ごと親を変更'}: {operation.connection.old_parent_title || '接続なし'} → {operation.connection.parent_title || operation.connection.parent_id} の後
              </p>}
              <Markdown text={m.content} />
            </TimelineItem>
          )
        }
        if (m.snapshot) return (
          <TimelineItem key={i} time={m.created_at} color="var(--text-faint)" label="スナップショット">
            <Markdown text={m.content} />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
              保存名: {m.snapshot.label}。設定のスナップショット一覧から戻せます（ライブラリ全体の復元）。
            </p>
          </TimelineItem>
        )
        // 途中指示の照合・作業メモの通知はアクセント色、LLM の文章(回答・報告)は灰色
        const notice = m.instruction_review || m.memory_review || m.memory_revision !== undefined
        return (
          <TimelineItem key={i} time={m.created_at} color={notice ? 'var(--accent)' : 'var(--text-dim)'}
            label={m.instruction_review ? '途中指示の照合' : m.memory_review || m.memory_revision !== undefined ? '作業メモ' : '制作'}>
            <Markdown text={m.content} />
          </TimelineItem>
        )
      })}
    </>
  )
})

/** 制作専用チャット。相談履歴とは分け、選択した送信モードで書き込みの可否を決める。 */
export default function ProductionChat({ beforeExecute, onChanged, onFollowTarget, onManualEdit, nodes, groups, policy, setPolicy, selectedNodeIds, chapterSelected, chapter, active = true }: {
  selectedNodeIds: string[]
  /** レビュー候補の対象にする章(選択中の章カード、無ければ開いている章)。シーン選択中は null */
  chapter: { id: string; title: string } | null
  /** 画面に出ているか。隠れている間はコンテキスト量の問い合わせ(サーバーで全文を組み立てる)を止める */
  active?: boolean
  chapterSelected: boolean
  policy: ProductionPolicy
  setPolicy: React.Dispatch<React.SetStateAction<ProductionPolicy>>
  onManualEdit: (paused: boolean) => void
  nodes: StoryNode[]
  groups: Group[]
  beforeExecute: () => string | null
  onChanged: (operation: ProductionOperation) => Promise<void>
  onFollowTarget: (target: ProductionTarget | null) => void
}): React.JSX.Element {
  const [chatId, setChatId] = useState<string | null>(null)
  const [history, setHistory] = useState<ChatSummary[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [rulesDirty, setRulesDirty] = useState(false)
  const [rulesRefresh, setRulesRefresh] = useState(0)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [memoryRefresh, setMemoryRefresh] = useState(0)
  const [input, setInput] = useState('')
  const [sendMode, setSendMode] = useState<'consult' | 'execute'>('consult')
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [live, setLiveState] = useState('')
  // ストリーミング本文は 1 フレームに 1 回だけ反映する(トークンごとの描き直しを避ける)
  const setLive = useMemo(() => frameSetter(setLiveState), [])
  const [status, setStatus] = useState('')
  const [statusAt, setStatusAt] = useState<string>()
  const [error, setError] = useState('')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [manualReady, setManualReady] = useState(false)
  const [manualEditing, setManualEditing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const manualRef = useRef(false)
  const [runId, setRunId] = useState<string | null>(null)
  const runRef = useRef<string | null>(null)
  // 待機列で順番待ちのまま停止されたとき、入力欄へ戻す依頼文(動き出したら null)
  const pendingMessageRef = useRef<string | null>(null)
  const [sendingInstruction, setSendingInstruction] = useState(false)
  const instructionRequest = useRef<{ runId: string; text: string; id: string; selectedIds: string[] } | null>(null)
  const selectionKey = JSON.stringify(selectedNodeIds)
  const selection = selectedNodeIds.map((id) => {
    const node = nodes.find((item) => item.id === id)
    return { id, title: node?.title || '(無題)', kind: node?.kind ?? null }
  })
  const [follow, setFollow] = useState(true)
  const followRef = useRef(true)
  const followTargetRef = useRef<ProductionTarget | null>(null)
  const task = useTask(taskId)
  const [historyBusy, setHistoryBusy] = useState(false)
  const busy = !!task || historyBusy
  const endRef = useRef<HTMLDivElement>(null)
  const taskRef = useRef<string | null>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  // LLM が直前の応答から作る候補(「橋で再会する案で進めて」など、対象を指すもの)。
  // 制作・相談が完了するたびに取り直し、次の送信や会話の切り替えで捨てる。
  // dynamicState: none = 取っていない / loading = 取得中 / done = LLM が判断した / unavailable = 使えなかった
  const [dynamic, setDynamic] = useState<ProductionSuggestion[]>([])
  const [dynamicState, setDynamicState] = useState<'none' | 'loading' | 'done' | 'unavailable'>('none')
  const suggesting = dynamicState === 'loading'
  // 固定の「この案で進めて」は、LLM の候補が無いときの代わり。取得中に出すと、押す瞬間に LLM の候補と
  // 入れ替わって別の実行を押しかねないので、結果が出るまで出さない
  const suggestions = productionSuggestions(messages, selection, chapter, dynamicState === 'none' || dynamicState === 'unavailable')
  const [suggestTick, setSuggestTick] = useState(0)
  const suggestHandled = useRef(0)
  const suggestAbort = useRef<AbortController | null>(null)
  const clearDynamic = (): void => {
    suggestAbort.current?.abort()
    suggestAbort.current = null
    setDynamic([])
    setDynamicState('none')
  }
  // generated は LLM が作った候補(相談チャットと同じ sparkle のアイコンを付けて、固定の候補と見分ける)
  const chips = [
    ...suggestions.map((item) => ({ ...item, generated: false })),
    ...dynamic.filter((item) => !suggestions.some((fixed) => fixed.label === item.label)).map((item) => ({ ...item, generated: true }))
  ]
  // 次の送信が実行になる状態(入力欄の枠・送信ボタン・案内を実行の色にする)。相談の処理中は切り替え自体が効かないので除く
  const executeArmed = sendMode === 'execute' && (!busy || !!runId)

  useEffect(() => {
    // 隠れている間(相談タブ・鑑賞モード・チャットを閉じている)は問い合わせない。
    // この部品は常にマウントされているので、止めないとシーンの選択やグラフの
    // 読み直しのたびにサーバーがプロンプト全体を組み立ててトークン数を数える
    if (busy || !active) return
    let stale = false
    const timer = window.setTimeout(() => {
      void productionApi.tokenUsage({ chat_id: chatId, message: input, execute: sendMode === 'execute', policy, selected_node_ids: selectedNodeIds })
        .then((result) => { if (!stale) setUsage(result) })
        .catch(() => { if (!stale) setUsage(null) })
    }, 400)
    return () => { stale = true; window.clearTimeout(timer) }
  }, [busy, active, chatId, input, sendMode, policy, rulesRefresh, memoryRefresh, memoryDirty, messages, nodes, groups, selectionKey])

  const bumpMemoryRefresh = useCallback((): void => setMemoryRefresh((value) => value + 1), [])
  const refreshHistory = async (): Promise<void> => setHistory(await productionApi.list())
  useEffect(() => {
    void refreshHistory().catch((e) => setError(String(e)))
    return () => { setProductionPreview(null); suggestAbort.current?.abort(); if (taskRef.current) cancelTask(taskRef.current) }
  }, [])
  useEffect(() => {
    // 完了の後始末(履歴の読み直し)が終わって busy が下りてから取りに行く
    if (busy || !chatId || suggestTick === suggestHandled.current) return
    suggestHandled.current = suggestTick
    const controller = new AbortController()
    suggestAbort.current?.abort()
    suggestAbort.current = controller
    setDynamicState('loading')
    const finish = (state: 'done' | 'unavailable', items: ProductionSuggestion[]): void => {
      if (controller.signal.aborted || suggestAbort.current !== controller) return
      suggestAbort.current = null
      setDynamic(items)
      setDynamicState(state)
    }
    void productionApi.suggest(chatId, controller.signal)
      .then((result) => finish(result.generated ? 'done' : 'unavailable', result.suggestions))
      .catch(() => finish('unavailable', [])) // 候補は無くても困らない。固定の候補に戻す
  }, [busy, chatId, suggestTick])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [messages, live, status, busy, error, chips.length, suggesting])

  const load = async (id: string): Promise<void> => {
    if (busy) return
    clearDynamic()
    setHistoryBusy(true)
    setUsage(null)
    try {
      const chat = await chatApi.get(id)
      if (chat.mode !== 'production') return
      setChatId(id)
      const loaded = chat.messages as unknown as Message[]
      setMessages(loaded)
      // 最後の依頼の終了時の条件(policy_after)を優先し、中断などで無ければ開始時の条件に戻す。
      const lastRequest = [...loaded].reverse().find((m) => m.policy)
      setPolicy(lastRequest?.policy_after ?? lastRequest?.policy ?? defaultProductionPolicy())
      setLive('')
      setError('')
      setStatus('')
    } catch (e) { setError(String(e)) }
    finally { setHistoryBusy(false) }
  }

  const deleteConversation = async (targetId: string): Promise<void> => {
    if (busy) return
    const title = history.find((item) => item.id === targetId)?.title || '現在の制作の会話'
    if (!window.confirm(`「${title}」の会話履歴を削除しますか?\n会話履歴は元に戻せません。作品・資料庫・作業メモ・スナップショットは残ります。`)) return
    setHistoryBusy(true)
    setError('')
    try {
      await chatApi.delete(targetId)
      setHistory((previous) => previous.filter((item) => item.id !== targetId))
      if (targetId === chatId) {
        clearDynamic()
        setChatId(null)
        setMessages([])
        setUsage(null)
        setLive('')
        setStatus('')
        followTargetRef.current = null
        onFollowTarget(null)
      }
      // 現在のAI保護・変更範囲と、入力中の依頼はそのまま次の会話へ引き継ぐ。
      showStatusNotice('制作の会話履歴を削除しました')
    } catch (e) { setError(`会話履歴を削除できませんでした: ${String(e)}`) }
    finally { setHistoryBusy(false) }
  }

  const recordInstruction = (item: ProductionInstruction): void => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.instruction?.id === item.instruction.id)
      if (index < 0) return [...prev, item]
      // HTTPの受付応答がSSEの反映通知より遅れても、表示を「受付」に戻さない。
      if (prev[index].instruction?.status !== 'accepted' && item.instruction.status === 'accepted') return prev
      return prev.map((m, i) => i === index ? item : m)
    })
  }

  const instruct = async (): Promise<void> => {
    const text = input.trim()
    if (!runId || !text || sendingInstruction) return
    const activeRun = runId
    const previous = instructionRequest.current
    const request = previous?.runId === activeRun && previous.text === text
      ? previous : { runId: activeRun, text, id: crypto.randomUUID(), selectedIds: [...selectedNodeIds] }
    instructionRequest.current = request
    setSendingInstruction(true)
    setError('')
    try {
      const item = await productionApi.instruct(activeRun, request.id, text, request.selectedIds)
      if (runRef.current === activeRun) recordInstruction(item)
      setInput((value) => value.trim() === text ? '' : value)
      instructionRequest.current = null
    } catch (e) { setError(String(e)) }
    finally { setSendingInstruction(false) }
  }

  const toggleManual = async (): Promise<void> => {
    if (!runId || switching) return
    const paused = !manualEditing
    const blocked = paused ? null : beforeExecute()
    if (blocked) { setError(blocked); return }
    setSwitching(true)
    setError('')
    // 再開の要求を送る前に画面をロックし、新しい手動操作を入れない。
    if (!paused) onManualEdit(false)
    try {
      await productionApi.pause(runId, paused)
      manualRef.current = paused
      setManualEditing(paused)
      onManualEdit(paused)
      if (paused) { setProductionPreview(null); onFollowTarget(null) }
      setStatus(paused ? '一時停止中(手動編集)。保存してから「制作を再開」を押すと、続きから進みます。' : '最新の構成を読み直して再開します…')
      setStatusAt(new Date().toISOString())
    } catch (e) {
      onManualEdit(manualRef.current)
      setError(String(e))
    } finally { setSwitching(false) }
  }

  /** text を渡すと入力欄の代わりにその文面を送る(候補のボタン用) */
  const send = (execute: boolean, text = input): void => {
    const message = text.trim()
    if (!message || busy) return
    if (rulesDirty) { setError('制作エージェントへの指示を保存するか、元に戻してから送信してください。'); return }
    if (memoryDirty) { setError('作業メモを保存するか、編集をキャンセルしてから送信してください。'); return }
    const blocked = execute ? beforeExecute() : null
    if (blocked) { setError(blocked); return }
    if (execute && policy.allowed_ids?.length === 0) { setError('変更できるシーンを1つ以上選んでください'); return }
    const selectedIds = [...selectedNodeIds]
    const selectedNodes = selection.map((node) => ({ ...node }))
    clearDynamic()
    setError('')
    setStatus('')
    setRunId(null)
    setManualReady(false)
    runRef.current = null
    setInput('')
    setProductionPreview(null)
    pendingMessageRef.current = message
    let currentChatId = chatId
    let activeNode: string | null = null
    const id = enqueueTask({
      label: execute ? '制作' : '制作の相談', kind: 'production',
      runner: async ({ signal, update }) => {
        // 待機列で待った時間は含めず、実際に動き出してからを測る。
        const startedAt = Date.now()
        pendingMessageRef.current = null
        setStatus('開始の準備をしています…')
        setStatusAt(new Date().toISOString())
        setMessages((prev) => [...prev, { role: 'user', content: message, selected_nodes: selectedNodes, created_at: new Date().toISOString(), execute, policy, policy_label: policySummary(policy, nodes, groups) }])
        let text = ''
        let receivedAt: string | undefined
        let finished = false
        let completed = false // 停止・エラーでなく最後まで終わった(依頼候補を取り直す)
        // 終了理由(完了 / 上限 / 反復停止 / 空応答 / 報告の途切れ)と件数。サーバーの done が持つ
        let summary: string | null = null
        const flush = (): void => {
          const content = text
          if (content) {
            const created_at = receivedAt ?? new Date().toISOString()
            setMessages((prev) => [...prev, { role: 'assistant', content, created_at }])
          }
          text = ''
          setLive('')
        }
        try {
          await productionApi.send({ chat_id: currentChatId, message, execute, policy, selected_node_ids: selectedIds }, async (event) => {
            receivedAt = event.timestamp ?? new Date().toISOString()
            const created_at = receivedAt
            if (event.usage) setUsage(event.usage)
            if (event.chat_id) { currentChatId = event.chat_id; setChatId(event.chat_id) }
            if (event.run_id && event.accepting_instructions) {
              runRef.current = event.run_id
              setRunId(event.run_id)
            }
            if (event.manual_edit_ready) setManualReady(true)
            if (event.memory) {
              setMemoryRefresh((value) => value + 1)
              setMessages((prev) => [...prev, { role: 'assistant', content: `作業メモを更新しました: ${event.memory!.reason}`, created_at }])
            }
            if (event.instruction) recordInstruction(event.instruction)
            if (event.step) {
              const step = event.step
              setMessages((prev) => [...prev, { role: 'assistant', content: '', step, created_at }])
            }
            if (event.delta) { text += event.delta; setLive(text) }
            if (event.response_end) { setProductionPreview(null); flush() }
            if (event.stage) { setStatus(event.stage); setStatusAt(created_at); update({ detail: event.stage }) }
            if ('active_node' in event && event.active_node !== activeNode) {
              setProductionPreview(null)
              setNodeBusy(activeNode, false)
              activeNode = event.active_node ?? null
              setNodeBusy(activeNode, true)
              if (activeNode) {
                followTargetRef.current = { kind: 'scene', id: activeNode }
                if (followRef.current && !manualRef.current) onFollowTarget(followTargetRef.current)
              }
            }
            if (event.active_library) {
              followTargetRef.current = { kind: event.active_library.kind, id: event.active_library.id }
              if (followRef.current && !manualRef.current) onFollowTarget(followTargetRef.current)
            }
            if ('preview' in event && !manualRef.current) setProductionPreview(event.preview ?? null)
            if (event.snapshot) {
              const snapshot = event.snapshot
              setMessages((prev) => [...prev, { role: 'assistant', content: '作業前の状態を保存しました。', snapshot, created_at }])
            }
            if (event.changed) {
              const operation = event.changed
              setPolicy((previous) => previous.allowed_ids === null ? previous : { ...previous,
                allowed_ids: operation.action === 'insert_scene' || operation.action === 'branch_scene' ? [...previous.allowed_ids, operation.node_id]
                  : operation.action === 'delete_scene' ? previous.allowed_ids.filter((id) => id !== operation.node_id) : previous.allowed_ids })
              setMessages((prev) => [...prev, { role: 'assistant', content: operation.reason, operation, created_at }])
              await onChanged(operation)
              setProductionPreview(null)
              const target: ProductionTarget = 'entity_id' in operation
                ? { kind: operation.entity_type, id: operation.entity_id }
                : { kind: 'scene', id: operation.node_id }
              if (!operation.action.startsWith('delete_')) {
                followTargetRef.current = target
                if (followRef.current && !manualRef.current) onFollowTarget(target)
              } else if (followTargetRef.current?.kind === target.kind && followTargetRef.current?.id === target.id) {
                followTargetRef.current = null
                onFollowTarget(null)
              }
            }
            if (event.tool_error) { setProductionPreview(null); setStatus(`変更を見直しています: ${event.tool_error}`); setStatusAt(created_at) }
            if (event.error) throw new Error(event.error)
            if (event.done) { finished = true; summary = event.summary ?? null }
          }, signal)
          if (!finished) throw new Error('接続が終了しました。確定済みの変更と履歴を確認してください。')
          setStatus(`${summary ?? '完了しました'}（経過時間 ${elapsedText(Date.now() - startedAt)}）`)
          completed = true
        } catch (e) {
          if (isAbortError(e)) setStatus('停止しました。確定済みの変更は残しています。')
          else setError(String(e))
        } finally {
          setStatusAt(new Date().toISOString())
          setProductionPreview(null)
          manualRef.current = false
          setManualEditing(false)
          setManualReady(false)
          onManualEdit(false)
          runRef.current = null
          setRunId(null)
          flush()
          setNodeBusy(activeNode, false)
          // 実行は1回ごとに選び直す。終わったら(完了・停止・エラーのどれでも)相談へ戻し、
          // 次の何気ない発言が実行として送られないようにする
          if (execute) setSendMode('consult')
          // サーバー側の中断・保存が完了するまで、次のキューと手動編集を待たせる。
          try {
            while ((await productionApi.status()).active) {
              await new Promise((resolve) => setTimeout(resolve, 200))
            }
            if (currentChatId) {
              const chat = await chatApi.get(currentChatId)
              setMessages(chat.messages as unknown as Message[])
            }
            await refreshHistory()
          } catch { /* サーバー終了時は画面に残っている経過を保つ */ }
          // busy が下りる前に取得中にしておく(固定の「この案で進めて」が一瞬出るのを防ぐ)
          if (completed) { setDynamicState('loading'); setSuggestTick((value) => value + 1) }
          notifyGraphChanged()
          taskRef.current = null
        }
      }
    })
    taskRef.current = id
    setTaskId(id)
  }

  const submit = (): void => {
    if (busy) {
      if (runId) void instruct()
    } else {
      send(sendMode === 'execute')
    }
  }

  const renameConversation = async (id: string, title: string): Promise<void> => {
    if (busy) return
    setHistoryBusy(true)
    try {
      await chatApi.rename(id, title)
      setHistory((items) => items.map((item) => item.id === id ? { ...item, title: title || null } : item))
    } catch (e) { setError(`会話名を変更できませんでした: ${String(e)}`) }
    finally { setHistoryBusy(false) }
  }

  return (
    <div ref={composerRef} className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col" style={{ background: 'var(--bg-chat)' }}>
      <ChatHistoryPanel history={history} chatId={chatId} busy={busy} production
        chatLabel={(item) => item.title || item.snippet || '制作'}
        startNewChat={() => {
          if (busy) return
          clearDynamic()
          setChatId(null); setMessages([]); setUsage(null); setPolicy(defaultProductionPolicy()); setStatus(''); setError('')
          followTargetRef.current = null; onFollowTarget(null)
        }}
        loadChat={load} deleteChat={deleteConversation} commitRename={renameConversation}
        newChatTip="新しい制作の会話を始める" />
    <div className="inspector-scrollbar flex flex-1 min-h-0 min-w-0 w-full flex-col gap-2 overflow-y-auto px-4 py-2 text-[12px]" style={{ background: 'var(--bg-chat)', color: 'var(--text)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-faint)' }}>制作</span>
        <button onClick={() => { followRef.current = !follow; setFollow(!follow); onFollowTarget(!follow && !manualRef.current ? followTargetRef.current : null) }}
          className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
          style={follow ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' } : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          data-tip="作業対象のシーンへ移動し、キャラクター・場所の編集時は資料庫の対象を開きます">{follow ? '☑' : '☐'} 作業対象を追う</button>
      </div>
      {busy && runId && <button disabled={!manualReady || switching} onClick={() => void toggleManual()}
        className="rounded-md border px-2 py-0.5 text-[12px] disabled:opacity-50"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-strong)' }}
        data-tip={!manualReady ? '作業前の保存が終わるまでお待ちください' : manualEditing ? '未保存のシーンを保存してから、最新の構成で制作を再開します' : '制作を一時停止して、シーンと接続を手動で編集します。書きかけの操作は破棄されます。「制作を再開」で続きから進みます'}>
        {switching ? '切り替えています…' : manualEditing ? '制作を再開' : '一時停止して手動編集'}
      </button>}
      <ChatRulesPanel busy={busy} onDirty={setRulesDirty} onSaved={() => setRulesRefresh((v) => v + 1)} />
      <ProductionMemoryPanel busy={busy} refresh={memoryRefresh} onDirty={setMemoryDirty} onChanged={bumpMemoryRefresh} />
      <ProductionPolicyPanel value={policy} onChange={setPolicy} nodes={nodes} groups={groups} busy={busy} />
      {/* スクロールバーは親の右の余白(16px)へ出し、発言との間を 6px 空ける。溝を常に確保するので、
          スクロールの有無にかかわらず発言の右端は上のパネルや入力欄と揃う(16 = バー10 + 余白6) */}
      <div className="inspector-scrollbar -mr-4 min-h-0 flex-1 overflow-y-auto pr-1.5 [scrollbar-gutter:stable]" aria-live="polite">
        <MessageList messages={messages} nodes={nodes} groups={groups} />
        {live && <TimelineItem color="var(--text-dim)" label="制作" pulse><Markdown text={live} /></TimelineItem>}
        {/* 書いている途中の本文(未確定)。確定すると消え、同じ場所に操作の項目が入る */}
        <ProductionPreviewPanel nodes={nodes} />
        {/* 押すとその場で送る。送り方を色で分ける(相談=アクセント、実行=--execute) */}
        {!busy && !error && (chips.length > 0 || suggesting) && <div aria-label="制作の依頼候補" className="my-2 flex flex-wrap items-center gap-1.5">
          {chips.map((suggestion) => <button key={suggestion.label} type="button" disabled={!!input.trim()}
            onClick={(e) => {
              // Shift を押しながらだと送らず、入力欄へ入れる(文面を直してから送れる)
              if (e.shiftKey) {
                setInput(suggestion.text)
                setSendMode(suggestion.execute ? 'execute' : 'consult')
                composerRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="制作への依頼"]')?.focus()
                return
              }
              send(suggestion.execute, suggestion.text)
            }}
            className={`production-suggest-chip ${suggestion.execute ? 'execute-action' : 'accent-action'} inline-flex max-w-full items-center gap-1 rounded-full border px-3 py-1 text-left text-[11px] [overflow-wrap:anywhere] disabled:opacity-40`}
            data-tip={input.trim() ? '入力中の文章を送信するか空にすると選べます'
              : `${suggestion.text}\n${suggestion.execute ? 'クリックで「制作を実行」として送信します(作業前の状態を保存してから、作品を編集します)。' : 'クリックで相談として送信します(作品は変更しません)。'}\nShift＋クリックで、送らずに入力欄へ入れます。${suggestion.generated ? '\n(直前の回答から AI が作った候補)' : ''}`}>
            {suggestion.generated && <Icon name="sparkle" size={11} className="shrink-0" />}
            <span className="min-w-0">{suggestion.label}</span>
          </button>)}
          {suggesting && <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>ほかの候補を考えています…</span>}
        </div>}
        <div ref={endRef} />
      </div>
      {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        {status && messageTime(statusAt) && <time dateTime={statusAt} className="mr-2 tabular-nums">{messageTime(statusAt)}</time>}
        {task?.status === 'pending' ? '待機しています…' : status || '全体の接続関係と資料庫のキャラクター・場所を参照できます。相談するだけでは作品を変更しません。'}
      </p>
      {/* 実行を選んでいる間は、送信すると作品が書き換わることを入力欄のすぐ上に出す */}
      {executeArmed && <p role="status" className="shrink-0 text-[11px]" style={{ color: 'var(--execute)' }}>
        「制作を実行」を選択中: 送信すると、作業前の状態を保存してから作品を編集します。終わると「相談する」に戻ります。
      </p>}
      <p className="shrink-0 text-[11px]" style={{ color: 'var(--text-dim)' }}
        data-tip="送信時の選択を依頼に添えます。送信後に選択を変えても対象は変わりません。変更範囲・AI保護は引き続き適用されます。本文は保存済みの内容を参照します。">
        選択中: {selection.length ? selection.map((node) => node.title).join('、') : 'なし'}
        {chapterSelected && '（章カードは添付されません。章全体は候補の章レビューから、本文はシーンを選んで依頼できます）'}
      </p>
      <AutoTextarea ariaLabel="制作への依頼" value={input} onChange={setInput} disabled={sendingInstruction || (busy && !runId)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
          e.preventDefault()
          if (!e.repeat) submit()
        }}
        minRows={2} placeholder={runId ? "途中指示を入力（未確定の変更を見直してから続けます）" : "方針の相談、または作業の依頼を入力"}
        className="w-full shrink-0 rounded-md border px-2 py-0.5 text-[12px] outline-none disabled:opacity-50"
        style={{ background: 'var(--bg-input)', borderColor: executeArmed ? 'var(--execute-border)' : 'var(--border)' }} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* 幅が足りないときは案内を省略表示にして、送信ボタンを次の行へ落とさない */}
        <span className="min-w-0 flex-1 basis-0 truncate text-[11px]" style={{ color: 'var(--text-faint)' }} data-tip="Enterで送信・Shift＋Enterで改行">Enterで送信・Shift＋Enterで改行</span>
        {usage && <ContextUsageRing usage={usage} />}
        <div role="group" aria-label="制作チャットの送信モード"
          className="flex h-[26px] shrink-0 overflow-hidden rounded-md border" style={{ borderColor: sendMode === 'execute' ? 'var(--execute-border)' : 'var(--border-strong)' }}>
          {([['consult', '相談する'], ['execute', '制作を実行']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={sendMode === value} disabled={busy}
              onClick={() => setSendMode(value)}
              className="flex h-full items-center whitespace-nowrap px-2.5 text-[12px] disabled:opacity-50"
              style={sendMode !== value ? { color: 'var(--text-faint)' }
                : value === 'execute' ? { background: 'var(--execute-soft)', color: 'var(--execute)' }
                  : { background: 'var(--accent-soft)', color: 'var(--text)' }}
              data-tip={busy ? '処理が終わるか停止してから切り替えられます' : value === 'consult' ? '作品を変更せずに相談します' : 'この1回だけ、依頼に応じて作品を編集します。終わると「相談する」に戻ります'}>
              {label}
            </button>
          ))}
        </div>
        {/* 制作の実行中は、同じ丸いボタンが入力の有無で切り替わる: 空なら停止(■)、文字があれば途中指示の送信(↑)。
            相談の処理中は途中指示を受け付けないので、常に停止 */}
        {busy && runId && input.trim() ? <button onClick={submit} disabled={sendingInstruction} aria-label="途中指示を送る"
          className="execute-action inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border disabled:opacity-40"
          data-tip="途中指示を送る(次の判断に取り込みます。確定済みの変更は自動では戻りません)。入力を空にすると停止ボタンに戻ります">
          <Icon name="arrowUp" size={14} strokeWidth={2.4} />
        </button> : busy ? <button onClick={() => {
          runRef.current = null; setRunId(null); if (taskId) cancelTask(taskId)
          // まだ動き出していない依頼は履歴にも残っていないので、入力欄へ戻す
          const pending = pendingMessageRef.current
          if (pending) { pendingMessageRef.current = null; setInput((prev) => prev || pending) }
        }}
          aria-label="停止"
          className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border hover:bg-[var(--accent-soft)]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }} data-tip="停止(未確定の生成を止めます。確定済みの変更は残ります)">
          {/* 送信の↑と同じ丸い形のまま、中身だけ■に変える(処理中に文字のボタンへ変わると位置と形が飛ぶ) */}
          <Icon name="stop" size={12} />
        </button> :
          <button onClick={submit} disabled={!input.trim()} aria-label="送信"
            className={`${sendMode === 'execute' ? 'execute-action' : 'accent-action'} inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border disabled:opacity-40`}
            data-tip={sendMode === 'execute' ? '制作を実行として送信(作業前の状態を保存してから、依頼した編集を実行します)' : '相談として送信(読み取りだけで回答します)'}>
            <Icon name="arrowUp" size={14} strokeWidth={2.4} />
          </button>
        }
      </div>
    </div>
    </div>
  )
}
