export interface BootstrapResult {
  apiBaseUrl: string | null
  error: string | null
}

export interface StoryGraphApi {
  bootstrap: () => Promise<BootstrapResult>
}

declare global {
  interface Window {
    storyGraph: StoryGraphApi
  }
}
