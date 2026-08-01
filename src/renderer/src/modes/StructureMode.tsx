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
import {
  api,
  assetUrl,
  generateBeatStream,
  isAbortError,
  isVideoAsset,
  reextractNodesStream,
  renderStream,
  uploadAsset
} from '../api'
import ChatDrawer from '../ChatDrawer'
import EventsEditor from '../EventsEditor'
import FactTimeline from '../FactTimeline'
import { MsgActionButton, StatsLine, SystemPromptModal } from '../GenMeta'
import { Icon } from '../icons'
import ProofreadTextarea from '../ProofreadTextarea'
import RelationGraph from '../RelationGraph'
import {
  LengthSelect,
  lengthLabel,
  RenderStyleControls,
  useRenderStyle,
  type RenderStyleState
} from '../RenderStyle'
import {
  cancelTask,
  enqueueTask,
  notifyGraphChanged,
  useTasks,
  setNodeBusy,
  subscribeGraphChanged,
  useBusyNodeIds,
  useTaskFor
} from '../tasks'
import { useElapsedSeconds } from '../useElapsed'
import { backfillVideoThumbs } from '../videoThumb'
import type {
  Character,
  EventInput,
  GraphEdge,
  Group,
  Place,
  RenderResult,
  StateSnapshot,
  StoryEvent,
  StoryNode
} from '../types'

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
  // 実効ロケーション。inherited = このシーンでは指定せず、親から引き継いだもの
  place?: { name: string; inherited: boolean }
  busy?: boolean // LLM 処理中(枠が時計まわりに光る)
}

type BeatFlowNode = Node<BeatNodeData, 'beatNode'>

