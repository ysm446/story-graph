import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { StoryGraphApi } from './bridge'

const api: StoryGraphApi = {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  getLibraryInfo: () => ipcRenderer.invoke('library:info'),
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  switchLibrary: (root) => ipcRenderer.invoke('library:switch', root),
  onScreenshotSaved: (callback) => {
    const listener = (_event: IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('screenshot:saved', listener)
    return () => ipcRenderer.off('screenshot:saved', listener)
  }
}

contextBridge.exposeInMainWorld('storyGraph', api)
