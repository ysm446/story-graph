import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import CharAvatar from './CharAvatar'
import { NodeThumb } from './modes/structure/StructureNodes'
import type { Character, Group, StoryNode } from './types'

/** 人物の鎖(キャラクターの線がシーンを通り抜けていくノード図)。
 *
 * キャラクターのノードから 1 本の線が出て、最初の出番のシーンの入口に差さる。
 * シーンのノードには cast に居る人物ごとの入口と出口があり、出口から次の出番の
 * シーンへつながる。線はすべてシーンの cast から導出する(線は保存しない):
 * ある人物の線 = 正史順で、その人物が cast に居るシーンを順に結んだもの。
 *
 * - 入口(空き口か、その人物の口)に差す = その人物をそのシーンの cast に加える
 * - 線を消す(選んで Delete / ダブルクリック) = 線の先のシーンの cast から外す。
 *   前後の出番は自動でつながり直す
 * - ノードは動かせる。配置は chain_x / chain_y に保存する(フローチャートの pos_x / pos_y
 *   とは別。null = 自動配置)。「整列」で全部を自動配置に戻す
 * - 対象は正史のみ
 *
 * docs/plan/plan.md の「構造モードのキャラクタービュー」を参照。
 */

const CHAR_COLUMN_X = 0
const CHAR_ROW_GAP = 84
const SCENE_START_X = 360
const SCENE_GAP_X = 360 // カード幅(w-72 = 288)+ 余白
const FALLBACK_COLOR = '#8a8fa8'

export type ChainPosition = { id: string; x: number; y: number }

// ---- ノード -----------------------------------------------------------

type ChainCharData = { char: Character; count: number; selected: boolean }
type ChainCharNode = Node<ChainCharData, 'chainChar'>

type ChainSceneData = {
  scene: StoryNode
  index: number
  chapter: string | null
  cast: Character[]
  selected: boolean
  readOnly: boolean
  /** 登場人物の行(アイコン・名前・ピン)をクリック → その人物を詳細欄の「資料」タブで開く(シーンの選択は変えない) */
  onSelectChar: (charId: string) => void
}
type ChainSceneNode = Node<ChainSceneData, 'chainScene'>

function ChainCharCard({ data }: NodeProps<ChainCharNode>): React.JSX.Element {
  const color = data.char.color ?? FALLBACK_COLOR
  return (
    <div
      className={`relative flex w-60 items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium ${data.selected ? 'ring-4' : ''}`}
      style={{
        background: 'var(--bg-card)',
        border: `1.5px solid ${color}`,
        color: data.count > 0 ? 'var(--text)' : 'var(--text-faint)',
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
      data-tip={
        (data.count > 0
          ? `${data.char.name}: ${data.count} シーンに登場。`
          : `${data.char.name}: まだ登場していません。`) +
        'クリックで下の詳細欄にこの人物の状態を出す。右の口からシーンの入口へ線を引くと、そのシーンに登場する'
      }
    >
      <CharAvatar char={data.char} size={36} />
      <span className="min-w-0 flex-1 truncate">{data.char.name}</span>
      <span className="shrink-0 tabular-nums text-[11px] font-normal" style={{ color: 'var(--text-faint)' }}>{data.count}</span>
      <Handle type="source" position={Position.Right} id="out" style={{ ['--handle-color' as string]: color }} />
    </div>
  )
}

function ChainSceneCard({ data }: NodeProps<ChainSceneNode>): React.JSX.Element {
  const { scene, index, chapter, cast, selected, readOnly, onSelectChar } = data
  // ピンは押したまま動かすと線を引く操作になるので、動かさずに離したときだけクリック扱いにする
  const pressAt = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      className={`w-72 rounded-2xl border ${selected ? 'ring-4' : ''}`}
      style={{
        background: 'var(--bg-card)',
        borderColor: selected ? 'var(--accent-border)' : 'var(--border-strong)',
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
    >
      <div className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }} data-tip="クリックで選択(下の詳細欄で編集できます)。ドラッグで動かせます">
        {chapter && (
          <div className="truncate text-[10px]" style={{ color: 'var(--text-faint)' }}>{chapter}</div>
        )}
        <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text)' }}>
          <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>{index + 1}.</span> {scene.title || '(無題)'}
        </div>
        <NodeThumb node={scene} className="mx-auto mt-2 max-h-32 max-w-full rounded-xl" />
        {scene.beat && (
          <div className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            {scene.beat}
          </div>
        )}
      </div>
      <div className="py-1">
        {cast.map((c) => {
          const color = c.color ?? FALLBACK_COLOR
          return (
            <div
              key={c.id}
              className="relative flex cursor-pointer items-center gap-2 px-3 py-1 text-[11px] hover:bg-[var(--accent-soft)]"
              style={{ color: 'var(--text)' }}
              onPointerDown={(e) => { pressAt.current = { x: e.clientX, y: e.clientY } }}
              onClick={(e) => {
                const start = pressAt.current
                pressAt.current = null
                if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return // ドラッグ(線引き・ノード移動)
                e.stopPropagation() // ノードのクリック(シーンの選択)にはしない
                onSelectChar(c.id)
              }}
              data-tip={`${c.name}。クリックで下の詳細欄の「資料」タブにこの人物を出す`}
            >
              <Handle type="target" position={Position.Left} id={`in:${c.id}`} style={{ ['--handle-color' as string]: color }} />
              <CharAvatar char={c} size={18} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {/* 出口の側にも同じアイコン(線を引く先を見たとき、誰の口か分かるように) */}
              <CharAvatar char={c} size={18} />
              <Handle type="source" position={Position.Right} id={`out:${c.id}`} style={{ ['--handle-color' as string]: color }} />
            </div>
          )
        })}
        {!readOnly && (
          <div
            className="relative flex items-center gap-2 px-3 py-1 text-[11px]"
            style={{ color: 'var(--text-faint)' }}
            data-tip="空き口。キャラクターや前のシーンの出口から線を引くと、その人物がこのシーンに登場します"
          >
            <Handle type="target" position={Position.Left} id="in:new" />
            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-dashed" style={{ borderColor: 'var(--border-strong)' }}>+</span>
            <span className="truncate">{cast.length === 0 ? '登場人物なし。ここに線を差す' : '別の人物を差す'}</span>
          </div>
        )}
      </div>
    </div>
  )
}

