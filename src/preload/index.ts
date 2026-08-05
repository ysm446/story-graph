import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { StoryGraphApi } from './bridge'

const api: StoryGraphApi = {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  getLibraryInfo: () => ipcRenderer.invoke('library:info'),
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  switchLibrary: (root) => ipcRenderer.invoke('library:switch', root),
  revealInFolder: (path) => ipcRenderer.invoke('shell:reveal', path),
  openFolder: (path) => ipcRenderer.invoke('shell:openFolder', path),
  chooseBackupSaveFile: (defaultName, defaultDir) =>
    ipcRenderer.invoke('backup:chooseSaveFile', defaultName, defaultDir),
  chooseBackupZip: () => ipcRenderer.invoke('backup:chooseZip'),
  chooseFolder: (title) => ipcRenderer.invoke('backup:chooseDir', title),
  onScreenshotSaved: (callback) => {
    const listener = (_event: IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('screenshot:saved', listener)
    return () => ipcRenderer.off('screenshot:saved', listener)
  }
}

contextBridge.exposeInMainWorld('storyGraph', api)
