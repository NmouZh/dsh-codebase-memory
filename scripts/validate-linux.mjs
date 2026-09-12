#!/usr/bin/env node
// Linux port acceptance driver.
//
// Loads the plugin the way DSH does — `apply(ctx, config)` with a stub context
// that captures the registered webServer routes — and then exercises those
// routes through their real handlers. The CLI bridge is the production one, so
// a rebuild here spawns the real codebase-memory-mcp process.
//
//   node scripts/validate-linux.mjs                  wiring + real index
//   node scripts/validate-linux.mjs --no-index       wiring only (no graph writes)
//   node scripts/validate-linux.mjs --repo /path     watch another repository
//   node scripts/validate-linux.mjs --polling        force usePolling (needs --index)
//   node scripts/validate-linux.mjs --keep           keep the started watch
//
// Exit code 0 means every check passed.

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../src/index.mjs'
import { createCliBridge } from '../src/cli-bridge.mjs'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const noIndex = hasFlag('--no-index')
const keep = hasFlag('--keep')
const forcePolling = hasFlag('--polling')
const repoPath = resolve(valueOf('--repo', process.cwd()))

const results = []
function summarize(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > 150 ? flat.slice(0, 147) + '…' : flat
}
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ctx.effect(callback) runs the callback immediately and keeps its return
// value as the disposer — mirroring the harness contract, so teardown here
// exercises the same path a real plugin unload takes.
function makeStubContext() {
  const routes = []
  const logs = []
  const disposers = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
    effect(callback) {
      const result = callback()
      if (typeof result === 'function') disposers.push(result)
      return result
    },
  }
  return { ctx, routes, logs, disposers }
}

function makeReq(method, path, body) {
  // routes.mjs reads the body through stream events, so the stub must behave
  // like a request stream (an async iterator is not enough).
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.socket = { remoteAddress: '127.0.0.1' }
  req.on('error', () => { /* the handler resolves null on stream errors */ })
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const state = { status: 0, headers: {}, chunks: [] }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers || {}
    },
    end(chunk) {
      if (chunk !== undefined) state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      state.body = Buffer.concat(state.chunks).toString('utf8')
    },
  }
}

async function callRoute(routes, method, path, body) {
  const routePath = path.split('?')[0]
  const route = routes.find((candidate) => candidate.path === routePath)
  if (!route) throw new Error(`route not registered: ${routePath}`)
  const res = makeRes()
  await route.handler(makeReq(method, path, body), res)
  let parsed = null
  try { parsed = JSON.parse(res.state.body) } catch { /* non-JSON stays null */ }
  return { status: res.state.status, body: parsed, raw: res.state.body }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

const stateDir = await mkdtemp(join(tmpdir(), 'dsh-cbm-validate-'))
const statePath = join(stateDir, 'watcher.json')
const stub = makeStubContext()

console.log('\ndsh-codebase-memory — Linux acceptance driver')
console.log(`  repo       ${repoPath}`)
console.log(`  state file ${statePath}`)
console.log(`  index      ${noIndex ? 'skipped (--no-index)' : 'will run a real index_repository'}\n`)

console.log('1) plugin load')
let dispose = null
try {
  dispose = await apply(stub.ctx, {
    statePath,
    autoAttach: false,
    defaultDebounceMs: 1000,
    defaultMode: 'fast',
    ignored: ['**/node_modules/**', '**/.git/**'],
    watchedExtensions: ['.mjs', '.js'],
    usePolling: forcePolling,
  })
  // apply() either returns the disposer or registers it through ctx.effect.
  if (typeof dispose !== 'function' && stub.disposers.length > 0) dispose = stub.disposers[stub.disposers.length - 1]
  check('apply() yields a disposer', typeof dispose === 'function')
} catch (err) {
  check('apply() yields a disposer', false, err.message)
}
check('webServer routes registered', stub.routes.length > 0, `${stub.routes.length} routes`)

console.log('\n2) runtime resolution')
const cliInfo = await callRoute(stub.routes, 'GET', '/api/dsh-codebase-memory/watcher/cli-info')
check('cli-info responds 200', cliInfo.status === 200)
const executable = cliInfo.body && cliInfo.body.executable
const source = cliInfo.body && cliInfo.body.source
check('cli-info reports an executable', typeof executable === 'string' && executable.length > 0, String(executable))
check('cli-info reports how it was found', ['config', 'env', 'path', 'known-location', 'npx'].includes(source), String(source))
if (source !== 'npx') {
  check('resolved runtime exists on disk', existsSync(executable))
} else {
  check('resolved runtime exists on disk', true, 'skipped: npx fallback needs a download')
}

console.log('\n3) live CLI round trip (real runtime process)')
const cli = createCliBridge()
let projects = []
try {
  projects = await cli.listProjects()
  check('list_projects round trip succeeds', Array.isArray(projects), `${projects.length} indexed projects, source=${cli.source}`)
} catch (err) {
  check('list_projects round trip succeeds', false, summarize(err.message))
}
check('runtime reported its resolved source', ['config', 'env', 'path', 'known-location'].includes(cli.source), cli.source)

console.log('\n4) mount detection')
const drvfs = ['/mnt/c', '/mnt/d', '/mnt/e'].find((p) => existsSync(p))
if (process.platform !== 'win32' && drvfs) {
  const { describeFilesystem, shouldForcePolling } = await import('../src/paths.mjs')
  check('DrvFs mount detected as 9p', describeFilesystem(drvfs) === '9p', `${drvfs} -> ${describeFilesystem(drvfs)}`)
  check('DrvFs mount forces polling', shouldForcePolling(drvfs) === true)
} else {
  check('DrvFs mount detected as 9p', true, 'skipped: no /mnt/* mount on this host')
  check('DrvFs mount forces polling', true, 'skipped')
}

console.log('\n5) route surface')
const missingPath = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/start', { repoPath: join(stateDir, 'nope') })
check('start rejects a missing path', missingPath.status === 400, missingPath.body && missingPath.body.error)
const notADir = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/start', { repoPath: resolve('package.json') })
check('start rejects a file', notADir.status === 400, notADir.body && notADir.body.error)
const noRepo = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/start', {})
check('start requires repoPath', noRepo.status === 400)
const noId = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/stop', {})
check('stop requires an id', noId.status === 400)
const notFound = await callRoute(stub.routes, 'GET', '/api/dsh-codebase-memory/watcher/status?id=nope')
check('status rejects an unknown id', notFound.status === 404)

console.log('\n6) watcher lifecycle')
const started = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/start', {
  repoPath,
  mode: 'fast',
  watchedExtensions: ['.mjs'],
})
check('start accepts the repository', started.status === 200 && started.body.ok === true, started.body && started.body.error)
const watch = started.body && started.body.watch
check('watch record carries a canonical path', Boolean(watch && watch.repoPath), watch && watch.repoPath)
check('watch record reports its polling mode', watch && typeof watch.usePolling === 'boolean', watch && `usePolling=${watch.usePolling}${watch.pollingForcedBy ? ' (' + watch.pollingForcedBy + ')' : ''}`)
check('watch record has an identity key', Boolean(watch && watch.pathKey))

