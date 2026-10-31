import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'
import { dirname, join, normalize } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createLibraryFolder, isLibraryFolder } from './library'
import { findAvailablePort, isPortInUse, isStoryGraphHealthy } from './sidecarNetwork'

const DEFAULT_API_PORT = 8765

// ---- ライブラリ設定(%APPDATA%/story-graph/app.json) ----------------
// ライブラリ = ストーリーごとのデータフォルダ(story-graph.db が入る)

interface AppConfig {
  libraryRoot: string | null
  recentRoots: string[]
  /** 前回ライブラリを新規作成した場所 */
  createParent: string | null
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
      recentRoots: Array.isArray(parsed.recentRoots) ? parsed.recentRoots.filter((r) => typeof r === 'string') : [],
      createParent: typeof parsed.createParent === 'string' ? parsed.createParent : null
    }
  } catch {
    return { libraryRoot: null, recentRoots: [], createParent: null }
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

/** 新規作成で最初に出す場所。前回の場所、無ければ今のライブラリの隣。
 *  既定のライブラリ(リポジトリ内の data/)の隣はリポジトリの直下になるので、ドキュメントにする */
function defaultCreateParent(config: AppConfig): string {
  if (config.createParent) return config.createParent
  return config.libraryRoot ? dirname(config.libraryRoot) : app.getPath('documents')
}

function rememberLibraryRoot(root: string): void {
  const config = loadConfig()
  // 既定のライブラリ(data/)は開いただけでは履歴に載らないので、離れるときに載せる(戻れなくなるため)
  const previous = config.libraryRoot ?? join(repoRoot(), 'data')
  config.libraryRoot = root
  config.recentRoots = [...new Set([root, previous, ...config.recentRoots])].slice(0, 10)
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

function appIconPath(): string | undefined {
  // dev はリポジトリ直下、将来のパッケージ版は resources または app.asar 内を探す。
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png'),
    join(repoRoot(), 'resources', 'icon.png')
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isStoryGraphHealthy(baseUrl, 2000)) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

async function probeHealthy(port: number): Promise<boolean> {
  // sidecar は IPv4 限定。IPv6 側に別サーバーがいるポートは再利用もしない。
  if (await isPortInUse(port, '::1')) return false
  return isStoryGraphHealthy(`http://127.0.0.1:${port}`)
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
  const baseUrl = `http://127.0.0.1:${port}`
  const proc = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: join(root, 'backend'),
      windowsHide: true,
      // STORY_GRAPH_APP_DATA: この PC のアプリ単位の設定(モデルの場所・接続先など)の置き場(backend/app_settings.py)
      env: { ...process.env, STORY_GRAPH_LIBRARY: libraryRoot, STORY_GRAPH_APP_DATA: app.getPath('userData') }
    }
  )
  proc.stdout?.on('data', (chunk: Buffer) => console.log(`[sidecar] ${chunk.toString().trimEnd()}`))
  proc.stderr?.on('data', (chunk: Buffer) => console.log(`[sidecar] ${chunk.toString().trimEnd()}`))
  proc.on('exit', (code) => {
    console.log(`[sidecar] exited with code ${code}`)
    // stopSidecar 経由(意図した停止)は sidecarProcess が先に null になっている。
    // クラッシュ時は状態をリセットして、次の ensureSidecar() で再起動できるようにする
    if (sidecarProcess !== proc) return
    sidecarProcess = null
    sidecarPromise = null
    if (apiBaseUrl === baseUrl) apiBaseUrl = null
  })
  sidecarProcess = proc

  // spawn 自体の失敗(EACCES 等)と、起動直後の即死(ポート bind 失敗・import エラー)は
  // ヘルスチェックの 30 秒を待たずに失敗させる。error リスナーが無いと main が落ちる
  const died = new Promise<boolean>((resolve) => {
    proc.once('error', (error) => {
      console.log(`[sidecar] spawn error: ${String(error)}`)
      resolve(true)
    })
    proc.once('exit', () => resolve(true))
  })
  const healthy = await Promise.race([waitForHealthy(baseUrl, 30_000), died.then(() => false)])
  if (!healthy) {
    stopSidecar() // タイムアウトしたプロセスを孤児化させない
    throw new Error(
      proc.exitCode !== null
        ? `sidecar が起動直後に終了しました (code ${proc.exitCode})`
        : 'sidecar のヘルスチェックがタイムアウトしました'
    )
  }
  apiBaseUrl = baseUrl
  return baseUrl
}

/** llama-server を止める(VRAM を解放する)。
 *
 * バックエンドを自前で起動している場合は stopSidecar のプロセスツリー kill でも
 * 一緒に落ちるが、既存のバックエンドを再利用していた場合は誰も落とさないため、
 * 終了時に必ず明示的に止める。外部起動の llama-server はバックエンド側の
 * マネージャが管理外として扱うので、この呼び出しでは止まらない(意図的)。
 */
