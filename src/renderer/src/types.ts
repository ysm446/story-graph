export interface Character {
  id: string
  name: string
  profile: string | null
  appearance: string | null
  voice: string | null
  color: string | null
  graph_x: number | null
  graph_y: number | null
  portrait_path: string | null
  portrait_source_path: string | null
  portrait_crop: string | null
  created_at: string
}

/** 場所。キャラクターと同型の登録制エンティティ(docs/design/places.md)。
 *  シーンは 1 つだけ参照し、空欄なら親から引き継ぐ。 */
export interface Place {
  id: string
  name: string
  description: string | null
  atmosphere: string | null
  color: string | null
  image_path: string | null
  created_at: string
}

export interface StoryEvent {
  id: string
  node_id: string
  seq: number
  type: string
  source: 'llm' | 'user'
  payload: Record<string, unknown>
  created_at: string
}

export interface EventInput {
  /** 既存イベントの編集時は id を引き継ぐ(参照(replaces / reasons)を壊さない)。新規は省略 */
  id?: string
  type: string
  payload: Record<string, unknown>
  source?: 'llm' | 'user'
}

export interface StoryNode {
  id: string
  title: string | null
  beat: string
  emotional_core: string | null
  cast: string[]
  location: string | null
  story_time: string | null
  status: 'canon' | 'draft'
  pos_x: number | null
  pos_y: number | null
  image_path: string | null
  /** 挿絵が動画のときのサムネイル画像(構造モードのカード用。無ければ描画時に生成される) */
  thumb_path: string | null
  /** このシーンだけの清書の目安の字数(null / 0 = 共通の設定に従う) */
  target_chars: number | null
  /** 章グループ(null = 未分類。docs/design/chapters.md) */
  group_id: string | null
  /** マーカーノード(null = 通常シーン)。start / ending は docs/design/endings.md、
   *  chapter_in / chapter_out は章の入口・出口(docs/design/chapters.md §9) */
  kind: 'start' | 'ending' | 'chapter_in' | 'chapter_out' | null
  created_at: string
  updated_at: string
  events: StoryEvent[]
  validation?: string[]
}

/** 章グループ。正史パス上の連続区間へのラベル(実体ノードではない) */
export interface Group {
  id: string
  title: string
  color: string | null
  /** 章内が編集されてまとめが古い(要更新バッジ) */
  digest_stale: number
  /** 章じまいのまとめ(digest)が保存されているか */
  has_digest: boolean
  /** 章の前提が崩れているときの警告(鎖が途切れている)。null = 正常 */
  warning: string | null
  /** 正史ルート上の章か(false = 島・分岐の章。並べ替え・鑑賞の見出し対象外) */
  on_canon: boolean
  /** 章ビューでの章カードの手動配置(null = 導出位置) */
  pos_x: number | null
  pos_y: number | null
  /** 章カードの表紙にするシーン(null = 自動。章内で最初に挿絵があるシーンを使う) */
  cover_node_id: string | null
  /** 章の入口 / 出口マーカー(ノードグループの Input / Output と同じ役割)。
   *  章の外との接続はここを通る(docs/design/chapters.md §9) */
  in_id: string | null
  out_id: string | null
  /** 章の中の「読む道」。メンバーのうち正史に乗っているもの(無ければ島の一続き)。
   *  鑑賞モード・まとめ・並べ替え・章カードのピンはこちらを見る */
  route: string[]
  /** メンバーのシーン ID(ルート → それ以外の順)。**一続きとは限らない**:
   *  章の中の分岐も、まだ繋いでいない島も入る(docs/design/chapters.md §9) */
  node_ids: string[]
}

export interface Relationship {
  score: number
  target_type: 'char' | 'faction'
  reasons: string[]
  label?: string
}

export interface CharState {
  status: 'introduced' | 'retired'
  retire_reason: string | null
  facts: Record<string, unknown>
  relationships: Record<string, Relationship>
  memories: string[]
}

export interface StateSnapshot {
  world: { time: unknown; facts: Record<string, unknown> }
  chars: Record<string, CharState>
}

export interface GraphEdge {
  id: string
  from_node: string
  to_node: string
  is_canon: number
}

export interface StoryGraph {
  nodes: StoryNode[]
  edges: GraphEdge[]
}

export interface StylePreset {
  id: string
  name: string
  person: 'first' | 'third'
  tone: string
  params: string
  builtin: boolean
}

export interface RenderResult {
  id: string
  node_id: string
  preset_id: string
  pov_char: string | null
  prose: string
  stale: number
  created_at: string
  /** 生成統計(api.ts の ChatStats と同形)。列追加(2026-07-31)以前の清書は null */
  meta?: { tokens: number; elapsed_sec: number | null; tokens_per_sec: number | null; finish_reason: string | null } | null
  /** 生成時に LLM へ送った messages の控え。列追加以前の清書は null */
  prompt_messages?: Array<Record<string, unknown>> | null
}

export interface SceneEntry {
  node: StoryNode
  render: RenderResult | null
}


// ライブラリ全体のスナップショット(docs/design/snapshots.md)
export interface Snapshot {
  id: string
  label: string
  kind: 'auto' | 'manual'
  created_at: string
  size: number
}
