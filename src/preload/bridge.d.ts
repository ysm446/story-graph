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
  /** フォルダ自体をエクスプローラーで開く */
  openFolder: (path: string) => Promise<boolean>
  /** バックアップ zip の保存先を選ぶ(キャンセルで null)。defaultDir は開く場所 */
  chooseBackupSaveFile: (defaultName: string, defaultDir: string) => Promise<string | null>
  /** 復元するバックアップ zip を選ぶ(キャンセルで null) */
  chooseBackupZip: () => Promise<string | null>
  /** フォルダを選ぶ(バックアップの保存先・復元先。キャンセルで null) */
  chooseFolder: (title: string) => Promise<string | null>
  onScreenshotSaved: (callback: (path: string) => void) => () => void
}

declare global {
  interface Window {
    storyGraph: StoryGraphApi
  }
}
