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
    draft?: boolean
    events?: EventInput[]
  }) => request<StoryNode>('/nodes', { method: 'POST', body: JSON.stringify(data) }),
  insertNodeAfter: (nodeId: string, data: { title?: string; beat: string; cast?: string[] }) =>
    request<StoryNode>(`/nodes/${nodeId}/insert_after`, { method: 'POST', body: JSON.stringify(data) }),
  updateNode: (id: string, data: Partial<Omit<StoryNode, 'id' | 'events'>>) =>
    request<StoryNode>(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNode: (id: string) => request<unknown>(`/nodes/${id}`, { method: 'DELETE' }),
  setNodePosition: (id: string, x: number, y: number) =>
    request<unknown>(`/nodes/${id}/position`, { method: 'POST', body: JSON.stringify({ x, y }) }),
  setNodeImage: (id: string, imagePath: string | null) =>
    request<unknown>(`/nodes/${id}/image`, { method: 'POST', body: JSON.stringify({ image_path: imagePath }) }),
  resetLayout: () => request<unknown>('/layout/reset', { method: 'POST' }),
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
  listProofreadPresets: () => request<Array<{ id: string; name: string; prompt: string }>>('/proofread/presets'),
  proofread: (text: string, presetId: string, context?: { before: string; after: string }) =>
    request<{ value: string }>('/proofread', {
      method: 'POST',
      body: JSON.stringify({
        text,
        preset_id: presetId,
        context_before: context?.before ?? '',
        context_after: context?.after ?? ''
      })
    }),
  suggestSceneMeta: (beat: string, field: 'title' | 'emotional_core') =>
    request<{ value: string }>('/suggest/scene_meta', {
      method: 'POST',
      body: JSON.stringify({ beat, field })
    }),
  promotePreview: (nodeId: string, selection: string) =>
    request<PromoteProposal>(`/nodes/${nodeId}/promote_preview`, {
      method: 'POST',
      body: JSON.stringify({ selection })
    }),

  debugPrompts: () =>
    request<
      Array<{
        id: number
        time: string
        label: string
        messages: Array<{ role: string; content: string }>
        temperature: number
        max_tokens: number
        response: string | null
        finish_reason: string | null
        usage: { prompt_tokens?: number; completion_tokens?: number } | null
        error: string | null
      }>
    >('/debug/prompts'),
  getGenerationPrompt: () =>
    request<{ default: string; rules: string; current: string }>('/generation_prompt'),

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
  llmLoad: () =>
    request<{ base_url: string; healthy: boolean; model_path: string | null }>('/llm/load', { method: 'POST' }),
  llamaReleases: () => request<{ releases: LlamaRelease[] }>('/llama/releases'),
  llamaServerStatus: () => request<LlamaServerStatus>('/llama/server_status'),
  extractEvents: (nodeId: string) =>
    request<{ events: StoryEvent[]; validation: string[] }>(`/nodes/${nodeId}/extract_events`, {
      method: 'POST'
    })
}

export interface ProofreadStreamEvent {
  delta?: string
  done?: boolean
  value?: string
  error?: string
}

export async function proofreadStream(
  body: { text: string; preset_id: string; context_before: string; context_after: string },
  onEvent: (data: ProofreadStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/proofread/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} /proofread/stream: ${await res.text()}`)
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
        onEvent(JSON.parse(line.slice(6)) as ProofreadStreamEvent)
      }
    }
  }
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

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function assetUrl(path: string | null | undefined): string | null {
  if (!path || !baseUrl) return null
  return `${baseUrl}/assets/${encodeURIComponent(path)}`
}

// ---- llama.cpp インストール ----------------------------------------

export interface LlamaReleaseVariant {
  key: string
  label: string
  family: 'cuda' | 'cpu' | 'vulkan' | 'hip' | 'sycl' | 'other'
  asset_name: string
  asset_url: string
  size_bytes: number
  cudart_name: string | null
  cudart_url: string | null
  cudart_size_bytes: number | null
}

export interface LlamaRelease {
  tag: string
  name: string
  published_at: string | null
  html_url: string
  variants: LlamaReleaseVariant[]
}

export interface LlamaServerInstall {
  build: string | null
  dir: string
  path: string
}

export interface LlamaServerStatus {
  installed: boolean
  build: string | null
  path: string | null
  install_dir: string | null
  runtime_dir: string
  installs: LlamaServerInstall[]
}

export type LlamaInstallProgress =
  | { phase: 'download'; file_label: string; received: number; total: number | null; percent: number | null }
  | { phase: 'extract'; file_label: string }
  | { phase: 'done'; build: string | null; path: string }
  | { phase: 'error'; message: string }

/** llama.cpp のインストールを開始し、進捗イベントを逐次受け取る。abort でキャンセル。 */
export async function llamaInstallStream(
  variant: LlamaReleaseVariant,
  onProgress: (p: LlamaInstallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/llama/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variant }),
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} /llama/install: ${await res.text()}`)
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
        onProgress(JSON.parse(line.slice(6)) as LlamaInstallProgress)
      }
    }
  }
}

