import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

const DEFAULT_API_PORT = 8765

// ---- ライブラリ設定(%APPDATA%/story-graph/app.json) ----------------
// ライブラリ = ストーリーごとのデータフォルダ(story-graph.db が入る)

interface AppConfig {
  libraryRoot: string | null
  recentRoots: string[]
}

function configFilePath(): string {
  return join(app.getPath('userData'), 'app.json')
}

function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
      libraryRoot: typeof parsed.libraryRoot === 'string' ? parsed.libraryRoot : null,
      recentRoots: Array.isArray(parsed.recentRoots) ? parsed.recentRoots.filter((r) => typeof r === 'string') : []
    }
  } catch {
    return { libraryRoot: null, recentRoots: [] }
  }
}

function saveConfig(config: AppConfig): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(configFilePath(), JSON.stringify(config, null, 2), 'utf-8')
  } catch (error) {
    console.error('[config] 保存に失敗:', error)
  }
}

function currentLibraryRoot(): string {
  const config = loadConfig()
  return config.libraryRoot ?? join(repoRoot(), 'data')
}

function rememberLibraryRoot(root: string): void {
  const config = loadConfig()
  config.libraryRoot = root
  config.recentRoots = [root, ...config.recentRoots.filter((r) => r !== root)].slice(0, 10)
  saveConfig(config)
}

let mainWindow: BrowserWindow | null = null
let sidecarProcess: ChildProcess | null = null
let apiBaseUrl: string | null = null
let sidecarPromise: Promise<string> | null = null

// whenReady と bootstrap IPC が同時に呼んでも spawn を 1 回にする
function ensureSidecar(): Promise<string> {
  if (!sidecarPromise) {
    sidecarPromise = startSidecar().catch((error) => {
      sidecarPromise = null
      throw error
    })
  }
  return sidecarPromise
}

function repoRoot(): string {
  // dev では __dirname = out/main なので2階層上がリポジトリルート。
  // .venv の存在で判定する(electron-vite dev の app.getAppPath() は out/main を返す)
  const candidates = [join(__dirname, '..', '..'), app.getAppPath()]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.venv'))) return candidate
  }
  return app.getAppPath()
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 20; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (available) return port
  }
  throw new Error('no available port for sidecar')
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return true
    } catch {
      // まだ起動中
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

async function probeHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000)
    })
    return res.ok
  } catch {
    return false
  }
}

async function startSidecar(): Promise<string> {
  const override = process.env.STORY_GRAPH_API_URL
  if (override) {
    apiBaseUrl = override
    return override
  }
  // 既に healthy な sidecar が居ればそれを使う(前回セッションの残存や手動起動。
  // Windows ではポートが塞がっていても listen チェックをすり抜けることがあるため、
  // 空きポート探索の前に必ず health を確認する)
  for (let port = DEFAULT_API_PORT; port < DEFAULT_API_PORT + 20; port += 1) {
    if (await probeHealthy(port)) {
      apiBaseUrl = `http://127.0.0.1:${port}`
      console.log(`[sidecar] 既存のバックエンドを再利用: ${apiBaseUrl}`)
      return apiBaseUrl
    }
  }
  const root = repoRoot()
  const pythonPath = join(root, '.venv', 'Scripts', 'python.exe')
  if (!existsSync(pythonPath)) {
    throw new Error(`.venv が見つかりません: ${pythonPath}`)
  }
  const port = await findAvailablePort(DEFAULT_API_PORT)
  const libraryRoot = currentLibraryRoot()
  mkdirSync(libraryRoot, { recursive: true })
  const proc = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: join(root, 'backend'),
      windowsHide: true,
      env: { ...process.env, STORY_GRAPH_LIBRARY: libraryRoot }
    }
  )
  proc.stdout?.on('data', (chunk: Buffer) => console.log(`[sidecar] ${chunk.toString().trimEnd()}`))
  proc.stderr?.on('data', (chunk: Buffer) => console.log(`[sidecar] ${chunk.toString().trimEnd()}`))
  proc.on('exit', (code) => {
    console.log(`[sidecar] exited with code ${code}`)
    sidecarProcess = null
  })
  sidecarProcess = proc

  const baseUrl = `http://127.0.0.1:${port}`
  const healthy = await waitForHealthy(baseUrl, 30_000)
  if (!healthy) {
    throw new Error('sidecar のヘルスチェックがタイムアウトしました')
  }
  apiBaseUrl = baseUrl
  return baseUrl
}

function stopSidecar(): void {
  const proc = sidecarProcess
  if (!proc || proc.pid === undefined) return
  sidecarProcess = null
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true })
    } else {
      proc.kill()
    }
  } catch {
    // 既に終了している
  }
}

async function captureScreenshot(): Promise<void> {
  const win = mainWindow
  if (!win) return
  try {
    const image = await win.webContents.capturePage()
    const dir = join(currentLibraryRoot(), 'screenshot')
    mkdirSync(dir, { recursive: true })
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const filePath = join(dir, `screenshot-${stamp}.png`)
    writeFileSync(filePath, image.toPNG())
    win.webContents.send('screenshot:saved', filePath)
  } catch (error) {
    console.error('[screenshot] 保存に失敗:', error)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true, // コンテンツ領域基準で 1920x1080
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  // window.open されたリンクは OS ブラウザで開く(チャットの Markdown リンク等)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      void captureScreenshot()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('bootstrap', async () => {
    try {
      await ensureSidecar()
    } catch (error) {
      return { apiBaseUrl: null, error: String(error) }
    }
    return { apiBaseUrl, error: null }
  })
  ipcMain.handle('library:info', () => {
    const config = loadConfig()
    return { current: currentLibraryRoot(), recents: config.recentRoots }
  })
  ipcMain.handle('library:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'ライブラリフォルダを選択',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    rememberLibraryRoot(root)
    return root
  })
  ipcMain.handle('library:switch', (_event, root: string) => {
    rememberLibraryRoot(root)
    return root
  })
  createWindow()
  void ensureSidecar().catch((error) => console.error('[sidecar] 起動失敗:', error))
})

app.on('window-all-closed', () => {
  stopSidecar()
  app.quit()
})

app.on('quit', () => {
  stopSidecar()
})
