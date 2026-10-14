import { createPortal } from 'react-dom'
import { useWorkspace, type ProductionTarget } from '../Workspace'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnNodeDrag
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  api,
  type NodeClipboard,
  type ProductionOperation,
  generateBeatStream,
  isAbortError,
  reextractNodesStream,
  renderStream
} from '../api'
import { showStatusNotice } from '../statusNotice'
import ChatDrawerBase from '../ChatDrawer'
import ContextMenu, { type ContextMenuItem } from '../ContextMenu'
import ProductionChatBase from '../ProductionChat'
import { defaultProductionPolicy } from '../ProductionPolicyPanel'
import type { ProductionPolicy } from '../api'
import FactTimeline from '../FactTimeline'
import CharacterTimeline from '../CharacterTimeline'
import CastChainGraph from '../CastChainGraph'
import CharacterEditor from './CharacterEditor'
import CharAvatar from '../CharAvatar'
import { Icon } from '../icons'
import RelationGraph from '../RelationGraph'
import { useRenderStyle } from '../RenderStyle'
import {
  cancelTask,
  enqueueTask,
  notifyGraphChanged,
  useProductionLocked,
  setNodeBusy,
  subscribeGraphChanged,
  useBusyNodeIds
} from '../tasks'
import { useStableCallback } from '../useStableCallback'
import { ElapsedLabel } from '../ElapsedLabel'
import { backfillThumbs } from '../thumbs'
import type {
  Character,
  GraphEdge,
  Group,
  Place,
  StoryGraph,
  StoryNode
} from '../types'
import { beatDraftCache, deleteBeatDraft, setBeatDraft } from './structure/beatDrafts'
import {
  avoidingOverlap,
  COLUMN_GAP_X,
  FALLBACK_NODE_HEIGHT,
  GRID_SIZE,
  layoutDag,
  shiftDownstreamX,
  snapped
} from './structure/layout'
import {
  chapterCoverNode,
  nodeTypes,
  PAN_ON_DRAG,
  PRO_OPTIONS,
  SNAP_GRID,
  type AppFlowNode,
  type BeatFlowNode,
  type BeatNodeData,
  type ChapterFlowNode,
  type ChapterNodeData
} from './structure/StructureNodes'
import { BeatTab } from './structure/BeatTab'
import { CharTab, type MemorySource } from './structure/CharTab'
import { ChapterTab } from './structure/ChapterTab'
import { RenderTab } from './structure/RenderTab'

// チャット部品は構造モードの再描画(ドラッグ・選択・進捗)に巻き込まない。
// 渡す props は下で useMemo / useStableCallback により参照を保っている
const ChatDrawer = memo(ChatDrawerBase)
const ProductionChat = memo(ProductionChatBase)

// ---- 構造モード本体 --------------------------------------------------

