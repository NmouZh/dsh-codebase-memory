# DSH Codebase Memory（代码库记忆）

[English](README.md) | 中文

本地 DSH bundle，通过官方 `@deepseek-ai/dsh-mcp-client` 桥接 [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp)，并内置一个文件系统 watcher，让知识图谱随代码变更保持最新。

## 运行时

- `codebase-memory-mcp@0.10.8`
- MCP 命名空间：`mcp__codebase_memory__*`
- 图谱 UI：http://127.0.0.1:9749

本插件不捆绑运行时，也不锁定某一条下载渠道，而是**解析已安装的可执行文件**，顺序如下：

| # | 来源 | 说明 |
|---|---|---|
| 1 | `CODEBASE_MEMORY_MCP_BIN` | 非标准安装位置的显式覆盖。 |
| 2 | `config.executable` | 按安装配置（仅 watcher bundle）。 |
| 3 | `PATH` | `codebase-memory-mcp`。所有官方渠道都落在这里：`~/.local/bin`（install.sh）、npm 全局 bin 目录、`pkg`/`AUR`/`PyPI` 的包装器。Windows 通过 `PATHEXT` 解析 `.exe`/`.cmd`。 |
| 4 | 已知安装位 | `$XDG_BIN_HOME` 或 `~/.local/bin`、`~/.local/share/pnpm`、各 npm 全局根目录。 |
| 5 | `npx` | 最后兜底。执行 `npx -y codebase-memory-mcp@0.10.8`，会去下载 release 包——注意下面的网络坑。 |

`GET /api/dsh-codebase-memory/watcher/cli-info` 同时报告解析到的路径与命中的规则（`source` 字段）。全部落空时，插件会报出它搜过的位置，而不是瞎猜一个。

把 `CODEBASE_MEMORY_MCP_BIN` 与 `config.executable` 设成**两个不同**路径会被判为配置错误，而不是静默择一。

`cordis.patch.yml` 里的 MCP 桥使用 `CODEBASE_MEMORY_MCP_BIN` 或裸命令名 `codebase-memory-mcp`，依赖 `PATH` 解析（`spawn` 不会自动重试第二条命令，所以桥这一侧没有 npx 兜底——watcher 那侧有）。

### 已核验的发布件

| 发布件 | SHA-256 |
|---|---|
| `codebase-memory-mcp-linux-amd64-portable.tar.gz`（39,510,096 字节） | `6eef49652bc0c7820f43114125044d40bf7f4d97c11b2592f6b0f6a307702325` |
| `codebase-memory-mcp-linux-amd64.tar.gz`（动态链接） | `e5cba4cad6ca8254a85f45041fc8a831908d7d5cb64f98fc3f8eb70a58671793` |
| `codebase-memory-mcp`（Linux x64，从 portable 包解开） | `1175645cb30560e7e47d78611cd1bcb509478eaf6d4e51f72fe18327ee9c1351` |

上游在 Linux 的所有官方渠道都发 `-portable` 静态件；非 portable 的动态链接件要求 glibc ≥ 2.38，在旧发行版（Debian 11、RHEL 8、Ubuntu 20.04）上无法启动。

## Bundle 注册

本包在 `cordis.patch.yml` 中注册两个 Cordis bundle：

| Bundle id | 用途 |
|---|---|
| `mcp-codebase-memory` | 把上游 MCP 服务器桥接进 DSH，原生暴露全部 `mcp__codebase_memory__*` 工具（search_graph、detect_changes、get_architecture、index_repository 等）。 |
| `dsh-codebase-memory-watcher` | 同一包内的第二个 bundle：为每个项目启动 chokidar watcher，防抖文件变更后通过运行时 CLI 重新执行 `index_repository`。 |

watcher 不持有 MCP 客户端连接——每次重建都调 `<运行时> cli index_repository`，JSON 参数走 **stdin**（位置式裸 JSON 参数上游已废弃，且仓库路径含引号时会崩）。走子进程让索引与桥的故障互相隔离。

## Watcher 路由（webServer 可用时自动注册）

| 方法 + 路径 | 请求体 / 查询参数 | 效果 |
|---|---|---|
| `GET /api/dsh-codebase-memory/watcher/list` | – | 列出全部持久化 watcher，含 `status`、`lastRun`、`lastDurationMs`、`lastError` 等 |
| `GET /api/dsh-codebase-memory/watcher/status?id=<id>` | – | 返回单个 watcher 的相同载荷 |
| `POST /api/dsh-codebase-memory/watcher/start` | `{ repoPath, debounceMs?, mode?, ignored?, watchedExtensions?, usePolling? }` | 启动 watcher（持久化状态，返回新 `id`） |
| `POST /api/dsh-codebase-memory/watcher/stop` | `{ id }` 或 `?id=` | 停止并标记 stopped（保留状态） |
| `POST /api/dsh-codebase-memory/watcher/rebuild` | `{ id }` | 忽略待处理变更，立即触发一次重建 |
| `POST /api/dsh-codebase-memory/watcher/restart` | – | 按持久化状态重启所有非 stopped watcher |
| `POST /api/dsh-codebase-memory/watcher/auto-attach` | – | 调 MCP 服务器的 `list_projects`，为尚未覆盖的每个项目启动 watcher |
| `GET /api/dsh-codebase-memory/watcher/cli-info` | – | 报告解析到的运行时路径**与命中规则** |

### 默认值（可在 `cordis.patch.yml` 配置）

