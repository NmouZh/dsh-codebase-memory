# Repository path identity is platform-aware, and separate from pattern matching

A watch record's identity — "is this the same repository as that one?" — is case-*sensitive* on POSIX and case-insensitive on Windows, and is computed by canonicalizing the path (`realpath`, falling back to a lexical absolute path). Ignore-pattern matching keeps the opposite rule: case-insensitive on Windows, case-sensitive on POSIX. The two rules live in separate functions because collapsing them into one `toLowerCase()` is what broke Linux.

## Considered options

- **Keep one case-folded normalization for both (the previous behavior).** `/srv/Repo` and `/srv/repo` became the same key, so starting a watch on the second repository silently reused the first repository's record — a watch that looks healthy while indexing the wrong tree. It also meant a `**/node_modules/**` pattern could never be expressed case-sensitively, which is the correct behavior on a case-sensitive filesystem.
- **Fold case everywhere except on POSIX, but keep one shared function.** Half-fixes it: the function would need to know which question it is answering anyway, which is exactly the argument for two functions.
- **Resolve symlinks for identity (chosen, together with the platform split).** Two paths that reach the same directory must share one watch, so identity resolves `realpath` when the path exists. Records still store the path the operator configured, and the canonical key is additive (`pathKey`), so migration never rewrites a user's configuration.

## Consequences

- A watch record persists both the configured `repoPath` (for display and CLI calls) and a canonical `pathKey` (for identity). State files written by v1 are re-keyed on first load and rewritten as version 2.
- `usePolling` detection and mount classification live in the same module, since they are also platform questions — WSL2 DrvFs mounts (`9p`) lose inotify events silently, so watches created there poll unless the operator set `usePolling` explicitly.
- Case-insensitive matching still applies to *patterns* on Windows; a test asserting the POSIX behavior of a pattern and the Windows behavior of an identity are both correct, and each is skipped on the other platform.
