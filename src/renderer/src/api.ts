import type {
  BackupConfig,
  BackupInfo,
  BackupResult,
  Character,
  EventInput,
  Group,
  MediaItem,
  Place,
  RenderResult,
  SceneEntry,
  Snapshot,
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

  listPlaces: () => request<Place[]>('/places'),
  createPlace: (data: Partial<Place> & { name: string }) =>
    request<Place>('/places', { method: 'POST', body: JSON.stringify(data) }),
  updatePlace: (id: string, data: Partial<Place>) =>
    request<Place>(`/places/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePlace: (id: string) => request<unknown>(`/places/${id}`, { method: 'DELETE' }),

  timeline: () => request<StoryNode[]>('/timeline'),
  getGraph: () => request<StoryGraph>('/graph'),
  getNode: (id: string) => request<StoryNode>(`/nodes/${id}`),
  makeCanon: (nodeId: string) =>
    request<{ canon_path: string[] }>(`/nodes/${nodeId}/make_canon`, { method: 'POST' }),
  // このシーンの先に新しい結末を作る(既定でアクティブ化 = 正史がここまでになる)
  createEnding: (nodeId: string, title?: string) =>
    request<StoryNode>(`/nodes/${nodeId}/ending`, {
      method: 'POST',
      body: JSON.stringify({ title: title ?? null })
    }),
  // どこにも繋がない結末(あとでシーンからドラッグしてつなぐ)
  createFloatingEnding: (title?: string) =>
    request<StoryNode>('/endings', { method: 'POST', body: JSON.stringify({ title: title ?? null }) }),
  // 親エッジを切って、このシーン以下を独立した島にする
  detachNode: (nodeId: string) =>
    request<{ detached: boolean; canon_path: string[] }>(`/nodes/${nodeId}/detach`, {
      method: 'POST'
    }),
  // 繋いだ後の整合取り(LLM 不要): 上流で登場済みのキャラへの char_introduce を消し、
  // 残る矛盾は警告として返す
  normalizeChain: (nodeId: string) =>
    request<{
      removed: number
      changed_nodes: string[]
      warnings: Array<{ node_id: string; title: string; errors: string[] }>
    }>(`/nodes/${nodeId}/normalize_chain`, { method: 'POST' }),
  // シーンを他のシーンの子として繋ぐ(既定は draft)。
  // replaceParent = 繋ぎ先に既に親がいたら、その親エッジを切ってから繋ぐ(つなぎ替え)
  connectNodes: (parentId: string, childId: string, canon = false, replaceParent = false) =>
    request<{ canon_path: string[] }>('/edges', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: parentId,
        child_id: childId,
        canon,
        replace_parent: replaceParent
      })
    }),
  createNode: (data: {
    title?: string
    beat: string
    emotional_core?: string
    cast?: string[]
    location?: string
    story_time?: string
    parent_id?: string
    draft?: boolean
    detached?: boolean // どこにも繋がない独立シーン(島の起点)
    events?: EventInput[]
  }) => request<StoryNode>('/nodes', { method: 'POST', body: JSON.stringify(data) }),
  insertNodeAfter: (nodeId: string, data: { title?: string; beat: string; cast?: string[] }) =>
    request<StoryNode>(`/nodes/${nodeId}/insert_after`, { method: 'POST', body: JSON.stringify(data) }),
  updateNode: (id: string, data: Partial<Omit<StoryNode, 'id' | 'events'>>) =>
    request<StoryNode>(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNode: (id: string) => request<unknown>(`/nodes/${id}`, { method: 'DELETE' }),
  setNodePosition: (id: string, x: number, y: number) =>
    request<unknown>(`/nodes/${id}/position`, { method: 'POST', body: JSON.stringify({ x, y }) }),
  // 複数ノードの配置をまとめて保存する(自動レイアウトの結果を焼き付けるのに使う)
  setNodePositions: (positions: Array<{ id: string; x: number; y: number }>) =>
    request<{ updated: number }>('/layout/positions', {
      method: 'POST',
      body: JSON.stringify({ positions })
    }),
  setNodeImage: (id: string, imagePath: string | null) =>
    request<unknown>(`/nodes/${id}/image`, { method: 'POST', body: JSON.stringify({ image_path: imagePath }) }),
  // このシーンだけの清書の目安の字数(null / 0 で共通の設定に従う)。
  // signal は清書タスクの中止用(保存待ちで固まらないように)
  setNodeTargetChars: (id: string, targetChars: number | null, signal?: AbortSignal) =>
    request<unknown>(`/nodes/${id}/target_chars`, {
      method: 'POST',
      body: JSON.stringify({ target_chars: targetChars }),
      signal
    }),
  // 動画挿絵のサムネイル(videoThumb.ts が生成して保存する)
  setNodeThumb: (id: string, thumbPath: string | null) =>
    request<unknown>(`/nodes/${id}/thumb`, { method: 'POST', body: JSON.stringify({ thumb_path: thumbPath }) }),

  // ---- 挿絵・参照画像のストック(docs/design/image-gen.md §7) ----
  /** 持ち主のストック(新しい順)と、いま選択中のファイル名 */
  listMedia: (ownerType: MediaItem['owner_type'], ownerId: string) =>
    request<{ items: MediaItem[]; selected: string | null }>(`/media/${ownerType}/${ownerId}`),
  /** ストックに足す。手持ちの画像 / 動画(uploadAsset 済み。set は省略)と、生成ウインドウの「決定」
   *  (生成に使ったセット = GeneratedImage をそのまま渡す)の両方。select で同時に現在の画像にする */
  addMedia: (
    ownerType: MediaItem['owner_type'],
    ownerId: string,
    path: string,
    select = true,
    set?: Pick<GeneratedImage, 'prompt' | 'instructions' | 'seed' | 'ref_chars' | 'workflow'>
  ) =>
    request<MediaItem>('/media', {
      method: 'POST',
      body: JSON.stringify({ owner_type: ownerType, owner_id: ownerId, path, select, ...(set ?? {}) })
    }),
  /** ストックの 1 枚を現在の画像にする(生成物なら生成ウインドウの保存状態もそのセットに戻る) */
  selectMedia: (id: string) => request<MediaItem>(`/media/${id}/select`, { method: 'POST' }),
  /** ストックから外す(選択中の 1 枚は 400) */
  deleteMedia: (id: string) => request<{ ok: boolean }>(`/media/${id}`, { method: 'DELETE' }),
  deleteUnselectedMedia: (ownerType: MediaItem['owner_type'], ownerId: string) =>
    request<{ deleted: number }>(`/media/${ownerType}/${ownerId}/unselected`, { method: 'DELETE' }),
  resetLayout: () => request<unknown>('/layout/reset', { method: 'POST' }),
  putEvents: (nodeId: string, events: EventInput[]) =>
    request<{ events: StoryEvent[]; validation: string[] }>(`/nodes/${nodeId}/events`, {
      method: 'PUT',
      body: JSON.stringify({ events })
    }),
  getState: (nodeId: string) => request<StateSnapshot>(`/nodes/${nodeId}/state`),
  validateNode: (nodeId: string) => request<{ errors: string[] }>(`/nodes/${nodeId}/validate`),

  // ---- 章グループ(docs/design/chapters.md) ----
  listGroups: () => request<Group[]>('/groups'),
  createGroup: (title: string, nodeIds: string[]) =>
    request<Group>('/groups', { method: 'POST', body: JSON.stringify({ title, node_ids: nodeIds }) }),
  updateGroup: (
    groupId: string,
    // cover_node_id: null を渡すと表紙の指定を外して自動導出に戻す
    data: { title?: string; color?: string; cover_node_id?: string | null }
  ) => request<Group>(`/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // 章の解除(シーンは残る)
  deleteGroup: (groupId: string) => request<unknown>(`/groups/${groupId}`, { method: 'DELETE' }),
  // 章ビューでの章カードの配置(並べ替えではなく表示位置)
  setGroupPosition: (groupId: string, x: number, y: number) =>
    request<unknown>(`/groups/${groupId}/position`, { method: 'POST', body: JSON.stringify({ x, y }) }),
  // 章の並べ替え: 別の章の後ろへつなぎ替える(after=null は先頭へ)
  moveGroup: (groupId: string, after: string | null) =>
    request<Group[]>(`/groups/${groupId}/move`, { method: 'POST', body: JSON.stringify({ after }) }),
  // 章の読む道を、このシーンを通る道にする(出口をその枝の端へ繋ぎ替える)
  setGroupRoute: (groupId: string, nodeId: string) =>
    request<{ group: Group; groups: Group[] }>(`/groups/${groupId}/route/${nodeId}`, {
      method: 'POST'
    }),
  // シーンを章に入れる(章の端に隣接しているときのみ。後続の一続きも一緒に入る)
  addNodeToGroup: (groupId: string, nodeId: string) =>
    request<{ group: Group; groups: Group[] }>(`/groups/${groupId}/nodes/${nodeId}`, {
      method: 'POST'
    }),
  // シーンを章から外す(端のシーンのみ)
  removeNodeFromGroup: (groupId: string, nodeId: string) =>
    request<{ groups: Group[] }>(`/groups/${groupId}/nodes/${nodeId}`, { method: 'DELETE' }),
  // 章じまいのまとめ(digest)。無ければ digest_events は null
  getGroupDigest: (groupId: string) =>
    request<{ digest_events: EventInput[] | null; digest_stale: number }>(`/groups/${groupId}/digest`),
  // LLM でまとめを生成してそのまま保存する(あとから編集できる)
  generateGroupDigest: (groupId: string) =>
    request<Group>(`/groups/${groupId}/digest/generate`, { method: 'POST' }),
  putGroupDigest: (groupId: string, events: EventInput[]) =>
    request<Group>(`/groups/${groupId}/digest`, { method: 'PUT', body: JSON.stringify({ events }) }),
  deleteGroupDigest: (groupId: string) =>
    request<Group>(`/groups/${groupId}/digest`, { method: 'DELETE' }),

  getSettings: () => request<Record<string, string>>('/settings'),
  putSettings: (values: Record<string, string>) =>
    request<Record<string, string>>('/settings', { method: 'PUT', body: JSON.stringify({ values }) }),

  listPresets: () => request<StylePreset[]>('/presets'),
  upsertPreset: (data: { id?: string; name: string; person: string; tone: string }) =>
    request<StylePreset>('/presets', { method: 'POST', body: JSON.stringify(data) }),
  deletePreset: (presetId: string) => request<unknown>(`/presets/${presetId}`, { method: 'DELETE' }),
  // groupId を渡すとその章のシーンだけ(鑑賞モードのスコープ。島・分岐の章でも読める)
  listRenders: (presetId: string, povChar: string | null, groupId?: string | null) =>
    request<SceneEntry[]>(
      `/renders?preset_id=${encodeURIComponent(presetId)}${
        povChar ? `&pov_char=${encodeURIComponent(povChar)}` : ''
      }${groupId ? `&group_id=${encodeURIComponent(groupId)}` : ''}`
    ),
  // 単一シーンの最新清書(構造モードの清書タブ。分岐・島のシーンも取れる)
  getRender: (nodeId: string, presetId: string, povChar: string | null) =>
    request<{ render: RenderResult | null }>(
      `/renders/${nodeId}?preset_id=${encodeURIComponent(presetId)}${
        povChar ? `&pov_char=${encodeURIComponent(povChar)}` : ''
      }`
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
  // スナップショット(ライブラリ全体のバックアップ。docs/design/snapshots.md)
  listSnapshots: () => request<{ snapshots: Snapshot[] }>('/snapshots'),
  createSnapshot: (label: string) =>
    request<Snapshot>('/snapshots', { method: 'POST', body: JSON.stringify({ label }) }),
  restoreSnapshot: (id: string) =>
    request<{ restored: string }>(`/snapshots/${id}/restore`, { method: 'POST' }),
  deleteSnapshot: (id: string) =>
    request<{ status: string }>(`/snapshots/${id}`, { method: 'DELETE' }),
  // 外部バックアップ(zip 書き出し。docs/design/backup.md)
  getBackupConfig: () => request<BackupConfig>('/backup/config'),
  putBackupConfig: (values: {
    enabled?: boolean
    dir?: string
    keep?: number
    inside?: boolean
  }) =>
    request<BackupConfig>('/backup/config', { method: 'PUT', body: JSON.stringify(values) }),
  suggestedBackupName: () => request<{ name: string }>('/backup/suggested_name'),
  exportBackup: (path: string, includeSnapshots: boolean) =>
    request<BackupResult>('/backup/export', {
      method: 'POST',
      body: JSON.stringify({ path, include_snapshots: includeSnapshots })
    }),
  runAutoBackup: () =>
    request<{ skipped: boolean; path?: string; removed?: string[] } & Partial<BackupResult>>(
      '/backup/auto?force=true',
      { method: 'POST' }
    ),
  inspectBackup: (path: string) =>
    request<BackupInfo>('/backup/inspect', { method: 'POST', body: JSON.stringify({ path }) }),
  restoreBackup: (path: string, destRoot: string) =>
    request<{ root: string; extracted: number }>('/backup/restore', {
      method: 'POST',
      body: JSON.stringify({ path, dest_root: destRoot })
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
    request<{
      models: Array<{ name: string; path: string; size: number }>
      current: string
      /** GGUF を探しているフォルダ(設定が空なら既定の models/) */
      models_dir: string
      default_models_dir: string
      models_dir_exists: boolean
    }>('/models'),

  llmStatus: () =>
    request<{
      base_url: string
      healthy: boolean
      /** spawn 済みだがまだ応答しない = モデルの読み込み中(生成の自動ロードを含む) */
      loading: boolean
      spawned: boolean
      model_path: string | null
    }>('/llm/status'),
  llmStart: () => request<{ base_url: string; healthy: boolean }>('/llm/start', { method: 'POST' }),
  llmStop: () => request<{ stopped: boolean }>('/llm/stop', { method: 'POST' }),
  llmLoad: () =>
    request<{ base_url: string; healthy: boolean; model_path: string | null }>('/llm/load', { method: 'POST' }),
  llamaReleases: () => request<{ releases: LlamaRelease[] }>('/llama/releases'),
  llamaServerStatus: () => request<LlamaServerStatus>('/llama/server_status'),
  llamaUninstall: (installDir: string) =>
    request<LlamaServerStatus & { removed_dir: string; freed_bytes: number }>('/llama/uninstall', {
      method: 'POST',
      body: JSON.stringify({ install_dir: installDir })
    }),
  // ---- ComfyUI(画像生成) ----
  comfyStatus: () => request<ComfyStatus>('/comfy/status'),
  comfyStart: () => request<{ base_url: string; healthy: boolean }>('/comfy/start', { method: 'POST' }),
  comfyStop: () => request<{ stopped: boolean }>('/comfy/stop', { method: 'POST' }),
  comfyModels: (folder = 'checkpoints') =>
    request<{ models: string[]; healthy: boolean }>(`/comfy/models?folder=${encodeURIComponent(folder)}`),
  comfyReleases: () => request<{ releases: ComfyRelease[] }>('/comfy/releases'),
  /** 生成ウインドウで選べるワークフローの組(workflows/variants.json。先頭が既定) */
  comfyWorkflows: () => request<{ variants: WorkflowVariant[] }>('/comfy/workflows'),
  comfyUninstall: () => request<ComfyStatus>('/comfy/uninstall', { method: 'POST' }),

  /** ComfyUI で参照画像を生成し、候補として保存する(ストックにもキャラにも入れない。採用は addMedia)。
   *  使ったプロンプト・追加指示・seed はキャラの保存状態に 1 セットで書かれ、戻り値にも入る。
   *  数十秒〜。初回はモデル読み込みで更に待つ。seed 省略でランダム */
  characterRefImageGenerate: (
    id: string,
    prompt: string,
    instructions: string | null,
    seed: number | null,
    workflow: string | null,
    signal?: AbortSignal
  ) =>
    request<GeneratedImage>(`/characters/${id}/ref_image/generate`, {
      method: 'POST',
      body: JSON.stringify({ prompt, instructions, seed, workflow }),
      signal
    }),
  /** ComfyUI で場面の挿絵を生成し、候補として保存する(ストックにも挿絵にも入れない。採用は addMedia)。
   *  使ったプロンプト・追加指示・seed・参照キャラはシーンの保存状態に 1 セットで書かれ、戻り値にも入る */
  nodeImageGenerate: (
    nodeId: string,
    prompt: string,
    charIds: string[],
    instructions: string | null,
    seed: number | null,
    workflow: string | null,
    signal?: AbortSignal
  ) =>
    request<GeneratedImage>(`/nodes/${nodeId}/image/generate`, {
      method: 'POST',
      body: JSON.stringify({ prompt, char_ids: charIds, instructions, seed, workflow }),
      signal
    }),
  // signal はキュー(tasks.ts)からの中止用
  extractEvents: (nodeId: string, signal?: AbortSignal) =>
    request<{ events: StoryEvent[]; validation: string[] }>(`/nodes/${nodeId}/extract_events`, {
      method: 'POST',
      signal
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
  try {
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
  } finally {
    // 中断時もストリームを閉じて、接続とリーダーのロックを残さない
    void reader.cancel().catch(() => undefined)
  }
}

export interface ReextractStreamEvent {
  stage?: 'start' | 'node' | 'done'
  index?: number
  total?: number
  title?: string
  node_id?: string
  failed?: Array<{ node_id: string; title: string; error: string }>
}

/** このシーン以下の部分木を、親から順にイベント抽出し直す(SSE) */
export async function reextractChainStream(
  nodeId: string,
  onEvent: (data: ReextractStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return reextractStream(`/nodes/${nodeId}/reextract_chain`, undefined, onEvent, signal)
}

/** 選択した複数シーンのイベントを抽出し直す(親から順に逐次、SSE) */
export async function reextractNodesStream(
  body: { node_ids: string[]; include_downstream?: boolean },
  onEvent: (data: ReextractStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return reextractStream('/nodes/reextract', body, onEvent, signal)
}

async function reextractStream(
  path: string,
  body: unknown,
  onEvent: (data: ReextractStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${path}: ${await res.text()}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)) as ReextractStreamEvent)
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

export interface RenderStreamEvent {
  stage?: 'start'
  total?: number // 清書するシーン数(最初に一度だけ来る)
  scene_start?: string
  title?: string | null
  delta?: string
  scene_done?: string
  render?: import('./types').RenderResult
  done?: boolean
  error?: string
}

/** 清書が 1 シーン書き上がったことを知らせる購読口(戻り値を呼ぶと解除)。
 *
 * 清書はモードをまたいで残るタスクキュー(tasks.ts)で走るので、**走らせた画面と
 * 読んでいる画面が違うことがある**(構造モードで一括清書 → 鑑賞モードへ移動、など)。
 * 誰が走らせても届くよう、HTTP の窓口である renderStream から配る。
 */
type RenderSavedListener = (nodeId: string) => void

const renderSavedListeners = new Set<RenderSavedListener>()

export function onRenderSaved(listener: RenderSavedListener): () => void {
  renderSavedListeners.add(listener)
  return () => {
    renderSavedListeners.delete(listener)
  }
}

function emitRenderSaved(nodeId: string): void {
  for (const listener of [...renderSavedListeners]) {
    try {
      listener(nodeId)
    } catch {
      // 購読側の失敗で清書のストリームを止めない
    }
  }
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
  /** CUDA のメジャーバージョン("13" など)。CUDA 以外は null */
  cuda_version: string | null
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
  /** runtime/ 配下に自動インストールしたもの = アプリから削除してよい */
  removable: boolean
  /** フォルダの占有サイズ。/llama/server_status からのみ付く */
  size_bytes?: number
  /** CUDA ビルドか。以下 2 つは /llama/server_status からのみ付く */
  is_cuda?: boolean
  /** CUDA ランタイム DLL が同居しているか(無い場合はシステム側の CUDA 頼り) */
  has_cudart?: boolean
  cuda_version?: string | null
}

export interface LlamaServerStatus {
  installed: boolean
  build: string | null
  path: string | null
  install_dir: string | null
  runtime_dir: string
  installs: LlamaServerInstall[]
  total_size_bytes: number
  /** PATH 上に見つかった CUDA ランタイムのメジャーバージョン(["13"] など) */
  system_cudart: string[]
}

export type LlamaInstallProgress =
  | { phase: 'download'; file_label: string; received: number; total: number | null; percent: number | null }
  | { phase: 'extract'; file_label: string }
  | { phase: 'done'; build: string | null; path: string }
  | { phase: 'error'; message: string }

export interface LlamaInstallOptions {
  /** CUDA ランタイム DLL を本体と一緒に落とすか(既定 true) */
  includeCudart?: boolean
  /** 本体は落とさず、既存インストールに CUDA ランタイム DLL だけ足す */
  cudartOnly?: boolean
}

/** llama.cpp のインストールを開始し、進捗イベントを逐次受け取る。abort でキャンセル。 */
export async function llamaInstallStream(
  variant: LlamaReleaseVariant,
  onProgress: (p: LlamaInstallProgress) => void,
  signal?: AbortSignal,
  options: LlamaInstallOptions = {}
): Promise<void> {
  await installStream(
    '/llama/install',
    { variant, include_cudart: options.includeCudart ?? true, cudart_only: options.cudartOnly ?? false },
    onProgress,
    signal
  )
}

// ---- ComfyUI(画像生成) ----------------------------------------------

export interface ComfyReleaseVariant {
  key: string
  backend: string
  label: string
  asset_name: string
  asset_url: string
  size_bytes: number
}

export interface ComfyRelease {
  tag: string
  name: string
  published_at: string | null
  html_url: string
  variants: ComfyReleaseVariant[]
}

/** 生成した画像の候補。assets に保存済みだが、ストックにも現在の画像にも入っていない。
 *  「決定」で addMedia(path, select, セット) に渡す。決定しなければ gc_assets が回収する */
export interface GeneratedImage {
  image_path: string
  /** 使った seed。同じ seed + 同じプロンプトで同じ絵になる */
  seed: number
  /** 生成に使ったセット(欄をあとで手直ししても、ストックに入るのはこちら) */
  prompt: string
  instructions: string | null
  ref_chars: string[] | null
  /** 使ったワークフローの組(variants.json の id) */
  workflow: string
}

/** 生成ウインドウで選べるワークフローの組(workflows/variants.json) */
export interface WorkflowVariant {
  id: string
  label: string
}

/** 場面プロンプト生成の冒頭で届く情報(どのキャラが image1.. になるか) */
export interface SceneImagePromptMeta {
  suffix: string
  /** 参照画像として渡すキャラ(image1.. のラベル順) */
  refs: Array<{ char_id: string; name: string; label: string }>
  /** cast 全員と参照画像の有無 */
  cast: Array<{ char_id: string; name: string; has_ref: boolean }>
}

/** 画像プロンプト生成の SSE イベント({meta} → {delta}… → {done, prompt} / {error}) */
export interface ImagePromptStreamEvent<M = { suffix: string }> {
  meta?: M
  delta?: string
  done?: boolean
  prompt?: string
  error?: string
}

/** POST して SSE(`data: {...}` 行)を逐次 onEvent に渡す共通部。abort で中断 */
async function postSse<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${path}: ${await res.text()}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)) as E)
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/** 外見・プロフィール(+ 追加指示)から参照画像の英語プロンプトをストリーミングで作る。保存はしない */
export function characterRefImagePromptStream(
  id: string,
  instructions: string | null,
  onEvent: (e: ImagePromptStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return postSse(`/characters/${id}/ref_image/prompt`, { instructions }, onEvent, signal)
}

/** ビート・場所・cast(+ 追加指示)から場面の英語プロンプトをストリーミングで作る。保存はしない。
 *  charIds 省略(null)で参照画像のあるキャラを自動選択 */
export function nodeImagePromptStream(
  nodeId: string,
  charIds: string[] | null,
  instructions: string | null,
  onEvent: (e: ImagePromptStreamEvent<SceneImagePromptMeta>) => void,
  signal?: AbortSignal
): Promise<void> {
  return postSse(`/nodes/${nodeId}/image/prompt`, { char_ids: charIds, instructions }, onEvent, signal)
}

export interface ComfyStatus {
  base_url: string
  healthy: boolean
  /** spawn 済みだがまだ応答しない = 起動中 */
  loading: boolean
  spawned: boolean
  /** 実際に使うモデルフォルダ(設定が空なら既定。既定も無ければ '' = 同梱の models/) */
  models_dir: string
  default_models_dir: string
  installed: boolean
  install: { dir: string; root: string; python: string; main: string; version: string | null; backend: string | null } | null
  install_dir: string
  runtime_dir: string
  size_bytes: number
}

/** ComfyUI(portable 版)のインストールを開始し、進捗イベントを逐次受け取る。abort でキャンセル。 */
export async function comfyInstallStream(
  variant: ComfyReleaseVariant,
  onProgress: (p: LlamaInstallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  await installStream('/comfy/install', { variant }, onProgress, signal)
}

/** インストール系 SSE(`data: {...}` 行)を読み、進捗を逐次渡す共通部 */
async function installStream(
  path: string,
  body: unknown,
  onProgress: (p: LlamaInstallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${path}: ${await res.text()}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
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
  } finally {
    void reader.cancel().catch(() => undefined)
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
  body: {
    preset_id: string
    pov_char: string | null
    from_node?: string | null
    mode?: 'single' | 'to_end'
    node_ids?: string[] // 構造モードの一括清書(指定するとこのシーンだけが対象)
    skip_existing?: boolean // 清書済み(stale でない)シーンを飛ばす
    target_chars?: number | null // 1 シーンあたりの目安の字数(0 / 未指定でおまかせ)
  },
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
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6)) as RenderStreamEvent
          onEvent(data)
          // 保存が済んだシーンは、走らせた画面以外にも知らせる(鑑賞モードの読み直し)
          if (data.scene_done) emitRenderSaved(data.scene_done)
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
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

/** 1 回の生成の統計(llama-server の timings / usage 由来)。
 *  チャットの返事と清書で共用する。steps はツールループのあるチャットのみ */
export interface ChatStats {
  tokens: number
  elapsed_sec: number | null
  tokens_per_sec: number | null
  finish_reason: string | null
  steps?: number
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
  try {
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
  } finally {
    void reader.cancel().catch(() => undefined)
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
  signal?: AbortSignal,
  // 指定するとそのノードの直後へ割り込ませる(章の中への追加。章の出口の手前に入る)
  afterId: string | null = null
): Promise<void> {
  if (!baseUrl) throw new Error('backend not ready')
  const res = await fetch(`${baseUrl}/generate/beat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, parent_id: parentId, after_id: afterId }),
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} /generate/beat: ${await res.text()}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
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
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}
