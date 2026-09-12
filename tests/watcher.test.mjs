import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateStore } from '../src/state.mjs'
import { createWatcherService } from '../src/watcher.mjs'
import { createCliBridge, resolveExecutable } from '../src/cli-bridge.mjs'
import { buildIgnoreMatcher, canonicalRepoPath, describeFilesystem, hasWatchedExtension, normalizeExtensions, sameRepoPath, shouldForcePolling } from '../src/paths.mjs'

const IS_WINDOWS = process.platform === 'win32'

const waitFor = async (predicate, timeoutMs = 3000) => {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function makeTmpDir(prefix) {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function fixture(indexRepository = async () => ({ status: 'indexed', nodes: 1, edges: 1 })) {
  const dir = await makeTmpDir('dsh-cbm-watcher-')
  await writeFile(join(dir, 'entry.js'), 'export const value = 1\n')
  const state = createStateStore(join(dir, 'watcher.json'))
  const cli = { indexRepository }
  const service = createWatcherService({
    state,
    cli,
    defaults: { debounceMs: 20, mode: 'fast', ignored: [], watchedExtensions: ['.js'], usePolling: false },
    log: null,
  })
  return { dir, state, service }
}

test('repo path identity is case-sensitive on POSIX and case-insensitive on Windows', async () => {
  const dir = await makeTmpDir('dsh-cbm-paths-')
  const upper = join(dir, 'Repo')
  const lower = join(dir, 'repo')
  await mkdir(upper)
  await mkdir(lower)

  assert.equal(sameRepoPath(upper, upper), true)
  // A trailing separator must not create a second identity.
  assert.equal(sameRepoPath(upper, upper + '/'), true)
  // Two directories that differ only by case are distinct repositories on
  // Linux; merging them would silently drop a real watch.
  assert.equal(sameRepoPath(upper, lower), IS_WINDOWS)
})

test('canonicalRepoPath resolves symlinks, tolerates missing paths, rejects empty input', async () => {
  const dir = await makeTmpDir('dsh-cbm-canon-')
  assert.equal(canonicalRepoPath(''), null)
  assert.equal(canonicalRepoPath(null), null)
  assert.equal(canonicalRepoPath('   '), null)

  // Nonexistent paths still canonicalize lexically, so an unmounted repo can
  // be recorded, and two spellings of the same path agree.
  const ghost = join(dir, 'not-created', 'repo')
  assert.equal(canonicalRepoPath(ghost), ghost)
  assert.equal(canonicalRepoPath(join(dir, 'not-created', 'other', '..', 'repo')), ghost)

  const real = join(await makeTmpDir('dsh-cbm-real-'), 'target')
  await mkdir(real)
  const link = join(dir, 'link-to-target')
  try {
    const { symlink } = await import('node:fs/promises')
    await symlink(real, link, 'dir')
    assert.equal(canonicalRepoPath(link), canonicalRepoPath(real))
  } catch {
    // Symlinks unavailable (Windows without privileges): nothing to assert.
  }
})

test('ignore matcher follows platform case rules and preserves nested-directory patterns', () => {
  const matcher = buildIgnoreMatcher(['**/node_modules/**', '**/.git/**', 'dist/**'])
  assert.equal(matcher('/srv/app/node_modules/pkg/index.js'), true)
  assert.equal(matcher('/srv/app/.git/HEAD'), true)
  assert.equal(matcher('/srv/app/src/index.js'), false)
  // Case folding is a Windows-only convenience; POSIX filesystems are
  // case-sensitive, so the pattern must not match a differently-cased dir.
  assert.equal(matcher('/srv/app/NODE_MODULES/pkg/index.js'), IS_WINDOWS)
})

test('extension filtering accepts both dotted and bare forms', () => {
  const exts = normalizeExtensions(['.ts', 'js', '.JSX', ''])
  assert.deepEqual([...exts].sort(), ['.js', '.jsx', '.ts'])
  assert.equal(hasWatchedExtension('/srv/app/main.ts', exts), true)
  assert.equal(hasWatchedExtension('/srv/app/README.md', exts), false)
  assert.equal(hasWatchedExtension('', exts), false)
})

test('filesystem detection flags WSL2 DrvFs mounts as needing polling', async () => {
  if (IS_WINDOWS) return // the API is POSIX-only
  const { existsSync } = await import('node:fs')
  const type = describeFilesystem(tmpdir())
  assert.ok(type !== null, 'tmpdir filesystem type should be readable')

  // /mnt/* is a DrvFs 9p mount whenever the harness runs inside WSL. When it
  // exists, polling must be forced there or change events get lost silently.
  const drvfs = ['/mnt/c', '/mnt/d'].find((p) => existsSync(p))
  if (drvfs) {
    assert.equal(describeFilesystem(drvfs), '9p')
    assert.equal(shouldForcePolling(drvfs), true)
  }
  // The Linux-native temp filesystem must never be forced into polling.
  assert.equal(shouldForcePolling(tmpdir()), false)
})

test('runtime resolution honours override order and reports its source', async () => {
  const dir = await makeTmpDir('dsh-cbm-resolve-')
  const fakeBin = join(dir, IS_WINDOWS ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp')
  await writeFile(fakeBin, '')
  await chmod(fakeBin, 0o755)

  const env = { PATH: dir }
  const onPath = resolveExecutable({ env })
  assert.equal(onPath.source, 'path')
  assert.equal(onPath.command, fakeBin)

  const explicit = resolveExecutable({ env, executable: '/opt/custom/cbm' })
  assert.equal(explicit.source, 'config')
  assert.equal(explicit.command, '/opt/custom/cbm')

  const fromEnv = resolveExecutable({ env: { ...env, CODEBASE_MEMORY_MCP_BIN: '/env/cbm' } })
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.command, '/env/cbm')

  // Config and environment disagreeing is a configuration bug, not a tie to
  // break silently.
  assert.throws(
    () => resolveExecutable({ env: { ...env, CODEBASE_MEMORY_MCP_BIN: '/env/cbm' }, executable: '/config/cbm' }),
    /conflicting runtime paths/,
  )
})

test('runtime resolution falls back to npx when the runtime is not installed', async () => {
  const sandbox = await makeTmpDir('dsh-cbm-npx-')
  const binDir = join(sandbox, 'bin')
  const home = join(sandbox, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const npxName = IS_WINDOWS ? 'npx.cmd' : 'npx'
  await writeFile(join(binDir, npxName), '')
  await chmod(join(binDir, npxName), 0o755)

  // An empty HOME matters: otherwise a real ~/.local/bin install is found in
  // the known-location step and the npx fallback is never reached.
  const invocation = resolveExecutable({ env: { PATH: binDir, HOME: home, USERPROFILE: home } })
  assert.equal(invocation.source, 'npx')
  assert.ok(invocation.args.includes('-y'), 'npx must install the pinned runtime on demand')
})

test('runtime resolution reports every location it searched when nothing is found', async () => {
  const sandbox = await makeTmpDir('dsh-cbm-missing-')
  const home = join(sandbox, 'home')
  await mkdir(home)
  assert.throws(
    () => resolveExecutable({ env: { PATH: join(sandbox, 'bin'), HOME: home, USERPROFILE: home } }),
    /codebase-memory-mcp not found/,
  )
})

test('cli bridge pipes arguments over stdin and parses the JSON reply', async () => {
  const dir = await makeTmpDir('dsh-cbm-cli-')
  const fake = join(dir, 'fake-cli.mjs')
  await writeFile(fake, `
    let body = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) body += chunk
    const args = JSON.parse(body || '{}')
    if (args.fail) { process.stderr.write('boom from fake cli'); process.exit(3) }
    process.stdout.write(JSON.stringify({ status: 'indexed', echoed: args, argv: process.argv.slice(2) }))
  `)
  const executable = join(dir, IS_WINDOWS ? 'cbm.cmd' : 'cbm')
  await writeFile(executable, `#!${process.execPath}\n${await readFile(fake, 'utf8')}`)
  await chmod(executable, 0o755)

  const bridge = createCliBridge({ executable, env: { ...process.env, PATH: dir } })
  assert.equal(bridge.source, 'config')
  assert.equal(bridge.executable, executable)

  const result = await bridge.callTool('index_repository', { repo_path: '/srv/repo with "quotes"', mode: 'fast' })
  assert.equal(result.status, 'indexed')
  // Arguments must travel over stdin: the raw positional-JSON form is
  // deprecated upstream and breaks on paths containing quotes.
  assert.deepEqual(result.echoed, { repo_path: '/srv/repo with "quotes"', mode: 'fast' })
  assert.deepEqual(result.argv, ['cli', 'index_repository'])

  await assert.rejects(() => bridge.callTool('index_repository', { fail: true }), /boom from fake cli/)
})

test('cli bridge times out a hanging runtime', async () => {
  const dir = await makeTmpDir('dsh-cbm-timeout-')
  const fake = join(dir, 'hang-cli.mjs')
  await writeFile(fake, 'setTimeout(() => {}, 30000)\n')
  const executable = join(dir, 'hang')
  await writeFile(executable, `#!${process.execPath}\n${await readFile(fake, 'utf8')}`)
  await chmod(executable, 0o755)

  const bridge = createCliBridge({ executable, timeoutMs: 150 })
  await assert.rejects(() => bridge.callTool('list_projects', {}), /timed out after 150ms/)
})

test('state store removes duplicate repository paths and reuses the surviving id', async () => {
  const dir = await makeTmpDir('dsh-cbm-state-')
  const statePath = join(dir, 'watcher.json')
  await writeFile(statePath, JSON.stringify({
    version: 1,
    watches: {
      w1: { id: 'w1', repoPath: 'C:/Repo', createdAt: 1 },
      w2: { id: 'w2', repoPath: 'c:\\repo\\', createdAt: 2 },
      w3: { id: 'w3', repoPath: 'D:/Other', createdAt: 3 },
    },
    nextId: 4,
  }))

  const state = createStateStore(statePath)
  const surviving = (await state.all()).map((watch) => watch.id)
  // On Windows the two spellings of the same drive path collapse into one
  // record. On POSIX they are absolute-but-distinct lexical paths, so both
  // survive — that divergence is the whole point of the platform split.
  assert.deepEqual(surviving, IS_WINDOWS ? ['w2', 'w3'] : ['w1', 'w2', 'w3'])

  const migrated = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(migrated.version, 2)
  for (const record of Object.values(migrated.watches)) {
    assert.equal(typeof record.pathKey, 'string')
    assert.ok(record.pathKey.length > 0)
    // Migration must not rewrite the path the user actually configured; the
    // canonical key is additive.
    assert.equal(typeof record.repoPath, 'string')
  }
})

test('state store reuses the record for the same repository and keeps records separate otherwise', async () => {
  const root = await makeTmpDir('dsh-cbm-identity-')
  const upper = join(root, 'Repo')
  const lower = join(root, 'repo')
  await mkdir(upper)
  await mkdir(lower)
  const state = createStateStore(join(root, 'watcher.json'))

  const first = await state.upsert({ repoPath: upper, createdAt: 1 })
  // Same directory through a trailing slash must reuse the id.
  assert.equal(await state.upsert({ repoPath: upper + '/', createdAt: 2 }), first)
  // A case-differing sibling is a different repository on POSIX.
  const second = await state.upsert({ repoPath: lower, createdAt: 3 })
  if (IS_WINDOWS) assert.equal(second, first)
  else assert.notEqual(second, first)

  assert.equal(await state.findIdByRepoPath(upper), first)
  assert.equal((await state.all()).length, IS_WINDOWS ? 1 : 2)
})

test('disposeAll preserves persisted watcher intent for Host restart recovery', async () => {
  const { state, service } = await fixture()
  const dir = await makeTmpDir('dsh-cbm-dispose-')
  const record = await service.start({ repoPath: dir, autoRebuild: false })
  await waitFor(async () => (await state.get(record.id))?.status === 'idle')
  await service.disposeAll()
  assert.notEqual((await state.get(record.id)).status, 'stopped')
})

test('a rebuild requested while another rebuild runs is queued and executed', async () => {
  let releaseFirst
  let calls = 0
  const first = new Promise((resolve) => { releaseFirst = resolve })
  const dir = await makeTmpDir('dsh-cbm-queue-')
  await writeFile(join(dir, 'entry.js'), 'export const value = 1\n')
  const state = createStateStore(join(dir, 'watcher.json'))
  const service = createWatcherService({
    state,
    cli: {
      indexRepository: async () => {
        calls += 1
        if (calls === 1) await first
        return { status: 'indexed', nodes: calls, edges: calls }
      },
    },
    defaults: { debounceMs: 20, mode: 'fast', ignored: [], watchedExtensions: ['.js'], usePolling: false },
    log: null,
  })
  const record = await service.start({ repoPath: dir, autoRebuild: false })
  await waitFor(async () => (await state.get(record.id))?.status === 'idle')
  const running = service.rebuildOne(record.id)
  await waitFor(() => calls === 1)
  const queued = await service.rebuildOne(record.id)
  assert.deepEqual(queued, { ok: true, queued: true })
  releaseFirst()
  await running
  await waitFor(() => calls === 2)
  await service.disposeAll()
})

test('a file edit after the initial scan triggers a debounced rebuild', async () => {
  // Regression guard for the core feature. Two traps this test exists to catch:
  //   1. Editing before chokidar's `ready` event lands inside the initial scan,
  //      where chokidar reports the file as `add` and ignoreInitial swallows it.
  //      That produced a false "the watcher never fires" diagnosis once already.
  //   2. The ignored predicate must keep real source files — an over-eager
  //      extension filter silently disables every rebuild.
  const dir = await makeTmpDir('dsh-cbm-events-')
  const source = join(dir, 'main.ts')
  await writeFile(source, 'export const v = 1\n')

  const state = createStateStore(join(dir, 'watcher.json'))
  let calls = 0
  const service = createWatcherService({
    state,
    cli: { indexRepository: async () => { calls += 1; return { status: 'indexed' } } },
    defaults: { debounceMs: 30, mode: 'fast', ignored: ['**/node_modules/**'], watchedExtensions: ['.ts'], usePolling: false },
    log: null,
  })

  const record = await service.start({ repoPath: dir })
  const handle = service.handles.get(record.id)
  await new Promise((resolve) => handle.chokidar.once('ready', resolve))

  await writeFile(source, 'export const v = 2\n')
  await waitFor(() => calls === 1, 5000)
  await waitFor(async () => (await state.get(record.id))?.status === 'idle', 5000)

  assert.equal(calls, 1)
  assert.equal((await state.get(record.id)).lastError, '')
  await service.disposeAll()
})

test('watcher records the canonical path and never watches a non-directory', async () => {
  const { service } = await fixture()
  const dir = await makeTmpDir('dsh-cbm-canonical-')
  const file = join(dir, 'not-a-dir.js')
  await writeFile(file, 'export const x = 1\n')

  await assert.rejects(() => service.start({ repoPath: file }), /not a directory/)
  await assert.rejects(() => service.start({ repoPath: '' }), /repoPath required/)

  // A trailing slash must not produce a second watch for the same directory.
  const first = await service.start({ repoPath: dir, autoRebuild: false })
  const second = await service.start({ repoPath: dir + '/', autoRebuild: false })
  assert.equal(second.id, first.id)
  assert.equal(second.repoPath, canonicalRepoPath(dir))
  await service.disposeAll()
})
