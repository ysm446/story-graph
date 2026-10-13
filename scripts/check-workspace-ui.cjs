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
    // 文字の無いアイコンのボタン(送信の ↑ など)は aria-label で探す
    await js(`(() => { const visible = [...document.querySelectorAll('button')].filter(e => e.getClientRects().length); const el = visible.find(e => e.textContent.trim() === ${JSON.stringify(label)}) ?? visible.find(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!el) throw new Error('ボタンがありません: ' + ${JSON.stringify(label)}); el.click() })()`)
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
  if (process.argv.includes('--embedding')) {
    // 設定の Embedding のページ: 起動時に読み込むかのオン・オフ(既定オン)と、いまの状態
    await js(`document.querySelector('button[aria-label="設定"]').click()`)
    await pause(400)
    await click('Embedding')
    await pause(500)
    const pressed = `[...document.querySelectorAll('button[aria-pressed]')].filter(e=>['オン','オフ'].includes(e.textContent.trim())).map(e=>e.textContent.trim()+':'+e.getAttribute('aria-pressed')).join('|')`
    await assert(`document.body.textContent.includes('起動時に Embedding を読み込む') && document.body.textContent.includes('記憶の検索で古さを点数に反映する(検証用)') && ${pressed}==='オン:true|オフ:false|オン:true|オフ:false'`, '起動時に Embedding を読み込む設定と、記憶の検索の古さの設定(検証用)があり、どちらも既定はオン')
    await assert(`(() => {const s=[...document.querySelectorAll('[role="status"]')].find(e=>e.textContent.includes('読み込'));return !!s && s.textContent.includes('まだ読み込んでいません') && document.body.textContent.includes('cl-nagoya/ruri-v3-310m') && document.body.textContent.includes('この PC に保存します')})()`, 'いまの状態(未読み込み)とモデル名、保存先を表示する。開いただけでは読み込まない')
    writeFileSync(join(target, 'settings-embedding.png'), (await win.webContents.capturePage()).toPNG())
    await js(`[...document.querySelectorAll('button[aria-pressed]')].find(e=>e.textContent.trim()==='オフ').click()`)
    await pause(500)
    const stored = (await (await fetch(base + '/settings')).json()).embedding_load_on_startup
    if (stored !== '0') errors.push('Embedding の設定が保存されていない: ' + JSON.stringify(stored))
    else console.log('PASS オフにすると設定が保存される')
    await assert(`${pressed}==='オン:false|オフ:true|オン:true|オフ:false'`, 'オフに切り替えた表示になる(もう一方の設定は変わらない)')
    await js(`[...document.querySelectorAll('button[aria-pressed]')].filter(e=>e.textContent.trim()==='オフ')[1].click()`)
    await pause(500)
    const decay = (await (await fetch(base + '/settings')).json()).memory_search_decay
    if (decay !== '0') errors.push('記憶の検索の古さの設定が保存されていない: ' + JSON.stringify(decay))
    else console.log('PASS 記憶の検索の古さをオフにすると設定が保存される')
    await assert(`${pressed}==='オン:false|オフ:true|オン:false|オフ:true'`, '古さの設定もオフに切り替えた表示になる')
    const state = (await (await fetch(base + '/embedding/status')).json()).state
    if (state !== 'idle') errors.push('検証用のバックエンドで Embedding を読み込んでしまった: ' + state)
    else console.log('PASS バックエンド単体の起動では Embedding を読み込まない')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--target')) {
    // 相談チャットの「話す相手」: アイコンと名前のメニューで選ぶ(標準の select は使わない)
    await click('相談')
    await pause(300)
    const button = `document.querySelector('button[aria-haspopup="listbox"]')`
    const menu = `document.querySelector('[role="listbox"][aria-label="話す相手"]')`
    await assert(`${button}.textContent.includes('相談(編集者)') && !${menu} && ![...document.querySelectorAll('select')].some(s=>[...s.options].some(o=>o.textContent.includes('と話す')))`, '話す相手は自前のボタンで、既定は相談(編集者)。標準の select は無い')
    await js(`${button}.click()`)
    await pause(250)
    await assert(`(() => {const m=${menu};const rows=[...m.querySelectorAll('[role="option"]')];const b=${button}.getBoundingClientRect(),r=m.getBoundingClientRect();return rows.map(e=>e.lastElementChild.textContent.trim()).join('|')==='相談(編集者)|キャラ同士の会話|検証キャラ' && rows[0].getAttribute('aria-selected')==='true' && rows.every(e=>{const mark=e.firstElementChild.getBoundingClientRect();return Math.round(mark.width)===24 && Math.round(mark.height)===24}) && m.parentElement===document.body && getComputedStyle(m).position==='fixed' && r.top>=b.bottom && r.right<=innerWidth && r.bottom<=innerHeight})()`, 'メニューは 編集者 / 会話室 / キャラ の順で、各行に24pxの印と名前。ボタンの下に画面内で出る')
    writeFileSync(join(target, 'target-menu.png'), (await win.webContents.capturePage()).toPNG())
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
    await pause(150)
    await assert(`!${menu} && ${button}.textContent.includes('相談(編集者)')`, 'Escape でメニューを閉じ、相手は変わらない')
    await js(`${button}.click()`)
    await pause(200)
    await js(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
    await pause(150)
    await assert(`!${menu}`, '外側のクリックでメニューを閉じる')
    await js(`${button}.click()`)
    await pause(200)
    await js(`[...${menu}.querySelectorAll('[role="option"]')].find(e=>e.lastElementChild.textContent.trim()==='検証キャラ').click()`)
    await pause(300)
    await assert(`!${menu} && ${button}.textContent.includes('検証キャラと話す') && ${button}.getAttribute('aria-label')==='話す相手: 検証キャラ'`, 'キャラを選ぶとメニューを閉じ、ボタンにそのキャラのアイコンと名前を出す')
    writeFileSync(join(target, 'target-char.png'), (await win.webContents.capturePage()).toPNG())
    await js(`${button}.click()`)
    await pause(200)
    await js(`[...${menu}.querySelectorAll('[role="option"]')].find(e=>e.lastElementChild.textContent.trim()==='キャラ同士の会話').click()`)
    await pause(300)
    await assert(`${button}.textContent.includes('キャラ同士の会話')`, 'キャラ同士の会話に切り替えられる')
    // 会話室の「次に話す人」も同じ部品(参加者が2人そろうまでは無効)
    await assert(`(() => {const b=document.querySelector('button[aria-label^="次に話す人"]');const send=[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length).find(e=>['進める','送信'].includes(e.textContent.trim()));return !!b && b.getAttribute('aria-haspopup')==='listbox' && b.textContent.includes('順に') && b.disabled && ![...document.querySelectorAll('select')].some(s=>[...s.options].some(o=>o.textContent.includes('順に'))) && (!send || Math.abs((b.getBoundingClientRect().top+b.getBoundingClientRect().bottom)-(send.getBoundingClientRect().top+send.getBoundingClientRect().bottom))<24)})()`, '次に話す人も同じメニューの部品で、既定は「順に」。標準の select は無い')
    writeFileSync(join(target, 'target-room.png'), (await win.webContents.capturePage()).toPNG())
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--settings')) {
    await click('資料庫')
    const fill = async (label, value) => {
      await js(`(() => {const el=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
      await pause(100)
    }
    await js(`document.querySelector('[aria-label="設定資料を追加"]').click()`)
    await pause(500)
    await assert(`document.querySelector('[aria-label="資料の扱い"]').value==='draft' && document.querySelector('[aria-label="AIへの参照方法"]').value==='search' && !!document.querySelector('[aria-label="設定資料の本文"]')`, '新規設定資料は全項目を編集状態で開き、構想・必要に応じて検索')
    await fill('設定資料のタイトル', '王都の交通制度')
    await fill('設定資料の分類', '制度')
    await fill('設定資料の本文', '# 通行証\n夜間の通行には通行証が必要。')
    await fill('資料の扱い', 'confirmed')
    await fill('AIへの参照方法', 'always')
    await fill('適用範囲・時点', '王都・第一章以降')
    await assert(`document.querySelector('[aria-label="設定資料の編集"]').textContent.includes('未保存') && document.querySelector('#library-settings').textContent.includes('未保存')`, '一覧と編集欄に未保存を表示')
    // 単位ごとに確定する。先に確定した単位だけが保存され、もう一方の下書きは残る。
    await js(`[...document.querySelectorAll('[data-edit-group="doc-meta"] button')].find(e=>e.textContent.trim()==='確定').click()`)
    await pause(400)
    const metaSaved = await (await fetch(base+'/setting-documents')).json()
    if (metaSaved.length!==1 || metaSaved[0].title!=='王都の交通制度' || metaSaved[0].status!=='confirmed' || metaSaved[0].ai_mode!=='always' || metaSaved[0].scope!=='王都・第一章以降' || metaSaved[0].body!=='') throw new Error('タイトルなどの単位だけが保存されていません: ' + JSON.stringify(metaSaved))
    await assert(`document.querySelector('[data-setting-title]')?.textContent==='王都の交通制度' && document.querySelector('[data-setting-meta]').textContent==='制度 ・ 確定設定 ・ AI: 常に参照' && document.querySelector('[aria-label="設定資料の本文"]').value.includes('夜間の通行') && document.querySelector('#library-settings').textContent.includes('未保存')`, 'タイトルの単位を確定すると読む表示になり、本文の下書きは残る')
    await js(`[...document.querySelectorAll('[data-edit-group="doc-body"] button')].find(e=>e.textContent.trim()==='確定').click()`)
    await pause(400)
    const saved = await (await fetch(base+'/setting-documents')).json()
    if (saved[0].body!=='# 通行証\n夜間の通行には通行証が必要。' || saved[0].title!=='王都の交通制度') throw new Error('本文が保存されていません: ' + JSON.stringify(saved))
    await assert(`!document.querySelector('[aria-label="設定資料の編集"]').textContent.includes('未保存') && !document.querySelector('#library-settings').textContent.includes('未保存') && !document.querySelector('[aria-label="設定資料の編集"] textarea')`, '確定すると未保存表示が消え、読む表示へ戻る')
    await assert(`document.querySelector('[aria-label="設定資料の編集"] h1')?.textContent==='通行証'`, '読む表示では本文をMarkdownで整形して表示')
    await js(`document.querySelector('button[aria-label="本文を編集"]').click()`)
    await pause(200)
    await fill('設定資料の本文', '未保存の本文')
    await js(`document.querySelector('#library-characters button').click()`)
    await pause(150)
    await js(`document.querySelector('#library-settings button').click()`)
    await pause(150)
    await assert(`document.querySelector('[aria-label="設定資料の本文"]').value==='未保存の本文'`, '種類の切替後も下書きを保持')
    await js(`[...document.querySelectorAll('[data-edit-group="doc-body"] button')].find(e=>e.textContent.trim()==='取り消し').click()`)
    await pause(200)
    await assert(`!document.querySelector('[aria-label="設定資料の本文"]') && document.querySelector('[data-edit-group="doc-body"]').textContent.includes('夜間の通行') && !document.querySelector('#library-settings').textContent.includes('未保存')`, '取り消しで保存済み本文へ戻り、読む表示になる')
    writeFileSync(join(target, 'settings.png'), (await win.webContents.capturePage()).toPNG())
    await js(`window.confirm=()=>false; void 0`)
    await click('この設定資料を削除')
    await assert(`!!document.querySelector('[data-setting-title]')`, '削除のキャンセルで資料を維持')
    await js(`window.confirm=()=>true; void 0`)
    await click('この設定資料を削除')
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
      await assert(`(() => {const rows=[...document.querySelectorAll('aside .group')].filter(e=>e.getClientRects().length);return rows.length>=2 && rows.every(row=>{const t=row.querySelector('[data-chat-updated]');const r=t&&t.getBoundingClientRect();const title=row.querySelector('.truncate').getBoundingClientRect();return t && /^(たった今|\d+分前)$/.test(t.textContent) && r.x>=title.right-1})})()`, mode + 'の会話一覧は右に最終更新からの経過を表示')
      await click('会話一覧')
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
      await click('新しい会話')
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
        if (label === 'キャラ') {
          await assert(`(() => {const list=document.querySelector('.char-detail-list');const row=list.querySelector('button');const l=list.getBoundingClientRect(),d=document.querySelector('.char-detail .scene-detail').getBoundingClientRect();return row.lastElementChild.textContent.trim()==='検証キャラ' && row.getAttribute('aria-pressed')==='true' && row.children.length===2 && Math.round(l.width)===188 && d.x>=l.right-1 && Math.abs(l.y-d.y)<1})()`, 'キャラは左に登場人物の一覧(アイコンと名前)、右に状態')
        }
        if (label === '関係図') {
          await assert(`document.querySelector('.scene-detail-main svg').querySelectorAll('g[transform]').length===2`, '関係図に登場人物を表示')
          await js(`document.querySelector('.scene-detail-main svg polyline[stroke="transparent"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
          await pause(100)
          await assert(`document.querySelector('.scene-detail-meta').textContent.includes('検証用の関係')`, '関係線のクリックで右欄に履歴を表示')
        }
        if (label === '事実') {
          await assert(`(() => {const list=document.querySelector('.char-detail-list[aria-label="事実を見る対象"]');const rows=[...list.querySelectorAll('button')];const l=list.getBoundingClientRect();return !list.closest('.char-detail').querySelector('select') && rows.map(r=>r.lastElementChild.textContent).join('|')==='検証キャラ|相手キャラ|世界' && rows[0].getAttribute('aria-pressed')==='true' && !!rows.at(-1).querySelector('svg') && Math.round(l.width)===188})()`, '事実は左に対象の一覧(人物と世界)を並べ、プルダウンは無い')
          await js(`document.querySelector('.char-detail-list .fact-world-row').click()`)
          await pause(150)
          await assert(`document.querySelector('.char-detail-list .fact-world-row').getAttribute('aria-pressed')==='true' && document.querySelector('.char-detail-list button').getAttribute('aria-pressed')==='false'`, '事実の一覧で世界に切り替えられる')
          await js(`document.querySelector('.char-detail-list button').click()`)
          await pause(150)
          await assert(`!!document.querySelector('aside .sticky.top-0')`, '事実のシーン見出しを固定')
        }
        writeFileSync(join(target, label + '-wide.png'), (await win.webContents.capturePage()).toPNG())
        win.setSize(1050,800)
        await pause(250)
        if (label !== '事実') await assert(`getComputedStyle(document.querySelector('.scene-detail-layout')).display==='block'`, label + 'は狭幅で1列')
        if (label === 'キャラ') await assert(`(() => {const l=document.querySelector('.char-detail-list').getBoundingClientRect(),d=document.querySelector('.char-detail .scene-detail').getBoundingClientRect();return d.y>=l.bottom-1 && getComputedStyle(document.querySelector('.char-detail-list')).flexDirection==='row'})()`, 'キャラは狭幅で登場人物を上の横並びに戻す')
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
    if (chapterCheck) {
      // 章を選んでいるときのタブは 章 / 関係図 / 事実。関係図・事実は章の最後のシーンまでを表示する。
      await assert(`(() => {const tab=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && e.textContent.trim()==='関係図');const labels=[...tab.parentElement.querySelectorAll('button')].map(e=>e.textContent.trim());return labels.slice(0,3).join('|')==='章|関係図|事実' && !labels.some(e=>['シーン','清書','キャラ'].includes(e))})()`, '章を選ぶとタブは 章 / 関係図 / 事実 だけ')
      await click('関係図')
      await pause(400)
      await assert(`document.body.textContent.includes('第1章「検証章」の終わり(「検証シーン」)まで') && !!document.querySelector('.scene-detail-main svg')`, '章の関係図は章の最後のシーンまでを表示')
      await click('事実')
      await pause(400)
      await assert(`document.body.textContent.includes('第1章「検証章」の終わり(「検証シーン」)まで') && !document.querySelector('.scene-detail-aside')`, '章の事実は章の最後のシーンまでを表示')
      writeFileSync(join(target, 'chapter-facts.png'), (await win.webContents.capturePage()).toPNG())
      await click('章')
      await pause(300)
      await assert(`!!document.querySelector('.scene-detail-aside') && document.querySelector('.scene-detail-aside').textContent.includes('表紙')`, '章タブで章の詳細へ戻る')
    }
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
      // 左右の余白: 中身・タブの行の「閉じる」・下のボタンの端を 20px に揃える(スクロールバーの有無で変わらない)。
      const edges = await js(`(() => {const panel=document.querySelector('.scene-detail').getBoundingClientRect();const visible=(q)=>[...document.querySelectorAll(q)].filter(e=>e.getClientRects().length);const close=visible('button').filter(e=>e.textContent.trim()==='閉じる').map(e=>e.getBoundingClientRect()).filter(r=>r.right<=panel.right+1 && r.right>panel.right-60 && Math.abs(r.bottom-panel.top)<60)[0];const footer=[...document.querySelector('.scene-detail').children].at(-1);const last=[...footer.querySelectorAll('button')].at(-1).getBoundingClientRect();const field=document.querySelector('.scene-detail-main input, .scene-detail-main textarea, .scene-detail-main p').getBoundingClientRect();const left=document.querySelector('.scene-detail-aside > div').getBoundingClientRect();return {close:panel.right-close.right,footer:panel.right-last.right,field:panel.right-field.right,left:left.x-panel.x}})()`)
      if (!Object.values(edges).every((value) => Math.abs(value - 20) < 1.5)) errors.push('詳細エリアの左右の端が 20px に揃っていない: ' + JSON.stringify(edges))
      else console.log('PASS 詳細エリアの中身・閉じる・下のボタンの端が左右 20px に揃う')
      writeFileSync(join(target, 'details-three.png'), (await win.webContents.capturePage()).toPNG())
      if (errors.length) throw new Error(errors.join('\n'))
    }
    if (!chapterCheck) {
      // 前のシーンからの経過: 既定は未設定で数の欄は無い。単位を選ぶと数の欄が出て、保存で両方が残る。
      const pick = (unit) => js(`(() => {const s=document.querySelector('select[aria-label="前のシーンからの経過"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(unit)});s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      const saved = async () => (await (await fetch(base + '/graph')).json()).nodes.find((n) => n.title === '検証シーン')
      await assert(`document.querySelector('select[aria-label="前のシーンからの経過"]').value==='' && !document.querySelector('input[aria-label="経過の数"]') && !document.body.textContent.includes('Story time')`, '経過の既定は未設定で、数の欄と Story time の欄は無い')
      await assert(`['Location','Elapsed'].every(name => {const head=[...document.querySelectorAll('.scene-detail-aside span')].find(e=>e.children.length===0 && e.textContent.trim()===name);const b=head.parentElement.querySelector('button');return !!b && b.textContent.trim()==='推測' && b.disabled===(name==='Location') && b.classList.contains('accent-action')})`, '場所と経過の見出しの横に「推測」ボタンがある(場所が未登録のあいだ、場所の推測は無効)')
      await pick('day')
      await pause(150)
      await assert(`document.querySelector('input[aria-label="経過の数"]').value==='1'`, '「日後」を選ぶと数の欄が出る')
      await js(`(() => {const i=document.querySelector('input[aria-label="経過の数"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'3');i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await pause(150)
      await js(`[...document.querySelectorAll('.scene-detail button')].find(e=>e.textContent.trim()==='保存').click()`)
      await pause(500)
      const dayNode = await saved()
      if (!(dayNode.elapsed_unit === 'day' && dayNode.elapsed_count === 3)) errors.push('経過(3日後)が保存されていない: ' + JSON.stringify([dayNode.elapsed_unit, dayNode.elapsed_count]))
      else console.log('PASS 経過(3日後)を保存できる')
      await js(`document.querySelector('select[aria-label="前のシーンからの経過"]').scrollIntoView({block:'center'})`)
      await pause(150)
      await assert(`(() => {const s=document.querySelector('select[aria-label="前のシーンからの経過"]');return s.scrollWidth<=s.clientWidth+1 && s.getBoundingClientRect().width>=120})()`, '経過の単位は切れずに表示される')
      writeFileSync(join(target, 'details-elapsed.png'), (await win.webContents.capturePage()).toPNG())
      await pick('same_day')
      await pause(150)
      await assert(`!document.querySelector('input[aria-label="経過の数"]')`, '「同じ日」では数の欄を出さない')
      await js(`[...document.querySelectorAll('.scene-detail button')].find(e=>e.textContent.trim()==='保存').click()`)
      await pause(500)
      const sameDay = await saved()
      if (!(sameDay.elapsed_unit === 'same_day' && sameDay.elapsed_count === null)) errors.push('経過(同じ日)で数が残っている: ' + JSON.stringify([sameDay.elapsed_unit, sameDay.elapsed_count]))
      else console.log('PASS 経過を「同じ日」に変えると数は消える')
      // Ctrl+S: 入力欄にフォーカスがあっても、保存ボタンと同じ保存をする。変更が無ければ何もしない。
      const titles = async () => (await (await fetch(base + '/graph')).json()).nodes.map((n) => n.title)
      const ctrlS = `(() => {const i=document.querySelector('.scene-detail-main input');i.focus();return i.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}))})()`
      await js(`(() => {const i=document.querySelector('.scene-detail-main input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'キーで保存');i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await pause(150)
      const prevented = !(await js(ctrlS))
      await pause(600)
      if (!(prevented && (await titles()).includes('キーで保存'))) errors.push('Ctrl+S でシーンが保存されていない: ' + JSON.stringify({ prevented, titles: await titles() }))
      else console.log('PASS Ctrl+S で、入力欄にフォーカスがあってもシーンを保存できる')
      await assert(`[...document.querySelectorAll('.scene-detail button')].find(e=>e.textContent.trim()==='保存').disabled && document.body.textContent.includes('シーンを保存しました')`, 'Ctrl+S の後は未保存の変更が無く、保存したことを知らせる')
      // 別のタブを開いていても保存できる(下書きはシーンごとに残っている)
      const typeTitle = (text) => js(`(() => {const i=document.querySelector('.scene-detail-main input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(text)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      const pressCtrlS = () => js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}))`)
      const clickNode = (text) => js(`(() => {const node=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes(${JSON.stringify(text)}));node.dispatchEvent(new MouseEvent('click',{bubbles:true}))})()`)
      await typeTitle('別タブから保存')
      await pause(150)
      await click('キャラ')
      await pause(250)
      await pressCtrlS()
      await pause(600)
      if (!(await titles()).includes('別タブから保存')) errors.push('シーンタブ以外で Ctrl+S が保存していない: ' + JSON.stringify(await titles()))
      else console.log('PASS シーンタブ以外を開いていても Ctrl+S で保存できる')
      await click('シーン')
      await pause(250)
      // 選択したシーンの下書きだけを保存し、選択していないシーンの下書きは残す
      // (複数選択そのものは、ここからキー操作を模擬しても選択が増えないので確かめていない)
      for (const title of ['二つ目', '三つ目']) await fetch(base + '/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, beat: title + 'の本文。' }) })
      await click('資料庫')
      await pause(300)
      await click('構造')
      for (let i = 0; i < 40; i++) {
        if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('三つ目'))`)) break
        await pause(100)
      }
      for (const [from, to] of [['三つ目', '選択外の下書き'], ['二つ目', '選択中の下書き']]) {
        await clickNode(from)
        await pause(300)
        await typeTitle(to)
        await pause(200)
      }
      await pressCtrlS()
      await pause(900)
      const after = await titles()
      if (!(after.includes('選択中の下書き') && after.includes('三つ目') && !after.includes('選択外の下書き'))) errors.push('Ctrl+S が選択外の下書きまで保存した、または選択中を保存していない: ' + JSON.stringify(after))
      else console.log('PASS Ctrl+S は選択中のシーンだけを保存し、選択していないシーンの下書きは残す')
      await assert(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('三つ目') && e.textContent.includes('未保存')) && ![...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('選択中の下書き') && e.textContent.includes('未保存'))`, '選択していないシーンのカードには未保存の印が残る')
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
  // 読む表示が既定。入力欄は並ばず、鉛筆を押した項目だけ編集欄になる。
  await assert(`(() => {const body=document.querySelector('.character-editor-body');return !body.querySelector('textarea') && [...body.querySelectorAll('p')].some(e=>e.textContent==='保存済みプロフィール') && !document.querySelector('.character-editor-id input:not([type="file"])') && !!document.querySelector('button[aria-label="プロフィールを編集"]') && [...body.querySelectorAll('button')].some(e=>e.textContent.trim()==='+ 外見を書く')})()`, 'キャラクターは読む表示が既定で、空の項目は書き始める案内を出す')
  await js(`document.querySelector('button[aria-label="プロフィールを編集"]').click()`)
  await pause(200)
  const profileSelector = '[data-edit-group="profile"] textarea'
  await assert(`document.querySelector(${JSON.stringify(profileSelector)}).value==='保存済みプロフィール' && document.activeElement===document.querySelector(${JSON.stringify(profileSelector)}) && document.querySelectorAll('.character-editor-body textarea').length===1`, '鉛筆を押した項目だけが編集欄になりフォーカスが入る')
  await assert(`(() => {const g=document.querySelector('[data-edit-group="profile"]');const area=g.querySelector('textarea').getBoundingClientRect();const buttons=[...g.querySelectorAll('button')].filter(e=>['取り消し','確定'].includes(e.textContent.trim()));const proof=[...g.querySelectorAll('button')].find(e=>e.textContent.includes('校正')).getBoundingClientRect();const [cancel,commit]=buttons.map(e=>e.getBoundingClientRect());return buttons.map(e=>e.textContent.trim()).join('|')==='取り消し|確定' && Math.abs(commit.right-area.right)<2 && cancel.right<commit.x && commit.y>area.bottom-1 && proof.bottom<=area.y+1 && Math.abs(proof.right-area.right)<2 && g.textContent.includes('プロフィール')})()`, '校正は見出しの行の右端、確定と取り消しは欄の下に右寄せで、確定が右端')
  await input(profileSelector, '未保存のプロフィール')
  const SEND = `document.querySelector('button[aria-label="送信"]')`
  const INPUT_BORDER = `getComputedStyle(document.querySelector('textarea[aria-label="制作への依頼"]')).borderColor`
  await assert(`${SEND}.classList.contains('accent-action') && !!${SEND}.querySelector('svg') && ${SEND}.textContent.trim()==='' && !${INPUT_BORDER}.includes('221, 136, 181') && !document.body.textContent.includes('「制作を実行」を選択中')`, '相談のときの送信は紫の↑ボタンで、入力欄の枠は通常の色')
  await assert(`(() => {const visible=(q)=>[...document.querySelectorAll(q)].find(e=>e.getClientRects().length);const list=visible('button[aria-label="会話一覧"]'),add=visible('button[aria-label="新しい会話"]');const row=list.parentElement;const title=row.querySelector('span');const r=(e)=>e.getBoundingClientRect();const rr=row.getBoundingClientRect();return !!list.querySelector('svg') && !!add.querySelector('svg') && list.textContent.trim()==='' && title.textContent==='新しい会話' && Math.abs(r(title).x-rr.x-24)<1 && r(list).x>=r(title).right-1 && r(add).x>=r(list).right && Math.abs(rr.right-r(add).right-24)<1})()`, '会話名は左端、会話一覧と新しい会話のアイコンは右端に並ぶ')
  // 画面の右端にある部品のツールチップが、細く縦長にならないこと。
  await js(`(() => {const r=${SEND}.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))})()`)
  for (let i = 0; i < 30; i++) { if (await js(`!!document.querySelector('[role="tooltip"]') && getComputedStyle(document.querySelector('[role="tooltip"]')).opacity!=='0'`)) break; await pause(100) }
  const tip = await js(`(() => {const t=document.querySelector('[role="tooltip"]');if(!t) return null;const r=t.getBoundingClientRect();return {width:r.width,height:r.height,right:r.right,text:t.textContent,inner:window.innerWidth}})()`)
  if (!(tip && tip.text.includes('相談として送信') && tip.width >= 200 && tip.height <= 48 && tip.right <= tip.inner - 7)) errors.push('右端のツールチップが縦長になっている: ' + JSON.stringify(tip))
  else console.log('PASS 画面の右端にある部品のツールチップも横長のまま画面内に収まる')
  await js(`document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
  for (let i = 0; i < 40; i++) { if (await js(`[...document.querySelectorAll('[role="img"] svg')].some(e=>e.getClientRects().length)`)) break; await pause(100) }
  await assert(`(() => {const h=(e)=>Math.round(e.getBoundingClientRect().height);const group=document.querySelector('[aria-label="制作チャットの送信モード"]');const ring=[...document.querySelectorAll('[role="img"] svg')].find(e=>e.getClientRects().length);const send=${SEND};const cy=(e)=>{const r=e.getBoundingClientRect();return r.y+r.height/2};return h(group)===26 && h(ring)===26 && h(send)===26 && Math.abs(cy(group)-cy(ring))<1 && Math.abs(cy(group)-cy(send))<1})()`, '送信モードの切り替え・使用量リング・送信ボタンの高さと位置が揃う')
  await assert(`(() => {const list=document.querySelector('[aria-live="polite"]');const area=document.querySelector('textarea[aria-label="制作への依頼"]').getBoundingClientRect();const l=list.getBoundingClientRect();const cs=getComputedStyle(list);return cs.scrollbarGutter==='stable' && Math.round(l.right-area.right)===24 && Math.round(l.right-10-parseFloat(cs.paddingRight)-area.right)===0})()`, '制作の発言欄はスクロールバーとの間を空け、発言の右端を入力欄と揃える')
  await click('制作を実行')
  await assert(`${SEND}.classList.contains('execute-action') && ${INPUT_BORDER}.includes('221, 136, 181') && document.body.textContent.includes('「制作を実行」を選択中') && getComputedStyle(document.querySelector('[aria-label="制作チャットの送信モード"] [aria-pressed="true"]')).color.includes('221, 136, 181')`, '制作を実行を選ぶと、切り替え・入力欄の枠・送信ボタンが実行の色(ピンク)になり案内を出す')
  writeFileSync(join(target, 'send-execute.png'), (await win.webContents.capturePage()).toPNG())
  await click('送信')
  await assert(`document.body.textContent.includes('未保存の資料があります')`, '未保存の資料がある場合は制作の実行を拒否')
  await click('構造')
  await click('資料庫')
  await assert(`document.querySelector(${JSON.stringify(profileSelector)}).value === '未保存のプロフィール'`, '資料庫の未保存編集もモードをまたいで保持')
  // キャラクターは上段(左=アイコン・名前 / 右=参照画像)を固定し、下段の文章欄だけをスクロールする。
  const editorRects = `(() => {const r=(e)=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width}};const main=[...document.querySelectorAll('main')].find(e=>e.getClientRects().length);const id=document.querySelector('.character-editor-id'),ref=document.querySelector('.character-editor-ref'),body=document.querySelector('.character-editor-body'),all=document.querySelector('.character-editor-scroll');return {main:r(main),id:r(id),ref:r(ref),body:r(body),mainScrolls:main.scrollHeight>main.clientHeight+1,bodyScroll:body.scrollTop,bodyMax:body.scrollHeight-body.clientHeight,allScroll:all.scrollTop,allMax:all.scrollHeight-all.clientHeight,idHas:id.textContent.includes('検証キャラ') && !id.textContent.includes('参照画像'),refHas:ref.textContent.includes('参照画像'),bodyHas:body.textContent.includes('プロフィール') && body.textContent.includes('口調') && body.textContent.includes('読み上げの声') && body.textContent.includes('このキャラクターを削除'),saveBar:[...document.querySelectorAll('.library-save-bar')].some(e=>e.getClientRects().length)}})()`
  const editor = await js(editorRects)
  if (!(editor.idHas && editor.refHas && editor.bodyHas && !editor.saveBar && !editor.mainScrolls && editor.ref.x >= editor.id.right && Math.abs(editor.id.y - editor.ref.y) < 1 && editor.body.y >= Math.max(editor.id.bottom, editor.ref.bottom) - 1 && editor.body.width > editor.id.width * 1.8)) errors.push('キャラクターの編集が 上段(左右) + 下段 になっていない: ' + JSON.stringify(editor))
  else console.log('PASS キャラクターは上段の左にアイコン・名前、右に参照画像、下段に文章の項目(全体の保存欄は無い)')
  win.setSize(1440, 860)
  await pause(300)
  const before = await js(editorRects)
  await js(`(() => {const body=document.querySelector('.character-editor-body');body.scrollTop=body.scrollHeight})()`)
  await pause(100)
  const scrolled = await js(editorRects)
  if (!(scrolled.bodyMax > 20 && scrolled.bodyScroll > 20 && Math.abs(scrolled.id.y - before.id.y) < 1 && Math.abs(scrolled.ref.y - before.ref.y) < 1 && !scrolled.mainScrolls)) errors.push('下段をスクロールしたとき上段が固定されていない: ' + JSON.stringify(scrolled))
  else console.log('PASS 下段の文章欄をスクロールしても上段は動かない')
  writeFileSync(join(target, 'library-character-scrolled.png'), (await win.webContents.capturePage()).toPNG())
  await js(`document.querySelector('.character-editor-body').scrollTop=0`)
  win.setSize(1440, 700)
  await pause(300)
  await js(`(() => {const all=document.querySelector('.character-editor-scroll');all.scrollTop=all.scrollHeight})()`)
  await pause(100)
  const low = await js(editorRects)
  if (!(low.allMax > 40 && low.allScroll > 40 && low.id.y < before.id.y - 40 && low.bodyMax < 2)) errors.push('低い画面で上段の固定が外れていない: ' + JSON.stringify(low))
  else console.log('PASS 低い画面では上段の固定をやめ、全体を一緒にスクロールする')
  await js(`document.querySelector('.character-editor-scroll').scrollTop=0`)
  win.setSize(1440, 1000)
  await pause(300)
  // 取り消しは保存値へ戻して閉じる。確定はその項目だけを保存して読む表示へ戻る。
  await js(`[...document.querySelectorAll('[data-edit-group="profile"] button')].find(e=>e.textContent.trim()==='取り消し').click()`)
  await pause(200)
  await assert(`(() => {const g=document.querySelector('[data-edit-group="profile"]');return !g.querySelector('textarea') && [...g.querySelectorAll('p')].some(e=>e.textContent==='保存済みプロフィール') && ![...document.querySelectorAll('nav[aria-label="資料の種類と一覧"] *')].some(e=>e.textContent==='未保存')})()`, '取り消しで保存値に戻り、未保存の表示が消える')
  await js(`[...document.querySelectorAll('.character-editor-body button')].find(e=>e.textContent.trim()==='+ 外見を書く').click()`)
  await pause(200)
  await input('[data-edit-group="appearance"] textarea', '検証の外見')
  await js(`[...document.querySelectorAll('[data-edit-group="appearance"] button')].find(e=>e.textContent.trim()==='確定').click()`)
  for (let i = 0; i < 40; i++) {
    if (await js(`!document.querySelector('[data-edit-group="appearance"] textarea')`)) break
    await pause(100)
  }
  const savedCharacter = (await (await fetch(base + '/characters')).json()).find((c) => c.name === '検証キャラ')
  if (!(savedCharacter.appearance === '検証の外見' && savedCharacter.profile === '保存済みプロフィール')) errors.push('確定でその項目だけが保存されていない: ' + JSON.stringify(savedCharacter))
  await assert(`(() => {const g=document.querySelector('[data-edit-group="appearance"]');return !g.querySelector('textarea') && [...g.querySelectorAll('p')].some(e=>e.textContent==='検証の外見')})()`, '確定でその項目を保存し、読む表示へ戻る')
  await js(`document.querySelector('button[aria-label="名前・読み・色を編集"]').click()`)
  await pause(200)
  await assert(`(() => {const g=document.querySelector('[data-edit-group="identity"]');const inputs=[...g.querySelectorAll('input')];return inputs.length===3 && inputs[0].value==='検証キャラ' && document.activeElement===inputs[0]})()`, '名前の鉛筆で名前・色・読みをまとめて編集できる')
  await js(`document.querySelector('[data-edit-group="identity"] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await pause(200)
  await assert(`!document.querySelector('[data-edit-group="identity"] input') && [...document.querySelectorAll('[data-character-name]')].some(e=>e.getClientRects().length && e.textContent.trim()==='検証キャラ')`, 'Escで編集を取り消して読む表示へ戻る')
  writeFileSync(join(target, 'library-character-read.png'), (await win.webContents.capturePage()).toPNG())
  if (errors.length) throw new Error(errors.join('\n'))
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
  await assert(`!!window.workspaceEmit && [...document.querySelectorAll('[data-write-locked="true"]')].some(e=>e.textContent.includes('検証キャラ')) && ![...document.querySelectorAll('[inert]')].some(e=>e.textContent.includes('検証キャラ'))`, '制作中は資料庫を書き換えだけロックする(操作不可にはしない)')
  // 制作中も見るための操作はできる: 資料庫の一覧の切り替え、読む表示のスクロール。書き換えの入口は開かない。
  await js(`document.querySelector('button[aria-label="プロフィールを編集"]')?.click()`)
  await js(`[...document.querySelectorAll('[data-edit-group="profile"] p')].find(e=>e.getClientRects().length)?.click()`)
  await pause(150)
  await assert(`!document.querySelector('[data-edit-group="profile"] textarea:not(:disabled)') || document.querySelector('[data-edit-group="profile"] textarea').value==='保存済みプロフィール'`, '制作中は資料の編集欄を新しく開けない')
  const lockedCharacters = (await (await fetch(base + '/characters')).json()).length
  await js(`document.querySelector('button[aria-label="キャラクターを追加"]').click()`)
  await pause(250)
  if ((await (await fetch(base + '/characters')).json()).length !== lockedCharacters) errors.push('制作中に資料の追加が実行された')
  else console.log('PASS 制作中は資料の追加を受け付けない')
  await js(`document.querySelector('[aria-controls="library-places"]').click()`)
  await pause(150)
  const placesToggled = await js(`document.querySelector('#library-places').hidden`)
  await js(`document.querySelector('[aria-controls="library-places"]').click()`)
  await pause(150)
  if (placesToggled === await js(`document.querySelector('#library-places').hidden`)) errors.push('制作中に資料庫の一覧を開閉できない')
  else console.log('PASS 制作中も資料庫の一覧は開閉できる(見るための操作)')
  await click('構造')
  await pause(300)
  await assert(`(() => {const main=document.querySelector('main[data-write-locked="true"]');return !!main && !main.hasAttribute('inert') && !!main.querySelector('.react-flow')})()`, '制作中のキャンバスは操作不可にせず、書き換えだけロックする')
  const lockedNodes = (await (await fetch(base + '/graph')).json()).nodes.length
  await js(`[...document.querySelectorAll('main button')].find(e=>e.textContent.trim()==='+ シーン').click()`)
  await pause(300)
  if ((await (await fetch(base + '/graph')).json()).nodes.length !== lockedNodes) errors.push('制作中にシーンの追加が実行された')
  else console.log('PASS 制作中はキャンバスからシーンを追加できない')
  await js(`(() => {const node=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes('検証シーン')); node.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`)
  await pause(400)
  await assert(`[...document.querySelectorAll('.react-flow__node.selected')].some(e=>e.textContent.includes('検証シーン'))`, '制作中もキャンバスでシーンを選択できる')
  await js(`[...document.querySelectorAll('aside [data-view-ok] button')].find(e=>e.getClientRects().length && e.textContent.trim()==='キャラ').click()`)
  await pause(300)
  await assert(`!!document.querySelector('.char-detail-list')?.getClientRects().length`, '制作中も詳細エリアのタブを切り替えられる')
  await js(`[...document.querySelectorAll('aside [data-view-ok] button')].find(e=>e.getClientRects().length && e.textContent.trim()==='シーン').click()`)
  await pause(300)
  await assert(`(() => {const title=document.querySelector('.scene-detail-main input');const prevented=(type,Ctor,init)=>!title.dispatchEvent(new Ctor(type,{bubbles:true,cancelable:true,...init}));const tab=[...document.querySelectorAll('aside [data-view-ok] button')].find(e=>e.getClientRects().length);return prevented('mousedown',MouseEvent,{}) && prevented('keydown',KeyboardEvent,{key:'a'}) && prevented('beforeinput',InputEvent,{data:'a',inputType:'insertText'}) && !prevented.call(null,'x',Event,{}) === true && tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))})()`, '制作中はシーンの入力欄への操作を捨て、タブへの操作は通す')
  writeFileSync(join(target, 'write-locked.png'), (await win.webContents.capturePage()).toPNG())
  await click('資料庫')
  await pause(300)
  await assert(`(() => {const stop=document.querySelector('button[aria-label="停止"]');const r=stop.getBoundingClientRect();return !!stop.querySelector('svg') && stop.textContent.trim()==='' && Math.round(r.width)===26 && Math.round(r.height)===26 && !document.querySelector('button[aria-label="送信"]')})()`, '制作中は送信の位置に同じ丸い形の停止ボタンを出す')
  await assert(`(() => {const list=document.querySelector('[aria-live="polite"]');const tags=[...list.querySelectorAll('span')].filter(e=>e.textContent==='制作を実行');return tags.length===1 && tags[0].parentElement.textContent.startsWith('あなた') && (() => {const head=tags[0].closest('.flex');const t=head.querySelector('time');return !!t && Math.abs(head.getBoundingClientRect().right-t.getBoundingClientRect().right)<1})() && !list.textContent.includes('変更範囲: 全体') && !list.textContent.includes('送信時の選択: なし')})()`, '実行として送った発言に印を付け、既定の変更範囲・選択なしは表示しない')
  // 制作側は時系列(線と丸)で並べ、読み取りの手順も1行ずつ出す。
  await js(`window.workspaceEmit({step:{name:'get_beats',label:'シーン本文を読む',detail:'検証シーン'}}); window.workspaceEmit({step:{name:'read_library',label:'資料庫を読む',detail:'キャラクターの一覧',error:'読み取りに失敗'}})`)
  await pause(250)
  await assert(`(() => {const list=document.querySelector('[aria-live="polite"]');const items=[...list.querySelectorAll('.timeline-item')];const step=list.querySelector('[data-step="get_beats"]');const failed=list.querySelector('[data-step="read_library"]');const dot=(e)=>getComputedStyle(e.closest('.timeline-item').querySelector('.timeline-dot')).backgroundColor;const bubble=[...list.children].find(e=>e.textContent.startsWith('あなた'));return items.length>=2 && step.textContent==='シーン本文を読む: 検証シーン' && failed.closest('.timeline-item').textContent.includes('読み取りに失敗') && dot(failed)==='rgb(239, 68, 68)' && dot(step)!==dot(failed) && !bubble.classList.contains('timeline-item') && getComputedStyle(items[0],'::before').width==='1px'})()`, '制作側は線と丸の時系列で並び、読み取りの手順を1行ずつ出す(失敗は赤)')
  await click('会話一覧')
  await assert(`[...document.querySelectorAll('button[aria-label="新しい会話"]')].find(e=>e.getClientRects().length).disabled`, '制作中は新しい会話を開始できない')
  await js(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  await pause(150)
  await assert(`!document.querySelector('aside[aria-label="会話一覧"]')`, '会話一覧は外側のクリックで閉じる')
  await js(`window.workspaceEmit({preview:{node_id:null,beat:'生成中の本文プレビュー'}})`)
  await pause(150)
  await assert(`(() => {const preview=document.querySelector('[aria-label="AI編集中の本文プレビュー"]'); const input=document.querySelector(${JSON.stringify(productionInput)}); const list=document.querySelector('[aria-live="polite"]'); return preview?.getClientRects().length && input.parentElement.contains(preview) && preview.textContent.includes('生成中の本文プレビュー') && list.contains(preview) && preview.classList.contains('timeline-item') && !!preview.querySelector('.timeline-dot.animate-pulse') && preview.textContent.includes('編集案を作成中(対象を確認中)') && !preview.nextElementSibling?.classList.contains('timeline-item');})()`, '資料庫でも制作チャットの時系列の末尾に、書いている途中の本文を出す')
  await click('構造')
  await assert(`(() => {const preview=document.querySelector('[aria-label="AI編集中の本文プレビュー"]'); const detail=[...document.querySelectorAll('aside')].find(e=>e.textContent.includes('清書'));return preview?.getClientRects().length && !detail.contains(preview);})()`, '構造に戻ってもプレビューは詳細欄に入らない')
  const characters = await (await fetch(base + '/characters')).json()
  const character = characters[0]
  await js(`document.querySelector('[aria-controls="library-characters"]').click()`)
  await js(`window.workspaceEmit(${JSON.stringify({active_library:{kind:'character',id:character.id}})})`)
  await pause(250)
  await assert(`[...document.querySelectorAll('[data-character-name]')].some(e=>e.getClientRects().length && e.textContent.trim()==='検証キャラ')`, 'キャラクター編集開始で構造から資料庫へ追従')
  await assert(`!document.querySelector('#library-characters').hidden`, '制作の追従で対象の種類を自動展開')
  await fetch(`${base}/characters/${character.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:'制作で更新したプロフィール'})})
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'update_character', entity_type:'character', entity_id:character.id,title:character.name,reason:'検証更新',before:{},after:{profile:'制作で更新したプロフィール'}}})})`)
  await pause(300)
  await assert(`[...document.querySelectorAll('[data-edit-group="profile"] p')].some(e=>e.getClientRects().length && e.textContent==='制作で更新したプロフィール')`, '資料庫の制作結果が読む表示へ反映される')
  const placeResponse = await fetch(base + '/places', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'追従先の場所'})})
  const place = await placeResponse.json()
  const placeChange = {changed:{action:'create_place',entity_type:'place',entity_id:place.id,title:place.name,reason:'場所を追加',before:null,after:{name:place.name}}}
  await js(`window.workspaceEmit(${JSON.stringify(placeChange)})`)
  await pause(400)
  await assert(`[...document.querySelectorAll('[data-place-name]')].some(e=>e.getClientRects().length && e.textContent.trim()==='追従先の場所') && !document.querySelector('[data-edit-group="place-identity"] input')`, '制作が登録した場所は一覧の再取得後に選択し、読む表示で出す')
  const settingsResponse = await fetch(base + '/setting-documents', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'制作で作成した設定',body:'王都の制度'})})
  const setting = await settingsResponse.json()
  await js(`document.querySelector('[aria-controls="library-settings"]').click()`)
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'create_setting_document',entity_type:'setting_document',entity_id:setting.id,title:setting.title,reason:'設定資料を作成',before:null,after:{body:setting.body}}})})`)
  await pause(400)
  await assert(`document.querySelector('[data-setting-title]')?.textContent==='制作で作成した設定' && !document.querySelector('#library-settings').hidden && !!document.querySelector('[data-setting-title]').getClientRects().length && !document.querySelector('[aria-label="設定資料の編集"] textarea')`, '設定資料の作成後に種類を展開して編集欄へ追従')
  await click('構造')
  await js(`window.workspaceEmit(${JSON.stringify({active_library:{kind:'setting_document',id:setting.id}})})`)
  await pause(200)
  await assert(`!!document.querySelector('[data-setting-title]').getClientRects().length`, '設定資料の編集開始で資料庫へ追従')
  await fetch(base + '/setting-documents/' + setting.id, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:setting.title,body:'更新した制度',revision:setting.revision})})
  await js(`window.workspaceEmit(${JSON.stringify({changed:{action:'update_setting_document',entity_type:'setting_document',entity_id:setting.id,title:setting.title,reason:'設定資料を更新',before:{body:setting.body},after:{body:'更新した制度'}}})})`)
  await pause(300)
  await assert(`document.querySelector('[data-edit-group="doc-body"]').textContent.includes('更新した制度')`, '設定資料の制作結果を読む表示へ反映')
  await click('☑ 作業対象を追う')
  await click('構造')
  await js(`window.workspaceEmit(${JSON.stringify({active_library:{kind:'character',id:character.id}})})`)
  await pause(200)
  await assert(`![...document.querySelectorAll('[data-character-name]')].some(e=>e.getClientRects().length && e.textContent.trim()==='検証キャラ')`, '追従オフでは資料庫へ移動しない')
  await click('☐ 作業対象を追う')
  await pause(200)
  await assert(`[...document.querySelectorAll('[data-character-name]')].some(e=>e.getClientRects().length && e.textContent.trim()==='検証キャラ')`, '追従をオンに戻すと最後のキャラクターを表示')
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
  await assert(`(() => {const item=[...document.querySelectorAll('[aria-live="polite"] .timeline-item')].find(e=>e.textContent.includes('章名を変更: 制作で改名した章'));return !!item && getComputedStyle(item.querySelector('.timeline-dot')).backgroundColor==='rgb(62, 207, 142)' && !!item.querySelector('details')})()`, '確定した操作は緑の丸で、変更内容を折りたたんで出す')
  await assert(`(() => {const items=[...document.querySelectorAll('[aria-live="polite"] .timeline-item')].filter(e=>e.querySelector('time'));const rights=items.map(e=>Math.round(e.querySelector('time').getBoundingClientRect().right));const edge=Math.round(items[0].getBoundingClientRect().right);return items.length>=3 && rights.every(r=>Math.abs(r-edge)<=1)})()`, '時系列の時刻は右端に揃う')
  writeFileSync(join(target, 'timeline.png'), (await win.webContents.capturePage()).toPNG())
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
  await assert(`document.querySelector('[aria-label="制作チャットの送信モード"] [aria-pressed="true"]').textContent==='相談する'`, '制作の実行が終わると送信モードは相談に戻り、候補を選んでも変わらない')
  await input('textarea[aria-label="制作への依頼"]', '')
  await click('この案で進めて')
  await assert(`document.querySelector('textarea[aria-label="制作への依頼"]').value.includes('直前の回答で提示された案') && !window.workspaceSuggestionSent`, 'この案で進めては会話の案を対象に入力し自動送信しない')
  await input('textarea[aria-label="制作への依頼"]', '')
  await click('資料庫')
  await click('追従先の場所')
  await assert(`!document.querySelector('[data-edit-group="place-description"] textarea') && [...document.querySelectorAll('main button')].some(e=>e.getClientRects().length && e.textContent.trim()==='+ 説明を書く') && ![...document.querySelectorAll('.library-save-bar')].some(e=>e.getClientRects().length)`, '場所は読む表示が既定で、全体の保存欄は無い')
  await js(`document.querySelector('button[aria-label="説明を編集"]').click()`)
  await pause(200)
  const placeDraftInput = '[data-edit-group="place-description"] textarea'
  await input(placeDraftInput, '種類を切り替えても保持する説明')
  await js(`document.querySelector('#library-characters button').click()`)
  await pause(150)
  await assert(`document.querySelector('#library-places').textContent.includes('未保存')`, '人物を編集中も場所の未保存バッジを表示')
  await js(`document.querySelector('#library-places button').click()`)
  await pause(150)
  await assert(`document.querySelector(${JSON.stringify(placeDraftInput)}).value==='種類を切り替えても保持する説明'`, '種類を行き来しても場所の未保存本文を保持')
  await js(`[...document.querySelectorAll('[data-edit-group="place-description"] button')].find(e=>e.textContent.trim()==='取り消し').click()`)
  await pause(200)
  await assert(`!document.querySelector('#library-places').textContent.includes('未保存') && !document.querySelector('[data-edit-group="place-description"] textarea')`, '場所の編集を取り消すと未保存バッジが消え、読む表示へ戻る')
  await js(`[...document.querySelectorAll('main button')].find(e=>e.getClientRects().length && e.textContent.trim()==='+ 雰囲気を書く').click()`)
  await pause(200)
  await input('[data-edit-group="place-atmosphere"] textarea', '検証の雰囲気')
  await js(`[...document.querySelectorAll('[data-edit-group="place-atmosphere"] button')].find(e=>e.textContent.trim()==='確定').click()`)
  for (let i = 0; i < 40; i++) {
    if (await js(`!document.querySelector('[data-edit-group="place-atmosphere"] textarea')`)) break
    await pause(100)
  }
  const savedPlace = (await (await fetch(base + '/places')).json()).find((item) => item.name === '追従先の場所')
  if (savedPlace.atmosphere !== '検証の雰囲気') errors.push('場所の確定でその項目が保存されていない: ' + JSON.stringify(savedPlace))
  await assert(`[...document.querySelectorAll('[data-edit-group="place-atmosphere"] p')].some(e=>e.textContent==='検証の雰囲気')`, '場所の項目を確定すると保存して読む表示へ戻る')
  writeFileSync(join(target, 'library-place-read.png'), (await win.webContents.capturePage()).toPNG())
  await click('関係図')
  await assert(`document.querySelector('button[aria-pressed="true"]').textContent.includes('関係図') || [...document.querySelectorAll('button[aria-pressed="true"]')].some(e=>e.textContent==='関係図')`, '見出し横から関係図を開く')
  await js(`document.querySelector('#library-characters button').click()`)
  await pause(150)
  await assert(`[...document.querySelectorAll('[data-character-name]')].some(e=>e.getClientRects().length && e.textContent.trim()==='検証キャラ')`, '資料名のクリックで関係図から編集に戻る')
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