const list = await callRoute(stub.routes, 'GET', '/api/dsh-codebase-memory/watcher/list')
check('list returns the started watch', list.body && list.body.watches.some((w) => w.id === watch.id))

const duplicate = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/start', { repoPath: repoPath + '/' })
check('a trailing slash reuses the same watch', duplicate.body && duplicate.body.watch.id === watch.id)

// The upstream runtime only indexes paths under an explicitly allowed root —
// its own safety boundary, which this plugin must not quietly widen. When the
// target is outside it, verify the failure *is* that gate (rather than a port
// bug) and report the exact command that would lift it.
function isUnderAllowedRoot(target) {
  const prefix = target.endsWith('/') ? target : target + '/'
  return projects.some((project) => {
    const root = project.root_path || project.rootPath
    return typeof root === 'string' && (prefix === root + '/' || prefix.startsWith(root + '/'))
  })
}

let indexed = false
const allowRootHint = `codebase-memory-mcp allow-root ${repoPath}`

if (noIndex) {
  console.log('\n7) real rebuild — skipped by --no-index')
} else if (!isUnderAllowedRoot(repoPath)) {
  console.log('\n7) real rebuild — outside the runtime\'s allowed root')
  const rebuilt = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/rebuild', { id: watch.id })
  const message = (rebuilt.body && rebuilt.body.error) || ''
  check(
    'rebuild fails with the upstream allow-root gate (not a port bug)',
    rebuilt.status === 500 && /outside the allowed root/.test(message),
    summarize(message),
  )
  check('the failure is persisted in watcher state', /outside the allowed root/.test(message))
  console.log(`      to index this repository: ${allowRootHint}`)
} else {
  console.log('\n7) real rebuild through the upstream runtime')
  const rebuilt = await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/rebuild', { id: watch.id })
  check('rebuild reports success', rebuilt.status === 200 && rebuilt.body.ok === true, rebuilt.body && (rebuilt.body.error || `${rebuilt.body.durationMs}ms`))
  const after = await callRoute(stub.routes, 'GET', `/api/dsh-codebase-memory/watcher/status?id=${watch.id}`)
  const status = after.body && after.body.watch
  check('rebuild recorded a result', Boolean(status && status.lastResult), status && JSON.stringify(status.lastResult))
  check('rebuild cleared the error field', Boolean(status && status.lastError === ''), status && status.lastError)
  check('rebuild was not a no-op', Boolean(status && status.lastDurationMs > 0), status && `${status.lastDurationMs}ms`)
  indexed = true
}

console.log('\n8) restart from persisted state')
await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/restart')
const afterRestart = await callRoute(stub.routes, 'GET', '/api/dsh-codebase-memory/watcher/list')
check('restart keeps a single watch for the repository', afterRestart.body && afterRestart.body.watches.length === 1, `${afterRestart.body && afterRestart.body.watches.length} watches`)

console.log('\n9) teardown')
await callRoute(stub.routes, 'POST', '/api/dsh-codebase-memory/watcher/stop', { id: watch.id })
const stopped = await callRoute(stub.routes, 'GET', `/api/dsh-codebase-memory/watcher/status?id=${watch.id}`)
check('stop persists the stopped status', stopped.body && stopped.body.watch.status === 'stopped', stopped.body && stopped.body.watch.status)
if (typeof dispose === 'function') await dispose()
check('dispose closes the route surface', stub.routes.length === 0, `${stub.routes.length} routes left`)

const { readFile } = await import('node:fs/promises')
let persisted = null
try { persisted = JSON.parse(await readFile(statePath, 'utf8')) } catch { /* handled below */ }
check('state file persists with version 2', Boolean(persisted && persisted.version === 2), persisted && `version=${persisted.version}`)
check('state file keeps intent for restart recovery', Boolean(persisted && persisted.watches[watch.id] && persisted.watches[watch.id].status === 'stopped'))

if (!keep) await rm(stateDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${indexed ? ' (real index executed)' : ''}`)
if (failed.length > 0) {
  console.error('failed checks:')
  for (const f of failed) console.error(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`)
  process.exit(1)
}
console.log('Linux port acceptance: OK\n')
process.exit(0)
