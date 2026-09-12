import chokidar from 'chokidar'
import { statSync } from 'node:fs'
import { createCliBridge } from './cli-bridge.mjs'
import { buildIgnoreMatcher, canonicalRepoPath, hasWatchedExtension, normalizeExtensions, pollingReason, shouldForcePolling } from './paths.mjs'

// Per-project watcher: chokidar watches the repo root, debounces events, and
// rebuilds the knowledge graph by calling the codebase-memory-mcp CLI. The
// MCP-client bundle does not expose its client handle to other bundles, so
// each rebuild spawns its own short-lived process — startup is a few seconds
// which is acceptable.

// Compatibility shim for the optional logger argument: it can be a single
// `(level, message)` function or an object with `info/error/warn` methods.
function callLog(log, level, message) {
  if (!log) return
  if (typeof log === 'function') {
    try { log(level, message) } catch { /* ignore */ }
    return
  }
  if (typeof log[level] === 'function') {
    try { log[level](message) } catch { /* ignore */ }
    return
  }
  if (level === 'error') console.error(message)
  else console.log(message)
}

function assertWatchableDirectory(repoPath) {
  let stats
  try {
    stats = statSync(repoPath)
  } catch (err) {
    throw new Error(`repoPath is not readable: ${repoPath} (${err && err.code ? err.code : err.message})`)
  }
  if (!stats.isDirectory()) throw new Error(`repoPath is not a directory: ${repoPath}`)
}

