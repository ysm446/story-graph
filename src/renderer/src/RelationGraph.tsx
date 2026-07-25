import { useEffect, useMemo, useRef, useState } from 'react'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import { api, assetUrl } from './api'
import type { Character, StateSnapshot, StoryNode } from './types'

const WIDTH = 360
const HEIGHT = 380

interface GraphNode extends SimulationNodeDatum {
  id: string
}

interface RelEdge {
  from: string
  to: string
  score: number
  reasons: string[]
}

interface ReasonEntry {
  type: string
  payload: Record<string, unknown>
  nodeTitle: string
}

function edgeColor(score: number): string {
  if (Math.abs(score) < 0.15) return '#5c6078'
  return score > 0 ? '#3ecf8e' : '#ef4444'
}

export default function RelationGraph({
  characters,
  canonPath,
  allNodes,
  onCharactersChanged
}: {
  characters: Character[]
  canonPath: StoryNode[]
  allNodes: StoryNode[]
  onCharactersChanged: () => void
}): React.JSX.Element {
  const [scrubIndex, setScrubIndex] = useState(canonPath.length - 1)
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [threshold, setThreshold] = useState(0)
  const [egoCharId, setEgoCharId] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string } | null>(null)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const charMap = useMemo(() => Object.fromEntries(characters.map((c) => [c.id, c])), [characters])

  // イベント ID → 理由表示用エントリ(全ノードの relationship イベントから索引)
  const reasonIndex = useMemo(() => {
    const map: Record<string, ReasonEntry> = {}
    for (const node of allNodes) {
      for (const e of node.events) {
        if (e.type === 'relationship_update' || e.type === 'relationship_set') {
          map[e.id] = { type: e.type, payload: e.payload, nodeTitle: node.title || '(無題)' }
        }
      }
    }
    return map
  }, [allNodes])

  // スクラブ位置の変更で fold 状態を取得
  const clampedIndex = Math.min(Math.max(scrubIndex, 0), Math.max(canonPath.length - 1, 0))
  const scrubNode = canonPath[clampedIndex] ?? null

  useEffect(() => {
    setScrubIndex(canonPath.length - 1)
  }, [canonPath.length])

  useEffect(() => {
    if (!scrubNode) {
      setState(null)
      return
    }
    void api.getState(scrubNode.id).then(setState).catch(() => setState(null))
  }, [scrubNode?.id, scrubNode?.updated_at])

  // 表示対象: 登場済みキャラ + score 非ゼロの関係のみ(スパース)
  const { visibleChars, edges } = useMemo(() => {
    if (!state) return { visibleChars: [] as string[], edges: [] as RelEdge[] }
    const chars = Object.keys(state.chars).filter((id) => charMap[id])
    let rels: RelEdge[] = []
    for (const from of chars) {
      const cs = state.chars[from]
      for (const [to, rel] of Object.entries(cs.relationships)) {
        if (rel.target_type !== 'char' || !charMap[to]) continue
        if (rel.score === 0 || Math.abs(rel.score) < threshold) continue
        rels.push({ from, to, score: rel.score, reasons: rel.reasons })
      }
    }
    if (egoCharId) {
      rels = rels.filter((r) => r.from === egoCharId || r.to === egoCharId)
    }
    const used = new Set(rels.flatMap((r) => [r.from, r.to]))
    const visible = chars.filter((id) => used.has(id) || id === egoCharId)
    return { visibleChars: visible, edges: rels }
  }, [state, charMap, threshold, egoCharId])

  // レイアウト: 保存済み座標をピン留めし、未配置キャラのみ d3-force で配置
  useEffect(() => {
    if (visibleChars.length === 0) return
    const missing = visibleChars.filter((id) => {
      const c = charMap[id]
      return positions[id] === undefined && (c?.graph_x == null || c?.graph_y == null)
    })
    const known: Record<string, { x: number; y: number }> = { ...positions }
    for (const id of visibleChars) {
      if (known[id] === undefined) {
        const c = charMap[id]
        if (c?.graph_x != null && c?.graph_y != null) known[id] = { x: c.graph_x, y: c.graph_y }
      }
    }
    if (missing.length === 0) {
      if (Object.keys(known).length !== Object.keys(positions).length) setPositions(known)
      return
    }
    const simNodes: GraphNode[] = visibleChars.map((id) => {
      const pinned = known[id]
      return pinned
        ? { id, x: pinned.x, y: pinned.y, fx: pinned.x, fy: pinned.y }
        : { id, x: WIDTH / 2 + (Math.random() - 0.5) * 60, y: HEIGHT / 2 + (Math.random() - 0.5) * 60 }
    })
    const nodeById = Object.fromEntries(simNodes.map((n) => [n.id, n]))
    const links: SimulationLinkDatum<GraphNode>[] = edges
      .filter((e) => nodeById[e.from] && nodeById[e.to])
      .map((e) => ({ source: e.from, target: e.to }))
    const sim = forceSimulation(simNodes)
      .force('link', forceLink<GraphNode, SimulationLinkDatum<GraphNode>>(links).id((d) => d.id).distance(110))
      .force('charge', forceManyBody().strength(-350))
      .force('x', forceX(WIDTH / 2).strength(0.06))
      .force('y', forceY(HEIGHT / 2).strength(0.06))
      .force('collide', forceCollide(34))
      .stop()
    for (let i = 0; i < 300; i += 1) sim.tick()
    const next = { ...known }
    for (const n of simNodes) {
      next[n.id] = { x: n.x ?? WIDTH / 2, y: n.y ?? HEIGHT / 2 }
    }
    setPositions(next)
    // 新規配置分をピン留め保存
    for (const id of missing) {
      const p = next[id]
      if (p) void api.updateCharacter(id, { graph_x: p.x, graph_y: p.y }).then(() => onCharactersChanged())
    }
  }, [visibleChars.join(','), edges.length])

  // ノードドラッグ(ピン留め座標の更新)
  const toSvgPoint = (event: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * HEIGHT
    }
  }

  const handlePointerMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    drag.moved = true
    const p = toSvgPoint(event)
    setPositions((prev) => ({ ...prev, [drag.id]: p }))
  }

  const handlePointerUp = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.moved) {
      const p = positions[drag.id]
      if (p) void api.updateCharacter(drag.id, { graph_x: p.x, graph_y: p.y }).then(() => onCharactersChanged())
    } else {
      // クリック = エゴネットワーク切替
      setEgoCharId((prev) => (prev === drag.id ? null : drag.id))
    }
  }

  const selectedReasons: Array<{ score: RelEdge; entries: ReasonEntry[] }> = useMemo(() => {
    if (!selectedEdge) return []
    const edge = edges.find((e) => e.from === selectedEdge.from && e.to === selectedEdge.to)
    if (!edge) return []
    return [{ score: edge, entries: edge.reasons.map((id) => reasonIndex[id]).filter(Boolean) }]
  }, [selectedEdge, edges, reasonIndex])

  const nameOf = (id: string): string => charMap[id]?.name ?? id

  if (canonPath.length === 0) {
    return (
      <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
        正史パスにシーンがありません
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 時間スクラブ */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-faint)' }}>
          <span className="uppercase tracking-[0.14em]">Time</span>
          <span className="truncate pl-2" style={{ color: 'var(--text-dim)' }}>
            {clampedIndex + 1}/{canonPath.length} {scrubNode?.title || '(無題)'}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(canonPath.length - 1, 0)}
          value={clampedIndex}
          onChange={(e) => setScrubIndex(Number(e.target.value))}
          className="graph-slider graph-slider-active w-full"
        />
      </div>
      {/* フィルタ */}
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        <span className="uppercase tracking-[0.14em]">|score| ≥ {threshold.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="graph-slider min-w-0 flex-1"
        />
        {egoCharId && (
          <button
            onClick={() => setEgoCharId(null)}
            className="rounded-md border px-1.5 py-0.5"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
          >
            {nameOf(egoCharId)} のみ ✕
          </button>
        )}
      </div>
      {/* グラフ本体 */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full rounded-xl border"
        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border)', touchAction: 'none' }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <defs>
          <marker
            id="rel-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const from = positions[edge.from]
          const to = positions[edge.to]
          if (!from || !to) return null
          const dx = to.x - from.x
          const dy = to.y - from.y
          const len = Math.hypot(dx, dy) || 1
          // 双方向エッジが重ならないよう法線方向にオフセット
          const nx = (-dy / len) * 6
          const ny = (dx / len) * 6
          // ノード半径分を短縮
          const pad = 26
          const sx = from.x + (dx / len) * pad + nx
          const sy = from.y + (dy / len) * pad + ny
          const tx = to.x - (dx / len) * pad + nx
          const ty = to.y - (dy / len) * pad + ny
          const isSelected = selectedEdge?.from === edge.from && selectedEdge?.to === edge.to
          return (
            <g key={`${edge.from}-${edge.to}`}>
              <line
                x1={sx}
                y1={sy}
                x2={tx}
                y2={ty}
                stroke={edgeColor(edge.score)}
                strokeWidth={1 + Math.abs(edge.score) * 4}
                strokeOpacity={isSelected ? 1 : 0.4 + Math.abs(edge.score) * 0.5}
                markerEnd="url(#rel-arrow)"
              />
              {/* クリック当たり判定用の太い透明線 */}
              <line
                x1={sx}
                y1={sy}
                x2={tx}
                y2={ty}
                stroke="transparent"
                strokeWidth={14}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelectedEdge(isSelected ? null : { from: edge.from, to: edge.to })}
              />
            </g>
          )
        })}
        {visibleChars.map((id) => {
          const p = positions[id]
          if (!p) return null
          const c = charMap[id]
          const retired = state?.chars[id]?.status === 'retired'
          const isEgo = egoCharId === id
          return (
            <g
              key={id}
              transform={`translate(${p.x}, ${p.y})`}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => {
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                dragRef.current = { id, moved: false }
              }}
            >
              {assetUrl(c?.portrait_path) ? (
                <>
                  <clipPath id={`avatar-clip-${id}`}>
                    <circle r={20} />
                  </clipPath>
                  <image
                    href={assetUrl(c?.portrait_path)!}
                    x={-20}
                    y={-20}
                    width={40}
                    height={40}
                    clipPath={`url(#avatar-clip-${id})`}
                    preserveAspectRatio="xMidYMid slice"
                    opacity={retired ? 0.45 : 1}
                  />
                  <circle
                    r={21}
                    fill="none"
                    stroke={isEgo ? 'var(--accent)' : c?.color ?? '#8a8fa8'}
                    strokeWidth={isEgo ? 3 : 2}
                    opacity={retired ? 0.45 : 1}
                  />
                  <text
                    textAnchor="middle"
                    dy="34"
                    fontSize="9"
                    fill="var(--text-dim)"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {(c?.name ?? id).slice(0, 5)}
                  </text>
                </>
              ) : (
                <>
                  <circle
                    r={22}
                    fill="var(--bg-card)"
                    stroke={isEgo ? 'var(--accent)' : c?.color ?? '#8a8fa8'}
                    strokeWidth={isEgo ? 3 : 2}
                    opacity={retired ? 0.45 : 1}
                  />
                  <text
                    textAnchor="middle"
                    dy="4"
                    fontSize="11"
                    fill="var(--text)"
                    opacity={retired ? 0.5 : 1}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {(c?.name ?? id).slice(0, 4)}
                  </text>
                </>
              )}
              {retired && (
                <text
                  textAnchor="middle"
                  dy={c?.portrait_path ? 46 : 34}
                  fontSize="9"
                  fill="var(--text-faint)"
                  style={{ pointerEvents: 'none' }}
                >
                  退場
                </text>
              )}
            </g>
          )
        })}
        {visibleChars.length === 0 && (
          <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle" fontSize="12" fill="var(--text-faint)">
            この時点で score 非ゼロの関係はありません
          </text>
        )}
      </svg>
      {/* エッジ履歴ドリルダウン */}
      {selectedEdge && (
        <div
          className="rounded-xl border p-3"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
        >
          <div className="mb-1.5 flex items-center justify-between text-[12px]">
            <span style={{ color: 'var(--text)' }}>
              {nameOf(selectedEdge.from)} → {nameOf(selectedEdge.to)}
              {selectedReasons[0] && (
                <span className="ml-2 tabular-nums" style={{ color: edgeColor(selectedReasons[0].score.score) }}>
                  {selectedReasons[0].score.score.toFixed(2)}
                </span>
              )}
            </span>
            <button onClick={() => setSelectedEdge(null)} style={{ color: 'var(--text-faint)' }}>
              ✕
            </button>
          </div>
          {selectedReasons[0]?.entries.length === 0 && (
            <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
              履歴イベントが見つかりません
            </div>
          )}
          {selectedReasons[0]?.entries.map((entry, i) => (
            <div
              key={i}
              className="mb-1 rounded-lg border px-2.5 py-1.5 text-[12px]"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="tabular-nums" style={{ color: 'var(--text)' }}>
                  {entry.type === 'relationship_set'
                    ? `= ${Number(entry.payload.value ?? 0).toFixed(2)}`
                    : `${Number(entry.payload.delta ?? 0) >= 0 ? '+' : ''}${Number(entry.payload.delta ?? 0).toFixed(2)}`}
                </span>
                <span className="truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {entry.nodeTitle}
                </span>
              </div>
              {typeof entry.payload.reason === 'string' && entry.payload.reason && (
                <div style={{ color: 'var(--text-dim)' }}>{entry.payload.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        ノードクリック = エゴネットワーク切替 / ドラッグ = 配置(保存されます) / エッジクリック = 履歴
      </p>
    </div>
  )
}
