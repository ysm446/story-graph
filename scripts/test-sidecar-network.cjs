// 実際の TCP / HTTP サーバーで、ポート競合と別アプリの誤認を回帰確認する。
// 実行: node --test scripts/test-sidecar-network.cjs
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { Module } = require('node:module')
const { test } = require('node:test')
const ts = require('typescript')

const sourcePath = resolve(__dirname, '../src/main/sidecarNetwork.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const networkModule = new Module(sourcePath, module)
networkModule._compile(compiled, sourcePath)
const { findAvailablePort, isPortInUse, isStoryGraphHealthy } = networkModule.exports

async function listen(t, handler, host = '127.0.0.1') {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, host, ipv6Only: host === '::1' }, resolve)
  })
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  const port = server.address().port
  return { port, url: `http://127.0.0.1:${port}` }
}

for (const host of ['127.0.0.1', '::1']) {
  test(`使用中の ${host} のポートを避ける`, async (t) => {
    const { port } = await listen(t, (_req, res) => res.end('other app'), host)
    assert.equal(await isPortInUse(port, host), true)
    assert.ok(await findAvailablePort(port) > port)
    await assert.rejects(findAvailablePort(port, 1), /空きポート/)
  })
}

test('HTTP 200 の HTML と別アプリの JSON は再利用しない', async (t) => {
  for (const body of ['<html>other app</html>', '{"status":"ok"}', '{"status":"ok","service":"other"}']) {
    const { url } = await listen(t, (_req, res) => res.end(body))
    assert.equal(await isStoryGraphHealthy(url), false)
  }
})

test('story-graph のヘルス応答を受け入れる', async (t) => {
  const { url } = await listen(t, (_req, res) => res.end('{"status":"ok","service":"story-graph"}'))
  assert.equal(await isStoryGraphHealthy(url), true)
})

test('更新前のバックエンドは API 定義を確認して再利用する', async (t) => {
  const { url } = await listen(t, (req, res) => {
    res.end(JSON.stringify(req.url === '/health'
      ? { status: 'ok' }
      : { info: { title: 'story-graph backend' } }))
  })
  assert.equal(await isStoryGraphHealthy(url), true)
})

test('応答本文が終わらなくてもタイムアウトする', async (t) => {
  const { url } = await listen(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{')
  })
  assert.equal(await isStoryGraphHealthy(url, 100), false)
})