function BeatNodeCard({ data, selected }: NodeProps<BeatFlowNode>): React.JSX.Element {
  const { storyNode, characters, place, busy } = data
  const isDraft = storyNode.status === 'draft'
  // はじまり / 結末のマーカーノードは小さな専用カード(docs/design/endings.md)
  if (storyNode.kind) {
    const isEnding = storyNode.kind === 'ending'
    const active = storyNode.status === 'canon'
    return (
      <div
        className={`relative w-40 rounded-2xl border-2 px-4 py-3 text-center shadow-lg shadow-black/30 ${
          selected ? 'ring-4' : ''
        }`}
        style={{
          background: 'var(--bg-card)',
          borderColor: active ? 'var(--accent-border)' : 'var(--border-strong)',
          borderStyle: active ? 'solid' : 'dashed',
          opacity: active ? 1 : 0.85,
          ['--tw-ring-color' as string]: 'var(--accent-border)'
        }}
        title={
          isEnding
            ? active
              ? 'アクティブな結末(ここまでが正史)'
              : '結末の候補。右クリック →「この結末にする」で正史を切り替え'
            : '物語のはじまり(最初のシーンはこの子としてつながる)'
        }
      >
        <Handle type="target" position={Position.Left} />
        <div className="text-[16px]">{isEnding ? '🏁' : '📖'}</div>
        <div className="mt-0.5 truncate text-[12px] font-semibold" style={{ color: 'var(--text)' }}>
          {storyNode.title || (isEnding ? '結末' : 'はじまり')}
        </div>
        {isEnding && active && (
          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--accent)' }}>
            アクティブ
          </div>
        )}
        <Handle type="source" position={Position.Right} />
      </div>
    )
  }
  return (
    <div
      className={`relative w-72 rounded-3xl border-2 px-5 py-4 shadow-lg shadow-black/30 ${
        selected ? 'ring-4' : ''
      } ${busy ? 'node-busy-ring' : ''}`}
      style={{
        background: 'var(--bg-card)',
        borderColor: busy ? 'var(--accent-border)' : selected ? 'var(--accent-border)' : 'var(--border-strong)',
        borderStyle: isDraft ? 'dashed' : 'solid',
        opacity: isDraft ? 0.85 : 1,
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
    >
      {/* 当たり判定と見た目は index.css の .react-flow__handle で調整している */}
      <Handle type="target" position={Position.Left} />
      {assetUrl(storyNode.image_path) &&
        (isVideoAsset(storyNode.image_path) ? (
          // グラフ上のカードは静止画で足りるので、保存済みのサムネイルを出す。
          // まだ無い場合だけ動画要素で先頭フレームを見せる(その裏で
          // videoThumb.backfillVideoThumbs が生成して、次回からは <img> になる)
          assetUrl(storyNode.thumb_path) ? (
            <img
              src={assetUrl(storyNode.thumb_path)!}
              className="mx-auto mb-2 max-h-40 max-w-full rounded-xl"
              style={{ opacity: isDraft ? 0.8 : 1 }}
            />
          ) : (
            <video
              src={assetUrl(storyNode.image_path)!}
              preload="metadata"
              muted
              playsInline
              className="mx-auto mb-2 max-h-40 max-w-full rounded-xl"
              style={{ opacity: isDraft ? 0.8 : 1 }}
            />
          )
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
        {place && (
          // 引き継ぎ(このシーンでは未指定)は淡く出して、自分で指定した場所と区別する
          <span
            className="text-[11px]"
            style={{ color: 'var(--text-faint)', opacity: place.inherited ? 0.55 : 1 }}
            title={place.inherited ? '前のシーンから引き継いだ場所' : undefined}
          >
            @{place.name}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

// ---- 章ノード(章ビュー専用の導出表示。docs/design/chapters.md) ------
//
// 実体ノードではない。データモデルはシーンノード + エッジ + nodes.group_id の
// ままで、章ビューは canon パスの「章に属す区間」を 1 枚のカードに圧縮して見せる。

type ChapterNodeData = { group: Group; number: number; onOpen: (groupId: string) => void }
type ChapterFlowNode = Node<ChapterNodeData, 'chapterNode'>
type AppFlowNode = BeatFlowNode | ChapterFlowNode

function ChapterNodeCard({ data, selected }: NodeProps<ChapterFlowNode>): React.JSX.Element {
  const { group, number, onOpen } = data
  return (
    <div
      className={`w-64 rounded-3xl border-2 px-5 py-5 shadow-lg shadow-black/30 ${selected ? 'ring-4' : ''}`}
      style={{
        background: 'var(--bg-card)',
        borderColor: group.color || 'var(--border-strong)',
        // 島・分岐の章は draft ノードと同じく破線で「別の可能性」を示す
        borderStyle: group.on_canon ? 'solid' : 'dashed',
        opacity: group.on_canon ? 1 : 0.9,
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
      title="ダブルクリックで章の中を開く"
      onDoubleClick={(e) => {
        // React Flow のダブルクリックズームに任せず、カード自身で確実に開く
        e.stopPropagation()
        onOpen(group.id)
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="text-[10px] uppercase tracking-[0.25em]" style={{ color: 'var(--text-faint)' }}>
        {group.on_canon ? `第${number}章` : '別ルートの章'}
      </div>
      <div className="mt-1 truncate text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
        {group.title}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-dim)' }}>
        {group.node_ids.length} シーン
        {group.warning && (
          <span
            className="rounded px-1.5 py-px text-[10px]"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
            title={group.warning}
          >
            ⚠ 要確認
          </span>
        )}
        {group.has_digest &&
          (group.digest_stale ? (
            <span
              className="rounded px-1.5 py-px text-[10px]"
              style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
              title="章の中が編集されたので、まとめが古くなっている可能性があります"
            >
              まとめ要更新
            </span>
          ) : (
            <span
              className="rounded px-1.5 py-px text-[10px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--text-dim)' }}
            >
              まとめ済
            </span>
          ))}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { beatNode: BeatNodeCard, chapterNode: ChapterNodeCard }

// ---- ビートタブ ------------------------------------------------------

// 未保存のシーン下書きをノード ID ごとに保持する(セッション内)。
// ノード非選択で BeatTab がアンマウントされても編集内容が消えないようにする。
// 保存やキャンセルではなく「一時退避」なので、保存成功時に該当エントリを消す。
const beatDraftCache = new Map<string, Partial<StoryNode>>()

// putEvents は全件置換なので、手元の node.events を土台にすると、直前の保存が
// reload 前だった場合にそのイベントが消える。保存前にサーバーの最新を取り直す
async function latestEventInputs(nodeId: string, fallback: StoryEvent[]): Promise<EventInput[]> {
  let events = fallback
  try {
    events = (await api.getNode(nodeId)).events ?? fallback
  } catch {
    /* 取れなければ手元の値で続行 */
  }
  // id を引き継ぐ(編集で ID が変わると replaces / reasons の参照が壊れる)
  return events.map((e) => ({ id: e.id, type: e.type, payload: e.payload, source: e.source }))
}

function BeatTab({
  node,
  characters,
  places,
  inheritedPlaceName,
  validation,
  onSaved,
  onDeleted,
  onNodeBusyChange
}: {
  node: StoryNode
  characters: Character[]
  places: Place[]
  /** location が空欄のとき親から引き継がれる場所の名前(無ければ null) */
  inheritedPlaceName: string | null
  validation: string[]
  onSaved: () => void
  onDeleted: () => void
  onNodeBusyChange: (nodeId: string, busy: boolean) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Partial<StoryNode>>({})
  // draft がどのシーンのものか。node が切り替わった直後の 1 レンダーでは draft が
  // まだ前のシーンの値なので、取り違えて退避しないよう突き合わせに使う
  const [draftNodeId, setDraftNodeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState<'title' | 'emotional_core' | null>(null)
  // 退場の入力中(理由をインラインで入力する。Electron は window.prompt が使えない)
  const [retireTarget, setRetireTarget] = useState<string | null>(null)
  const [retireReason, setRetireReason] = useState('death')
  const [imageDragOver, setImageDragOver] = useState(false)
  const suggestElapsed = useElapsedSeconds(suggesting !== null)
  const imageDragDepth = useRef(0) // 子要素との境界で dragleave が発火してもチラつかないよう深さを数える
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const coreTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  // いま表示しているシーン。自動生成の応答が別のシーンの下書きに混ざらないよう突き合わせる
  const shownNodeId = useRef(node.id)
  shownNodeId.current = node.id

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

  // 感情の核はスクロールさせず、内容に合わせて高さを自動調整する
  // (シーン本文は ProofreadTextarea が自前で行う)
  const autosize = useCallback((textarea: HTMLTextAreaElement | null): void => {
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight + 2}px`
  }, [])

  useEffect(() => {
    autosize(coreTextareaRef.current)
  }, [draft.emotional_core, node.id, autosize])

  // サイドバーのリサイズ等で幅が変わると折り返しが変わるため、幅の変化でも再計算する
  useEffect(() => {
    const textarea = coreTextareaRef.current
    if (!textarea) return
    let lastWidth = textarea.clientWidth
    const observer = new ResizeObserver(() => {
      const width = textarea.clientWidth
      if (width !== lastWidth) {
        lastWidth = width
        autosize(textarea)
      }
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [node.id, autosize])

  const suggestField = (field: 'title' | 'emotional_core'): void => {
    const beat = (draft.beat ?? '').trim()
    if (!beat || suggesting) return
    const targetId = node.id // 応答が返るまでに別のシーンへ移っていたら捨てる
    setSuggesting(field)
    setError(null)
    api
      .suggestSceneMeta(beat, field)
      .then(({ value }) => {
        if (value && shownNodeId.current === targetId) setDraft((d) => ({ ...d, [field]: value }))
      })
      .catch((e) => {
        if (shownNodeId.current === targetId) setError(String(e))
      })
      .finally(() => {
        if (shownNodeId.current === targetId) setSuggesting(null)
      })
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
    setDraftNodeId(node.id)
    setError(null)
    setSuggesting(null) // 前のシーンで押した自動生成の表示を引き継がない
    setRetireTarget(null) // 前のシーンで開いた退場理由の入力を残さない
  }, [node.id, node.updated_at])

  const toggleCast = (charId: string): void => {
    setDraft((d) => {
      const cast = d.cast ?? []
      return { ...d, cast: cast.includes(charId) ? cast.filter((c) => c !== charId) : [...cast, charId] }
    })
  }

  // このシーンで退場するキャラ(char_retire イベントを持っているキャラ)
  const retiredHere = node.events
    .filter((e) => e.type === 'char_retire')
    .map((e) => String((e.payload as { char?: string }).char ?? ''))

  // 退場は作者が決める。char_retire イベントの付け外しで表現する。
  // Electron では window.prompt が使えないので、理由の入力はインラインで行う
  const saveRetire = async (charId: string, reason: string): Promise<void> => {
    try {
      const events = await latestEventInputs(node.id, node.events)
      await api.putEvents(node.id, [
        ...events,
        { type: 'char_retire', payload: { char: charId, reason: reason.trim() || 'death' }, source: 'user' }
      ])
      setRetireTarget(null)
      onSaved()
    } catch (e) {
      setError(String(e))
    }
  }

  const cancelRetire = async (charId: string): Promise<void> => {
    try {
      const events = (await latestEventInputs(node.id, node.events)).filter(
        (e) => !(e.type === 'char_retire' && (e.payload as { char?: string }).char === charId)
      )
      await api.putEvents(node.id, events)
      onSaved()
    } catch (e) {
      setError(String(e))
    }
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

  // 下書きがノードの保存値と異なるか(未初期化 / 前のシーンの下書きのままの間は false)
  const dirty =
    draftNodeId === node.id &&
    draft.beat !== undefined &&
    ((draft.title ?? '') !== (node.title ?? '') ||
      (draft.beat ?? '') !== (node.beat ?? '') ||
      (draft.emotional_core ?? '') !== (node.emotional_core ?? '') ||
      (draft.location ?? '') !== (node.location ?? '') ||
      (draft.story_time ?? '') !== (node.story_time ?? '') ||
      JSON.stringify(draft.cast ?? []) !== JSON.stringify(node.cast ?? []))

  // 未保存の変更があればノード ID ごとに退避、変更が無ければ退避を掃除する。
  // シーンを切り替えた直後の 1 レンダーでは draft がまだ前のシーンのものなので、
  // 初期化(setDraft)が届くまで何もしない。ここで書いてしまうと、矢印キーで
  // 続けて移動したときに前のシーンの内容が移動先の下書きとして残ってしまう
  useEffect(() => {
    if (draftNodeId !== node.id) return // 初期化前(draft はまだ前のシーンのもの)
    if (draft.beat === undefined) return
    if (dirty) beatDraftCache.set(node.id, draft)
    else beatDraftCache.delete(node.id)
  }, [draft, dirty, node.id, draftNodeId])

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
      {/* 「ここから先のイベントを作り直す」はノードエリアの右クリック
          (イベントを作り直す(この先も / LLM))と同じ操作なので、こちらは置かない */}
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
            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10px] disabled:opacity-40"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
            title="シーン本文からタイトルを自動生成"
          >
            {suggesting === 'title' ? (
              `生成中… (${suggestElapsed}s)`
            ) : (
              <>
                <Icon name="sparkle" size={11} />
                自動生成
              </>
            )}
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
          <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
            テキストを選ぶと校正できます
          </span>
        </span>
        {/* 高さの自動調整と「選択して校正」は共通コンポーネント側で行う。
            長いシーン本文の一部を直すことがあるので、前後を文脈として渡す */}
        <ProofreadTextarea
          rows={4}
          value={draft.beat ?? ''}
          onChange={(next) => setDraft((d) => ({ ...d, beat: next }))}
          style={inputStyle}
          withContext
        />
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
            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10px] disabled:opacity-40"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
            title="シーン本文から感情の核を自動生成"
          >
            {suggesting === 'emotional_core' ? (
              `生成中… (${suggestElapsed}s)`
            ) : (
              <>
                <Icon name="sparkle" size={11} />
                自動生成
              </>
            )}
          </button>
        </span>
        {/* 長い一文になることがあるので、input ではなく自動で高さが伸びる textarea */}
        <textarea
          ref={coreTextareaRef}
          rows={1}
          value={draft.emotional_core ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, emotional_core: e.target.value }))}
          className="w-full resize-none overflow-hidden rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none"
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
            const retired = retiredHere.includes(c.id)
            return (
              <span
                key={c.id}
                // ⊗ が出る(cast 入り)ときだけ右の余白を詰める。出ないときは左右対称に
                className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 text-[12px] ${
                  active ? 'pr-1' : 'pr-2.5'
                }`}
                style={
                  active
                    ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--text)' }
                    : { background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-faint)' }
                }
              >
                <button onClick={() => toggleCast(c.id)} className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color ?? '#8a8fa8' }} />
                  <span className={retired ? 'line-through' : undefined}>{c.name}</span>
                </button>
                {/* 退場は作者が決める(LLM には出させない)。このシーンで退場させる */}
                {active && (
                  <button
                    onClick={() => {
                      if (retired) void cancelRetire(c.id)
                      else {
                        setRetireReason('death')
                        setRetireTarget(c.id)
                      }
                    }}
                    className="rounded-full px-1 text-[11px]"
                    style={{ color: retired ? 'var(--accent)' : 'var(--text-faint)' }}
                    title={
                      retired
                        ? 'このシーンでの退場を取り消す'
                        : 'このシーンで退場させる(以降 cast に入れると警告)'
                    }
                  >
                    {retired ? '⏎' : '⊗'}
                  </button>
                )}
              </span>
            )
          })}
        </div>
        {/* 退場の理由を入力(Electron では prompt が使えないためインラインで) */}
        {retireTarget && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
            <span style={{ color: 'var(--text-dim)' }}>
              {characters.find((c) => c.id === retireTarget)?.name} を退場させる理由:
            </span>
            <input
              autoFocus
              value={retireReason}
              onChange={(e) => setRetireReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void saveRetire(retireTarget, retireReason)
                }
                if (e.key === 'Escape') setRetireTarget(null)
              }}
              placeholder="death / departure など"
              className="w-40 rounded-md border px-1.5 py-0.5 outline-none"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--accent-border)' }}
            />
            <button
              onClick={() => void saveRetire(retireTarget, retireReason)}
              className="rounded-md px-2 py-0.5 font-medium text-white"
              style={{ background: 'var(--accent)' }}
            >
              退場させる
            </button>
            <button onClick={() => setRetireTarget(null)} style={{ color: 'var(--text-faint)' }}>
              取消
            </button>
          </div>
        )}
        {retiredHere.length > 0 && (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            このシーンで退場: {retiredHere.map((id) => characters.find((c) => c.id === id)?.name ?? id).join(', ')}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className={labelClass} style={{ color: 'var(--text-faint)' }}>
            Location
          </span>
          {/* 場所は登録制。未指定なら親から引き継ぐ(docs/design/places.md) */}
          <select
            value={draft.location ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value || null }))}
            className="w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
            style={{
              ...inputStyle,
              color: draft.location ? 'var(--text)' : 'var(--text-faint)'
            }}
          >
            <option value="">
              {inheritedPlaceName ? `引き継ぎ(${inheritedPlaceName})` : '指定しない'}
            </option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {places.length === 0 && (
            <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-faint)' }}>
              資料庫の「場所」タブで登録できます
            </span>
          )}
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
      <EventsEditor
        node={node}
        characters={characters}
        onChanged={onSaved}
        onBusyChange={(busy: boolean) => onNodeBusyChange(node.id, busy)}
      />
    </div>
  )
}

// ---- キャラタブ(状態閲覧 + 手動イベント化する編集) -------------------

function CharTab({
  node,
  characters,
  memoryContents,
  onChanged,
  onSelectNode
}: {
  node: StoryNode
  characters: Character[]
  /** 記憶イベント ID → 本文とどのシーンの記憶か */
  memoryContents: Record<string, { content: string; nodeId: string; title: string }>
  onChanged: () => void
  onSelectNode: (nodeId: string) => void
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
  // 記憶の並び順。既定は新しい順(直近の変化が上に来て差分が見やすい)
  const [memNewestFirst, setMemNewestFirst] = useState(
    () => localStorage.getItem('memoriesOldestFirst') !== '1'
  )

  const eventsKey = node.events.map((e) => e.id).join(',')

  // シーンが変わったら、前のシーンの状態を出したままにしない。
  // 矢印キーで次々に切り替えると取得が複数走るので、古い応答は捨てる
  // (捨てないと、後から返ってきた前のシーンの状態が残り続ける)
  useEffect(() => {
    setCharId((prev) => (prev && node.cast.includes(prev) ? prev : node.cast[0] ?? null))
    let ignore = false
    setState(null)
    void api
      .getState(node.id)
      .then((s) => {
        if (!ignore) setState(s)
      })
      .catch(() => {
        if (!ignore) setState(null)
      })
    return () => {
      ignore = true
    }
  }, [node.id, node.updated_at, eventsKey])

  // 書きかけの入力とエラーは前のシーンのものなので、切り替えたら捨てる
  useEffect(() => {
    setError(null)
    setFactKey('')
    setFactValue('')
    setRelTarget('')
    setRelReason('')
    setRelLabel('')
    setMemContent('')
  }, [node.id])

  const charState = charId ? state?.chars[charId] : null
  const nameOf = (id: string): string => characters.find((c) => c.id === id)?.name ?? id

  const appendEvent = async (event: StoryEvent['payload'] & object, type: string): Promise<void> => {
    setError(null)
    try {
      await api.putEvents(node.id, [
        ...(await latestEventInputs(node.id, node.events)),
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
                {/* 0 を中心に、好意は右へ・反感は左へ伸ばす(-1.0〜+1.0) */}
                <div
                  className="relative h-1.5 flex-1 overflow-hidden rounded-full"
                  style={{ background: 'var(--bg-input)' }}
                  title={`${nameOf(target)} への好感度 ${rel.score.toFixed(2)}`}
                >
                  <div
                    className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
                    style={{ background: 'var(--border-strong)' }}
                  />
                  <div
                    className="absolute inset-y-0 rounded-full"
                    style={{
                      width: `${Math.abs(rel.score) * 50}%`,
                      [rel.score >= 0 ? 'left' : 'right']: '50%',
                      background: rel.score >= 0 ? '#3ecf8e' : 'var(--danger)'
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
            <div className="mb-1 flex items-center justify-between">
              <h4 className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                Memories({charState.memories.length})
              </h4>
              {charState.memories.length > 1 && (
                <button
                  onClick={() => {
                    setMemNewestFirst((prev) => {
                      localStorage.setItem('memoriesOldestFirst', prev ? '1' : '0')
                      return !prev
                    })
                  }}
                  className="text-[10px] hover:underline"
                  style={{ color: 'var(--text-faint)' }}
                  title="並び順を切り替える"
                >
                  {memNewestFirst ? '新 → 古' : '古 → 新'}
                </button>
              )}
            </div>
            {/* fold の積み順が古い順なので、新しい順は反転して出す */}
            {(memNewestFirst ? [...charState.memories].reverse() : charState.memories).map((eventId) => {
              const memory = memoryContents[eventId]
              return (
                <div
                  key={eventId}
                  className="mb-1 rounded-lg border px-3 py-1.5 text-[12px] leading-relaxed"
                  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                >
                  {memory?.content ?? eventId}
                  {/* どのシーンで得た記憶か(クリックでそのシーンへ) */}
                  {memory && (
                    <button
                      onClick={() => onSelectNode(memory.nodeId)}
                      className="mt-0.5 block max-w-full truncate text-left text-[10px] hover:underline"
                      style={{ color: memory.nodeId === node.id ? 'var(--accent)' : 'var(--text-faint)' }}
                      title={`「${memory.title}」で得た記憶(クリックでそのシーンへ)`}
                    >
                      ← {memory.title}
                      {memory.nodeId === node.id ? '(このシーン)' : ''}
                    </button>
                  )}
                </div>
              )
            })}
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

// ---- 清書タブ --------------------------------------------------------

/** 選択シーンの清書(散文)を見て、その場で書き直せるプレビュー。
 *
 *  鑑賞モードと同じ `renders` を見ている(スタイルプリセット / POV も
 *  `RenderStyle` 経由で共通)。ここで書いたものはそのまま鑑賞モードに出る。
 */
// ---- 章タブ(章ノードを選択したときのインスペクタ。docs/design/chapters.md §6) ----

/** 内容に合わせて縦幅が伸びる textarea(中でスクロールさせない)。
 *  ビートタブの「感情の核」と同じ方式で、インスペクタ幅の変化でも測り直す */
function AutoTextarea({
  value,
  onChange,
  className,
  style
}: {
  value: string
  onChange: (value: string) => void
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const autosize = useCallback((): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [])

  useEffect(() => autosize(), [value, autosize])

  // 折り返しが変わると必要な高さも変わるので、幅の変化でも再計算する
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth
        autosize()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [autosize])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      style={{ ...style, overflow: 'hidden', resize: 'none' }}
    />
  )
}

function ChapterTab({
  group,
  number,
  nodes,
  characters,
  onSelectScene,
  onChanged,
  onRename,
  onDissolve
}: {
  group: Group
  number: number
  nodes: StoryNode[]
  characters: Character[]
  onSelectScene: (nodeId: string) => void
  onChanged: () => void
  onRename: () => void
  onDissolve: () => void
}): React.JSX.Element {
  const [digest, setDigest] = useState<EventInput[]>([])
  const [hasDigest, setHasDigest] = useState(false)
  const [digestStale, setDigestStale] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false) // ローカル編集が未保存
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // まとめの生成は LLM キューに積む(他の生成と同じ 1 件ずつの逐次実行)
  const generateQueued = useTasks().some((t) => t.label === '章のまとめ')

  const nameOf = (charId: string): string => characters.find((c) => c.id === charId)?.name ?? charId
  const nodeTitle = (id: string): string => nodes.find((n) => n.id === id)?.title || '(無題)'

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const d = await api.getGroupDigest(group.id)
      setDigest(d.digest_events ?? [])
      setHasDigest(d.digest_events !== null)
      setDigestStale(d.digest_stale === 1)
      setDirty(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [group.id])

  // 生成タスクの完了は notifyGraphChanged → reload → groups の変化で伝わるので、
  // has_digest / digest_stale が動いたときも取り直す
  useEffect(() => {
    void refetch()
  }, [refetch, group.has_digest, group.digest_stale])

  const generate = (): void => {
    enqueueTask({
      label: '章のまとめ',
      detail: group.title,
      runner: async () => {
        await api.generateGroupDigest(group.id)
        notifyGraphChanged()
      }
    })
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.putGroupDigest(group.id, digest)
      await refetch()
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeDigest = async (): Promise<void> => {
    if (!window.confirm('まとめを削除しますか?(次の章からは生の記憶に戻ります)')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteGroupDigest(group.id)
      await refetch()
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const updateEntry = (index: number, patch: Record<string, unknown>): void => {
    setDigest((prev) => prev.map((e, i) => (i === index ? { ...e, payload: { ...e.payload, ...patch } } : e)))
    setDirty(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-faint)' }}>
          {group.on_canon ? `第${number}章` : '別ルートの章'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          {group.title}
        </span>
        <button
          onClick={onRename}
          title="章の名前を変更"
          className="rounded p-0.5 hover:bg-[var(--accent-soft)]"
          style={{ color: 'var(--text-faint)' }}
        >
          ✎
        </button>
        <button
          onClick={onDissolve}
          title="章を解除する(シーンは残る)"
          className="rounded p-0.5 text-[11px] hover:bg-[var(--accent-soft)]"
          style={{ color: 'var(--text-faint)' }}
        >
          解除
        </button>
      </div>
      {group.warning && (
        <p className="text-[11px] leading-relaxed" style={{ color: '#f2a3a3' }}>
          ⚠ {group.warning}
        </p>
      )}
      <div>
        <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          シーン({group.node_ids.length})
        </span>
        <div className="flex flex-col">
          {group.node_ids.map((id, i) => (
            <button
              key={id}
              onClick={() => onSelectScene(id)}
              className="rounded-md px-2 py-1 text-left text-[12px] hover:bg-[var(--accent-soft)]"
              style={{ color: 'var(--text-dim)' }}
            >
              {i + 1}. {nodeTitle(id)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            章のまとめ
          </span>
          {hasDigest &&
            (digestStale ? (
              <span
                className="rounded px-1.5 py-px text-[10px]"
                style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
                title="章の中が編集されたので、まとめが古くなっている可能性があります"
              >
                要更新
              </span>
            ) : (
              <span
                className="rounded px-1.5 py-px text-[10px]"
                style={{ background: 'var(--accent-soft)', color: 'var(--text-dim)' }}
              >
                最新
              </span>
            ))}
        </div>
        <p className="mb-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          章を閉じたときのキャラごとの要約記憶。次の章からは、この章の生の記憶の代わりに
          このまとめが引き継がれます(生の記憶は清書時の検索などで引き続き参照されます)。
          まとめを更新しない限り、章の中の記憶の編集は次の章へ波及しません。
        </p>
        <div className="mb-2 flex gap-1.5">
          <button
            onClick={generate}
            disabled={generateQueued}
            className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
            title="LLM で章のまとめを作る(既存のまとめは置き換え)"
          >
            {generateQueued ? '生成待ち…' : hasDigest ? '⟳ まとめを作り直す' : '▶ まとめを作る'}
          </button>
          {hasDigest && (
            <button
              onClick={() => void removeDigest()}
              disabled={busy}
              className="rounded-lg border px-2 py-1 text-[12px] disabled:opacity-50"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
            >
              削除
            </button>
          )}
        </div>
        {error && (
          <p className="mb-2 text-[11px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </p>
        ) : digest.length === 0 ? (
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            まだまとめはありません
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {digest.map((e, i) =>
              e.type === 'memory_compress' ? (
                <div
                  key={e.id ?? i}
                  className="rounded-xl border p-2"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
                >
                  <div className="mb-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    <span className="font-medium" style={{ color: 'var(--text)' }}>
                      {nameOf(String(e.payload.char ?? ''))}
                    </span>
                    <span className="ml-auto" style={{ color: 'var(--text-faint)' }}>
                      重要度
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.1}
                      value={Number(e.payload.importance ?? 0.6)}
                      onChange={(ev) => updateEntry(i, { importance: Number(ev.target.value) })}
                      className="w-16 rounded-md border px-1.5 py-0.5 text-[11px]"
                      style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                    />
                  </div>
                  <AutoTextarea
                    value={String(e.payload.summary ?? '')}
                    onChange={(v) => updateEntry(i, { summary: v })}
                    className="w-full rounded-md border px-2 py-1 text-[12px] leading-relaxed outline-none"
                    style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
                  />
                </div>
              ) : (
                <div
                  key={e.id ?? i}
                  className="rounded-xl border p-2 text-[11px]"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                >
                  {e.type}: {JSON.stringify(e.payload)}
                </div>
              )
            )}
            {dirty && (
              <button
                onClick={() => void save()}
                disabled={busy}
                className="self-end rounded-lg px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                まとめを保存
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RenderTab({
  node,
  style,
  isCanon,
  onNodeBusyChange,
  onNodeChanged
}: {
  node: StoryNode
  style: RenderStyleState
  /** 正史パス上のシーンか(分岐・島は直前シーンの文体接続が効かない) */
  isCanon: boolean
  onNodeBusyChange: (nodeId: string, busy: boolean) => void
  /** シーン個別の分量を変えたとき(グラフの node を取り直す) */
  onNodeChanged: () => void
}): React.JSX.Element {
  const { presetId, povChar } = style
  const [render, setRender] = useState<RenderResult | null>(null)
  const [loading, setLoading] = useState(true)
  // この清書の生成に送った内容(プロンプト)をモーダルで見る(null = 閉じている)
  const [promptView, setPromptView] = useState<Array<Record<string, unknown>> | null>(null)
  // 生成中の文字列。どのシーンのものかを持つ(生成中に別のシーンへ移れる)
  const [live, setLive] = useState<{ nodeId: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const task = useTaskFor('render', node.id)
  const running = task?.status === 'running'
  const elapsed = useElapsedSeconds(running)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // シーン個別の分量。保存はサーバー任せだが、reload を待つと選択が戻って見えるので
  // 楽観的にローカルへ反映する(node が更新されたら破棄)
  const [charsOverride, setCharsOverride] = useState<number | null>(null)
  useEffect(() => {
    setCharsOverride(null)
  }, [node.id, node.target_chars])
  const nodeChars = charsOverride ?? node.target_chars ?? 0
  // 実際に効く字数(シーン個別 > 共通)。表示と字数比較に使う
  const effectiveChars = nodeChars || style.targetChars
  // 分量の保存が終わる前に清書を押されても取りこぼさないよう、保存を待ってから流す
  const savingRef = useRef<Promise<unknown>>(Promise.resolve())
  // 清書タスクを中止したとき、保存待ちで固まらないよう保存も中止できるようにする
  const saveAbortRef = useRef<AbortController | null>(null)

  const saveNodeChars = (chars: number): void => {
    setCharsOverride(chars)
    const controller = new AbortController()
    saveAbortRef.current = controller
    savingRef.current = api
      .setNodeTargetChars(node.id, chars || null, controller.signal)
      .then(onNodeChanged)
      .catch((e) => {
        if (!isAbortError(e)) setError(String(e))
      })
  }

  // いま何を映しているか。生成完了時に「まだ同じ条件を見ているか」の判定に使う
  const shownRef = useRef({ nodeId: node.id, presetId, povChar })
  useEffect(() => {
    shownRef.current = { nodeId: node.id, presetId, povChar }
  }, [node.id, presetId, povChar])

  useEffect(() => {
    if (!presetId) {
      setRender(null)
      setLoading(false)
      return
    }
    let ignore = false
    setLoading(true)
    setError(null)
    void api
      .getRender(node.id, presetId, povChar)
      .then((r) => {
        if (!ignore) setRender(r.render)
      })
      .catch((e) => {
        if (!ignore) setError(String(e))
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
    // updated_at はシーン編集後に stale 表示を取り直すために見る
  }, [node.id, node.updated_at, presetId, povChar])

  // 生成中は末尾に追従する
  const liveText = live?.nodeId === node.id ? live.text : null
  useEffect(() => {
    if (liveText === null) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [liveText])

  const runRender = (): void => {
    if (!presetId) return
    const targetId = node.id // 実行までに別のシーンへ移っても対象は変えない
    const preset = presetId
    const pov = povChar
    const chars = style.targetChars
    setError(null)
    enqueueTask({
      label: '清書',
      detail: node.title || '(無題)',
      kind: 'render',
      nodeId: targetId,
      runner: async ({ signal }) => {
        onNodeBusyChange(targetId, true)
        setLive({ nodeId: targetId, text: '' })
        // 中止されたら保存も中止する(保存待ちのまま固まらないように)
        const onAbort = (): void => saveAbortRef.current?.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          // 直前に分量を変えていたら、その保存を待ってから流す
          // (シーン個別の分量はサーバーがノードから読むため)
          await savingRef.current.catch(() => undefined)
          await renderStream(
            {
              preset_id: preset,
              pov_char: pov,
              node_ids: [targetId],
              skip_existing: false,
              target_chars: chars
            },
            (e) => {
              if (e.delta) setLive((l) => (l && l.nodeId === targetId ? { ...l, text: l.text + e.delta } : l))
              if (e.scene_done && e.render) {
                const shown = shownRef.current
                if (shown.nodeId === targetId && shown.presetId === preset && shown.povChar === pov) {
                  setRender(e.render)
                }
              }
              // エラーも同じ条件を見ているときだけ出す(別のシーンに混ざらないように)
              if (e.error && shownRef.current.nodeId === targetId) setError(e.error)
            },
            signal
          )
        } catch (err) {
          setError(isAbortError(err) ? '清書を中止しました(書きかけは保存されません)' : String(err))
        } finally {
          signal.removeEventListener('abort', onAbort)
          onNodeBusyChange(targetId, false)
          setLive(null)
        }
      }
    })
  }

  // 本文はシーンタブと同じ UI フォント・サイズで出す(鑑賞用の proseFont / fontSize は
  // 鑑賞モード側だけに使う。インスペクタ内は他タブと見た目を揃える方針。2026-07-31)
  const proseClass = 'whitespace-pre-wrap text-[13px] leading-relaxed'
  const stale = render?.stale === 1

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 条件。プリセットと POV は鑑賞モードと共通、分量はこのシーンだけの指定 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <RenderStyleControls style={style} variant="compact" showLength={false} />
        <LengthSelect
          value={nodeChars}
          onChange={saveNodeChars}
          zeroLabel={`分量: 共通に従う(${lengthLabel(style.targetChars)})`}
          className="min-w-0 flex-1 basis-40"
          title="このシーンだけの目安の字数。共通の設定より優先される(鑑賞モードの全編清書にも効く)"
        />
      </div>
      <div className="flex items-center gap-1.5">
        {running || task ? (
          <button
            onClick={() => task && cancelTask(task.id)}
            className="rounded-lg border px-2.5 py-1 text-[12px]"
            style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
          >
            ■ {running ? `清書中… (${elapsed}s)` : '待機中… 取り消す'}
          </button>
        ) : (
          <button
            onClick={runRender}
            disabled={!presetId}
            className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
            title={render ? '同じ条件で書き直す(前の清書は履歴として残る)' : 'このシーンを散文にする'}
          >
            {render ? '⟳ 清書し直す' : '▶ このシーンを清書'}
          </button>
        )}
        {stale && (
          <span
            className="rounded px-1.5 py-px text-[10px] uppercase"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
            title="このシーンか上流が編集されたので、清書が古くなっています"
          >
            stale
          </span>
        )}
        {render && !liveText && (
          <span
            className="ml-auto text-[11px] tabular-nums"
            style={{ color: 'var(--text-faint)' }}
            title={
              effectiveChars
                ? `目安は ${effectiveChars} 字(${nodeChars ? 'このシーンの指定' : '共通の設定'})`
                : undefined
            }
          >
            {render.prose.length} 字{effectiveChars ? ` / 目安 ${effectiveChars}` : ''}
          </span>
        )}
      </div>
      {!isCanon && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          正史パス外のシーンです。直前シーンの文末に接続する処理は効きません(単独で書かれます)。
        </p>
      )}
      {error && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div ref={bodyRef} className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto">
        {liveText !== null ? (
          <div className={proseClass} style={{ color: 'var(--text)' }}>
            {liveText}
            <span
              className="node-generating-border ml-0.5 inline-block h-4 w-1.5 align-middle"
              style={{ background: 'var(--accent)' }}
            />
          </div>
        ) : render ? (
          <div className={proseClass} style={{ color: 'var(--text)', opacity: stale ? 0.6 : 1 }}>
            {render.prose}
          </div>
        ) : loading ? (
          <div className="pt-6 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </div>
        ) : (
          <div
            className="rounded-xl border border-dashed px-4 py-6 text-center text-[12px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          >
            {presetId ? 'このシーンはまだ清書されていません' : 'スタイルプリセットがありません'}
            <div className="mt-1 text-[11px]">{node.beat}</div>
          </div>
        )}
      </div>
      {/* 生成統計と、生成に送った内容(プロンプト)の確認。チャットの返事と同じ部品。
          列追加(2026-07-31)以前の清書には残っていないので、その場合は出さない */}
      {render && !liveText && (render.meta || render.prompt_messages) && (
        <div className="flex items-center gap-1.5">
          {render.meta && <StatsLine stats={render.meta} />}
          {render.prompt_messages && (
            <MsgActionButton
              kind="prompt"
              title="この清書の生成に送った内容(システムプロンプトなど)を見る"
              onClick={() => setPromptView(render.prompt_messages!)}
            />
          )}
        </div>
      )}
      {promptView !== null && <SystemPromptModal messages={promptView} onClose={() => setPromptView(null)} />}
    </div>
  )
}

// ---- 構造モード本体 --------------------------------------------------

function StructureModeInner({
  settingsVersion,
  onSelectedNodeChange,
  onSelectionCountChange
}: {
  settingsVersion: number
  onSelectedNodeChange?: (nodeId: string | null) => void
  onSelectionCountChange?: (count: number) => void
}): React.JSX.Element {
  const [minimapVisible, setMinimapVisible] = useState(true)
  const [chatDynamicSuggestions, setChatDynamicSuggestions] = useState(true)
  const [graphNodes, setGraphNodes] = useState<StoryNode[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  // 章の表示状態: 'flat' = 全シーン、'chapters' = 章ビュー、それ以外 = 章 ID(章内ビュー)。
  // 章がひとつも無い間は常に flat(書き始めの体験を変えない)
  const [chapterView, setChapterView] = useState<string>('chapters')
  // 章ノードを選択中(インスペクタに章パネルを出す)
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [places, setPlaces] = useState<Place[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<'beat' | 'render' | 'char' | 'graph' | 'facts'>('beat')
  const [validation, setValidation] = useState<string[]>([])
  const [instruction, setInstruction] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genStatus, setGenStatus] = useState<string | null>(null)
  const genElapsed = useElapsedSeconds(generating)
  const genTaskIdRef = useRef<string | null>(null) // 実行中の生成タスクの ID(中止ボタン用)
  const [flowNodes, setFlowNodes] = useState<BeatFlowNode[]>([])
  // 保存座標へ焼き付け済みのノード(pinLayout の二重送信よけ)と、
  // 遅延して読むための最新の flowNodes
  const pinnedRef = useRef<Set<string>>(new Set())
  const flowNodesRef = useRef<BeatFlowNode[]>([])
  // エッジ選択(Delete で切断)と、チェーン再抽出の進捗
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  // 右クリックメニュー(範囲選択した複数ノードへの一括操作)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    targets: string[]
    ending?: boolean
    /** 章カードの右クリック(値は group id) */
    chapter?: string
    /** 何もないところの右クリック(値はキャンバス座標) */
    pane?: { x: number; y: number }
  } | null>(null)
  // 清書の条件(スタイルプリセット / POV)。清書タブと右クリックの一括清書で共用し、
  // 鑑賞モードとも settings 経由で共通(RenderStyle.tsx)
  const renderStyle = useRenderStyle()
  // LLM 処理中のノード(枠が時計まわりに光る)。生成・抽出・再抽出で共用。
  // モジュールレベル(tasks.ts)で持つので、モードを離れて戻っても復元される
  const busyNodeIds = useBusyNodeIds()
  const markNodeBusy = setNodeBusy
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem('inspectorWidth'))
    return saved >= 320 && saved <= 900 ? saved : 480
  })
  const rowRef = useRef<HTMLDivElement | null>(null)
  // 相談チャットはノードエリアとの上下分割ペイン。開閉と高さは親が持つ。
  // モードを切り替えるとこのコンポーネントは破棄されるので、高さと同じく
  // localStorage に覚えておく(閉じた状態が既定)
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem('chatDrawerOpen') === '1')
  const [chatHeight, setChatHeight] = useState(() => {
    const saved = Number(localStorage.getItem('chatDrawerHeight'))
    return saved >= 220 && saved <= 1200 ? saved : 440
  })
  const canvasColumnRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLElement | null>(null) // React Flow の描画領域(中央配置の基準)
  // 生成 UI はキャンバスの面積を食うので、既定は畳んでツールバーのボタンから開く
  const [genPanelOpen, setGenPanelOpen] = useState(false)
  const reactFlow = useReactFlow()

  // 分割でノードエリアの大きさが変わっても、React Flow はビューポート変換をそのまま
  // 維持するため、端のノードが隠れて「パネルが被っている」ように見える。
  // 縮んだ分の半分だけ視点をずらして、見えている内容の中心を保つ。
  // 引数はノードエリアが縮んだ量(拡がった場合は負)。
  const shiftViewportForShrink = useCallback(
    (dx: number, dy: number): void => {
      if (dx === 0 && dy === 0) return
      const viewport = reactFlow.getViewport()
      reactFlow.setViewport({ ...viewport, x: viewport.x - dx / 2, y: viewport.y - dy / 2 })
    },
    [reactFlow]
  )

  // ドラッグ中にアンマウントしても window リスナーと body.userSelect が残らないように、
  // 進行中のドラッグの後始末を持っておく(同時に動くドラッグは 1 つだけ)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => resizeCleanupRef.current?.()
  }, [])

  const beginInspectorResize = useCallback(
    (event: React.PointerEvent): void => {
      event.preventDefault()
      let current = inspectorWidth
      const onMove = (ev: PointerEvent): void => {
        const rect = rowRef.current?.getBoundingClientRect()
        if (!rect) return
        // インスペクタが広がった分だけノードエリアは縮む
        const next = Math.min(900, Math.max(320, rect.right - ev.clientX))
        if (next === current) return
        shiftViewportForShrink(next - current, 0)
        current = next
        setInspectorWidth(next)
      }
      const cleanup = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        resizeCleanupRef.current = null
      }
      const onUp = (): void => {
        cleanup()
        setInspectorWidth((w) => {
          localStorage.setItem('inspectorWidth', String(Math.round(w)))
          return w
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      resizeCleanupRef.current = cleanup
    },
    [inspectorWidth, shiftViewportForShrink]
  )

  const reload = useCallback(async (): Promise<void> => {
    const [graph, chars, placeList, groupList] = await Promise.all([
      api.getGraph(),
      api.listCharacters(),
      api.listPlaces(),
      api.listGroups()
    ])
    setGraphNodes(graph.nodes)
    setGraphEdges(graph.edges)
    setCharacters(chars)
    setPlaces(placeList)
    setGroups(groupList)
  }, [])

  // 選択シーンを親に伝える(鑑賞モードを開いたときにそのシーンへ飛ばすため)
  useEffect(() => {
    onSelectedNodeChange?.(selectedId)
  }, [selectedId, onSelectedNodeChange])

  // 範囲選択の数をステータスバーへ。モードを離れるとこのコンポーネントは
  // 破棄されるが、ステータスバーは生きているので、アンマウント時に 0 を送る
  const selectionCount = flowNodes.filter((n) => n.selected).length
  useEffect(() => {
    onSelectionCountChange?.(selectionCount)
  }, [selectionCount, onSelectionCountChange])
  useEffect(() => {
    return () => onSelectionCountChange?.(0)
  }, [onSelectionCountChange])

  useEffect(() => {
    void reload().catch((e) => setGenStatus(`読み込みに失敗しました: ${String(e)}`))
  }, [reload])

  // キュー(tasks.ts)の runner は完了時に notifyGraphChanged を呼ぶ。runner の
  // クロージャは積んだ時点のコンポーネントを握るため、マウント中はここで購読して
  // reload する(再マウント後もタスク完了が画面に反映される)
  useEffect(() => subscribeGraphChanged(() => void reload().catch(() => undefined)), [reload])

  // 動画挿絵のサムネイルを埋める(未生成のものだけ、1 件ずつ)。
  // 生成できたら reload して、カードを <video> から <img> に切り替える
  useEffect(() => {
    void backfillVideoThumbs(graphNodes).then((created) => {
      if (created) void reload()
    })
  }, [graphNodes, reload])

  // 設定(ミニマップ表示 / 質問候補の自動生成)を読み込む。settingsVersion は
  // 設定ポップアップを閉じたときに変わるので、そこで変更が反映される
  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        setMinimapVisible(s.minimap_visible !== '0')
        setChatDynamicSuggestions(s.chat_dynamic_suggestions !== '0')
      })
      .catch(() => undefined)
  }, [settingsVersion])

  // 矢印キーで次々に選択が変わると取得が複数走るので、古い応答は捨てる
  // (捨てないと、後から返ってきた前のシーンの結果が残り続ける)
  useEffect(() => {
    if (!selectedId) {
      setValidation([])
      return
    }
    let ignore = false
    setValidation([])
    void api
      .validateNode(selectedId)
      .then((r) => {
        if (!ignore) setValidation(r.errors)
      })
      .catch(() => {
        if (!ignore) setValidation([])
      })
    return () => {
      ignore = true
    }
  }, [selectedId, graphNodes])

  const charMap = useMemo(() => Object.fromEntries(characters.map((c) => [c.id, c])), [characters])
  const placeMap = useMemo(() => Object.fromEntries(places.map((p) => [p.id, p])), [places])

  // 実効ロケーション: location が空欄なら親を遡って直近の場所を使う
  // (backend の Store.effective_location と同じ規則。グラフは手元にあるので
  //  ここで解決して、ノード 1 つずつ問い合わせない)
  const effectiveLocations = useMemo(() => {
    const parentOf: Record<string, string> = {}
    for (const e of graphEdges) parentOf[e.to_node] = e.from_node
    const own: Record<string, string | null> = {}
    for (const n of graphNodes) own[n.id] = n.location || null
    const resolved: Record<string, { placeId: string; inherited: boolean } | null> = {}
    for (const n of graphNodes) {
      if (own[n.id]) {
        resolved[n.id] = { placeId: own[n.id]!, inherited: false }
        continue
      }
      let current: string | undefined = parentOf[n.id]
      const seen = new Set<string>([n.id])
      let found: string | null = null
      while (current && !seen.has(current)) {
        seen.add(current)
        if (own[current]) {
          found = own[current]
          break
        }
        current = parentOf[current]
      }
      resolved[n.id] = found ? { placeId: found, inherited: true } : null
    }
    return resolved
  }, [graphNodes, graphEdges])

  // 選択シーンで location を空欄にしたときに引き継がれる場所(= 親の実効ロケーション)
  const inheritedPlaceName = useMemo(() => {
    if (!selectedId) return null
    const parentId = graphEdges.find((e) => e.to_node === selectedId)?.from_node
    const eff = parentId ? effectiveLocations[parentId] : null
    if (!eff) return null
    return placeMap[eff.placeId]?.name ?? eff.placeId
  }, [selectedId, graphEdges, effectiveLocations, placeMap])

  // 記憶(イベント ID)→ 本文とどのシーンの記憶か。キャラタブの一覧で使う
  const memoryContents = useMemo(() => {
    const map: Record<string, { content: string; nodeId: string; title: string }> = {}
    for (const node of graphNodes) {
      for (const e of node.events) {
        if (e.type === 'memory_add' || e.type === 'memory_compress') {
          map[e.id] = {
            content: String(e.payload.content ?? e.payload.summary ?? ''),
            nodeId: node.id,
            title: node.title || '(無題)'
          }
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
        // 一度置いたノードは動かさない。エッジの切断・正史の切り替え・シーンの
        // 追加や削除で DAG の形が変わっても、既に画面にあるノードは自分の位置を
        // 保つ(自動整列は ⟲ を押したときだけ)。新しく現れたノードだけ計算する
        const position =
          n.pos_x != null && n.pos_y != null
            ? { x: n.pos_x, y: n.pos_y }
            : existing?.position ?? computed[n.id] ?? { x: 0, y: 0 }
        return {
          id: n.id,
          type: 'beatNode' as const,
          position: existing?.dragging ? existing.position : position,
          selected: existing?.selected ?? false,
          dragging: existing?.dragging,
          // 実測サイズを引き継ぐ。落とすと再構築のたびに heightsSig が 0 に振れて
          // リフローが走り、保存座標のないノードが仮の高さで並べ直されてしまう
          // (整列直後に 1 ノード動かすと全体が巻き戻って見える不具合の原因)
          measured: existing?.measured,
          data: {
            storyNode: n,
            characters: charMap,
            place: (() => {
              const eff = effectiveLocations[n.id]
              if (!eff) return undefined
              const place = placeMap[eff.placeId]
              return { name: place?.name ?? eff.placeId, inherited: eff.inherited }
            })(),
            busy: busyNodeIds.has(n.id)
          }
        }
      })
    })
  }, [graphNodes, graphEdges, charMap, placeMap, effectiveLocations, busyNodeIds])

  // 実測高さが揃ったら、まだ置き場所が決まっていないノードだけ位置を組み直す
  // (初回マウント直後は高さ未測定のため、測定後に一度リフローする)。
  // 一度焼き付けた(下の effect で保存座標にした)ノードは以後この対象から外れる
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
        if (pinnedRef.current.has(n.id)) return n // 焼き付け済み(保存待ち)も触らない
        const p = computed[n.id]
        if (!p || (Math.abs(n.position.x - p.x) < 0.5 && Math.abs(n.position.y - p.y) < 0.5)) return n
        changed = true
        return { ...n, position: p }
      })
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heightsSig])

  // 高さが測れて位置が落ち着いたノードを、その位置のまま保存座標に焼き付ける。
  // こうしておくと、エッジを切る / 正史を切り替える / シーンを足すといった
  // 構造の変化で DAG の形が変わっても、ノードが自動整列で動くことがない
  // (自動整列に戻したいときはツールバーの ⟲)。高さの測定は 1 ノードずつ
  // 届くので、落ち着くまで待ってから 1 リクエストにまとめる
  useEffect(() => {
    const timer = setTimeout(() => {
      const targets = flowNodesRef.current.filter(
        (n) =>
          !n.dragging &&
          !!n.measured?.height &&
          !pinnedRef.current.has(n.id) &&
          n.data.storyNode.pos_x == null &&
          n.data.storyNode.pos_y == null
      )
      if (targets.length === 0) return
      for (const n of targets) pinnedRef.current.add(n.id)
      void api
        .setNodePositions(
          targets.map((n) => ({ id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }))
        )
        .catch(() => {
          // 保存に失敗しても画面上の位置はそのまま。次の測定で焼き付け直す
          for (const n of targets) pinnedRef.current.delete(n.id)
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [heightsSig])

  useEffect(() => {
    flowNodesRef.current = flowNodes
  }, [flowNodes])

  const handleNodesChange = useCallback((changes: NodeChange<AppFlowNode>[]): void => {
    // シーンノードと章カードは別 state。applyNodeChanges は知らない id の変更を
    // 無視するので、同じ変更列を両方に流すだけでよい。章カードにも流さないと
    // 実測サイズ(measured)が確定せず、React Flow v12 がカードを描画しない
    setFlowNodes((nds) => applyNodeChanges(changes as NodeChange<BeatFlowNode>[], nds))
    setChapterNodes((nds) => applyNodeChanges(changes as NodeChange<ChapterFlowNode>[], nds))
  }, [])

  /** ⟲ の中身。
   *
   * - 2 つ以上のノードを選択中: **選択したノードだけ**を整列する。選択範囲の
   *   左上を動かさないよう、部分 DAG のレイアウト結果を今の左上へ寄せる
   *   (選択の外にあるノードとの重なりは作者に任せる)
   * - それ以外: 手動配置をすべて捨てて全体を自動レイアウトに戻す
   */
  const realignLayout = useCallback(async (): Promise<void> => {
    try {
      const selected = flowNodes.filter((n) => n.selected)
      if (selected.length < 2) {
        await api.resetLayout()
        pinnedRef.current.clear()
        setFlowNodes([]) // 保存座標を消した上でドラッグ中間状態も破棄して再構築する
        await reload()
        return
      }
      const ids = new Set(selected.map((n) => n.id))
      const heights: Record<string, number> = {}
      for (const n of selected) {
        if (n.measured?.height) heights[n.id] = n.measured.height
      }
      const computed = layoutDag(
        graphNodes.filter((n) => ids.has(n.id)),
        graphEdges.filter((e) => ids.has(e.from_node) && ids.has(e.to_node)),
        heights
      )
      const minX = Math.min(...selected.map((n) => n.position.x))
      const minY = Math.min(...selected.map((n) => n.position.y))
      const positions = selected.map((n) => ({
        id: n.id,
        x: Math.round(minX + (computed[n.id]?.x ?? 0)),
        y: Math.round(minY + (computed[n.id]?.y ?? 0))
      }))
      const byId = new Map(positions.map((p) => [p.id, p]))
      setFlowNodes((prev) =>
        prev.map((n) => {
          const p = byId.get(n.id)
          return p ? { ...n, position: { x: p.x, y: p.y } } : n
        })
      )
      for (const p of positions) pinnedRef.current.add(p.id)
      try {
        await api.setNodePositions(positions)
      } catch (e) {
        // 保存できなかったら焼き付け済み扱いにしない(次の測定で保存し直せるように)
        for (const p of positions) pinnedRef.current.delete(p.id)
        throw e
      }
      setGenStatus(`${positions.length} シーンを整列しました`)
      await reload()
    } catch (e) {
      setGenStatus(`整列できません: ${String(e)}`)
    }
  }, [flowNodes, graphNodes, graphEdges, reload])

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

  // ---- エッジの切断 / 接続(島の切り出しと繋ぎ直し) -----------------

  // エッジを切る = 子ノード以下を独立した島にする(ノードは消さない)
  const detachEdge = useCallback(
    async (edgeId: string): Promise<void> => {
      const edge = graphEdges.find((e) => e.id === edgeId)
      if (!edge) {
        setSelectedEdgeId(null) // 消えたエッジの選択を残さない(Delete が誤爆しないように)
        return
      }
      const child = graphNodes.find((n) => n.id === edge.to_node)
      const label = child?.title || '(無題)'
      const message =
        child?.kind === 'ending'
          ? `結末「${label}」を切り離しますか?(あとで別のシーンにつなげます)`
          : `「${label}」から先を切り離しますか?(シーンは残り、独立した島になります)`
      if (!window.confirm(message)) return
      try {
        await api.detachNode(edge.to_node)
        setSelectedEdgeId(null)
        await reload()
      } catch (e) {
        setGenStatus(`切り離せません: ${String(e)}`)
      }
    },
    [graphEdges, graphNodes, reload]
  )

  // 章カードのピンは、章の実シーンに読み替える(出 = 末尾シーン、入 = 先頭シーン)。
  // 章カードは表示上の導出ノードなので、接続は中身のシーンに対して行う
  const resolveEndpoint = useCallback(
    (id: string | null | undefined, role: 'source' | 'target'): string | null => {
      if (!id) return null
      if (!id.startsWith('chapter:')) return id
      const group = groups.find((g) => g.id === id.slice('chapter:'.length))
      if (!group || group.node_ids.length === 0) return null
      return role === 'source' ? group.node_ids[group.node_ids.length - 1] : group.node_ids[0]
    },
    [groups]
  )

  // 繋げるのは「島の根(親がいないノード)」だけ。循環と多重親を防ぐ
  const isValidConnection = useCallback(
    (connection: { source?: string | null; target?: string | null }): boolean => {
      const source = resolveEndpoint(connection.source, 'source')
      const target = resolveEndpoint(connection.target, 'target')
      if (!source || !target || source === target) return false
      if (graphEdges.some((e) => e.to_node === target)) return false // 既に親がいる
      // 自分の下流には繋げない(循環)
      const descendants = new Set([target])
      let added = true
      while (added) {
        added = false
        for (const e of graphEdges) {
          if (descendants.has(e.from_node) && !descendants.has(e.to_node)) {
            descendants.add(e.to_node)
            added = true
          }
        }
      }
      return !descendants.has(source)
    },
    [graphEdges, resolveEndpoint]
  )

  const handleConnect = useCallback(
    async (connection: { source?: string | null; target?: string | null }): Promise<void> => {
      const source = resolveEndpoint(connection.source, 'source')
      const target = resolveEndpoint(connection.target, 'target')
      if (!source || !target || !isValidConnection(connection)) return
      try {
        await api.connectNodes(source, target)
      } catch (e) {
        setGenStatus(`繋げません: ${String(e)}`)
        return
      }
      try {
        // 状態は fold が親から積み直すので LLM は不要。ここでは重複した
        // char_introduce の掃除と検証だけを行う(即時・非破壊的)
        const normalized = await api.normalizeChain(target)
        await reload()
        const parts = [
          '繋ぎました(下書きとして接続)',
          normalized.removed > 0 ? `重複した登場イベントを ${normalized.removed} 件整理` : '整理は不要でした'
        ]
        if (normalized.warnings.length > 0) {
          parts.push(`要確認 ${normalized.warnings.length} 件: ${normalized.warnings[0].errors[0]}`)
        }
        setGenStatus(parts.join(' / '))
      } catch (e) {
        // 接続自体は済んでいる。整合取りの失敗を接続失敗のように報告しない
        await reload().catch(() => undefined)
        setGenStatus(`繋ぎました(下書きとして接続)/ 整合取りに失敗: ${String(e)}`)
      }
    },
    // graphEdges / graphNodes は本体では使わないが、繋いだ結果の再評価に合わせて更新する
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isValidConnection, resolveEndpoint, reload, graphEdges, graphNodes]
  )

  const nameOfChar = useCallback(
    (charId: string): string => characters.find((c) => c.id === charId)?.name ?? charId,
    [characters]
  )

  // ---- 一括操作(右クリックメニュー) ------------------------------

  // 選択した複数シーンのイベントを抽出し直す(親から順に逐次)
  const runReextractNodes = useCallback(
    (nodeIds: string[], includeDownstream: boolean): void => {
      if (nodeIds.length === 0) return
      enqueueTask({
        label: 'イベント作り直し',
        total: nodeIds.length,
        detail: `${nodeIds.length} シーン${includeDownstream ? '(下流も)' : ''}`,
        runner: async ({ update, signal }) => {
          let current: string | null = null
          try {
            await reextractNodesStream(
              { node_ids: nodeIds, include_downstream: includeDownstream },
              (e) => {
                if (e.stage === 'node') {
                  update({ done: e.index, total: e.total, detail: e.title })
                  markNodeBusy(current, false)
                  current = e.node_id ?? null
                  markNodeBusy(current, true)
                }
                if (e.stage === 'done') {
                  const failed = e.failed ?? []
                  setGenStatus(
                    failed.length === 0
                      ? `${e.total} シーンのイベントを作り直しました`
                      : `${(e.total ?? 0) - failed.length} シーン成功 / ${failed.length} シーン失敗: ` +
                        failed.map((f) => f.title).join(', ')
                  )
                }
              },
              signal
            )
          } catch (err) {
            setGenStatus(isAbortError(err) ? '作り直しを中止しました' : `作り直せません: ${String(err)}`)
          } finally {
            markNodeBusy(current, false)
            // reload はこの runner を積んだ時点のインスタンスを握るため、
            // 再マウント後も届くモジュールレベルの通知で反映する
            notifyGraphChanged()
          }
        }
      })
    },
    [markNodeBusy]
  )

  // 整合取り(LLM なし)。重複した登場イベントの掃除 + 検証
  const normalizeNodes = useCallback(
    async (nodeIds: string[]): Promise<void> => {
      let removed = 0
      const warnings: Array<{ title: string; errors: string[] }> = []
      for (const id of nodeIds) {
        try {
          const r = await api.normalizeChain(id)
          removed += r.removed
          warnings.push(...r.warnings)
        } catch {
          /* 個々の失敗は無視して続ける */
        }
      }
      await reload()
      setGenStatus(
        `整合を取りました(登場イベント ${removed} 件を整理)` +
          (warnings.length > 0 ? ` / 要確認 ${warnings.length} 件: ${warnings[0].errors[0]}` : '')
      )
    },
    [reload]
  )

  // 選択したシーンを一括清書(条件は鑑賞モードの選択をそのまま使う)
  const runRenderNodes = useCallback(
    (nodeIds: string[], skipExisting: boolean, includeDownstream = false): void => {
      const presetId = renderStyle.presetId
      if (!presetId || nodeIds.length === 0) return
      let targets = nodeIds
      if (includeDownstream) {
        // 下流(全子孫)を集める。順序はサーバーが正史・深さ順に並べ直す
        const children: Record<string, string[]> = {}
        for (const e of graphEdges) (children[e.from_node] ??= []).push(e.to_node)
        const seen = new Set<string>()
        const stack = [...nodeIds]
        while (stack.length > 0) {
          const id = stack.pop()!
          if (seen.has(id)) continue
          seen.add(id)
          for (const c of children[id] ?? []) stack.push(c)
        }
        targets = [...seen]
      }
      const pov = renderStyle.povChar
      const chars = renderStyle.targetChars
      enqueueTask({
        label: '清書',
        total: targets.length,
        detail: `${targets.length} シーン${skipExisting ? '(未清書のみ)' : ''}`,
        runner: async ({ update, signal }) => {
          let current: string | null = null
          let done = 0
          try {
            await renderStream(
              {
                preset_id: presetId,
                pov_char: pov,
                node_ids: targets,
                skip_existing: skipExisting,
                target_chars: chars
              },
              (e) => {
                // 実際に書くシーン数(未清書のみの絞り込み後)はサーバーが返す
                if (e.stage === 'start') update({ total: e.total })
                if (e.scene_start) {
                  markNodeBusy(current, false)
                  current = e.scene_start
                  markNodeBusy(current, true)
                  // 進捗は「いま何件目か」で数える(0/N から始まらないように)
                  update({ done: done + 1, detail: e.title ?? '' })
                }
                if (e.scene_done) {
                  done += 1
                }
                if (e.error) setGenStatus(`清書エラー: ${e.error}`)
                if (e.done) {
                  setGenStatus(done > 0 ? `${done} シーンを清書しました` : '清書済みのため何もしませんでした')
                }
              },
              signal
            )
          } catch (err) {
            setGenStatus(isAbortError(err) ? '清書を中止しました' : `清書できません: ${String(err)}`)
          } finally {
            markNodeBusy(current, false)
          }
        }
      })
    },
    [markNodeBusy, renderStyle.presetId, renderStyle.povChar, renderStyle.targetChars, graphEdges]
  )

  // 選択したシーンをまとめて切り離す / 削除する
  const detachNodes = useCallback(
    async (nodeIds: string[]): Promise<void> => {
      const targets = nodeIds.filter((id) => graphEdges.some((e) => e.to_node === id))
      if (targets.length === 0) {
        setGenStatus('切り離せるシーンがありません(すでに島の根です)')
        return
      }
      if (!window.confirm(`${targets.length} シーンを親から切り離しますか?(シーンは残ります)`)) return
      let failed = 0
      for (const id of targets) {
        await api.detachNode(id).catch(() => {
          failed += 1
        })
      }
      await reload().catch(() => undefined)
      if (failed > 0) setGenStatus(`${failed} 件のシーンを切り離せませんでした`)
    },
    [graphEdges, reload]
  )

  const deleteNodes = useCallback(
    async (nodeIds: string[]): Promise<void> => {
      if (!window.confirm(`${nodeIds.length} シーンを削除しますか?(後続シーンは前のシーンに繋がります)`)) return
      let failed = 0
      for (const id of nodeIds) {
        await api.deleteNode(id).catch(() => {
          failed += 1
        })
        beatDraftCache.delete(id)
      }
      setSelectedId((current) => (current && nodeIds.includes(current) ? null : current))
      await reload().catch(() => undefined)
      if (failed > 0) setGenStatus(`${failed} 件のシーンを削除できませんでした(子を持つシーンなど)`)
    },
    [reload]
  )

  // 右クリックメニューは外側クリックと Escape で閉じる
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /** 矢印キーでのシーン移動。
   *
   * ← → は時間軸(親 / 子)、↑ ↓ は同じ分岐点の兄弟レーン。DAG の 2 軸と
   * キーの 2 軸を一致させている。兄弟の並びは自動レイアウトと同じ順
   * (正史の子が先、あとは作成順)なので、画面の上下と ↑ ↓ が対応する。
   * 選択ごと動かすので、インスペクタもついてくる。
   */
  const navigateSelection = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down'): void => {
      const currentId = flowNodes.find((n) => n.selected)?.id ?? selectedId
      if (!currentId) return
      const orderIndex = new Map(graphNodes.map((n, i) => [n.id, i]))
      const parentOf = new Map(graphEdges.map((e) => [e.to_node, e.from_node]))
      const sortIds = (ids: string[]): string[] =>
        ids.slice().sort((a, b) => {
          const canonOf = (id: string): number =>
            graphEdges.some((e) => e.to_node === id && e.is_canon) ? 1 : 0
          return canonOf(b) - canonOf(a) || (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0)
        })
      const childrenOf = (id: string): string[] =>
        sortIds(graphEdges.filter((e) => e.from_node === id).map((e) => e.to_node))

      let targetId: string | undefined
      if (direction === 'right') {
        targetId = childrenOf(currentId)[0] // 分岐しているときは正史の子へ
      } else if (direction === 'left') {
        targetId = parentOf.get(currentId)
      } else {
        // 兄弟(親が無ければ島の根どうし)を並べて 1 つ隣へ。端では止まる
        const parent = parentOf.get(currentId)
        const siblings = parent
          ? childrenOf(parent)
          : sortIds(graphNodes.filter((n) => !parentOf.has(n.id)).map((n) => n.id))
        const index = siblings.indexOf(currentId)
        if (index < 0) return
        targetId = siblings[index + (direction === 'down' ? 1 : -1)]
      }
      if (!targetId) return

      const flow = reactFlow.getNode(targetId)
      if (flow) {
        // ズームは保ったまま中央へ寄せる(F の fitBounds とは役割を分ける)
        void reactFlow.setCenter(
          flow.position.x + (flow.measured?.width ?? 288) / 2,
          flow.position.y + (flow.measured?.height ?? FALLBACK_NODE_HEIGHT) / 2,
          { zoom: reactFlow.getZoom(), duration: 300 }
        )
      }
      const nextId = targetId
      setSelectedId(nextId)
      setFlowNodes((prev) =>
        prev.map((n) => (n.selected === (n.id === nextId) ? n : { ...n, selected: n.id === nextId }))
      )
    },
    [flowNodes, selectedId, graphNodes, graphEdges, reactFlow]
  )

  // キーボードショートカット(lm-graph と同じ): A = 全体表示 / F = 選択にフォーカス
  // Delete = 選択ノードを削除(エッジ選択中は切断)
  // 矢印 = シーン間の移動(← → が親子、↑ ↓ が分岐レーン)
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
        // エッジを選択中なら「削除」ではなく「切断」(ノードは残す)
        if (selectedEdgeId) {
          event.preventDefault()
          void detachEdge(selectedEdgeId)
          return
        }
        // キャンバス上で選択中のノードを優先し、無ければインスペクタの選択ノード
        const targetId = flowNodes.find((n) => n.selected)?.id ?? selectedId
        if (!targetId) return
        event.preventDefault()
        void deleteNodeById(targetId)
        return
      }
      const arrows: Record<string, 'left' | 'right' | 'up' | 'down'> = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down'
      }
      if (arrows[event.key]) {
        event.preventDefault()
        navigateSelection(arrows[event.key])
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
  }, [reactFlow, flowNodes, selectedId, deleteNodeById, navigateSelection])

  const toggleChat = useCallback((): void => {
    // 分割線(1px)を含めた分だけノードエリアが縮む / 拡がる
    shiftViewportForShrink(0, chatOpen ? -(chatHeight + 1) : chatHeight + 1)
    setChatOpen((prev) => {
      localStorage.setItem('chatDrawerOpen', prev ? '0' : '1')
      return !prev
    })
  }, [chatOpen, chatHeight, shiftViewportForShrink])

  // 分割線のドラッグでチャットの高さを変える(上へドラッグで拡大)。
  // ノードエリアは最低 160px 残す
  const beginChatResize = useCallback(
    (event: React.PointerEvent): void => {
      event.preventDefault()
      const startY = event.clientY
      const startH = chatHeight
      const columnHeight = canvasColumnRef.current?.clientHeight
      const maxH = columnHeight ? Math.max(columnHeight - 160, 220) : Math.round(window.innerHeight * 0.7)
      let current = startH
      const onMove = (ev: PointerEvent): void => {
        const next = Math.min(Math.max(startH + (startY - ev.clientY), 220), maxH)
        if (next === current) return
        shiftViewportForShrink(0, next - current)
        current = next
        setChatHeight(next)
      }
      const cleanup = (): void => {
        document.body.style.userSelect = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        resizeCleanupRef.current = null
      }
      const onUp = (): void => {
        cleanup()
        localStorage.setItem('chatDrawerHeight', String(Math.round(current)))
      }
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      resizeCleanupRef.current = cleanup
    },
    [chatHeight, shiftViewportForShrink]
  )

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
    // はじまり / 結末マーカーはシーンではないので、パス表示(関係図・事実)からは除く
    return ids
      .map((id) => nodeById.get(id)!)
      .filter(Boolean)
      .filter((n) => !n.kind)
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
    // はじまり / 結末マーカーはシーンではないので正史(シーン列)からは除く
    return path.filter((n) => !n.kind)
  }, [graphNodes, graphEdges])

  const flowEdges: Edge[] = useMemo(
    () =>
      graphEdges.map((e) => {
        const selected = e.id === selectedEdgeId
        return {
          id: e.id,
          source: e.from_node,
          target: e.to_node,
          // クリックしやすいように当たり判定を広めに(見た目の線は細いまま)
          interactionWidth: 18,
          selected,
          style: selected
            ? { stroke: 'var(--accent)', strokeWidth: 3 }
            : e.is_canon
              ? { stroke: '#8a8fb8', strokeWidth: 2.5 }
              : { stroke: '#4a4f66', strokeWidth: 1.5, strokeDasharray: '7 5' }
        }
      }),
    [graphEdges, selectedEdgeId]
  )

  // ---- 章ビュー ⇄ 章内ビュー(docs/design/chapters.md §6) ------------
  // データモデルは変えない。章ビューは flowNodes / graphEdges からの導出表示

  const focusedGroup = useMemo(() => groups.find((g) => g.id === chapterView) ?? null, [groups, chapterView])
  const effectiveView: 'flat' | 'chapters' | 'focused' =
    groups.length === 0 ? 'flat' : focusedGroup ? 'focused' : chapterView === 'chapters' ? 'chapters' : 'flat'

  // 章内ビューで見せるノード: 章のメンバー + そこから生える分岐(draft・未分類)の部分木
  const visibleIds = useMemo(() => {
    if (effectiveView !== 'focused' || !focusedGroup) return null
    const set = new Set(focusedGroup.node_ids)
    const children: Record<string, string[]> = {}
    for (const e of graphEdges) (children[e.from_node] ??= []).push(e.to_node)
    const byId = new Map(graphNodes.map((n) => [n.id, n]))
    const queue = [...focusedGroup.node_ids]
    while (queue.length > 0) {
      const current = queue.pop()!
      for (const child of children[current] ?? []) {
        if (set.has(child)) continue
        const node = byId.get(child)
        // 正史の続き(次章側)へは踏み込まない。分岐(draft)だけを連れてくる
        if (node && node.status === 'draft' && !node.group_id) {
          set.add(child)
          queue.push(child)
        }
      }
    }
    return set
  }, [effectiveView, focusedGroup, graphNodes, graphEdges])

  // 章ビュー用: シーン ID → 章 ID(カードへの写像とエッジの畳み込みに使う)
  const chapterSeq = useMemo(() => {
    const groupByNode = new Map<string, string>()
    groups.forEach((g) => g.node_ids.forEach((n) => groupByNode.set(n, g.id)))
    return { groupByNode }
  }, [groups])

  // 章カードは state で持つ。毎レンダー作り直すと React Flow の実測サイズ
  // (measured)が失われ、v12 は実測が確定するまでノードを描画しないため、
  // カードが不可視のままになる(選択状態の保持も同じ理由)
  const [chapterNodes, setChapterNodes] = useState<ChapterFlowNode[]>([])
  const openChapter = useCallback((groupId: string): void => setChapterView(groupId), [])
  // 章カードの導出位置は「先頭シーンの位置」。整列(⟲)すると正史は横一直線に
  // 並ぶので、章カードもその行にそのまま収まる(以前は章カードだけ専用レーンに
  // 上げていたため、整列すると 2 段に折り返したように見えていた)。
  // 先頭シーンが動いたときだけ作り直せばよいので、位置の署名を依存にする
  const chapterAnchorSig = groups
    .map((g) => {
      const p = flowNodes.find((n) => n.id === g.node_ids[0])?.position
      return p ? `${g.id}:${Math.round(p.x)}:${Math.round(p.y)}` : `${g.id}:-`
    })
    .join(',')
  useEffect(() => {
    setChapterNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const nodeById = new Map(graphNodes.map((n) => [n.id, n]))
      let islandIndex = 0
      return groups.map((g, gi) => {
        const id = `chapter:${g.id}`
        const existing = prevById.get(id)
        // 章カードは一度動かしたらその位置のまま(groups.pos_x/pos_y)。
        // まだ動かしていない章は、画面上の先頭シーンの位置に置く(正史・島とも同じ)
        const first = nodeById.get(g.node_ids[0])
        const anchor =
          flowNodesRef.current.find((n) => n.id === g.node_ids[0])?.position ??
          (first && first.pos_x != null && first.pos_y != null
            ? { x: first.pos_x, y: first.pos_y }
            : undefined)
        const position =
          g.pos_x != null && g.pos_y != null
            ? { x: g.pos_x, y: g.pos_y }
            : // 先頭シーンがまだ画面に無い(整列直後の作り直し中など)は今の位置を保つ
              (anchor ?? existing?.position ?? { x: islandIndex++ * COLUMN_GAP_X, y: 420 })
        return {
          id,
          type: 'chapterNode' as const,
          // ドラッグ中に再構築が走っても位置を巻き戻さない(シーンノードと同じ扱い)
          position: existing?.dragging ? existing.position : position,
          draggable: true,
          dragging: existing?.dragging,
          selected: existing?.selected ?? false,
          measured: existing?.measured,
          data: { group: g, number: gi + 1, onOpen: openChapter }
        }
      })
    })
    // chapterAnchorSig は flowNodes の位置を畳んだ署名(毎フレーム作り直さないため)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, chapterAnchorSig, graphNodes, openChapter])

  // 章ビュー: 章カード + 未分類のシーン
  const chapterFlow = useMemo(() => {
    if (effectiveView !== 'chapters') return null
    const { groupByNode } = chapterSeq
    const nodes: AppFlowNode[] = [...chapterNodes]
    // 章に属さないノード(シーン・分岐・島・はじまり / 結末)は、章ビューでも
    // 自分の位置のまま・通常どおりドラッグできる(以前は正史上のシーンを
    // 並びの列に固定していたが、ドラッグ・整列と衝突するためやめた)
    for (const fn of flowNodes) {
      if (groupByNode.has(fn.id)) continue
      nodes.push(fn)
    }
    // エッジ: 端点を章カードへ写像し、章の内部エッジは落とす(重複もまとめる)
    const rep = (id: string): string => {
      const gid = groupByNode.get(id)
      return gid ? `chapter:${gid}` : id
    }
    const seen = new Set<string>()
    const edges: Edge[] = []
    for (const e of graphEdges) {
      const source = rep(e.from_node)
      const target = rep(e.to_node)
      if (source === target) continue
      const key = `${source}->${target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        id: key,
        source,
        target,
        interactionWidth: 18,
        style: e.is_canon
          ? { stroke: '#8a8fb8', strokeWidth: 2.5 }
          : { stroke: '#4a4f66', strokeWidth: 1.5, strokeDasharray: '7 5' }
      })
    }
    return { nodes, edges }
  }, [effectiveView, chapterSeq, chapterNodes, flowNodes, graphEdges])

  const displayNodes: AppFlowNode[] =
    effectiveView === 'chapters' && chapterFlow
      ? chapterFlow.nodes
      : visibleIds
        ? flowNodes.filter((n) => visibleIds.has(n.id))
        : flowNodes
  const displayEdges: Edge[] =
    effectiveView === 'chapters' && chapterFlow
      ? chapterFlow.edges
      : visibleIds
        ? flowEdges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
        : flowEdges

  // ビューを切り替えたらノード構成が大きく変わるので、全体が見える位置へ
  useEffect(() => {
    const timer = setTimeout(() => void reactFlow.fitView({ duration: 300, maxZoom: 1 }), 60)
    return () => clearTimeout(timer)
  }, [effectiveView, chapterView, reactFlow])

  // ---- 章の操作 -------------------------------------------------------
  // Electron は window.prompt を使えない(呼ぶと例外)ので、名前の入力は
  // 自前のモーダル(namePrompt)で行う

  const [namePrompt, setNamePrompt] = useState<{
    label: string
    value: string
    onSubmit: (value: string) => void
  } | null>(null)

  // ---- はじまり / 結末の操作(docs/design/endings.md) ----------------

  const makeEndingCanon = async (endingId: string): Promise<void> => {
    try {
      await api.makeCanon(endingId)
      await reload()
    } catch (e) {
      setGenStatus(`正史を切り替えられません: ${String(e)}`)
    }
  }

  const createEndingAt = async (nodeId: string): Promise<void> => {
    try {
      await api.createEnding(nodeId)
      await reload()
    } catch (e) {
      setGenStatus(`結末を作れません: ${String(e)}`)
    }
  }

  // 何もないところに浮いた結末を置く(あとでシーンからドラッグしてつなぐ)
  const createFloatingEndingAt = async (at: { x: number; y: number }): Promise<void> => {
    try {
      const node = await api.createFloatingEnding()
      // 結末カードは w-40(160px)なので、その半分ぶん左上へずらして置く
      await api.setNodePosition(node.id, Math.round(at.x - 80), Math.round(at.y - 40))
      await reload()
      setSelectedId(node.id)
      setGenStatus('結末を置きました。シーンの右のハンドルからドラッグしてつなげます')
    } catch (e) {
      setGenStatus(`結末を作れません: ${String(e)}`)
    }
  }

  const renameEnding = (endingId: string): void => {
    const node = graphNodes.find((n) => n.id === endingId)
    setNamePrompt({
      label: '結末の名前(トゥルーエンドなど)',
      value: node?.title || '結末',
      onSubmit: (title) => {
        void (async () => {
          try {
            await api.updateNode(endingId, { title })
            await reload()
          } catch (e) {
            setGenStatus(`名前を変更できません: ${String(e)}`)
          }
        })()
      }
    })
  }

  const deleteEnding = async (endingId: string): Promise<void> => {
    if (!window.confirm('この結末を削除しますか?')) return
    try {
      await api.deleteNode(endingId)
      await reload()
    } catch (e) {
      setGenStatus(`削除できません: ${String(e)}`)
    }
  }

  const createChapter = (targets: string[]): void => {
    setNamePrompt({
      label: '章の名前',
      value: `第${groups.length + 1}章`,
      onSubmit: (title) => {
        void (async () => {
          try {
            await api.createGroup(title, targets)
            await reload()
            setChapterView('chapters') // 作った章がすぐ見えるように章ビューへ
          } catch (e) {
            setGenStatus(`章にできません: ${String(e)}`)
          }
        })()
      }
    })
  }

  const removeFromChapter = async (nodeId: string): Promise<void> => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node?.group_id) return
    try {
      await api.removeNodeFromGroup(node.group_id, nodeId)
      await reload()
    } catch (e) {
      setGenStatus(`章から外せません: ${String(e)}`)
    }
  }

  const renameChapter = (group: Group): void => {
    setNamePrompt({
      label: '章の名前を変更',
      value: group.title,
      onSubmit: (title) => {
        if (title === group.title) return
        void (async () => {
          try {
            await api.updateGroup(group.id, { title })
            await reload()
          } catch (e) {
            setGenStatus(`名前を変更できません: ${String(e)}`)
          }
        })()
      }
    })
  }

  /** 章を並べ替える。swapWith(入れ替える相手の章)を渡すと**カードの位置も入れ替える**。
   *
   * どちらの章もまだ動かしていない(位置が導出のまま)なら、並びが変われば導出位置も
   * 一緒に入れ替わるので何もしない。手で置いた章が絡むときだけ座標を書き換える。
   */
  const moveChapter = async (
    groupId: string,
    after: string | null,
    swapWith?: string
  ): Promise<void> => {
    try {
      const posOf = (id: string): { x: number; y: number } | undefined =>
        chapterNodes.find((n) => n.id === `chapter:${id}`)?.position
      const pinned = (id: string): boolean => {
        const g = groups.find((x) => x.id === id)
        return g?.pos_x != null && g?.pos_y != null
      }
      const mine = swapWith ? posOf(groupId) : undefined
      const theirs = swapWith ? posOf(swapWith) : undefined
      await api.moveGroup(groupId, after)
      if (swapWith && mine && theirs && (pinned(groupId) || pinned(swapWith))) {
        await Promise.all([
          api.setGroupPosition(groupId, Math.round(theirs.x), Math.round(theirs.y)),
          api.setGroupPosition(swapWith, Math.round(mine.x), Math.round(mine.y))
        ])
      }
    } catch (e) {
      setGenStatus(`章を移動できません: ${String(e)}`)
    } finally {
      await reload()
    }
  }

  const dissolveChapter = async (group: Group): Promise<void> => {
    if (!window.confirm(`「${group.title}」の章を解除しますか?(シーンはそのまま残ります)`)) return
    try {
      await api.deleteGroup(group.id)
      setChapterView('chapters')
      await reload()
    } catch (e) {
      setGenStatus(`章を解除できません: ${String(e)}`)
    }
  }

  const selectedNode = graphNodes.find((n) => n.id === selectedId) ?? null
  const selectedCount = flowNodes.filter((n) => n.selected).length // ⟲ の対象(2 つ以上で部分整列)
  // インスペクタに章パネルを出す章。シーンを選んでいるときはシーン優先。
  // 章内ビューで何も選んでいないときは、その章のパネルを出しておく
  const chapterForPanel = selectedNode
    ? null
    : (groups.find((g) => g.id === selectedChapterId) ?? focusedGroup)

  /** 新しいシーンを親の右隣に手動配置する(**親が手動配置のときだけ**)。
   *
   * 自動レイアウトの座標は「原点からの深さ」で決まるので、ドラッグで動かした
   * ノードや画面中央に置いた島の子は、そのままだと親から遠く離れた場所
   * (たいてい左)に出てしまう。親が自動配置なら何もしない — 自動レイアウトに
   * 任せたほうが全体が揃うため。
   */
  const placeNextToParent = useCallback(
    async (newNodeId: string, parentId: string | null, extraLanes = 0): Promise<void> => {
      if (!parentId) return
      const parent = reactFlow.getNode(parentId) as BeatFlowNode | undefined
      if (!parent || parent.data.storyNode.pos_x == null || parent.data.storyNode.pos_y == null) return
      const height = parent.measured?.height ?? FALLBACK_NODE_HEIGHT
      // 既にいる子の数だけ下のレーンへ(自動レイアウトと同じ考え方。重ならないように)
      const siblings = reactFlow
        .getEdges()
        .filter((e) => e.source === parentId && e.target !== newNodeId).length
      await api.setNodePosition(
        newNodeId,
        Math.round(parent.position.x + COLUMN_GAP_X),
        Math.round(parent.position.y + (siblings + extraLanes) * (height + LANE_GAP_Y))
      )
    },
    [reactFlow]
  )

  const handleAddBeat = async (): Promise<void> => {
    try {
      // 実際に親になるノード(未選択なら正史の末尾に付く)
      const parentId = selectedId ?? canonPath[canonPath.length - 1]?.id ?? null
      const node = await api.createNode({
        beat: '(ここに出来事の仕様を書く)',
        cast: [],
        parent_id: selectedId ?? undefined
      })
      await placeNextToParent(node.id, parentId)
      await reload()
      setSelectedId(node.id)
      setInspectorTab('beat')
    } catch (e) {
      setGenStatus(`シーンを追加できません: ${String(e)}`)
    }
  }

  // どこにも繋がない独立シーン。自動レイアウトの対象外にしたいので、
  // 手動配置として置く(島を作り置きするための入り口)。
  // at を渡すとその位置(キャンバス座標)、省略時は画面の中央
  const handleAddDetached = async (at?: { x: number; y: number }): Promise<void> => {
    try {
      const node = await api.createNode({
        beat: '(ここに出来事の仕様を書く)',
        cast: [],
        detached: true
      })
      const rect = canvasRef.current?.getBoundingClientRect()
      const center =
        at ??
        (rect
          ? reactFlow.screenToFlowPosition({
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2
            })
          : null)
      if (center) {
        // カード幅 288 / 高さの目安 160 の分だけ左上にずらして置く
        await api.setNodePosition(node.id, Math.round(center.x - 144), Math.round(center.y - 80))
      }
      await reload()
      setSelectedId(node.id)
      setInspectorTab('beat')
    } catch (e) {
      setGenStatus(`シーンを追加できません: ${String(e)}`)
    }
  }

  const handleInsertAfter = async (): Promise<void> => {
    if (!selectedId) return
    try {
      const node = await api.insertNodeAfter(selectedId, {
        beat: '(ここに出来事の仕様を書く)',
        cast: []
      })
      // 割り込みなので、元の後続シーンが居る右隣とは重ならないよう 1 レーン下に置く
      // (手動配置の領域では下流を自動で押し出せないため、位置の調整は作者に任せる)
      await placeNextToParent(node.id, selectedId, 1)
      await reload()
      setSelectedId(node.id)
      setInspectorTab('beat')
    } catch (e) {
      setGenStatus(`シーンを割り込ませられません: ${String(e)}`)
    }
  }

  // 生成もキューに積む(連続して指示を出しても取りこぼさない)。
  // 指示文は積んだ時点のものを使うので、入力欄はすぐ空にする
  const handleGenerate = (parentId: string | null): void => {
    const promptText = instruction.trim() || null
    // 生成されるノードはまだ存在しないので、続きを書く元のノードを光らせる
    const originId = parentId ?? (canonPath.length > 0 ? canonPath[canonPath.length - 1].id : null)
    setInstruction('')
    const taskId = enqueueTask({
      label: parentId ? '分岐生成' : 'シーン生成',
      detail: promptText ?? '(指示なし)',
      runner: async ({ update, signal }) => {
        // 中止ボタンは「実行中」の生成を止める。最後に積んだ ID ではなく、
        // runner が動き出したここで記録する(複数積んだときの誤爆よけ)
        genTaskIdRef.current = taskId
        setGenerating(true)
        setGenStatus('LLM 準備中…(初回はモデルロードに時間がかかります)')
        markNodeBusy(originId, true)
        try {
          await generateBeatStream(
            promptText,
            (e) => {
              if (e.stage === 'generating') {
                setGenStatus(`シーン生成中…(${e.attempt} 回目)`)
                update({ detail: `生成中(${e.attempt} 回目)` })
              } else if (e.stage === 'validating') {
                setGenStatus('検証中…')
                update({ detail: '検証中…' })
              } else if (e.stage === 'retry') setGenStatus(`検証 NG、リトライ中…(${(e.errors ?? []).join(' / ')})`)
              else if (e.error) setGenStatus(`エラー: ${e.error}`)
              else if (e.done && e.node) {
                setGenStatus(
                  e.validation && e.validation.length > 0 ? `警告付きで採用: ${e.validation.join(' / ')}` : null
                )
                const newId = e.node.id
                void placeNextToParent(newId, originId)
                  .catch(() => undefined)
                  .then(() => {
                    // reload はこの runner を積んだ時点のインスタンスを握るため、
                    // 再マウント後も届くモジュールレベルの通知で反映する
                    notifyGraphChanged()
                    setSelectedId(newId)
                    setInspectorTab('beat')
                  })
              }
            },
            parentId,
            signal
          )
        } catch (err) {
          setGenStatus(isAbortError(err) ? 'キャンセルしました' : String(err))
        } finally {
          markNodeBusy(originId, false)
          setGenerating(false)
        }
      }
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={rowRef} className="flex min-h-0 flex-1">
        {/* ノードエリア + 相談チャット(インスペクタに被らないよう左カラム内に収める) */}
        <div ref={canvasColumnRef} className="flex min-w-0 flex-1 flex-col">
        <main ref={canvasRef} className="relative min-h-0 flex-1" style={{ background: 'var(--bg-canvas)' }}>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            // 既定の Backspace 削除は API を通さず画面だけ消えてしまうため無効化し、
            // 削除は Delete キー(下の keydown ハンドラ)に集約する
            deleteKeyCode={null}
            // 矢印キーはシーン間の移動に使う。React Flow の既定(フォーカス中の
            // ノードを矢印で動かす a11y 操作)と衝突するので明示的に切る
            disableKeyboardA11y
            onNodesChange={handleNodesChange}
            // ノードを選んだらエッジ選択は解く(残すと Delete がエッジ切断に化ける)
            onNodeClick={() => setSelectedEdgeId(null)}
            // 章ノードのダブルクリックで章の中へ(章ビューのドリルダウン)
            onNodeDoubleClick={(_, node) => {
              if (node.type === 'chapterNode') setChapterView((node.data as ChapterNodeData).group.id)
            }}
            onSelectionChange={({ nodes }) => {
              if (nodes.length > 0) setSelectedEdgeId(null)
              const chapter = nodes.find((n) => n.type === 'chapterNode')
              const beats = nodes.filter((n) => n.type !== 'chapterNode')
              // 章ノードの選択はインスペクタの章パネルへ。シーン選択・選択解除で閉じる
              if (chapter) setSelectedChapterId((chapter.data as ChapterNodeData).group.id)
              else setSelectedChapterId(null)
              setSelectedId((prev) => {
                if (beats.length === 0) return null
                // 複数選択中は先頭をインスペクタ対象にする
                return beats.some((n) => n.id === prev) ? prev : beats[0].id
              })
            }}
            onConnect={(connection) => void handleConnect(connection)}
            isValidConnection={(connection) => isValidConnection(connection)}
            // エッジ選択は自前で持つ(onEdgesChange を渡していないため)
            onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
            onEdgeDoubleClick={(_, edge) => void detachEdge(edge.id)}
            onPaneClick={() => {
              setSelectedEdgeId(null)
              setMenu(null)
            }}
            // 右クリック: 選択中のノード群(右クリックしたノードを含む)に対する一括操作
            onNodeContextMenu={(event, node) => {
              event.preventDefault()
              if (node.type === 'chapterNode') {
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  targets: [],
                  chapter: (node.data as ChapterNodeData).group.id
                })
                return
              }
              const kind = (node.data as BeatNodeData).storyNode.kind
              if (kind === 'start') return // はじまりに操作は無い
              if (kind === 'ending') {
                setMenu({ x: event.clientX, y: event.clientY, targets: [node.id], ending: true })
                return
              }
              // マーカーは一括操作の対象にしない
              const selected = flowNodes
                .filter((n) => n.selected && !n.data.storyNode.kind)
                .map((n) => n.id)
              const targets = selected.includes(node.id) ? selected : [node.id]
              setMenu({ x: event.clientX, y: event.clientY, targets })
            }}
            onSelectionContextMenu={(event, nodes) => {
              event.preventDefault()
              // 章ノード(導出表示)とはじまり / 結末マーカーは一括操作の対象にしない
              const targets = nodes
                .filter((n) => n.type !== 'chapterNode' && !(n.data as BeatNodeData).storyNode?.kind)
                .map((n) => n.id)
              if (targets.length === 0) return
              setMenu({ x: event.clientX, y: event.clientY, targets })
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault()
              // 何もないところの右クリック: 追加系のメニュー(置く場所はこの位置)
              const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
              setMenu({ x: event.clientX, y: event.clientY, targets: [], pane: flow })
            }}
            onNodeDragStop={(_, __, draggedNodes) => {
              // 章カードのドラッグ = 置いた場所にそのまま置く(groups.pos_x/pos_y に保存)。
              // 章の並べ替えは右クリックの「← 前へ / → 後ろへ」で行う(ドラッグと
              // 兼ねると位置が導出に戻ってしまうため。docs/design/chapters.md §6)
              const chapters = draggedNodes.filter((n) => n.type === 'chapterNode')
              for (const card of chapters) {
                const groupId = (card.data as ChapterNodeData).group.id
                const x = Math.round(card.position.x)
                const y = Math.round(card.position.y)
                // 再構築で導出位置へ戻らないよう groups にも先に反映しておく(楽観更新)
                setGroups((prev) =>
                  prev.map((g) => (g.id === groupId ? { ...g, pos_x: x, pos_y: y } : g))
                )
                void api
                  .setGroupPosition(groupId, x, y)
                  .catch((e) => setGenStatus(`位置を保存できません: ${String(e)}`))
              }
              const beats = draggedNodes.filter((n) => n.type !== 'chapterNode')
              if (beats.length === 0) return
              // busyNodeIds の変化などでノード配列が再構築されても座標が戻らないよう、
              // サーバー由来の graphNodes にも先に反映しておく(楽観更新)
              const moved = new Map(beats.map((n) => [n.id, n.position]))
              setGraphNodes((prev) =>
                prev.map((n) => {
                  const p = moved.get(n.id)
                  return p ? { ...n, pos_x: p.x, pos_y: p.y } : n
                })
              )
              for (const dragged of beats) {
                void api
                  .setNodePosition(dragged.id, dragged.position.x, dragged.position.y)
                  .catch((e) => setGenStatus(`位置を保存できません: ${String(e)}`))
              }
            }}
            minZoom={0.1}
            maxZoom={2}
            // ダブルクリックズームは章カードの「開く」と競合するので切る
            zoomOnDoubleClick={false}
            fitView
            panOnDrag={[1]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            // ハンドルのドラッグで親子を繋げる(妥当性は isValidConnection で判定)。
            // 章カードのピンは章の先頭 / 末尾シーンに読み替える(resolveEndpoint)
            nodesConnectable
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1.4} color="#394154" />
            {minimapVisible && <MiniMap pannable zoomable nodeColor={() => '#2e3140'} />}
            <Panel position="top-left">
              {/* 畳んでいるときは幅を詰める(パネルの領域はキャンバスのクリックを奪うため) */}
              <div className={`flex flex-col gap-2 ${genPanelOpen || genStatus ? 'w-72' : 'w-fit'}`}>
                {/* 章内ビューのパンくず(章名 / 名前の変更 / 解除) */}
                {effectiveView === 'focused' && focusedGroup && (
                  <div
                    className="flex w-fit items-center gap-1.5 rounded-xl border px-2 py-1.5 text-[12px] shadow-lg shadow-black/30"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
                  >
                    <button
                      onClick={() => setChapterView('chapters')}
                      className="rounded-md px-1.5 py-0.5 hover:bg-[var(--accent-soft)]"
                      style={{ color: 'var(--text-dim)' }}
                      title="章ビューへ戻る"
                    >
                      ← 章一覧
                    </button>
                    <span className="max-w-56 truncate font-medium" style={{ color: 'var(--text)' }}>
                      {focusedGroup.on_canon ? `第${groups.indexOf(focusedGroup) + 1}章` : '別ルートの章'}{' '}
                      {focusedGroup.title}
                    </span>
                    <button
                      onClick={() => void renameChapter(focusedGroup)}
                      className="rounded-md px-1 py-0.5 hover:bg-[var(--accent-soft)]"
                      style={{ color: 'var(--text-faint)' }}
                      title="章の名前を変更"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => void dissolveChapter(focusedGroup)}
                      className="rounded-md px-1 py-0.5 hover:bg-[var(--accent-soft)]"
                      style={{ color: 'var(--text-faint)' }}
                      title="章を解除する(シーンは残る)"
                    >
                      解散
                    </button>
                  </div>
                )}
                {/* ツールバー: 補助操作はアイコンだけにして面積を詰める */}
                <div className="flex gap-1.5">
                  {/* 章がある間だけ、章ビュー ⇄ 全シーンの切替を出す */}
                  {groups.length > 0 && effectiveView !== 'focused' && (
                    <button
                      onClick={() => setChapterView((v) => (v === 'chapters' ? 'flat' : 'chapters'))}
                      className="rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                      style={{
                        background: effectiveView === 'chapters' ? 'var(--accent-soft)' : 'var(--bg-card)',
                        borderColor: effectiveView === 'chapters' ? 'var(--accent-border)' : 'var(--border-strong)',
                        color: 'var(--text-dim)'
                      }}
                      title={
                        effectiveView === 'chapters'
                          ? '全シーンのフラット表示に切り替える'
                          : '章ビュー(章単位の俯瞰)に切り替える'
                      }
                    >
                      {effectiveView === 'chapters' ? '⊞ 全シーン' : '📖 章ビュー'}
                    </button>
                  )}
                  <button
                    onClick={() => void handleAddBeat()}
                    className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white shadow-lg shadow-black/30"
                    style={{ background: 'var(--accent)' }}
                    title={selectedId ? '選択ノードの子としてシーンを追加' : '正史の末尾にシーンを追加'}
                  >
                    + シーン
                  </button>
                  <button
                    onClick={() => void handleAddDetached()}
                    className="rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    title="どこにも繋がらないシーンを画面の中央に追加(あとでハンドルのドラッグで繋げます)"
                  >
                    ⊕
                  </button>
                  {selectedId && (
                    <button
                      onClick={() => void handleInsertAfter()}
                      className="rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                      title="選択ノードと後続シーンの間に新しいシーンを割り込ませる"
                    >
                      ⤵
                    </button>
                  )}
                  <button
                    onClick={() => void realignLayout()}
                    className="rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    title={
                      selectedCount >= 2
                        ? `選択中の ${selectedCount} シーンだけを整列する`
                        : '手動配置をリセットして全体を自動レイアウトに戻す(複数選択中なら選択分だけ整列)'
                    }
                  >
                    ⟲
                  </button>
                  <button
                    onClick={() => setGenPanelOpen((v) => !v)}
                    className={`rounded-lg border px-2.5 py-1.5 text-[13px] font-medium shadow-lg shadow-black/30 ${
                      generating ? 'node-generating-border' : ''
                    }`}
                    style={{
                      background: genPanelOpen ? 'var(--accent-soft)' : 'var(--bg-card)',
                      borderColor: genPanelOpen ? 'var(--accent-border)' : 'var(--border-strong)',
                      color: 'var(--accent)'
                    }}
                    title={genPanelOpen ? '生成パネルを閉じる' : 'LLM でシーンを生成する'}
                  >
                    ▶ 生成 {genPanelOpen ? '▴' : '▾'}
                  </button>
                </div>
                {genPanelOpen && (
                  <div
                    className={`rounded-2xl border p-3 shadow-lg shadow-black/30 ${generating ? 'node-generating-border' : ''}`}
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
                  >
                    <textarea
                      rows={2}
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="生成の指示(任意)"
                      className="mb-2 w-full rounded-lg border px-2.5 py-1.5 text-[12px] outline-none"
                      style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                    />
                    {/* 実行中でも押せる(キューに積まれる) */}
                    <div className="flex flex-col gap-1.5">
                      <button
                        onClick={() => {
                          setGenPanelOpen(false) // 生成中はキャンバスを広く使えるよう畳む
                          handleGenerate(null)
                        }}
                        className="w-full rounded-lg px-3 py-1.5 text-[13px] font-medium text-white"
                        style={{ background: 'var(--accent)' }}
                      >
                        ▶ 次のシーンを生成
                      </button>
                      <button
                        onClick={() => {
                          setGenPanelOpen(false)
                          handleGenerate(selectedId)
                        }}
                        disabled={!selectedId}
                        className="w-full rounded-lg border px-3 py-1.5 text-[13px] font-medium disabled:opacity-40"
                        style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
                        title="選択ノードから what-if 分岐を draft として生成"
                      >
                        ⑂ 選択ノードから分岐を生成
                      </button>
                      {generating && (
                        <button
                          onClick={() => genTaskIdRef.current && cancelTask(genTaskIdRef.current)}
                          className="w-full rounded-lg border px-3 py-1.5 text-[13px] font-medium"
                          style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                        >
                          ■ 実行中の生成を中止
                        </button>
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
                )}
                {/* 再抽出・清書の進捗はステータスバーに集約したので、ここには出さない */}
                {/* パネルを畳んでいる間の進捗表示。中止もここから行える */}
                {!genPanelOpen && genStatus && (
                  <div
                    className={`flex items-start gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] leading-relaxed shadow-lg shadow-black/30 ${
                      generating ? 'node-generating-border' : ''
                    }`}
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                  >
                    <span className="min-w-0 flex-1">
                      {genStatus}
                      {generating && (
                        <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                          ({genElapsed}s)
                        </span>
                      )}
                    </span>
                    {generating ? (
                      <button
                        onClick={() => genTaskIdRef.current && cancelTask(genTaskIdRef.current)}
                        className="shrink-0 rounded-md border px-1.5"
                        style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                        title="生成を中止"
                      >
                        ■
                      </button>
                    ) : (
                      <button
                        onClick={() => setGenStatus(null)}
                        className="shrink-0 px-1"
                        style={{ color: 'var(--text-faint)' }}
                        title="表示を消す"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
              </div>
            </Panel>
            {/* 相談チャットのトグルは左下(生成 UI と離し、ミニマップの反対側に置く) */}
            <Panel position="bottom-left">
              <button
                onClick={toggleChat}
                className="flex h-10 w-10 items-center justify-center rounded-full border shadow-lg shadow-black/30"
                style={{
                  background: chatOpen ? 'var(--accent-soft)' : 'var(--bg-card)',
                  borderColor: chatOpen ? 'var(--accent-border)' : 'var(--border-strong)',
                  color: chatOpen ? 'var(--accent)' : 'var(--text-dim)'
                }}
                title={chatOpen ? '相談チャットを閉じる' : '相談チャットを下段に開く'}
              >
                <Icon name="chat" size={18} />
              </button>
            </Panel>
            {graphNodes.length === 0 && (
              <Panel position="top-center">
                <div
                  className="mt-24 rounded-2xl border px-6 py-4 text-[13px]"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                >
                  「+ シーン」または「▶ 生成」で物語を始めてください
                </div>
              </Panel>
            )}
          </ReactFlow>
          {/* 右クリックメニュー: 選択したシーンへの一括操作 */}
          {menu && (
            <div
              className="fixed z-50 w-60 overflow-hidden rounded-xl border py-1 text-[12px] shadow-xl shadow-black/50"
              style={{
                left: menu.x,
                top: menu.y,
                background: 'var(--bg-card)',
                borderColor: 'var(--border-strong)'
              }}
            >
              <div className="px-3 py-1 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                {menu.pane
                  ? 'ここに追加'
                  : menu.chapter
                    ? (groups.find((g) => g.id === menu.chapter)?.on_canon
                        ? `第${groups.findIndex((g) => g.id === menu.chapter) + 1}章`
                        : '別ルートの章')
                    : menu.ending
                      ? '結末'
                      : `${menu.targets.length} シーンを選択中`}
              </div>
              {(
                menu.pane
                  ? [
                      {
                        label: '＋ シーンを追加',
                        hint: selectedNode ? '選択中のシーンの子として追加' : '正史の末尾(結末の手前)に追加',
                        run: () => void handleAddBeat()
                      },
                      {
                        label: '⊕ 独立シーン(島)をここに',
                        hint: 'どこにも繋がらないシーン。あとでドラッグして繋げます',
                        run: () => void handleAddDetached(menu.pane)
                      },
                      {
                        label: '🏁 結末をここに置く',
                        hint: 'シーンの右のハンドルからドラッグしてつなげます',
                        run: () => void createFloatingEndingAt(menu.pane!)
                      }
                    ]
                  : menu.chapter
                  ? ((): Array<{ label: string; hint: string; disabled?: boolean; run: () => void }> => {
                      const group = groups.find((g) => g.id === menu.chapter)
                      if (!group) return []
                      // 並べ替えは正史ルート上の章同士でだけ意味を持つ
                      const canonGroups = groups.filter((g) => g.on_canon)
                      const ci = canonGroups.findIndex((g) => g.id === group.id)
                      return [
                        {
                          label: '章の中を開く',
                          hint: 'ダブルクリックと同じ',
                          run: () => setChapterView(group.id)
                        },
                        ...(group.on_canon
                          ? [
                              {
                                label: '← 前へ移動',
                                hint: '一つ前の章と入れ替える(カードの位置も入れ替わります)',
                                disabled: ci <= 0,
                                run: () =>
                                  void moveChapter(
                                    group.id,
                                    ci <= 1 ? null : canonGroups[ci - 2].id,
                                    canonGroups[ci - 1]?.id
                                  )
                              },
                              {
                                label: '→ 後ろへ移動',
                                hint: '一つ後ろの章と入れ替える(カードの位置も入れ替わります)',
                                disabled: ci >= canonGroups.length - 1,
                                run: () =>
                                  void moveChapter(
                                    group.id,
                                    canonGroups[ci + 1]?.id ?? null,
                                    canonGroups[ci + 1]?.id
                                  )
                              }
                            ]
                          : []),
                        {
                          label: '名前を変更',
                          hint: '章のタイトル',
                          run: () => renameChapter(group)
                        },
                        {
                          label: '章を解除',
                          hint: 'まとまりをやめる(シーンは残る)',
                          run: () => void dissolveChapter(group)
                        }
                      ]
                    })()
                  : menu.ending
                  ? [
                      {
                        label: '🏁 この結末にする',
                        hint: 'ここまでの道を正史にする',
                        run: () => void makeEndingCanon(menu.targets[0])
                      },
                      {
                        label: '名前を変更',
                        hint: '「トゥルーエンド」など',
                        run: () => renameEnding(menu.targets[0])
                      },
                      {
                        label: '削除',
                        hint: '結末の候補を消す(最後の 1 つは消せない)',
                        run: () => void deleteEnding(menu.targets[0])
                      }
                    ]
                  : ([
                  // 章にまとめる: 未分類のシーンだけを選んでいるときに出す(重複所属は不可)
                  ...(menu.targets.every((t) => !graphNodes.find((n) => n.id === t)?.group_id)
                    ? [
                        {
                          label: '📖 章にまとめる',
                          hint: '一続きにつながったシーンを章にする(島・分岐でも可)',
                          run: () => void createChapter(menu.targets)
                        }
                      ]
                    : []),
                  // 結末を作る: 単一シーンの右クリックで
                  ...(menu.targets.length === 1
                    ? [
                        {
                          label: '🏁 ここに結末を作る',
                          hint: 'このシーンの先に新しい結末(正史がここまでになる)',
                          run: () => void createEndingAt(menu.targets[0])
                        }
                      ]
                    : []),
                  ...(menu.targets.length === 1 && graphNodes.find((n) => n.id === menu.targets[0])?.group_id
                    ? [
                        {
                          label: '章から外す',
                          hint: '章の端(先頭・末尾)のシーンだけ外せます',
                          run: () => void removeFromChapter(menu.targets[0])
                        }
                      ]
                    : []),
                  {
                    label: '整合を取る(LLM なし)',
                    hint: '重複した登場イベントを掃除して検証',
                    run: () => void normalizeNodes(menu.targets)
                  },
                  {
                    label: 'イベントを作り直す(LLM)',
                    hint: '選択したシーンだけ(親から順に逐次)',
                    run: () => void runReextractNodes(menu.targets, false)
                  },
                  {
                    label: 'イベントを作り直す(この先も / LLM)',
                    hint: '選択したシーンと、その下流すべて',
                    run: () => void runReextractNodes(menu.targets, true)
                  },
                  {
                    label: `清書(未清書のみ)`,
                    hint: `${renderStyle.preset?.name ?? '未設定'}${
                      renderStyle.povChar ? ` / POV: ${nameOfChar(renderStyle.povChar)}` : ''
                    }`,
                    disabled: !renderStyle.presetId,
                    run: () => void runRenderNodes(menu.targets, true)
                  },
                  {
                    label: '清書し直す(上書き)',
                    hint: '清書済みのシーンも作り直す',
                    disabled: !renderStyle.presetId,
                    run: () => void runRenderNodes(menu.targets, false)
                  },
                  {
                    label: '清書(この先も / 未清書のみ)',
                    hint: '選択したシーンと下流の、未清書か要更新のもの',
                    disabled: !renderStyle.presetId,
                    run: () => void runRenderNodes(menu.targets, true, true)
                  },
                  {
                    label: '清書し直す(この先も / 上書き)',
                    hint: '選択したシーンと、その下流すべて',
                    disabled: !renderStyle.presetId,
                    run: () => void runRenderNodes(menu.targets, false, true)
                  },
                  {
                    label: 'まとめて切り離す',
                    hint: '親エッジを切って島にする',
                    run: () => void detachNodes(menu.targets)
                  },
                  {
                    label: 'まとめて削除',
                    hint: '後続シーンは前のシーンに繋がる',
                    run: () => void deleteNodes(menu.targets)
                  }
                ] as Array<{ label: string; hint: string; disabled?: boolean; run: () => void }>)
              ).map((item) => (
                <button
                  key={item.label}
                  onClick={() => {
                    setMenu(null)
                    item.run()
                  }}
                  disabled={item.disabled ?? false}
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--accent-soft)] disabled:opacity-40"
                  style={{ color: 'var(--text-dim)' }}
                >
                  <span style={{ color: 'var(--text)' }}>{item.label}</span>
                  <br />
                  <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {item.hint}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* 名前の入力モーダル(章の作成・名前変更。Electron では window.prompt が使えない) */}
          {namePrompt && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center"
              style={{ background: 'rgba(0,0,0,0.55)' }}
              onClick={() => setNamePrompt(null)}
            >
              <div
                className="w-[360px] max-w-[92vw] rounded-2xl border p-4"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="mb-2 text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                  {namePrompt.label}
                </h3>
                <input
                  autoFocus
                  value={namePrompt.value}
                  onChange={(e) => setNamePrompt((p) => (p ? { ...p, value: e.target.value } : p))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      const value = namePrompt.value.trim()
                      if (!value) return
                      setNamePrompt(null)
                      namePrompt.onSubmit(value)
                    }
                    if (e.key === 'Escape') setNamePrompt(null)
                  }}
                  className="w-full rounded-lg border px-2 py-1.5 text-[13px] outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--accent-border)', color: 'var(--text)' }}
                />
                <div className="mt-3 flex justify-end gap-2 text-[12px]">
                  <button onClick={() => setNamePrompt(null)} style={{ color: 'var(--text-faint)' }}>
                    取消
                  </button>
                  <button
                    onClick={() => {
                      const value = namePrompt.value.trim()
                      if (!value) return
                      setNamePrompt(null)
                      namePrompt.onSubmit(value)
                    }}
                    disabled={!namePrompt.value.trim()}
                    className="rounded-md px-3 py-1 font-medium text-white disabled:opacity-40"
                    style={{ background: 'var(--accent)' }}
                  >
                    OK
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
        {chatOpen && (
          <>
            {/* 上下の分割線(インスペクタの分割線と同じ見た目・当たり判定) */}
            <div
              className="relative h-px shrink-0 cursor-row-resize transition-colors hover:bg-[var(--accent-border)]"
              style={{ background: 'var(--border)' }}
              title="ドラッグで高さを変更"
            >
              <div
                onPointerDown={beginChatResize}
                className="absolute inset-x-0 z-10 cursor-row-resize"
                style={{ top: -3, bottom: -3 }}
              />
            </div>
            <div className="min-h-0 shrink-0" style={{ height: chatHeight }}>
              <ChatDrawer
                open
                onClose={toggleChat}
                selectedId={selectedId}
                canonTailId={canonPath.length > 0 ? canonPath[canonPath.length - 1].id : null}
                nodesById={Object.fromEntries(graphNodes.map((n) => [n.id, n]))}
                characters={characters}
                onGraphChanged={() => void reload()}
                dynamicSuggestions={chatDynamicSuggestions}
              />
            </div>
          </>
        )}
        </div>
        {/* リサイズハンドル: 線はレイアウト実体の 1px、当たり判定だけ左右 3px はみ出させる */}
        <div
          className="relative w-px shrink-0 cursor-col-resize transition-colors hover:bg-[var(--accent-border)]"
          style={{ background: 'var(--border)' }}
          title="ドラッグで幅を変更"
        >
          <div
            onPointerDown={beginInspectorResize}
            className="absolute inset-y-0 z-10 cursor-col-resize"
            style={{ left: -3, right: -3 }}
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
                { id: 'render', label: '清書' },
                { id: 'char', label: 'キャラ' },
                { id: 'graph', label: '関係図' },
                { id: 'facts', label: '事実' }
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
            ) : inspectorTab === 'facts' ? (
              <FactTimeline
                path={pathToSelected ?? canonPath}
                characters={characters}
                selectedNodeId={selectedId}
                onSelectNode={(nodeId) => setSelectedId(nodeId)}
              />
            ) : chapterForPanel ? (
              <ChapterTab
                group={chapterForPanel}
                number={groups.indexOf(chapterForPanel) + 1}
                nodes={graphNodes}
                characters={characters}
                onSelectScene={(nodeId) => {
                  // 章ビューから選んだ場合は章の中に入ってから選択する
                  if (effectiveView === 'chapters') setChapterView(chapterForPanel.id)
                  setSelectedId(nodeId)
                }}
                onChanged={() => void reload()}
                onRename={() => void renameChapter(chapterForPanel)}
                onDissolve={() => void dissolveChapter(chapterForPanel)}
              />
            ) : selectedNode?.kind ? (
              // はじまり / 結末マーカーの簡易パネル
              <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-dim)' }}>
                <div className="text-[28px]">{selectedNode.kind === 'ending' ? '🏁' : '📖'}</div>
                <div className="mt-1.5 text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
                  {selectedNode.title || (selectedNode.kind === 'ending' ? '結末' : 'はじまり')}
                </div>
                <div className="mt-1.5" style={{ color: 'var(--text-faint)' }}>
                  {selectedNode.kind === 'ending'
                    ? selectedNode.status === 'canon'
                      ? 'アクティブな結末。ここから根へさかのぼった道が正史です'
                      : '結末の候補(別のルート)'
                    : '物語のはじまり。最初のシーンはこの子としてつながります'}
                </div>
                {selectedNode.kind === 'ending' && (
                  <div className="mt-4 flex flex-col items-center gap-2">
                    {selectedNode.status !== 'canon' && (
                      <button
                        onClick={() => void makeEndingCanon(selectedNode.id)}
                        className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-white"
                        style={{ background: 'var(--accent)' }}
                      >
                        🏁 この結末にする
                      </button>
                    )}
                    <button
                      onClick={() => renameEnding(selectedNode.id)}
                      className="rounded-lg border px-3 py-1 text-[12px]"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    >
                      名前を変更
                    </button>
                  </div>
                )}
              </div>
            ) : selectedNode ? (
              inspectorTab === 'render' ? (
                <RenderTab
                  node={selectedNode}
                  style={renderStyle}
                  isCanon={canonPath.some((n) => n.id === selectedNode.id)}
                  onNodeBusyChange={markNodeBusy}
                  onNodeChanged={() => void reload()}
                />
              ) : inspectorTab === 'beat' ? (
                <BeatTab
                  node={selectedNode}
                  characters={characters}
                  places={places}
                  inheritedPlaceName={inheritedPlaceName}
                  validation={validation}
                  onSaved={() => void reload()}
                  onDeleted={() => {
                    setSelectedId(null)
                    void reload()
                  }}
                  onNodeBusyChange={markNodeBusy}
                />
              ) : (
                <CharTab
                  node={selectedNode}
                  characters={characters}
                  memoryContents={memoryContents}
                  onChanged={() => void reload()}
                  onSelectNode={(nodeId) => setSelectedId(nodeId)}
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

export default function StructureMode({
  settingsVersion = 0,
  onSelectedNodeChange,
  onSelectionCountChange
}: {
  settingsVersion?: number
  /** 選択シーンを親に伝える(鑑賞モードを開いたときにそこへ飛ぶため) */
  onSelectedNodeChange?: (nodeId: string | null) => void
  /** 範囲選択しているシーン数を親に伝える(ステータスバーの表示用) */
  onSelectionCountChange?: (count: number) => void
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <StructureModeInner
        settingsVersion={settingsVersion}
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectionCountChange={onSelectionCountChange}
      />
    </ReactFlowProvider>
  )
}
