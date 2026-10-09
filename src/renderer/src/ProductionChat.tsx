import { useEffect, useRef, useState } from 'react'
import { chatApi, isAbortError, productionApi, type ChatSummary, type ProductionInstruction, type ProductionPolicy, type ProductionOperation } from './api'
import { Markdown } from './Markdown'
import { cancelTask, enqueueTask, notifyGraphChanged, setNodeBusy, useTasks } from './tasks'
import type { Group, Snapshot, StoryNode } from './types'
import ProductionPolicyPanel, { defaultProductionPolicy, policySummary } from './ProductionPolicyPanel'

interface Message {
  policy?: ProductionPolicy
  policy_after?: ProductionPolicy
  policy_label?: string
  role: string
  content: string
  operation?: ProductionOperation
  snapshot?: Snapshot
  instruction?: ProductionInstruction['instruction']
}

const operationLabels = { insert_scene: '追加', update_scene: '編集', delete_scene: '削除' }

/** 段階0の制作専用チャット。相談履歴とは分け、実行ボタンからだけ書き込みを許可する。 */
export default function ProductionChat({ beforeExecute, onChanged, onFollowTarget, nodes, groups }: {
  nodes: StoryNode[]
  groups: Group[]
  beforeExecute: () => string | null
  onChanged: (operation: ProductionOperation) => Promise<void>
  onFollowTarget: (nodeId: string | null) => void
}): React.JSX.Element {
  const [chatId, setChatId] = useState<string | null>(null)
  const [history, setHistory] = useState<ChatSummary[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [policy, setPolicy] = useState<ProductionPolicy>(defaultProductionPolicy)
  const [live, setLive] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const runRef = useRef<string | null>(null)
  const [sendingInstruction, setSendingInstruction] = useState(false)
  const instructionRequest = useRef<{ runId: string; text: string; id: string } | null>(null)
  const [follow, setFollow] = useState(true)
  const followRef = useRef(true)
  const followTargetRef = useRef<string | null>(null)
  const tasks = useTasks()
  const task = tasks.find((t) => t.id === taskId)
  const busy = !!task
  const endRef = useRef<HTMLDivElement>(null)
  const taskRef = useRef<string | null>(null)

  const refreshHistory = async (): Promise<void> => setHistory(await productionApi.list())
  useEffect(() => {
    void refreshHistory().catch((e) => setError(String(e)))
    return () => { if (taskRef.current) cancelTask(taskRef.current) }
  }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [messages, live, status])

  const load = async (id: string): Promise<void> => {
    try {
      const chat = await chatApi.get(id)
      if (chat.mode !== 'production') return
      setChatId(id)
      const loaded = chat.messages as unknown as Message[]
      setMessages(loaded)
      const lastPolicy = [...loaded].reverse().find((m) => m.policy)?.policy_after ?? [...loaded].reverse().find((m) => m.policy)?.policy
      setPolicy(lastPolicy ?? defaultProductionPolicy())
      setLive('')
      setError('')
      setStatus('')
    } catch (e) { setError(String(e)) }
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
      ? previous : { runId: activeRun, text, id: crypto.randomUUID() }
    instructionRequest.current = request
    setSendingInstruction(true)
    setError('')
    try {
      const item = await productionApi.instruct(activeRun, request.id, text)
      if (runRef.current === activeRun) recordInstruction(item)
      setInput((value) => value.trim() === text ? '' : value)
      instructionRequest.current = null
    } catch (e) { setError(String(e)) }
    finally { setSendingInstruction(false) }
  }

  const send = (execute: boolean): void => {
    const message = input.trim()
    if (!message || busy) return
    const blocked = execute ? beforeExecute() : null
    if (blocked) { setError(blocked); return }
    if (execute && policy.allowed_ids?.length === 0) { setError('変更できるシーンを1つ以上選んでください'); return }
    setError('')
    setStatus('')
    setRunId(null)
    runRef.current = null
    setInput('')
    let currentChatId = chatId
    let activeNode: string | null = null
    const id = enqueueTask({
      label: execute ? '制作' : '制作の相談', kind: 'production',
      runner: async ({ signal, update }) => {
        setStatus('開始の準備をしています…')
        setMessages((prev) => [...prev, { role: 'user', content: message, policy, policy_label: policySummary(policy, nodes, groups) }])
        let text = ''
        let finished = false
        const flush = (): void => {
          const content = text
          if (content) setMessages((prev) => [...prev, { role: 'assistant', content }])
          text = ''
          setLive('')
        }
        try {
          await productionApi.send({ chat_id: currentChatId, message, execute, policy }, async (event) => {
            if (event.chat_id) { currentChatId = event.chat_id; setChatId(event.chat_id) }
            if (event.run_id && event.accepting_instructions) {
              runRef.current = event.run_id
              setRunId(event.run_id)
            }
            if (event.instruction) recordInstruction(event.instruction)
            if (event.delta) { text += event.delta; setLive(text) }
            if (event.response_end) flush()
            if (event.stage) { setStatus(event.stage); update({ detail: event.stage }) }
            if ('active_node' in event) {
              setNodeBusy(activeNode, false)
              activeNode = event.active_node ?? null
              setNodeBusy(activeNode, true)
              if (activeNode) {
                followTargetRef.current = activeNode
                if (followRef.current) onFollowTarget(activeNode)
              }
            }
            if (event.snapshot) {
              const snapshot = event.snapshot
              setMessages((prev) => [...prev, { role: 'assistant', content: '作業前の状態を保存しました。', snapshot }])
            }
            if (event.changed) {
              const operation = event.changed
              setPolicy((previous) => previous.allowed_ids === null ? previous : { ...previous,
                allowed_ids: operation.action === 'insert_scene' ? [...previous.allowed_ids, operation.node_id]
                  : operation.action === 'delete_scene' ? previous.allowed_ids.filter((id) => id !== operation.node_id) : previous.allowed_ids })
              setMessages((prev) => [...prev, { role: 'assistant', content: operation.reason, operation }])
              await onChanged(operation)
              if (operation.action !== 'delete_scene') {
                followTargetRef.current = operation.node_id
                if (followRef.current) onFollowTarget(operation.node_id)
              } else if (followTargetRef.current === operation.node_id) {
                followTargetRef.current = null
                onFollowTarget(null)
              }
            }
            if (event.tool_error) setStatus(`変更を見直しています: ${event.tool_error}`)
            if (event.error) throw new Error(event.error)
            if (event.done) finished = true
          }, signal)
          if (!finished) throw new Error('接続が終了しました。確定済みの変更と履歴を確認してください。')
          setStatus('完了しました')
        } catch (e) {
          if (isAbortError(e)) setStatus('停止しました。確定済みの変更は残しています。')
          else setError(String(e))
        } finally {
          runRef.current = null
          setRunId(null)
          flush()
          setNodeBusy(activeNode, false)
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
          notifyGraphChanged()
          taskRef.current = null
        }
      }
    })
    taskRef.current = id
    setTaskId(id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-4 py-2 text-[12px]" style={{ background: 'var(--bg-chat)', color: 'var(--text)' }}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-faint)' }}>制作（実験）</span>
        <select
          aria-label="制作の会話" value={chatId ?? ''} disabled={busy}
          onChange={(e) => {
            if (e.target.value) void load(e.target.value)
            else { setChatId(null); setMessages([]); setPolicy(defaultProductionPolicy()); setStatus(''); setError('') }
          }}
          className="min-w-0 flex-1 rounded-md border px-2 py-0.5 text-[12px] outline-none disabled:opacity-50"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          data-tip={busy ? '制作が終わるか停止してから切り替えられます' : '相談とは別の制作履歴を開きます'}
        >
          <option value="">新しい制作の会話</option>
          {chatId && !history.some((h) => h.id === chatId) && <option value={chatId}>現在の制作</option>}
          {history.map((h) => <option key={h.id} value={h.id}>{h.title || h.snippet || '制作'}</option>)}
        </select>
        <button onClick={() => { followRef.current = !follow; setFollow(!follow); onFollowTarget(!follow ? followTargetRef.current : null) }}
          className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
          style={follow ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' } : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          data-tip="作業対象の章を開き、シーンをキャンバスの中央に表示します">{follow ? '☑' : '☐'} 作業対象を追う</button>
      </div>
      <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
        検証用ライブラリでお試しください。「制作を実行」でシーンの追加・編集・削除を行います。実行中の手動編集は停止します。
      </p>
      <ProductionPolicyPanel value={policy} onChange={setPolicy} nodes={nodes} groups={groups} busy={busy} />
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className="mb-2 rounded-lg border px-3 py-1.5" style={{
            background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--bg-elevated)', borderColor: 'var(--border)'
          }}>
            <div className="mb-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {m.instruction ? `途中指示・${({ accepted: '受け付けました', reflected: '次の判断に反映しました', unapplied: '未反映のまま終了しました' })[m.instruction.status]}` : m.operation ? `${operationLabels[m.operation.action]}: ${m.operation.title || '(無題)'}` : m.role === 'user' ? 'あなた' : '制作'}
            </div>
            {m.policy && <p className="mb-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>{m.policy_label || policySummary(m.policy, nodes, groups)}</p>}
            <Markdown text={m.content} />
            {m.snapshot && <p className="mt-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
              保存名: {m.snapshot.label}。設定のスナップショット一覧から戻せます（ライブラリ全体の復元）。
            </p>}
          </div>
        ))}
        {live && <Markdown text={live} />}
        <div ref={endRef} />
      </div>
      {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        {task?.status === 'pending' ? '待機しています…' : status || '全体の接続関係を参照します。相談するだけでは作品を変更しません。'}
      </p>
      <textarea aria-label="制作への依頼" value={input} onChange={(e) => setInput(e.target.value)} disabled={sendingInstruction || (busy && !runId)}
        rows={2} placeholder={runId ? "途中指示を入力（未確定の変更を見直してから続けます）" : "方針の相談、または作業の依頼を入力"}
        className="w-full rounded-md border px-2 py-0.5 text-[12px] outline-none disabled:opacity-50"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }} />
      <div className="flex justify-end gap-2">
        {busy && runId && <button onClick={() => void instruct()} disabled={!input.trim() || sendingInstruction}
          className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          data-tip="指示を受け付け、次の判断に取り込みます。確定済みの変更は自動では戻りません">途中指示を送る</button>}
        {busy ? <button onClick={() => { runRef.current = null; setRunId(null); if (taskId) cancelTask(taskId) }}
          className="rounded-md border px-2 py-0.5 text-[11px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }} data-tip="未確定の生成を止めます。確定済みの変更は残ります">停止</button> : <>
          <button onClick={() => send(false)} disabled={!input.trim()}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }} data-tip="読み取りだけで回答します">相談する</button>
          <button onClick={() => send(true)} disabled={!input.trim()}
            className="accent-action inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
            data-tip="作業前の状態を保存してから、依頼した編集を実行します">制作を実行</button>
        </>}
      </div>
    </div>
  )
}