export function createWatcherService({ state, cli, defaults, log }) {
  // watchId -> { chokidar, record, debounceTimer, pendingFiles, running, rebuildPromise }
  const handles = new Map()

  async function rebuild(record, { reason = 'manual' } = {}) {
    const id = record.id
    if (!id) return { ok: false, error: 'missing watch id' }
    const handle = handles.get(id)
    if (handle?.running) {
      handle.queuedReason = reason
      callLog(log, 'info', `[dsh-codebase-memory] rebuild queued for ${id} (${reason})`)
      return { ok: true, queued: true }
    }

    const run = (async () => {
      const startedAt = Date.now()
      try {
        callLog(log, 'info', `[dsh-codebase-memory] rebuilding ${record.repoPath} (${record.mode}, reason=${reason})`)
        const result = await cli.indexRepository(record.repoPath, record.mode)
        const finishedAt = Date.now()
        const durationMs = finishedAt - startedAt
        await state.update(id, {
          status: 'idle',
          lastRun: finishedAt,
          lastDurationMs: durationMs,
          lastError: '',
          lastResult: summarizeIndexResult(result),
        })
        callLog(log, 'info', `[dsh-codebase-memory] rebuild ${id} done in ${durationMs}ms`)
        return { ok: true, durationMs, result }
      } catch (err) {
        const finishedAt = Date.now()
        const message = err && err.message ? err.message : String(err)
        await state.update(id, { status: 'unhealthy', lastRun: finishedAt, lastError: message })
        callLog(log, 'error', `[dsh-codebase-memory] rebuild ${id} failed: ${message}`)
        return { ok: false, error: message }
      }
    })()

    if (handle) {
      handle.running = true
      handle.rebuildPromise = run
    }
    const result = await run
    if (handle) {
      handle.running = false
      handle.rebuildPromise = null
      const queuedReason = handle.queuedReason
      handle.queuedReason = null
      if (queuedReason && !handle.stopping) {
        const fresh = (await state.get(id)) || record
        handle.rebuildPromise = rebuild(fresh, { reason: queuedReason })
      }
    }
    return result
  }

  function summarizeIndexResult(result) {
    if (!result || typeof result !== 'object') return null
    return {
      status: typeof result.status === 'string' ? result.status : null,
      nodes: typeof result.nodes === 'number' ? result.nodes : null,
      edges: typeof result.edges === 'number' ? result.edges : null,
      project: typeof result.project === 'string' ? result.project : null,
    }
  }

  async function start({ repoPath, debounceMs, mode, ignored, watchedExtensions, usePolling, autoRebuild = true }) {
    // Store the canonical absolute path: identical repositories reached through
    // a symlink, a trailing slash, or a relative path then share one watch.
    const canonical = canonicalRepoPath(repoPath)
    if (canonical === null) throw new Error('repoPath required')
    assertWatchableDirectory(canonical)

    const existingId = await state.findIdByRepoPath(canonical)

    // Polling: honour an explicit choice, otherwise fall back to the configured
    // default, otherwise detect a filesystem whose change events are unreliable
    // (WSL2 DrvFs mounts) and poll there so rebuilds actually happen.
    let effectivePolling
    let pollingForcedBy = ''
    if (usePolling !== undefined) {
      effectivePolling = usePolling === true
    } else if (defaults.usePolling === true) {
      effectivePolling = true
      pollingForcedBy = 'config'
    } else if (shouldForcePolling(canonical)) {
      effectivePolling = true
      pollingForcedBy = pollingReason(canonical) || 'mount'
    } else {
      effectivePolling = false
    }

    const fields = {
      repoPath: canonical,
      debounceMs: Number.isFinite(debounceMs) ? debounceMs : defaults.debounceMs,
      mode: mode || defaults.mode,
      ignored: Array.isArray(ignored) && ignored.length > 0 ? ignored : defaults.ignored,
      watchedExtensions: Array.isArray(watchedExtensions) && watchedExtensions.length > 0 ? watchedExtensions : defaults.watchedExtensions,
      usePolling: effectivePolling,
      pollingForcedBy,
      status: 'starting',
      lastRun: 0,
      lastError: '',
      createdAt: Date.now(),
    }
    let id
    if (existingId) {
      const merged = await state.update(existingId, fields)
      id = merged && merged.id ? merged.id : existingId
    } else {
      id = await state.upsert(fields)
    }
    const record = await state.get(id)

    // If we already have a live handle for this id, drop it first.
    if (handles.has(id)) await stop(id, { skipState: true })

    const exts = normalizeExtensions(record.watchedExtensions)
    const matcher = buildIgnoreMatcher(record.ignored)

    const watcher = chokidar.watch(record.repoPath, {
      ignored: (p) => {
        if (!p || p === record.repoPath) return false
        // User-configured ignore patterns (node_modules, .git, …) always win.
        if (matcher(p)) return true
        // Look for an extension; chokidar passes both directories and files.
        const dot = p.lastIndexOf('.')
        if (dot < 0 || dot === p.length - 1) {
          // No extension at all (typical for a directory path): let chokidar
          // recurse so it can find our watched files inside.
          return false
        }
        const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
        if (dot < slash) {
          // The last '.' is in a directory component, not a filename
          // extension (e.g. "foo.bar/baz"). Treat as a directory.
          return false
        }
        // Real filename with extension: keep only the ones we care about.
        return !exts.has(p.slice(dot).toLowerCase())
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      // Native notifications are the default; polling is enabled per watcher
      // for filesystems that do not deliver reliable change events.
      usePolling: record.usePolling === true,
      interval: 500,
      binaryInterval: 1000,
    })

    const handle = {
      chokidar: watcher,
      record,
      debounceTimer: null,
      pendingFiles: new Set(),
      running: false,
      rebuildPromise: null,
      queuedReason: null,
      stopping: false,
    }
    handles.set(id, handle)

    const scheduleRebuild = () => {
      if (handle.debounceTimer) clearTimeout(handle.debounceTimer)
      handle.debounceTimer = setTimeout(async () => {
        handle.debounceTimer = null
        const files = [...handle.pendingFiles]
        handle.pendingFiles.clear()
        const fresh = (await state.get(id)) || { ...handle.record, id }
        handle.rebuildPromise = rebuild(fresh, { reason: files.length + ' files changed' })
        try { await handle.rebuildPromise } catch { /* rebuild swallows */ }
      }, record.debounceMs)
    }

    const onFsEvent = (p) => {
      if (!hasWatchedExtension(p, exts)) return
      handle.pendingFiles.add(p)
      if (autoRebuild) scheduleRebuild()
    }

    watcher.on('add', onFsEvent)
    watcher.on('change', onFsEvent)
    watcher.on('unlink', onFsEvent)
    watcher.on('error', (err) => {
      const message = err && err.message ? err.message : String(err)
      callLog(log, 'error', `[dsh-codebase-memory] watcher ${id} error: ${message}`)
      void state.update(id, { status: 'unhealthy', lastError: message })
    })
    watcher.on('ready', async () => {
      await state.update(id, { status: 'idle', lastError: '' })
      const polling = record.usePolling === true ? `, polling=${record.pollingForcedBy || 'configured'}` : ''
      callLog(log, 'info', `[dsh-codebase-memory] watching ${record.repoPath} (debounce=${record.debounceMs}ms, mode=${record.mode}${polling})`)
    })

    return record
  }

  async function stop(id, { skipState = false } = {}) {
    const handle = handles.get(id)
    if (!handle) return false
    handle.stopping = true
    handle.queuedReason = null
    if (handle.debounceTimer) clearTimeout(handle.debounceTimer)
    handle.pendingFiles.clear()
    if (handle.rebuildPromise) { try { await handle.rebuildPromise } catch { /* ignore */ } }
    try { await handle.chokidar.close() } catch { /* ignore */ }
    handles.delete(id)
    if (!skipState) await state.update(id, { status: 'stopped' })
    return true
  }

  async function restart() {
    const records = await state.all()
    for (const record of records) {
      if (record.status === 'stopped') continue
      await start({
        repoPath: record.repoPath,
        debounceMs: record.debounceMs,
        mode: record.mode,
        ignored: record.ignored,
        watchedExtensions: record.watchedExtensions,
        usePolling: record.usePolling,
      })
    }
  }

  async function rebuildOne(id) {
    const record = await state.get(id)
    if (!record) return { ok: false, error: 'unknown watch id: ' + id }
    return await rebuild(record, { reason: 'manual rebuild' })
  }

  async function disposeAll() {
    for (const id of [...handles.keys()]) await stop(id, { skipState: true })
  }

  return { start, stop, restart, rebuildOne, rebuild, disposeAll, handles }
}

export { createCliBridge }