- `debounceMs`：`5000`（5 秒静默期后重建）
- `mode`：`moderate`（类型感知 LSP 调用/使用解析；`fast` 跳过相似度，`full` 启用相似度并索引全部文件）
- `autoAttach`：`true`（启动时为 MCP 服务器已知的每个项目自动开 watcher）
- `usePolling`：`false`（默认原生文件通知；见下方挂载盘规则）
- `ignored`：`**/node_modules/**`、`**/.git/**`、`**/dist/**`、`**/build/**`、`**/.next/**`、`**/.turbo/**`、`**/.codebase-memory/**`、`**/.pnpm-store/**`、`**/target/**`、`**/__pycache__/**`、`**/.venv/**`
- `watchedExtensions`：`.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs`、`.py`、`.go`、`.rs`、`.java`、`.cs`、`.rb`、`.php`、`.sh`、`.vue`、`.svelte`

一个扩展名该不该进这份清单，判据是**上游索引器会不会从中抽取节点/边**，而不是「这个文件会不会变」。lockfile 与生成的 JSON 被刻意排除：否则一次 `pnpm install` 就会触发整库重建。

按仓库覆盖走 `POST /watcher/start`，请求体字段优先于配置默认值。

## 平台说明

### 路径身份

仓库身份在 **POSIX 上大小写敏感**，在 Windows 上不敏感。Linux 上 `/srv/Repo` 与 `/srv/repo` 是两个不同的 watcher；把大小写折叠掉（早期版本的做法）会静默吞掉其中一个。路径会被规范化（`realpath`，失败时退回词法绝对路径），结尾斜杠不会再产生第二个 watcher。

忽略**模式**的匹配在 Windows 上大小写不敏感、在 POSIX 上敏感——「模式匹配」与「身份判定」是刻意分开的两条规则。

### 跨 VM 挂载盘的轮询

创建 watcher 时会检查文件系统类型。在 **WSL2 的 DrvFs 挂载**（`/mnt/c`、`/mnt/d` 等，类型 `9p`）上原生事件通知不可靠，因此该 watcher 自动启用轮询，记录里带 `pollingForcedBy: "9p"`。NFS、FUSE、CIFS、SMB 同理。

显式传入的 `usePolling`（路由请求体或 `config.usePolling: true`）永远优先——自动探测只填「没人设过」的那个值。

### 状态持久化

watcher 记录保存在 `$DSH_HOME/dsh-codebase-memory/watcher.json`（`$DSH_HOME` 默认 `~/.dsh`），在支持的平台上以仅所有者可读的权限写入。文件带版本号；version 1（Windows 风格折叠路径）会首次加载时原地迁移，且**不改写**用户配置的路径。插件卸载时只关闭运行中的句柄、不改持久化意图；下次 DSH Web 启动会重建所有未被用户显式停止的 watcher。

## 安装

从 [Releases](https://github.com/andyfan1094/dsh-codebase-memory/releases) 下载最新的 `dsh-codebase-memory-*.tgz` 并加入 profile：

```bash
dsh plugin --profile web add ~/downloads/dsh-codebase-memory-0.2.2.tgz
```

本地开发可改用 checkout 链接安装（必须绝对路径）：

```bash
dsh plugin --profile web add link:/home/you/src/dsh-codebase-memory
```

PowerShell 写法：

```powershell
dsh plugin --profile web add D:\downloads\dsh-codebase-memory-0.2.2.tgz
dsh plugin --profile web add link:D:/src/dsh-codebase-memory
```

安装后重启 DSH Web 宿主。`dsh plugin …` 会转发给该 profile 的包管理器（pnpm），常规 pnpm 规则照旧。

## 卸载

```bash
dsh plugin --profile web remove dsh-codebase-memory
```

运行时是独立安装的，插件不会动它：

```bash
npm uninstall -g codebase-memory-mcp          # npm 渠道
rm ~/.local/bin/codebase-memory-mcp           # install.sh 渠道
```

## 排障

| 现象 | 原因与处理 |
|---|---|
| 启动时报 `codebase-memory-mcp not found` | `PATH` 与已知安装位都没有运行时。安装它（`curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh \| bash`）或设 `CODEBASE_MEMORY_MCP_BIN`。 |
| npx 兜底报 `connect ECONNREFUSED 127.0.0.1:443` | 本机解析器把 `release-assets.githubusercontent.com` 打到回环，下载这一环走不通。请直接安装运行时，别依赖 `npx`；`api.github.com` 与 `raw.githubusercontent.com` 不受影响。 |
| `<path> is outside the allowed root` | 上游运行时只索引白名单内的根。需要时显式授权：`codebase-memory-mcp allow-root <path>`，`allow-root --list` 可查看当前清单。 |
| watcher 一直 `idle`、从不重建 | 该文件系统不投递变更事件（WSL2 的 `/mnt/*`、网络共享）。DrvFs/NFS/FUSE/CIFS 已自动覆盖；其他情况给该 watcher 设 `usePolling: true`。 |
| WSL 上 `CBM_CACHE_DIR` 被拒 | DrvFs 挂载是 `0777` 世界可写，运行时会拒绝把私有缓存放在其下（上游 issue [#1687](https://github.com/DeusData/codebase-memory-mcp/issues/1687)）。缓存留在 Linux 文件系统上，默认的 `~/.cache/codebase-memory-mcp` 即可。 |
| 每次重建都有几秒额外开销 | 每次 CLI 调用会起一个临时 daemon。跑一次 `codebase-memory-mcp daemon start` 保持常驻即可。插件刻意不托管这个生命周期。 |

## 验证

```bash
pnpm test            # 单元 + 集成测试（node --test）
pnpm check           # 逐个源文件语法检查
pnpm validate:linux  # 验收驱动：用桩 ctx 加载插件、跑真实路由、并做一次真 CLI 往返
```

`pnpm validate:linux` 支持 `--no-index`（跳过写图谱）、`--repo <path>`、`--polling`、`--keep`。

## 截图

![dsh-codebase-memory 截图](docs/screenshots/codebase-memory-cli.png)
