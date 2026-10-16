import { memo, useSyncExternalStore } from 'react'
import { Handle, Position, useStore, type Node, type NodeProps, type ReactFlowState } from '@xyflow/react'
import { assetUrl, isVideoAsset } from '../../api'
import { useProductionPreview } from '../../productionPreview'
import type { Character, Group, StoryNode } from '../../types'
import { beatDraftCache, subscribeBeatDrafts } from './beatDrafts'
import { GRID_SIZE } from './layout'

// ---- カスタムノード --------------------------------------------------

/** カード上の挿絵(シーンカード / 章カードの表紙で共用)。挿絵が無ければ何も出さない。
 *
 *  グラフ上のカードは小さな静止画で足りるので、保存済みのサムネイルを出す
 *  (thumbs.backfillThumbs が生成する)。まだ無い場合、動画は動画要素で先頭フレームを、
 *  静止画は原画をそのまま見せ、生成が終わって reload されたらサムネイルに切り替わる
 */
export function NodeThumb({
  node,
  className,
  style
}: {
  node: StoryNode
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element | null {
  const src = assetUrl(node.image_path)
  if (!src) return null
  const thumb = assetUrl(node.thumb_path)
  if (isVideoAsset(node.image_path)) {
    return thumb ? (
      <img src={thumb} decoding="async" className={className} style={style} />
    ) : (
      <video src={src} preload="metadata" muted playsInline className={className} style={style} />
    )
  }
  return <img src={thumb ?? src} decoding="async" className={className} style={style} />
}

export type BeatNodeData = {
  storyNode: StoryNode
  connected: boolean // 表示範囲によらず、実グラフに入出力の接続があるか
  characters: Record<string, Character>
  // 実効ロケーション。inherited = このシーンでは指定せず、親から引き継いだもの
  place?: { name: string; inherited: boolean }
  busy?: boolean // LLM 処理中(枠が時計まわりに光る)
  /** 登場人物の札をクリック → このシーンを選び、詳細欄を人物専用の表示にする */
  onSelectChar?: (charId: string, sceneId: string) => void
}

export type BeatFlowNode = Node<BeatNodeData, 'beatNode'>

// ---- ズームアウト時のタイトル表示 ----------------------------------------
//
// 引いて全体を眺めるとカード内の 13px 文字は読めなくなるので、しきい値を下回ったら
// カードの上に画面上で一定サイズのラベルを出す(1/zoom で拡大して打ち消す)。
// カード本体やハンドルの位置は変えないので、レイアウトや線は影響を受けない。

/** これ以下に引いたらカードの上にタイトルを出す */
const ZOOMED_OUT_TITLE_ZOOM = 0.5
const selectZoom = (s: ReactFlowState): number => s.transform[2]

function ZoomedOutTitle({ title }: { title: string }): React.JSX.Element | null {
  const zoom = useStore(selectZoom)
  if (zoom > ZOOMED_OUT_TITLE_ZOOM || !title) return null
  const scale = 1 / zoom
  return (
    <div
      className="pointer-events-none absolute bottom-full left-1/2 mb-2 max-w-[640px] truncate rounded-lg px-3 py-1 text-[13px] font-semibold"
      style={{
        transform: `translateX(-50%) scale(${scale})`,
        transformOrigin: 'bottom center',
        background: 'color-mix(in srgb, var(--bg-card) 85%, transparent)',
        color: 'var(--text)',
        whiteSpace: 'nowrap'
      }}
    >
      {title}
    </div>
  )
}

export function BeatNodeCard({ data, selected }: NodeProps<BeatFlowNode>): React.JSX.Element {
  const { storyNode, characters, place, busy, connected, onSelectChar } = data
  const preview = useProductionPreview(storyNode.id)
  const unsaved = useSyncExternalStore(subscribeBeatDrafts, () => beatDraftCache.has(storyNode.id))
  const isDraft = storyNode.status === 'draft'
  // 章の入口 / 出口(ノードグループの Input / Output。docs/design/chapters.md §9)
  if (storyNode.kind === 'chapter_in' || storyNode.kind === 'chapter_out') {
    const isIn = storyNode.kind === 'chapter_in'
    return (
      <div
        className={`relative w-40 rounded-2xl border-2 border-dashed px-4 py-3 text-center shadow-lg shadow-black/30 ${
          selected ? 'ring-4' : ''
        }`}
        style={{
          background: 'var(--bg-card)',
          borderColor: 'var(--accent-border)',
          ['--tw-ring-color' as string]: 'var(--accent-border)'
        }}
        data-tip={
          isIn
            ? '章の入口。前の章(や前のシーン)からの線はここに繋ぐ'
            : '章の出口。ここに繋がっている道が、この章の読む道になる'
        }
      >
        <ZoomedOutTitle title={isIn ? '章の入口' : '章の出口'} />
        <Handle type="target" position={Position.Left} />
        <div className="text-[15px]">{isIn ? '⇥' : '↦'}</div>
        <div className="mt-0.5 text-[11px] font-semibold" style={{ color: 'var(--text-dim)' }}>
          {isIn ? '章の入口' : '章の出口'}
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    )
  }
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
          // アクティブでない結末も淡くしない(破線と「アクティブ」表示で足りる)
          borderStyle: active ? 'solid' : 'dashed',
          ['--tw-ring-color' as string]: 'var(--accent-border)'
        }}
        data-tip={
          isEnding
            ? active
              ? 'アクティブな結末(ここまでが正史)'
              : '結末の候補。右クリック →「この結末にする」で正史を切り替え'
            : '物語のはじまり(最初のシーンはこの子としてつながる)'
        }
      >
        {/* はじまりに親は繋げず、結末から先も繋げない(サーバーが拒否する)。
            不可能な側のハンドルは出さず、ドラッグ自体を始めさせない */}
        <ZoomedOutTitle title={storyNode.title || (isEnding ? '結末' : 'はじまり')} />
        {isEnding && <Handle type="target" position={Position.Left} />}
        <div className="text-[16px]">{isEnding ? '🏁' : '📖'}</div>
        <div className="mt-0.5 truncate text-[12px] font-semibold" style={{ color: 'var(--text)' }}>
          {storyNode.title || (isEnding ? '結末' : 'はじまり')}
        </div>
        {isEnding && active && (
          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--accent)' }}>
            アクティブ
          </div>
        )}
        {!isEnding && <Handle type="source" position={Position.Right} />}
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
        // 正史でないシーンは**破線とバッジだけ**で示し、淡くしない。分岐ルートも
        // 書きかけの本編であって「無効な項目」ではないため(2026-08-11 ユーザー判断)
        borderStyle: isDraft ? 'dashed' : 'solid',
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
    >
      <ZoomedOutTitle title={storyNode.title || '(無題のシーン)'} />
      {/* 当たり判定と見た目は index.css の .react-flow__handle で調整している */}
      <Handle type="target" position={Position.Left} />
      <NodeThumb node={storyNode} className="mx-auto mb-2 max-h-40 max-w-full rounded-xl" />
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
          {storyNode.title || '(無題のシーン)'}
        </span>
        {preview && <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}>AI編集中</span>}
        {unsaved && (
          <span
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}
            data-tip="このシーンには未保存の変更があります"
          >
            未保存
          </span>
        )}
        {isDraft && (
          <span
            className="shrink-0 rounded px-1.5 py-px text-[10px]"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-faint)' }}
            data-tip={connected ? '正史ルート以外につながっているシーンです' : '他のノードと接続されていないシーンです'}
          >
            {connected ? '分岐' : '未接続'}
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
            // nodrag: 札を押してもカードのドラッグ・選択を始めない。クリックもカードに伝えない
            <button
              key={charId}
              className="nodrag inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] hover:bg-[var(--accent-soft)]"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}
              onClick={(e) => {
                e.stopPropagation()
                onSelectChar?.(charId, storyNode.id)
              }}
              data-tip={`${c?.name ?? charId}。クリックでこのシーンを選び、下の詳細欄にこの人物を出す`}
            >
              {portrait ? (
                <img src={portrait} className="h-3.5 w-3.5 rounded-full object-cover" />
              ) : (
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: c?.color ?? '#8a8fa8' }} />
              )}
              {c?.name ?? charId}
            </button>
          )
        })}
        {place && (
          // 引き継ぎ(このシーンでは未指定)は淡く出して、自分で指定した場所と区別する
          <span
            className="text-[11px]"
            style={{ color: 'var(--text-faint)', opacity: place.inherited ? 0.55 : 1 }}
            data-tip={place.inherited ? '前のシーンから引き継いだ場所' : undefined}
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

export type ChapterNodeData = {
  group: Group
  number: number
  /** シーンをこのカードの上へ運んでいる(離すとその章に入る) */
  dropTarget?: boolean
  /** 表紙にするシーン(cover_node_id の指定 → 無ければ章内で最初に挿絵があるシーン) */
  cover: StoryNode | null
  onOpen: (groupId: string) => void
}
export type ChapterFlowNode = Node<ChapterNodeData, 'chapterNode'>
export type AppFlowNode = BeatFlowNode | ChapterFlowNode

/** 章の表紙にするシーンを決める。作者が指定していればそれを優先し、
 *  指定が無い(または指定シーンの挿絵が外された)ときは章内で最初に挿絵があるシーン。 */
export function chapterCoverNode(group: Group, nodeById: Map<string, StoryNode>): StoryNode | null {
  const picked = group.cover_node_id ? nodeById.get(group.cover_node_id) : undefined
  if (picked?.image_path) return picked
  for (const id of group.node_ids) {
    const node = nodeById.get(id)
    if (node?.image_path) return node
  }
  return null
}

export function ChapterNodeCard({ data, selected }: NodeProps<ChapterFlowNode>): React.JSX.Element {
  const { group, number, cover, dropTarget, onOpen } = data
  return (
    <div
      className={`relative w-64 rounded-3xl border-2 px-5 py-5 shadow-lg shadow-black/30 ${
        selected || dropTarget ? 'ring-4' : ''
      }`}
      style={{
        background: dropTarget ? 'var(--accent-soft)' : 'var(--bg-card)',
        borderColor: dropTarget ? 'var(--accent)' : group.color || 'var(--border-strong)',
        // 島・分岐の章は draft ノードと同じく破線で「別の可能性」を示す
        // (淡くはしない。見出しの「別ルートの章」と破線で足りる)
        borderStyle: group.on_canon ? 'solid' : 'dashed',
        ['--tw-ring-color' as string]: 'var(--accent-border)'
      }}
      data-tip="ダブルクリックで章の中を開く(シーンをここに落とすとこの章に入ります)"
      onDoubleClick={(e) => {
        // React Flow のダブルクリックズームに任せず、カード自身で確実に開く
        e.stopPropagation()
        onOpen(group.id)
      }}
    >
      <ZoomedOutTitle title={group.on_canon ? `第${number}章 ${group.title}` : group.title} />
      <Handle type="target" position={Position.Left} />
      {/* 表紙。シーンカードと同じく、切り抜かずに元の比率のまま収める */}
      {cover && <NodeThumb node={cover} className="mx-auto mb-3 max-h-40 max-w-full rounded-xl" />}
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
            data-tip={group.warning}
          >
            ⚠ 要確認
          </span>
        )}
        {group.has_digest &&
          (group.digest_stale ? (
            <span
              className="rounded px-1.5 py-px text-[10px]"
              style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
              data-tip="章の中が編集されたので、まとめが古くなっている可能性があります"
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

// カードは memo する。data の参照は再構築 effect 側で保っているので、変わった
// カードだけが描き直される
export const nodeTypes = { beatNode: memo(BeatNodeCard), chapterNode: memo(ChapterNodeCard) }
// React Flow に渡す定数。毎レンダー新しい配列・オブジェクトを渡すと内部の memo が外れる
export const PAN_ON_DRAG = [1]
export const SNAP_GRID: [number, number] = [GRID_SIZE, GRID_SIZE]
export const PRO_OPTIONS = { hideAttribution: true }
