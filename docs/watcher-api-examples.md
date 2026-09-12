# Watcher API examples

All routes are registered under `/api/dsh-codebase-memory/watcher/*` when the webServer service is available. Examples below assume the default loopback address (the routes reject anything that is not a loopback request).

```bash
base=http://127.0.0.1:3080/api/dsh-codebase-memory/watcher

# List every persisted watcher with status and last-run info
curl -s "$base/list"

# Start a watcher for one repository (the trailing slash never creates a second watch)
curl -s -X POST "$base/start" -H 'content-type: application/json' \
  -d '{"repoPath":"/home/you/src/demo"}'

# Start a watcher on a WSL2 DrvFs mount and force polling explicitly
curl -s -X POST "$base/start" -H 'content-type: application/json' \
  -d '{"repoPath":"/mnt/d/src/demo","usePolling":true}'

# Force an immediate rebuild
curl -s -X POST "$base/rebuild" -H 'content-type: application/json' -d '{"id":"<id>"}'

# Recreate watchers for every project the MCP server already knows
curl -s -X POST "$base/auto-attach"

# Show which runtime will be used for rebuilds, and how it was found
curl -s "$base/cli-info"
# {"ok":true,"executable":"/home/you/.local/bin/codebase-memory-mcp","source":"path"}
```

PowerShell equivalents:

```powershell
$base = 'http://127.0.0.1:3080/api/dsh-codebase-memory/watcher'
Invoke-RestMethod ($base + '/list')
Invoke-RestMethod -Uri ($base + '/start') -Method Post -ContentType 'application/json' -Body '{"repoPath":"D:\\src\\demo"}'
Invoke-RestMethod -Uri ($base + '/rebuild') -Method Post -ContentType 'application/json' -Body '{"id":"<id>"}'
Invoke-RestMethod -Uri ($base + '/auto-attach') -Method Post
Invoke-RestMethod ($base + '/cli-info')
```

## Troubleshooting

- **Edits are not picked up**: check `/list` for `status`, `lastError` and `usePolling`. Watches on WSL2 DrvFs (`/mnt/*`), NFS, FUSE, CIFS and SMB enable polling automatically (`pollingForcedBy` names the reason); anything else needs `usePolling: true` on that watch. Polling costs CPU and disk activity.
- **Watchers are missing after a host restart**: only watchers you did not explicitly stop are restored automatically. Use `/restart` to relaunch non-stopped ones or `/auto-attach` to cover every known MCP project.
- **Rebuild fails with `<path> is outside the allowed root`**: the runtime only indexes allow-listed roots. Grant access deliberately with `codebase-memory-mcp allow-root <path>`, and review the list with `allow-root --list`. The plugin never widens it for you.
- **Rebuilds fail with CLI errors**: `/cli-info` reports the resolved runtime and the rule that found it (`config`, `env`, `path`, `known-location`, `npx`). If it reports `npx`, install the runtime directly — the npx fallback needs to download a release archive and fails wherever those downloads are blocked.
- **`/cli-info` returns a path that does not exist**: the plugin probes, so a stale file can win. Pin the correct one with `CODEBASE_MEMORY_MCP_BIN` and restart the host.
