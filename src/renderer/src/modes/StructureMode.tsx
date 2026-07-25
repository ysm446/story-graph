import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, assetUrl, generateBeatStream, isAbortError, isVideoAsset, proofreadStream, uploadAsset } from '../api'
import ChatDrawer from '../ChatDrawer'
import RelationGraph from '../RelationGraph'
import { useElapsedSeconds } from '../useElapsed'
import type { Character, EventInput, GraphEdge, StateSnapshot, StoryEvent, StoryNode } from '../types'

const COLUMN_GAP_X = 344 // カード幅(w-72 = 288)+ 余白
const LANE_GAP_Y = 56 // レーン間の余白
const FALLBACK_NODE_HEIGHT = 160

// ---- DAG レイアウト(正史は左から右へ一直線、分岐は下のレーンへ) ------
// カード幅は固定なので x は深さで決まる。y はレーンごとに、そのレーンの
// 実測最大高さを積み上げて決める(カード高さは画像や本文量で変わるため)

function layoutDag(
  nodes: StoryNode[],
  edges: GraphEdge[],
  heights: Record<string, number>
): Record<string, { x: number; y: number }> {
  const childrenMap: Record<string, Array<{ id: string; canon: boolean }>> = {}
  const hasParent = new Set<string>()
  for (const e of edges) {
    ;(childrenMap[e.from_node] ??= []).push({ id: e.to_node, canon: !!e.is_canon })
    hasParent.add(e.to_node)
  }
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  const placed: Record<string, { depth: number; lane: number }> = {}
  let laneCounter = 0

  const assign = (id: string, lane: number, depth: number): void => {
    if (placed[id]) return // 循環データでも無限再帰しないように
    placed[id] = { depth, lane }
    const kids = (childrenMap[id] ?? [])
      .slice()
      .sort((a, b) => Number(b.canon) - Number(a.canon) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    kids.forEach((kid, i) => {
      assign(kid.id, i === 0 ? lane : ++laneCounter, depth + 1)
    })
  }

  const roots = nodes.filter((n) => !hasParent.has(n.id))
  roots.forEach((root, i) => {
    assign(root.id, i === 0 ? 0 : ++laneCounter, 0)
  })

  // レーンごとの最大高さを求めてから、レーンの y を積み上げる
  const laneHeights: number[] = []
  for (const [id, p] of Object.entries(placed)) {
    const height = heights[id] ?? FALLBACK_NODE_HEIGHT
    laneHeights[p.lane] = Math.max(laneHeights[p.lane] ?? 0, height)
  }
  const laneY: number[] = []
  let y = 0
  for (let lane = 0; lane <= laneCounter; lane += 1) {
    laneY[lane] = y
    y += (laneHeights[lane] ?? FALLBACK_NODE_HEIGHT) + LANE_GAP_Y
  }

  const positions: Record<string, { x: number; y: number }> = {}
  for (const [id, p] of Object.entries(placed)) {
    positions[id] = { x: p.depth * COLUMN_GAP_X, y: laneY[p.lane] ?? 0 }
  }
  return positions
}

// ---- カスタムノード --------------------------------------------------

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
        opacity: isDraft ? 0.85 : 1,
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-[#6a728f]" />
      {assetUrl(storyNode.image_path) &&
        (isVideoAsset(storyNode.image_path) ? (
          // グラフ上のカードでは負荷を抑えるため再生せず、先頭フレームをサムネイルとして表示
          <video
            src={assetUrl(storyNode.image_path)!}
            preload="metadata"
            muted
            playsInline
            className="mx-auto mb-2 max-h-40 max-w-full rounded-xl"
            style={{ opacity: isDraft ? 0.8 : 1 }}
          />
        ) : (
          <img
            src={assetUrl(storyNode.image_path)!}
            className="mx-auto mb-2 max-h-40 max-w-full rounded-xl"
            style={{ opacity: isDraft ? 0.8 : 1 }}
          />
        ))}
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
          {storyNode.title || '(無題のシーン)'}
        </span>
        {isDraft && (
          <span
            className="shrink-0 rounded px-1.5 py-px text-[10px] uppercase"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-faint)' }}
          >
            draft
          </span>
        )}
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
          const portrait = assetUrl(c?.portrait_path)
          return (
            <span
              key={charId}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}
            >
              {portrait ? (
                <img src={portrait} className="h-3.5 w-3.5 rounded-full object-cover" />
              ) : (
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: c?.color ?? '#8a8fa8' }} />
              )}
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
      <Handle type="source" position={Position.Right} className="!bg-[#6a728f]" />
    </div>
  )
}

const nodeTypes = { beatNode: BeatNodeCard }

// ---- イベントエディタ(手動イベントの追加・削除) ----------------------

const EVENT_TEMPLATES: Record<string, string> = {
  memory_add: '{"char": "", "content": "", "emotion": 0, "importance": 0.5, "refs": []}',
  memory_compress: '{"char": "", "replaces": [], "summary": "", "importance": 0.5}',
  relationship_update: '{"char": "", "target_type": "char", "target": "", "delta": 0.1, "reason": ""}',
  relationship_set: '{"char": "", "target_type": "char", "target": "", "value": 0, "reason": ""}',
  fact_set: '{"scope": "char", "char": "", "key": "location", "value": ""}',
  char_introduce: '{"char": ""}',
  char_retire: '{"char": "", "reason": "death"}',
  manual_override: '{"path": "", "value": "", "note": ""}'
}

