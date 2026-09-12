# DSH Codebase Memory

[中文文档](README.zh.md) | English

Local DSH bundle that connects [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp) through the official `@deepseek-ai/dsh-mcp-client` bridge, and ships a file-system watcher that keeps the knowledge graph fresh.

## Runtime

- `codebase-memory-mcp@0.10.8`
- MCP namespace: `mcp__codebase_memory__*`
- Graph UI: http://127.0.0.1:9749

The plugin does not bundle the runtime and does not pin one download channel. It resolves an existing executable, in this order:

| # | Source | How |
|---|---|---|
| 1 | `CODEBASE_MEMORY_MCP_BIN` | Explicit override for non-standard installs. |
| 2 | `config.executable` | Per-install configuration (watcher bundle only). |
| 3 | `PATH` | `codebase-memory-mcp`, the location every documented channel uses: `~/.local/bin` (install.sh), the npm global bin directory, `pkg`/`AUR`/`PyPI` wrappers. Windows resolves `.exe`/`.cmd` through `PATHEXT`. |
| 4 | Known locations | `$XDG_BIN_HOME` or `~/.local/bin`, `~/.local/share/pnpm`, the npm global roots. |
| 5 | `npx` | Last resort. Runs `npx -y codebase-memory-mcp@0.10.8`, which downloads the release archive — see the network caveat below. |

`GET /api/dsh-codebase-memory/watcher/cli-info` reports both the resolved path and which rule matched (the `source` field). If nothing matches, the plugin fails with the list of locations it searched instead of guessing.

Setting both `CODEBASE_MEMORY_MCP_BIN` and `config.executable` to *different* paths is treated as a configuration error, not a tie to break silently.

The MCP bridge in `cordis.patch.yml` uses `CODEBASE_MEMORY_MCP_BIN` or the bare `codebase-memory-mcp` name and relies on `PATH` (`spawn` does not retry a second command, so there is no npx fallback on the bridge side — the watcher has one).

### Verified release artifacts

| Artifact | SHA-256 |
|---|---|
| `codebase-memory-mcp-linux-amd64-portable.tar.gz` (39,510,096 bytes) | `6eef49652bc0c7820f43114125044d40bf7f4d97c11b2592f6b0f6a307702325` |
| `codebase-memory-mcp-linux-amd64.tar.gz` (dynamically linked) | `e5cba4cad6ca8254a85f45041fc8a831908d7d5cb64f98fc3f8eb70a58671793` |
| `codebase-memory-mcp` (Linux x64, unpacked from the portable archive) | `1175645cb30560e7e47d78611cd1bcb509478eaf6d4e51f72fe18327ee9c1351` |

Upstream ships the `-portable` static build on Linux on every official channel; the non-portable binary dynamically links glibc 2.38+ and fails on older distributions (Debian 11, RHEL 8, Ubuntu 20.04).

## Tool rendering in the Web UI

The 15 `mcp__codebase_memory__*` calls do not render as raw text. The package ships a browser half that registers one keyed `tool.call.toolview` entry per tool name — the documented extension point for owning how a tool's calls appear inside a turn.

Each card shows a status dot, the operation name, a one-line summary of what the call answered, and result chips (row counts, node/edge totals, truncation). Clicking the head discloses a body dispatched by tool:

| Tool | Body |
|---|---|
| `search_graph`, `search_code` | symbol + `file:line` rows; clicking opens the file at that line |
| `trace_path` | qualified-name groups with hop badges, callees and callers separated |
| `get_architecture`, `detect_changes` | one section per report section, each carrying the columns it declares |
| `get_code_snippet` | code card: symbol, kind, fan-in/out, line-numbered source, copy button |
| `index_status`, `index_repository`, `list_projects` | key/value grid, nested collections collapsed to counts |
| `check_index_coverage` | per-scope verdicts with a metadata-soundness marker |
| `get_graph_schema` | node label and edge type tables, properties on demand |

Anything unrecognised — including a future upstream format — falls back to plain text rather than inventing structure. A result that arrives truncated says so at the bottom of the card, because a silently partial answer reads like a complete one.

Two implementation notes for anyone editing it:

- **No build step.** The client half is authored directly in the `__ModuleLoader__` shape the client module system registers, importing react through the injected `require`. Edit `lib/client.js`, reload the page. The stylesheet is scoped to `.cbm-*`, inherits colour so both themes work, and honours `prefers-reduced-motion`.
- **The parsers carry the risk**, so `tests/client.test.mjs` drives them with verbatim tool output. Two rules those tests exist to protect: a JSON payload must not be mistaken for `key: value` lines, and a trailing number is a hop distance only when the section did not declare it as a column.

The host-side declaration lives in `package.json`: `exports["./client"]` names the browser entry and `dsh.client` records the platform plus the client packages it needs (`@deepseek-ai/dsh-client-ui-renderer` for the slot registry, `@deepseek-ai/dsh-client-ui-tool` for the contract). Note that `dsh.client.inject` lists *package* names for the module graph, while the browser entry's own `inject` lists *service* names (`slots`) — two separate declarations that both have to be right.

