import { contextBridge, ipcRenderer } from 'electron'
import type { StoryGraphApi } from './bridge'

const api: StoryGraphApi = {
  bootstrap: () => ipcRenderer.invoke('bootstrap')
}

contextBridge.exposeInMainWorld('storyGraph', api)
