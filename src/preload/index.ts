import { contextBridge, ipcRenderer } from 'electron'
import type { StoryGraphApi } from './bridge'

const api: StoryGraphApi = {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  getLibraryInfo: () => ipcRenderer.invoke('library:info'),
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  switchLibrary: (root) => ipcRenderer.invoke('library:switch', root)
}

contextBridge.exposeInMainWorld('storyGraph', api)