function StructureModeInner({
  settingsVersion,
  focusNodeId,
  onSelectedNodeChange,
  onSelectionCountChange,
  onReaderScopeChange
}: {
  settingsVersion: number
  focusNodeId?: string | null
  onSelectedNodeChange?: (nodeId: string | null) => void
  onSelectionCountChange?: (count: number) => void
  onReaderScopeChange?: (groupId: string | null) => void
}): React.JSX.Element {
  const [minimapVisible, setMinimapVisible] = useState(false) // 既定は非表示(2026-10-14 ユーザー指示)
  const [gridSnap, setGridSnap] = useState(true) // ドラッグを背景のグリッドに合わせる
  const [chatDynamicSuggestions, setChatDynamicSuggestions] = useState(true)
  const [graphNodes, setGraphNodes] = useState<StoryNode[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  // 章の表示状態: 'flat' = 全シーン、'chapters' = 章ビュー、それ以外 = 章 ID(章内ビュー)。
  // 章がひとつも無い間は常に flat(書き始めの体験を変えない)
  const [chapterView, setChapterView] = useState<string>('chapters')
  // キャラクタービュー。フローチャートの上に重ねて出す(docs/plan/plan.md)。
  // null = 出さない、table = 出番表(CharacterTimeline)、chain = 人物の鎖(CastChainGraph)
  const [castView, setCastView] = useState<null | 'table' | 'chain'>(null)
  // 人物の鎖でクリックした人物(詳細欄のキャラタブに出す)。seq は同じ人物の連打でも効かせるため
  const [focusChar, setFocusChar] = useState<{ id: string; seq: number } | null>(null)
  /** キャラクター(鎖のノード・登場人物の行・フローチャートのカードの札)をクリック → 詳細欄を人物専用の表示にする
   *  (プロフィール / 状態 / 関係図 / 事実の履歴。シーンや清書のタブは出さない)。
   *  フローチャートのノードの data にも渡すので、他の state より先に定義しておく */
  // focusNodeOnCanvas は後ろで定義される(React Flow の instance が要る)ので、ref を介して呼ぶ
  const focusNodeOnCanvasRef = useRef<(nodeId: string) => void>(() => undefined)
  const handleSelectChainChar = useCallback((charId: string, sceneId?: string): void => {
    // どのシーンの札を押したかが分かるときは、そのシーンも選ぶ(人物の詳細の「時点」になる)。
    // 詳細欄は人物専用の表示のまま(onNodeClick を通らないので scene には戻らない)
    if (sceneId) focusNodeOnCanvasRef.current(sceneId)
    setLibraryCharId(charId)
    setFocusChar((prev) => ({ id: charId, seq: (prev?.seq ?? 0) + 1 }))
    setInspectorFocus('character')
  }, [])
  // 章ノードを選択中(インスペクタに章パネルを出す)
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [places, setPlaces] = useState<Place[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(focusNodeId ?? null)
  // 開いた直後に寄せるシーン(鑑賞モードで読んでいたシーン)。マウント時の値だけを使う
  // ので、以後の選択の往復(親と同期している)でフォーカスが走り直すことはない
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(focusNodeId ?? null)
  // 初回フォーカスを消化したか。済むまでは自動の全体表示(fitView)を止める
  const focusDoneRef = useRef(!focusNodeId)
  const [inspectorTab, setInspectorTab] = useState<'beat' | 'render' | 'char' | 'graph' | 'facts'>('beat')
  // 詳細欄の対象。scene = 選択中のシーン(章・マーカー)のタブ、character = 人物専用のタブ
  // (人物の鎖でキャラクターや登場人物の行をクリックすると character、シーンを選ぶと scene に戻る)
  const [inspectorFocus, setInspectorFocus] = useState<'scene' | 'character'>('scene')
  const [libraryCharId, setLibraryCharId] = useState<string | null>(null)
  const [charTab, setCharTab] = useState<'profile' | 'state' | 'graph' | 'facts'>('profile')
  const [validation, setValidation] = useState<string[]>([])
  const [instruction, setInstruction] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genStatus, setGenStatus] = useState<string | null>(null)
  const [nodeClipboard, setNodeClipboard] = useState<NodeClipboard | null>(null)
  const pastingNodes = useRef(false)
  const pasteCount = useRef(0)
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
  const productionLocked = useProductionLocked()
  const [productionPolicy, setProductionPolicy] = useState<ProductionPolicy>(defaultProductionPolicy)
  const workspace = useWorkspace()
  const { chatHost, chatOpen, manual: productionManual, setManual: setProductionManual } = workspace
  const productionEditingLocked = productionLocked && !productionManual
  // 制作中に React Flow へ渡す右クリックのハンドラ(メニューを出さず、ブラウザ既定のメニューも出さない)
  const suppressContextMenu = useCallback((event: React.MouseEvent | MouseEvent): void => event.preventDefault(), [])
  const [chatKind, setChatKind] = useState<'consult' | 'production'>('consult')
  const markNodeBusy = setNodeBusy
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem('inspectorOpen') !== '0')
  const [inspectorHeight, setInspectorHeight] = useState(() => {
    const saved = Number(localStorage.getItem('inspectorHeight'))
    return saved >= 220 && saved <= 1200 ? saved : 340
  })
  const rowRef = useRef<HTMLDivElement | null>(null)
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

  // prefetchedGraph: 直前の処理(placeCreatedNode)が取得済みのグラフを使い回す。
  // /graph は全ノード + 全イベント入りで大きいので、シーン作成のたびに 2 回
  // 取り直さない
  const reload = useCallback(async (prefetchedGraph?: StoryGraph): Promise<void> => {
    const [graph, chars, placeList, groupList] = await Promise.all([
      prefetchedGraph ?? api.getGraph(),
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

  // 範囲選択の数をステータスバーへ。構造以外での表示はAppが抑制する。
  const selectionCount = flowNodes.filter((n) => n.selected).length
  useEffect(() => {
    onSelectionCountChange?.(selectionCount)
  }, [selectionCount, onSelectionCountChange])
  useEffect(() => {
    return () => onSelectionCountChange?.(0)
  }, [onSelectionCountChange])

  useEffect(() => {
    if (workspace.mode === 'structure') {
      void reload().catch((e) => setGenStatus(`読み込みに失敗しました: ${String(e)}`))
    }
  }, [reload, workspace.mode])

  // キュー(tasks.ts)の runner は完了時に notifyGraphChanged を呼ぶ。runner の
  // クロージャは積んだ時点のコンポーネントを握るため、マウント中はここで購読して
  // reload する(再マウント後もタスク完了が画面に反映される)
  useEffect(() => subscribeGraphChanged(() => void reload().catch(() => undefined)), [reload])

  // 挿絵のサムネイルを埋める(未生成のものだけ、1 件ずつ)。
  // 生成できたら reload して、カードを原画 / <video> からサムネイルの <img> に切り替える
  useEffect(() => {
    void backfillThumbs(graphNodes).then((created) => {
      if (created) void reload()
    })
  }, [graphNodes, reload])

  // 設定(ミニマップ表示 / 質問候補の自動生成)を読み込む。settingsVersion は
  // 設定ポップアップを閉じたときに変わるので、そこで変更が反映される
  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        setMinimapVisible(s.minimap_visible === '1')
        setGridSnap(s.grid_snap !== '0')
        setChatDynamicSuggestions(s.chat_dynamic_suggestions !== '0')
      })
      .catch(() => undefined)
  }, [settingsVersion])

  // 矢印キーで次々に選択が変わると取得が複数走るので、古い応答は捨てる
  // (捨てないと、後から返ってきた前のシーンの結果が残り続ける)
  const selectedNodeForValidation = useMemo(
    () => (selectedId ? graphNodes.find((n) => n.id === selectedId) ?? null : null),
    [graphNodes, selectedId]
  )
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
    // 依存は選択中のノードそのもの。graphNodes 全体にすると、別ノードの位置の
    // 楽観更新などでも検証(サーバー側で fold)が走り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedNodeForValidation])

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

  // 「次のシーン」の解決(補間生成の対象。docs/design/interpolation.md §3)。
  // 子の選び方はサーバーの next_scene_after / insert_node_after と同じ規則:
  // canon の子 → 同じ章の出口 → 唯一の子。マーカーは読み飛ばし、結末なら null。
  // 表示(ボタンの文言)用の判定で、実際の挿入位置と文脈はサーバー側が決める
  const nextSceneOf = useCallback(
    (nodeId: string): StoryNode | null => {
      const byId = new Map(graphNodes.map((n) => [n.id, n]))
      let cur = byId.get(nodeId)
      const seen = new Set([nodeId])
      while (cur) {
        const children = graphEdges.filter((e) => e.from_node === cur!.id)
        if (children.length === 0) return null
        let edge = children.find((e) => e.is_canon === 1) ?? null
        if (!edge) {
          edge =
            children.find((e) => {
              const child = byId.get(e.to_node)
              return child?.kind === 'chapter_out' && child.group_id === cur!.group_id
            }) ?? null
        }
        if (!edge && children.length === 1) edge = children[0]
        if (!edge) return null // 分岐していてどの間か決められない
        const next = byId.get(edge.to_node)
        if (!next || seen.has(next.id)) return null
        if (!next.kind) return next
        if (next.kind === 'ending') return null
        seen.add(next.id)
        cur = next // 章の入口 / 出口は読み飛ばす
      }
      return null
    },
    [graphNodes, graphEdges]
  )

  // 選択シーンに後続があれば「▶ 間のシーンを生成」(補間)に切り替わる
  const interpolateNext = useMemo(() => {
    if (!selectedId) return null
    const sel = graphNodes.find((n) => n.id === selectedId)
    if (!sel || sel.kind) return null
    return nextSceneOf(selectedId)
  }, [selectedId, graphNodes, nextSceneOf])

  // 選択シーンで location を空欄にしたときに引き継がれる場所(= 親の実効ロケーション)
  const inheritedPlaceName = useMemo(() => {
    if (!selectedId) return null
    const parentId = graphEdges.find((e) => e.to_node === selectedId)?.from_node
    const eff = parentId ? effectiveLocations[parentId] : null
    if (!eff) return null
    return placeMap[eff.placeId]?.name ?? eff.placeId
  }, [selectedId, graphEdges, effectiveLocations, placeMap])

  // 記憶(イベント ID)→ 本文と出どころ。キャラタブの一覧で使う
  const memoryContents = useMemo(() => {
    const map: Record<string, MemorySource> = {}
    for (const node of graphNodes) {
      for (const e of node.events) {
        if (e.type === 'memory_add' || e.type === 'memory_compress') {
          map[e.id] = {
            kind: 'scene',
            content: String(e.payload.content ?? e.payload.summary ?? ''),
            nodeId: node.id,
            title: node.title || '(無題)'
          }
        }
      }
    }
    // 章のまとめ(digest)の記憶。ノードの events には居ないので groups から拾う。
    // これを入れないと、まとめ済みの章より後ろのシーンでイベント ID が並んでしまう
    for (const group of groups) {
      for (const e of group.digest_events ?? []) {
        if (e.type !== 'memory_compress') continue
        map[e.id] = {
          kind: 'digest',
          content: String(e.payload.summary ?? ''),
          // クリックの行き先は章の最後のシーン(まとめはそこまでの記憶なので)
          nodeId: group.route[group.route.length - 1] ?? null,
          title: group.title
        }
      }
    }
    return map
  }, [graphNodes, groups])

  // グラフデータの変化時のみノード配列を再構築。ドラッグ・選択は
  // applyNodeChanges の差分適用に任せる(毎フレーム再構築するとチラつく)
  useEffect(() => {
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const heights: Record<string, number> = {}
      for (const n of prev) {
        if (n.measured?.height) heights[n.id] = n.measured.height
      }
      const connectedIds = new Set(graphEdges.flatMap((edge) => [edge.from_node, edge.to_node]))
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
        const nextPosition = existing?.dragging ? existing.position : position
        const eff = effectiveLocations[n.id]
        const placeName = eff ? (placeMap[eff.placeId]?.name ?? eff.placeId) : undefined
        const busy = busyNodeIds.has(n.id)
        const connected = connectedIds.has(n.id)
        // 中身が同じなら前のノードをそのまま使う(参照を保つ)。1 ノードの編集や
        // busy の切り替えで全カードの data が作り直されると、memo した全カードが
        // 描き直される
        if (existing) {
          const d = existing.data
          const samePlace = eff
            ? d.place?.name === placeName && d.place?.inherited === eff.inherited
            : d.place === undefined
          if (
            d.storyNode === n &&
            d.connected === connected &&
            d.characters === charMap &&
            d.onSelectChar === handleSelectChainChar &&
            d.busy === busy &&
            samePlace &&
            existing.position.x === nextPosition.x &&
            existing.position.y === nextPosition.y
          ) {
            return existing
          }
        }
        return {
          id: n.id,
          type: 'beatNode' as const,
          position: nextPosition,
          selected: existing?.selected ?? false,
          dragging: existing?.dragging,
          // 実測サイズを引き継ぐ。落とすと再構築のたびに heightsSig が 0 に振れて
          // リフローが走り、保存座標のないノードが仮の高さで並べ直されてしまう
          // (整列直後に 1 ノード動かすと全体が巻き戻って見える不具合の原因)
          measured: existing?.measured,
          data: {
            storyNode: n,
            connected,
            characters: charMap,
            place: eff ? { name: placeName as string, inherited: eff.inherited } : undefined,
            busy,
            onSelectChar: handleSelectChainChar
          }
        }
      })
    })
  }, [graphNodes, graphEdges, charMap, placeMap, effectiveLocations, busyNodeIds, handleSelectChainChar])

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

  const deletingNodes = useRef(false)

  // 選択ノードの削除。後続シーンは前のシーンへ繋ぎ直す。
  const deleteNodeById = useCallback(
    async (nodeId: string): Promise<void> => {
      if (deletingNodes.current) return
      const node = graphNodes.find((n) => n.id === nodeId)
      const label = node?.title || '(無題)'
      if (!window.confirm(`シーン「${label}」を削除しますか?(後続シーンは前のシーンに繋がります)`)) return
      deletingNodes.current = true
      try {
        await api.deleteNode(nodeId)
        deleteBeatDraft(nodeId)
        setSelectedId((current) => (current === nodeId ? null : current))
        await reload()
      } catch (e) {
        setGenStatus(`削除できません: ${String(e)}`)
      } finally {
        deletingNodes.current = false
      }
    },
    [graphNodes, reload]
  )

  // ---- エッジの切断 / 接続(島の切り出しと繋ぎ直し) -----------------

  // エッジを切る = 子ノード以下を独立した島にする(ノードは消さない)
  const detachEdge = useCallback(
    async (edgeId: string): Promise<void> => {
      // 章ビューのエッジは端点を章カードへ畳んだ導出表示で、ID は
      // `source->target` の合成キー(graphEdges には無い)。切断は
      // 「繋がり先の実ノードの親エッジを切る」ことなので、繋がり先を
      // 実ノード(章カードなら章の入口)へ読み替える。以前は見つからず
      // 黙って何も起きなかった(章ビューでは章どうしを切り離せなかった)
      let childId = graphEdges.find((e) => e.id === edgeId)?.to_node ?? null
      const arrow = edgeId.indexOf('->')
      if (!childId && arrow >= 0) {
        const targetKey = edgeId.slice(arrow + 2)
        if (targetKey.startsWith('chapter:')) {
          const group = groups.find((g) => g.id === targetKey.slice('chapter:'.length))
          childId = group?.in_id ?? group?.route[0] ?? null
        } else {
          childId = targetKey
        }
      }
      if (!childId || !graphEdges.some((e) => e.to_node === childId)) {
        setSelectedEdgeId(null) // 消えたエッジの選択を残さない(Delete が誤爆しないように)
        return
      }
      const child = graphNodes.find((n) => n.id === childId)
      const label = child?.title || '(無題)'
      // 章の入口を切る = 章ごと切り離す。マーカー名(「第一章 入口」)ではなく
      // 章の名前で確認する
      const chapterTitle =
        child?.kind === 'chapter_in'
          ? groups.find((g) => g.id === child.group_id)?.title ?? label
          : null
      const message =
        child?.kind === 'ending'
          ? `結末「${label}」を切り離しますか?(あとで別のシーンにつなげます)`
          : chapterTitle !== null
            ? `章「${chapterTitle}」を前から切り離しますか?(章ごと独立した島になります)`
            : `「${label}」から先を切り離しますか?(シーンは残り、独立した島になります)`
      if (!window.confirm(message)) return
      try {
        await api.detachNode(childId)
        setSelectedEdgeId(null)
        await reload()
      } catch (e) {
        setGenStatus(`切り離せません: ${String(e)}`)
      }
    },
    [graphEdges, graphNodes, groups, reload]
  )

  // いま開いている章と表示の種類。接続・シーン追加の挙動にも効くので、
  // 章ビューのセクション(下)ではなくここで定義する
  const focusedGroup = useMemo(() => groups.find((g) => g.id === chapterView) ?? null, [groups, chapterView])
  const effectiveView: 'flat' | 'chapters' | 'focused' =
    groups.length === 0 ? 'flat' : focusedGroup ? 'focused' : chapterView === 'chapters' ? 'chapters' : 'flat'

  // 章カードのピンは、章の実シーンに読み替える(出 = 末尾シーン、入 = 先頭シーン)。
  // 章カードは表示上の導出ノードなので、接続は中身のシーンに対して行う
  const resolveEndpoint = useCallback(
    (id: string | null | undefined, role: 'source' | 'target'): string | null => {
      if (!id) return null
      if (!id.startsWith('chapter:')) return id
      const group = groups.find((g) => g.id === id.slice('chapter:'.length))
      if (!group) return null
      // 章カードのピンは、章の出口 / 入口そのもの(無い章は route の端で代用)
      const fallback = role === 'source' ? group.route.at(-1) : group.route[0]
      return (role === 'source' ? group.out_id : group.in_id) ?? fallback ?? null
    },
    [groups]
  )

  // 繋ぎ先に既に親がいる場合は「つなぎ替え」になる(A-B-C で A→C を繋ぐと B-C が切れる)。
  // 多重親にはならず、循環だけを防ぐ
  const isValidConnection = useCallback(
    (connection: { source?: string | null; target?: string | null }): boolean => {
      const source = resolveEndpoint(connection.source, 'source')
      const target = resolveEndpoint(connection.target, 'target')
      if (!source || !target || source === target) return false
      // 結末の先には繋げず、はじまりに親は作れない(ハンドルも出していないが、
      // 章カードのピン読み替えを通る経路もあるためここでも弾く)
      if (graphNodes.find((n) => n.id === source)?.kind === 'ending') return false
      if (graphNodes.find((n) => n.id === target)?.kind === 'start') return false
      if (graphEdges.some((e) => e.from_node === source && e.to_node === target)) return false // 既にある
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
    [graphEdges, graphNodes, resolveEndpoint]
  )

  const handleConnect = useCallback(
    async (connection: { source?: string | null; target?: string | null }): Promise<void> => {
      const source = resolveEndpoint(connection.source, 'source')
      const target = resolveEndpoint(connection.target, 'target')
      if (!source || !target || !isValidConnection(connection)) return
      // 繋ぎ先に既にいる親は切れる(つなぎ替え)。何を切ったかは黙らずに知らせる
      const oldParent = graphEdges.find((e) => e.to_node === target)?.from_node ?? null
      const titleOf = (id: string): string =>
        graphNodes.find((n) => n.id === id)?.title || '(無題)'
      try {
        await api.connectNodes(source, target, false, true)
      } catch (e) {
        setGenStatus(`繋げません: ${String(e)}`)
        return
      }
      // 章の中で島を書いて章の末尾に繋いだときは、その章のシーンにする
      // (未分類のままだと章ビューで章カードの外に出てしまう。後続の一続きも
      // サーバー側で一緒に入る)
      if (focusedGroup && source === focusedGroup.route.at(-1)) {
        await api.addNodeToGroup(focusedGroup.id, target).catch(() => undefined)
      }
      try {
        // 状態は fold が親から積み直すので LLM は不要。ここでは重複した
        // char_introduce の掃除と検証だけを行う(即時・非破壊的)
        const normalized = await api.normalizeChain(target)
        await reload()
        const toChapterOut = graphNodes.find((n) => n.id === target)?.kind === 'chapter_out'
        const parts = [
          toChapterOut
            ? `この章の道を「${titleOf(source)}」までに差し替えました`
            : oldParent
              ? `繋ぎ替えました(${titleOf(oldParent)} → ${titleOf(target)} を外しました)`
              : '繋ぎました(下書きとして接続)',
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
    [isValidConnection, resolveEndpoint, reload, graphEdges, graphNodes, focusedGroup]
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

  // 選択したシーンとその子孫(分岐も章もまたいで結末まで)。「この先すべて」の対象数を出すのに使う。
  // マーカー(はじまり / 結末 / 章の入口・出口)は辿るが数えない
  // (シーンではなく、サーバ側の作り直しも kind 付きノードは飛ばすため)
  const withDownstream = useCallback(
    (nodeIds: string[]): string[] => {
      const children: Record<string, string[]> = {}
      for (const e of graphEdges) (children[e.from_node] ??= []).push(e.to_node)
      const kinds = new Map(graphNodes.map((n) => [n.id, n.kind]))
      const seen = new Set<string>()
      const stack = [...nodeIds]
      while (stack.length > 0) {
        const id = stack.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        for (const c of children[id] ?? []) stack.push(c)
      }
      return [...seen].filter((id) => !kinds.get(id))
    },
    [graphEdges, graphNodes]
  )

  // 選択したシーンを一括清書(条件は鑑賞モードの選択をそのまま使う。清書済みも上書きする)
  // 選んだシーンの朗読台本に、LLM で話者と感情を付ける(docs/design/voice.md §4.4)。シーンごとに 1 件ずつ
  // タスクキューに積む(ステータスバーで進み具合が見え、1 件ずつ中止できる)。対象の清書は、いまの清書の
  // スタイル(プリセット / POV)の最新。清書の無いシーンは積まない。redo=false なら付け済みのシーンは飛ばす
  const runAnnotateNodes = useCallback(
    async (nodeIds: string[], redo: boolean): Promise<void> => {
      const presetId = renderStyle.presetId
      if (!presetId || nodeIds.length === 0) return
      const pov = renderStyle.povChar
      let queued = 0
      let noRender = 0
      let already = 0
      for (const nodeId of nodeIds) {
        let renderId: string | null = null
        try {
          renderId = (await api.getRender(nodeId, presetId, pov)).render?.id ?? null
          if (renderId && !redo && (await api.voiceScript(renderId)).source === 'llm') {
            already += 1
            continue
          }
        } catch {
          renderId = null
        }
        if (!renderId) {
          noRender += 1
          continue
        }
        const rid = renderId
        const title = graphNodes.find((n) => n.id === nodeId)?.title || '(無題)'
        queued += 1
        enqueueTask({
          label: '台本',
          detail: `話者と感情: ${title}`,
          kind: 'voice-script',
          nodeId: rid, // 台本の画面が「付けている最中」を見分ける鍵(清書 ID)
          runner: async ({ signal }) => {
            markNodeBusy(nodeId, true)
            try {
              await api.annotateVoiceScript(rid, null, signal)
            } catch (err) {
              if (!isAbortError(err)) setGenStatus(`話者と感情を付けられませんでした(${title}): ${String(err)}`)
            } finally {
              markNodeBusy(nodeId, false)
            }
          }
        })
      }
      const skipped = [
        noRender ? `清書の無い ${noRender} シーン` : '',
        already ? `付け済みの ${already} シーン` : ''
      ].filter(Boolean)
      setGenStatus(
        queued
          ? `話者と感情の付与を ${queued} シーン分キューに積みました${skipped.length ? `(${skipped.join('・')}は飛ばしました)` : ''}`
          : `積むシーンがありません(${skipped.join('・') || '対象なし'})`
      )
    },
    [renderStyle.presetId, renderStyle.povChar, graphNodes, markNodeBusy]
  )

  const runRenderNodes = useCallback(
    (nodeIds: string[]): void => {
      const presetId = renderStyle.presetId
      if (!presetId || nodeIds.length === 0) return
      const pov = renderStyle.povChar
      const chars = renderStyle.targetChars
      enqueueTask({
        label: '清書',
        total: nodeIds.length,
        detail: `${nodeIds.length} シーン`,
        runner: async ({ update, signal }) => {
          let current: string | null = null
          let done = 0
          try {
            await renderStream(
              {
                preset_id: presetId,
                pov_char: pov,
                node_ids: nodeIds,
                skip_existing: false,
                target_chars: chars
              },
              (e) => {
                // 実際に書くシーン数はサーバーが返す
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
                if (e.done) setGenStatus(`${done} シーンを清書しました`)
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
    [markNodeBusy, renderStyle.presetId, renderStyle.povChar, renderStyle.targetChars]
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
    async (nodeIds: string[], groupIds: string[] = []): Promise<void> => {
      if (deletingNodes.current) return
      const targets = [...new Set(nodeIds)].filter((id) => graphNodes.some((n) => n.id === id && !n.kind))
      const chapters = [...new Set(groupIds)]
      if (!targets.length && !chapters.length) return
      const sceneCount = graphNodes.filter((n) => !n.kind &&
        (targets.includes(n.id) || (n.group_id && chapters.includes(n.group_id)))).length
      const message = chapters.length
        ? `${chapters.length} 章と、章内を含む ${sceneCount} シーンを削除しますか?(章内の枝・未接続シーンも削除されます。後続シーンは前のシーンに繋がります)`
        : `${sceneCount} シーンを削除しますか?(後続シーンは前のシーンに繋がります)`
      if (!window.confirm(message)) return
      deletingNodes.current = true
      try {
        const result = await api.deleteSelection(targets, chapters)
        const deleted = new Set(result.node_ids)
        for (const id of deleted) deleteBeatDraft(id)
        setSelectedId((current) => (current && deleted.has(current) ? null : current))
        setSelectedChapterId((current) => (current && chapters.includes(current) ? null : current))
        setChapterView((current) => (chapters.includes(current) ? 'chapters' : current))
        try {
          await reload()
        } catch (e) {
          setGenStatus(`削除後の表示を更新できませんでした: ${String(e)}`)
        }
      } catch (e) {
        setGenStatus(`削除できませんでした: ${String(e)}`)
      } finally {
        deletingNodes.current = false
      }
    },
    [graphNodes, reload]
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

  const toggleInspector = (): void => {
    const height = Math.min(inspectorHeight, (rowRef.current?.clientHeight ?? window.innerHeight) * 0.7)
    shiftViewportForShrink(0, inspectorOpen ? -(height + 1) : height + 1)
    setInspectorOpen(!inspectorOpen)
    localStorage.setItem('inspectorOpen', inspectorOpen ? '0' : '1')
  }

  // 分割線のドラッグで詳細欄の高さを変える(上へドラッグで拡大)。
  // ノードエリアは最低 160px 残す
  const beginInspectorResize = useCallback(
    (event: React.PointerEvent): void => {
      event.preventDefault()
      const startY = event.clientY
      const columnHeight = rowRef.current?.clientHeight
      const maxH = columnHeight ? Math.max(220, Math.min(columnHeight - 160, columnHeight * 0.7)) : Math.round(window.innerHeight * 0.7)
      const startH = Math.min(inspectorHeight, maxH)
      let current = startH
      const onMove = (ev: PointerEvent): void => {
        const next = Math.min(Math.max(startH + (startY - ev.clientY), 220), maxH)
        if (next === current) return
        shiftViewportForShrink(0, next - current)
        current = next
        setInspectorHeight(next)
      }
      const cleanup = (): void => {
        document.body.style.userSelect = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        resizeCleanupRef.current = null
      }
      const onUp = (): void => {
        cleanup()
        localStorage.setItem('inspectorHeight', String(Math.round(current)))
      }
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      resizeCleanupRef.current = cleanup
    },
    [inspectorHeight, shiftViewportForShrink]
  )

  // 共通チャットの幅・開閉で変わるキャンバスの横幅にも中心位置を追従する。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let previous = canvas.clientWidth
    const observer = new ResizeObserver(() => {
      const width = canvas.clientWidth
      if (width <= 0) return
      if (previous > 0) shiftViewportForShrink(previous - width, 0)
      previous = width
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [shiftViewportForShrink])

  // あるノードまでのパス(親エッジを遡る)。関係図・事実は、選択中のシーン(章なら章の最後のシーン)までの時間軸を表示する
  const pathToNode = useCallback((targetId: string | null) => {
    if (!targetId) return null
    const parentMap = new Map(graphEdges.map((e) => [e.to_node, e.from_node]))
    const nodeById = new Map(graphNodes.map((n) => [n.id, n]))
    if (!nodeById.has(targetId)) return null
    const ids: string[] = [targetId]
    const seen = new Set([targetId])
    let current = targetId
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
  }, [graphNodes, graphEdges])
  const pathToSelected = useMemo(() => pathToNode(selectedId), [pathToNode, selectedId])

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
  // (どの章を見ているかは接続や追加の挙動にも効くので、focusedGroup /
  //  effectiveView はこのセクションより前で定義している)

  // 章内ビューで見せるノード: 章のメンバー + そこから生える分岐(draft・未分類)の部分木
  const visibleIds = useMemo(() => {
    if (effectiveView !== 'focused' || !focusedGroup) return null
    // 入口 / 出口も章の中に見せる(ここに繋ぎ替えて章の道を決めるため)
    const set = new Set(
      [...focusedGroup.node_ids, focusedGroup.in_id, focusedGroup.out_id].filter(
        (id): id is string => !!id
      )
    )
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

  // 章ビュー用: シーン ID → 章 ID(カードへの写像とエッジの畳み込みに使う)。
  // 章のメンバーに加えて、**章のシーンから生える分岐(draft・未分類)の部分木**も
  // その章に写す。章内ビューでは章の中に表示されている(visibleIds と同じ規則)ので、
  // 章ビューでだけ章カードの外に飛び出すのを防ぐ
  const chapterSeq = useMemo(() => {
    const groupByNode = new Map<string, string>()
    const outIds = new Set<string>()
    groups.forEach((g) => {
      g.node_ids.forEach((n) => groupByNode.set(n, g.id))
      // 入口 / 出口も章カードに畳む(章ビューでは章の境界 = カードのピン)
      if (g.in_id) groupByNode.set(g.in_id, g.id)
      if (g.out_id) {
        groupByNode.set(g.out_id, g.id)
        outIds.add(g.out_id)
      }
    })
    const children: Record<string, string[]> = {}
    for (const e of graphEdges) (children[e.from_node] ??= []).push(e.to_node)
    const byId = new Map(graphNodes.map((n) => [n.id, n]))
    const queue = [...groupByNode.keys()]
    while (queue.length > 0) {
      const current = queue.pop()!
      // **出口の先は章の外**。ここから畳むと、章の後ろに繋いだ独立シーンが
      // 章カードに吸い込まれて画面から消える(2026-08-02 ユーザー報告)。
      // 畳む対象は「章の中のシーンから生える分岐」だけ
      if (outIds.has(current)) continue
      const gid = groupByNode.get(current)!
      for (const child of children[current] ?? []) {
        if (groupByNode.has(child)) continue
        const node = byId.get(child)
        if (node && node.status === 'draft' && !node.group_id) {
          groupByNode.set(child, gid)
          queue.push(child)
        }
      }
    }
    return { groupByNode }
  }, [groups, graphNodes, graphEdges])

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
      const p = flowNodes.find((n) => n.id === g.route[0])?.position
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
        const first = nodeById.get(g.route[0])
        const anchor =
          flowNodesRef.current.find((n) => n.id === g.route[0])?.position ??
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
          data: {
            group: g,
            number: gi + 1,
            cover: chapterCoverNode(g, nodeById),
            onOpen: openChapter
          }
        }
      })
    })
    // chapterAnchorSig は flowNodes の位置を畳んだ署名(毎フレーム作り直さないため)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, chapterAnchorSig, graphNodes, openChapter])

  // シーンを章カードの上へ運んでいるか(離すとその章に入る)
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null)

  /** ドラッグ中のシーンが重なっている章カードの ID(章ビューでのみ) */
  const chapterDropTarget = useCallback(
    (node: AppFlowNode, dragged: AppFlowNode[]): string | null => {
      if (effectiveView !== 'chapters') return null
      // 章カードごと動かしているときは対象外(カードの移動が優先)
      if (node.type === 'chapterNode' || dragged.some((n) => n.type === 'chapterNode')) return null
      const hit = reactFlow.getIntersectingNodes(node).find((n) => n.type === 'chapterNode')
      return hit ? (hit.data as ChapterNodeData).group.id : null
    },
    [effectiveView, reactFlow]
  )

  /** 章カードへ落としたシーンを、その章に入れる(繋がっている後続も一緒に入る) */
  const dropIntoChapter = async (groupId: string, nodeIds: string[]): Promise<void> => {
    const title = groups.find((g) => g.id === groupId)?.title ?? '章'
    let added = 0
    for (const id of nodeIds) {
      try {
        await api.addNodeToGroup(groupId, id)
        added += 1
      } catch (e) {
        setGenStatus(`「${title}」に入れられません: ${String(e)}`)
      }
    }
    if (added > 0) setGenStatus(`${added} シーンを「${title}」に入れました`)
    await reload()
  }

  // 章ビュー: 章カード + 未分類のシーン
  const chapterFlow = useMemo(() => {
    if (effectiveView !== 'chapters') return null
    const { groupByNode } = chapterSeq
    // ドロップ先の章カードだけ光らせる(data を差し替えるのはその 1 枚)
    const nodes: AppFlowNode[] = chapterNodes.map((n) =>
      dropTargetGroupId && n.data.group.id === dropTargetGroupId
        ? { ...n, data: { ...n.data, dropTarget: true } }
        : n
    )
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
    // 整列にも同じ畳み方が要るので、端点を写像したグラフも一緒に返す
    const derived: GraphEdge[] = []
    for (const e of graphEdges) {
      const source = rep(e.from_node)
      const target = rep(e.to_node)
      if (source === target) continue
      const key = `${source}->${target}`
      if (seen.has(key)) continue
      seen.add(key)
      derived.push({ id: key, from_node: source, to_node: target, is_canon: e.is_canon })
      const selected = key === selectedEdgeId
      edges.push({
        id: key,
        source,
        target,
        interactionWidth: 18,
        selected,
        style: selected
          ? { stroke: 'var(--accent)', strokeWidth: 3 }
          : e.is_canon
            ? { stroke: '#8a8fb8', strokeWidth: 2.5 }
            : { stroke: '#4a4f66', strokeWidth: 1.5, strokeDasharray: '7 5' }
      })
    }
    return { nodes, edges, derived }
  }, [effectiveView, chapterSeq, chapterNodes, flowNodes, graphEdges, dropTargetGroupId, selectedEdgeId])

  /** ⟲ の中身。**いま見えている範囲だけ**を整列する。
   *
   * - **章内ビュー**: その章に見えているシーン(章のメンバー + そこから生える分岐)
   *   だけを並べ直す。章の外のノードには触らない
   * - **章ビュー**: 章カードと未分類のノードだけを、**章カードを 1 枚のノードに
   *   畳んだ導出グラフ**で並べる。**章の中のシーンには触らない**(章カードの位置は
   *   groups.pos_x/pos_y に焼き付ける)
   * - **フラット表示**: 2 つ以上選択していれば選択分だけ、そうでなければ
   *   手動配置をすべて捨てて全体を自動レイアウトに戻す
   *
   * 全体リセット以外は、範囲の左上を動かさないようレイアウト結果を今の左上へ
   * 寄せる(範囲の外にあるノードとの重なりは作者に任せる)。
   */
  const realignLayout = useCallback(async (): Promise<void> => {
    /** 実測高さを id → 高さの辞書に。無ければ layoutDag の既定値が使われる */
    const heightsOf = (nodes: AppFlowNode[]): Record<string, number> => {
      const heights: Record<string, number> = {}
      for (const n of nodes) if (n.measured?.height) heights[n.id] = n.measured.height
      return heights
    }
    try {
      // ---- 章ビュー: 章カード + 未分類ノードだけ(章の中は触らない)
      if (effectiveView === 'chapters' && chapterFlow) {
        const targets = chapterFlow.nodes
        if (targets.length < 2) {
          setGenStatus('整列するものがありません')
          return
        }
        const computed = layoutDag(targets, chapterFlow.derived, heightsOf(targets))
        const minX = Math.min(...targets.map((n) => n.position.x))
        const minY = Math.min(...targets.map((n) => n.position.y))
        const placed = targets.map((n) => ({
          id: n.id,
          x: Math.round(minX + (computed[n.id]?.x ?? 0)),
          y: Math.round(minY + (computed[n.id]?.y ?? 0))
        }))
        const byId = new Map(placed.map((p) => [p.id, p]))
        const move = <T extends AppFlowNode>(n: T): T => {
          const p = byId.get(n.id)
          return p ? { ...n, position: { x: p.x, y: p.y } } : n
        }
        setChapterNodes((prev) => prev.map(move))
        setFlowNodes((prev) => prev.map(move))
        const scenes = placed.filter((p) => !p.id.startsWith('chapter:'))
        for (const p of scenes) pinnedRef.current.add(p.id)
        try {
          await Promise.all([
            ...placed
              .filter((p) => p.id.startsWith('chapter:'))
              .map((p) => api.setGroupPosition(p.id.slice('chapter:'.length), p.x, p.y)),
            scenes.length > 0 ? api.setNodePositions(scenes) : Promise.resolve()
          ])
        } catch (e) {
          for (const p of scenes) pinnedRef.current.delete(p.id)
          throw e
        }
        setGenStatus(`${placed.length} 件を整列しました(章の中は変えていません)`)
        await reload()
        return
      }

      const selected = flowNodes.filter((n) => n.selected)
      // 章内ビューでは、選択していなければ「その章に見えているシーン」が対象。
      // 全体リセット(手動配置の破棄)はフラット表示のときだけ
      const targets =
        selected.length >= 2 ? selected : visibleIds ? flowNodes.filter((n) => visibleIds.has(n.id)) : []
      if (targets.length < 2) {
        if (effectiveView !== 'flat') {
          setGenStatus('整列するシーンがありません')
          return
        }
        await api.resetLayout()
        pinnedRef.current.clear()
        setFlowNodes([]) // 保存座標を消した上でドラッグ中間状態も破棄して再構築する
        await reload()
        return
      }
      const ids = new Set(targets.map((n) => n.id))
      const computed = layoutDag(
        graphNodes.filter((n) => ids.has(n.id)),
        graphEdges.filter((e) => ids.has(e.from_node) && ids.has(e.to_node)),
        heightsOf(targets)
      )
      const minX = Math.min(...targets.map((n) => n.position.x))
      const minY = Math.min(...targets.map((n) => n.position.y))
      const positions = targets.map((n) => ({
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
  }, [effectiveView, chapterFlow, visibleIds, flowNodes, graphNodes, graphEdges, reload])

  // 矢印キーの移動もこの 2 つを見るので、参照が毎レンダー変わらないよう memo する
  const displayNodes: AppFlowNode[] = useMemo(
    () =>
      effectiveView === 'chapters' && chapterFlow
        ? chapterFlow.nodes
        : visibleIds
          ? flowNodes.filter((n) => visibleIds.has(n.id))
          : flowNodes,
    [effectiveView, chapterFlow, visibleIds, flowNodes]
  )
  const displayEdges: Edge[] = useMemo(
    () =>
      effectiveView === 'chapters' && chapterFlow
        ? chapterFlow.edges
        : visibleIds
          ? flowEdges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
          : flowEdges,
    [effectiveView, chapterFlow, visibleIds, flowEdges]
  )

  // ビューを切り替えたらノード構成が大きく変わるので、全体が見える位置へ。
  // 開いた直後のフォーカス指定(鑑賞モードで読んでいたシーン)を消化するまでは、
  // 全体表示で上書きしない(章の中に入る操作でもこの効果が走るため)
  useEffect(() => {
    if (!focusDoneRef.current) return
    const timer = setTimeout(() => void reactFlow.fitView({ duration: 300, maxZoom: 1 }), 60)
    return () => clearTimeout(timer)
  }, [effectiveView, chapterView, reactFlow])

  /** キャンバスの選択が変わったときにインスペクタの対象を合わせる。
   *
   * React Flow はこのハンドラ自体を effect の依存に含めるので、インラインで渡すと
   * 再レンダーのたびに「現在の選択」で呼ばれ、キャンバス選択を伴わない
   * setSelectedId(リンクからの移動など)が直後に打ち消される。参照を固定しておく。
   */
  const handleSelectionChange = useCallback(({ nodes }: { nodes: Node[] }): void => {
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
  }, [])

  /** そのノードを選択して画面中央へ寄せる(ズームは保つ)。
   *
   * 矢印キーの移動と、開いた直後のフォーカス(鑑賞モードからの復帰)で共用する。
   * 選択の持ち場所はシーンと章カードで別なので、どちらか一方だけが選ばれるようにする。
   */
  const focusNodeOnCanvas = useCallback(
    (nodeId: string): void => {
      const flow = reactFlow.getNode(nodeId)
      if (flow) {
        // ズームは保ったまま中央へ寄せる(F の fitBounds とは役割を分ける)
        void reactFlow.setCenter(
          flow.position.x + (flow.measured?.width ?? 288) / 2,
          flow.position.y + (flow.measured?.height ?? FALLBACK_NODE_HEIGHT) / 2,
          { zoom: reactFlow.getZoom(), duration: 300 }
        )
      }
      const chapterId = nodeId.startsWith('chapter:') ? nodeId.slice('chapter:'.length) : null
      setFlowNodes((prev) =>
        prev.map((n) => (n.selected === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId }))
      )
      setChapterNodes((prev) =>
        prev.map((n) => (n.selected === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId }))
      )
      setSelectedChapterId(chapterId)
      setSelectedId(chapterId ? null : nodeId)
    },
    [reactFlow]
  )
  focusNodeOnCanvasRef.current = focusNodeOnCanvas

  /** 作ったばかりのシーンへ画面を寄せる。
   *
   * 物語は右へ伸びていくので、末尾や章の中に足したシーンは画面の外にできることが多い。
   * 反映(reload → 再描画)が何回目で届くかは決まらないので、現れるまで数回試す。
   * 章ビューなどで畳まれていて出てこないときは、そのまま何もしない。
   */
  const focusTimerRef = useRef<number | null>(null)
  const focusWhenReady = useCallback(
    (nodeId: string): void => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current)
      let tries = 0
      const tick = (): void => {
        focusTimerRef.current = null
        if (reactFlow.getNode(nodeId)) return focusNodeOnCanvas(nodeId)
        tries += 1
        if (tries < 15) focusTimerRef.current = window.setTimeout(tick, 200)
      }
      focusTimerRef.current = window.setTimeout(tick, 200)
    },
    [reactFlow, focusNodeOnCanvas]
  )
  useEffect(
    () => () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current)
    },
    []
  )

  const previousMode = useRef(workspace.mode)
  useEffect(() => {
    if (previousMode.current === 'reader' && workspace.mode === 'structure' && focusNodeId) {
      focusDoneRef.current = false
      setPendingFocusId(focusNodeId)
    }
    previousMode.current = workspace.mode
  }, [workspace.mode, focusNodeId])

  // 制作では章に隠れたシーンも開く。通常の追加操作のfocusWhenReadyとは分ける。
  const followProductionTarget = useCallback((target: ProductionTarget | null): void => {
    workspace.followTarget(target)
    const nodeId = target?.kind === 'chapter' ? `chapter:${target.id}` : target?.kind === 'scene' ? target.id : null
    if (nodeId) {
      setInspectorTab('beat')
      setInspectorFocus('scene')
    }
    focusDoneRef.current = nodeId === null
    setPendingFocusId(nodeId)
  }, [workspace.followTarget])

  // 鑑賞モードで読んでいたシーン、または制作の対象にフォーカスして開く(戻ったときに迷子にならない)。
  // 章に畳まれて見えないときは、その章の中に入ってから寄せる
  useEffect(() => {
    // 画面に何か出てから判断する(ノードの構築前は「見えない」と区別が付かない)
    if (workspace.mode !== 'structure' || !pendingFocusId || graphNodes.length === 0 || displayNodes.length === 0) return
    const finish = (): void => {
      focusDoneRef.current = true
      setPendingFocusId(null)
    }
    const target = graphNodes.find((n) => n.id === pendingFocusId)
    if (pendingFocusId.startsWith('chapter:')) {
      if (!groups.some((group) => `chapter:${group.id}` === pendingFocusId)) return finish()
      if (chapterView !== 'chapters') return setChapterView('chapters')
      if (!displayNodes.some((node) => node.id === pendingFocusId)) return
      const timer = setTimeout(() => { focusNodeOnCanvas(pendingFocusId); finish() }, 80)
      return () => clearTimeout(timer)
    }
    if (!target) return finish() // 鑑賞モードにいる間に消えたシーン
    if (!displayNodes.some((n) => n.id === pendingFocusId)) {
      // 章ビューでは章カードに畳まれている / 別の章の中を見ている
      // 所属未設定でも章カードに畳まれる枝があるため、表示に使う対応表で判定する。
      const groupId = target.group_id ?? chapterSeq.groupByNode.get(target.id)
      if (groupId && chapterView !== groupId && chapterView !== 'flat') return setChapterView(groupId)
      // 章外のシーンは章一覧でも見える。描画待ちを理由に全章を展開しない。
      if (!groupId && chapterView !== 'chapters' && chapterView !== 'flat') return setChapterView('chapters')
      // reload直後はgraphNodesだけが先に更新される。新規ノードの描画を待つ。
      return
    }
    // ノードの実寸が入ってから寄せる(初回描画では measured が空で中心がずれる)
    const timer = setTimeout(() => {
      focusNodeOnCanvas(pendingFocusId)
      finish()
    }, 80)
    return () => clearTimeout(timer)
  }, [workspace.mode, pendingFocusId, displayNodes, graphNodes, groups, chapterView, chapterSeq, focusNodeOnCanvas])

  // ---- キーボード操作 -------------------------------------------------

  /** 矢印キーが辿るグラフ。**いま画面に出ているつながり**を対象にする。
   *
   * 章ビューではエッジの端点を章カードへ畳んで「章どうしのつながり」にし、
   * 章内ビューではその章に見えているシーンだけに絞る。以前はシーングラフを
   * そのまま辿っていたため、章ビューでは章カードを選んでも何も起きず、
   * 画面に出ていないシーンへ選択だけが移っていた。
   */
  const navGraph = useMemo(() => {
    // シーン ID → 画面上のノード ID(章ビューでは章カード)。null = 画面に無い
    const rep = (id: string): string | null => {
      if (effectiveView === 'chapters') {
        const groupId = chapterSeq.groupByNode.get(id)
        return groupId ? `chapter:${groupId}` : id
      }
      return visibleIds && !visibleIds.has(id) ? null : id
    }
    // 並び順は元のシーン順から導く(章カードは先頭シーンの順)
    const order = new Map<string, number>()
    graphNodes.forEach((n, i) => {
      const id = rep(n.id)
      if (id && !order.has(id)) order.set(id, i)
    })
    const parentOf = new Map<string, string>()
    const childList = new Map<string, { id: string; canon: number }[]>()
    for (const e of graphEdges) {
      const from = rep(e.from_node)
      const to = rep(e.to_node)
      if (!from || !to || from === to) continue // 章の内部エッジは畳むと消える
      if (!parentOf.has(to)) parentOf.set(to, from)
      const children = childList.get(from) ?? []
      if (!children.some((c) => c.id === to)) children.push({ id: to, canon: e.is_canon ? 1 : 0 })
      childList.set(from, children)
    }
    const byOrder = (a: string, b: string): number => (order.get(a) ?? 0) - (order.get(b) ?? 0)
    const childrenOf = (id: string): string[] =>
      (childList.get(id) ?? [])
        .slice()
        .sort((a, b) => b.canon - a.canon || byOrder(a.id, b.id))
        .map((c) => c.id)
    const roots = (): string[] => [...order.keys()].filter((id) => !parentOf.has(id)).sort(byOrder)
    return { rep, parentOf, childrenOf, roots }
  }, [effectiveView, chapterSeq, visibleIds, graphNodes, graphEdges])

  /** 矢印キーでの移動。
   *
   * ← → は時間軸(親 / 子)、↑ ↓ は同じ分岐点の兄弟レーン。DAG の 2 軸と
   * キーの 2 軸を一致させている。兄弟の並びは自動レイアウトと同じ順
   * (正史の子が先、あとは作成順)なので、画面の上下と ↑ ↓ が対応する。
   * 選択ごと動かすので、インスペクタもついてくる(章カードなら章パネル)。
   */
  const navigateSelection = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down'): void => {
      const focus = focusNodeOnCanvas
      const currentId =
        displayNodes.find((n) => n.selected)?.id ?? (selectedId ? navGraph.rep(selectedId) : null)
      if (!currentId) {
        // 何も選んでいないときは、まず先頭(いちばん上流)を選ぶ
        const first = navGraph.roots()[0]
        if (first) focus(first)
        return
      }

      let targetId: string | undefined
      if (direction === 'right') {
        targetId = navGraph.childrenOf(currentId)[0] // 分岐しているときは正史の子へ
      } else if (direction === 'left') {
        targetId = navGraph.parentOf.get(currentId)
      } else {
        // 兄弟(親が無ければ島の根どうし)を並べて 1 つ隣へ。端では止まる
        const parent = navGraph.parentOf.get(currentId)
        const siblings = parent ? navGraph.childrenOf(parent) : navGraph.roots()
        const index = siblings.indexOf(currentId)
        if (index < 0) return
        targetId = siblings[index + (direction === 'down' ? 1 : -1)]
      }
      if (!targetId) return
      focus(targetId)
    },
    [displayNodes, selectedId, navGraph, focusNodeOnCanvas]
  )

  const copyNodes = useCallback(async (ids: string[]): Promise<void> => {
    const targets = graphNodes.filter((n) => ids.includes(n.id) && !n.kind)
    if (!targets.length) {
      showStatusNotice('コピーするシーンを選択してください')
      return
    }
    // コピー時点の本文・イベント・配置を保持する。章の移動や元の編集には追随しない。
    const nodes = structuredClone(targets)
    const positions = nodes.map((n, i) => {
      const shown = displayNodes.find((v) => v.id === n.id)
      return { x: shown?.position.x ?? n.pos_x ?? i * 360, y: shown?.position.y ?? n.pos_y ?? 0 }
    })
    const minX = Math.min(...positions.map((p) => p.x))
    const minY = Math.min(...positions.map((p) => p.y))
    nodes.forEach((n, i) => { n.pos_x = positions[i].x - minX; n.pos_y = positions[i].y - minY })
    const selected = new Set(nodes.map((n) => n.id))
    const edges = structuredClone(graphEdges.filter((e) => selected.has(e.from_node) && selected.has(e.to_node)))
    try {
      const library = await api.getLibrary()
      setNodeClipboard({ library_root: library.root, nodes, edges })
      pasteCount.current = 0
      showStatusNotice(`${nodes.length} シーンをコピーしました`)
    } catch (e) {
      showStatusNotice(`コピーできませんでした: ${String(e)}`)
    }
  }, [graphNodes, graphEdges, displayNodes])

  const pasteNodes = useCallback(async (at?: { x: number; y: number }, groupId?: string): Promise<void> => {
    if (!nodeClipboard || pastingNodes.current || productionEditingLocked) return
    pastingNodes.current = true
    const destination = groupId ?? focusedGroup?.id ?? selectedChapterId ?? null
    const rect = canvasRef.current?.getBoundingClientRect()
    const center = at ?? (rect ? reactFlow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 })
    const offset = at ? 0 : pasteCount.current * 40
    try {
      const result = await api.pasteNodes(nodeClipboard, destination, Math.round(center.x - 144 + offset), Math.round(center.y - 80 + offset))
      pasteCount.current++
      if (destination) setChapterView(destination)
      setSelectedChapterId(null)
      setSelectedEdgeId(null)
      setSelectedId(result.node_ids[0])
      await reload()
      focusWhenReady(result.node_ids[0])
      setInspectorTab('beat')
      showStatusNotice(`${result.node_ids.length} シーンを貼り付けました`)
    } catch (e) {
      showStatusNotice(`貼り付けできませんでした: ${String(e)}`)
    } finally {
      pastingNodes.current = false
    }
  }, [nodeClipboard, productionEditingLocked, focusedGroup, selectedChapterId, reactFlow, reload, focusWhenReady])

  // キーボードショートカット(lm-graph と同じ): A = 全体表示 / F = 選択にフォーカス
  // Delete = 選択ノードを削除(エッジ選択中は切断)
  // 矢印 = ノード間の移動(← → が親子、↑ ↓ が分岐レーン)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (workspace.mode !== 'structure') return
      if (castView) return // キャラクタービューの間は、下のフローチャートのキー操作(削除・移動)を効かせない
      if (event.isComposing || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase()
        if (key === 'c') {
          if (window.getSelection()?.type === 'Range') return
          event.preventDefault()
          if (!event.repeat) void copyNodes(displayNodes.filter((n) => n.selected).map((n) => n.id))
          return
        }
        if (key === 'v' && nodeClipboard) {
          if (productionEditingLocked) return // 制作中は貼り付けない(書き換え)
          event.preventDefault()
          if (!event.repeat) void pasteNodes()
          return
        }
      }
      if (event.key === 'Delete') {
        if (productionEditingLocked) return // 制作中は削除・切断しない(書き換え)
        if (event.repeat || deletingNodes.current) return
        // エッジを選択中なら「削除」ではなく「切断」(ノードは残す)
        if (selectedEdgeId) {
          event.preventDefault()
          void detachEdge(selectedEdgeId)
          return
        }
        const selected = displayNodes.filter((n) => n.selected)
        if (selected.length > 1 || selected[0]?.type === 'chapterNode') {
          // 章は所属シーンごと削除し、単独のマーカーは対象に含めない。
          const targets = selected
            .filter((n) => n.type !== 'chapterNode' && !(n.data as BeatNodeData).storyNode?.kind)
            .map((n) => n.id)
          event.preventDefault()
          const chapters = selected.filter((n) => n.type === 'chapterNode')
            .map((n) => (n.data as ChapterNodeData).group.id)
          void deleteNodes(targets, chapters)
          return
        }
        // キャンバス上で選択中のノードを優先し、無ければインスペクタの選択ノード
        const targetId = selected[0]?.id ?? selectedId
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
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'a') {
        event.preventDefault()
        void reactFlow.fitView({ duration: 300, padding: 0.1 })
        return
      }
      if (event.key === 'f') {
        let targets = displayNodes.filter((n) => n.selected)
        if (targets.length === 0 && selectedId) {
          targets = displayNodes.filter((n) => n.id === selectedId)
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
  }, [workspace.mode, castView, reactFlow, displayNodes, selectedId, selectedEdgeId, detachEdge, deleteNodeById, deleteNodes, navigateSelection, productionEditingLocked, copyNodes, pasteNodes, nodeClipboard])

  /** 人物の鎖でノードを動かした → 配置を保存する(画面は先に書き換える) */
  const handleChainPositions = useCallback(
    (scenes: Array<{ id: string; x: number; y: number }>, chars: Array<{ id: string; x: number; y: number }>): void => {
      const sceneMap = new Map(scenes.map((p) => [p.id, p]))
      const charMap = new Map(chars.map((p) => [p.id, p]))
      if (scenes.length) setGraphNodes((prev) => prev.map((n) => (sceneMap.has(n.id) ? { ...n, chain_x: sceneMap.get(n.id)!.x, chain_y: sceneMap.get(n.id)!.y } : n)))
      if (chars.length) setCharacters((prev) => prev.map((c) => (charMap.has(c.id) ? { ...c, chain_x: charMap.get(c.id)!.x, chain_y: charMap.get(c.id)!.y } : c)))
      void api.setChainPositions(scenes, chars).catch((e) => setGenStatus(`配置を保存できません: ${String(e)}`))
    },
    []
  )

  /** キャラクタービューからシーンを選んだとき: 詳細欄を人物専用の表示からシーンの表示に戻す。
   *  シーン側のタブ(キャラ・関係図・事実)は前のまま(選んだシーンの内容に変わる) */
  const selectSceneFromView = useCallback(
    (nodeId: string): void => {
      focusNodeOnCanvas(nodeId)
      setInspectorFocus('scene')
    },
    [focusNodeOnCanvas]
  )

  /** 人物の鎖でシーンをダブルクリック → フローチャートに戻ってそのシーンへ寄せる
   *  (章に畳まれていれば章の中まで開く。pendingFocusId の仕組みを使う) */
  const openSceneInFlow = useCallback((nodeId: string): void => {
    setCastView(null)
    setInspectorFocus('scene')
    focusDoneRef.current = false
    setPendingFocusId(nodeId)
  }, [])

  // 人物専用の表示で見ている人物と、その「時点」のシーン。選択中のシーンにその人物が居ればそのシーン、
  // 居なければ正史で最後に登場したシーン(どこにも居なければ null = 状態・関係図・事実は出せない)
  const focusCharacter = useMemo(
    () => (libraryCharId ? characters.find((c) => c.id === libraryCharId) ?? null : null),
    [characters, libraryCharId]
  )
  const charPointNode = useMemo(() => {
    if (!libraryCharId) return null
    const current = selectedId ? graphNodes.find((n) => n.id === selectedId) : null
    if (current && !current.kind && (current.cast ?? []).includes(libraryCharId)) return current
    return [...canonPath].reverse().find((n) => (n.cast ?? []).includes(libraryCharId)) ?? null
  }, [libraryCharId, selectedId, graphNodes, canonPath])
  const charPointPath = useMemo(() => (charPointNode ? pathToNode(charPointNode.id) : null), [charPointNode, pathToNode])

  /** 人物の鎖で線を差す / 消す → そのシーンの cast を付け替えて保存する。
   *  画面は先に書き換え(楽観更新)、保存後に読み直す。詳細欄に未保存の下書きが
   *  残っていれば、その cast も合わせる(あとで保存したときに巻き戻さないように) */
  const handleCastChange = useCallback(
    (sceneId: string, charId: string, op: 'add' | 'remove'): void => {
      const node = graphNodes.find((n) => n.id === sceneId)
      if (!node) return
      const current = node.cast ?? []
      const cast = op === 'add' ? (current.includes(charId) ? current : [...current, charId]) : current.filter((c) => c !== charId)
      setGraphNodes((prev) => prev.map((n) => (n.id === sceneId ? { ...n, cast } : n)))
      const draft = beatDraftCache.get(sceneId)
      if (draft) setBeatDraft(sceneId, { ...draft, cast })
      void api
        .updateNode(sceneId, { cast })
        .then(() => reload())
        .catch((e) => setGenStatus(`登場人物を保存できません: ${String(e)}`))
    },
    [graphNodes, reload]
  )

  // Ctrl+S: 選択中のシーンのうち、未保存の下書きが残っているものをまとめて保存する。
  // 下書きはシーンタブを離れてもシーンごとに残る(beatDraftCache)ので、どのタブを開いていても、
  // 複数選択でも同じに動く。選択していないシーンの下書きには触らない(忘れていた下書きを確定しない)。
  const savingDrafts = useRef(false)
  const saveSelectedDrafts = useStableCallback(async (): Promise<void> => {
    if (savingDrafts.current || productionEditingLocked) return
    const selected = displayNodes.filter((n) => n.selected).map((n) => n.id)
    const ids = [...new Set(selectedId ? [...selected, selectedId] : selected)].filter((id) => beatDraftCache.has(id))
    if (ids.length === 0) return
    savingDrafts.current = true
    let saved = 0
    const failed: string[] = []
    try {
      for (const id of ids) {
        const draft = beatDraftCache.get(id)
        if (!draft) continue
        try {
          await api.updateNode(id, draft)
          // 保存中に打った分(表示中のシーン)は退避に残す(BeatTab.handleSave と同じ)
          if (beatDraftCache.get(id) === draft) deleteBeatDraft(id)
          saved += 1
        } catch {
          // 1つ失敗しても残りは保存する。失敗したシーンの下書きは残る
          failed.push(draft.title || '(無題)')
        }
      }
      if (saved > 0) await reload()
    } finally {
      savingDrafts.current = false
    }
    const done = saved === 0 ? '' : saved === 1 && failed.length === 0 ? 'シーンを保存しました' : `${saved} シーンを保存しました`
    const trouble = failed.length ? `保存できませんでした: ${failed.join('、')}` : ''
    showStatusNotice([done, trouble].filter(Boolean).join(' / '))
  })
  useEffect(() => {
    // 構造モードは資料庫・鑑賞の間も裏に残るので、表に出ているときだけ受ける
    if (workspace.mode !== 'structure') return
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 's' || event.isComposing) return
      event.preventDefault()
      if (!event.repeat) void saveSelectedDrafts()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspace.mode, saveSelectedDrafts])

  // ---- 章の操作 -------------------------------------------------------
  // Electron は window.prompt を使えない(呼ぶと例外)ので、名前の入力は
  // 自前のモーダル(namePrompt)で行う

  const [namePrompt, setNamePrompt] = useState<{
    label: string
    value: string
    onSubmit: (value: string) => void
  } | null>(null)

  // ---- はじまり / 結末の操作(docs/design/endings.md) ----------------

  /** 結末をアクティブにする(= そこまでの道が正史になる)。
   *  2026-08-02 以降、呼ぶのは結末ノードの右クリックだけ。シーンを指して
   *  「この道を正史にする」操作は概念の重複なので UI から外した。 */
  const makeRouteCanon = async (nodeId: string): Promise<void> => {
    try {
      await api.makeCanon(nodeId)
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
      focusWhenReady(node.id)
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

  /** 章の読む道を、このシーンを通る道にする(出口をその枝の端へ繋ぎ替える) */
  const setChapterRoute = async (groupId: string, nodeId: string): Promise<void> => {
    try {
      await api.setGroupRoute(groupId, nodeId)
      await reload()
      setGenStatus('章の道を差し替えました')
    } catch (e) {
      setGenStatus(`章の道を変えられません: ${String(e)}`)
    }
  }

  /** 未分類のシーンを、隣接する章に入れる(後続の一続きも一緒に入る)。
   *  章の中で書いたのに未分類のまま残ったシーンを拾い直すための操作 */
  const addToChapter = async (nodeId: string, groupId: string): Promise<void> => {
    try {
      await api.addNodeToGroup(groupId, nodeId)
      await reload()
    } catch (e) {
      setGenStatus(`章に入れられません: ${String(e)}`)
    }
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

  /** 空の章(器)を作る。中身は後から書く / 島を入れる(docs/design/chapters.md §9)。
   *  at を渡すとその位置(キャンバス座標)に章カードを置く */
  const createEmptyChapter = (at?: { x: number; y: number }): void => {
    setNamePrompt({
      label: '章の名前',
      value: `第${groups.length + 1}章`,
      onSubmit: (title) => {
        void (async () => {
          try {
            const group = await api.createGroup(title, [])
            if (at) await api.setGroupPosition(group.id, Math.round(at.x), Math.round(at.y))
            await reload()
            setChapterView('chapters')
          } catch (e) {
            setGenStatus(`章を作れません: ${String(e)}`)
          }
        })()
      }
    })
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

  /** 章カードの表紙にするシーンを指定する(nodeId = null で自動導出に戻す)。
   *  挿絵そのものはシーンのもので、章は「どれを表紙にするか」だけを持つ */
  const setChapterCover = async (groupId: string, nodeId: string | null): Promise<void> => {
    try {
      await api.updateGroup(groupId, { cover_node_id: nodeId })
      await reload()
    } catch (e) {
      setGenStatus(`表紙を変更できません: ${String(e)}`)
    }
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
  // 「いまどの章を指しているか」。シーンを選んでいるときはシーン優先(= null)、
  // 章カードを選んでいればその章、章内ビューで何も選んでいなければその章。
  // インスペクタの章パネル、相談チャットのアンカー、生成・追加の足し先で共用する
  const activeGroup = selectedNode
    ? null
    : (groups.find((g) => g.id === selectedChapterId) ?? focusedGroup)
  // 章を指しているときの関係図・事実は「その章の最後のシーンまで」(相談チャットのアンカーと同じ扱い)
  const chapterEndId = activeGroup ? (activeGroup.route.at(-1) ?? null) : null
  const chapterEndPath = useMemo(() => pathToNode(chapterEndId), [pathToNode, chapterEndId])
  // 章のときに出すタブは 章 / 関係図 / 事実。清書・キャラはシーンに結びついた画面なので出さない。
  // 清書・キャラを開いたまま章を選んだら章を見せ、シーンに戻れば元のタブに戻る(inspectorTab は書き換えない)
  const shownTab = activeGroup && (inspectorTab === 'render' || inspectorTab === 'char') ? 'beat' : inspectorTab

  // 鑑賞モードのスコープ。章の中にいる間はその章、章ビューで章カードを選んで
  // いればその章(島・分岐の章でもよい)。null = 全体(正史)
  const readerScopeGroupId =
    focusedGroup?.id ?? groups.find((g) => g.id === selectedChapterId)?.id ?? null
  useEffect(() => {
    onReaderScopeChange?.(readerScopeGroupId)
  }, [readerScopeGroupId, onReaderScopeChange])

  // 相談チャットのアンカー候補。章カードを選ぶと selectedId は null になる
  // (章カードはシーンではない)ので、そのままだと正史の末尾に落ちてしまう。
  // 章を選んでいるときは**その章の末尾シーン**を候補にする
  // (ヘッダーの「アンカー: ○○ まで」= その章の終わりまで、と読める)
  const chatAnchorId =
    selectedId ?? (activeGroup ? (activeGroup.route.at(-1) ?? null) : null)

  /** 作ったばかりのシーンを、**実際に繋がった場所**へ置く(親が手動配置のときだけ)。
   *
   * 親と後続は「作ったあとのグラフ」から読む。画面側で見当をつけた親(生成の起点や
   * 選択中のシーン)と、サーバーが実際に繋いだ親は食い違う — 正史の末尾に足したつもりでも
   * 結末マーカーの手前に挿さるし、章の中では章の出口マーカーの手前に挿さる。マーカーは
   * 正史のシーン列から除いてあるので、見当をつけた親は 1 つ手前のシーンになり、
   * その右隣(= マーカーが既に居る列)へ置いていた。結果、繋がっている場所とはまるで
   * 別のところ、たいてい別の島のカードの上に新しいシーンが現れていた。
   *
   * 親が自動配置(pos が NULL)なら何もしない — 自動レイアウトに任せたほうが全体が揃う。
   */
  const placeCreatedNode = useCallback(
    async (newNodeId: string): Promise<StoryGraph> => {
      // 取得したグラフは決めた座標を書き込んで返す(呼び出し側が reload に
      // 使い回せるように。/graph は大きいので 2 回取り直さない)
      const graph = await api.getGraph()
      const parentId = graph.edges.find((e) => e.to_node === newNodeId)?.from_node ?? null
      if (!parentId) return graph // どこにも繋がっていない島。位置は作った側が決める
      const byId = new Map(graph.nodes.map((n) => [n.id, n]))
      const parent = byId.get(parentId)
      if (!parent || parent.pos_x == null || parent.pos_y == null) return graph
      const heightOf = (id: string): number =>
        reactFlow.getNode(id)?.measured?.height ?? FALLBACK_NODE_HEIGHT

      // 割り込みなら親と後続のあいだへ。後続が居なければ親の右隣(末尾への追加)
      const successorId = graph.edges.find((e) => e.from_node === newNodeId)?.to_node ?? null
      const successor = successorId ? byId.get(successorId) : undefined
      const shifted = new Map<string, { x: number; y: number }>()
      let desired: { x: number; y: number }
      if (successorId && successor && successor.pos_x != null && successor.pos_y != null) {
        let successorX = successor.pos_x
        // 手動配置の領域では後続が自分から動かないので、隙間が 1 列ぶんに足りなければ
        // **後続から下流を 1 列ぶん右へ押し出して**場所を作る
        if (successorX - parent.pos_x < COLUMN_GAP_X * 2) {
          const moved = shiftDownstreamX(graph, successorId, COLUMN_GAP_X)
          if (moved.length > 0) {
            await api.setNodePositions(moved)
            for (const m of moved) {
              shifted.set(m.id, m)
              const n = byId.get(m.id)
              if (n) {
                n.pos_x = m.x
                n.pos_y = m.y
              }
            }
          }
          successorX = shifted.get(successorId)?.x ?? successorX
        }
        desired = {
          x: snapped((parent.pos_x + successorX) / 2),
          y: snapped((parent.pos_y + successor.pos_y) / 2)
        }
      } else {
        desired = { x: snapped(parent.pos_x + COLUMN_GAP_X), y: snapped(parent.pos_y) }
      }

      // 同じ列に既にカードが居るなら下のレーンへ(分岐や、隣に並んだ島の上に重ねない)。
      // 自動配置のカード(pos が NULL)も画面には描かれているので、描画中の位置で
      // 重なりを見る(DB 座標だけ見ると、自動レイアウトの島の上に重ねてしまう)
      const others = graph.nodes
        .filter((n) => n.id !== newNodeId)
        .map((n) => {
          const moved = shifted.get(n.id)
          const screen = reactFlow.getNode(n.id)?.position
          const x = moved?.x ?? n.pos_x ?? screen?.x
          const y = moved?.y ?? n.pos_y ?? screen?.y
          return x == null || y == null ? null : { x, y, height: heightOf(n.id) }
        })
        .filter((r): r is { x: number; y: number; height: number } => r !== null)
      const at = avoidingOverlap(desired, heightOf(newNodeId), others)
      await api.setNodePosition(newNodeId, at.x, at.y)
      const created = byId.get(newNodeId)
      if (created) {
        created.pos_x = at.x
        created.pos_y = at.y
      }
      return graph
    },
    [reactFlow]
  )

  const handleAddBeat = async (): Promise<void> => {
    try {
      // 空の章(器)の中では、島として作ってその章に入れる。物語のどこにも
      // 位置していないので、繋ぎ先は作者があとで決める
      if (focusedGroup && focusedGroup.node_ids.length === 0 && !selectedId) {
        await handleAddDetached(undefined, focusedGroup.id)
        return
      }
      // 章を指しているときは**その章の末尾**へ割り込ませる(中に入っている章か、
      // 選んでいる章カード)。従来は正史の末尾(= 章の外)に付いていたので、
      // 章に足したつもりのシーンが章の外にできていた。シーンを選んでいるときは
      // 従来どおりその子(章の途中なら分岐になる)
      const chapterTail = selectedId ? null : (activeGroup?.route.at(-1) ?? activeGroup?.in_id ?? null)
      const draft = { beat: '(ここに出来事の仕様を書く)', cast: [] }
      const node = chapterTail
        ? await api.insertNodeAfter(chapterTail, draft)
        : await api.createNode({ ...draft, parent_id: selectedId ?? undefined })
      // 章の末尾に足したシーンはその章のものにする(未分類のままだと
      // 章ビューで章カードの外に出てしまう)
      if (activeGroup && chapterTail) {
        await api.addNodeToGroup(activeGroup.id, node.id).catch(() => undefined)
      }
      await reload(await placeCreatedNode(node.id))
      setSelectedId(node.id)
      setInspectorTab('beat')
      focusWhenReady(node.id)
    } catch (e) {
      setGenStatus(`シーンを追加できません: ${String(e)}`)
    }
  }

  // どこにも繋がない独立シーン。自動レイアウトの対象外にしたいので、
  // 手動配置として置く(島を作り置きするための入り口)。
  // at を渡すとその位置(キャンバス座標)、省略時は画面の中央。
  // groupId を渡すとその章のシーンにする(空の章の中で作るとき)
  const handleAddDetached = async (
    at?: { x: number; y: number },
    groupId?: string
  ): Promise<void> => {
    try {
      const node = await api.createNode({
        beat: '(ここに出来事の仕様を書く)',
        cast: [],
        detached: true
      })
      if (groupId) await api.addNodeToGroup(groupId, node.id).catch(() => undefined)
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
      focusWhenReady(node.id)
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
      await reload(await placeCreatedNode(node.id))
      setSelectedId(node.id)
      setInspectorTab('beat')
      focusWhenReady(node.id)
    } catch (e) {
      setGenStatus(`シーンを割り込ませられません: ${String(e)}`)
    }
  }

  // 生成もキューに積む(連続して指示を出しても取りこぼさない)。
  // 指示文は積んだ時点のものを使うので、入力欄はすぐ空にする
  const handleGenerate = (parentId: string | null, insertAfterId: string | null = null): void => {
    const promptText = instruction.trim() || null
    // insertAfterId(選択中のシーン)の直後へ足す。後続が居れば「間のシーン」に、
    // 居なければその続きになる(どちらもサーバーの insert_node_after 任せ。
    // docs/design/interpolation.md)。シーンを選んでいないときは、指している章の
    // 末尾(出口の手前)へ。空の章では入口の直後へ。どれでもなければ渡さず、
    // 正史の末尾(= 物語の最後)に足す
    // マーカー(はじまり / 結末 / 章の入口・出口)はシーンではないので「選んでいる
    // ものの続き」の対象にしない(はじまりを選んだまま押すと物語の先頭に割り込んで
    // しまう)。従来どおり物語の末尾(= 結末の手前)への追加として扱う
    const anchorNode = insertAfterId ? graphNodes.find((n) => n.id === insertAfterId) : undefined
    const anchorId = anchorNode && anchorNode.kind == null ? anchorNode.id : null
    const afterId = parentId
      ? null
      : (anchorId ?? activeGroup?.route.at(-1) ?? activeGroup?.in_id ?? null)
    // 生成されるノードはまだ存在しないので、続きを書く元のノードを光らせる
    const originId =
      parentId ?? afterId ?? (canonPath.length > 0 ? canonPath[canonPath.length - 1].id : null)
    setInstruction('')
    const taskId = enqueueTask({
      label: parentId ? '分岐生成' : afterId && nextSceneOf(afterId) ? '間のシーン生成' : 'シーン生成',
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
                void placeCreatedNode(newId)
                  .catch(() => undefined)
                  .then(() => {
                    // reload はこの runner を積んだ時点のインスタンスを握るため、
                    // 再マウント後も届くモジュールレベルの通知で反映する
                    notifyGraphChanged()
                    setSelectedId(newId)
                    setInspectorTab('beat')
                    focusWhenReady(newId)
                  })
              }
            },
            parentId,
            signal,
            afterId
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

  // チャット部品(memo)へ渡す props。参照を保たないと memo が効かない
  const nodesById = useMemo(() => Object.fromEntries(graphNodes.map((n) => [n.id, n])), [graphNodes])
  const productionSelectedNodeIds = useMemo(() => {
    if (workspace.mode !== 'structure') return []
    const ids = displayNodes.filter((n) => n.selected && n.type !== 'chapterNode').map((n) => n.id)
    return ids
  }, [workspace.mode, displayNodes])
  // 選択の中身が同じなら前の配列を返す(displayNodes はドラッグ・位置更新でも変わるため)
  const productionSelectedRef = useRef<string[]>([])
  const productionSelectedStable = useMemo(() => {
    const prev = productionSelectedRef.current
    const same = prev.length === productionSelectedNodeIds.length && prev.every((id, i) => id === productionSelectedNodeIds[i])
    if (!same) productionSelectedRef.current = productionSelectedNodeIds
    return productionSelectedRef.current
  }, [productionSelectedNodeIds])
  const productionChapterSelected = workspace.mode === 'structure' && displayNodes.some((n) => n.selected && n.type === 'chapterNode')
  // 制作の章レビュー候補の対象。シーン選択中は選択レビューを優先するので渡さない
  const productionChapterId = workspace.mode === 'structure' && productionSelectedStable.length === 0 ? (activeGroup?.id ?? null) : null
  const productionChapterTitle = activeGroup?.title ?? ''
  const productionChapter = useMemo(
    () => (productionChapterId ? { id: productionChapterId, title: productionChapterTitle } : null),
    [productionChapterId, productionChapterTitle]
  )
  const beforeProductionExecute = useStableCallback((): string | null =>
    workspace.libraryDirty.current
      ? '未保存の資料があります。保存してから制作を実行してください。'
      : beatDraftCache.size > 0
        ? '未保存のシーンがあります。保存してから制作を実行してください。'
        : null
  )
  const onProductionChanged = useStableCallback(async (operation: ProductionOperation): Promise<void> => {
    await reload(operation.node_id && (operation.action === 'insert_scene' || operation.action === 'branch_scene' || operation.connection?.mode === 'scene') ? await placeCreatedNode(operation.node_id) : undefined)
    workspace.changed()
    if (operation.action === 'delete_scene') setSelectedId((id) => id === operation.node_id ? null : id)
  })

  // React Flow へ渡すハンドラ。参照を固定し、中身だけ最新に追従させる(useStableCallback)
  // ノードを選んだらエッジ選択は解く(残すと Delete がエッジ切断に化ける)
  // ノード本体のクリックは、詳細欄を人物専用の表示からシーンの表示に戻す
  // (登場人物の札のクリックはここに伝えないので、人物の表示のまま)
  const onNodeClick = useStableCallback((): void => {
    setSelectedEdgeId(null)
    setInspectorFocus('scene')
  })
  // 章ノードのダブルクリックで章の中へ(章ビューのドリルダウン)
  const onNodeDoubleClick = useStableCallback((_: React.MouseEvent, node: Node): void => {
    if (node.type === 'chapterNode') setChapterView((node.data as ChapterNodeData).group.id)
  })
  const onConnect = useStableCallback((connection: Connection): void => void handleConnect(connection))
  const isValidConnectionStable = useStableCallback((connection: Edge | Connection): boolean =>
    isValidConnection(connection as Connection)
  )
  // エッジ選択は自前で持つ(onEdgesChange を渡していないため)
  const onEdgeClick = useStableCallback((_: React.MouseEvent, edge: Edge): void => setSelectedEdgeId(edge.id))
  const onEdgeDoubleClick = useStableCallback((_: React.MouseEvent, edge: Edge): void => void detachEdge(edge.id))
  const onPaneClick = useStableCallback((): void => {
    setSelectedEdgeId(null)
    setMenu(null)
  })
  // 右クリック: 選択中のノード群(右クリックしたノードを含む)に対する一括操作
  const onNodeContextMenu = useStableCallback((event: React.MouseEvent, node: Node): void => {
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
    // 章の入口 / 出口は配線するだけ(操作は章カードの右クリックにある)
    if (kind === 'chapter_in' || kind === 'chapter_out') return
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
  })
  const onSelectionContextMenu = useStableCallback((event: React.MouseEvent, nodes: Node[]): void => {
    event.preventDefault()
    // 章ノード(導出表示)とはじまり / 結末マーカーは一括操作の対象にしない
    const targets = nodes
      .filter((n) => n.type !== 'chapterNode' && !(n.data as BeatNodeData).storyNode?.kind)
      .map((n) => n.id)
    if (targets.length === 0) return
    setMenu({ x: event.clientX, y: event.clientY, targets })
  })
  const onPaneContextMenu = useStableCallback((event: React.MouseEvent | MouseEvent): void => {
    event.preventDefault()
    // 何もないところの右クリック: 追加系のメニュー(置く場所はこの位置)
    const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    setMenu({ x: event.clientX, y: event.clientY, targets: [], pane: flow })
  })
  // 章カードの上へシーンを運んでいる間だけ、カードを光らせる
  const onNodeDrag: OnNodeDrag<AppFlowNode> = useStableCallback((_, node, draggedNodes): void => {
    setDropTargetGroupId(chapterDropTarget(node, draggedNodes))
  })
  const onNodeDragStop: OnNodeDrag<AppFlowNode> = useStableCallback((_, node, draggedNodes): void => {
    // 章カードに落とした = その章に入れる(位置は保存しない。
    // カードの下に置いた座標はフラット表示では意味がないため)
    const dropGroupId = chapterDropTarget(node, draggedNodes)
    setDropTargetGroupId(null)
    if (dropGroupId) {
      void dropIntoChapter(
        dropGroupId,
        draggedNodes.filter((n) => n.type !== 'chapterNode').map((n) => n.id)
      )
      return
    }
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
    // 複数ノードをまとめて動かしたときも保存は 1 リクエスト
    void api
      .setNodePositions(beats.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })))
      .catch((e) => setGenStatus(`位置を保存できません: ${String(e)}`))
  })

  return (
    <div className="flex h-full flex-col">
      <div ref={rowRef} className="flex min-h-0 flex-1 flex-col">
        {/* 中央のキャンバス。詳細欄はこの下、共通チャットはAppの右ペインへ表示する */}
        <div ref={canvasColumnRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 制作中は書き換えだけを止める(writeLock.ts)。キャンバスの移動・拡大縮小・選択はできる */}
        <main ref={canvasRef} data-write-locked={productionEditingLocked ? 'true' : undefined} className="relative min-h-0 flex-1" style={{ background: 'var(--bg-canvas)' }}>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            // 画面に入っているカードだけ DOM に置く(100 枚規模の挿絵付きカードを
            // 全部描くと重い)。未測定のノードは測るために一度描かれるので、
            // 実測高さに頼る整列や焼き付けはこれまでどおり動く
            onlyRenderVisibleElements
            // 既定の Backspace 削除は API を通さず画面だけ消えてしまうため無効化し、
            // 削除は Delete キー(下の keydown ハンドラ)に集約する
            deleteKeyCode={null}
            // 矢印キーはシーン間の移動に使う。React Flow の既定(フォーカス中の
            // ノードを矢印で動かす a11y 操作)と衝突するので明示的に切る
            disableKeyboardA11y
            onNodesChange={handleNodesChange}
            // ハンドラは useStableCallback で参照を固定している(return の直前)。
            // 毎レンダー新しい関数を渡すと React Flow 内部の memo が外れ、
            // 画面に出ている全カード・全エッジが描き直される
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onSelectionChange={handleSelectionChange}
            // 制作中は、接続・切断・移動・右クリックの操作(どれも書き換え)を受け付けない
            onConnect={productionEditingLocked ? undefined : onConnect}
            isValidConnection={isValidConnectionStable}
            onEdgeClick={onEdgeClick}
            onEdgeDoubleClick={productionEditingLocked ? undefined : onEdgeDoubleClick}
            onPaneClick={onPaneClick}
            onNodeContextMenu={productionEditingLocked ? suppressContextMenu : onNodeContextMenu}
            onSelectionContextMenu={productionEditingLocked ? suppressContextMenu : onSelectionContextMenu}
            onPaneContextMenu={productionEditingLocked ? suppressContextMenu : onPaneContextMenu}
            nodesDraggable={!productionEditingLocked}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            minZoom={0.1}
            maxZoom={2}
            // ダブルクリックズームは章カードの「開く」と競合するので切る
            zoomOnDoubleClick={false}
            // 鑑賞モードからの復帰でフォーカス予約があるときは初期の全体表示を
            // 止める(描画が遅いと init の fitView が setCenter の後に走って、
            // 当てたフォーカスを全体表示で上書きすることがある)
            fitView={!pendingFocusId}
            panOnDrag={PAN_ON_DRAG}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            // ハンドルのドラッグで親子を繋げる(妥当性は isValidConnection で判定)。
            // 章カードのピンは章の先頭 / 末尾シーンに読み替える(resolveEndpoint)
            nodesConnectable={!productionEditingLocked}
            // ドラッグを背景のドットと同じグリッドに合わせる(設定でオフにできる)
            snapToGrid={gridSnap}
            snapGrid={SNAP_GRID}
            proOptions={PRO_OPTIONS}
          >
            <Background gap={GRID_SIZE} size={1.4} color="#394154" />
            {minimapVisible && <MiniMap pannable zoomable nodeColor="#2e3140" />}
            <Panel position="top-left" style={{ maxWidth: 'calc(100% - 32px)' }}>
              {/* 幅は中身に合わせる(パネルの領域はキャンバスのクリックを奪うため)。
                  生成パネルとステータスの幅は各要素側で持たせ、ツールバーの並びを潰さない */}
              <div className="flex w-fit max-w-full flex-col gap-2">
                {/* 章内ビューのパンくず(現在地を示すだけ。名前の変更は下段の章の詳細と、章カードの右クリックから) */}
                {effectiveView === 'focused' && focusedGroup && (
                  <div
                    className="flex w-fit max-w-full items-center gap-1.5 rounded-xl border px-2 py-1.5 text-[12px] shadow-lg shadow-black/30"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
                  >
                    <nav aria-label="現在の階層" data-view-ok className="flex min-w-0 items-center gap-1.5">
                      <button
                        onClick={() => setChapterView('chapters')}
                        className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-[var(--accent-soft)]"
                        style={{ color: 'var(--text-dim)' }}
                        data-tip="作品全体の章一覧へ戻る"
                      >
                        作品全体
                      </button>
                      <span aria-hidden="true" className="shrink-0" style={{ color: 'var(--text-faint)' }}>›</span>
                      <span aria-current="page" className="min-w-0 max-w-56 truncate font-medium" style={{ color: 'var(--text)' }}
                        data-tip={`${focusedGroup.on_canon ? `第${groups.indexOf(focusedGroup) + 1}章` : '別ルートの章'}「${focusedGroup.title}」`}>
                        {focusedGroup.on_canon ? `第${groups.indexOf(focusedGroup) + 1}章` : '別ルートの章'}「{focusedGroup.title}」
                      </span>
                    </nav>
                  </div>
                )}
                {/* ツールバー: 補助操作はアイコンだけにして面積を詰める。
                    下にステータスが出ても折り返さないよう、幅は中身なりに固定する */}
                <div className="flex w-fit gap-1.5 whitespace-nowrap">
                  {/* 章がある間だけ、章ビュー ⇄ 全シーンの切替を出す */}
                  {groups.length > 0 && effectiveView !== 'focused' && (
                    <button
                      data-view-ok
                      onClick={() => setChapterView((v) => (v === 'chapters' ? 'flat' : 'chapters'))}
                      className="rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                      style={{
                        background: effectiveView === 'chapters' ? 'var(--accent-soft)' : 'var(--bg-card)',
                        borderColor: effectiveView === 'chapters' ? 'var(--accent-border)' : 'var(--border-strong)',
                        color: 'var(--text-dim)'
                      }}
                      data-tip={
                        effectiveView === 'chapters'
                          ? '全シーンのフラット表示に切り替える'
                          : '章ビュー(章単位の俯瞰)に切り替える'
                      }
                    >
                      {effectiveView === 'chapters' ? '⊞ 全シーン' : '📖 章ビュー'}
                    </button>
                  )}
                  <button
                    data-view-ok
                    onClick={() => setCastView('table')}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    data-tip="キャラクタービュー(人物ごとの出番を表にして見る)に切り替える"
                  >
                    <Icon name="users" size={14} /> 人物
                  </button>
                  <button
                    onClick={() => void handleAddBeat()}
                    className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white shadow-lg shadow-black/30"
                    style={{ background: 'var(--accent)' }}
                    data-tip={
                      selectedId
                        ? '選択ノードの子としてシーンを追加'
                        : activeGroup
                          ? `「${activeGroup.title}」の末尾(出口の手前)にシーンを追加`
                          : '正史の末尾にシーンを追加'
                    }
                  >
                    + シーン
                  </button>
                  <button
                    // 章の中で作った島は、その章のシーンにする
                    onClick={() => void handleAddDetached(undefined, focusedGroup?.id)}
                    className="rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    aria-label="どこにも繋がらないシーンを追加"
                    data-tip={
                      focusedGroup
                        ? `どこにも繋がらないシーンを「${focusedGroup.title}」に追加(あとでハンドルのドラッグで繋げます)`
                        : 'どこにも繋がらないシーンを画面の中央に追加(あとでハンドルのドラッグで繋げます)'
                    }
                  >
                    ⊕
                  </button>
                  {selectedId && (
                    <button
                      onClick={() => void handleInsertAfter()}
                      className="flex items-center rounded-lg border px-2.5 py-2 shadow-lg shadow-black/30"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                      data-tip="選択ノードと後続シーンの間に新しいシーンを割り込ませる"
                      aria-label="選択ノードの後ろに割り込ませる"
                    >
                      <Icon name="insert" size={15} />
                    </button>
                  )}
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
                    data-tip={genPanelOpen ? '生成パネルを閉じる' : 'LLM でシーンを生成する'}
                  >
                    ▶ 生成 {genPanelOpen ? '▴' : '▾'}
                  </button>
                </div>
                {genPanelOpen && (
                  <div
                    className={`w-72 rounded-2xl border p-3 shadow-lg shadow-black/30 ${generating ? 'node-generating-border' : ''}`}
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
                          // 選んでいるシーンの直後へ。後続が居れば間のシーン、居なければ
                          // その続き(分岐の先端を選んでいれば、その枝が伸びる)
                          handleGenerate(null, selectedId)
                        }}
                        className="w-full rounded-lg px-3 py-1.5 text-[13px] font-medium text-white"
                        style={{ background: 'var(--accent)' }}
                        data-tip={
                          interpolateNext
                            ? `選択シーンと「${interpolateNext.title || '(無題)'}」の間に起こったことを推測して挟む`
                            : selectedNode
                              ? `「${selectedNode.title || '(無題)'}」の続きを生成`
                              : activeGroup
                                ? `「${activeGroup.title}」の末尾に次のシーンを生成`
                                : '物語の末尾に次のシーンを生成'
                        }
                      >
                        {interpolateNext ? '▶ 間のシーンを生成' : '▶ 次のシーンを生成'}
                      </button>
                      <button
                        onClick={() => {
                          setGenPanelOpen(false)
                          handleGenerate(selectedId)
                        }}
                        disabled={!selectedId}
                        className="accent-action w-full rounded-lg border px-3 py-1.5 text-[13px] font-medium disabled:opacity-40"
                        data-tip="選択ノードから what-if 分岐を draft として生成"
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
                            <ElapsedLabel active={generating} />
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
                    className={`flex w-72 items-start gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] leading-relaxed shadow-lg shadow-black/30 ${
                      generating ? 'node-generating-border' : ''
                    }`}
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                  >
                    <span className="min-w-0 flex-1">
                      {genStatus}
                      {generating && (
                        <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                          <ElapsedLabel active={generating} />
                        </span>
                      )}
                    </span>
                    {generating ? (
                      <button
                        onClick={() => genTaskIdRef.current && cancelTask(genTaskIdRef.current)}
                        className="shrink-0 rounded-md border px-1.5"
                        style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
                        aria-label="生成を中止"
                        data-tip="生成を中止"
                      >
                        ■
                      </button>
                    ) : (
                      <button
                        onClick={() => setGenStatus(null)}
                        className="shrink-0 px-1"
                        style={{ color: 'var(--text-faint)' }}
                        aria-label="表示を消す"
                        data-tip="表示を消す"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
              </div>
            </Panel>
            <Panel position="top-right">
              <button
                onClick={() => void realignLayout()}
                aria-label="ノードを整列"
                className="rounded-lg border px-2.5 py-1.5 text-[13px] shadow-lg shadow-black/30"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip={
                  effectiveView === 'chapters'
                    ? '章カードと未分類のノードだけを整列する(章の中は変えません)'
                    : effectiveView === 'focused'
                      ? selectedCount >= 2
                        ? `選択中の ${selectedCount} シーンだけを整列する`
                        : 'この章に見えているシーンだけを整列する(章の外は変えません)'
                      : selectedCount >= 2
                        ? `選択中の ${selectedCount} シーンだけを整列する`
                        : '手動配置をリセットして全体を自動レイアウトに戻す(複数選択中なら選択分だけ整列)'
                }
              >
                <Icon name="alignNodes" size={17} />
              </button>
            </Panel>
            {/* 詳細欄のトグルは左下(生成 UI と離し、ミニマップの反対側に置く) */}
            <Panel position="bottom-left">
              <button
                data-view-ok
                onClick={toggleInspector}
                className="flex h-10 w-10 items-center justify-center rounded-full border shadow-lg shadow-black/30"
                style={{
                  background: inspectorOpen ? 'var(--accent-soft)' : 'var(--bg-card)',
                  borderColor: inspectorOpen ? 'var(--accent-border)' : 'var(--border-strong)',
                  color: inspectorOpen ? 'var(--accent)' : 'var(--text-dim)'
                }}
                aria-label={inspectorOpen ? '詳細欄を閉じる' : '詳細欄を下段に開く'}
                data-tip={inspectorOpen ? '詳細欄を閉じる' : '詳細欄を下段に開く'}
              >
                <span className="text-[11px]">詳細</span>
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
          {/* キャラクタービュー: フローチャートの上に重ねる(React Flow は下で生きたままなので、
              選択・フォーカス・矢印キーの仕組みはそのまま使える)。見るだけの画面なので制作中も触れる */}
          {castView && (
            <div data-view-ok className="absolute inset-0 z-10 flex flex-col" style={{ background: 'var(--bg-canvas)' }}>
              <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
                <button
                  onClick={() => setCastView(null)}
                  className="shrink-0 whitespace-nowrap rounded-lg border px-2.5 py-1 text-[13px]"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  data-tip="フローチャート(シーンのつながり)に戻る"
                >
                  ⊞ フローチャート
                </button>
                <span className="shrink-0 whitespace-nowrap text-[13px] font-medium" style={{ color: 'var(--text)' }}>キャラクタービュー</span>
                <div className="flex shrink-0 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
                  {([['table', '出番表'], ['chain', '人物の鎖']] as const).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => setCastView(value)}
                      className="whitespace-nowrap px-2.5 py-0.5 text-[12px]"
                      style={castView === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
                      data-tip={value === 'table' ? '人物ごとの出番を表にして見る' : '人物の線がシーンを通り抜けていくノード図。線を差して登場させる'}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {castView === 'chain'
                    ? productionEditingLocked
                      ? '制作中は見るだけです(線の差し替えは制作が終わってから)'
                      : 'キャラクターやシーンの出口から入口へ線を引くと登場。線を選んで Delete かダブルクリックで外す。灰色の点線はシーンの順番(見るだけ。シーンをダブルクリックでフローチャートへ)'
                    : '横がシーン、縦が人物。縦線でつながっているセルは同じシーンに一緒に登場しています'}
                </span>
                {castView === 'chain' && !productionEditingLocked && (
                  <button
                    onClick={() => {
                      if (!window.confirm('人物の鎖の配置をすべて自動配置に戻します。よろしいですか?')) return
                      void api.resetChainLayout().then(() => reload()).catch((e) => setGenStatus(`配置を戻せません: ${String(e)}`))
                    }}
                    className="ml-auto shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    data-tip="手で動かした配置を捨てて、自動配置(左にキャラクター、正史順にシーン)に戻す"
                  >
                    ⟲ 整列
                  </button>
                )}
              </div>
              {castView === 'chain' ? (
                <div data-cast-chain className="min-h-0 flex-1">
                  <CastChainGraph
                    path={canonPath}
                    characters={characters}
                    groups={groups}
                    selectedNodeId={selectedId}
                    selectedCharId={inspectorFocus === 'character' ? libraryCharId : null}
                    readOnly={productionEditingLocked}
                    onSelectNode={selectSceneFromView}
                    onSelectChar={handleSelectChainChar}
                    onOpenInFlow={openSceneInFlow}
                    onCastChange={handleCastChange}
                    onPositionsChange={handleChainPositions}
                  />
                </div>
              ) : (
                <CharacterTimeline
                  path={canonPath}
                  hiddenCount={graphNodes.filter((n) => !n.kind).length - canonPath.length}
                  characters={characters}
                  groups={groups}
                  selectedNodeId={selectedId}
                  selectedChapterId={selectedChapterId}
                  onSelectNode={selectSceneFromView}
                  onSelectChapter={(groupId) => selectSceneFromView(`chapter:${groupId}`)}
                />
              )}
            </div>
          )}
          {/* 右クリックメニュー: 選択したシーンへの一括操作。説明はホバーのツールチップ、
              区切り線は group の切れ目(ContextMenu.tsx) */}
          {menu && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              heading={
                menu.pane
                  ? focusedGroup?.title ?? 'ここに追加'
                  : menu.chapter
                    ? (groups.find((g) => g.id === menu.chapter)?.on_canon
                        ? `第${groups.findIndex((g) => g.id === menu.chapter) + 1}章`
                        : '別ルートの章')
                    : menu.ending
                      ? '結末'
                      : `${menu.targets.length} シーンを選択中`
              }
              onPick={() => setMenu(null)}
              items={[
                ...(!menu.pane && !menu.chapter && !menu.ending ? [{
                  label: 'コピー',
                  hint: '選択したシーンと内部の接続をコピー',
                  shortcut: 'Ctrl+C',
                  group: 'edit',
                  run: () => void copyNodes(menu.targets)
                }] : []),
                {
                  label: menu.chapter ? 'この章に貼り付け' : '貼り付け',
                  hint: nodeClipboard ? '独立した枝として貼り付け' : '先にシーンをコピーしてください',
                  shortcut: 'Ctrl+V',
                  group: 'edit',
                  disabled: !nodeClipboard || productionEditingLocked,
                  run: () => void pasteNodes(menu.pane, menu.chapter)
                },
                ...(menu.pane
                  ? [
                      {
                        label: '＋ シーンを追加',
                        hint: selectedNode
                          ? '選択中のシーンの子として追加'
                          : activeGroup
                            ? `「${activeGroup.title}」の末尾(出口の手前)に追加`
                            : '正史の末尾(結末の手前)に追加',
                        group: 'add',
                        run: () => void handleAddBeat()
                      },
                      {
                        label: '⊕ 独立シーン(島)をここに',
                        hint: focusedGroup
                          ? 'どこにも繋がらないシーン。この章のシーンになります'
                          : 'どこにも繋がらないシーン。あとでドラッグして繋げます',
                        group: 'add',
                        // 章の中で作った島はその章のものにする
                        run: () => void handleAddDetached(menu.pane, focusedGroup?.id)
                      },
                      {
                        label: '🏁 結末をここに置く',
                        hint: 'シーンの右のハンドルからドラッグしてつなげます',
                        group: 'add',
                        run: () => void createFloatingEndingAt(menu.pane!)
                      },
                      {
                        label: '📖 空の章をここに作る',
                        hint: '器を先に置いて、中身は後から書く(章の中で作れます)',
                        group: 'add',
                        run: () => createEmptyChapter(menu.pane)
                      },
                      ...(focusedGroup ? [{
                        label: '章を解除',
                        hint: `「${focusedGroup.title}」のシーンは残して、章のまとまりを解除します`,
                        group: 'danger',
                        disabled: productionEditingLocked,
                        run: () => void dissolveChapter(focusedGroup)
                      }] : [])
                    ]
                  : menu.chapter
                  ? ((): ContextMenuItem[] => {
                      const group = groups.find((g) => g.id === menu.chapter)
                      if (!group) return []
                      // 並べ替えは正史ルート上の章同士でだけ意味を持つ
                      const canonGroups = groups.filter((g) => g.on_canon)
                      const ci = canonGroups.findIndex((g) => g.id === group.id)
                      return [
                        {
                          label: '章の中を開く',
                          hint: 'ダブルクリックと同じ',
                          group: 'nav',
                          run: () => setChapterView(group.id)
                        },
                        ...(group.on_canon
                          ? [
                              {
                                label: '← 前へ移動',
                                hint: ci <= 0 ? '先頭の章です' : '一つ前の章と入れ替える(カードの位置も入れ替わります)',
                                group: 'nav',
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
                                hint:
                                  ci >= canonGroups.length - 1
                                    ? '末尾の章です'
                                    : '一つ後ろの章と入れ替える(カードの位置も入れ替わります)',
                                group: 'nav',
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
                          group: 'chapter',
                          run: () => renameChapter(group)
                        },
                        {
                          label: '章を解除',
                          hint: 'シーンは残して、章のまとまりを解除します',
                          group: 'chapter',
                          disabled: productionEditingLocked,
                          run: () => void dissolveChapter(group)
                        },
                        {
                          label: '章と中のシーンを削除',
                          hint: '枝・未接続シーンも含めて削除',
                          group: 'danger',
                          run: () => void deleteNodes([], [group.id])
                        }
                      ]
                    })()
                  : menu.ending
                  ? [
                      {
                        label: '🏁 この結末にする',
                        hint: 'ここまでの道を正史にする',
                        group: 'route',
                        run: () => void makeRouteCanon(menu.targets[0])
                      },
                      {
                        label: '名前を変更',
                        hint: '「トゥルーエンド」など',
                        group: 'chapter',
                        run: () => renameEnding(menu.targets[0])
                      },
                      {
                        label: '削除',
                        hint: '結末の候補を消す(最後の 1 つは消せない)',
                        group: 'danger',
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
                          group: 'add',
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
                          group: 'add',
                          run: () => void createEndingAt(menu.targets[0])
                        }
                      ]
                    : []),
                  // 間のシーンを生成: 後続シーンのある単一シーンで(補間。
                  // docs/design/interpolation.md)。前後の内容から間の出来事を推測する
                  ...((): ContextMenuItem[] => {
                    if (menu.targets.length !== 1) return []
                    const node = graphNodes.find((n) => n.id === menu.targets[0])
                    if (!node || node.kind) return []
                    const next = nextSceneOf(node.id)
                    if (!next) return []
                    return [
                      {
                        label: '▶ 間のシーンを生成',
                        hint: `「${next.title || '(無題)'}」との間に起こったことを推測して挟む`,
                        group: 'add',
                        run: () => handleGenerate(null, node.id)
                      }
                    ]
                  })(),
                  // 章の道(ルート)の差し替え: **章の中で**分岐のシーンを右クリックしたとき。
                  // 出口の繋ぎ替えとして扱う(島の章で正史を巻き込まないよう、正史を
                  // 追従させるかはサーバー側が判断する)。
                  // 章の外の「★ この道を正史にする」は削除した(2026-08-02 ユーザー判断)。
                  // 正史はアクティブな結末から遡った道なので、決めるのは「どの結末か」だけ。
                  // 切替は結末ノードの右クリックに一本化する
                  ...((): ContextMenuItem[] => {
                    if (menu.targets.length !== 1 || !focusedGroup) return []
                    const node = graphNodes.find((n) => n.id === menu.targets[0])
                    if (!node || node.kind || node.status !== 'draft') return []
                    return [
                      {
                        label: '★ この枝を章の道にする',
                        hint: '章の出口をこの枝に繋ぎ替えます(鑑賞モードとまとめもこの道になります)',
                        group: 'chapter',
                        run: () => void setChapterRoute(focusedGroup.id, node.id)
                      }
                    ]
                  })(),
                  // 章に入れる: 未分類のシーンが章の端に隣接しているときだけ出す
                  // (章の中で書いたのに未分類のまま残ったシーンを拾い直す)
                  ...((): ContextMenuItem[] => {
                    if (menu.targets.length !== 1) return []
                    const node = graphNodes.find((n) => n.id === menu.targets[0])
                    if (!node || node.group_id || node.kind) return []
                    const parentId = graphEdges.find((e) => e.to_node === node.id)?.from_node ?? null
                    const childIds = graphEdges.filter((e) => e.from_node === node.id).map((e) => e.to_node)
                    const target =
                      groups.find((g) => g.route.at(-1) === parentId) ??
                      groups.find((g) => childIds.includes(g.route[0]))
                    if (!target) return []
                    return [
                      {
                        label: '📖 この章に入れる',
                        hint: `「${target.title}」のシーンにする(後ろに続くシーンも一緒に)`,
                        group: 'chapter',
                        run: () => void addToChapter(node.id, target.id)
                      }
                    ]
                  })(),
                  // 章の表紙: 挿絵のある章内のシーンを右クリックしたときだけ出す
                  ...((): ContextMenuItem[] => {
                    if (menu.targets.length !== 1) return []
                    const node = graphNodes.find((n) => n.id === menu.targets[0])
                    if (!node?.group_id || !node.image_path) return []
                    const group = groups.find((g) => g.id === node.group_id)
                    if (!group) return []
                    return group.cover_node_id === node.id
                      ? [
                          {
                            label: '🖼 表紙をやめる',
                            hint: '章の表紙を自動(先頭の挿絵)に戻す',
                            group: 'chapter',
                            run: () => void setChapterCover(group.id, null)
                          }
                        ]
                      : [
                          {
                            label: '🖼 この挿絵を章の表紙にする',
                            hint: `「${group.title}」の章カードのサムネイルにする`,
                            group: 'chapter',
                            run: () => void setChapterCover(group.id, node.id)
                          }
                        ]
                  })(),
                  ...(menu.targets.length === 1 && graphNodes.find((n) => n.id === menu.targets[0])?.group_id
                    ? [
                        {
                          label: '章から外す',
                          hint: '章の端(先頭・末尾)のシーンだけ外せます',
                          group: 'chapter',
                          run: () => void removeFromChapter(menu.targets[0])
                        }
                      ]
                    : []),
                  {
                    label: 'イベントを作り直す',
                    hint: `選択した ${menu.targets.length} シーンだけ(親から順に。この先は変えない)`,
                    group: 'llm',
                    run: () => void runReextractNodes(menu.targets, false)
                  },
                  // この先も作り直す: 選択の先に何も無ければ上の項目と同じになるので出さない
                  ...((): ContextMenuItem[] => {
                    const ahead = withDownstream(menu.targets).length - menu.targets.length
                    if (ahead === 0) return []
                    return [
                      {
                        label: 'イベントを作り直す(この先すべて)',
                        hint: `選択 ${menu.targets.length} + この先 ${ahead} シーン。分岐も章もまたいで結末まで`,
                        group: 'llm',
                        run: () => void runReextractNodes(menu.targets, true)
                      }
                    ]
                  })(),
                  {
                    label: '清書し直す(上書き)',
                    hint: renderStyle.presetId
                      ? `${renderStyle.preset?.name ?? '未設定'}${
                          renderStyle.povChar ? ` / POV: ${nameOfChar(renderStyle.povChar)}` : ''
                        } — 清書済みのシーンも作り直す`
                      : '清書タブでスタイルプリセットを選んでください',
                    group: 'llm',
                    disabled: !renderStyle.presetId,
                    run: () => void runRenderNodes(menu.targets)
                  },
                  {
                    label: '話者と感情を付ける',
                    hint: renderStyle.presetId
                      ? `読み上げの台本に LLM で。${renderStyle.preset?.name ?? '未設定'}${
                          renderStyle.povChar ? ` / POV: ${nameOfChar(renderStyle.povChar)}` : ''
                        } の清書 — 付け済みのシーンは飛ばす(シーンごとにキューへ)`
                      : '清書タブでスタイルプリセットを選んでください',
                    group: 'llm',
                    disabled: !renderStyle.presetId,
                    run: () => void runAnnotateNodes(menu.targets, false)
                  },
                  {
                    label: '話者と感情を付け直す',
                    hint: renderStyle.presetId
                      ? '付け済みのシーンも付け直す(台本で手直しした行はそのまま)'
                      : '清書タブでスタイルプリセットを選んでください',
                    group: 'llm',
                    disabled: !renderStyle.presetId,
                    run: () => void runAnnotateNodes(menu.targets, true)
                  },
                  {
                    label: 'まとめて切り離す',
                    hint: '親エッジを切って島にする',
                    group: 'danger',
                    run: () => void detachNodes(menu.targets)
                  },
                  {
                    label: 'まとめて削除',
                    hint: '後続シーンは前のシーンに繋がる',
                    group: 'danger',
                    run: () => void deleteNodes(menu.targets)
                  }
                ] as ContextMenuItem[]))
              ] as ContextMenuItem[]}
            />
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
        </div>
        {chatHost && createPortal(<div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-chat)' }}>
              <div className="flex shrink-0 items-center gap-2 border-b px-6 py-1" style={{ background: 'var(--bg-chat)', borderColor: 'var(--border)' }}>
                <div className="flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
                  {([['consult', '相談'], ['production', '制作']] as const).map(([value, label]) => (
                    <button key={value} disabled={productionLocked} onClick={() => setChatKind(value)}
                      className="px-3 py-1 text-[13px] disabled:opacity-50"
                      style={chatKind === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
                      data-tip={productionLocked ? '制作が終わるか停止してから切り替えられます' : value === 'consult' ? '作品を変更せずに相談します' : '会話からシーンを作成・編集する実験機能'}>{label}</button>
                  ))}
                </div>
                {productionLocked && <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{productionManual ? '一時停止中(手動編集)・保存後に制作を再開できます' : '手動編集は制作チャットで一時停止してから行えます'}</span>}
              </div>
              <div className="min-h-0 flex-1" hidden={chatKind !== 'consult'}>
              <ChatDrawer
                open={chatOpen && workspace.mode !== 'reader' && chatKind === 'consult'}
                anchorCandidateId={chatAnchorId}
                canonTailId={canonPath.length > 0 ? canonPath[canonPath.length - 1].id : null}
                nodesById={nodesById}
                characters={characters}
                dynamicSuggestions={chatDynamicSuggestions}
              />
              </div>
              <div className="min-h-0 flex-1" style={{ display: chatKind === 'production' ? 'flex' : 'none' }}><ProductionChat
                policy={productionPolicy} setPolicy={setProductionPolicy}
                nodes={graphNodes} groups={groups}
                selectedNodeIds={productionSelectedStable}
                chapterSelected={productionChapterSelected}
                chapter={productionChapter}
                active={chatOpen && chatKind === 'production' && workspace.mode !== 'reader'}
                beforeExecute={beforeProductionExecute}
                onManualEdit={setProductionManual}
                onFollowTarget={followProductionTarget}
                onChanged={onProductionChanged}
              /></div>
        </div>, chatHost)}
        {/* 詳細欄の分割線: 1pxの線と上下3pxの当たり判定 */}
        <div
          className="relative h-px shrink-0 cursor-row-resize transition-colors hover:bg-[var(--accent-border)]"
          style={{ background: 'var(--border)', display: inspectorOpen ? undefined : 'none' }}
          data-tip="ドラッグで詳細欄の高さを変更"
        >
          <div
            onPointerDown={beginInspectorResize}
            role="separator" aria-label="詳細欄の高さ" aria-orientation="horizontal"
            className="absolute inset-x-0 z-10 cursor-row-resize"
            style={{ top: -3, bottom: -3 }}
          />
        </div>
        <aside
          inert={!inspectorOpen}
          data-write-locked={productionEditingLocked ? 'true' : undefined}
          className="flex shrink-0 flex-col"
          style={{ background: 'var(--bg-sidebar)', height: inspectorOpen ? inspectorHeight : 0, maxHeight: '70%', overflow: 'hidden' }}
        >
          <div data-view-ok className="flex shrink-0 items-center gap-1 border-b px-5 py-2" style={{ borderColor: 'var(--border)' }}>
            {inspectorFocus === 'character' && focusCharacter ? (
              <>
                {/* 人物専用の表示: 誰を見ているかを先頭に出し、タブは人物のもの(シーン・清書は出さない) */}
                <span className="mr-2 flex min-w-0 items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text)' }}
                  data-tip="人物の鎖で選んだ人物。シーンを選ぶとシーンの表示に戻ります">
                  <CharAvatar char={focusCharacter} size={20} />
                  <span className="max-w-40 truncate">{focusCharacter.name}</span>
                </span>
                {(
                  [
                    { id: 'profile', label: 'プロフィール' },
                    { id: 'state', label: '状態' },
                    { id: 'graph', label: '関係図' },
                    { id: 'facts', label: '事実の履歴' }
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setCharTab(t.id)}
                    className="rounded-md px-3 py-1 text-[12px]"
                    style={charTab === t.id ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
                  >
                    {t.label}
                  </button>
                ))}
              </>
            ) : (
              [
                { id: 'beat', label: activeGroup ? '章' : 'シーン' },
                { id: 'render', label: '清書' },
                { id: 'char', label: 'キャラ' },
                { id: 'graph', label: '関係図' },
                { id: 'facts', label: '事実' }
              ] as const
            ).filter((t) => !activeGroup || (t.id !== 'render' && t.id !== 'char')).map((t) => (
              <button
                key={t.id}
                onClick={() => setInspectorTab(t.id)}
                className="rounded-md px-3 py-1 text-[12px]"
                style={
                  shownTab === t.id
                    ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                    : { color: 'var(--text-dim)' }
                }
              >
                {t.label}
              </button>
            ))}
            <button onClick={toggleInspector} className="ml-auto rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }} data-tip="詳細欄を折りたたむ">閉じる</button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {inspectorFocus === 'character' && focusCharacter ? (
              // ---- 人物専用の表示 ----
              charTab === 'profile' ? (
                // 資料庫と同じ編集画面。削除は資料庫に限定する(onDeleted を渡さない)。保存後は構造も資料庫も読み直す
                <div className="min-h-0 min-w-0 flex-1 overflow-hidden px-5 pt-3">
                  <CharacterEditor
                    key={focusCharacter.id}
                    character={focusCharacter}
                    onChanged={async () => {
                      await reload()
                      workspace.changed() // 資料庫側も次に開いたとき読み直す
                    }}
                  />
                </div>
              ) : !charPointNode || !charPointPath ? (
                <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                  {focusCharacter.name}はまだ正史のシーンに登場していません。
                  <br />
                  人物の鎖でシーンの入口へ線を引くと、その時点の{charTab === 'state' ? '状態' : charTab === 'graph' ? '関係' : '事実'}が見られます
                </div>
              ) : (
                <>
                  {/* どの時点を見ているか */}
                  <div className="shrink-0 border-b px-5 py-1 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--text-faint)' }}>
                    「{charPointNode.title || '無題'}」の時点
                    {charPointNode.id !== selectedId && '(この人物が最後に登場したシーン)'}
                  </div>
                  {charTab === 'state' ? (
                    <CharTab
                      key={`${focusCharacter.id}:${charPointNode.id}`}
                      node={charPointNode}
                      characters={characters}
                      memoryContents={memoryContents}
                      onChanged={() => void reload()}
                      onSelectNode={selectSceneFromView}
                      focusChar={{ id: focusCharacter.id, seq: 0 }}
                      lockChar
                    />
                  ) : charTab === 'graph' ? (
                    <div data-view-ok className="contents">
                      <RelationGraph detailLayout autoFit
                        characters={characters}
                        path={charPointPath}
                        allNodes={graphNodes}
                        onCharactersChanged={() => void reload()}
                        egoCharId={focusCharacter.id}
                        onEgoChange={() => undefined}
                      />
                    </div>
                  ) : (
                    <FactTimeline
                      path={charPointPath}
                      characters={characters}
                      selectedNodeId={charPointNode.id}
                      onSelectNode={selectSceneFromView}
                      fixedTarget={focusCharacter.id}
                    />
                  )}
                </>
              )
            ) : (
            <>
            {activeGroup && (shownTab === 'graph' || shownTab === 'facts') && (
              // どの時点を見ているか。章のときは選んだシーンが無いので明示する
              <div className="shrink-0 border-b px-5 py-1 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--text-faint)' }}>
                {chapterEndPath
                  ? `第${groups.indexOf(activeGroup) + 1}章「${activeGroup.title}」の終わり(「${chapterEndPath.at(-1)?.title || '無題'}」)まで`
                  : `第${groups.indexOf(activeGroup) + 1}章「${activeGroup.title}」にはまだシーンがありません`}
              </div>
            )}
            {activeGroup && !chapterEndPath && (shownTab === 'graph' || shownTab === 'facts') ? (
              <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                章にシーンを追加すると、章の終わりの時点の{shownTab === 'graph' ? '関係' : '事実'}を表示します
              </div>
            ) : shownTab === 'graph' ? (
              // 関係図の絞り込み・履歴は見るための操作(図の上の配置の保存だけ、制作中は行われない)
              <div data-view-ok className="contents">
              <RelationGraph detailLayout autoFit
                characters={characters}
                path={(activeGroup ? chapterEndPath : pathToSelected) ?? canonPath}
                allNodes={graphNodes}
                onCharactersChanged={() => void reload()}
              />
              </div>
            ) : shownTab === 'facts' ? (
              <FactTimeline
                path={(activeGroup ? chapterEndPath : pathToSelected) ?? canonPath}
                characters={characters}
                selectedNodeId={activeGroup ? chapterEndId : selectedId}
                onSelectNode={(nodeId) => focusNodeOnCanvas(nodeId)}
              />
            ) : activeGroup ? (
              <ChapterTab
                // 章を切り替えたら state ごと作り直す(使い回すと、前の章の
                // まとめの取得が遅れて届いたとき別の章のまとめとして表示・保存される)
                key={activeGroup.id}
                group={activeGroup}
                number={groups.indexOf(activeGroup) + 1}
                nodes={graphNodes}
                characters={characters}
                onSelectScene={(nodeId) => {
                  // 章ビューから選んだ場合は章の中に入ってから選択する
                  if (effectiveView === 'chapters') setChapterView(activeGroup.id)
                  // 章の中に入ってから現れるので、描画されるのを待って選択する
                  focusWhenReady(nodeId)
                }}
                onChanged={() => void reload()}
                onRename={() => void renameChapter(activeGroup)}
                onDissolve={() => void dissolveChapter(activeGroup)}
                onSetCover={(nodeId) => void setChapterCover(activeGroup.id, nodeId)}
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
                        onClick={() => void makeRouteCanon(selectedNode.id)}
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
                  aiProtected={productionPolicy.protected_ids.includes(selectedNode.id)}
                  protectionLocked={productionLocked}
                  onToggleProtection={() => {
                    if (productionLocked) return
                    const id = selectedNode.id
                    setProductionPolicy((current) => ({ ...current,
                      protected_ids: current.protected_ids.includes(id)
                        ? current.protected_ids.filter((value) => value !== id)
                        : [...current.protected_ids, id] }))
                  }}
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
                  onSelectNode={(nodeId) => focusNodeOnCanvas(nodeId)}
                  focusChar={focusChar}
                />
              )
            ) : (
              <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                ノードを選択してください
              </div>
            )}
            </>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

// memo: App はタスクの進捗や通知のたびに再レンダーされるが、props が同じなら
// 5,000 行規模のこのモードを再実行しない(props の関数は App 側で参照が固定されている)
export default memo(StructureMode)

function StructureMode({
  settingsVersion = 0,
  focusNodeId,
  onSelectedNodeChange,
  onSelectionCountChange,
  onReaderScopeChange
}: {
  settingsVersion?: number
  /** 開いたときにフォーカスするシーン(鑑賞モードで読んでいたシーン) */
  focusNodeId?: string | null
  /** 選択シーンを親に伝える(鑑賞モードを開いたときにそこへ飛ぶため) */
  onSelectedNodeChange?: (nodeId: string | null) => void
  /** 範囲選択しているシーン数を親に伝える(ステータスバーの表示用) */
  onSelectionCountChange?: (count: number) => void
  /** いま見ている章を親に伝える(鑑賞モードを開いたときのスコープ。null = 全体) */
  onReaderScopeChange?: (groupId: string | null) => void
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <StructureModeInner
        settingsVersion={settingsVersion}
        focusNodeId={focusNodeId}
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectionCountChange={onSelectionCountChange}
        onReaderScopeChange={onReaderScopeChange}
      />
    </ReactFlowProvider>
  )
}
