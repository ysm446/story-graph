import type {
  Character,
  EventInput,
  PromoteProposal,
  SceneEntry,
  StateSnapshot,
  StoryEvent,
  StoryGraph,
  StoryNode,
  StylePreset
} from './types'

let baseUrl: string | null = null

export async function initApi(): Promise<{ baseUrl: string | null; error: string | null }> {
  const result = await window.storyGraph.bootstrap()
  baseUrl = result.apiBaseUrl
  return { baseUrl, error: result.error }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${path}: ${body}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  getLibrary: () => request<{ root: string | null }>('/library'),
  switchLibrary: (root: string) =>
    request<{ root: string }>('/library/switch', { method: 'POST', body: JSON.stringify({ root }) }),

  listCharacters: () => request<Character[]>('/characters'),
  createCharacter: (data: Partial<Character> & { name: string }) =>
    request<Character>('/characters', { method: 'POST', body: JSON.stringify(data) }),
  updateCharacter: (id: string, data: Partial<Character>) =>
    request<Character>(`/characters/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCharacter: (id: string) => request<unknown>(`/characters/${id}`, { method: 'DELETE' }),

  timeline: () => request<StoryNode[]>('/timeline'),
  getGraph: () => request<StoryGraph>('/graph'),
  makeCanon: (nodeId: string) =>
    request<{ canon_path: string[] }>(`/nodes/${nodeId}/make_canon`, { method: 'POST' }),
  createNode: (data: {
    title?: string
    beat: string
    emotional_core?: string
    cast?: string[]
    location?: string
    story_time?: string
    parent_id?: string
    events?: EventInput[]
  }) => request<StoryNode>('/nodes', { method: 'POST', body: JSON.stringify(data) }),
  updateNode: (id: string, data: Partial<Omit<StoryNode, 'id' | 'events'>>) =>
    request<StoryNode>(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNode: (id: string) => request<unknown>(`/nodes/${id}`, { method: 'DELETE' }),
  putEvents: (nodeId: string, events: EventInput[]) =>
    request<{ events: StoryEvent[]; validation: string[] }>(`/nodes/${nodeId}/events`, {
      method: 'PUT',
      body: JSON.stringify({ events })
    }),
  getState: (nodeId: string) => request<StateSnapshot>(`/nodes/${nodeId}/state`),
  validateNode: (nodeId: string) => request<{ errors: string[] }>(`/nodes/${nodeId}/validate`),

  getSettings: () => request<Record<string, string>>('/settings'),
  putSettings: (values: Record<string, string>) =>
    request<Record<string, string>>('/settings', { method: 'PUT', body: JSON.stringify({ values }) }),

  listPresets: () => request<StylePreset[]>('/presets'),
  upsertPreset: (data: { id?: string; name: string; person: string; tone: string }) =>
    request<StylePreset>('/presets', { method: 'POST', body: JSON.stringify(data) }),
  deletePreset: (presetId: string) => request<unknown>(`/presets/${presetId}`, { method: 'DELETE' }),
  listRenders: (presetId: string, povChar: string | null) =>
    request<SceneEntry[]>(
      `/renders?preset_id=${encodeURIComponent(presetId)}${povChar ? `&pov_char=${encodeURIComponent(povChar)}` : ''}`
    ),
  promotePreview: (nodeId: string, selection: string) =>
    request<PromoteProposal>(`/nodes/${nodeId}/promote_preview`, {
      method: 'POST',
      body: JSON.stringify({ selection })
    }),

  systemResources: () =>
    request<{
      cpu_usage: number
      ram_used: number
      ram_total: number
      gpu_usage: number | null
      vram_used: number | null
      vram_total: number | null
    }>('/system/resources'),
  listModels: () =>
    request<{ models: Array<{ name: string; path: string; size: number }>; current: string }>('/models'),

  llmStatus: () =>
    request<{ base_url: string; healthy: boolean; spawned: boolean; model_path: string | null }>('/llm/status'),
  llmStart: () => request<{ base_url: string; healthy: boolean }>('/llm/start', { method: 'POST' }),
  llmStop: () => request<{ stopped: boolean }>('/llm/stop', { method: 'POST' }),
  extractEvents: (nodeId: string) =>
    request<{ events: StoryEvent[]; validation: string[] }>(`/nodes/${nodeId}/extract_events`, {
      method: 'POST'
    })
}

export interface RenderStreamEvent {
  scene_start?: string
  title?: string | null
  delta?: string
  scene_done?: string
  render?: import('./types').RenderResult
  done?: boolean
  error?: string
}

export async function renderStream(
  body: { preset_id: string; pov_char: string | null; from_node: string | null; mode: 'single' | 'to_end' },
  onEvent: (data: RenderStreamEvent) => void
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} /render: ${await res.text()}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (line.startsWith('data: ')) {
        onEvent(JSON.parse(line.slice(6)) as RenderStreamEvent)
      }
    }
  }
}

export interface GenerationEvent {
  stage?: 'generating' | 'validating' | 'retry'
  attempt?: number
  errors?: string[]
  done?: boolean
  node?: StoryNode
  validation?: string[]
  error?: string
}

export async function generateBeatStream(
  instruction: string | null,
  onEvent: (data: GenerationEvent) => void,
  parentId: string | null = null
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/generate/beat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, parent_id: parentId })
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} /generate/beat: ${await res.text()}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (line.startsWith('data: ')) {
        onEvent(JSON.parse(line.slice(6)) as GenerationEvent)
      }
    }
  }
}
