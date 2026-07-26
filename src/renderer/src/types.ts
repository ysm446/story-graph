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
  created_at: string
  updated_at: string
  events: StoryEvent[]
  validation?: string[]
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
}

export interface SceneEntry {
  node: StoryNode
  render: RenderResult | null
}

export interface PromoteProposal {
  beat_appendix: string
  events: Array<{ type: string; payload: Record<string, unknown> }>
}
