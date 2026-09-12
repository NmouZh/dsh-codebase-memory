import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { IS_WINDOWS } from './paths.mjs'

// Resolve the codebase-memory-mcp executable and drive it through its CLI
// surface. One CLI invocation launches its own short-lived process (and, as
// of 0.10.8, its own temporary daemon) — startup costs a few seconds, which we
// accept to keep the bridge dependency-free and to keep indexing isolated from
// the MCP-client bundle's connection.
//
// Resolution order (first hit wins):
//   1. CODEBASE_MEMORY_MCP_BIN      explicit operator override, wins everywhere
//   2. config.executable            per-install configuration
//   3. PATH                         the documented install location is on PATH
//   4. known install locations      ~/.local/bin, /usr/local/bin, npm -g, …
//   5. npx                          last resort; needs network + npm on PATH
//
// The upstream runtime is distributed four ways on Linux (install.sh into
// ~/.local/bin, npm global, PyPI, AUR) and only via npx on Windows, so no
// single hard-coded path can be right. Probing keeps every channel working.

export const RUNTIME_PACKAGE = 'codebase-memory-mcp'
export const RUNTIME_VERSION = '0.10.8'

// Upstream writes structured diagnostics (level=info …) and routine hints to
// stderr alongside the real error text. Keep the error lines and drop the
// chatter, so watcher state shows the actionable message rather than a log
// dump the operator has to read past.
export function summarizeStderr(raw) {
  const lines = String(raw || '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const isNoise = (line) => /^level=(info|debug)\b/.test(line) || /^hint: .*temporary CBM daemon/.test(line)
  const informative = lines.filter((line) => !isNoise(line))
  const picked = informative.length > 0 ? informative : lines
  return picked.join('\n').slice(0, 600)
}

// Upstream's npm package is a ~12 KB downloader: `npm i -g` runs a postinstall
// that fetches the platform archive and writes the real binary to
// <npm root -g>/codebase-memory-mcp/bin/. Note the Windows layout has no
// `bin/` segment, which is why the candidate lists below diverge per platform.
//
// The environment is a parameter rather than the ambient process.env so that
// resolution is reproducible under test and honest about which HOME it used.
function homeOf(env) {
  const fromEnv = env && (env.HOME || env.USERPROFILE)
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : homedir()
}

function npmGlobalRoots(env) {
  const roots = []
  if (IS_WINDOWS) {
    const roaming = (env && env.APPDATA) || join(homeOf(env), 'AppData', 'Roaming')
    roots.push(join(roaming, 'npm', 'node_modules'))
    const local = (env && env.LOCALAPPDATA) || join(homeOf(env), 'AppData', 'Local')
    roots.push(join(local, 'npm-cache', '_npx', 'node_modules'))
    roots.push(join(homeOf(env), 'AppData', 'Roaming', 'npm', 'node_modules'))
    roots.push('C:/Program Files/nodejs/node_modules')
    return roots
  }
  const prefix = env && env.npm_config_prefix
  if (prefix) roots.push(join(prefix, 'lib', 'node_modules'))
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/usr/lib64/node_modules')
  return roots
}

function candidatePaths(env) {
  const home = homeOf(env)
  const out = []
  if (IS_WINDOWS) {
    out.push(join(home, '.local', 'bin', 'codebase-memory-mcp.exe'))
    for (const root of npmGlobalRoots(env)) out.push(join(root, RUNTIME_PACKAGE, 'bin', 'codebase-memory-mcp.exe'))
    return out
  }
  const xdgBin = (env && env.XDG_BIN_HOME) || join(home, '.local', 'bin')
  out.push(join(xdgBin, RUNTIME_PACKAGE))
  out.push(join(home, '.local', 'share', 'pnpm', RUNTIME_PACKAGE))
  for (const root of npmGlobalRoots(env)) out.push(join(root, RUNTIME_PACKAGE, 'bin', RUNTIME_PACKAGE))
  return out
}

export function pathDirectories(env = process.env) {
  const raw = env.PATH || env.Path || ''
  const dirs = raw.split(IS_WINDOWS ? ';' : ':').map((entry) => entry.trim().replace(/^"|"$/g, ''))
  return dirs.filter((entry) => entry.length > 0)
}

// Is this an executable file we can actually spawn? On Windows the extension
// (or its absence) decides; on POSIX we require the execute bit, so a stray
// non-executable file of the same name does not shadow a real install.
export function isExecutableFile(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false
  try {
    if (!statSync(candidate).isFile()) return false
  } catch {
    return false
  }
  if (IS_WINDOWS) return true
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function fromPathDirectories(env) {
  const names = IS_WINDOWS ? [RUNTIME_PACKAGE + '.exe', RUNTIME_PACKAGE + '.cmd', RUNTIME_PACKAGE + '.bat'] : [RUNTIME_PACKAGE]
  for (const dir of pathDirectories(env)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

// The npx fallback is invoked by the Node executable itself on Windows, which
// cannot spawn "npx" without a shell.
export function npxInvocation() {
  if (IS_WINDOWS) {
    return {
      command: process.execPath,
      args: [process.execPath.replace(/\\node\.exe$/i, '') + '\\node_modules\\npm\\bin\\npx-cli.js', '-y', `${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`],
    }
  }
  return { command: 'npx', args: ['-y', `${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`] }
}

// Is npx reachable? Scan PATH directly instead of shelling out to `which`:
// `which` is absent on Windows and not guaranteed on POSIX, and a helper that
// needs a helper is not a reliable last resort.
function npxAvailable(env) {
  const names = IS_WINDOWS ? ['npx.exe', 'npx.cmd', 'npx.bat'] : ['npx']
  for (const dir of pathDirectories(env)) {
    for (const name of names) {
      if (isExecutableFile(join(dir, name))) return true
    }
  }
  return false
}

// Resolve the runtime into a spawnable invocation.
// Returns { command, args: [], source, executable }:
//   source     config | env | path | known-location | npx
//   executable the resolved path when known, otherwise the command to run
export function resolveExecutable(options = {}) {
  const env = options.env || process.env
  const configured = typeof options.executable === 'string' ? options.executable.trim() : ''
  const fromEnv = typeof env.CODEBASE_MEMORY_MCP_BIN === 'string' ? env.CODEBASE_MEMORY_MCP_BIN.trim() : ''

  if (configured !== '' && fromEnv !== '' && configured !== fromEnv) {
    throw new Error(
      `conflicting runtime paths: config.executable=${configured} but CODEBASE_MEMORY_MCP_BIN=${fromEnv}. ` +
        'Set only one of them.',
    )
  }

  if (configured !== '') return { command: configured, args: [], source: 'config', executable: isAbsolute(configured) ? configured : null }
  if (fromEnv !== '') return { command: fromEnv, args: [], source: 'env', executable: isAbsolute(fromEnv) ? fromEnv : null }

  const onPath = fromPathDirectories(env)
  if (onPath) return { command: onPath, args: [], source: 'path', executable: onPath }

  for (const candidate of candidatePaths(env)) {
    if (existsSync(candidate)) return { command: candidate, args: [], source: 'known-location', executable: candidate }
  }

  if (npxAvailable(env)) {
    const npx = npxInvocation()
    return { command: npx.command, args: npx.args, source: 'npx', executable: null }
  }

  // Nothing worked: name the search so the failure is actionable.
  const searched = [...pathDirectories(env), ...candidatePaths(env)]
  throw new Error(
    `${RUNTIME_PACKAGE} not found. Install it (for example: ` +
      `curl -fsSL https://raw.githubusercontent.com/DeusData/${RUNTIME_PACKAGE}/main/install.sh | bash) ` +
      `or set CODEBASE_MEMORY_MCP_BIN. Searched PATH and: ${searched.join(', ')}`,
  )
}

// Build the CLI invocation for one tool call. Arguments go over stdin: the
// positional raw-JSON form is deprecated upstream and breaks on paths that
// contain quotes or backslashes.
export function buildCliArgs(toolName) {
  return ['cli', toolName]
}

export function createCliBridge({ executable = '', env = process.env, timeoutMs = 600_000 } = {}) {
  const invocation = resolveExecutable({ executable, env })

  return {
    // The resolved path when we have one, otherwise the command we will spawn.
    executable: invocation.executable || invocation.command,
    source: invocation.source,

    // Run `codebase-memory-mcp cli <tool_name>` with the JSON arguments piped
    // to stdin, and return parsed JSON on success. Throws with a wrapped error
    // on failure so callers can surface the message in watcher state.
    async callTool(toolName, args = {}) {
      const payload = JSON.stringify(args == null ? {} : args)
      return new Promise((resolve, reject) => {
        let child
        try {
          child = spawn(invocation.command, [...invocation.args, ...buildCliArgs(toolName)], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
          })
        } catch (err) {
          reject(new Error(`${RUNTIME_PACKAGE} cli ${toolName} spawn failed: ${err && err.message ? err.message : String(err)}`))
          return
        }

        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { child.kill() } catch { /* ignore */ }
          fn(value)
        }

        const timer = setTimeout(() => {
          finish(reject, new Error(`${RUNTIME_PACKAGE} cli ${toolName} timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

        child.on('error', (err) => {
          const hint = invocation.source === 'npx' ? ' (the npx fallback needs network access and npm on PATH)' : ''
          finish(reject, new Error(`${RUNTIME_PACKAGE} cli ${toolName} spawn failed: ${err.message}${hint}`))
        })

        child.on('close', (code) => {
          if (code !== 0) {
            const message = summarizeStderr(stderr) || `exit code ${code}`
            finish(reject, new Error(`${RUNTIME_PACKAGE} cli ${toolName} failed: ${message}`))
            return
          }
          // The CLI prints a single JSON object on stdout; diagnostics go to stderr.
          const trimmed = stdout.trim()
          if (trimmed === '') {
            finish(resolve, null)
            return
          }
          try {
            finish(resolve, JSON.parse(trimmed))
          } catch {
            finish(reject, new Error(`${RUNTIME_PACKAGE} cli ${toolName} returned non-JSON: ${trimmed.slice(0, 200)}`))
          }
        })

        // A closed stdin makes the CLI read its arguments from the pipe.
        child.stdin.on('error', () => { /* the CLI may exit before reading stdin */ })
        child.stdin.end(payload)
      })
    },

    async listProjects() {
      const result = await this.callTool('list_projects', {})
      return result && Array.isArray(result.projects) ? result.projects : []
    },

    async indexRepository(repoPath, mode = 'moderate') {
      return await this.callTool('index_repository', { repo_path: repoPath, mode })
    },

    async indexStatus(projectName) {
      try {
        return await this.callTool('index_status', { project: projectName })
      } catch (err) {
        return { error: err.message }
      }
    },
  }
}