## Bundles

The package registers two Cordis bundles in `cordis.patch.yml`:

| Bundle id | Purpose |
|---|---|
| `mcp-codebase-memory` | Bridges the upstream MCP server into DSH so all `mcp__codebase_memory__*` tools (search_graph, detect_changes, get_architecture, index_repository, …) are exposed natively. |
| `dsh-codebase-memory-watcher` | Same package, second bundle id; spins up a chokidar watcher per project, debounces file edits, and re-runs `index_repository` via the runtime's CLI. |

The watcher never owns the MCP client connection — it shells out to `<runtime> cli index_repository` for each rebuild, with the JSON arguments piped over **stdin** (the positional raw-JSON form is deprecated upstream and breaks on paths containing quotes). Shelling out keeps indexing isolated from bridge failures.

## Watcher routes (auto-registered when `webServer` is available)

| Method + path | Body / query | Effect |
|---|---|---|
| `GET /api/dsh-codebase-memory/watcher/list` | – | List every persisted watcher with `status`, `lastRun`, `lastDurationMs`, `lastError`, … |
| `GET /api/dsh-codebase-memory/watcher/status?id=<id>` | – | Same payload for a single watcher. |
| `POST /api/dsh-codebase-memory/watcher/start` | `{ repoPath, debounceMs?, mode?, ignored?, watchedExtensions?, usePolling? }` | Start a watcher (persists state, returns the new `id`). |
| `POST /api/dsh-codebase-memory/watcher/stop` | `{ id }` or `?id=` | Stop + mark stopped (state kept). |
| `POST /api/dsh-codebase-memory/watcher/rebuild` | `{ id }` | Trigger an immediate rebuild regardless of pending edits. |
| `POST /api/dsh-codebase-memory/watcher/restart` | – | Restart every non-stopped watcher from persisted state. |
| `POST /api/dsh-codebase-memory/watcher/auto-attach` | – | Call `list_projects` on the MCP server and start a watcher for each project not already covered. |
| `GET /api/dsh-codebase-memory/watcher/cli-info` | – | Report the resolved runtime path and the rule that found it. |

### Defaults (configurable in `cordis.patch.yml`)

