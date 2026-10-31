export interface BootstrapResult {
  apiBaseUrl: string | null
  error: string | null
}

export interface LibraryInfo {
  current: string
  recents: string[]
  /** 新規作成のダイアログで最初に出す場所 */
  defaultParent: string
}

export interface StoryGraphApi {
  bootstrap: () => Promise<BootstrapResult>
  getLibraryInfo: () => Promise<LibraryInfo>
  /** 開くフォルダを選ぶ(キャンセルで null)。isLibrary はそこに既にライブラリがあるか */
  chooseLibrary: () => Promise<{ root: string; isLibrary: boolean } | null>
  /** そのフォルダが既にライブラリか(履歴のフォルダは移動・削除されていることがある) */
  isLibrary: (root: string) => Promise<boolean>
  /** 新規作成の場所を選ぶ(キャンセルで null)。defaultPath は開く場所 */
  chooseLibraryParent: (defaultPath: string) => Promise<string | null>
  /** `parent/name` のフォルダを作る。切り替えは呼ぶ側が switchLibrary で行う */
  createLibrary: (parent: string, name: string) => Promise<{ root: string } | { error: string }>
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
