import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, generateBeatStream } from '../api'
import type { Character, StateSnapshot, StoryNode } from '../types'

const NODE_GAP_Y = 190

type BeatNodeData = {
  storyNode: StoryNode
  characters: Record<string, Character>
}

type BeatFlowNode = Node<BeatNodeData, 'beatNode'>

function BeatNodeCard({ data, selected }: NodeProps<BeatFlowNode>): React.JSX.Element {
  const { storyNode, characters } = data
  const isDraft = storyNode.status === 'draft'
  return (
    <div
      className={`w-72 rounded-3xl border-2 px-5 py-4 shadow-lg shadow-black/30 ${selected ? 'ring-4' : ''}`}
      style={{
        background: 'var(--bg-card)',
        borderColor: selected ? 'var(--accent-border)' : 'var(--border-strong)',
        borderStyle: isDraft ? 'dashed' : 'solid',
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#6a728f]" />
      <div className="mb-1 text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
        {storyNode.title || '(無題のビート)'}
      </div>
      <div className="mb-2 line-clamp-3 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
        {storyNode.beat}
      </div>
      {storyNode.emotional_core && (
        <div className="mb-2 text-[11px] italic" style={{ color: 'var(--accent)' }}>
          {storyNode.emotional_core}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {storyNode.cast.map((charId) => {
          const c = characters[charId]
          return (
            <span
              key={charId}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: c?.color ?? '#8a8fa8' }}
              />
              {c?.name ?? charId}
            </span>
          )
        })}
        {storyNode.location && (
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            @{storyNode.location}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-[#6a728f]" />
    </div>
  )
}

const nodeTypes = { beatNode: BeatNodeCard }

// ---- インスペクタ ----------------------------------------------------

function BeatTab({
  node,
  characters,
  validation,
  onSaved,
  onDeleted
}: {
  node: StoryNode
  characters: Character[]
  validation: string[]
  onSaved: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Partial<StoryNode>>({})
  const [error, setError] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)

  useEffect(() => {
    setDraft({
      title: node.title,
      beat: node.beat,
      emotional_core: node.emotional_core,
      cast: node.cast,
      location: node.location,
      story_time: node.story_time
    })
    setError(null)
  }, [node.id, node.updated_at])

  const toggleCast = (charId: string): void => {
    setDraft((d) => {
      const cast = d.cast ?? []
      return { ...d, cast: cast.includes(charId) ? cast.filter((c) => c !== charId) : [...cast, charId] }
    })
  }

  const handleSave = async (): Promise<void> => {
    try {
      await api.updateNode(node.id, draft)
      onSaved()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm('このビートを削除しますか?(末尾のみ削除可)')) return
    try {
      await api.deleteNode(node.id)
      onDeleted()
    } catch (e) {
      setError('削除できません: Phase 1 では末尾ノードのみ削除できます')
    }
  }

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

  return (
    <div className="flex flex-col gap-3">
      {validation.length > 0 && (
        <div
          className="rounded-lg border px-3 py-2 text-[12px] leading-relaxed"
          style={{ borderColor: 'rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)', color: '#f2a3a3' }}
        >
          {validation.map((v, i) => (
            <div key={i}>⚠ {v}</div>
          ))}
        </div>
      )}
      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          Title
        </span>
        <input
          value={draft.title ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
          style={inputStyle}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          Beat(出来事の仕様書)
        </span>
        <textarea
          rows={6}
          value={draft.beat ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, beat: e.target.value }))}
          className="w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
          style={inputStyle}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          Emotional core
        </span>
        <input
          value={draft.emotional_core ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, emotional_core: e.target.value }))}
          className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
          style={inputStyle}
        />
      </label>
      <div>
        <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          Cast
        </span>
        <div className="flex flex-wrap gap-1.5">
          {characters.map((c) => {
            const active = (draft.cast ?? []).includes(c.id)
            return (
              <button
                key={c.id}
                onClick={() => toggleCast(c.id)}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]"
                style={
                  active
                    ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--text)' }
                    : { background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-faint)' }
                }
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color ?? '#8a8fa8' }} />
                {c.name}
              </button>
            )
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            Location
          </span>
          <input
            value={draft.location ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
            className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
            style={inputStyle}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            Story time
          </span>
          <input
            value={draft.story_time ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, story_time: e.target.value }))}
            className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
            style={inputStyle}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleSave()}
          className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          保存
        </button>
        <button onClick={() => void handleDelete()} className="ml-auto text-[12px]" style={{ color: 'var(--danger)' }}>
          削除
        </button>
      </div>
      {error && (
        <div className="text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            Events({node.events.length})
          </span>
          <button
            onClick={() => {
              setExtracting(true)
              setError(null)
              api
                .extractEvents(node.id)
                .then(() => onSaved())
                .catch((e) => setError(String(e)))
                .finally(() => setExtracting(false))
            }}
            disabled={extracting}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
          >
            {extracting ? '抽出中…' : 'イベント抽出(LLM)'}
          </button>
        </div>
        {node.events.length === 0 && (
          <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
            イベントなし。手動で書いたビートは「イベント抽出(LLM)」で状態差分を生成できます
          </div>
        )}
        {node.events.map((e) => (
          <div
            key={e.id}
            className="mb-1.5 rounded-lg border px-3 py-2 text-[12px]"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="mb-0.5 flex items-center gap-2">
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                {e.type}
              </span>
              <span
                className="rounded px-1.5 py-px text-[10px] uppercase"
                style={
                  e.source === 'user'
                    ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                    : { background: 'var(--bg-input)', color: 'var(--text-faint)' }
                }
              >
                {e.source}
              </span>
            </div>
            <div className="break-all font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
              {JSON.stringify(e.payload)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CharTab({
  node,
  characters,
  memoryContents
}: {
  node: StoryNode
  characters: Character[]
  memoryContents: Record<string, string>
}): React.JSX.Element {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [charId, setCharId] = useState<string | null>(node.cast[0] ?? null)

  useEffect(() => {
    setCharId(node.cast[0] ?? null)
    setState(null)
    void api.getState(node.id).then(setState).catch(() => setState(null))
  }, [node.id, node.updated_at])

  const charState = charId ? state?.chars[charId] : null
  const nameOf = (id: string): string => characters.find((c) => c.id === id)?.name ?? id

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {node.cast.map((id) => (
          <button
            key={id}
            onClick={() => setCharId(id)}
            className="rounded-full border px-2.5 py-1 text-[12px]"
            style={
              id === charId
                ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--text)' }
                : { borderColor: 'var(--border)', color: 'var(--text-faint)' }
            }
          >
            {nameOf(id)}
          </button>
        ))}
      </div>
      {node.cast.length === 0 && (
        <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          cast が空です
        </div>
      )}
      {charState && (
        <>
          <section>
            <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              Facts
            </h4>
            {Object.keys(charState.facts).length === 0 && (
              <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                なし
              </div>
            )}
            {Object.entries(charState.facts).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 py-0.5 text-[12px]">
                <span style={{ color: 'var(--text-dim)' }}>{k}</span>
                <span style={{ color: 'var(--text)' }}>{JSON.stringify(v)}</span>
              </div>
            ))}
            {charState.status === 'retired' && (
              <div className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
                退場済み({charState.retire_reason})
              </div>
            )}
          </section>
          <section>
            <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              Relationships
            </h4>
            {Object.keys(charState.relationships).length === 0 && (
              <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                なし
              </div>
            )}
            {Object.entries(charState.relationships).map(([target, rel]) => (
              <div key={target} className="mb-1 flex items-center gap-2 text-[12px]">
                <span className="w-20 truncate" style={{ color: 'var(--text-dim)' }}>
                  {nameOf(target)}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--bg-input)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.abs(rel.score) * 100}%`,
                      background: rel.score >= 0 ? '#3ecf8e' : 'var(--danger)',
                      marginLeft: rel.score < 0 ? 'auto' : undefined
                    }}
                  />
                </div>
                <span className="w-10 text-right tabular-nums" style={{ color: 'var(--text)' }}>
                  {rel.score.toFixed(2)}
                </span>
              </div>
            ))}
          </section>
          <section>
            <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              Memories({charState.memories.length})
            </h4>
            {charState.memories.map((eventId) => (
              <div
                key={eventId}
                className="mb-1 rounded-lg border px-3 py-1.5 text-[12px] leading-relaxed"
                style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
              >
                {memoryContents[eventId] ?? eventId}
              </div>
            ))}
          </section>
        </>
      )}
      {charId && !charState && state && (
        <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          このキャラはまだ物語に登場していません(char_introduce 前)
        </div>
      )}
    </div>
  )
}

// ---- 構造モード本体 --------------------------------------------------

function StructureModeInner(): React.JSX.Element {
  const [timeline, setTimeline] = useState<StoryNode[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<'beat' | 'char'>('beat')
  const [validation, setValidation] = useState<string[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genStatus, setGenStatus] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const [tl, chars] = await Promise.all([api.timeline(), api.listCharacters()])
    setTimeline(tl)
    setCharacters(chars)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!selectedId) {
      setValidation([])
      return
    }
    void api
      .validateNode(selectedId)
      .then((r) => setValidation(r.errors))
      .catch(() => setValidation([]))
  }, [selectedId, timeline])

  const charMap = useMemo(
    () => Object.fromEntries(characters.map((c) => [c.id, c])),
    [characters]
  )

  const memoryContents = useMemo(() => {
    const map: Record<string, string> = {}
    for (const node of timeline) {
      for (const e of node.events) {
        if (e.type === 'memory_add' || e.type === 'memory_compress') {
          map[e.id] = String(e.payload.content ?? e.payload.summary ?? '')
        }
      }
    }
    return map
  }, [timeline])

  const flowNodes: BeatFlowNode[] = useMemo(
    () =>
      timeline.map((n, i) => ({
        id: n.id,
        type: 'beatNode',
        position: { x: 0, y: i * NODE_GAP_Y },
        selected: n.id === selectedId,
        data: { storyNode: n, characters: charMap }
      })),
    [timeline, charMap, selectedId]
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      timeline.slice(1).map((n, i) => ({
        id: `${timeline[i].id}-${n.id}`,
        source: timeline[i].id,
        target: n.id,
        style: { stroke: '#6a728f', strokeWidth: 2 }
      })),
    [timeline]
  )

  const selectedNode = timeline.find((n) => n.id === selectedId) ?? null

  const handleAddBeat = async (): Promise<void> => {
    const node = await api.createNode({ beat: '(ここに出来事の仕様を書く)', cast: [] })
    await reload()
    setSelectedId(node.id)
    setInspectorTab('beat')
  }

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true)
    setGenStatus('LLM 準備中…(初回はモデルロードに時間がかかります)')
    try {
      await generateBeatStream(instruction.trim() || null, (e) => {
        if (e.stage === 'generating') setGenStatus(`ビート生成中…(${e.attempt} 回目)`)
        else if (e.stage === 'validating') setGenStatus('検証中…')
        else if (e.stage === 'retry') setGenStatus(`検証 NG、リトライ中…(${(e.errors ?? []).join(' / ')})`)
        else if (e.error) setGenStatus(`エラー: ${e.error}`)
        else if (e.done && e.node) {
          setGenStatus(
            e.validation && e.validation.length > 0 ? `警告付きで採用: ${e.validation.join(' / ')}` : null
          )
          setInstruction('')
          const newId = e.node.id
          void reload().then(() => {
            setSelectedId(newId)
            setInspectorTab('beat')
          })
        }
      })
    } catch (err) {
      setGenStatus(String(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1" style={{ background: 'var(--bg-canvas)' }}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            minZoom={0.1}
            maxZoom={2}
            fitView
            zoomOnScroll={false}
            zoomOnPinch={false}
            panOnScroll
            panOnDrag={[1]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1.4} color="#394154" />
            <MiniMap pannable zoomable nodeColor={() => '#2e3140'} />
            <Panel position="top-left">
              <div className="flex w-72 flex-col gap-2">
                <button
                  onClick={() => void handleAddBeat()}
                  className="self-start rounded-lg px-3 py-1.5 text-[13px] font-medium text-white shadow-lg shadow-black/30"
                  style={{ background: 'var(--accent)' }}
                >
                  + ビート追加
                </button>
                <div
                  className={`rounded-2xl border p-3 shadow-lg shadow-black/30 ${generating ? 'node-generating-border' : ''}`}
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
                >
                  <textarea
                    rows={2}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="生成の指示(任意)"
                    disabled={generating}
                    className="mb-2 w-full rounded-lg border px-2.5 py-1.5 text-[12px] outline-none"
                    style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                  />
                  <button
                    onClick={() => void handleGenerate()}
                    disabled={generating}
                    className="w-full rounded-lg px-3 py-1.5 text-[13px] font-medium text-white"
                    style={{ background: generating ? 'var(--accent-hover)' : 'var(--accent)' }}
                  >
                    {generating ? '生成中…' : '▶ 次のビートを生成'}
                  </button>
                  {genStatus && (
                    <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                      {genStatus}
                    </div>
                  )}
                </div>
              </div>
            </Panel>
            {timeline.length === 0 && (
              <Panel position="top-center">
                <div
                  className="mt-24 rounded-2xl border px-6 py-4 text-[13px]"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                >
                  「+ ビート追加」で最初のビートを作成してください
                </div>
              </Panel>
            )}
          </ReactFlow>
        </main>
        <aside
          className="flex w-96 shrink-0 flex-col border-l"
          style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
        >
          <div className="flex gap-1 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
            {(
              [
                { id: 'beat', label: 'ビート' },
                { id: 'char', label: 'キャラ' }
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => setInspectorTab(t.id)}
                className="rounded-md px-3 py-1 text-[12px]"
                style={
                  inspectorTab === t.id
                    ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                    : { color: 'var(--text-dim)' }
                }
              >
                {t.label}
              </button>
            ))}
            <span className="ml-auto self-center text-[11px]" style={{ color: 'var(--text-faint)' }}>
              関係図は Phase 3
            </span>
          </div>
          <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            {selectedNode ? (
              inspectorTab === 'beat' ? (
                <BeatTab
                  node={selectedNode}
                  characters={characters}
                  validation={validation}
                  onSaved={() => void reload()}
                  onDeleted={() => {
                    setSelectedId(null)
                    void reload()
                  }}
                />
              ) : (
                <CharTab node={selectedNode} characters={characters} memoryContents={memoryContents} />
              )
            ) : (
              <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                ノードを選択してください
              </div>
            )}
          </div>
        </aside>
      </div>
      <div className="shrink-0 border-t" style={{ background: 'var(--bg-chat)', borderColor: 'var(--border)' }}>
        <button
          onClick={() => setChatOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-1.5 text-[12px]"
          style={{ color: 'var(--text-faint)' }}
        >
          <span>{chatOpen ? '▾' : '▴'}</span> 相談チャット
        </button>
        {chatOpen && (
          <div className="px-4 pb-4 text-[12px]" style={{ color: 'var(--text-faint)' }}>
            相談チャットは Phase 5 で実装します。
          </div>
        )}
      </div>
    </div>
  )
}

export default function StructureMode(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <StructureModeInner />
    </ReactFlowProvider>
  )
}