- `debounceMs`: `5000` (5 s quiet period before rebuild)
- `mode`: `moderate` (type-aware LSP call/usage resolution; `fast` skips similarity, `full` enables similarity + every file)
- `autoAttach`: `true` (start a watcher for every project the MCP server already knows at boot)
- `usePolling`: `false` (native file notifications by default; see the mount rule below)
- `ignored`: `**/node_modules/**`, `**/.git/**`, `**/dist/**`, `**/build/**`, `**/.next/**`, `**/.turbo/**`, `**/.codebase-memory/**`, `**/.pnpm-store/**`, `**/target/**`, `**/__pycache__/**`, `**/.venv/**`
- `watchedExtensions`: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.rb`, `.php`, `.sh`, `.vue`, `.svelte`

An extension belongs on that list when the upstream indexer extracts nodes or edges from it — not merely because the file can change. Lockfiles and generated JSON are deliberately excluded: `pnpm install` would otherwise trigger a full rebuild.

Per-repository overrides go through `POST /watcher/start`; the body fields win over the configured defaults.

## Platform notes

### Path identity

A repository's identity is **case-sensitive on POSIX** and case-insensitive on Windows. `/srv/Repo` and `/srv/repo` are two different watches on Linux; folding their case (as earlier versions did) silently dropped one of them. Paths are canonicalized (`realpath`, falling back to a lexical absolute path) and a trailing slash never creates a second watch.

Ignore *patterns* are matched case-insensitively on Windows and case-sensitively on POSIX — pattern matching and identity are deliberately separate rules.

### Polling on cross-VM mounts

When a watch is created, the plugin inspects the filesystem type. On **WSL2 DrvFs mounts** (`/mnt/c`, `/mnt/d`, …, filesystem type `9p`) native notifications are unreliable, so polling is enabled for that watch and the record carries `pollingForcedBy: "9p"`. The same applies to NFS, FUSE, CIFS and SMB shares.

An explicit `usePolling` (route body, or `config.usePolling: true`) always wins — automatic detection only fills in the value nobody set.

### State persistence

Watcher records live in `$DSH_HOME/dsh-codebase-memory/watcher.json` (`$DSH_HOME` defaults to `~/.dsh`) and are written with owner-only permissions where the platform supports them. The file is versioned; version 1 files (Windows-style case-folded paths) are migrated in place on first load without rewriting the configured paths. Plugin disposal closes live handles without changing the persisted intent; the next DSH Web start re-creates every watcher that the user did not explicitly stop.

## Install

Download the newest `dsh-codebase-memory-*.tgz` from [Releases](https://github.com/andyfan1094/dsh-codebase-memory/releases) and add it to the profile:

```bash
dsh plugin --profile web add ~/downloads/dsh-codebase-memory-0.3.0.tgz
```

For local development, install from a checkout instead (absolute paths only):

```bash
dsh plugin --profile web add link:/home/you/src/dsh-codebase-memory
```

PowerShell equivalents:

```powershell
dsh plugin --profile web add D:\downloads\dsh-codebase-memory-0.3.0.tgz
dsh plugin --profile web add link:D:/src/dsh-codebase-memory
```

Restart the DSH Web host after installation. `dsh plugin …` forwards to the profile's package manager (pnpm), so the usual pnpm rules apply.

## Remove

```bash
dsh plugin --profile web remove dsh-codebase-memory
```

The runtime is installed separately and is not touched by the plugin:

```bash
npm uninstall -g codebase-memory-mcp          # npm channel
rm ~/.local/bin/codebase-memory-mcp           # install.sh channel
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `codebase-memory-mcp not found` at boot | No runtime on `PATH` or in the known locations. Install it (`curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh \| bash`) or set `CODEBASE_MEMORY_MCP_BIN`. |
| `connect ECONNREFUSED 127.0.0.1:443` from the npx fallback | A local resolver is sinkholing `release-assets.githubusercontent.com` to loopback, so the download leg cannot work. Install the runtime directly instead of relying on `npx`; `api.github.com` and `raw.githubusercontent.com` are unaffected. |
| `<path> is outside the allowed root` | The upstream runtime only indexes allow-listed roots. Grant it deliberately: `codebase-memory-mcp allow-root <path>`, or `allow-root --list` to review the current list. |
| Watcher stays `idle` and never rebuilds | The filesystem does not deliver change events (WSL2 `/mnt/*`, network shares). Automatic detection covers DrvFs/NFS/FUSE/CIFS; for anything else set `usePolling: true` on that watch. |
| `mcp__codebase_memory__*` tools missing from the session | The bridge gave up starting. It logs a `warn` and, with `failOnStartupError: false`, the Host keeps booting without the tools. Check for a live child of the Host (`pgrep -P <host-pid> codebase-memory-mcp`); no process means the spawn failed. The usual cause is a config `cwd` pointing at a directory that does not exist (a session subdir under `/tmp`, wiped on reboot) — remove the `cwd` override and restart the Host. Ten failed reconnect attempts is all it takes; it does not keep retrying after that. |
| `CBM_CACHE_DIR` rejected on WSL | DrvFs mounts are world-writable (`0777`), and the runtime refuses a private cache under them (upstream issue [#1687](https://github.com/DeusData/codebase-memory-mcp/issues/1687)). Keep the cache on the Linux filesystem — the default `~/.cache/codebase-memory-mcp` is fine. |
| Rebuilds feel slow | Each CLI call pays a fixed startup cost. Measured on Linux x64: ~5.5 s end to end with no warm daemon, ~4.5 s with one running (`codebase-memory-mcp daemon start`) — the daemon removes the boot cost, not the CLI's own per-invocation work. The plugin deliberately does not manage that lifecycle. Budget accordingly: indexing a mid-size repo takes tens of seconds. |

## When the agent should reach for the graph (token cost)

The 15 `mcp__codebase_memory__*` tools cost nothing until they are called, and return compact structured payloads. `read`-ing a large file or running an unbounded `grep` costs an unpredictable amount — often thousands of tokens in one shot. Routing the structural questions to the graph therefore cuts both latency and token spend:

| Question shape | Use | How to keep it cheap |
|---|---|---|
| "Who calls X?" / "What breaks if I change X?" | `trace_path` (inbound/outbound), `detect_changes` | Keep `depth` at 2–3, raise `limit` only if truncated |
| Architecture, layering, entry points, hotspots | `get_architecture` | **Always name `aspects` explicitly.** Never `["all"]` — it dumps everything at once |
| Semantic lookup ("where is the retry logic?") | `search_graph` | Start with `detail:"ids"` and the default limit, then `get_code_snippet` a few candidates |
| Multi-hop structural queries, complexity hotspots | `query_graph` | **Write your own `LIMIT`** (the ceiling is 100k rows), and return only the columns you need |
| Reading one symbol | `get_code_snippet` | Cheaper than reading the whole file |

Do **not** use the graph to see what code currently looks like (the index lags the working tree — debounce plus index time), for a small edit whose location you already know, or to verify a change you just made. On failure or an empty result, fall back to `read`/`grep` and say so rather than retrying the same call.

## Verification

```bash
pnpm test          # unit + integration tests (node --test)
pnpm check         # syntax check every source file
pnpm validate:linux  # acceptance driver: loads the plugin with a stub ctx,
                     # exercises the real routes, and runs a real CLI round trip
```

`pnpm validate:linux` accepts `--no-index` (skip graph writes), `--repo <path>`, `--polling` and `--keep`.

## Screenshots

![dsh-codebase-memory screenshot](docs/screenshots/codebase-memory-cli.png)
