# Runtime resolution order: probe the environment, don't pin a path

The plugin needs the `codebase-memory-mcp` executable, but upstream distributes it through five channels that land in five different places (`install.sh` → `~/.local/bin`, npm global → `<npm root -g>/codebase-memory-mcp/bin/`, PyPI, AUR, `npx`), and only one of them (`npx`) exists on Windows. So resolution probes in a fixed order — explicit override, configured path, `PATH`, known install locations, then `npx` — and reports which rule matched through `cli-info.source`.

## Considered options

- **Hard-code the npm global path.** This is what the plugin did before the Linux port: `%APPDATA%\npm\node_modules\…` on Windows and two `/usr/*/lib/node_modules/…` guesses elsewhere. Every channel except npm global therefore resolved to a nonexistent file, and the failure surfaced as an opaque spawn error inside a rebuild.
- **Make `npx` the only channel.** Reproducible on paper, but it turns every start into a network download of a 39 MB release archive — and fails outright wherever release-asset downloads are blocked or DNS-shadowed, even when a perfectly good binary is already installed.
- **Probe the environment (chosen).** One code path covers every official channel, prefers what the operator already installed, and degrades to `npx` only when nothing else exists.

## Consequences

- A machine with two runtimes installed (say `~/.local/bin` and `/usr/local/bin`) silently uses whichever `PATH` names first. That is intentional: `PATH` is the operator's stated preference. Pinning a specific one is what `CODEBASE_MEMORY_MCP_BIN` and `config.executable` are for.
- Setting both overrides to *different* paths is a hard error rather than a precedence rule, because silently picking one turns a configuration mistake into a mystery.
- When nothing matches, the error names every location searched. An unhelpful "not found" costs more than the extra line of message.
- The MCP bridge in `cordis.patch.yml` cannot reuse the probe: its config is evaluated by the loader's `!!js` sandbox, which exposes only Node globals (no `require`, no `fs`). It therefore resolves `CODEBASE_MEMORY_MCP_BIN` or the bare executable name through `PATH` — and has no `npx` fallback, because `spawn` does not retry a second command. The watcher bundle, being real code, carries the full ladder.
