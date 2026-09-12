# Changelog

## 0.2.2 - 2026-09-12

### Added

- Runtime resolution now probes the environment instead of pinning one install path: `CODEBASE_MEMORY_MCP_BIN`, `config.executable`, `PATH`, known install locations (`~/.local/bin`, `$XDG_BIN_HOME`, pnpm, the npm global roots), then `npx` as a last resort. `GET /watcher/cli-info` reports the winning rule as `source`.
- `scripts/validate-linux.mjs` (`pnpm validate:linux`): loads the plugin through a stub context, drives the real HTTP routes, and performs a real CLI round trip against the installed runtime.
- Cross-VM mount detection: watches created on WSL2 DrvFs (`9p`) — and on NFS/FUSE/CIFS/SMB — enable polling automatically and record `pollingForcedBy`, unless `usePolling` was set explicitly.
- `docs/adr/0001` and `docs/adr/0002` record the runtime-resolution and path-identity decisions.
- `docs/architecture.md` documents the module map, the upstream `allow-root` gate, and the warm-daemon policy.
- **Web UI tool rendering.** A browser half (`lib/client.js`, declared through `exports["./client"]` and `dsh.client`) registers one keyed `tool.call.toolview` entry per tool name, so each `mcp__codebase_memory__*` call renders as a card instead of raw text: status dot, summary, result chips, and a disclosure body dispatched by tool — search rows that open the file at the line, trace trees with hop badges, architecture and change reports as their own sections, a code card for `get_code_snippet`, per-scope verdicts for coverage, and label/edge tables for the graph schema. Unknown shapes degrade to plain text, and a truncated result says so.
- `tests/client.test.mjs` drives those parsers with verbatim tool output (25 tests total).

### Changed

- CLI arguments are piped over **stdin**. The positional raw-JSON form is deprecated upstream (it warns on every call) and breaks on paths containing quotes.
- Repository path identity is platform-aware: case-sensitive on POSIX, case-insensitive on Windows, canonicalized through `realpath`. `/srv/Repo` and `/srv/repo` are two watches on Linux instead of one.
- Watcher state moves to version 2 with a `pathKey` identity field; version 1 files migrate in place on first load without rewriting configured paths.
- State path honours `$DSH_HOME` (falling back to `~/.dsh`), matching the rest of the harness.
- `watchedExtensions` gains `.sh`; the docs now state the selection rule (the indexer must extract nodes or edges from the extension) rather than listing files that merely change.
- Failure messages filter the runtime's routine `level=info` chatter and keep the actionable error line.
- CI runs the test suite, not just the bundle manifest check.

### Fixed

- The Linux runtime path was hard-coded to two `/usr/*/lib/node_modules` locations, so every rebuild on a machine using the documented `install.sh` channel failed to spawn the CLI.
- `cordis.patch.yml` no longer requires `npx` on Linux (it also resolved `npx` through a Windows-only path expression and used `%TEMP%` ahead of `TMPDIR`).
- The MCP bridge config no longer passes `npx` arguments to a directly spawned executable.

## 0.2.0 - 2026-08-22

### Added

- Bridges the Codebase Memory MCP server into DSH via `@deepseek-ai/dsh-mcp-client`, exposing all `mcp__codebase_memory__*` tools natively.
- Second bundle id (`dsh-codebase-memory-watcher`) runs a chokidar watcher per project with debounced rebuilds through the global `codebase-memory-mcp` CLI.
- Watcher HTTP routes: list / status / start / stop / rebuild / restart / auto-attach / cli-info.
- Watcher state persists in `~/.dsh/dsh-codebase-memory/watcher.json` and is restored on DSH Web start unless explicitly stopped.
- Graph UI from the upstream server remains available at `http://127.0.0.1:9749`.
