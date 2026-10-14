import type { StoryNode } from '../../types'

// 未保存のシーン下書きをノード ID ごとに保持する(セッション内)。
// ノード非選択で BeatTab がアンマウントされても編集内容が消えないようにする。
// 一時退避なので、保存成功時や「元に戻す」で該当エントリを消す。
export const beatDraftCache = new Map<string, Partial<StoryNode>>()
const beatDraftListeners = new Set<() => void>()
export const subscribeBeatDrafts = (listener: () => void): (() => void) => {
  beatDraftListeners.add(listener)
  return () => { beatDraftListeners.delete(listener) }
}

export function setBeatDraft(nodeId: string, draft: Partial<StoryNode>): void {
  const alreadyDirty = beatDraftCache.has(nodeId)
  beatDraftCache.set(nodeId, draft)
  // バッジの有無が変わるときだけ通知し、入力ごとの全カード更新は避ける。
  if (!alreadyDirty) beatDraftListeners.forEach((listener) => listener())
}

export function deleteBeatDraft(nodeId: string): void {
  if (beatDraftCache.delete(nodeId)) beatDraftListeners.forEach((listener) => listener())
}

export function savedBeatDraft(node: StoryNode): Partial<StoryNode> {
  return {
    title: node.title,
    beat: node.beat,
    emotional_core: node.emotional_core,
    cast: [...node.cast],
    location: node.location,
    elapsed_unit: node.elapsed_unit,
    elapsed_count: node.elapsed_count
  }
}