async function stopLlamaServer(): Promise<void> {
  if (!apiBaseUrl) return
  // ComfyUI もバックエンドが spawn したものは同じ理由で明示的に止める(VRAM を握ったまま残さない)
  await Promise.allSettled(
    ['/llm/stop', '/comfy/stop'].map((path) =>
      fetch(`${apiBaseUrl}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(4000)
      })
    )
  )
  // 既に落ちている / バックエンドが応答しない場合は諦める(allSettled で握る)
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

/** F12 で画面を PNG に保存する。
 *
 *  capturePage は物理ピクセルで撮るので、Windows の表示が 150% なら PNG は 1.5 倍の
 *  画素数(1920×1080 のウィンドウで 2880×1620)になる。`logical` のとき(Shift+F12)は
 *  倍率で割った大きさに縮めて保存し、**100% のディスプレイで同じ大きさのウィンドウを
 *  撮ったのと同じ絵**(構図はそのまま、1920×1080)にする。倍率はウィンドウのある
 *  ディスプレイから取る。ズームはいじらないので画面はちらつかない
 */
async function captureScreenshot(logical = false): Promise<void> {
  const win = mainWindow
  if (!win) return
  try {
    let image = await win.webContents.capturePage()
    const scale = logical ? screen.getDisplayMatching(win.getBounds()).scaleFactor : 1
    if (scale !== 1) {
      const { width, height } = image.getSize()
      image = image.resize({ width: Math.round(width / scale), height: Math.round(height / scale), quality: 'best' })
    }
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
    icon: appIconPath(),
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
    // F12 = 物理ピクセルのまま撮る / Shift+F12 = 表示倍率(150% など)で割った大きさに縮めて保存
    if (input.type === 'keyDown' && input.key === 'F12') {
      void captureScreenshot(input.shift)
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

// 二重起動防止: 2 つ目のインスタンスは即終了し、既存ウィンドウを前面に出す。
// 二重に起動すると userData の Chromium キャッシュを取り合い、起動ログに
// GPU キャッシュの Access Denied が並ぶ(実害は小さいが紛らわしい)
if (!app.requestSingleInstanceLock()) {
  // ready 前の quit は「ready 後に終了」扱いなので、下の whenReady が一瞬走らないよう
  // ここでウィンドウ生成と sidecar 起動を抑止する
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return
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
    return { current: currentLibraryRoot(), recents: config.recentRoots, defaultParent: defaultCreateParent(config) }
  })
  ipcMain.handle('library:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'ライブラリを開く',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    return { root, isLibrary: isLibraryFolder(root) }
  })
  ipcMain.handle('library:isLibrary', (_event, root: string) => isLibraryFolder(root))
  ipcMain.handle('library:chooseParent', async (_event, defaultPath: string) => {
    const options: Electron.OpenDialogOptions = {
      title: 'ライブラリを作る場所を選択',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    // 名前の入力欄へ戻るので、キー入力が画面へ戻らないことがないようにする(ConfirmDialog.tsx の注意と同じ症状)
    mainWindow?.webContents.focus()
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('library:create', (_event, parent: string, name: string) => {
    const result = createLibraryFolder(parent, name)
    if ('root' in result) {
      const config = loadConfig()
      config.createParent = parent
      saveConfig(config)
    }
    return result
  })
  ipcMain.handle('library:switch', (_event, root: string) => {
    rememberLibraryRoot(root)
    return root
  })
  // 外部バックアップ(docs/design/backup.md)。パスを選ぶのはネイティブダイアログ、
  // zip の読み書きはバックエンド(同じ PC にいるのでファイル本体は HTTP に流さない)
  ipcMain.handle('backup:chooseSaveFile', async (_event, defaultName: string, defaultDir: string) => {
    const name = defaultName || 'story-graph-backup.zip'
    const dir = defaultDir && existsSync(defaultDir) ? defaultDir : app.getPath('documents')
    const result = await dialog.showSaveDialog({
      title: 'バックアップの保存先',
      defaultPath: join(dir, name),
      filters: [{ name: 'zip アーカイブ', extensions: ['zip'] }]
    })
    return result.canceled || !result.filePath ? null : result.filePath
  })
  ipcMain.handle('backup:chooseZip', async () => {
    const result = await dialog.showOpenDialog({
      title: '復元するバックアップ(zip)を選択',
      properties: ['openFile'],
      filters: [{ name: 'zip アーカイブ', extensions: ['zip'] }]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('backup:chooseDir', async (_event, title: string) => {
    const result = await dialog.showOpenDialog({
      title: title || 'フォルダを選択',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  // スクリーンショット通知のクリックから、保存先をエクスプローラーで開く
  ipcMain.handle('shell:reveal', (_event, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return false
    shell.showItemInFolder(normalize(filePath)) // 区切りが / 混じりでも Windows のエクスプローラーが選択できるよう揃える
    return true
  })
  // フォルダ自体を開く(バックアップの保存先など)。
  // 保存先はまだ一度もバックアップしていないと存在しないので、その場で作ってから開く
  // (作れない・開けないときは false を返し、呼び出し側がその旨を出す)
  ipcMain.handle('shell:openFolder', async (_event, dirPath: string) => {
    if (!dirPath) return false
    try {
      if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
    } catch {
      return false
    }
    const error = await shell.openPath(dirPath)
    return !error
  })
  createWindow()
  void ensureSidecar().catch((error) => console.error('[sidecar] 起動失敗:', error))
})

app.on('window-all-closed', () => {
  app.quit() // 実際の片付けは before-quit で行う
})

// 終了時は llama-server を止めてから sidecar を落とす。fetch を待つ必要があるので
// 一度 quit を止め、片付けが終わってから再度 quit する
let cleanedUp = false
app.on('before-quit', (event) => {
  if (cleanedUp) return
  event.preventDefault()
  void (async () => {
    await stopLlamaServer()
    stopSidecar()
    cleanedUp = true
    app.quit()
  })()
})

app.on('quit', () => {
  stopSidecar() // 保険(before-quit を通らない経路でも sidecar は落とす)
})
