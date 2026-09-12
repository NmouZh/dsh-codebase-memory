import { realpathSync, statfsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

// Platform-aware path identity, ignore-pattern matching, and mount detection.
//
// Why this module exists: the identity of a repository ("is this the same
// repo as that other watch?") and the matching of an ignore pattern against a
// path are two different questions, and they need opposite case handling.
//
//   * Identity must be case-*sensitive* on POSIX: /home/dev/Repo and
//     /home/dev/repo are two different directories on ext4. Folding case here
//     silently drops a real watch.
//   * Matching may fold case on Windows, where the pattern "**/Node_Modules/**"
//     should still match "node_modules".
//
// Collapsing both into one toLowerCase() call is what made the watcher merge
// unrelated repositories on Linux. Keep them separate.

export const IS_WINDOWS = process.platform === 'win32'

// "compatible" deliberately excludes:
//  - 0x517B (SMB/CIFS) and 0xFE534D42 (SMB2): chokidar explicitly disables
//    fsevents on these.
//  - 0xFF534D42 (CIFS magic): same reason.
//  - ZFS: no evidence of missed events on Linux.
// Detection is a heuristic. A user who knows better can always set
// usePolling explicitly; an explicit value always wins.
const POLL_FILESYSTEM_TYPES = new Map([
  [0x01021997, '9p'], // WSL2 DrvFs: /mnt/c, /mnt/d, … (cross-VM, events get lost)
  [0x6969, 'nfs'],
  [0x65735546, 'fuse'],
  [0x65735543, 'fuseblk'],
  [0xFF534D42, 'cifs'],
  [0xFE534D42, 'smb2'],
  [0x73757245, 'cifs-remote'],
  [0x564C, 'novell'],
  [0x4D44, 'msdos'],
])

// A curated alias table for the filesystem types we actually see on developer
// machines. Linux also publishes this mapping in /proc/filesystems, but that
// file is kernel-specific and absent on Windows, so we prefer our own names
// and fall back to the raw magic number.
const FILESYSTEM_NAMES = new Map([
  [0xEF53, 'ext'],
  [0x01021994, 'tmpfs'],
  [0x01021997, '9p'],
  [0x58465342, 'xfs'],
  [0x9123683E, 'btrfs'],
  [0x6969, 'nfs'],
  [0x65735546, 'fuse'],
  [0x65735543, 'fuseblk'],
  [0xFF534D42, 'cifs'],
  [0xFE534D42, 'smb2'],
  [0x4D44, 'msdos'],
  [0x7A657365, 'zfs'],
  [0x2FC12FC1, 'zfs'],
])

// Collapse a path to the single forward-slash representation chokidar uses,
// so ignore patterns ("**/node_modules/**") match on every platform.
export function toSlashes(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/')
}

// Case folding for *pattern matching only*. Never use this for identity.
export function foldForMatch(value) {
  const slashed = toSlashes(value)
  return IS_WINDOWS ? slashed.toLowerCase() : slashed
}

function tryRealpath(absolute) {
  try {
    return realpathSync(absolute)
  } catch {
    return null
  }
}

function tryStatfs(target) {
  try {
    return statfsSync(target)
  } catch {
    return null
  }
}

// Canonical absolute path for a repository, used for identity comparison.
// Resolves symlinks when the path exists; falls back to a lexical absolute
// path when it does not (a watch may legitimately point at a repo that is not
// mounted yet). Returns null when no path can be derived.
export function canonicalRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') return null
  const absolute = resolvePath(repoPath.trim())
  const real = tryRealpath(absolute)
  const canonical = real || absolute
  // Strip a trailing separator (except for the filesystem root) so that
  // "/srv/repo/" and "/srv/repo" agree.
  if (canonical.length > 1) return canonical.replace(/[/\\]+$/, '')
  return canonical
}

// Identity comparison: two repository paths refer to the same repository.
// Case-sensitive on POSIX, case-insensitive on Windows.
export function sameRepoPath(a, b) {
  const left = canonicalRepoPath(a)
  const right = canonicalRepoPath(b)
  if (left === null || right === null) return false
  if (left === right) return true
  return IS_WINDOWS && left.toLowerCase() === right.toLowerCase()
}

// Build the predicate chokidar calls for its `ignored` option from the
// configured glob-ish patterns ("**/node_modules/**", …). Matching is
// case-insensitive on Windows and case-sensitive on POSIX.
export function buildIgnoreMatcher(patterns) {
  const list = (Array.isArray(patterns) ? patterns : []).filter((p) => typeof p === 'string' && p.length > 0)
  const tokens = []
  for (const pattern of list) {
    const token = pattern
      .replace(/^\*\*\//, '')
      .replace(/\/\*\*$/, '')
      .replace(/^\*\//, '')
      .replace(/\/\*$/, '')
    if (token !== '') tokens.push(IS_WINDOWS ? token.toLowerCase() : token)
  }
  return (filePath) => {
    if (!filePath) return false
    const normalized = foldForMatch(filePath)
    for (const token of tokens) {
      if (normalized.includes('/' + token + '/') || normalized.endsWith('/' + token) || normalized.startsWith(token + '/')) return true
    }
    return false
  }
}

// Normalize the configured extension list to a Set of lowercase ".ext" values.
export function normalizeExtensions(list) {
  const out = new Set()
  for (const ext of list || []) {
    if (typeof ext !== 'string' || ext === '') continue
    out.add((ext.startsWith('.') ? ext : '.' + ext).toLowerCase())
  }
  return out
}

// Does this path carry one of the watched extensions? Directory paths (no
// extension, or a dot inside a directory component) are never matches.
export function hasWatchedExtension(filePath, extensions) {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  for (const ext of extensions) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

// Human-readable filesystem type for a path, or null when it cannot be read.
export function describeFilesystem(target) {
  const stats = tryStatfs(target)
  if (!stats) return null
  const magic = stats.type >>> 0
  return FILESYSTEM_NAMES.get(magic) || '0x' + magic.toString(16)
}

// Should this repository be watched with polling? True for filesystems whose
// change notifications are known to be unreliable — most importantly WSL2's
// DrvFs mounts (/mnt/c, /mnt/d), where inotify events are silently dropped and
// a watcher would look healthy while never rebuilding anything.
export function shouldForcePolling(repoPath) {
  if (IS_WINDOWS) return false
  if (typeof repoPath !== 'string' || repoPath === '') return false
  const stats = tryStatfs(repoPath)
  if (!stats) return false
  return POLL_FILESYSTEM_TYPES.has(stats.type >>> 0)
}

// Why polling was forced, for the watch record and for logs.
export function pollingReason(repoPath) {
  const stats = tryStatfs(repoPath)
  if (!stats) return null
  return POLL_FILESYSTEM_TYPES.get(stats.type >>> 0) || null
}
