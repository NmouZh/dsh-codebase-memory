import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { canonicalRepoPath } from './paths.mjs'

// State store: persisted to <DSH_HOME>/dsh-codebase-memory/watcher.json so a
// DSH Web restart can rebuild watchers automatically.
//
// Version history:
//   1  repoPath compared after lowercase + slash folding (Windows-first)
//   2  repoPath identity is platform-aware; records carry a `pathKey`
//
// A v1 file still loads: every record is re-keyed with the canonical path
// identity, which on POSIX stops unrelated repositories (/srv/Repo vs
// /srv/repo) from being merged into one watch.

const STATE_VERSION = 2

function pathKeyOf(record) {
  const canonical = canonicalRepoPath(record && record.repoPath)
  return canonical === null ? '' : canonical
}

function dedupeWatches(watches) {
  // pathKey -> { id, record }. Later records win when they are newer.
  const byKey = new Map()
  const unkeyed = {}
  for (const [id, raw] of Object.entries(watches)) {
    const record = { ...raw, id }
    const key = pathKeyOf(record)
    if (key === '') {
      // No usable path: keep it, it cannot participate in identity matching.
      unkeyed[id] = record
      continue
    }
    record.pathKey = key
    const previous = byKey.get(key)
    if (previous && Number(previous.record.createdAt || 0) >= Number(record.createdAt || 0)) continue
    byKey.set(key, { id, record })
  }
  const deduped = { ...unkeyed }
  for (const { id, record } of byKey.values()) deduped[id] = record
  return deduped
}

export function createStateStore(filePath) {
  let state = {
    version: STATE_VERSION,
    watches: {},
    nextId: 1,
  }
  let loaded = false
  let persistTail = Promise.resolve()

  function migrate(parsed) {
    const watches = dedupeWatches(parsed.watches)
    const changed =
      parsed.version !== STATE_VERSION ||
      Object.keys(watches).length !== Object.keys(parsed.watches).length ||
      Object.entries(watches).some(([id, record]) => (parsed.watches[id] && parsed.watches[id].pathKey) !== record.pathKey)
    return {
      next: { ...parsed, version: STATE_VERSION, watches },
      changed,
    }
  }

  async function load() {
    if (loaded) return
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.watches === 'object' && parsed.watches !== null) {
        const { next, changed } = migrate(parsed)
        state = next
        loaded = true
        if (changed) await persist()
        return
      }
      console.warn('[dsh-codebase-memory] state file has an unexpected shape; starting clean')
    } catch (err) {
      // Missing or corrupt: start clean; the watcher will rebuild on demand.
      if (err && err.code !== 'ENOENT') {
        console.warn('[dsh-codebase-memory] state load failed:', err.message)
      }
    }
    loaded = true
  }

  async function persist() {
    const snapshot = JSON.stringify(state, null, 2)
    const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now() + '-' + randomUUID()
    persistTail = persistTail
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
        try { await chmod(tmp, 0o600) } catch { /* Windows ACLs are inherited */ }
        await rename(tmp, filePath)
      })
      .catch((err) => console.warn('[dsh-codebase-memory] state persist failed:', err.message))
    return persistTail
  }

  function findByPathKey(key, excludeId) {
    if (!key) return null
    for (const record of Object.values(state.watches)) {
      if (record.id === excludeId) continue
      const recordKey = record.pathKey || pathKeyOf(record)
      if (recordKey === key) return record
    }
    return null
  }

  return {
    async all() {
      await load()
      return Object.values(state.watches)
    },
    async get(id) {
      await load()
      return state.watches[id] || null
    },
    // Find an existing watch for the same repository, so a restart or an
    // auto-attach pass reuses the record instead of piling up duplicates.
    async findIdByRepoPath(repoPath) {
      await load()
      const canonical = canonicalRepoPath(repoPath)
      if (canonical === null) return null
      const existing = findByPathKey(canonical)
      return existing ? existing.id : null
    },
    async upsert(record) {
      await load()
      const pathKey = pathKeyOf(record)
      if (!record.id && pathKey !== '') {
        const existing = findByPathKey(pathKey)
        if (existing) record.id = existing.id
      }
      if (!record.id) record.id = 'w' + String(state.nextId++)
      state.watches[record.id] = { ...record, pathKey }
      await persist()
      return record.id
    },
    async update(id, patch) {
      await load()
      const existing = state.watches[id]
      if (!existing) return null
      const merged = { ...existing, ...patch, id }
      // Keep the identity key consistent with whatever repoPath now says.
      if (!('pathKey' in patch)) merged.pathKey = pathKeyOf(merged)
      state.watches[id] = merged
      await persist()
      return state.watches[id]
    },
    async remove(id) {
      await load()
      if (!state.watches[id]) return false
      delete state.watches[id]
      await persist()
      return true
    },
  }
}
