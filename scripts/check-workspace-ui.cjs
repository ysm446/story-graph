// 隔離したライブラリとElectronで、共通チャットの配置・下書き保持・編集ガードを検証する。
const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
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
  const historyCheck = process.argv.includes('--history')
  if (historyCheck || process.argv.includes('--width')) {
    const seed = spawnSync(join(root, '.venv/Scripts/python.exe'), ['-c', `from app import store
for mode in ['production', None]:
 for title in ['history-one', 'history-two']:
  chat = store.create_chat(None, 'upto', mode=mode)
  store.set_chat_title(chat['id'], title + ${process.argv.includes('--width') ? "'long-title-' * 30" : "''"})
  store.save_chat_messages(chat['id'], [{'role':'user','content':title + '-message'}])
`], {cwd:join(root,'backend'),env:{...process.env,STORY_GRAPH_LIBRARY:target},windowsHide:true,encoding:'utf8'})
    if (seed.status !== 0) throw new Error(seed.stderr)
  }
  const tabsCheck = process.argv.includes('--tabs')
  if (tabsCheck) {
    const chars = await (await fetch(base + '/characters')).json()
    const graph = await (await fetch(base + '/graph')).json()
    const node = graph.nodes.find(n => !n.kind)
    const char = chars[0]
    const otherResponse = await fetch(base + '/characters', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'相手キャラ'})})
    if (!otherResponse.ok) throw new Error(await otherResponse.text())
    const other = await otherResponse.json()
    const update = async (path, value) => {
      const r = await fetch(base + path, {method:path.endsWith('/events') ? 'PUT' : 'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})
      if (!r.ok) throw new Error(await r.text())
    }
    await update('/nodes/' + node.id, {cast:[char.id]})
    await update('/nodes/' + node.id + '/events', {events:[
      {type:'char_introduce',payload:{char:char.id}},
      {type:'char_introduce',payload:{char:other.id}},
      {type:'relationship_set',payload:{char:char.id,target_type:'char',target:other.id,value:0.6,reason:'検証用の関係',label:'友人'}},
      ...Array.from({length:14}, (_,i)=>({type:'fact_set',payload:{scope:'char',char:char.id,key:'検証項目'+i,value:'確認する事実の内容'+i}})),
      {type:'memory_add',payload:{char:char.id,content:'このシーンで得た記憶を確認します。',emotion:0,importance:0.5,refs:[]}}
    ]})
  }
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
  if (process.argv.includes('--settings')) {
    await click('資料庫')
    const fill = async (label, value) => {
      await js(`(() => {const el=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
      await pause(100)
    }
    await js(`document.querySelector('[aria-label="設定資料を追加"]').click()`)
    await pause(500)
    await assert(`document.querySelector('[aria-label="資料の扱い"]').value==='draft' && document.querySelector('[aria-label="AIへの参照方法"]').value==='search'`, '新規設定資料は構想・必要に応じて検索')
    await fill('設定資料のタイトル', '王都の交通制度')
    await fill('設定資料の分類', '制度')
    await fill('設定資料の本文', '# 通行証\n夜間の通行には通行証が必要。')
    await fill('資料の扱い', 'confirmed')
    await fill('AIへの参照方法', 'always')
    await fill('適用範囲・時点', '王都・第一章以降')
    await assert(`document.querySelector('[aria-label="設定資料の編集"]').textContent.includes('未保存') && document.querySelector('#library-settings').textContent.includes('未保存')`, '一覧と編集欄に未保存を表示')
    await click('保存')
    await pause(300)
    const saved = await (await fetch(base+'/setting-documents')).json()
    if (saved.length!==1 || saved[0].title!=='王都の交通制度' || saved[0].status!=='confirmed' || saved[0].ai_mode!=='always' || saved[0].scope!=='王都・第一章以降') throw new Error('設定資料が保存されていません')
    await assert(`!document.querySelector('[aria-label="設定資料の編集"]').textContent.includes('未保存')`, '保存すると未保存表示が消える')
    await fill('設定資料の本文', '未保存の本文')
    await js(`document.querySelector('#library-characters button').click()`)
    await pause(150)
    await js(`document.querySelector('#library-settings button').click()`)
    await pause(150)
    await assert(`document.querySelector('[aria-label="設定資料の本文"]').value==='未保存の本文'`, '種類の切替後も下書きを保持')
    await click('元に戻す')
    await assert(`document.querySelector('[aria-label="設定資料の本文"]').value.includes('夜間の通行')`, '元に戻すで保存済み本文へ復帰')
    await click('プレビュー')
    await assert(`document.querySelector('[aria-label="設定資料の編集"] h1')?.textContent==='通行証'`, '本文をMarkdownでプレビュー')
    writeFileSync(join(target, 'settings.png'), (await win.webContents.capturePage()).toPNG())
    await js(`window.confirm=()=>false; void 0`)
    await click('削除')
    await assert(`!!document.querySelector('[aria-label="設定資料のタイトル"]')`, '削除のキャンセルで資料を維持')
    await js(`window.confirm=()=>true; void 0`)
    await click('削除')
    await pause(250)
    if ((await (await fetch(base+'/setting-documents')).json()).length) throw new Error('削除が反映されていません')
    console.log('PASS 確認後に資料を削除')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--width')) {
    for (const width of [440, 320]) {
      await js(`document.querySelector('[aria-label="チャットの幅"]').parentElement.style.width='${width}px'`)
      await pause(200)
      await assert(`(() => {const input=document.querySelector('textarea[aria-label="制作への依頼"]');const panel=document.querySelector('[aria-label="チャットの幅"]').parentElement.getBoundingClientRect();const root=input.parentElement.parentElement;return root.getBoundingClientRect().right<=panel.right+1 && root.scrollWidth<=root.clientWidth+1;})()`, width + 'pxで制作チャットが右端に収まる')
      await click('会話一覧')
      await assert(`document.querySelector('[aria-label="チャットの幅"]').parentElement.scrollWidth<=${width+1}`, width + 'pxで会話一覧を開いても横にはみ出さない')
      writeFileSync(join(target, 'chat-width-' + width + '.png'), (await win.webContents.capturePage()).toPNG())
      await click('会話一覧')
      await assert(`!document.querySelector('aside[aria-label="会話一覧"]')`, width + 'pxで会話一覧をボタンで閉じる')
    }
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (historyCheck) {
    for (const mode of ['制作','相談']) {
      if (mode === '相談') await click(mode)
      await click('会話一覧')
      await js(`[...document.querySelectorAll('aside button')].find(e=>e.getClientRects().length && e.textContent.includes('history-one')).click()`)
      await pause(200)
      await assert(`document.body.textContent.includes('history-one-message') && !document.querySelector('aside[aria-label="会話一覧"]')`, mode + 'の一覧から会話を開くと一覧を閉じる')
      await click('会話一覧')
      await js(`(() => {const row=[...document.querySelectorAll('aside .group')].find(e=>e.textContent.includes('history-two') && e.getClientRects().length);row.querySelector('[aria-label="この会話の操作"]').click()})()`)
      await click('名前を変更')
      await js(`(() => {const el=[...document.querySelectorAll('input[placeholder="会話名(空で既定に戻す)"]')].find(e=>e.getClientRects().length);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'renamed-history');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await pause(100)
      await js(`document.querySelector('input[placeholder="会話名(空で既定に戻す)"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
      for (let i=0; i<50; i++) {
        if (await js(`document.body.textContent.includes('renamed-history')`)) break
        await pause(100)
      }
      await assert(`document.body.textContent.includes('renamed-history')`, mode + 'の会話名を変更')
      await js(`(() => {window.confirm=()=>true;const row=[...document.querySelectorAll('aside .group')].find(e=>e.textContent.includes('renamed-history') && e.getClientRects().length);row.querySelector('[aria-label="この会話の操作"]').click()})()`)
      await click('削除')
      await assert(`document.body.textContent.includes('history-one-message') && ![...document.querySelectorAll('aside .group')].some(e=>e.getClientRects().length && e.textContent.includes('renamed-history'))`, mode + 'の別会話を削除しても現在の会話を保持')
      await click('+ 新しい会話')
      await assert(`!document.querySelector('aside[aria-label="会話一覧"]')`, mode + 'で新しい会話を始めると一覧を閉じる')
      await click('会話一覧')
      await assert(`![...document.querySelectorAll('aside .group')].some(e=>e.getClientRects().length && e.style.background)`, mode + 'で新しい会話を開始')
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
      await pause(150)
      await assert(`!document.querySelector('aside[aria-label="会話一覧"]')`, mode + 'の会話一覧をEscapeで閉じる')
    }
    if (errors.length) throw new Error(errors.join('\n'))
    win.destroy()
    return
  }
  if (process.argv.includes('--details') || chapterCheck || tabsCheck) {
    const targetText = chapterCheck ? '検証章' : '検証シーン'
    for (let i = 0; i < 60; i++) {
      if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes(${JSON.stringify(targetText)}))`)) break
      await pause(100)
    }
    await js(`(() => {const node=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes(${JSON.stringify(targetText)})); node.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`)
    await pause(300)
    if (tabsCheck) {
      for (const label of ['清書','キャラ','関係図','事実']) {
        await click(label)
        await pause(250)
        await assert(`(() => {const aside=[...document.querySelectorAll('aside')].find(e=>e.textContent.includes('清書'));return aside.scrollWidth<=aside.clientWidth+1;})()`, label + 'は詳細欄の幅内に収まる')
        if (label !== '事実') await assert(`!!document.querySelector('.scene-detail-layout')`, label + 'は左右分割')
        if (label === '関係図') {
          await assert(`document.querySelector('.scene-detail-main svg').querySelectorAll('g[transform]').length===2`, '関係図に登場人物を表示')
          await js(`document.querySelector('.scene-detail-main svg polyline[stroke="transparent"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
          await pause(100)
          await assert(`document.querySelector('.scene-detail-meta').textContent.includes('検証用の関係')`, '関係線のクリックで右欄に履歴を表示')
        }
        if (label === '事実') {
          await assert(`!!document.querySelector('aside .sticky.top-0')`, '事実のシーン見出しを固定')
        }
        writeFileSync(join(target, label + '-wide.png'), (await win.webContents.capturePage()).toPNG())
        win.setSize(1050,800)
        await pause(250)
        if (label !== '事実') await assert(`getComputedStyle(document.querySelector('.scene-detail-layout')).display==='block'`, label + 'は狭幅で1列')
        writeFileSync(join(target, label + '-narrow.png'), (await win.webContents.capturePage()).toPNG())
        win.setSize(1440,1000)
        await pause(250)
      }
      if (errors.length) throw new Error(errors.join('\n'))
      console.log('Screenshots: ' + target)
      win.destroy()
      return
    }
    await assert(`(() => {const a=document.querySelector('.scene-detail-main').getBoundingClientRect();const b=(document.querySelector('.scene-detail-side')||document.querySelector('.scene-detail-meta')).getBoundingClientRect(); return (document.querySelector(".detail-main-right, .detail-three") ? a.x>=b.right-1 : b.x>=a.right-1) && Math.abs(a.y-b.y)<1;})()`, '広い詳細欄は本文と補助情報の2列')
    const divider = await js(`(() => {const r=document.querySelector('.scene-detail-divider').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y+30),width:document.querySelector('.scene-detail-meta').clientWidth}})()`)
    await js(`(() => {const el=document.querySelector('.scene-detail-divider');const rect=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:rect.x,clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.x+(document.querySelector(".detail-main-right, .detail-three") ? 80 : -80),clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointerup'));})()`)
    await pause(200)
    const widthKey = chapterCheck ? 'chapterDetailListWidth' : 'sceneDetailEventsWidth'
    await assert(`document.querySelector('.scene-detail-meta').clientWidth > ${divider.width + 40} && Number(localStorage.getItem(${JSON.stringify(widthKey)})) > 34`, '境界のドラッグで補助情報を拡大し幅を保存')
    {
      // シーン・章のタブは幅で 3列 → 2列(左の2つを縦に重ねる) → 1列 と切り替わる
      const middle = chapterCheck ? 'シーン(' : 'イベント'
      const rects = `(() => {const r=(q)=>{const b=document.querySelector(q).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,right:b.right,bottom:b.bottom}};return {aside:r('.scene-detail-aside'),meta:r('.scene-detail-meta'),main:r('.scene-detail-main'),width:document.querySelector('.scene-detail').clientWidth}})()`
      const medium = await js(rects)
      if (!(medium.width < 1100 && Math.abs(medium.aside.x - medium.meta.x) < 1 && medium.meta.y >= medium.aside.bottom - 1 && medium.main.x >= medium.aside.right - 1)) errors.push('中くらいの幅で挿絵・設定とイベントが左の1列に重なっていない: ' + JSON.stringify(medium))
      else console.log('PASS 中くらいの幅では挿絵・設定とイベントを左に重ね、本文を右に置く')
      writeFileSync(join(target, 'details-medium.png'), (await win.webContents.capturePage()).toPNG())
      win.setSize(1900, 1000)
      await pause(400)
      const wide = await js(rects)
      if (!(wide.width >= 1100 && Math.abs(wide.aside.y - wide.meta.y) < 1 && Math.abs(wide.meta.y - wide.main.y) < 1 && wide.meta.x >= wide.aside.right - 1 && wide.main.x >= wide.meta.right - 1 && Math.round(wide.aside.width) === 264)) errors.push('広い幅で3列になっていない: ' + JSON.stringify(wide))
      else console.log('PASS 広い幅では挿絵・設定 / イベント / 本文の3列')
      await assert(`document.querySelector('.scene-detail-meta').textContent.includes(${JSON.stringify(middle)}) && !document.querySelector('.scene-detail-aside').textContent.includes(${JSON.stringify(middle)})`, (chapterCheck ? 'シーン一覧' : 'イベント') + 'は中央の列に置く')
      if (chapterCheck) await assert(`document.querySelector('.scene-detail-aside').textContent.includes('表紙') && document.querySelector('.scene-detail-main').textContent.includes('まとめ')`, '章は左に表紙、右にまとめを置く')
      const before = wide.meta.width
      await js(`(() => {const el=document.querySelector('.scene-detail-divider');const rect=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:rect.x,clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.x+60,clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointerup'))})()`)
      await pause(200)
      const dragged = await js(rects)
      if (!(Math.abs(dragged.meta.width - before - 60) < 6 && Math.round(dragged.aside.width) === 264)) errors.push('3列の境界ドラッグでイベント列だけが広がっていない: ' + JSON.stringify({ before, after: dragged.meta.width, aside: dragged.aside.width }))
      else console.log('PASS 3列の境界ドラッグはイベント列だけを広げる')
      await js(`(() => {const el=document.querySelector('.scene-detail-aside-divider');const rect=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:rect.x,clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.x+56,clientY:rect.y+30}));window.dispatchEvent(new PointerEvent('pointerup'))})()`)
      await pause(200)
      const asideDragged = await js(rects)
      if (!(Math.abs(asideDragged.aside.width - 320) < 4 && Number(await js(`localStorage.getItem(${JSON.stringify(widthKey + 'Aside')})`)) === Math.round(asideDragged.aside.width) && asideDragged.meta.x >= asideDragged.aside.right - 1 && asideDragged.main.x >= asideDragged.meta.right - 1)) errors.push('左の境界のドラッグで挿絵・設定の列が広がっていない: ' + JSON.stringify(asideDragged))
      else console.log('PASS 左の境界のドラッグで挿絵・設定の列を広げ、幅を保存')
      writeFileSync(join(target, 'details-three.png'), (await win.webContents.capturePage()).toPNG())
      if (errors.length) throw new Error(errors.join('\n'))
    }
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
  await assert(`(() => {const buttons=[...document.querySelectorAll('nav[aria-label="資料の種類と一覧"] button[aria-expanded]')];return buttons.length===3 && buttons[0].textContent.includes('キャラクター') && buttons[1].textContent.includes('場所') && buttons[2].textContent.includes('設定資料');})()`, '資料の種類はキャラクター・場所・設定資料の順に縦に並ぶ')
  await js(`document.querySelector('[aria-controls="library-characters"]').click()`)
  await pause(100)
  await assert(`document.querySelector('#library-characters').hidden && !document.querySelector('#library-places').hidden`, '種類の一覧を独立して折りたためる')
  await js(`document.querySelector('[aria-controls="library-characters"]').click()`)
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
  await click('会話一覧')
  await assert(`[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && e.textContent.trim()==='+ 新しい会話').disabled`, '制作中は一覧から新しい会話を開始できない')
  await js(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  await pause(150)
  await assert(`!document.querySelector('aside[aria-label="会話一覧"]')`, '会話一覧は外側のクリックで閉じる')
  await js(`window.workspaceEmit({preview:{node_id:null,beat:'生成中の本文プレビュー'}})`)
  await pause(150)
  await assert(`(() => {const preview=document.querySelector('[aria-label="AI編集中の本文プレビュー"]'); const input=document.querySelector(${JSON.stringify(productionInput)}); return preview?.getClientRects().length && input.parentElement.contains(preview) && preview.textContent.includes('生成中の本文プレビュー');})()`, '資料庫でも制作チャット内に本文プレビューを表示')
  await click('構造')
  await assert(`(() => {const preview=document.querySelector('[aria-label="AI編集中の本文プレビュー"]'); const detail=[...document.querySelectorAll('aside')].find(e=>e.textContent.includes('清書'));return preview?.getClientRects().length && !detail.contains(preview);})()`, '構造に戻ってもプレビューは詳細欄に入らない')
  const characters = await (await fetch(base + '/characters')).json()
  const character = characters[0]
  await js(`document.querySelector('[aria-controls="library-characters"]').click()`)
  await js(`window.workspaceEmit(${JSON.stringify({active_library:{kind:'character',id:character.id}})})`)
  await pause(250)
  await assert(`[...document.querySelectorAll('input')].some(e=>e.getClientRects().length && e.value==='検証キャラ')`, 'キャラクター編集開始で構造から資料庫へ追従')
  await assert(`!document.querySelector('#library-characters').hidden`, '制作の追従で対象の種類を自動展開')
  await fetch(`${base}/characters/${character.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:'制作で更新したプロフィール'})})
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'update_character', entity_type:'character', entity_id:character.id,title:character.name,reason:'検証更新',before:{},after:{profile:'制作で更新したプロフィール'}}})})`)
  await pause(300)
  await assert(`[...document.querySelectorAll('textarea')].some(e=>e.value==='制作で更新したプロフィール')`, '資料庫の制作結果が編集欄へ反映される')
  const placeResponse = await fetch(base + '/places', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'追従先の場所'})})
  const place = await placeResponse.json()
  const placeChange = {changed:{action:'create_place',entity_type:'place',entity_id:place.id,title:place.name,reason:'場所を追加',before:null,after:{name:place.name}}}
  await js(`window.workspaceEmit(${JSON.stringify(placeChange)})`)
  await pause(400)
  await assert(`[...document.querySelectorAll('input')].some(e=>e.getClientRects().length && e.value==='追従先の場所')`, '新規の場所は一覧の再取得後に選択して表示')
  const settingsResponse = await fetch(base + '/setting-documents', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'制作で作成した設定',body:'王都の制度'})})
  const setting = await settingsResponse.json()
  await js(`document.querySelector('[aria-controls="library-settings"]').click()`)
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'create_setting_document',entity_type:'setting_document',entity_id:setting.id,title:setting.title,reason:'設定資料を作成',before:null,after:{body:setting.body}}})})`)
  await pause(400)
  await assert(`document.querySelector('[aria-label="設定資料のタイトル"]').value==='制作で作成した設定' && !document.querySelector('#library-settings').hidden && !!document.querySelector('[aria-label="設定資料のタイトル"]').getClientRects().length`, '設定資料の作成後に種類を展開して編集欄へ追従')
  await click('構造')
  await js(`window.workspaceEmit(${JSON.stringify({active_library:{kind:'setting_document',id:setting.id}})})`)
  await pause(200)
  await assert(`!!document.querySelector('[aria-label="設定資料のタイトル"]').getClientRects().length`, '設定資料の編集開始で資料庫へ追従')
  await fetch(base + '/setting-documents/' + setting.id, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:setting.title,body:'更新した制度',revision:setting.revision})})
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'update_setting_document',entity_type:'setting_document',entity_id:setting.id,title:setting.title,reason:'設定資料を更新',before:{body:setting.body},after:{body:'更新した制度'}}})})`)
  await pause(300)
  await assert(`document.querySelector('[aria-label="設定資料の本文"]').value==='更新した制度'`, '設定資料の制作結果を編集欄へ反映')
  await click('☑ 作業対象を追う')
  await click('構造')
  await js(`window.workspaceEmit(${JSON.stringify({active_library:{kind:'character',id:character.id}})})`)
  await pause(200)
  await assert(`![...document.querySelectorAll('input')].some(e=>e.getClientRects().length && e.value==='検証キャラ')`, '追従オフでは資料庫へ移動しない')
  await click('☐ 作業対象を追う')
  await pause(200)
  await assert(`[...document.querySelectorAll('input')].some(e=>e.getClientRects().length && e.value==='検証キャラ')`, '追従をオンに戻すと最後のキャラクターを表示')
  const followGraph = await (await fetch(base + '/graph')).json()
  const chapterResponse = await fetch(base + '/groups', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'制作した章',node_ids:[]})})
  if (!chapterResponse.ok) throw new Error(await chapterResponse.text())
  const chapter = await chapterResponse.json()
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'create_chapter',entity_type:'chapter',entity_id:chapter.id,title:chapter.title,reason:'章を作成',before:null,after:{title:chapter.title,node_ids:''}}})})`)
  await pause(700)
  await assert(`!!document.querySelector('.react-flow__node[data-id="chapter:${chapter.id}"].selected') && !!document.querySelector('.react-flow').getClientRects().length`, '章作成後は構造画面の章カードを選択して追従')
  await fetch(base + '/groups/' + chapter.id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'制作で改名した章'})})
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'rename_chapter',entity_type:'chapter',entity_id:chapter.id,title:'制作で改名した章',reason:'章名を変更',before:{title:chapter.title},after:{title:'制作で改名した章'}}})})`)
  await pause(500)
  await assert(`document.querySelector('.react-flow__node[data-id="chapter:${chapter.id}"]').textContent.includes('制作で改名した章') && document.body.textContent.includes('章名を変更: 制作で改名した章')`, '章の改名がカードと制作履歴に反映')
  await js(`window.workspaceEmit(${JSON.stringify({active_node:followGraph.nodes.find(n=>!n.kind).id})})`)
  await pause(250)
  await assert(`!!document.querySelector('.react-flow').getClientRects().length`, 'シーンの作業へ戻ると資料庫から構造へ追従')
  await js(`window.workspaceEmit({delta:'設定資料の制度案を更新しました。'}); window.workspaceEmit({response_end:true}); window.workspaceFinish()`)
  await pause(200)
  await assert(`document.body.textContent.includes('完了しました（経過時間')`, 'モードを切り替えても制作ストリームが完了する')
  await assert(`!document.querySelector('[aria-label="AI編集中の本文プレビュー"]')`, '制作終了で未確定のプレビューを消す')
  await assert(`(() => {const panel=document.querySelector('[aria-label="制作の依頼候補"]');return panel?.querySelector('button').textContent==='この案で進めて' && panel.textContent.includes('今回の変更をレビュー') && panel.querySelectorAll('button').length<=3})()`, '制作後の候補はこの案で進めてを先頭に最大3件表示')
  await js(`window.workspaceSuggestionSent=false;const previous=window.fetch;window.fetch=(url,options)=>{if(String(url).endsWith('/production/send'))window.workspaceSuggestionSent=true;return previous(url,options)};void 0`)
  await click('今回の変更をレビュー')
  await assert(`document.querySelector('textarea[aria-label="制作への依頼"]').value.includes('制作で作成した設定') && !window.workspaceSuggestionSent`, '候補は対象を含む依頼文を入力するだけで送信しない')
  await assert(`document.activeElement===document.querySelector('textarea[aria-label="制作への依頼"]') && [...document.querySelectorAll('[aria-label="制作の依頼候補"] button')].every(e=>e.disabled)`, '候補選択で入力欄にフォーカスし下書きの上書きを防ぐ')
  await assert(`document.querySelector('[aria-label="制作チャットの送信モード"] [aria-pressed="true"]').textContent==='制作を実行'`, '候補選択で送信モードを変更しない')
  await input('textarea[aria-label="制作への依頼"]', '')
  await click('この案で進めて')
  await assert(`document.querySelector('textarea[aria-label="制作への依頼"]').value.includes('直前の回答で提示された案') && !window.workspaceSuggestionSent`, 'この案で進めては会話の案を対象に入力し自動送信しない')
  await input('textarea[aria-label="制作への依頼"]', '')
  await click('資料庫')
  await click('追従先の場所')
  const placeDraftInput = await js(`(() => {const e=[...document.querySelectorAll('main textarea')].find(e=>e.getClientRects().length);e.dataset.placeDraftCheck='1';return 'textarea[data-place-draft-check="1"]';})()`)
  await input(placeDraftInput, '種類を切り替えても保持する説明')
  await js(`document.querySelector('#library-characters button').click()`)
  await pause(150)
  await assert(`document.querySelector('#library-places').textContent.includes('未保存')`, '人物を編集中も場所の未保存バッジを表示')
  await js(`document.querySelector('#library-places button').click()`)
  await pause(150)
  await assert(`document.querySelector(${JSON.stringify(placeDraftInput)}).value==='種類を切り替えても保持する説明'`, '種類を行き来しても場所の未保存本文を保持')
  await click('元に戻す')
  await assert(`!document.querySelector('#library-places').textContent.includes('未保存')`, '場所を元に戻すと未保存バッジが消える')
  await click('関係図')
  await assert(`document.querySelector('button[aria-pressed="true"]').textContent.includes('関係図') || [...document.querySelectorAll('button[aria-pressed="true"]')].some(e=>e.textContent==='関係図')`, '見出し横から関係図を開く')
  await js(`document.querySelector('#library-characters button').click()`)
  await pause(150)
  await assert(`[...document.querySelectorAll('input')].some(e=>e.getClientRects().length && e.value==='検証キャラ')`, '資料名のクリックで関係図から編集に戻る')
  await js(`document.querySelector('nav[aria-label="資料の種類と一覧"]').parentElement.style.width='180px'`)
  await assert(`(() => {const n=document.querySelector('nav[aria-label="資料の種類と一覧"]');return n.scrollWidth<=n.clientWidth+1;})()`, '幅180pxでも階層メニューが横にはみ出さない')
  writeFileSync(join(target, 'library-tree.png'), (await win.webContents.capturePage()).toPNG())
  await click('構造')
  await pause(400)
  await js(`document.querySelector('.react-flow__node[data-id="chapter:${chapter.id}"]').click()`)
  await pause(300)
  await assert(`[...document.querySelectorAll('[aria-label="制作の依頼候補"] button')].some(e=>e.textContent==='章「制作で改名した章」をレビュー')`, '章カードを選ぶと章レビューの候補を表示')
  await click('章「制作で改名した章」をレビュー')
  await assert(`(() => {const v=document.querySelector('textarea[aria-label="制作への依頼"]').value;return v.includes('章ID: ${chapter.id}') && v.includes('保存内容は変更せず') && !window.workspaceSuggestionSent})()`, '章レビューは章IDを含む依頼文を入力するだけで送信しない')
  await input('textarea[aria-label="制作への依頼"]', '')
  const memoryToggle = `[...document.querySelectorAll('button')].find(e=>e.textContent.includes('作業メモを使う'))`
  await assert(`${memoryToggle}.getAttribute('aria-pressed')==='false' && [...document.querySelectorAll('summary')].some(e=>e.textContent==='作業メモ · オフ')`, '作業メモは既定でオフと表示')
  await js(`${memoryToggle}.click()`)
  await pause(500)
  await assert(`${memoryToggle}.getAttribute('aria-pressed')==='true' && ![...document.querySelectorAll('summary')].some(e=>e.textContent.includes('オフ'))`, '作業メモをオンに切り替えて表示へ反映')
  if ((await (await fetch(base + '/settings')).json()).production_memory_enabled !== '1') errors.push('作業メモの設定が保存されていない')
  await js(`document.querySelector('button[aria-label="設定"]').click()`)
  await pause(400)
  await assert(`(() => {const items=[...document.querySelectorAll('aside button')].map(e=>e.textContent.trim());const i=items.indexOf('シーン生成');return [...document.querySelectorAll('aside div')].some(e=>e.textContent==='システムプロンプト') && i>0 && items.slice(i,i+5).join('|')==='シーン生成|清書(スタイルプリセット)|校正|制作エージェントへの指示|書き出し / 読み込み'})()`, '設定の左一覧でシステムプロンプトの5項目をまとめて表示')
  await click('シーン生成')
  await pause(300)
  await assert(`document.body.textContent.includes('適用先: 構造モードの「生成」') && document.body.textContent.includes('beat は出来事の記述に徹する')`, 'シーン生成に適用先と必ず付くルールを表示')
  await click('清書(スタイルプリセット)')
  await pause(300)
  await assert(`document.body.textContent.includes('シーンに書かれている出来事以外を発生させない')`, '清書に必ず付く厳守事項を表示')
  await click('制作エージェントへの指示')
  await pause(300)
  await assert(`document.body.textContent.includes('適用先: 制作チャット') && [...document.querySelectorAll('.settings-field-label')].some(e=>e.textContent.includes('実行モードの固定の指示')) && document.body.textContent.includes('今回は相談のみです')`, '制作エージェントへの指示に適用先と固定の指示を表示')
  await input('textarea[aria-label="制作エージェントへの指示(設定)"]', '設定画面から保存した指示')
  await js(`document.querySelector('textarea[aria-label="制作エージェントへの指示(設定)"]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`)
  await pause(600)
  if ((await (await fetch(base + '/settings')).json()).author_chat_rules !== '設定画面から保存した指示') errors.push('設定画面の制作エージェントへの指示が保存されていない')
  await assert(`document.querySelector('textarea[aria-label="制作エージェントへの指示"]').value==='設定画面から保存した指示'`, '設定画面で保存した指示を制作チャットのパネルへ反映')
  writeFileSync(join(target, 'settings-prompts.png'), (await win.webContents.capturePage()).toPNG())
  await js(`[...document.querySelectorAll('button[aria-label="閉じる"]')].find(e=>e.textContent.trim()==='✕').click()`)
  await pause(200)
  writeFileSync(join(target, 'workspace.png'), (await win.webContents.capturePage()).toPNG())
  console.log('Screenshot: ' + join(target, 'workspace.png'))
  if (errors.length) throw new Error(errors.join('\n'))
  win.destroy()
}
main().then(() => { backend?.kill(); app.exit(0) }).catch((error) => { console.error(error); backend?.kill(); app.exit(1) })