function EventsEditor({
  node,
  onChanged
}: {
  node: StoryNode
  onChanged: () => void
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [newType, setNewType] = useState('fact_set')
  const [payloadText, setPayloadText] = useState(EVENT_TEMPLATES['fact_set'])
  const [busy, setBusy] = useState(false)
  const busyElapsed = useElapsedSeconds(busy)
  const [error, setError] = useState<string | null>(null)
  const [validation, setValidation] = useState<string[]>([])

  const currentEvents = (): EventInput[] =>
    node.events.map((e) => ({ type: e.type, payload: e.payload, source: e.source }))

  const save = async (events: EventInput[]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.putEvents(node.id, events)
      setValidation(result.validation)
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = (index: number): void => {
    const events = currentEvents()
    events.splice(index, 1)
    void save(events)
  }

  const handleAdd = (): void => {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(payloadText) as Record<string, unknown>
    } catch {
      setError('payload が JSON として不正です')
      return
    }
    void save([...currentEvents(), { type: newType, payload, source: 'user' }]).then(() => {
      setAdding(false)
      setPayloadText(EVENT_TEMPLATES[newType])
    })
  }

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          Events({node.events.length})
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            {adding ? 'キャンセル' : '+ 手動イベント'}
          </button>
          <button
            onClick={() => {
              setBusy(true)
              setError(null)
              api
                .extractEvents(node.id)
                .then((r) => {
                  setValidation(r.validation)
                  onChanged()
                })
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false))
            }}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
          >
            {busy ? `処理中… (${busyElapsed}s)` : 'イベント抽出(LLM)'}
          </button>
        </div>
      </div>
      {adding && (
        <div
          className="mb-2 rounded-lg border p-2"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
        >
          <select
            value={newType}
            onChange={(e) => {
              setNewType(e.target.value)
              setPayloadText(EVENT_TEMPLATES[e.target.value])
            }}
            className="mb-1.5 w-full rounded-md border px-2 py-1 text-[12px]"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          >
            {Object.keys(EVENT_TEMPLATES).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <textarea
            rows={3}
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            className="mb-1.5 w-full rounded-md border px-2 py-1 font-mono text-[11px]"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
          />
          <button
            onClick={handleAdd}
            disabled={busy}
            className="rounded-md px-3 py-1 text-[12px] font-medium text-white"
            style={{ background: 'var(--accent)' }}
          >
            追加
          </button>
        </div>
      )}
      {error && (
        <div className="mb-1 text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      {validation.length > 0 && (
        <div className="mb-1 text-[12px]" style={{ color: '#f2a3a3' }}>
          {validation.map((v, i) => (
            <div key={i}>⚠ {v}</div>
          ))}
        </div>
      )}
      {node.events.length === 0 && (
        <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          イベントなし。手動追加か「イベント抽出(LLM)」で状態差分を作成できます
        </div>
      )}
      {node.events.map((e, index) => (
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
            <button
              onClick={() => handleDelete(index)}
              disabled={busy}
              className="ml-auto text-[11px]"
              style={{ color: 'var(--text-faint)' }}
              title="このイベントを削除"
            >
              ✕
            </button>
          </div>
          <div className="break-all font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {JSON.stringify(e.payload)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- ビートタブ ------------------------------------------------------

// 未保存のシーン下書きをノード ID ごとに保持する(セッション内)。
// ノード非選択で BeatTab がアンマウントされても編集内容が消えないようにする。
// 保存やキャンセルではなく「一時退避」なので、保存成功時に該当エントリを消す。
const beatDraftCache = new Map<string, Partial<StoryNode>>()

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
  const [suggesting, setSuggesting] = useState<'title' | 'emotional_core' | null>(null)
  const [proofreadPresets, setProofreadPresets] = useState<Array<{ id: string; name: string }>>([])
  const [proofreadPreset, setProofreadPreset] = useState(
    () => localStorage.getItem('proofreadPreset') ?? 'standard'
  )
  const [proofreading, setProofreading] = useState(false)
  const [beatBackup, setBeatBackup] = useState<string | null>(null)
  const [correction, setCorrection] = useState<{
    value: string
    base: string // 校正リクエスト時点の全文(置換はこの時点の座標で行う)
    start: number
    end: number
    done: boolean
  } | null>(null)
  const [imageDragOver, setImageDragOver] = useState(false)
  const proofreadElapsed = useElapsedSeconds(proofreading)
  const suggestElapsed = useElapsedSeconds(suggesting !== null)
  const imageDragDepth = useRef(0) // 子要素との境界で dragleave が発火してもチラつかないよう深さを数える
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const beatTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const proofreadAbortRef = useRef<AbortController | null>(null)

  const handleImageFile = (file: File): void => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      setError('画像または動画ファイルをドロップしてください')
      return
    }
    void uploadAsset(file)
      .then(({ path }) => api.setNodeImage(node.id, path))
      .then(onSaved)
      .catch((err) => setError(String(err)))
  }

  useEffect(() => {
    void api
      .listProofreadPresets()
      .then((presets) => {
        setProofreadPresets(presets)
        if (!presets.some((p) => p.id === proofreadPreset)) setProofreadPreset(presets[0]?.id ?? 'standard')
      })
      .catch(() => setProofreadPresets([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setBeatBackup(null)
    setCorrection(null)
    proofreadAbortRef.current?.abort()
  }, [node.id])

  // シーン本文はスクロールさせず、内容に合わせて高さを自動調整する
  const autosizeBeat = useCallback((): void => {
    const textarea = beatTextareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight + 2}px`
  }, [])

  useEffect(() => {
    autosizeBeat()
  }, [draft.beat, node.id, autosizeBeat])

  // サイドバーのリサイズ等で幅が変わると折り返しが変わるため、幅の変化でも再計算する
  useEffect(() => {
    const textarea = beatTextareaRef.current
    if (!textarea) return
    let lastWidth = textarea.clientWidth
    const observer = new ResizeObserver(() => {
      const width = textarea.clientWidth
      if (width !== lastWidth) {
        lastWidth = width
        autosizeBeat()
      }
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [node.id, autosizeBeat])

  const runProofread = (): void => {
    const full = draft.beat ?? ''
    if (!full.trim() || proofreading) return
    // テキストエリアに選択範囲があればその部分だけを校正する
    const textarea = beatTextareaRef.current
    const selStart = textarea?.selectionStart ?? 0
    const selEnd = textarea?.selectionEnd ?? 0
    const hasSelection = textarea !== null && selEnd > selStart && full.slice(selStart, selEnd).trim() !== ''
    const start = hasSelection ? selStart : 0
    const end = hasSelection ? selEnd : full.length
    const target = full.slice(start, end)
    const controller = new AbortController()
    proofreadAbortRef.current = controller
    setProofreading(true)
    setError(null)
    // プレビューにストリーミング表示する(lm-chat 方式 + 逐次表示)
    setCorrection({ value: '', base: full, start, end, done: false })
    void proofreadStream(
      {
        text: target,
        preset_id: proofreadPreset,
        context_before: hasSelection ? full.slice(0, start) : '',
        context_after: hasSelection ? full.slice(end) : ''
      },
      (e) => {
        if (e.delta) {
          setCorrection((c) => (c ? { ...c, value: c.value + e.delta } : c))
        } else if (e.done) {
          const value = (e.value ?? '').trim()
          if (!value || value === target) {
            setCorrection(null) // 変化なし
          } else {
            setCorrection((c) => (c ? { ...c, value, done: true } : c))
          }
        } else if (e.error) {
          setError(e.error)
          setCorrection(null)
        }
      },
      controller.signal
    )
      .catch((e) => {
        if (!isAbortError(e)) setError(String(e))
        setCorrection(null)
      })
      .finally(() => {
        proofreadAbortRef.current = null
        setProofreading(false)
      })
  }

  const applyCorrection = (): void => {
    const c = correction
    if (!c || !c.done) return
    setBeatBackup(draft.beat ?? '')
    // リクエスト時点の全文(base)を基準に置換する(座標ズレを防ぐ)
    setDraft((d) => ({ ...d, beat: c.base.slice(0, c.start) + c.value + c.base.slice(c.end) }))
    setCorrection(null)
  }

  const cancelCorrection = (): void => {
    proofreadAbortRef.current?.abort()
    setCorrection(null)
  }

  const suggestField = (field: 'title' | 'emotional_core'): void => {
    const beat = (draft.beat ?? '').trim()
    if (!beat || suggesting) return
    setSuggesting(field)
    setError(null)
    api
      .suggestSceneMeta(beat, field)
      .then(({ value }) => {
        if (value) setDraft((d) => ({ ...d, [field]: value }))
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSuggesting(null))
  }

  useEffect(() => {
    // 退避済みの未保存下書きがあれば復元、無ければ保存値で初期化する
    const cached = beatDraftCache.get(node.id)
    setDraft(
      cached ?? {
        title: node.title,
        beat: node.beat,
        emotional_core: node.emotional_core,
        cast: node.cast,
        location: node.location,
        story_time: node.story_time
      }
    )
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
      beatDraftCache.delete(node.id) // 保存できたら退避を破棄
      onSaved()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleMakeCanon = async (): Promise<void> => {
    try {
      await api.makeCanon(node.id)
      onSaved()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm('このシーンを削除しますか?(後続シーンは前のシーンに繋がります)')) return
    try {
      await api.deleteNode(node.id)
      beatDraftCache.delete(node.id)
      onDeleted()
    } catch (e) {
      setError(`削除できません: ${String(e)}`)
    }
  }

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }
  const labelClass = 'mb-1 block text-[11px] uppercase tracking-[0.14em]'

  // 下書きがノードの保存値と異なるか(未初期化の間は false)
  const dirty =
    draft.beat !== undefined &&
    ((draft.title ?? '') !== (node.title ?? '') ||
      (draft.beat ?? '') !== (node.beat ?? '') ||
      (draft.emotional_core ?? '') !== (node.emotional_core ?? '') ||
      (draft.location ?? '') !== (node.location ?? '') ||
      (draft.story_time ?? '') !== (node.story_time ?? '') ||
      JSON.stringify(draft.cast ?? []) !== JSON.stringify(node.cast ?? []))

  // 未保存の変更があればノード ID ごとに退避、変更が無ければ退避を掃除する
  useEffect(() => {
    if (draft.beat === undefined) return // 初期化前
    if (dirty) beatDraftCache.set(node.id, draft)
    else beatDraftCache.delete(node.id)
  }, [draft, dirty, node.id])

  return (
    <div className="flex flex-col gap-3">
      {node.status === 'draft' && (
        <button
          onClick={() => void handleMakeCanon()}
          className="rounded-lg border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)', background: 'var(--accent-soft)' }}
        >
          ★ このブランチを正史にする
        </button>
      )}
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
        <span className="mb-1 flex items-center justify-between">
          <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}>
            Title
          </span>
          <button
            onClick={(e) => {
              e.preventDefault()
              suggestField('title')
            }}
            disabled={suggesting !== null || !(draft.beat ?? '').trim()}
            className="rounded-md border px-1.5 py-px text-[10px] disabled:opacity-40"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
            title="シーン本文からタイトルを自動生成"
          >
            {suggesting === 'title' ? `生成中… (${suggestElapsed}s)` : '✨ 自動生成'}
          </button>
        </span>
        <input
          value={draft.title ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
          style={inputStyle}
        />
      </label>
      <label className="block">
        <span className="mb-1 flex items-center justify-between gap-1">
          <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}>
            シーン(出来事の仕様書)
          </span>
          <span className="flex items-center gap-1">
            {beatBackup !== null && (
              <button
                onClick={(e) => {
                  e.preventDefault()
                  setDraft((d) => ({ ...d, beat: beatBackup }))
                  setBeatBackup(null)
                }}
                className="rounded-md border px-1.5 py-px text-[10px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                title="校正前の文章に戻す"
              >
                ↩ 元に戻す
              </button>
            )}
            <select
              value={proofreadPreset}
              onChange={(e) => {
                setProofreadPreset(e.target.value)
                localStorage.setItem('proofreadPreset', e.target.value)
              }}
              className="rounded-md border px-1 py-px text-[10px]"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              {proofreadPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={(e) => {
                e.preventDefault()
                runProofread()
              }}
              disabled={proofreading || suggesting !== null || !(draft.beat ?? '').trim()}
              className="rounded-md border px-1.5 py-px text-[10px] disabled:opacity-40"
              style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
              title="本文を校正。テキストを選択していればその範囲だけを校正します(結果は下書きに反映、保存までは確定しない)"
            >
              {proofreading ? `校正中… (${proofreadElapsed}s)` : '✎ 校正'}
            </button>
          </span>
        </span>
        <span className="block">
          {correction && (
            <div
              className="mb-1.5 rounded-xl border p-2.5 shadow-lg shadow-black/40"
              style={{ background: 'var(--bg-card)', borderColor: 'var(--accent-border)' }}
            >
              <div className="mb-1 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                校正プレビュー{correction.end - correction.start < correction.base.length ? '(選択範囲)' : '(全文)'}
              </div>
              <div
                className="inspector-scrollbar mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed"
                style={{ color: 'var(--text)' }}
              >
                {correction.value}
                {!correction.done && (
                  <span
                    className="node-generating-border ml-0.5 inline-block h-3 w-1 align-middle"
                    style={{ background: 'var(--accent)' }}
                  />
                )}
              </div>
              <div className="flex justify-end gap-1.5">
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault()
                    cancelCorrection()
                  }}
                  className="rounded-md px-2.5 py-1 text-[11px]"
                  style={{ color: 'var(--text-dim)' }}
                >
                  {correction.done ? 'キャンセル' : '■ 中止'}
                </button>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault()
                    applyCorrection()
                  }}
                  disabled={!correction.done}
                  className="rounded-md px-3 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}
                >
                  置換
                </button>
              </div>
            </div>
          )}
          <textarea
            ref={beatTextareaRef}
            rows={4}
            value={draft.beat ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, beat: e.target.value }))}
            className="w-full resize-none overflow-hidden rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
            style={inputStyle}
          />
        </span>
      </label>
      <label className="block">
        <span className="mb-1 flex items-center justify-between">
          <span className={labelClass.replace('mb-1 block ', '')} style={{ color: 'var(--text-faint)' }}>
            Emotional core
          </span>
          <button
            onClick={(e) => {
              e.preventDefault()
              suggestField('emotional_core')
            }}
            disabled={suggesting !== null || !(draft.beat ?? '').trim()}
            className="rounded-md border px-1.5 py-px text-[10px] disabled:opacity-40"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
            title="シーン本文から感情の核を自動生成"
          >
            {suggesting === 'emotional_core' ? `生成中… (${suggestElapsed}s)` : '✨ 自動生成'}
          </button>
        </span>
        <input
          value={draft.emotional_core ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, emotional_core: e.target.value }))}
          className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
          style={inputStyle}
        />
      </label>
      <div>
        <span className={labelClass} style={{ color: 'var(--text-faint)' }}>
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
          <span className={labelClass} style={{ color: 'var(--text-faint)' }}>
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
          <span className={labelClass} style={{ color: 'var(--text-faint)' }}>
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
      {/* 挿絵(画像/動画。装飾専用。LLM には渡さない) */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            挿絵
          </span>
          <div className="flex gap-1.5">
            <button
              onClick={() => imageInputRef.current?.click()}
              className="rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            >
              {node.image_path ? '変更' : '+ 画像/動画を添付'}
            </button>
            {node.image_path && (
              <button
                onClick={() => void api.setNodeImage(node.id, null).then(onSaved)}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
              >
                外す
              </button>
            )}
          </div>
        </div>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) handleImageFile(file)
          }}
        />
        <div
          onDragEnter={(e) => {
            e.preventDefault()
            imageDragDepth.current += 1
            setImageDragOver(true)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            imageDragDepth.current -= 1
            if (imageDragDepth.current <= 0) {
              imageDragDepth.current = 0
              setImageDragOver(false)
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            imageDragDepth.current = 0
            setImageDragOver(false)
            const file = e.dataTransfer.files?.[0]
            if (file) handleImageFile(file)
          }}
          onClick={() => {
            if (!node.image_path) imageInputRef.current?.click()
          }}
          className="relative rounded-xl transition-colors"
          style={imageDragOver ? { outline: '2px dashed var(--accent)', outlineOffset: 2 } : undefined}
        >
          {assetUrl(node.image_path) ? (
            <>
              {isVideoAsset(node.image_path) ? (
                <video
                  src={assetUrl(node.image_path)!}
                  autoPlay
                  muted
                  loop
                  playsInline
                  className="pointer-events-none mx-auto max-h-60 max-w-full rounded-xl"
                />
              ) : (
                <img
                  src={assetUrl(node.image_path)!}
                  draggable={false}
                  className="pointer-events-none mx-auto max-h-60 max-w-full rounded-xl"
                />
              )}
              {imageDragOver && (
                <span
                  className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl text-[12px] font-medium"
                  style={{ background: 'rgba(13,15,20,0.7)', color: 'var(--accent)' }}
                >
                  ドロップで差し替え
                </span>
              )}
            </>
          ) : (
            <div
              className="cursor-pointer rounded-xl border border-dashed px-4 py-6 text-center text-[12px]"
              style={{
                borderColor: imageDragOver ? 'var(--accent)' : 'var(--border-strong)',
                color: imageDragOver ? 'var(--accent)' : 'var(--text-faint)'
              }}
            >
              ここに画像/動画をドロップ(またはクリックで選択)
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleSave()}
          disabled={!dirty}
          className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--accent)' }}
          title={dirty ? undefined : '変更はありません'}
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
      <EventsEditor node={node} onChanged={onSaved} />
    </div>
  )
}

// ---- キャラタブ(状態閲覧 + 手動イベント化する編集) -------------------

function CharTab({
  node,
  characters,
  memoryContents,
  onChanged
}: {
  node: StoryNode
  characters: Character[]
  memoryContents: Record<string, string>
  onChanged: () => void
}): React.JSX.Element {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [charId, setCharId] = useState<string | null>(node.cast[0] ?? null)
  const [factKey, setFactKey] = useState('')
  const [factValue, setFactValue] = useState('')
  const [relTarget, setRelTarget] = useState('')
  const [relValue, setRelValue] = useState('0')
  const [relReason, setRelReason] = useState('')
  const [relLabel, setRelLabel] = useState('')
  const [memContent, setMemContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  const eventsKey = node.events.map((e) => e.id).join(',')

  useEffect(() => {
    setCharId((prev) => (prev && node.cast.includes(prev) ? prev : node.cast[0] ?? null))
    void api.getState(node.id).then(setState).catch(() => setState(null))
  }, [node.id, node.updated_at, eventsKey])

  const charState = charId ? state?.chars[charId] : null
  const nameOf = (id: string): string => characters.find((c) => c.id === id)?.name ?? id

  const appendEvent = async (event: StoryEvent['payload'] & object, type: string): Promise<void> => {
    setError(null)
    try {
      await api.putEvents(node.id, [
        ...node.events.map((e) => ({ type: e.type, payload: e.payload, source: e.source })),
        { type, payload: event as Record<string, unknown>, source: 'user' as const }
      ])
      onChanged()
    } catch (e) {
      setError(String(e))
    }
  }

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

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
      {error && (
        <div className="text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      {charId && charState && (
        <>
          <section>
            <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              Facts
            </h4>
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
            <div className="mt-1 flex gap-1">
              <input
                placeholder="key"
                value={factKey}
                onChange={(e) => setFactKey(e.target.value)}
                className="w-24 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <input
                placeholder="value"
                value={factValue}
                onChange={(e) => setFactValue(e.target.value)}
                className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <button
                onClick={() => {
                  if (!factKey.trim()) return
                  void appendEvent({ scope: 'char', char: charId, key: factKey.trim(), value: factValue }, 'fact_set')
                  setFactKey('')
                  setFactValue('')
                }}
                className="rounded-md px-2 text-[12px] text-white"
                style={{ background: 'var(--accent)' }}
                title="fact_set イベントとして記録"
              >
                +
              </button>
            </div>
          </section>
          <section>
            <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              Relationships
            </h4>
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
            <div className="mt-1 flex flex-wrap gap-1">
              <select
                value={relTarget}
                onChange={(e) => setRelTarget(e.target.value)}
                className="rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              >
                <option value="">相手…</option>
                {characters
                  .filter((c) => c.id !== charId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <input
                type="number"
                min={-1}
                max={1}
                step={0.05}
                value={relValue}
                onChange={(e) => setRelValue(e.target.value)}
                className="w-20 rounded-md border px-2 py-1 text-[12px] tabular-nums"
                style={inputStyle}
              />
              <input
                placeholder="理由"
                value={relReason}
                onChange={(e) => setRelReason(e.target.value)}
                className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <input
                placeholder="一言(相関図表示)"
                value={relLabel}
                onChange={(e) => setRelLabel(e.target.value)}
                className="w-28 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
                title="相関図の矢印に添える一言(例: 幼なじみ)"
              />
              <button
                onClick={() => {
                  if (!relTarget) return
                  const payload: Record<string, unknown> = {
                    char: charId,
                    target_type: 'char',
                    target: relTarget,
                    value: Number(relValue),
                    reason: relReason || '手動修正'
                  }
                  if (relLabel.trim()) payload.label = relLabel.trim()
                  void appendEvent(payload, 'relationship_set')
                  setRelReason('')
                  setRelLabel('')
                }}
                className="rounded-md px-2 text-[12px] text-white"
                style={{ background: 'var(--accent)' }}
                title="relationship_set イベントとして記録"
              >
                set
              </button>
            </div>
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
            <div className="mt-1 flex gap-1">
              <input
                placeholder="記憶を追加(このキャラ視点で)"
                value={memContent}
                onChange={(e) => setMemContent(e.target.value)}
                className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <button
                onClick={() => {
                  if (!memContent.trim()) return
                  void appendEvent(
                    { char: charId, content: memContent.trim(), emotion: 0, importance: 0.5, refs: [] },
                    'memory_add'
                  )
                  setMemContent('')
                }}
                className="rounded-md px-2 text-[12px] text-white"
                style={{ background: 'var(--accent)' }}
                title="memory_add イベントとして記録"
              >
                +
              </button>
            </div>
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

function StructureModeInner({ settingsVersion }: { settingsVersion: number }): React.JSX.Element {
  const [minimapVisible, setMinimapVisible] = useState(true)
  const [graphNodes, setGraphNodes] = useState<StoryNode[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<'beat' | 'char' | 'graph'>('beat')
  const [validation, setValidation] = useState<string[]>([])
  const [instruction, setInstruction] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genStatus, setGenStatus] = useState<string | null>(null)
  const genElapsed = useElapsedSeconds(generating)
  const genAbortRef = useRef<AbortController | null>(null)
  const [flowNodes, setFlowNodes] = useState<BeatFlowNode[]>([])
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem('inspectorWidth'))
    return saved >= 320 && saved <= 900 ? saved : 480
  })
  const rowRef = useRef<HTMLDivElement | null>(null)

  const beginInspectorResize = useCallback((event: React.PointerEvent): void => {
    event.preventDefault()
    const onMove = (ev: PointerEvent): void => {
      const rect = rowRef.current?.getBoundingClientRect()
      if (!rect) return
      setInspectorWidth(Math.min(900, Math.max(320, rect.right - ev.clientX)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setInspectorWidth((w) => {
        localStorage.setItem('inspectorWidth', String(Math.round(w)))
        return w
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const [graph, chars] = await Promise.all([api.getGraph(), api.listCharacters()])
    setGraphNodes(graph.nodes)
    setGraphEdges(graph.edges)
    setCharacters(chars)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 設定(ミニマップ表示)を読み込む。settingsVersion は設定ポップアップを
  // 閉じたときに変わるので、そこで変更が反映される
  useEffect(() => {
    void api
      .getSettings()
      .then((s) => setMinimapVisible(s.minimap_visible !== '0'))
      .catch(() => undefined)
  }, [settingsVersion])

  useEffect(() => {
    if (!selectedId) {
      setValidation([])
      return
    }
    void api
      .validateNode(selectedId)
      .then((r) => setValidation(r.errors))
      .catch(() => setValidation([]))
  }, [selectedId, graphNodes])

  const charMap = useMemo(() => Object.fromEntries(characters.map((c) => [c.id, c])), [characters])

  const memoryContents = useMemo(() => {
    const map: Record<string, string> = {}
    for (const node of graphNodes) {
      for (const e of node.events) {
        if (e.type === 'memory_add' || e.type === 'memory_compress') {
          map[e.id] = String(e.payload.content ?? e.payload.summary ?? '')
        }
      }
    }
    return map
  }, [graphNodes])

  // グラフデータの変化時のみノード配列を再構築。ドラッグ・選択は
  // applyNodeChanges の差分適用に任せる(毎フレーム再構築するとチラつく)
  useEffect(() => {
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const heights: Record<string, number> = {}
      for (const n of prev) {
        if (n.measured?.height) heights[n.id] = n.measured.height
      }
      const computed = layoutDag(graphNodes, graphEdges, heights)
      return graphNodes.map((n) => {
        const existing = prevById.get(n.id)
        const position =
          n.pos_x != null && n.pos_y != null
            ? { x: n.pos_x, y: n.pos_y }
            : computed[n.id] ?? { x: 0, y: 0 }
        return {
          id: n.id,
          type: 'beatNode' as const,
          position: existing?.dragging ? existing.position : position,
          selected: existing?.selected ?? false,
          dragging: existing?.dragging,
          data: { storyNode: n, characters: charMap }
        }
      })
    })
  }, [graphNodes, graphEdges, charMap])

  // 実測高さが揃ったら、自動レイアウトのノードだけ位置を組み直す
  // (初回マウント直後は高さ未測定のため、測定後に一度リフローする)
  const heightsSig = flowNodes.map((n) => `${n.id}:${Math.round(n.measured?.height ?? 0)}`).join(',')
  useEffect(() => {
    setFlowNodes((prev) => {
      if (prev.some((n) => n.dragging)) return prev
      const heights: Record<string, number> = {}
      for (const n of prev) {
        if (n.measured?.height) heights[n.id] = n.measured.height
      }
      const computed = layoutDag(graphNodes, graphEdges, heights)
      let changed = false
      const next = prev.map((n) => {
        const gn = graphNodes.find((g) => g.id === n.id)
        if (!gn || (gn.pos_x != null && gn.pos_y != null)) return n // 手動配置は触らない
        const p = computed[n.id]
        if (!p || (Math.abs(n.position.x - p.x) < 0.5 && Math.abs(n.position.y - p.y) < 0.5)) return n
        changed = true
        return { ...n, position: p }
      })
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heightsSig])

  const handleNodesChange = useCallback((changes: NodeChange<BeatFlowNode>[]): void => {
    setFlowNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  // 選択ノードの削除(削除ボタンと Delete キーの共通処理)。子を持つノードは削除できない
  const deleteNodeById = useCallback(
    async (nodeId: string): Promise<void> => {
      const node = graphNodes.find((n) => n.id === nodeId)
      const label = node?.title || '(無題)'
      if (!window.confirm(`シーン「${label}」を削除しますか?(後続シーンは前のシーンに繋がります)`)) return
      try {
        await api.deleteNode(nodeId)
        beatDraftCache.delete(nodeId)
        setSelectedId((current) => (current === nodeId ? null : current))
        await reload()
      } catch (e) {
        setGenStatus(`削除できません: ${String(e)}`)
      }
    },
    [graphNodes, reload]
  )

  // キーボードショートカット(lm-graph と同じ): A = 全体表示 / F = 選択にフォーカス
  // Delete = 選択ノードを削除
  const reactFlow = useReactFlow()
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return
      }
      if (event.key === 'Delete') {
        // キャンバス上で選択中のノードを優先し、無ければインスペクタの選択ノード
        const targetId = flowNodes.find((n) => n.selected)?.id ?? selectedId
        if (!targetId) return
        event.preventDefault()
        void deleteNodeById(targetId)
        return
      }
      if (event.key === 'a') {
        event.preventDefault()
        void reactFlow.fitView({ duration: 300, padding: 0.1 })
        return
      }
      if (event.key === 'f') {
        let targets = flowNodes.filter((n) => n.selected)
        if (targets.length === 0 && selectedId) {
          targets = flowNodes.filter((n) => n.id === selectedId)
        }
        if (targets.length === 0) return
        event.preventDefault()
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const n of targets) {
          const width = n.measured?.width ?? 288
          const height = n.measured?.height ?? 160
          minX = Math.min(minX, n.position.x)
          minY = Math.min(minY, n.position.y)
          maxX = Math.max(maxX, n.position.x + width)
          maxY = Math.max(maxY, n.position.y + height)
        }
        void reactFlow.fitBounds(
          { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
          { duration: 300, padding: 0.2 }
        )
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [reactFlow, flowNodes, selectedId, deleteNodeById])

  // 選択ノードまでのパス(親エッジを遡る)。関係図は選択中の時間軸を表示する
  const pathToSelected = useMemo(() => {
    if (!selectedId) return null
    const parentMap = new Map(graphEdges.map((e) => [e.to_node, e.from_node]))
    const nodeById = new Map(graphNodes.map((n) => [n.id, n]))
    if (!nodeById.has(selectedId)) return null
    const ids: string[] = [selectedId]
    const seen = new Set([selectedId])
    let current = selectedId
    while (parentMap.has(current)) {
      const parent = parentMap.get(current)!
      if (seen.has(parent)) break
      ids.push(parent)
      seen.add(parent)
      current = parent
    }
    ids.reverse()
    return ids.map((id) => nodeById.get(id)!).filter(Boolean)
  }, [selectedId, graphNodes, graphEdges])

  // 正史パス(canon エッジを根から辿る)
  const canonPath = useMemo(() => {
    const canonChildren = new Map(graphEdges.filter((e) => e.is_canon).map((e) => [e.from_node, e.to_node]))
    const hasParent = new Set(graphEdges.map((e) => e.to_node))
    const nodeById = new Map(graphNodes.map((n) => [n.id, n]))
    const root = graphNodes.find((n) => !hasParent.has(n.id))
    if (!root) return [] as StoryNode[]
    const path: StoryNode[] = [root]
    const seen = new Set([root.id])
    let current = root.id
    while (canonChildren.has(current)) {
      const next = canonChildren.get(current)!
      if (seen.has(next)) break
      const node = nodeById.get(next)
      if (!node) break
      path.push(node)
      seen.add(next)
      current = next
    }
    return path
  }, [graphNodes, graphEdges])

  const flowEdges: Edge[] = useMemo(
    () =>
      graphEdges.map((e) => ({
        id: e.id,
        source: e.from_node,
        target: e.to_node,
        style: e.is_canon
          ? { stroke: '#8a8fb8', strokeWidth: 2.5 }
          : { stroke: '#4a4f66', strokeWidth: 1.5, strokeDasharray: '7 5' }
      })),
    [graphEdges]
  )

  const selectedNode = graphNodes.find((n) => n.id === selectedId) ?? null

  const handleAddBeat = async (): Promise<void> => {
    const node = await api.createNode({
      beat: '(ここに出来事の仕様を書く)',
      cast: [],
      parent_id: selectedId ?? undefined
    })
    await reload()
    setSelectedId(node.id)
    setInspectorTab('beat')
  }

  const handleInsertAfter = async (): Promise<void> => {
    if (!selectedId) return
    const node = await api.insertNodeAfter(selectedId, {
      beat: '(ここに出来事の仕様を書く)',
      cast: []
    })
    await reload()
    setSelectedId(node.id)
    setInspectorTab('beat')
  }

  const handleGenerate = async (parentId: string | null): Promise<void> => {
    const controller = new AbortController()
    genAbortRef.current = controller
    setGenerating(true)
    setGenStatus('LLM 準備中…(初回はモデルロードに時間がかかります)')
    try {
      await generateBeatStream(
        instruction.trim() || null,
        (e) => {
          if (e.stage === 'generating') setGenStatus(`シーン生成中…(${e.attempt} 回目)`)
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
        },
        parentId,
        controller.signal
      )
    } catch (err) {
      setGenStatus(isAbortError(err) ? 'キャンセルしました' : String(err))
    } finally {
      genAbortRef.current = null
      setGenerating(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={rowRef} className="flex min-h-0 flex-1">
        {/* ノードエリア + 相談チャット(インスペクタに被らないよう左カラム内に収める) */}
        <div className="flex min-w-0 flex-1 flex-col">
        <main className="relative min-h-0 flex-1" style={{ background: 'var(--bg-canvas)' }}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            // 既定の Backspace 削除は API を通さず画面だけ消えてしまうため無効化し、
            // 削除は Delete キー(下の keydown ハンドラ)に集約する
            deleteKeyCode={null}
            onNodesChange={handleNodesChange}
            onSelectionChange={({ nodes }) => {
              setSelectedId((prev) => {
                if (nodes.length === 0) return null
                // 複数選択中は先頭をインスペクタ対象にする
                return nodes.some((n) => n.id === prev) ? prev : nodes[0].id
              })
            }}
            onNodeDragStop={(_, __, draggedNodes) => {
              for (const dragged of draggedNodes) {
                void api.setNodePosition(dragged.id, dragged.position.x, dragged.position.y)
              }
            }}
            minZoom={0.1}
            maxZoom={2}
            fitView
            panOnDrag={[1]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1.4} color="#394154" />
            {minimapVisible && <MiniMap pannable zoomable nodeColor={() => '#2e3140'} />}
            <Panel position="top-left">
              <div className="flex w-72 flex-col gap-2">
                <div className="flex gap-1.5">
                  <button
                    onClick={() => void handleAddBeat()}
                    className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white shadow-lg shadow-black/30"
                    style={{ background: 'var(--accent)' }}
                    title={selectedId ? '選択ノードの子として追加' : '正史の末尾に追加'}
                  >
                    + シーン追加
                  </button>
                  {selectedId && (
                    <button
                      onClick={() => void handleInsertAfter()}
                      className="rounded-lg border px-2.5 py-1.5 text-[12px] shadow-lg shadow-black/30"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                      title="選択ノードと後続シーンの間に新しいシーンを割り込ませる"
                    >
                      ⤵ 間に挿入
                    </button>
                  )}
                  <button
                    onClick={() => {
                      void api.resetLayout().then(() => {
                        // 保存座標を消した上でドラッグ中間状態も破棄して再構築する
                        setFlowNodes([])
                        void reload()
                      })
                    }}
                    className="rounded-lg border px-2.5 py-1.5 text-[12px] shadow-lg shadow-black/30"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    title="手動配置をリセットして自動レイアウトに戻す"
                  >
                    ⟲ 自動整列
                  </button>
                </div>
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
                  <div className="flex flex-col gap-1.5">
                    {generating ? (
                      <button
                        onClick={() => genAbortRef.current?.abort()}
                        className="w-full rounded-lg border px-3 py-1.5 text-[13px] font-medium"
                        style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                      >
                        ■ 生成を中止
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => void handleGenerate(null)}
                          className="w-full rounded-lg px-3 py-1.5 text-[13px] font-medium text-white"
                          style={{ background: 'var(--accent)' }}
                        >
                          ▶ 次のシーンを生成
                        </button>
                        <button
                          onClick={() => void handleGenerate(selectedId)}
                          disabled={!selectedId}
                          className="w-full rounded-lg border px-3 py-1.5 text-[13px] font-medium disabled:opacity-40"
                          style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
                          title="選択ノードから what-if 分岐を draft として生成"
                        >
                          ⑂ 選択ノードから分岐を生成
                        </button>
                      </>
                    )}
                  </div>
                  {genStatus && (
                    <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                      {genStatus}
                      {generating && (
                        <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                          ({genElapsed}s)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Panel>
            {graphNodes.length === 0 && (
              <Panel position="top-center">
                <div
                  className="mt-24 rounded-2xl border px-6 py-4 text-[13px]"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                >
                  「+ シーン追加」または「▶ 次のシーンを生成」で物語を始めてください
                </div>
              </Panel>
            )}
          </ReactFlow>
        </main>
        <ChatDrawer
          selectedId={selectedId}
          canonTailId={canonPath.length > 0 ? canonPath[canonPath.length - 1].id : null}
          nodesById={Object.fromEntries(graphNodes.map((n) => [n.id, n]))}
          characters={characters}
          onGraphChanged={() => void reload()}
        />
        </div>
        {/* リサイズハンドル(見た目は 1px のライン、当たり判定は幅 4px のまま) */}
        <div
          onPointerDown={beginInspectorResize}
          className="group relative w-1 shrink-0 cursor-col-resize"
          title="ドラッグで幅を変更"
        >
          <div
            className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-[var(--accent-border)]"
            style={{ background: 'var(--border)' }}
          />
        </div>
        <aside
          className="flex shrink-0 flex-col"
          style={{ background: 'var(--bg-sidebar)', width: inspectorWidth }}
        >
          <div className="flex gap-1 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
            {(
              [
                { id: 'beat', label: 'シーン' },
                { id: 'char', label: 'キャラ' },
                { id: 'graph', label: '関係図' }
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
          </div>
          <div className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            {inspectorTab === 'graph' ? (
              <RelationGraph
                characters={characters}
                path={pathToSelected ?? canonPath}
                allNodes={graphNodes}
                onCharactersChanged={() => void reload()}
              />
            ) : selectedNode ? (
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
                <CharTab
                  node={selectedNode}
                  characters={characters}
                  memoryContents={memoryContents}
                  onChanged={() => void reload()}
                />
              )
            ) : (
              <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                ノードを選択してください
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

export default function StructureMode({ settingsVersion = 0 }: { settingsVersion?: number }): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <StructureModeInner settingsVersion={settingsVersion} />
    </ReactFlowProvider>
  )
}
