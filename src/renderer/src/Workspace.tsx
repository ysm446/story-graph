import { createContext, useContext } from 'react'

export type WorkspaceMode = 'structure' | 'characters' | 'reader'

/** モードをまたぐチャットの表示先と、編集の競合防止を共有する。 */
export const WorkspaceContext = createContext<{
  mode: WorkspaceMode
  chatHost: HTMLDivElement | null
  chatOpen: boolean
  toggleChat: () => void
  manual: boolean
  setManual: (value: boolean) => void
  revision: number
  changed: () => void
  libraryDirty: React.MutableRefObject<boolean>
} | null>(null)

export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('WorkspaceContext がありません')
  return value
}
