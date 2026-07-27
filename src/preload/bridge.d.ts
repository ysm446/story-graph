export interface BootstrapResult {
  apiBaseUrl: string | null
  error: string | null
}

export interface LibraryInfo {
  current: string
  recents: string[]
}

export interface StoryGraphApi {
  bootstrap: () => Promise<BootstrapResult>
  getLibraryInfo: () => Promise<LibraryInfo>
  chooseLibrary: () => Promise<string | null>
  switchLibrary: (root: string) => Promise<string>
  /** ファイルの場所をエクスプローラーで開く(そのファイルを選択した状態) */
  revealInFolder: (path: string) => Promise<boolean>
  onScreenshotSaved: (callback: (path: string) => void) => () => void
}

declare global {
  interface Window {
    storyGraph: StoryGraphApi
  }
}
