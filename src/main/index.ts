import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

const DEFAULT_API_PORT = 8765

let mainWindow: BrowserWindow | null = null
let sidecarProcess: ChildProcess | null = null
let apiBaseUrl: string | null = null

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
  const proc = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: join(root, 'backend'), windowsHide: true }
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1720,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
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
    if (!apiBaseUrl) {
      try {
        await startSidecar()
      } catch (error) {
        return { apiBaseUrl: null, error: String(error) }
      }
    }
    return { apiBaseUrl, error: null }
  })
  createWindow()
  void startSidecar().catch((error) => console.error('[sidecar] 起動失敗:', error))
})

app.on('window-all-closed', () => {
  stopSidecar()
  app.quit()
})

app.on('quit', () => {
  stopSidecar()
})