const VIDEO_EXTS = ['.mp4', '.webm']

/** 添付アセットが動画かどうか(拡張子で判定) */
export function isVideoAsset(path: string | null | undefined): boolean {
  if (!path) return false
  const lower = path.toLowerCase()
  return VIDEO_EXTS.some((ext) => lower.endsWith(ext))
}

export async function uploadAsset(file: File): Promise<{ path: string }> {
  if (!baseUrl) throw new Error('backend not ready')
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${baseUrl}/assets/upload`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`${res.status} /assets/upload: ${await res.text()}`)
  return res.json() as Promise<{ path: string }>
}

export async function renderStream(
  body: { preset_id: string; pov_char: string | null; from_node: string | null; mode: 'single' | 'to_end' },
  onEvent: (data: RenderStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
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

export interface ChatSummary {
  id: string
  anchor_node: string | null
  anchor_title: string | null
  scope: string
  char_id: string | null
  char_name: string | null
  mode: string | null
  title: string | null // null なら snippet を見出しに使う
  snippet: string
  updated_at: string
}

export interface ChatRecord {
  id: string
  anchor_node: string | null
  scope: string
  char_id: string | null
  mode: string | null
  messages: Array<Record<string, unknown>>
}

/** 1 回の返事の生成統計(llama-server の timings / usage 由来) */
export interface ChatStats {
  tokens: number
  elapsed_sec: number | null
  tokens_per_sec: number | null
  finish_reason: string | null
  steps: number
}

export interface ChatStreamEvent {
  chat_id?: string
  stage?: string
  delta?: string
  stats?: ChatStats | null
  tool_call?: { name: string; args: Record<string, unknown> }
  tool_result?: { name: string; is_error: boolean }
  proposals?: Array<{
    title: string
    beat: string
    emotional_core?: string
    cast?: string[]
    location?: string
  }>
  answer?: string
  error?: string
}

export const chatApi = {
  list: () => request<ChatSummary[]>('/chats'),
  get: (chatId: string) => request<ChatRecord>(`/chats/${chatId}`),
  delete: (chatId: string) => request<unknown>(`/chats/${chatId}`, { method: 'DELETE' }),
  // 会話名の変更(空文字で既定の見出しに戻る)
  rename: (chatId: string, title: string) =>
    request<ChatRecord>(`/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  // 1 往復の削除。keepUser=true なら返事だけ消して発言を残す
  deleteTurn: (chatId: string, index: number, keepUser: boolean) =>
    request<ChatRecord>(`/chats/${chatId}/turn/${index}?keep_user=${keepUser}`, { method: 'DELETE' }),
  // 内容ベースの質問候補。設定オフ・LLM 未起動・生成失敗はすべて空配列で返る
  suggestQuestions: (body: { chat_id: string | null; anchor_node: string | null; scope: string }) =>
    request<{ questions: string[] }>('/chat/suggest_questions', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  // コンテキスト使用量(会話トークン / ctx_size)。estimated は概算フォールバック
  tokenUsage: (body: {
    chat_id: string | null
    anchor_node: string | null
    scope: string
    char_id?: string | null
    mode?: string
  }) =>
    request<{ token_count: number; ctx_size: number; estimated: boolean }>('/chat/token_usage', {
      method: 'POST',
      body: JSON.stringify(body)
    })
}

export async function chatSendStream(
  body: {
    chat_id: string | null
    anchor_node: string | null
    scope: string
    message: string
    char_id?: string | null // 設定時は「キャラクターと話す」モード
    mode?: string // interview | roleplay
    replace_from?: number | null // 編集・再生成: この位置まで履歴を巻き戻す
  },
  onEvent: (data: ChatStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} /chat/send: ${await res.text()}`)
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
        onEvent(JSON.parse(line.slice(6)) as ChatStreamEvent)
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
  parentId: string | null = null,
  signal?: AbortSignal
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/generate/beat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, parent_id: parentId }),
    signal
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
