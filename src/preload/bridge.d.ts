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
}

declare global {
  interface Window {
    storyGraph: StoryGraphApi
  }
}
