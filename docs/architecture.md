# Architecture

One package registers two Cordis bundles through `cordis.patch.yml`:

| Bundle id | Role |
|---|---|
| `mcp-codebase-memory` | Bridges the upstream Codebase Memory MCP server into DSH through the official `@deepseek-ai/dsh-mcp-client`, so every `mcp__codebase_memory__*` tool is registered natively in the session tool list. |
| `dsh-codebase-memory-watcher` | Same package, second bundle id. Runs one chokidar watcher per registered project and rebuilds indexes after edits settle. |

## Data flow

- Agent sessions call `mcp__codebase_memory__*` tools; calls go through the DSH MCP client bridge to the local `codebase-memory-mcp` server.
- The Graph UI at `http://127.0.0.1:9749` is served by the upstream server itself and stays independent of DSH.
- The watcher path is separate from the bridge path: it spawns the runtime's CLI (`cli index_repository`, JSON on stdin) instead of sharing the MCP client connection.

## Sources of truth

| Concern | Module |
|---|---|
| Path identity, ignore matching, extension matching, mount detection | `src/paths.mjs` |
| Runtime resolution and CLI invocation | `src/cli-bridge.mjs` |
| Persisted watch records and version migration | `src/state.mjs` |
| Per-project watching, debounce, rebuild queueing | `src/watcher.mjs` |
| HTTP surface | `src/routes.mjs` |
| Wiring, startup recovery, auto-attach | `src/index.mjs` |

`src/paths.mjs` exists because "is this the same repository?" and "does this ignore pattern match?" need opposite case rules; see [ADR 0002](adr/0002-platform-aware-repo-path-identity.md).

## Watcher design

- Each watcher debounces file events (`debounceMs`, default 5000) and then invokes the runtime CLI with the repository path.
- Rebuilds are serialized per watcher: a request that arrives mid-rebuild is queued and runs once the current one finishes.
- The watcher deliberately does not share or own the MCP client connection; rebuilding through a short-lived CLI process keeps bridge failures isolated from indexing.
- Defaults (`mode: moderate`, ignore list, watched extensions) live in `cordis.patch.yml`; the full table is in the README.
- Watcher records persist in `$DSH_HOME/dsh-codebase-memory/watcher.json`. Disposal closes handles but keeps intent; DSH Web start re-creates every watcher the user did not explicitly stop.

## Platform handling

The port is single-implementation: platform differences are confined to two places — runtime resolution in `src/cli-bridge.mjs` and path identity in `src/paths.mjs`. Everything else behaves identically on Linux, macOS and Windows. See [ADR 0001](adr/0001-runtime-resolution-order.md).

Consequences worth knowing:

- **Indexing is gated upstream.** `codebase-memory-mcp` refuses to index a path outside its allowed roots (`codebase-memory-mcp allow-root <path>`). The plugin reports that message as-is and never widens the allow-list itself — it is the operator's safety boundary, not the plugin's to change.
- **The warm daemon is the operator's.** `cli` invocations start a temporary daemon. Measured on Linux x64, a `list_projects` call costs ~5.5 s cold and ~4.5 s with a permanent daemon (`codebase-memory-mcp daemon start`): the daemon removes the boot cost, not the CLI's own per-invocation work. The plugin does not manage that lifecycle, to avoid start/stop races and orphaned processes.
- **Cross-VM mounts are polled.** WSL2 DrvFs (`9p`) loses inotify events silently, so watches created there enable polling unless `usePolling` was set explicitly.
- **The cache stays off `/mnt/*`.** Upstream rejects a private cache directory under a world-writable DrvFs parent (upstream issue #1687); the default `~/.cache/codebase-memory-mcp` is correct.
