import { useSyncExternalStore } from 'react'

export interface ProductionPreview { node_id: string | null; beat: string }
let preview: ProductionPreview | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
// 未確定の編集案。手動下書き・ノード本文・会話履歴には保存しない。
export function setProductionPreview(value: ProductionPreview | null): void {
  if (preview === value) return
  preview = value
  listeners.forEach((listener) => listener())
}
export function useProductionPreview(nodeId?: string): ProductionPreview | null {
  return useSyncExternalStore(subscribe, () => nodeId === undefined || preview?.node_id === nodeId ? preview : null)
}
