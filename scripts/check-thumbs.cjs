// 隔離したライブラリとElectronで、静止画サムネイルの自動生成と画面外カードの描画抑制を検証する。
const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createServer } = require('node:net')
const root = resolve(__dirname, '..')
const target = join(root, 'data', `thumbs-check-${Date.now()}`)
mkdirSync(target, { recursive: true })
app.setPath('userData', join(target, 'electron'))
let backend
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const SOURCE_PNG = join(root, 'data', 'assets', 'images', 'a98e9c013b93.png') // 1216x832, 1.3MB
const NODE_COUNT = 40

async function main() {
  await app.whenReady()
  const port = await new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => done(port))
    })
  })
  const base = `http://127.0.0.1:${port}`
  backend = spawn(join(root, '.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: join(root, 'backend'), env: { ...process.env, STORY_GRAPH_LIBRARY: target }, windowsHide: true, stdio: 'ignore'
  })
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break } } catch {}
    await pause(200)
  }
  if (!ready) throw new Error('検証用バックエンドを起動できませんでした')
  const post = async (path, value) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    if (!r.ok) throw new Error(path + ': ' + await r.text())
    return r.json()
  }
  // 原寸 PNG をアップロードして、連なる NODE_COUNT 件のシーンに同じ挿絵を付ける
  const form = new FormData()
  form.append('file', new Blob([readFileSync(SOURCE_PNG)], { type: 'image/png' }), 'big.png')
  const upload = await fetch(base + '/assets/upload', { method: 'POST', body: form })
  if (!upload.ok) throw new Error(await upload.text())
  const { path: imagePath } = await upload.json()
  const ids = []
  for (let i = 0; i < NODE_COUNT; i++) {
    const node = await post('/nodes', { title: `シーン ${i + 1}`, beat: `本文 ${i + 1}。` })
    ids.push(node.id)
    // 実アプリと同じくストック経由で現在の挿絵にする(media 行も作られる)
    await post('/media', { owner_type: 'node', owner_id: node.id, path: imagePath, select: true })
  }
  ipcMain.handle('bootstrap', () => ({ apiBaseUrl: base, error: null }))
  ipcMain.handle('library:info', () => ({ current: target, recents: [] }))
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false, preload: join(root, 'out/preload/index.js') } })
  const errors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && !event.message.startsWith('ResizeObserver loop')) {
      errors.push(event.message); console.error(event.message)
    }
  })
  await win.loadFile(join(root, 'out/renderer/index.html'))
  const js = (source) => win.webContents.executeJavaScript(source)
  const assert = (condition, message) => {
    if (!condition) throw new Error('FAIL ' + message)
    console.log('PASS ' + message)
  }
  for (let i = 0; i < 60; i++) {
    if (await js(`!!document.querySelector('.react-flow')`)) break
    await pause(200)
  }
  // サムネイルが全件埋まるのを待つ(1 件ずつ生成するので少し待つ)
  let graph = null
  for (let i = 0; i < 150; i++) {
    graph = await (await fetch(base + '/graph')).json()
    const done = graph.nodes.filter((n) => ids.includes(n.id) && n.thumb_path).length
    if (done === NODE_COUNT) break
    await pause(400)
  }
  const withThumb = graph.nodes.filter((n) => ids.includes(n.id) && n.thumb_path)
  assert(withThumb.length === NODE_COUNT, `${NODE_COUNT} 件すべてに thumb_path が入る(${withThumb.length} 件)`)
  const thumbs = new Set(withThumb.map((n) => n.thumb_path))
  const sample = [...thumbs][0]
  assert(sample.endsWith('.webp'), `静止画のサムネイルは WebP(${sample})`)
  const assetsDir = join(target, 'assets', 'images')
  const thumbFile = join(assetsDir, sample)
  // nativeImage は WebP を読めないので、レンダラで読み込んで寸法を測る
  const size = await js(`new Promise((ok) => { const i = new Image(); i.onload = () => ok({ width: i.naturalWidth, height: i.naturalHeight }); i.onerror = () => ok({ width: 0, height: 0 }); i.src = ${JSON.stringify(base + '/assets/' + sample)} })`)
  assert(Math.max(size.width, size.height) === 576, `長辺が 576px(${size.width}x${size.height})`)
  const bytes = statSync(thumbFile).size
  const original = statSync(join(assetsDir, imagePath)).size
  assert(bytes < original / 5, `サムネイルは原画の 1/5 未満(${Math.round(bytes / 1024)}KB / ${Math.round(original / 1024)}KB)`)
  // ストック(media)にも写っているか
  const media = await (await fetch(`${base}/media/node/${ids[0]}`)).json()
  assert(media.items.some((m) => m.path === imagePath && m.thumb_path === withThumb.find((n) => n.id === ids[0]).thumb_path), 'media.thumb_path にも写る')
  // 画面: カードの <img> はサムネイルを指し、画面外のカードは DOM に無い
  await pause(800)
  const dom = await js(`(() => {
    const imgs = [...document.querySelectorAll('.react-flow__node img')].map((e) => e.getAttribute('src'));
    return { rendered: document.querySelectorAll('.react-flow__node').length, imgs };
  })()`)
  assert(dom.imgs.length > 0 && dom.imgs.every((s) => s.includes('.webp')), `描画中のカードの挿絵がすべてサムネイル(${dom.imgs.length} 枚)`)
  // 全体表示では全カードが画面に入るので、ホイールで拡大してから画面外のカードが DOM から外れることを見る
  await js(`(() => { const pane = document.querySelector('.react-flow__pane'); const r = pane.getBoundingClientRect();
    for (let i = 0; i < 6; i++) pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })) })()`)
  await pause(800)
  const zoomed = await js(`document.querySelectorAll('.react-flow__node').length`)
  assert(zoomed > 0 && zoomed < NODE_COUNT / 2, `拡大すると画面外のカードは描画しない(描画 ${zoomed} / 全 ${NODE_COUNT + 2} ノード。全体表示では ${dom.rendered})`)
  writeFileSync(join(target, 'structure-zoomed.png'), (await win.webContents.capturePage()).toPNG())
  writeFileSync(join(target, 'structure.png'), (await win.webContents.capturePage()).toPNG())
  console.log('Screenshot: ' + join(target, 'structure.png'))
  if (errors.length) throw new Error(errors.join('\n'))
  win.destroy()
}
main().then(() => { backend?.kill(); app.exit(0) }).catch((error) => { console.error(error); backend?.kill(); app.exit(1) })
