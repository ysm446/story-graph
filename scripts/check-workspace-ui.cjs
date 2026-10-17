// 隔離したライブラリとElectronで、共通チャットの配置・下書き保持・編集ガードを検証する。
const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createServer } = require('node:net')
const root = resolve(__dirname, '..')
// 検証の出力は data/test/ にまとめる(data/ の直下には既定のライブラリがあるので混ぜない。2026-10-14 ユーザー指示)
const testRoot = join(root, 'data', 'test')
const target = join(testRoot, `workspace-check-${Date.now()}`)
mkdirSync(target, { recursive: true })
// 前回までの検証フォルダを片付ける。実行のたびに data/test/ へ 1 つ作るので、消さないと増え続ける
// (2026-10-14 に 173 個・約 1.3GB たまっていた)。終了時に消さないのは、スクリーンショットを後から
// 見られるようにするためと、実行中は Electron が中のファイルを開いていて消せないため。
// 10 分より古いものだけを消すので、並行して走っている別の検証のフォルダには触らない
for (const name of readdirSync(testRoot)) {
  const match = /^workspace-check-(\d+)$/.exec(name)
  if (!match || Date.now() - Number(match[1]) < 10 * 60 * 1000) continue
  try { rmSync(join(testRoot, name), { recursive: true, force: true }) } catch { /* 開かれている間は次の回に任せる */ }
}
app.setPath('userData', join(target, 'electron'))
const trace = (m) => { if (process.env.CHECK_TRACE) console.error('[trace] ' + m) }
trace('script loaded ' + target)
let backend
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function main() {
  await app.whenReady()
  trace('app ready')
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
  trace('backend ready ' + base)
  for (const [path, value] of process.argv.includes('--import') || process.argv.includes('--cast') || process.argv.includes('--usage') || process.argv.includes('--memories') ? [] : [['/characters', { name: '検証キャラ', profile: '保存済みプロフィール' }], ['/nodes', { title: '検証シーン', beat: '保存済みの本文。' }]]) {
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
  // 確定したシーン編集の項目に、本文の折りたたみが出るか(制作の履歴を直接仕込む)
  if (process.argv.includes('--optext')) {
    const graph = await (await fetch(base + '/graph')).json()
    const node = graph.nodes.find((n) => !n.kind)
    const seed = spawnSync(join(root, '.venv/Scripts/python.exe'), ['-c', `import json
from app import store
chat = store.create_chat(None, 'upto', mode='production')
store.set_chat_title(chat['id'], 'optext-chat')
scene = {'id': ${JSON.stringify(node.id)}, 'title': '検証シーン', 'beat': '確定した本文です。二行目もあります。', 'cast': [], 'location': None}
store.save_chat_messages(chat['id'], [
  {'role': 'user', 'content': '本文を直して', 'execute': True},
  {'role': 'assistant', 'content': '語尾を整えました', 'operation': {'action': 'update_scene', 'node_id': scene['id'], 'title': '検証シーン', 'reason': '語尾を整えました', 'scene': scene}},
  {'role': 'assistant', 'content': '完了しました。'}
])
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
  trace('page loaded')
  const js = (source) => win.webContents.executeJavaScript(source)
  const click = async (label) => {
    // 文字の無いアイコンのボタン(送信の ↑ など)は aria-label で探す
    await js(`(() => { const visible = [...document.querySelectorAll('button')].filter(e => e.getClientRects().length); const el = visible.find(e => e.textContent.trim() === ${JSON.stringify(label)}) ?? visible.find(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!el) throw new Error('ボタンがありません: ' + ${JSON.stringify(label)}); el.click() })()`)
    await pause(180)
  }
  const assert = async (condition, message) => {
    if (!await js(condition)) {
      try { writeFileSync(join(target, 'fail.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
      if (errors.length) console.error('これまでの不一致: ' + errors.join(' / '))
      throw new Error(message)
    }
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
  if (process.argv.includes('--import')) {
    // 設定の「取り込み」: 完成例(docs/reference/import-example.json)を、空のライブラリへ取り込む
    const { readFileSync } = require('node:fs')
    const example = JSON.parse(readFileSync(join(root, 'docs/reference/import-example.json'), 'utf8'))
    const choose = (data) => js(`(() => {const input=document.querySelector('input[aria-label="取り込み JSON のファイル"]');const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(data))}],'work.json',{type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    const result = `document.querySelector('[data-import-result]')`
    const waitResult = async () => { for (let i = 0; i < 40; i++) { if (await js(`!!${result}`)) return; await pause(100) } }
    await js(`document.querySelector('button[aria-label="設定"]').click()`)
    await pause(400)
    await click('取り込み')
    await pause(400)
    await assert(`document.body.textContent.includes('import-format.md') && !${result} && document.body.textContent.includes('今開いているライブラリ(作品)に保存します')`, '取り込みのページに説明があり、ファイルを選ぶまでは結果を出さない')
    // 誤りのあるファイル: 取り込むボタンは出さず、誤りの一覧と、貼り返すためのコピーを出す
    const broken = JSON.parse(JSON.stringify(example))
    broken.scenes[1].location = '山の上'
    broken.scenes[2].cast.push('田中')
    await choose(broken)
    await waitResult()
    await assert(`(() => {const r=${result};const items=[...r.querySelectorAll('li')].map(e=>e.textContent);return r.dataset.importResult==='errors' && items.length===2 && items.some(t=>t.includes('「橋のひび」') && t.includes('「山の上」が places にありません')) && items.some(t=>t.includes('「田中」が characters にありません')) && r.textContent.includes('誤りが 2 件あります') && [...r.querySelectorAll('button')].map(e=>e.textContent.trim()).join('|')==='誤りをコピー'})()`, '誤りのあるファイルでは、場所と直し方の分かる誤りの一覧を出し、取り込むボタンは出さない')
    writeFileSync(join(target, 'import-errors.png'), (await win.webContents.capturePage()).toPNG())
    if ((await (await fetch(base + '/graph')).json()).nodes.some((n) => !n.kind)) errors.push('検査だけでシーンが書き込まれた')
    else console.log('PASS 検査だけでは何も書き込まない')
    // 正しいファイル: 件数を確かめてから取り込む
    await choose(example)
    for (let i = 0; i < 40; i++) { if (await js(`${result}?.dataset.importResult==='ok'`)) break; await pause(100) }
    await assert(`(() => {const r=${result};return r.dataset.importResult==='ok' && r.textContent.includes('「北の橋(完成例)」') && r.textContent.includes('キャラクター 3 / 場所 2 / 設定資料 1 / 章 3 / シーン 4 / イベント 17') && !r.querySelector('li') && [...r.querySelectorAll('button')].some(e=>e.textContent.trim()==='取り込む')})()`, '正しいファイルでは件数の要約と「取り込む」を出す')
    writeFileSync(join(target, 'import-ready.png'), (await win.webContents.capturePage()).toPNG())
    await js(`[...${result}.querySelectorAll('button')].find(e=>e.textContent.trim()==='取り込む').click()`)
    for (let i = 0; i < 80; i++) { if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('第一幕'))`)) break; await pause(150) }
    await pause(500)
    for (let i = 0; i < 40; i++) { if (await js(`document.body.textContent.includes('取り込みました(キャラクター 3')`)) break; await pause(150) }
    await assert(`!document.querySelector('input[aria-label="取り込み JSON のファイル"]') && !!document.querySelector('.react-flow').getClientRects().length && [...document.querySelectorAll('.react-flow__node')].filter(e=>/第.幕/.test(e.textContent)).length===3 && document.body.textContent.includes('取り込みました(キャラクター 3')`, '取り込むと画面を読み直して構造の画面に戻り、取り込んだ章が並び、結果を知らせる')
    await assert(`(() => {const x=(t)=>{const e=[...document.querySelectorAll('.react-flow__node')].find(n=>n.textContent.includes(t));return e?e.getBoundingClientRect().x:NaN};const xs=[x('はじまり'),x('第一幕'),x('第二幕'),x('第三幕'),x('結末')];return xs.every((v,i)=>i===0 || v>xs[i-1])})()`, 'キャンバスは はじまり → 第一幕 → 第二幕 → 第三幕 → 結末 の順に並ぶ')
    writeFileSync(join(target, 'import-done.png'), (await win.webContents.capturePage()).toPNG())
    const graph = await (await fetch(base + '/graph')).json()
    const scenes = graph.nodes.filter((n) => !n.kind)
    const characters = await (await fetch(base + '/characters')).json()
    const snapshots = (await (await fetch(base + '/snapshots')).json()).snapshots
    if (!(scenes.length === 4 && characters.length === 3 && scenes.reduce((sum, n) => sum + n.events.length, 0) === 17 && snapshots.some((x) => x.label.startsWith('取り込みの前: 北の橋')))) errors.push('取り込んだ内容が期待と違う: ' + JSON.stringify({ scenes: scenes.length, characters: characters.length, snapshots: snapshots.map((x) => x.label) }))
    else console.log('PASS シーン4・キャラクター3・イベント17が登録され、取り込みの前のスナップショットがある')
    await click('資料庫')
    await pause(500)
    await assert(`['アヤ','ケン','老技師','港','北の橋','測量組合'].every(name => document.body.textContent.includes(name))`, '資料庫に、取り込んだキャラクター・場所・設定資料が出る')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--cast')) {
    // キャラクタービュー(人物別の出番表): 完成例を取り込んで、人物ごとのセル・章の帯・選択の連動を確かめる
    const { readFileSync } = require('node:fs')
    const example = JSON.parse(readFileSync(join(root, 'docs/reference/import-example.json'), 'utf8'))
    const applied = await fetch(base + '/import/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: example }) })
    if (!applied.ok) throw new Error(await applied.text())
    // 取り込みは画面を読む前に済ませたので、読み直して反映する(executeJavaScript で reload すると
    // 画面が消えて約束が戻らないので、webContents 側で行う)
    await new Promise((done) => { win.webContents.once('did-finish-load', () => done()); win.webContents.reload() })
    for (let i = 0; i < 60; i++) { if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('第一幕'))`)) break; await pause(200) }
    await pause(400)
    // 章カードに、読む道のシーンの登場人物が出るシーンの多い順(同数は初登場順)で並ぶ
    const chapterCast = (title) => `(() => {const card=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes(${JSON.stringify(title)}));return card ? [...card.querySelectorAll('img[alt], span[aria-label]')].map(e=>e.getAttribute('alt') ?? e.getAttribute('aria-label')).join('|') : ''})()`
    await assert(`${chapterCast('第一幕')} === 'アヤ|ケン' && ${chapterCast('第二幕')} === 'アヤ|老技師' && ${chapterCast('第三幕')} === 'アヤ|ケン'`, '章カードに章の登場人物のアイコンが並ぶ')
    writeFileSync(join(target, 'cast-chapter-cards.png'), (await win.webContents.capturePage()).toPNG())
    // ズームアウト時のタイトル: 全体表示(引いた状態)では出ていて、設定で非表示にすると出なくなる
    await assert(`document.querySelectorAll('[data-zoomed-out-title]').length >= 3`, '引いた状態では、カードの上にタイトルが出る')
    await fetch(base + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { zoomed_out_titles: '0' } }) })
    await new Promise((done) => { win.webContents.once('did-finish-load', () => done()); win.webContents.reload() })
    for (let i = 0; i < 60; i++) { if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('第一幕'))`)) break; await pause(200) }
    await pause(400)
    await assert(`document.querySelectorAll('[data-zoomed-out-title]').length === 0`, '設定で「ズームアウト時のタイトル」を非表示にすると、引いてもタイトルは出ない')
    // 全体表示ではカードが小さすぎて目視できないので、第二幕のカードに寄って切り抜く
    const cardRect = async () => js(`(() => {const r=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes('第二幕')).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    for (let i = 0; i < 12; i++) {
      const r = await cardRect()
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true })
      await pause(60)
    }
    await pause(400)
    {
      const r = await cardRect()
      writeFileSync(join(target, 'cast-chapter-card-zoom.png'), (await win.webContents.capturePage({ x: Math.max(0, Math.round(r.x - 20)), y: Math.max(0, Math.round(r.y - 60)), width: Math.round(r.width + 40), height: Math.round(r.height + 80) })).toPNG())
    }
    // 章カードのアイコンを押すと、シーンカードの札と同じく詳細欄が人物専用の表示になる。
    // 時点はその章の読む道で最後に登場するシーン(第二幕の老技師は 2 シーンとも出るので後ろのほう)
    await js(`[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes('第二幕')).querySelector('button[aria-label="老技師"]').click()`)
    await pause(500)
    const chapterCharTabs = `(() => {const tab=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && e.textContent.trim()==='プロフィール');return tab ? tab.parentElement.textContent : ''})()`
    await assert(`${chapterCharTabs}.includes('老技師') && [...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('第二幕'))`, '章カードの人物のアイコンをクリックすると、その人物が詳細欄に出る(章ビューのまま)')
    await click('状態')
    await pause(300)
    await assert(`document.body.textContent.includes('「' + ${JSON.stringify(example.scenes[2].title)} + '」の時点')`, '章カードから出した人物は、その章で最後に登場するシーンの時点になる')
    await click('プロフィール')
    await click('人物')
    await pause(400)
    const cells =`[...document.querySelectorAll('button[aria-label]')].filter(e => /^(アヤ|ケン|老技師): /.test(e.getAttribute('aria-label')))`
    await assert(`document.body.textContent.includes('キャラクタービュー') && ${cells}.length === 8 && ${cells}.filter(e=>e.getAttribute('aria-label').startsWith('アヤ:')).length === 4`, 'キャラクタービューに、cast どおりの出番のセルが並ぶ(アヤ 4・ケン 2・老技師 2)')
    // 続けて出ているシーンは 1 本の帯にまとまる: アヤは 1〜4 で 1 本、ケンは 1 と 4 で 2 本、老技師は 2〜3 で 1 本
    await assert(`(() => {const runs=[...document.querySelectorAll('[data-cast-run]')];const n=(id)=>runs.filter(e=>e.getAttribute('data-cast-run')===id).length;const ids=[...new Set(runs.map(e=>e.getAttribute('data-cast-run')))];return runs.length===4 && ids.map(n).sort().join()==='1,1,2' && Math.max(...runs.map(e=>e.offsetWidth))===${4 * 112 - 20}})()`, '続けて出ているシーンの出番は 1 本の帯にまとまる(帯は 4 本、いちばん長いのはアヤの 4 シーン分)')
    await assert(`['第1章「第一幕 出発」','第2章「第二幕 橋」','第3章「第三幕 帰港」'].every(t => document.body.textContent.includes(t))`, '列の上に章の帯が出る')
    await assert(`(() => {const tips=[...document.querySelectorAll('[data-tip$="シーンに登場"]')].map(e=>e.getAttribute('data-tip'));return tips.includes('アヤ: 4 シーンに登場') && tips.includes('ケン: 2 シーンに登場') && tips.includes('老技師: 2 シーンに登場')})()`, '左の人物の行に出番の数が出る')
    const second = example.scenes[1].title
    await js(`${cells}.find(e => e.getAttribute('aria-label') === '老技師: ' + ${JSON.stringify(second)}).click()`)
    await pause(500)
    // 出番のセルは、シーンカードで人物を押したときと同じく、その時点の人物を詳細欄に出す
    const charTabs = `(() => {const tab=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && e.textContent.trim()==='プロフィール');return tab ? [...tab.parentElement.querySelectorAll('button')].map(e=>e.textContent.trim()).slice(0,4).join('|') + '|' + tab.parentElement.textContent : ''})()`
    await assert(`${charTabs}.startsWith('プロフィール|状態|関係図|事実の履歴|') && ${charTabs}.includes('老技師') && document.body.textContent.includes('キャラクタービュー')`, 'セルをクリックすると、その人物が詳細欄に出る(ビューは開いたまま)')
    await click('状態')
    await pause(300)
    await assert(`document.body.textContent.includes('「' + ${JSON.stringify(second)} + '」の時点') && !document.body.textContent.includes('(この人物が最後に登場したシーン)')`, '詳細欄の人物は、クリックしたセルのシーンの時点になる')
    writeFileSync(join(target, 'cast-view.png'), (await win.webContents.capturePage()).toPNG())
    // 左ドラッグで表を上下左右に動かす。完成例では画面に収まってしまうので、表の枠を小さくして試す。
    // setPointerCapture は本物のポインタでないと効かないので、合成イベントではなく sendInputEvent で動かす
    const mouse = async (type, x, y) => { win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] }); await pause(40) }
    const dragBy = async (x, y, dx, dy) => { await mouse('mouseDown', x, y); for (let k = 1; k <= 5; k++) await mouse('mouseMove', x + (dx * k) / 5, y + (dy * k) / 5); await mouse('mouseUp', x + dx, y + dy); await pause(200) }
    const table = `document.querySelector('[data-cast-table]')`
    await js(`(() => { const el = ${table}; el.style.maxWidth = '420px'; el.style.maxHeight = '150px'; el.scrollLeft = 0; el.scrollTop = 0 })()`)
    await pause(200)
    const tableRect = await js(`(() => { const r = ${table}.getBoundingClientRect(); return { x: r.x, y: r.y } })()`)
    // 左の人物の名前の列から(帯の上ではない所)ドラッグ
    await dragBy(tableRect.x + 80, tableRect.y + 110, -100, -30)
    const scrolled = await js(`[${table}.scrollLeft, ${table}.scrollTop]`)
    if (!(Math.abs(scrolled[0] - 100) <= 6 && scrolled[1] >= 20)) errors.push('ドラッグで表が動いていない: ' + JSON.stringify(scrolled))
    else console.log('PASS 左ドラッグで出番表が上下左右に動く')
    // 見出しから始めたドラッグはシーンを選ばない(選択は 2 番目のシーンのまま)。動かさずに押せば今までどおり選ぶ
    const headerAt = (title) => js(`(() => { const r = [...${table}.querySelectorAll('button[data-tip]')].find(e => e.getAttribute('data-tip').includes(${JSON.stringify('. ')} + ${JSON.stringify(title)})).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await js(`${table}.scrollLeft = 0`)
    await pause(100)
    let at = await headerAt(example.scenes[0].title)
    await dragBy(at.x, at.y, 60, 0)
    await assert(`${charTabs}.includes('老技師') && document.body.textContent.includes('「' + ${JSON.stringify(second)} + '」の時点')`, '見出しから始めたドラッグではシーンが選ばれない(セルで出した人物の表示のまま)')
    at = await headerAt(example.scenes[0].title)
    await mouse('mouseDown', at.x, at.y)
    await mouse('mouseUp', at.x, at.y)
    await pause(400)
    await assert(`[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(example.scenes[0].title)})`, '動かさずに見出しを押すと、今までどおりそのシーンが選ばれる')
    await js(`(() => { const el = ${table}; el.style.maxWidth = ''; el.style.maxHeight = ''; el.scrollLeft = 0; el.scrollTop = 0 })()`)
    // 章の帯をクリックすると章を選んだことになり、詳細欄が章の表示(章 / 関係図 / 事実)になる
    await js(`[...${table}.querySelectorAll('button')].find(e => e.textContent === '第2章「第二幕 橋」').click()`)
    await pause(500)
    await assert(`(() => {const band=[...${table}.querySelectorAll('button')].find(e => e.textContent === '第2章「第二幕 橋」');const tab=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && e.textContent.trim()==='関係図');const labels=[...tab.parentElement.querySelectorAll('button')].map(e=>e.textContent.trim());return band.getAttribute('aria-pressed')==='true' && labels.slice(0,3).join('|')==='章|関係図|事実' && tab.closest('aside').textContent.includes('第二幕 橋') && document.body.textContent.includes('キャラクタービュー')})()`, '章の帯をクリックすると、その章が選ばれて詳細欄が章の表示になる(ビューは開いたまま)')
    // 章の帯のあとにセルを押しても、そのシーンの時点になる(章カードの選択が外れた通知で、選んだシーンが消えない)
    await js(`${cells}.find(e => e.getAttribute('aria-label') === '老技師: ' + ${JSON.stringify(second)}).click()`)
    await pause(400)
    await assert(`${charTabs}.includes('老技師') && document.body.textContent.includes('「' + ${JSON.stringify(second)} + '」の時点') && !document.body.textContent.includes('(この人物が最後に登場したシーン)')`, '章の帯のあとにセルをクリックしても、そのシーンの時点の人物が出る(章カードの選択が外れても消えない)')
    await click('プロフィール') // 人物のタブを既定に戻す(後の検証はプロフィールから始まる)
    // 列の見出しは今までどおりシーンを選び、詳細欄はシーンの表示に戻る(後の検証のため選択は 2 番目のシーン)
    const headerOf = (title) => `[...document.querySelectorAll('[data-cast-table] button[data-tip]')].find(e => e.getAttribute('data-tip').includes('. ' + ${JSON.stringify(title)}))`
    await js(`${headerOf(second)}.click()`)
    await pause(400)
    await assert(`[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(second)}) && !${charTabs}`, '列の見出しをクリックすると、そのシーンが選ばれて詳細欄はシーンの表示に戻る')
    // シーンを選んだ状態で → / ← を押すと、前後のシーンへ移る(キャラクタービューは開いたまま)
    const key = async (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(400) }
    // 前にクリックした見出しにフォーカスを置いておき、キーで移っても枠(:focus-visible)が置き去りにならないことも見る
    win.focus(); win.webContents.focus()
    await js(`[...document.querySelectorAll('[data-cast-table] button[data-tip]')].find(e => e.getAttribute('data-tip').includes('. ' + ${JSON.stringify(second)})).focus()`)
    await key('Right')
    await assert(`[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(example.scenes[2].title)}) && document.body.textContent.includes('キャラクタービュー') && !document.querySelector('[data-cast-table] :focus-visible')`, '→ キーで次のシーンへ移る(前に押した見出しの枠は残らない)')
    await key('Left')
    await key('Left')
    await assert(`[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(example.scenes[0].title)})`, '← キーで前のシーンへ移る')
    await key('Left')
    await assert(`[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(example.scenes[0].title)})`, '最初のシーンで ← を押しても動かない')
    await js(`${headerOf(second)}.click()`)
    await pause(400)
    // 出番のセルをクリックすると、詳細欄が人物専用(プロフィール / 状態 / 関係図 / 事実の履歴)になる
    await js(`${cells}.find(e => e.getAttribute('aria-label') === 'ケン: ' + ${JSON.stringify(example.scenes[0].title)}).click()`)
    await pause(800)
    const tabLabels = `[...document.querySelectorAll('aside button')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`
    await assert(`(() => { const name = [...document.querySelectorAll('[data-character-name]')].find(e => e.getClientRects().length); const tabs = ${tabLabels}; return !!name && name.textContent.trim() === 'ケン' && ['プロフィール','状態','関係図','事実の履歴'].every(t => tabs.includes(t)) && !tabs.includes('シーン') && !tabs.includes('清書') && !!document.querySelector('button[aria-label="プロフィールを編集"]') && !document.body.textContent.includes('このキャラクターを削除') })()`, 'セルをクリックすると、詳細欄が人物専用(プロフィール / 状態 / 関係図 / 事実の履歴)になり、プロフィールに資料庫と同じ編集画面が出る(シーン・清書・削除は出ない)')
    // 詳細欄で保存すると、資料庫に反映される
    await js(`document.querySelector('button[aria-label="プロフィールを編集"]').click()`)
    await pause(300)
    await input('[data-edit-group="profile"] textarea', '詳細欄から書いたプロフィール')
    await js(`[...document.querySelectorAll('[data-edit-group="profile"] button')].find(e => e.textContent.trim() === '確定').click()`)
    await pause(800)
    const savedKen = (await (await fetch(base + '/characters')).json()).find((c) => c.name === 'ケン')
    if (savedKen.profile !== '詳細欄から書いたプロフィール') errors.push('詳細欄で確定したプロフィールが保存されていない: ' + JSON.stringify(savedKen.profile))
    else console.log('PASS 詳細欄のプロフィールで確定した内容が保存される')
    await click('状態')
    await pause(600)
    await assert(`document.body.textContent.includes('の時点') && !!document.querySelector('input[placeholder^="記憶を追加"]') && !document.querySelector('[role="group"][aria-label="このシーンの登場人物"]')`, '「状態」でその人物の記憶・事実・関係が、時点つきで出る(人物の一覧は出さない)')
    await click('事実の履歴')
    await pause(400)
    await assert(`!document.querySelector('[role="group"][aria-label="事実を見る対象"]') && document.body.textContent.includes('の時点')`, '「事実の履歴」はその人物に絞って出る')
    await click('プロフィール')
    await pause(300)
    writeFileSync(join(target, 'cast-library.png'), (await win.webContents.capturePage()).toPNG())
    await click('⊞ フローチャート')
    await pause(300)
    await assert(`!document.body.textContent.includes('キャラクタービュー') && [...document.querySelectorAll('.react-flow__node')].length > 0`, '「フローチャート」で元の表示に戻る')
    // フローチャートのカードの登場人物の札をクリック → 人物専用の表示(シーンの選択は変えない)。
    // 章ビューではシーンのカードが章に畳まれているので、全シーンの表示にしてから押す
    if (await js(`document.body.textContent.includes('⊞ 全シーン')`)) {
      await click('⊞ 全シーン')
      await pause(800)
    }
    await js(`[...document.querySelectorAll('.react-flow__node button[data-tip$="この人物を出す"]')].find(e => e.getAttribute('data-tip').startsWith('アヤ') && e.getClientRects().length).click()`)
    await pause(500)
    await assert(`(() => { const name = [...document.querySelectorAll('[data-character-name]')].find(e => e.getClientRects().length); const chip = [...document.querySelectorAll('.react-flow__node button[data-tip$="この人物を出す"]')].find(e => e.getAttribute('data-tip').startsWith('アヤ') && e.getClientRects().length); return !!name && name.textContent.trim() === 'アヤ' && ${tabLabels}.includes('プロフィール') && chip.closest('.react-flow__node').classList.contains('selected') })()`, 'フローチャートのカードの登場人物の札をクリックすると、そのシーンが選ばれ、詳細欄が人物専用の表示になる')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--memories')) {
    // 人物の状態の Memories: 続けて同じシーンから得た記憶は 1 枚のカードにまとまり、そのシーンの挿絵を先頭に 1 回だけ出す
    const { readFileSync } = require('node:fs')
    const example = JSON.parse(readFileSync(join(root, 'docs/reference/import-example.json'), 'utf8'))
    const applied = await fetch(base + '/import/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: example }) })
    if (!applied.ok) throw new Error(await applied.text())
    // 最初と最後のシーンにだけ挿絵(アプリのアイコン)を付ける
    const graph = await (await fetch(base + '/graph')).json()
    const idOf = (title) => graph.nodes.find((n) => n.title === title).id
    const [firstTitle, lastTitle] = [example.scenes[0].title, example.scenes[3].title]
    const seeded = spawnSync(join(root, '.venv/Scripts/python.exe'), ['-c', 'import sys, shutil, os, db; from store import Store; s = Store(db.connect(sys.argv[1]), root=sys.argv[2]); shutil.copy(sys.argv[3], os.path.join(s.assets_dir(), "test-art.png")); [s.set_node_image(n, "test-art.png") for n in sys.argv[4:]]; s.conn.commit()', join(target, 'story-graph.db'), target, join(root, 'resources/icon.png'), idOf(firstTitle), idOf(lastTitle)], { cwd: join(root, 'backend'), encoding: 'utf8' })
    if (seeded.status !== 0) throw new Error(seeded.stderr)
    await new Promise((done) => { win.webContents.once('did-finish-load', () => done()); win.webContents.reload() })
    for (let i = 0; i < 60; i++) { if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('第一幕'))`)) break; await pause(200) }
    await pause(400)
    // 最後のシーンの時点のアヤを出す(キャラクタービューの出番のセルから)
    await click('人物')
    await pause(400)
    await js(`[...document.querySelectorAll('button[aria-label]')].find(e => e.getAttribute('aria-label') === 'アヤ: ' + ${JSON.stringify(lastTitle)}).click()`)
    await pause(500)
    await click('状態')
    await pause(600)
    const groups = `[...document.querySelectorAll('[data-memory-group]')]`
    await assert(`${groups}.length === 4 && ${groups}.filter(e => e.querySelector('img')).length === 2 && ${groups}[0].textContent.includes('(このシーン)') && ${groups}[3].textContent.includes(${JSON.stringify(firstTitle)})`, '記憶はシーンごとのカードで新しい順に並び、挿絵のあるシーンのカードにだけサムネイルが出る')
    // 同じシーンに記憶を足すと、同じカードにまとまる(出どころの行は 1 回だけ)
    await js(`(() => { const el = document.querySelector('input[placeholder^="記憶を追加"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '検証で足した記憶'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await pause(100)
    await js(`document.querySelector('button[aria-label="memory_add イベントとして記録"]').click()`)
    for (let i = 0; i < 30; i++) { if (await js(`document.body.textContent.includes('Memories(5)')`)) break; await pause(200) }
    await assert(`${groups}.length === 4 && ${groups}[0].textContent.includes('検証で足した記憶') && ${groups}[0].querySelectorAll('img').length === 1 && (${groups}[0].textContent.match(/← /g) || []).length === 1`, '同じシーンの記憶は 1 枚のカードにまとまり、挿絵と出どころは 1 回だけ出る')
    writeFileSync(join(target, 'memories.png'), (await win.webContents.capturePage()).toPNG())
    const rect = await js(`(() => { const r = document.querySelector('[data-memory-group]').parentElement.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(Math.min(r.height, 420)) } })()`)
    writeFileSync(join(target, 'memories-zoom.png'), (await win.webContents.capturePage(rect)).toPNG())
    // サムネイルを押すと、そのシーンへ移る
    await js(`${groups}[3].querySelector('button img').closest('button').click()`)
    await pause(600)
    await assert(`[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(firstTitle)})`, 'サムネイルをクリックすると、出どころの行と同じくそのシーンが選ばれる')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--usage')) {
    // 資料庫の「出番の図」(SceneUsage): 人物は登場するシーン、場所は使われている場面(引き継ぎを含む)を正史の順に並べ、分岐は別の行。クリックでフローチャートへ
    const { readFileSync } = require('node:fs')
    const example = JSON.parse(readFileSync(join(root, 'docs/reference/import-example.json'), 'utf8'))
    const applied = await fetch(base + '/import/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: example }) })
    if (!applied.ok) throw new Error(await applied.text())
    const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(await r.text()); return r.json() }
    const graph0 = await (await fetch(base + '/graph')).json()
    const chars = await (await fetch(base + '/characters')).json()
    const places = await (await fetch(base + '/places')).json()
    const byTitle = (t) => graph0.nodes.find((n) => n.title === t).id
    const charId = (n) => chars.find((c) => c.name === n).id
    const placeId = (n) => places.find((p) => p.name === n).id
    // 正史の末尾に場所を空欄にしたシーン(港を引き継ぐ)、2 番目のシーンから分岐(老技師だけ)
    await post('/nodes/' + byTitle(example.scenes[3].title) + '/insert_after', { title: '翌朝', beat: '翌朝の港。', cast: [charId('ケン')] })
    await post('/nodes', { title: '別の道', beat: '橋を迂回する。', cast: [charId('老技師')], location: placeId('北の橋'), parent_id: byTitle(example.scenes[1].title) })
    await new Promise((done) => { win.webContents.once('did-finish-load', () => done()); win.webContents.reload() })
    for (let i = 0; i < 60; i++) { if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('第一幕'))`)) break; await pause(200) }
    await pause(400)
    await click('資料庫')
    await pause(400)
    const clickRow = async (name) => { await js(`[...document.querySelectorAll('button')].find(e => e.getClientRects().length && e.textContent.trim().endsWith(${JSON.stringify(name)}) && e.closest('nav, aside, [class*="list"]') !== null).click()`); await pause(500) }
    const section = (label) => `document.querySelector('section[aria-label=${JSON.stringify(label)}]')`
    const cols = (label) => `[...${section(label)}.querySelectorAll('button[aria-label]')].map(e => e.getAttribute('aria-label'))`
    await clickRow('ケン')
    await assert(`!!${section('登場するシーン')} && ${cols('登場するシーン')}.join('|') === '1. ${example.scenes[0].title}|2. ${example.scenes[1].title}|3. ${example.scenes[2].title}|4. ${example.scenes[3].title}|5. 翌朝'`, '人物のページに「登場するシーン」の図が出て、正史の 5 シーンが順に並ぶ')
    await assert(`${section('登場するシーン')}.textContent.includes('登場するシーン3') && !${section('登場するシーン')}.textContent.includes('分岐:')`, 'ケンの出番は 3(分岐には出ていないので分岐の行は無い)')
    await assert(`['第一幕 出発','第二幕 橋','第三幕 帰港'].every(t => ${section('登場するシーン')}.textContent.includes(t))`, '図の上に章の帯が出る')
    writeFileSync(join(target, 'usage-character.png'), (await win.webContents.capturePage()).toPNG())
    await clickRow('老技師')
    await assert(`${section('登場するシーン')}.textContent.includes('登場するシーン3') && ${section('登場するシーン')}.textContent.includes('分岐: 「${example.scenes[1].title}」から') && ${cols('登場するシーン')}.includes('1. 別の道')`, '老技師は正史 2 + 分岐 1 で、分岐の行に「別の道」が出る')
    await clickRow('港')
    await assert(`!!${section('使われている場面')} && ${section('使われている場面')}.textContent.includes('使われている場面3(うち引き継ぎ 1)')`, '場所のページに「使われている場面」が出て、引き継ぎを含めて数える(港: 3、うち引き継ぎ 1)')
    await assert(`[...${section('使われている場面')}.querySelectorAll('div')].some(e => e.style.borderStyle === 'dashed') && [...${section('使われている場面')}.querySelectorAll('div')].some(e => e.style.borderStyle === 'solid')`, '引き継ぎのシーンは破線の帯、直接指定は実線の帯')
    await assert(`[...${section('使われている場面')}.querySelectorAll('button[data-tip]')].find(e => e.getAttribute('aria-label') === '5. 翌朝').getAttribute('data-tip').includes('引き継ぎ')`, '引き継ぎのセルのツールチップに「引き継ぎ」と出る')
    writeFileSync(join(target, 'usage-place.png'), (await win.webContents.capturePage()).toPNG())
    // 図のセルをクリックすると、フローチャートに移ってそのシーンが選ばれる
    await js(`[...${section('使われている場面')}.querySelectorAll('button[aria-label]')].find(e => e.getAttribute('aria-label') === '5. 翌朝').click()`)
    await pause(1200)
    await assert(`!!document.querySelector('.react-flow') && document.querySelector('.react-flow').getClientRects().length > 0 && [...document.querySelectorAll('input')].some(i => i.value === '翌朝')`, 'セルをクリックすると、フローチャートに移ってそのシーンが選ばれる')
    writeFileSync(join(target, 'usage-jump.png'), (await win.webContents.capturePage()).toPNG())
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--imageprompts')) {
    // 設定 → システムプロンプト → 画像生成プロンプト: 4 つの編集欄(既定がプレースホルダ)と固定部分、保存
    await js(`document.querySelector('button[aria-label="設定"]').click()`)
    await pause(400)
    await assert(`(() => {const items=[...document.querySelectorAll('aside button')].map(e=>e.textContent.trim());const i=items.indexOf('シーン生成');return i>0 && items.slice(i,i+6).join('|')==='シーン生成|清書(スタイルプリセット)|校正|制作エージェントへの指示|画像生成プロンプト|書き出し / 読み込み'})()`, '設定の左一覧のシステムプロンプトに「画像生成プロンプト」が並ぶ')
  await click('画像生成プロンプト')
  await pause(400)
  await assert(`[...document.querySelectorAll('textarea[aria-label^="画像生成プロンプト: "]')].length === 4 && document.body.textContent.includes('機械的に付く部分') && [...document.querySelectorAll('textarea[aria-label^="画像生成プロンプト: "]')].every(t => t.placeholder.length > 40)`, '画像生成プロンプトに 4 つの編集欄(既定がプレースホルダ)と固定部分を表示')
  await input('textarea[aria-label="画像生成プロンプト: 人物の参照画像"]', '設定から変えた人物の指示')
  await js(`document.querySelector('textarea[aria-label="画像生成プロンプト: 人物の参照画像"]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`)
  await pause(500)
  if ((await (await fetch(base + '/settings')).json()).image_prompt_character !== '設定から変えた人物の指示') errors.push('画像生成プロンプトの人物の指示が保存されていない')
  else console.log('PASS 画像生成プロンプトの編集欄が保存される')
  writeFileSync(join(target, 'settings-image-prompts.png'), (await win.webContents.capturePage()).toPNG())
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--relations')) {
    // 資料庫の関係図(直角の線): 線が人物のアイコン・名前を通らず、ラベルが人物・他のラベルに重ならない
    const { copyFileSync } = require('node:fs')
    mkdirSync(join(target, 'assets', 'images'), { recursive: true })
    copyFileSync(join(root, 'resources/icon.png'), join(target, 'assets', 'images', 'test-art.png'))
    const node = (await (await fetch(base + '/graph')).json()).nodes.find(n => !n.kind)
    // 名前の長さ・アイコンの有無・退場を混ぜ、上下・左右に近く並べる(名前の上を線が通りやすい配置)
    const people = [['アリス', 0, 0, true], ['ボブ', 130, 0, false], ['キャロライン', 260, 0, true], ['ダン', 0, 120, true], ['エヴァンジェリン', 130, 120, true], ['フランク', 260, 120, false], ['グレース', 65, 240, true], ['ハル', 195, 240, true]]
    const ids = []
    for (const [name, x, y, portrait] of people) {
      const r = await fetch(base + '/characters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      if (!r.ok) throw new Error(await r.text())
      const c = await r.json()
      ids.push(c.id)
      const p = await fetch(base + '/characters/' + c.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph_x: x, graph_y: y, ...(portrait ? { portrait_path: 'test-art.png' } : {}) }) })
      if (!p.ok) throw new Error(await p.text())
    }
    const labels = ['友人', '幼なじみ', '師匠', 'ライバル', '想い人', '仇']
    const rels = [[0, 1], [1, 0], [0, 4], [4, 0], [3, 1], [2, 3], [5, 0], [6, 2], [7, 3], [4, 7], [6, 5], [1, 6], [2, 4], [3, 5]]
    const events = [
      ...ids.map(id => ({ type: 'char_introduce', payload: { char: id } })),
      ...rels.map(([a, b], i) => ({ type: 'relationship_set', payload: { char: ids[a], target_type: 'char', target: ids[b], value: i % 3 === 2 ? -0.5 : 0.6, reason: '検証用の関係', label: labels[i % labels.length] } })),
      { type: 'char_retire', payload: { char: ids[4], reason: '検証' } }
    ]
    const ev = await fetch(base + '/nodes/' + node.id + '/events', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }) })
    if (!ev.ok) throw new Error(await ev.text())
    await new Promise((done) => { win.webContents.once('did-finish-load', () => done()); win.webContents.reload() })
    for (let i = 0; i < 60; i++) { if (await js(`!!document.querySelector('.react-flow')`)) break; await pause(200) }
    await click('資料庫')
    await click('関係図')
    const svg = `[...document.querySelectorAll('main svg')].find(e => e.getClientRects().length && e.querySelectorAll('g[transform]').length >= 8)`
    for (let i = 0; i < 40; i++) { if (await js(`!!${svg} && ${svg}.querySelectorAll('polyline').length >= ${rels.length * 2}`)) break; await pause(150) }
    await pause(600) // 線は deferred な座標で引くので一拍待つ
    // 図の座標系で、人物の形(アイコンの円 + 下の名前・退場の矩形)・線・ラベルの矩形を取り出して重なりを調べる
    const measure = (svgExpr) => js(`(() => {
      const svg = ${svgExpr}
      const nodes = [...svg.querySelectorAll('g[transform]')].filter(g => g.querySelector('circle')).map(g => {
        const t = g.transform.baseVal.consolidate().matrix
        const x = t.e, y = t.f
        const r = Math.max(...[...g.querySelectorAll('circle')].map(c => +c.getAttribute('r'))) + 1
        const boxes = [...g.querySelectorAll('text')].map(t => t.getBBox()).filter(b => b.y > 5).map(b => ({ x0: x + b.x, x1: x + b.x + b.width, y0: y + b.y, y1: y + b.y + b.height }))
        return { x, y, r, boxes }
      })
      const inside = (n, px, py) => Math.hypot(px - n.x, py - n.y) < n.r || n.boxes.some(b => px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1)
      const lines = [...svg.querySelectorAll('polyline')].filter(p => p.getAttribute('stroke') !== 'transparent').map(p => p.getAttribute('points').trim().split(/\s+/).map(s => s.split(',').map(Number)))
      let lineHits = 0, diagonal = 0
      for (const pts of lines) {
        if (pts.some((p, i) => i > 0 && Math.abs(p[0] - pts[i - 1][0]) > 0.2 && Math.abs(p[1] - pts[i - 1][1]) > 0.2)) diagonal++
        let hit = false
        for (let i = 1; i < pts.length && !hit; i++) {
          const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)))
          for (let k = 0; k <= n && !hit; k++) if (nodes.some(nd => inside(nd, ax + (bx - ax) * k / n, ay + (by - ay) * k / n))) hit = true
        }
        if (hit) lineHits++
      }
      const labels = [...svg.querySelectorAll('g > rect')].map(r => ({ x0: +r.getAttribute('x'), y0: +r.getAttribute('y'), x1: +r.getAttribute('x') + +r.getAttribute('width'), y1: +r.getAttribute('y') + +r.getAttribute('height') }))
      const hitsRect = (r, n) => { const cx = Math.min(r.x1, Math.max(r.x0, n.x)), cy = Math.min(r.y1, Math.max(r.y0, n.y)); return Math.hypot(cx - n.x, cy - n.y) < n.r || n.boxes.some(b => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0) }
      const labelHitsNode = labels.filter(r => nodes.some(n => hitsRect(r, n))).length
      const labelOverlap = labels.filter(r => labels.some(q => q !== r && r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)).length
      return { nodes: nodes.length, lines: lines.length, labels: labels.length, lineHits, diagonal, labelHitsNode, labelOverlap }
    })()`)
    const check = async (svgExpr, name, file) => {
      const report = await measure(svgExpr)
      console.log(name + ': ' + JSON.stringify(report))
      writeFileSync(join(target, file + '.png'), (await win.webContents.capturePage()).toPNG())
      // 細部を目で見る用に、ホイールで 2 倍ほど寄せて図の枠だけを撮る
      const rect = await js(`(() => { const s = ${svgExpr}; const r = s.getBoundingClientRect(); for (let i = 0; i < 5; i++) s.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })()`)
      await pause(300)
      writeFileSync(join(target, file + '-zoom.png'), (await win.webContents.capturePage(rect)).toPNG())
      if (report.nodes !== people.length || report.lines !== rels.length || report.labels !== rels.length) errors.push(name + 'の人物・線・ラベルの数が合わない: ' + JSON.stringify(report))
      if (report.lineHits || report.diagonal) errors.push(name + 'の線が人物のアイコン・名前を通る、または斜めになっている: ' + JSON.stringify(report))
      if (report.labelHitsNode || report.labelOverlap) errors.push(name + 'のラベルが人物・他のラベルに重なる: ' + JSON.stringify(report))
      if (errors.length) throw new Error(errors.join('\n'))
      console.log('PASS ' + name + ': 線は人物のアイコン・名前を避け、ラベルは人物・他のラベルに重ならない')
    }
    await check(svg, '資料庫の関係図', 'relations')
    // 詳細欄の関係図(シーンを選んだときの関係図タブ)も同じ直角の線(2026-10-15)
    await click('構造')
    for (let i = 0; i < 60; i++) { if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('検証シーン'))`)) break; await pause(100) }
    await js(`[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes('検証シーン')).dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
    await pause(300)
    await click('関係図')
    const detailSvg = `document.querySelector('.scene-detail-main svg')`
    for (let i = 0; i < 40; i++) { if (await js(`!!${detailSvg} && ${detailSvg}.querySelectorAll('polyline').length >= ${rels.length * 2}`)) break; await pause(150) }
    await pause(600)
    await check(detailSvg, '詳細欄の関係図', 'relations-detail')
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--optext')) {
    await click('会話一覧')
    await js(`[...document.querySelectorAll('aside button')].find(e=>e.getClientRects().length && e.textContent.includes('optext-chat')).click()`)
    await pause(400)
    const details = `[...document.querySelectorAll('details')].find(e => e.textContent.includes('本文を表示('))`
    await assert(`(() => { const d = ${details}; return !!d && !d.open && d.querySelector('summary').textContent.trim() === '本文を表示(18 字)' && document.body.textContent.includes('編集: 検証シーン') })()`, '確定したシーン編集の項目に、確定した本文の折りたたみ(閉じた状態)が出る')
    await js(`${details}.querySelector('summary').click()`)
    await pause(200)
    await assert(`(() => { const d = ${details}; return d.open && d.textContent.includes('確定した本文です。二行目もあります。') })()`, '開くと確定した本文が読める')
    writeFileSync(join(target, 'operation-text.png'), (await win.webContents.capturePage()).toPNG())
    // ↑ で前に送った依頼文を呼び出し、↓ で空に戻る。打ちかけがあるときの ↑ は置き換えない
    const area = `document.querySelector('textarea[aria-label="制作への依頼"]')`
    const key = (k) => js(`(() => { const el = ${area}; el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })) })()`)
    await key('ArrowUp'); await pause(100)
    await assert(`${area}.value === '本文を直して'`, '入力欄が空のとき ↑ で前に送った依頼文が入る')
    await key('ArrowUp'); await pause(100)
    await assert(`${area}.value === '本文を直して'`, 'いちばん古いものより前には行かない')
    await key('ArrowDown'); await pause(100)
    await assert(`${area}.value === ''`, '↓ で空に戻る')
    await input('textarea[aria-label="制作への依頼"]', '打ちかけ')
    await key('ArrowUp'); await pause(100)
    await assert(`${area}.value === '打ちかけ'`, '打ちかけがあるときの ↑ は置き換えない')
    if (errors.length) throw new Error(errors.join(String.fromCharCode(10)))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--composer')) {
    // 制作チャットの空の状態: 使い方の説明は会話欄の中に出し、入力の箱の上には説明文を常設しない
    await pause(400)
    await assert(`(() => {const list=document.querySelector('[aria-live="polite"]');const box=document.querySelector('.chat-composer');const help=[...list.querySelectorAll('p')].find(e=>e.textContent.includes('相談するだけでは作品を変更しません'));const between=[...box.parentElement.children].filter(e=>e!==box && e.getBoundingClientRect().top>=list.getBoundingClientRect().bottom-1 && e.getClientRects().length);return !!help && getComputedStyle(help).textAlign==='center' && between.every(e=>!e.textContent.includes('参照できます')) && between.length===0})()`, '使い方の説明は空の会話欄の中に出し、入力の箱の上には何も常設しない')
    await assert(`(() => {const area=document.querySelector('.chat-composer textarea');return getComputedStyle(area,'::placeholder').color==='rgb(92, 96, 120)' && area.placeholder.includes('方針の相談')})()`, '入力欄のプレースホルダは控えめな色(--text-faint)')
    await assert(`(() => {const box=document.querySelector('.chat-composer').getBoundingClientRect();const panel=document.querySelector('.chat-composer').parentElement.getBoundingClientRect();return Math.round(panel.bottom-box.bottom)===16})()`, '入力の箱とチャット欄の下端の間は16px')
    // 作品全体の画面で何も選んでいない: 候補に「作品全体をレビュー」が出る(シーン・章のレビューは出ない)
    await assert(`(() => {const labels=[...document.querySelectorAll('[aria-label="制作の依頼候補"] button')].map(e=>e.textContent.trim());return labels.includes('作品全体をレビュー') && !labels.some(t=>t.startsWith('章「')||t.startsWith('選択中'))})()`, '何も選んでいないときは「作品全体をレビュー」の候補を出す')
    writeFileSync(join(target, 'composer-empty.png'), (await win.webContents.capturePage()).toPNG())
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--embedding')) {
    // 設定の Embedding のページ: 起動時に読み込むかのオン・オフ(既定オン)と、いまの状態
    await js(`document.querySelector('button[aria-label="設定"]').click()`)
    await pause(400)
    await click('Embedding')
    await pause(500)
    const pressed = `[...document.querySelectorAll('button[aria-pressed]')].filter(e=>['オン','オフ'].includes(e.textContent.trim())).map(e=>e.textContent.trim()+':'+e.getAttribute('aria-pressed')).join('|')`
    await assert(`document.body.textContent.includes('起動時に Embedding を読み込む') && ${pressed}==='オン:true|オフ:false'`, '起動時に Embedding を読み込む設定があり、既定はオン')
    await assert(`(() => {const s=[...document.querySelectorAll('[role="status"]')].find(e=>e.textContent.includes('読み込'));return !!s && s.textContent.includes('まだ読み込んでいません') && document.body.textContent.includes('cl-nagoya/ruri-v3-310m') && document.body.textContent.includes('この PC に保存します')})()`, 'いまの状態(未読み込み)とモデル名、保存先を表示する。開いただけでは読み込まない')
    writeFileSync(join(target, 'settings-embedding.png'), (await win.webContents.capturePage()).toPNG())
    await js(`[...document.querySelectorAll('button[aria-pressed]')].find(e=>e.textContent.trim()==='オフ').click()`)
    await pause(500)
    const stored = (await (await fetch(base + '/settings')).json()).embedding_load_on_startup
    if (stored !== '0') errors.push('Embedding の設定が保存されていない: ' + JSON.stringify(stored))
    else console.log('PASS オフにすると設定が保存される')
    await assert(`${pressed}==='オン:false|オフ:true'`, 'オフに切り替えた表示になる')
    // 記憶の検索のページ(作品ごと): 古い記憶の点数を下げる速さをプルダウンで選ぶ。既定は 100 シーンで半分
    await click('記憶の検索')
    await pause(400)
    const half = `document.querySelector('select[aria-label="古い記憶の点数を下げる速さ"]')`
    await assert(`${half}.value==='100' && [...${half}.options].map(o=>o.value).join('|')==='0|20|50|100|200' && document.body.textContent.includes('今開いているライブラリ(作品)に保存します')`, '記憶の検索のページに半減期のプルダウンがあり、既定は100。保存先は作品')
    writeFileSync(join(target, 'settings-memory.png'), (await win.webContents.capturePage()).toPNG())
    await js(`(() => {const s=${half};Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'200');s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await pause(500)
    const halfLife = (await (await fetch(base + '/settings')).json()).memory_half_life
    if (halfLife !== '200') errors.push('半減期の設定が保存されていない: ' + JSON.stringify(halfLife))
    else console.log('PASS 半減期を選ぶと設定が保存される')
    await assert(`${half}.value==='200'`, '選んだ半減期が表示に残る')
    const state = (await (await fetch(base + '/embedding/status')).json()).state
    if (state !== 'idle') errors.push('検証用のバックエンドで Embedding を読み込んでしまった: ' + state)
    else console.log('PASS バックエンド単体の起動では Embedding を読み込まない')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Screenshots: ' + target)
    win.destroy()
    return
  }
  if (process.argv.includes('--imagegen')) {
    // 設定の画像生成のページ: 既定のワークフローを選ぶ(モデル名・steps などは組が持つので選ばない)
    await js(`document.querySelector('button[aria-label="設定"]').click()`)
    await pause(400)
    await click('画像生成')
    await pause(1500)
    const wf = `document.querySelector('select[aria-label="既定のワークフロー"]')`
    const models = `[...document.querySelectorAll('[aria-label="このワークフローが使うモデル"] li')].map(e=>e.textContent)`
    await assert(`${wf}.value==='default' && [...${wf}.options].some(o=>o.textContent.startsWith('Krea2 Turbo')) && ${models}.some(t=>t.startsWith('checkpoints'))`, '既定のワークフローの選択があり、未設定なら先頭の組。選んだ組が使うモデルが出る')
    await assert(`!document.body.textContent.includes('ステップ数') && !document.body.textContent.includes('チェックポイント(') && document.body.textContent.includes('ネガティブプロンプト')`, 'チェックポイント・ステップ数などの欄は無く、ネガティブプロンプトは残る')
    await js(`(() => {const s=${wf};Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'krea2');s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await pause(500)
    const chosen = (await (await fetch(base + '/settings')).json()).comfy_workflow
    if (chosen !== 'krea2') errors.push('既定のワークフローが保存されていない: ' + JSON.stringify(chosen))
    else console.log('PASS 既定のワークフローを選ぶと設定が保存される')
    await assert(`${wf}.value==='krea2' && ${models}.some(t=>t.startsWith('diffusion_models')) && ${models}.some(t=>t.startsWith('text_encoders'))`, '選び直すと、その組が使うモデル(diffusion_models / text_encoders …)に変わる')
    const listed = (await (await fetch(base + '/comfy/workflows')).json()).default
    if (listed !== 'krea2') errors.push('生成ウインドウ向けの既定の組が変わっていない: ' + JSON.stringify(listed))
    else console.log('PASS 生成ウインドウ向けの一覧でも既定の組が変わる')
    writeFileSync(join(target, 'settings-imagegen.png'), (await win.webContents.capturePage()).toPNG())
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
      await assert(`(() => {const input=document.querySelector('textarea[aria-label="制作への依頼"]');const panel=document.querySelector('[aria-label="チャットの幅"]').parentElement.getBoundingClientRect();const root=input.closest('.chat-composer').parentElement.parentElement;const box=input.closest('.chat-composer');const send=box.querySelector('button[aria-label="送信"]').getBoundingClientRect();return root.getBoundingClientRect().right<=panel.right+1 && root.scrollWidth<=root.clientWidth+1 && send.right<=box.getBoundingClientRect().right && send.bottom<=box.getBoundingClientRect().bottom;})()`, width + 'pxで制作チャットが右端に収まり、送信ボタンは入力の箱の中に残る')
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
        if (label === '清書') {
          // 左の列に上から プリセット / POV / 分量 / 清書ボタン、右に本文(2026-10-15 ユーザー指定)
          await assert(`(() => {const meta=document.querySelector('.scene-detail-meta'),main=document.querySelector('.scene-detail-main');const [preset,pov,length]=[...meta.querySelectorAll('select')];const run=[...meta.querySelectorAll('button')].find(e=>e.textContent.includes('清書'));const y=(e)=>e.getBoundingClientRect().top;return main.getBoundingClientRect().left>=meta.getBoundingClientRect().right-1 && y(preset)<y(pov) && y(pov)<y(length) && y(length)<y(run) && pov.textContent.includes('POV') && length.value!=='custom' && length.textContent.includes('分量')})()`, '清書は左にプリセット・POV・分量・ボタンを縦に並べ、右に本文')
          // 右の列は鑑賞モードの「挿絵分割」と同じ: 上にタイトル、下に左が挿絵・右が本文(鑑賞モードの本文フォント・大きさ、行間 1.9)。
          // LLM を使わずに清書を 1 件入れ、挿絵(アプリのアイコン)も付けて確かめる
          const nodeId = (await (await fetch(base + '/graph')).json()).nodes.find((n) => n.title === '検証シーン').id
          const presetId = await js(`document.querySelector('.scene-detail-meta select').value`)
          const prose = '港の朝は、まだ霧の底に沈んでいた。アヤは桟橋の端に立ち、遠くで鳴る汽笛の数を数えた。三つ目が途切れたところで、彼女はようやく息を吐いた。\n\n'.repeat(4)
          const seeded = spawnSync(join(root, '.venv/Scripts/python.exe'), ['-c', 'import sys, shutil, os, db; from store import Store; s = Store(db.connect(sys.argv[1]), root=sys.argv[2]); s.save_render(sys.argv[3], sys.argv[4], None, sys.argv[5]); shutil.copy(sys.argv[6], os.path.join(s.assets_dir(), "test-art.png")); s.set_node_image(sys.argv[3], "test-art.png"); s.conn.commit()', join(target, 'story-graph.db'), target, nodeId, presetId, prose, join(root, 'resources/icon.png')], { cwd: join(root, 'backend'), encoding: 'utf8' })
          if (seeded.status !== 0) throw new Error(seeded.stderr)
          await new Promise((done) => { win.webContents.once('did-finish-load', () => done()); win.webContents.reload() })
          for (let i = 0; i < 60; i++) { if (await js(`[...document.querySelectorAll('.react-flow__node')].some(e=>e.textContent.includes('検証シーン'))`)) break; await pause(100) }
          await js(`(() => {const node=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes('検証シーン')); node.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`)
          await pause(300)
          await click('清書')
          await pause(600)
          await assert(`(() => {const main=document.querySelector('.scene-detail-main'),meta=document.querySelector('.scene-detail-meta');const h=main.querySelector('h2'),split=main.querySelector('.render-split');if(!h||!split)return false;const art=split.querySelector('img'),p=[...split.querySelectorAll('.whitespace-pre-wrap')].find(e=>e.textContent.includes('港の朝'));if(!art||!p)return false;const s=getComputedStyle(p);return h.textContent==='検証シーン' && getComputedStyle(h).fontFamily===s.fontFamily && h.getBoundingClientRect().bottom<=split.getBoundingClientRect().top && art.getBoundingClientRect().right<=p.getBoundingClientRect().left && !meta.querySelector('img,video') && s.fontFamily.includes('Inter') && s.fontSize==='14px' && Math.abs(parseFloat(s.lineHeight)-26.6)<0.6})()`, '清書は右の列の上にタイトル、下に左が挿絵・右が本文(フォント・大きさは最初は鑑賞モードと同じ)。左の列に挿絵は無い')
          // タイトルと挿絵は動かさず、本文だけがスクロールする(2026-10-15 ユーザー要望)
          const artBefore = await js(`(() => {const main=document.querySelector('.scene-detail-main');return [main.querySelector('h2').getBoundingClientRect().top, main.querySelector('.render-split img').getBoundingClientRect().top]})()`)
          await js(`(() => {const prose=document.querySelector('.render-prose');prose.scrollTop=99999;document.querySelector('.scene-detail-main').scrollTop=99999})()`)
          await pause(300)
          await assert(`(() => {const main=document.querySelector('.scene-detail-main'),prose=main.querySelector('.render-prose'),art=main.querySelector('.render-split img');const before=${JSON.stringify(artBefore)};return prose.scrollTop>50 && main.scrollTop===0 && Math.abs(main.querySelector('h2').getBoundingClientRect().top-before[0])<1 && Math.abs(art.getBoundingClientRect().top-before[1])<1 && art.getBoundingClientRect().bottom<=main.getBoundingClientRect().bottom+1})()`, '清書の本文をスクロールしても、タイトルと挿絵は動かない(挿絵は列に収まる)')
          // 左の列の「表示」で、この画面だけの本文フォント・大きさを選べる(鑑賞モードの設定は変わらない)
          const readerBefore = await (await fetch(base + '/settings')).json()
          await js(`(() => {const section=document.querySelector('.scene-detail-meta section[aria-label="清書タブの表示"]');const [font,size]=section.querySelectorAll('select');const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('change',{bubbles:true}))};set(font,'mincho');set(size,'18')})()`)
          await pause(400)
          const readerAfter = await (await fetch(base + '/settings')).json()
          await assert(`(() => {const p=document.querySelector('.render-prose .whitespace-pre-wrap'),h=document.querySelector('.scene-detail-main h2');const s=getComputedStyle(p);return s.fontFamily.includes('Shippori Mincho') && s.fontSize==='18px' && getComputedStyle(h).fontFamily===s.fontFamily})()` + ` && ${JSON.stringify(readerAfter.render_tab_font === 'mincho' && readerAfter.render_tab_font_size === '18' && readerAfter.reader_font === readerBefore.reader_font && readerAfter.reader_font_size === readerBefore.reader_font_size)}`, '清書の「表示」でフォントと大きさを変えると本文とタイトルに効き、鑑賞モードの設定は変わらない')
        }
        if (label === 'キャラ') {
          await assert(`(() => {const list=document.querySelector('.char-detail-list');const row=list.querySelector('button');const l=list.getBoundingClientRect(),d=document.querySelector('.char-detail .scene-detail').getBoundingClientRect();return row.lastElementChild.textContent.trim()==='検証キャラ' && row.getAttribute('aria-pressed')==='true' && row.children.length===2 && Math.round(l.width)===188 && d.x>=l.right-1 && Math.abs(l.y-d.y)<1})()`, 'キャラは左に登場人物の一覧(アイコンと名前)、右に状態')
        }
        if (label === '関係図') {
          await assert(`document.querySelector('.scene-detail-main svg').querySelectorAll('g[transform]').length===2`, '関係図に登場人物を表示')
          // 好意の矢印は水色(--rel-positive)。成功の緑やエラーの赤を借りない
          await assert(`(() => {const line=[...document.querySelectorAll('.scene-detail-main svg polyline')].find(e=>e.getAttribute('stroke')!=='transparent');const head=line.parentElement.querySelector('polygon');return getComputedStyle(line).stroke==='rgb(77, 179, 247)' && getComputedStyle(head).fill==='rgb(77, 179, 247)'})()`, '関係図の好意の矢印は水色')
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
        if (label === '清書') await assert(`(() => {const art=document.querySelector('.render-split img'),p=document.querySelector('.render-prose'),meta=document.querySelector('.scene-detail-meta');return art.getBoundingClientRect().bottom<=p.getBoundingClientRect().top+1 && p.getBoundingClientRect().bottom<=meta.getBoundingClientRect().top+1 && art.getBoundingClientRect().height<=321})()`, '清書は狭幅で挿絵・本文・設定が重ならずに縦に並ぶ')
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
      // 時間後: 同じ日と日後の間にあり、数を持つ
      await assert(`[...document.querySelector('select[aria-label="前のシーンからの経過"]').options].map(o=>o.value).join('|')==='|immediate|same_day|hour|day|week|month|year'`, '経過の選択肢は 未設定 / 直後 / 同じ日 / 時間後 / 日後 / 週間後 / か月後 / 年後')
      await pick('hour')
      await pause(150)
      await js(`(() => {const i=document.querySelector('input[aria-label="経過の数"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'5');i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await pause(150)
      await js(`[...document.querySelectorAll('.scene-detail button')].find(e=>e.textContent.trim()==='保存').click()`)
      await pause(500)
      const hourNode = await saved()
      if (!(hourNode.elapsed_unit === 'hour' && hourNode.elapsed_count === 5)) errors.push('経過(5時間後)が保存されていない: ' + JSON.stringify([hourNode.elapsed_unit, hourNode.elapsed_count]))
      else console.log('PASS 経過(5時間後)を保存できる')
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
  // 入力欄の枠は、入力欄と下の操作の行をまとめた箱が持つ
  const INPUT_BORDER = `getComputedStyle(document.querySelector('.chat-composer')).borderColor`
  await assert(`(() => {const box=document.querySelector('.chat-composer');const area=box.querySelector('textarea[aria-label="制作への依頼"]');const b=box.getBoundingClientRect(),a=area.getBoundingClientRect();const inside=(e)=>{const r=e.getBoundingClientRect();return r.left>=b.left && r.right<=b.right && r.top>=a.bottom-1 && r.bottom<=b.bottom};const picked=[...box.querySelectorAll('span')].find(e=>e.textContent.trim().startsWith('選択中:'));return getComputedStyle(area).borderTopWidth==='0px' && !!picked && inside(picked) && inside(box.querySelector('[aria-label="制作チャットの送信モード"]')) && inside(box.querySelector('button[aria-label="送信"]')) && picked.getBoundingClientRect().right<=box.querySelector('[aria-label="制作チャットの送信モード"]').getBoundingClientRect().left && !document.body.textContent.includes('Enterで送信')})()`, '入力欄と下の行は1つの箱で、下の行の左に選択中、右に送信モードと送信。Enter の案内文は無い')
  await assert(`${SEND}.classList.contains('accent-action') && !!${SEND}.querySelector('svg') && ${SEND}.textContent.trim()==='' && !${INPUT_BORDER}.includes('221, 136, 181') && !document.body.textContent.includes('「制作を実行」を選択中')`, '相談のときの送信は紫の↑ボタンで、入力欄の枠は通常の色')
  await assert(`(() => {const visible=(q)=>[...document.querySelectorAll(q)].find(e=>e.getClientRects().length);const list=visible('button[aria-label="会話一覧"]'),add=visible('button[aria-label="新しい会話"]');const row=list.parentElement;const title=row.querySelector('span');const r=(e)=>e.getBoundingClientRect();const rr=row.getBoundingClientRect();return !!list.querySelector('svg') && !!add.querySelector('svg') && list.textContent.trim()==='' && title.textContent==='新しい会話' && Math.abs(r(title).x-rr.x-24)<1 && r(list).x>=r(title).right-1 && r(add).x>=r(list).right && Math.abs(rr.right-r(add).right-24)<1})()`, '会話名は左端、会話一覧と新しい会話のアイコンは右端に並ぶ')
  // 画面の右端にある部品のツールチップが、細く縦長にならないこと。
  await js(`(() => {const r=${SEND}.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))})()`)
  for (let i = 0; i < 30; i++) { if (await js(`!!document.querySelector('[role="tooltip"]') && getComputedStyle(document.querySelector('[role="tooltip"]')).opacity!=='0'`)) break; await pause(100) }
  const tip = await js(`(() => {const t=document.querySelector('[role="tooltip"]');if(!t) return null;const r=t.getBoundingClientRect();return {width:r.width,height:r.height,right:r.right,text:t.textContent,inner:window.innerWidth}})()`)
  if (!(tip && tip.text.includes('相談として送信') && tip.text.includes('Enter で送信') && tip.width >= 200 && tip.height <= 64 && tip.right <= tip.inner - 7)) errors.push('右端のツールチップが縦長になっている: ' + JSON.stringify(tip))
  else console.log('PASS 画面の右端にある部品のツールチップも横長のまま画面内に収まる')
  await js(`document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
  for (let i = 0; i < 40; i++) { if (await js(`[...document.querySelectorAll('[role="img"] svg')].some(e=>e.getClientRects().length)`)) break; await pause(100) }
  await assert(`(() => {const h=(e)=>Math.round(e.getBoundingClientRect().height);const group=document.querySelector('[aria-label="制作チャットの送信モード"]');const ring=[...document.querySelectorAll('[role="img"] svg')].find(e=>e.getClientRects().length);const send=${SEND};const cy=(e)=>{const r=e.getBoundingClientRect();return r.y+r.height/2};return h(group)===26 && h(ring)===26 && h(send)===26 && Math.abs(cy(group)-cy(ring))<1 && Math.abs(cy(group)-cy(send))<1})()`, '送信モードの切り替え・使用量リング・送信ボタンの高さと位置が揃う')
  await assert(`(() => {const list=document.querySelector('[aria-live="polite"]');const area=document.querySelector('.chat-composer').getBoundingClientRect();const l=list.getBoundingClientRect();const cs=getComputedStyle(list);return cs.scrollbarGutter==='stable' && Math.round(l.right-area.right)===24 && Math.round(l.right-10-parseFloat(cs.paddingRight)-area.right)===0})()`, '制作の発言欄はスクロールバーとの間を空け、発言の右端を入力欄と揃える')
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
  await assert(`(() => {const preview=document.querySelector('[aria-label="AI編集中の本文プレビュー"]'); const input=document.querySelector(${JSON.stringify(productionInput)}); const list=document.querySelector('[aria-live="polite"]'); return preview?.getClientRects().length && input.closest('.chat-composer').parentElement.contains(preview) && preview.textContent.includes('生成中の本文プレビュー') && list.contains(preview) && preview.classList.contains('timeline-item') && !!preview.querySelector('.timeline-dot.animate-pulse') && preview.textContent.includes('編集案を作成中(対象を確認中)') && !preview.nextElementSibling?.classList.contains('timeline-item');})()`, '資料庫でも制作チャットの時系列の末尾に、書いている途中の本文を出す')
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
  // 条件パネル(指示 / 作業メモ / 変更範囲)は「作業対象を追う」の行に開閉ボタンとして並ぶ
  const panelButton = (label) => `[...document.querySelectorAll('button[aria-expanded]')].find(e=>e.textContent.startsWith('${label}'))`
  const followButton = `[...document.querySelectorAll('button')].find(e=>e.textContent.includes('作業対象を追う'))`
  // 幅が狭いと折り返すので、同じ行の中(2行以内)に収まることを見る
  await assert(`(() => {const row=${followButton}.parentElement;return [${panelButton('指示')},${panelButton('作業メモ')},${panelButton('範囲: ')}].every(b=>!!b && b.parentElement===row && b.getAttribute('aria-expanded')==='false') && row.getBoundingClientRect().height<64})()`, '条件パネルの3つを作業対象を追うの行にボタンで並べ、既定は閉じて2行以内に収まる')
  await js(`${panelButton('指示')}.click()`)
  await pause(200)
  await js(`${panelButton('作業メモ')}.click()`)
  await pause(300)
  await assert(`${panelButton('作業メモ')}.getAttribute('aria-expanded')==='true' && ${panelButton('指示')}.getAttribute('aria-expanded')==='false' && !document.querySelector('textarea[aria-label="制作エージェントへの指示"]')`, '条件パネルは同時に1つだけ開く')
  const memoryToggle = `[...document.querySelectorAll('button')].find(e=>e.textContent.includes('作業メモを使う'))`
  await assert(`${memoryToggle}.getAttribute('aria-pressed')==='false' && ${panelButton('作業メモ')}.textContent.startsWith('作業メモ · オフ')`, '作業メモは既定でオフと表示')
  await js(`${memoryToggle}.click()`)
  await pause(500)
  await assert(`${memoryToggle}.getAttribute('aria-pressed')==='true' && !${panelButton('作業メモ')}.textContent.includes('オフ')`, '作業メモをオンに切り替えて表示へ反映')
  await js(`${panelButton('作業メモ')}.click()`)
  await pause(200)
  if ((await (await fetch(base + '/settings')).json()).production_memory_enabled !== '1') errors.push('作業メモの設定が保存されていない')
  await js(`document.querySelector('button[aria-label="設定"]').click()`)
  await pause(400)
  await assert(`(() => {const items=[...document.querySelectorAll('aside button')].map(e=>e.textContent.trim());const i=items.indexOf('シーン生成');return [...document.querySelectorAll('aside div')].some(e=>e.textContent==='システムプロンプト') && i>0 && items.slice(i,i+6).join('|')==='シーン生成|清書(スタイルプリセット)|校正|制作エージェントへの指示|画像生成プロンプト|書き出し / 読み込み'})()`, '設定の左一覧でシステムプロンプトの6項目をまとめて表示')
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
  // 指示の入力欄はパネルを開いたときだけ描く(閉じていても下書きは保持している)
  await js(`${panelButton('指示')}.click()`)
  await pause(200)
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
