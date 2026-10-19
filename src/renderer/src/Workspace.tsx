import { createContext, useContext } from 'react'

export type WorkspaceMode = 'structure' | 'characters' | 'reader'
export type ProductionTarget = { kind: 'scene' | 'chapter' | 'character' | 'place' | 'setting_document'; id: string }

/** モードをまたぐチャットの表示先と、編集の競合防止を共有する。 */
export const WorkspaceContext = createContext<{
  mode: WorkspaceMode
  chatHost: HTMLDivElement | null
  /** モード切替の行の、そのモードの操作を置く場所(構造モードのツールバー。2026-10-19) */
  toolbarHost: HTMLDivElement | null
  chatOpen: boolean
  toggleChat: () => void
  manual: boolean
  setManual: (value: boolean) => void
  revision: number
  changed: () => void
  productionTarget: ProductionTarget | null
  followTarget: (target: ProductionTarget | null) => void
  /** 資料庫などからシーンを開く(構造モードへ移り、そのシーンを選んで寄せる) */
  openScene: (nodeId: string) => void
  libraryDirty: React.MutableRefObject<boolean>
} | null>(null)

export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('WorkspaceContext がありません')
  return value
}
