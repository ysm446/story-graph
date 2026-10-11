// 隔離したライブラリとElectronで、共通チャットの配置・下書き保持・編集ガードを検証する。
const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createServer } = require('node:net')
const root = resolve(__dirname, '..')
const target = join(root, 'data', `workspace-check-${Date.now()}`)
mkdirSync(target, { recursive: true })
app.setPath('userData', join(target, 'electron'))
let backend
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
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
  for (const [path, value] of [['/characters', { name: '検証キャラ', profile: '保存済みプロフィール' }], ['/nodes', { title: '検証シーン', beat: '保存済みの本文。' }]]) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    if (!response.ok) throw new Error(await response.text())
  }
  ipcMain.handle('bootstrap', () => ({ apiBaseUrl: base, error: null }))
  const chapterCheck = process.argv.includes('--chapter')
  if (chapterCheck) {
    const graph = await (await fetch(base + '/graph')).json()
    const response = await fetch(base + '/groups', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'検証章',node_ids:graph.nodes.filter(n=>!n.kind).map(n=>n.id)})})
    if (!response.ok) throw new Error(await response.text())
  }
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
  const click = async (label) => {
    await js(`(() => { const el = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(label)} && e.getClientRects().length); if (!el) throw new Error('ボタンがありません: ' + ${JSON.stringify(label)}); el.click() })()`)
    await pause(180)
  }
  const assert = async (condition, message) => {
    if (!await js(condition)) throw new Error(message)
    console.log('PASS ' + message)
  }
  const input = async (selector, value) => {
    await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('入力欄がありません'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await pause(100)
  }
  for (let i=0; i<60; i++) {
    if (await js(`!!document.querySelector('.react-flow')`)) break
    await pause(200)
  }
  await click('チャット')
  await click('制作')
  if (process.argv.includes('--details') || chapterCheck) {
    const targetText = chapterCheck ? '検証章' : '検証シーン'
    for (let i = 0; i < 60; i++) {
      if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes(${JSON.stringify(targetText)}))`)) break
      await pause(100)
    }
    await js(`(() => {const node=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes(${JSON.stringify(targetText)})); node.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`)
    await pause(300)
    await assert(`(() => {const a=document.querySelector('.scene-detail-main').getBoundingClientRect();const b=document.querySelector('.scene-detail-meta').getBoundingClientRect(); return b.x>=a.right-1 && Math.abs(a.y-b.y)<1;})()`, '広い詳細欄は本文と補助情報の2列')
    const divider = await js(`(() => {const r=document.querySelector('.scene-detail-divider').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y+30),width:document.querySelector('.scene-detail-meta').clientWidth}})()`)
    await js(`(() => {const el=document.querySelector('.scene-detail-divider');const rect=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:rect.x,clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.x-80,clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointerup'));})()`)
    await pause(200)
    const widthKey = chapterCheck ? 'chapterDetailMetaWidth' : 'sceneDetailMetaWidth'
    await assert(`document.querySelector('.scene-detail-meta').clientWidth > ${divider.width + 40} && Number(localStorage.getItem(${JSON.stringify(widthKey)})) > 42`, '境界のドラッグで補助情報を拡大し幅を保存')
    writeFileSync(join(target, 'details-wide.png'), (await win.webContents.capturePage()).toPNG())
    win.setSize(1050, 800)
    await pause(300)
    await assert(`getComputedStyle(document.querySelector('.scene-detail-layout')).display==='block'`, '狭い詳細欄は1列へ切り替わる')
    writeFileSync(join(target, 'details-narrow.png'), (await win.webContents.capturePage()).toPNG())
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  // 入力欄の文言変更にも追従するため、制作パネル末尾のtextareaを識別する。
  const productionInput = await js(`(() => {const all=[...document.querySelectorAll('textarea')].filter(e=>e.getClientRects().length); const e=all.at(-1); e.dataset.workspaceInput='1'; return 'textarea[data-workspace-input="1"]'})()`)
  await input(productionInput, '会話の下書きを保持する検証')
  await assert(`(() => {const canvas=document.querySelector('.react-flow').getBoundingClientRect(); const detail=[...document.querySelectorAll('aside')].find(e=>e.textContent.includes('清書') && e.getClientRects().length).getBoundingClientRect(); const chat=document.querySelector(${JSON.stringify(productionInput)}).getBoundingClientRect(); return detail.y >= canvas.bottom - 1 && chat.x > detail.right; })()`, '詳細欄はキャンバス下、チャットは右')
  await click('資料庫')
  await assert(`document.querySelector(${JSON.stringify(productionInput)}).value === '会話の下書きを保持する検証'`, '資料庫へ切り替えても制作の下書きを保持')
  await click('鑑賞')
  await assert(`!document.querySelector(${JSON.stringify(productionInput)}).getClientRects().length`, '鑑賞ではチャットを非表示')
  await click('構造')
  await click('チャット')
  await click('チャット')
  await assert(`document.querySelector(${JSON.stringify(productionInput)}).value === '会話の下書きを保持する検証'`, '鑑賞からの復帰と開閉で下書きを保持')
  await click('相談')
  await click('制作')
  await assert(`document.querySelector(${JSON.stringify(productionInput)}).value === '会話の下書きを保持する検証'`, '相談・制作の切替で下書きを保持')
  await click('資料庫')
  // 登録した人物を選択して未保存のプロフィールを作る。
  await js(`(() => {const el=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && e.textContent.includes('検証キャラ')); if(!el) throw new Error('人物なし'); el.click()})()`)
  await pause(200)
  const profileSelector = await js(`(() => {const e=[...document.querySelectorAll('textarea')].find(e=>e.value==='保存済みプロフィール'); e.dataset.workspaceProfile='1';return 'textarea[data-workspace-profile="1"]'})()`)
  await input(profileSelector, '未保存のプロフィール')
  await click('制作を実行')
  await click('送信')
  await assert(`document.body.textContent.includes('未保存の資料があります')`, '未保存の資料がある場合は制作の実行を拒否')
  await click('構造')
  await click('資料庫')
  await assert(`document.querySelector(${JSON.stringify(profileSelector)}).value === '未保存のプロフィール'`, '資料庫の未保存編集もモードをまたいで保持')
  await input(profileSelector, '保存済みプロフィール')
  // LLMは起動せず、SSEの到着順と確定済みデータの再読込を検証する。
  await js(`(() => {
    const original = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).endsWith('/production/send')) {
        const stream = new ReadableStream({start(controller) {
          window.workspaceEmit = event => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\\n\\n'));
          window.workspaceFinish = () => { window.workspaceEmit({done:true}); controller.close() };
        }});
        return Promise.resolve(new Response(stream, {headers:{'Content-Type':'text/event-stream'}}));
      }
      return original(url, options);
    };
  })()`)
  await click('送信')
  await assert(`!!window.workspaceEmit && [...document.querySelectorAll('[inert]')].some(e=>e.textContent.includes('検証キャラ'))`, '制作中は資料庫の手動編集をロック')
  await click('構造')
  await click('資料庫')
  const characters = await (await fetch(base + '/characters')).json()
  const character = characters[0]
  await fetch(`${base}/characters/${character.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:'制作で更新したプロフィール'})})
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'update_character', entity_type:'character', entity_id:character.id,title:character.name,reason:'検証更新',before:{},after:{profile:'制作で更新したプロフィール'}}})})`)
  await pause(300)
  await assert(`[...document.querySelectorAll('textarea')].some(e=>e.value==='制作で更新したプロフィール')`, '資料庫の制作結果が編集欄へ反映される')
  await js(`window.workspaceFinish()`)
  await pause(200)
  await assert(`document.body.textContent.includes('完了しました（経過時間')`, 'モードを切り替えても制作ストリームが完了する')
  await click('構造')
  await pause(400)
  writeFileSync(join(target, 'workspace.png'), (await win.webContents.capturePage()).toPNG())
  console.log('Screenshot: ' + join(target, 'workspace.png'))
  if (errors.length) throw new Error(errors.join('\n'))
  win.destroy()
}
main().then(() => { backend?.kill(); app.exit(0) }).catch((error) => { console.error(error); backend?.kill(); app.exit(1) })
