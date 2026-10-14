import { memo, useCallback, useEffect, useMemo } from 'react'
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
 * - 配置は自動のみ(左の列にキャラクター、正史順に左から右へシーン)。対象は正史のみ
 *
 * docs/plan/plan.md の「構造モードのキャラクタービュー」を参照。
 */

const CHAR_COLUMN_X = 0
const CHAR_ROW_GAP = 64
const SCENE_START_X = 300
const SCENE_GAP_X = 330
const FALLBACK_COLOR = '#8a8fa8'

// ---- ノード -----------------------------------------------------------

type ChainCharData = { char: Character; count: number }
type ChainCharNode = Node<ChainCharData, 'chainChar'>

type ChainSceneData = {
  scene: StoryNode
  index: number
  chapter: string | null
  cast: Character[]
  selected: boolean
  readOnly: boolean
}
type ChainSceneNode = Node<ChainSceneData, 'chainScene'>

function ChainCharCard({ data }: NodeProps<ChainCharNode>): React.JSX.Element {
  const color = data.char.color ?? FALLBACK_COLOR
  return (
    <div
      className="relative flex w-44 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px]"
      style={{ background: 'var(--bg-card)', border: `1.5px solid ${color}`, color: data.count > 0 ? 'var(--text)' : 'var(--text-faint)' }}
      data-tip={
        data.count > 0
          ? `${data.char.name}: ${data.count} シーンに登場。右の口からシーンの入口へ線を引くと、そのシーンに登場します`
          : `${data.char.name}: まだ登場していません。右の口からシーンの入口へ線を引くと登場します`
      }
    >
      <CharAvatar char={data.char} size={22} />
      <span className="min-w-0 flex-1 truncate">{data.char.name}</span>
      <span className="shrink-0 tabular-nums text-[11px]" style={{ color: 'var(--text-faint)' }}>{data.count}</span>
      <Handle type="source" position={Position.Right} id="out" style={{ background: color, borderColor: color }} />
    </div>
  )
}

function ChainSceneCard({ data }: NodeProps<ChainSceneNode>): React.JSX.Element {
  const { scene, index, chapter, cast, selected, readOnly } = data
  return (
    <div
      className={`w-60 rounded-2xl border ${selected ? 'ring-4' : ''}`}
      style={{
        background: 'var(--bg-card)',
        borderColor: selected ? 'var(--accent-border)' : 'var(--border-strong)',
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
    >
      <div className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }} data-tip="クリックで選択(下の詳細欄で編集できます)">
        {chapter && (
          <div className="truncate text-[10px]" style={{ color: 'var(--text-faint)' }}>{chapter}</div>
        )}
        <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text)' }}>
          <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>{index + 1}.</span> {scene.title || '(無題)'}
        </div>
      </div>
      <div className="py-1">
        {cast.map((c) => {
          const color = c.color ?? FALLBACK_COLOR
          return (
            <div key={c.id} className="relative flex items-center gap-2 px-3 py-1 text-[11px]" style={{ color: 'var(--text)' }}>
              <Handle type="target" position={Position.Left} id={`in:${c.id}`} style={{ background: color, borderColor: color }} />
              <CharAvatar char={c} size={18} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <Handle type="source" position={Position.Right} id={`out:${c.id}`} style={{ background: color, borderColor: color }} />
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

function buildNodes(
  path: StoryNode[],
  characters: Character[],
  groups: Group[],
  selectedNodeId: string | null,
  readOnly: boolean
): Array<ChainCharNode | ChainSceneNode> {
  const byId = new Map(characters.map((c) => [c.id, c]))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const counts = new Map<string, number>()
  for (const n of path) for (const id of n.cast ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  const chars: ChainCharNode[] = characters.map((c, i) => ({
    id: charNodeId(c.id),
    type: 'chainChar',
    position: { x: CHAR_COLUMN_X, y: i * CHAR_ROW_GAP },
    draggable: false,
    deletable: false,
    data: { char: c, count: counts.get(c.id) ?? 0 }
  }))
  const scenes: ChainSceneNode[] = path.map((scene, index) => {
    const group = scene.group_id ? groupById.get(scene.group_id) : undefined
    const chapter = group
      ? group.on_canon ? `第${groups.indexOf(group) + 1}章「${group.title}」` : `別ルートの章「${group.title}」`
      : null
    return {
      id: scene.id,
      type: 'chainScene',
      position: { x: SCENE_START_X + index * SCENE_GAP_X, y: 0 },
      draggable: false,
      deletable: false,
      data: {
        scene,
        index,
        chapter,
        cast: (scene.cast ?? []).map((id) => byId.get(id)).filter((c): c is Character => !!c),
        selected: scene.id === selectedNodeId,
        readOnly
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
  if (connection.source.startsWith('char:')) charId = connection.source.slice('char:'.length)
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
  readOnly,
  onSelectNode,
  onCastChange
}: {
  path: StoryNode[]
  characters: Character[]
  groups: Group[]
  selectedNodeId: string | null
  readOnly: boolean
  onSelectNode: (nodeId: string) => void
  /** cast を付け替える(保存は呼び出し側)。add = 登場させる、remove = 外す */
  onCastChange: (sceneId: string, charId: string, op: 'add' | 'remove') => void
}): React.JSX.Element {
  const derivedNodes = useMemo(
    () => buildNodes(path, characters, groups, selectedNodeId, readOnly),
    [path, characters, groups, selectedNodeId, readOnly]
  )
  const derivedEdges = useMemo(() => buildEdges(path, characters, readOnly), [path, characters, readOnly])
  // 選択・接続の途中状態は React Flow 側に持たせ、導出が変わったら差し替える
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
    },
    [onSelectNode]
  )

  return (
    <ReactFlow
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
      // ノードは消せない(消すのは線だけ。線を消すと cast から外れる)
      onBeforeDelete={async ({ edges: toDelete }) => ({ nodes: [], edges: toDelete })}
      deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
      nodesDraggable={false}
      nodesConnectable={!readOnly}
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