const nodeTypes = { chainChar: memo(ChainCharCard), chainScene: memo(ChainSceneCard) }

// ---- 導出 -------------------------------------------------------------

const charNodeId = (charId: string): string => `char:${charId}`
const isCharNodeId = (id: string): boolean => id.startsWith('char:')
const charIdOf = (nodeId: string): string => nodeId.slice('char:'.length)

/** 保存済みの配置があればそれ、無ければ自動配置 */
function positionOf(stored: { chain_x?: number | null; chain_y?: number | null }, auto: { x: number; y: number }): { x: number; y: number } {
  return typeof stored.chain_x === 'number' && typeof stored.chain_y === 'number'
    ? { x: stored.chain_x, y: stored.chain_y }
    : auto
}

function buildNodes(
  path: StoryNode[],
  characters: Character[],
  groups: Group[],
  selectedNodeId: string | null,
  selectedCharId: string | null,
  readOnly: boolean,
  onSelectChar: (charId: string) => void
): Array<ChainCharNode | ChainSceneNode> {
  const byId = new Map(characters.map((c) => [c.id, c]))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const counts = new Map<string, number>()
  for (const n of path) for (const id of n.cast ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  const chars: ChainCharNode[] = characters.map((c, i) => ({
    id: charNodeId(c.id),
    type: 'chainChar',
    position: positionOf(c, { x: CHAR_COLUMN_X, y: i * CHAR_ROW_GAP }),
    draggable: !readOnly,
    deletable: false,
    data: { char: c, count: counts.get(c.id) ?? 0, selected: c.id === selectedCharId }
  }))
  const scenes: ChainSceneNode[] = path.map((scene, index) => {
    const group = scene.group_id ? groupById.get(scene.group_id) : undefined
    const chapter = group
      ? group.on_canon ? `第${groups.indexOf(group) + 1}章「${group.title}」` : `別ルートの章「${group.title}」`
      : null
    return {
      id: scene.id,
      type: 'chainScene',
      position: positionOf(scene, { x: SCENE_START_X + index * SCENE_GAP_X, y: 0 }),
      draggable: !readOnly,
      deletable: false,
      data: {
        scene,
        index,
        chapter,
        cast: (scene.cast ?? []).map((id) => byId.get(id)).filter((c): c is Character => !!c),
        selected: scene.id === selectedNodeId,
        readOnly,
        onSelectChar
      }
    }
  })
  return [...chars, ...scenes]
}

/** 人物ごとに、正史順の出番を順に結ぶ。最初の 1 本はキャラクターのノードから */
function buildEdges(path: StoryNode[], characters: Character[], readOnly: boolean): Edge[] {
  const edges: Edge[] = []
  for (const c of characters) {
    const color = c.color ?? FALLBACK_COLOR
    let prev: string | null = null
    path.forEach((scene) => {
      if (!(scene.cast ?? []).includes(c.id)) return
      edges.push({
        id: `chain:${c.id}:${scene.id}`,
        source: prev ?? charNodeId(c.id),
        sourceHandle: prev ? `out:${c.id}` : 'out',
        target: scene.id,
        targetHandle: `in:${c.id}`,
        deletable: !readOnly,
        style: { stroke: color, strokeWidth: 2 },
        data: { charId: c.id }
      })
      prev = scene.id
    })
  }
  return edges
}

/** 接続から「誰を・どのシーンに」を読む。成り立たない接続は null */
function parseConnection(
  connection: Connection,
  path: StoryNode[]
): { charId: string; sceneId: string } | null {
  const targetIndex = path.findIndex((n) => n.id === connection.target)
  if (targetIndex < 0) return null
  let charId: string | null = null
  let sourceIndex = -1
  if (isCharNodeId(connection.source)) charId = charIdOf(connection.source)
  else {
    sourceIndex = path.findIndex((n) => n.id === connection.source)
    if (sourceIndex < 0 || !connection.sourceHandle?.startsWith('out:')) return null
    charId = connection.sourceHandle.slice('out:'.length)
  }
  if (!charId) return null
  // 出口から引く線は、後のシーンへしか差せない(鎖は正史順)
  if (sourceIndex >= 0 && targetIndex <= sourceIndex) return null
  const handle = connection.targetHandle ?? ''
  if (handle !== 'in:new' && handle !== `in:${charId}`) return null
  if ((path[targetIndex].cast ?? []).includes(charId)) return null
  return { charId, sceneId: path[targetIndex].id }
}

// ---- 本体 -------------------------------------------------------------

function CastChainGraphInner({
  path,
  characters,
  groups,
  selectedNodeId,
  selectedCharId,
  readOnly,
  onSelectNode,
  onSelectChar,
  onCastChange,
  onPositionsChange
}: {
  path: StoryNode[]
  characters: Character[]
  groups: Group[]
  selectedNodeId: string | null
  selectedCharId: string | null
  readOnly: boolean
  onSelectNode: (nodeId: string) => void
  onSelectChar: (charId: string) => void
  /** cast を付け替える(保存は呼び出し側)。add = 登場させる、remove = 外す */
  onCastChange: (sceneId: string, charId: string, op: 'add' | 'remove') => void
  /** ドラッグで動かしたノードの配置(保存は呼び出し側) */
  onPositionsChange: (scenes: ChainPosition[], chars: ChainPosition[]) => void
}): React.JSX.Element {
  const derivedNodes = useMemo(
    () => buildNodes(path, characters, groups, selectedNodeId, selectedCharId, readOnly, onSelectChar),
    [path, characters, groups, selectedNodeId, selectedCharId, readOnly, onSelectChar]
  )
  const derivedEdges = useMemo(() => buildEdges(path, characters, readOnly), [path, characters, readOnly])
  // 選択・接続・ドラッグの途中状態は React Flow 側に持たせ、導出が変わったら差し替える
  const [nodes, setNodes, onNodesChange] = useNodesState<ChainCharNode | ChainSceneNode>(derivedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(derivedEdges)
  useEffect(() => setNodes(derivedNodes), [derivedNodes, setNodes])
  useEffect(() => setEdges(derivedEdges), [derivedEdges, setEdges])

  const isValidConnection = useCallback(
    (connection: Edge | Connection): boolean => !readOnly && parseConnection(connection as Connection, path) !== null,
    [path, readOnly]
  )
  const onConnect = useCallback(
    (connection: Connection): void => {
      const parsed = parseConnection(connection, path)
      if (parsed) onCastChange(parsed.sceneId, parsed.charId, 'add')
    },
    [path, onCastChange]
  )
  const removeEdges = useCallback(
    (removed: Edge[]): void => {
      for (const edge of removed) {
        const charId = (edge.data as { charId?: string } | undefined)?.charId
        if (charId) onCastChange(edge.target, charId, 'remove')
      }
    },
    [onCastChange]
  )
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node): void => {
      if (node.type === 'chainScene') onSelectNode(node.id)
      else if (node.type === 'chainChar') onSelectChar(charIdOf(node.id))
    },
    [onSelectNode, onSelectChar]
  )
  // まとめて動かしたときも 1 回で保存する(nodes = 一緒に動いた全ノード)
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent | MouseEvent | TouchEvent, __: Node, dragged: Node[]): void => {
      const scenes: ChainPosition[] = []
      const chars: ChainPosition[] = []
      for (const n of dragged) {
        const p = { id: isCharNodeId(n.id) ? charIdOf(n.id) : n.id, x: n.position.x, y: n.position.y }
        ;(isCharNodeId(n.id) ? chars : scenes).push(p)
      }
      if (scenes.length + chars.length > 0) onPositionsChange(scenes, chars)
    },
    [onPositionsChange]
  )

  return (
    <ReactFlow
      className="cast-chain"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onEdgesDelete={removeEdges}
      onEdgeDoubleClick={readOnly ? undefined : (_, edge) => removeEdges([edge])}
      onNodeClick={onNodeClick}
      onNodeDragStop={onNodeDragStop}
      // ノードは消せない(消すのは線だけ。線を消すと cast から外れる)
      onBeforeDelete={async ({ edges: toDelete }) => ({ nodes: [], edges: toDelete })}
      deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      snapToGrid
      snapGrid={[20, 20]}
      disableKeyboardA11y
      zoomOnDoubleClick={false}
      fitView
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1.4} color="#394154" />
    </ReactFlow>
  )
}

export default function CastChainGraph(props: Parameters<typeof CastChainGraphInner>[0]): React.JSX.Element {
  // 外側のフローチャートとストアを分ける(同じ Provider の下だと状態を共有してしまう)
  return (
    <ReactFlowProvider>
      <CastChainGraphInner {...props} />
    </ReactFlowProvider>
  )
}
