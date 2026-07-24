export interface Character {
  id: string
  name: string
  profile: string | null
  appearance: string | null
  voice: string | null
  color: string | null
  graph_x: number | null
  graph_y: number | null
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
  created_at: string
  updated_at: string
  events: StoryEvent[]
  validation?: string[]
}

export interface Relationship {
  score: number
  target_type: 'char' | 'faction'
  reasons: string[]
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
