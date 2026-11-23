# pi-router

极简 superagent（**Router**）的 Pi 扩展：只拆任务、派任务、收报告、记账。任务的内部拆解与执行
全部交给 [pi-subagents](https://github.com/earendil-works/pi-subagents) 的 `router-worker` 子代理。

装上本扩展后，**任何你主动打开的 Pi 会话就是一个只读 Router**：它只能读、查状态、派活，
物理上改不了文件；所有 Router（跨项目、跨会话）共享同一份记忆。

## 它做什么

- 9 个工具：
  - v1 记账：`router_task_open` / `router_task_update` / `router_task_list` /
    `router_memory_append` / `router_memory_read`
  - v2 只读与可见性：`router_inspect`（git-status / git-log / git-diff / tree）、
    `router_workers`（worker 的 runId / 状态 / session 路径）
  - v3 分层记忆：`router_note`（写当前会话短时记忆）、`router_task_get`（digest 里
    `read: task/<id>` 指针的目标）
- 注入路由规则与分层记忆（global → project → session → open tasks）到系统提示。
- `/router` 命令：`status` / `tasks` / `task <id>` / `memory [scope] [query]` / `digest` /
  **`new <目标>`** / **`spawn <id>`** / **`promote <行号> [global|project]`** / **`session`**。
- 账本 = 全局 `~/.pi/agent/router/tasks.json`（结构化事实）；记忆拆成四层：
  `global.md`、`projects/<project>.md`、`sessions/<sessionId>.json`、`audit.jsonl`。

## 安装

```bash
# 全局安装（推荐：任何目录的会话都会自动成为 Router）
cp -r pi-router ~/.pi/agent/extensions/pi-router

# 或者只给当前项目装（auto-discovery）
cp -r pi-router .pi/extensions/pi-router

# 开发时直接加载源码入口（无构建步骤）
pi -e ./src/index.ts
```

在 `.pi/config.json` 里也可以用 `"extensions": ["./src/index.ts"]` 显式引用本目录。

### 依赖

- 需要安装 **pi-subagents**，因为它提供 `subagent` 工具与 worker agent 运行时。
- 需要把 worker agent 放到 **`.pi/agents/router-worker.md`**（即本仓库 `agents/router-worker.md`）。
  其 frontmatter 必须允许 `read, write, edit, bash, grep, find, ls, subagent`（`subagent` 在末尾
  用于嵌套授权），并设 `extensions: []` 防止 worker 再加载 router 扩展。
  worker 侧不受只读限制，可以再开嵌套子代理。
- `@earendil-works/pi-coding-agent` 与 `typebox` 是 `peerDependencies`，运行时由 Pi 提供；
  本项目 `dependencies` 为空，不新增运行时依赖。

## 只读行为（v2）

Router 会话被三层限制，不只是提示词约束：

1. **工具白名单**：`session_start`（含 new/resume/fork/reload）与每轮 `before_agent_start`
   都会 `pi.setActiveTools(KEEP)`，Router 只保留
   `read`、`grep`、`find`、`ls`、`subagent`、9 个 `router_*` 工具。
2. **`router_inspect` 替代 bash**：固定 argv，只接受 `git-status` / `git-log` / `git-diff` / `tree`，
   不接受自由字符串与 shell 元字符；`limit` 夹在 1..500。
3. **`tool_call` 拦截兜底**：任何 `write*` / `edit*` / `apply*` / `bash` / `powershell`
   （以及宿主若提供的 `cp`/`mv`/`rm`）一律 block，理由以 `Router 只读` 开头。

> ⚠ 因此在 Router 会话里你**自己也不能手动改代码**——这是 v2 的目标行为。需要人工改写时，
> 用别的会话或在 `~/.pi/agent/router.json` 里设 `"routerReadOnly": false` 关掉只读（逃生开关）。

子会话（`PI_SUBAGENT_CHILD=1`）不加载本扩展，也不受这些限制。

## 记忆分层（v3）

记忆不再是一份 `memory.md`，而是四个存储位置（`<home>` 即账本根目录）：

| 层 | 路径 | 写入方 |
|---|---|---|
| 全局 | `global.md` | 人写 / `/router promote` 晋升；模型只读 |
| 项目 | `projects/<project>.md` | 人写 / `/router promote` 晋升；模型只读 |
| 会话 | `sessions/<sessionId>.json` | 模型可写（`router_note`）；会话启动清理 7 天前旧文件 |
| 审计 | `audit.jsonl` | 扩展代码 append-only；模型只读 |

注入系统提示前由 `assembleMemory` 组装成固定四段：`## global → ## project <name> →
## session → ## open tasks`。每层独立预算（默认 `global 800 / project 1200 / session 600 /
tasks 1400` 字符），总量封顶 4096 字符 / 60 行，末尾有一行
`budget: global X/800 · project X/1200 · session X/600 · tasks X/1400` 告诉模型被剪了多少。
tasks 层每行末尾追加 ` · read: task/<id>`，需要看完整任务就用 `router_task_get` 读取。

## 写权限（v3）

Router 的写能力按域收口：

- 模型只能写 **session 层**（`router_note`）与 **审计**（`router_memory_append`）。
- `router_memory_append` 语义已改变：只把 `kind:"note"` 追加到 `audit.jsonl`，**绝不写 global/project**。
- `global.md` / `projects/*.md` 只能由人写或通过 `/router promote` 晋升，模型永远只读。
- 所有文件写路径（任务、会话、晋升、迁移）都走 `tasks.lock`；审计是单行 `appendFile`（失败静默，不影响主流程）。

## /router promote

模型把值得长期保留的审计内容交给人确认，由人执行：

```text
/router promote <audit行号> [global|project]
```

- `<audit行号>` 从 1 开始，**倒序计数**（1 = 最新一行）。
- 目标缺省 `project`（追加到 `projects/<project>.md`）；`global` 追加到 `global.md`。
- 写入走文件锁，成功后 `notify`，并再写一条 `kind:"promote"` 审计。

## 账本位置与全局记忆

| 内容 | 默认路径 |
|---|---|
| 账本 | `~/.pi/agent/router/tasks.json` |
| 全局记忆 | `~/.pi/agent/router/global.md` |
| 项目记忆 | `~/.pi/agent/router/projects/<project>.md` |
| 会话记忆 | `~/.pi/agent/router/sessions/<sessionId>.json` |
| 审计 | `~/.pi/agent/router/audit.jsonl` |
| 锁 | `~/.pi/agent/router/tasks.lock` |
| 配置 | `~/.pi/agent/router.json` |

- 每个任务记录 `project`（`basename(realpath(cwd))`，同一物理项目不同层级路径归一）与
  `ownerSession`（创建它的会话 id），因此同一份账本能服务所有项目。
- 所有写路径（open / update / 会话 note / 晋升 / 迁移 / 自动记 runId）都在文件锁内执行：
  `tasks.lock` 用 `open(..., "wx")` 独占创建，25ms→200ms 指数退避、3s 超时、mtime 超过 10s
  视为陈旧并接管一次。读路径（digest / list / 命令）不取锁，接受最终一致。
- 写入是 temp + rename 原子替换；损坏账本会在**写路径的锁内**备份为 `tasks.json.bak-<ts>` 并以空账本继续，
  读路径（digest / list）只报 warning、不改盘。

### v2 → v3 记忆迁移

首次访问时，旧的 `memory.md` 会被拆分：带 `[project]` 的块落到
`projects/<project>.md`，不带 `[project]` 的块落到 `global.md`；原文保留，原文件改名为
`memory.md.migrated-<ts>`（不删除），并写一条 `kind:"migrate"` 审计。迁移幂等；解析失败时
保留原文件并返回 warning，不丢数据。

### 覆盖账本根目录

优先级（后面的被前面的覆盖）：环境变量 `PI_ROUTER_HOME` > `scope: "project"` 的 `<cwd>/.pi/router` >
配置 `home` > 默认 `~/.pi/agent/router`。即 `scope: "project"` 时 `home` 不生效，账本回到 v1 的
每项目目录（供不想全局共享的用户）。

```json
{
  "scope": "global",
  "home": "~/.pi/agent/router",
  "routerReadOnly": true,
  "workerModel": null,
  "maxOpenShown": 20,
  "progressThrottleMs": 60000
}
```

- `home` 支持 `~` 展开；建议写绝对路径或 `~` 形式。
- 配置读取失败（JSON 坏 / 字段类型错）只回退对应默认值并在输出里警告，不会崩溃。
- `workerModel` 只作为 digest 顶部一行 `worker model: <id>` 提示，扩展本身不派活、不改模型。
- `progressThrottleMs` 目前**预留**（只解析，不做节流）。

### v1 → v2 迁移

首次**写操作**时，扩展会把旧的项目账本 `<cwd>/.pi/router/tasks.json` 导入全局账本：
v1 任务补上 `project`（任务自己 `cwd` 的 `basename`，不是当前会话目录）与 `ownerSession: "migrated"`，
其余字段原样保留；
落盘成功后把旧文件改名为 `tasks.json.migrated-<ts>`（**不删除**，可回滚）。
迁移在锁内完成，用 `(key, createdAt)` 去重，崩溃后重跑不会重复导入。
digest / list 在读路径上也能立刻看到旧任务（内存导入，不落盘）。

回滚：把 `tasks.json.migrated-<ts>` 改回 `<cwd>/.pi/router/tasks.json` 即可；或把
`router.json` 设为 `"scope": "project"`，全局账本原样保留、不再读写。

## Worker 可见性

- 派活后不必手写 `runId`：`subagent` 成功的 `tool_result` 会自动提取
  `details.runId` / `details.runs[0].runId` / `details.childRunId`，再按以下规则绑定到账本任务：
  1. 候选 = `queued` 且无 `runId` 的任务；只有一个就直接绑定；
  2. 多个时优先匹配派发文本里包含其 `goal` 的候选（忽略大小写/空白；`goal` 少于 8 字符不参与）；
  3. 仍无法区分则取**最新创建**的候选，并把「绑给了谁」追加到工具结果里告知模型。
  绑定时任务置 `running`。候选为 0（或任务已有 `runId`）则不动作。
- 注意：这条启发式在「先开很多任务、再逐个派发」的极端并行下可能绑错；需要精确控制时
  显式调 `router_task_update { id, runId }` 覆盖即可（后写生效）。
- `router_workers { status?: "active" | "done" | "all" }`（默认 `active`）列出 worker 的
  runId、state、session 路径与最后一条报告。运行目录发现顺序（逐个 `stat`，取第一个存在的）：
  1. `PI_SUBAGENTS_RUN_DIR`（显式覆盖；它本身或其 `async-subagent-runs` 子目录）
  2. `PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs`
  3. `<tmpdir>/pi-subagents-<scopeId>/async-subagent-runs`，`scopeId` 与 pi-subagents 同规则：
     有 `getuid` 时 `uid-<N>`，否则 `user-<USERNAME/USER/LOGNAME>` → `home-<USERPROFILE/HOME>` → `shared`
  4. 以上都不存在时，`router_workers` 仍显示账本信息并提示「运行目录未找到」

  只读探测，绝不修改运行目录。
- 要看过程用 `subagent({ action: "status", id, options: { view: "transcript" } })`。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test：store / guard / config / workers / memory 五个文件
```

扩展由 Pi 直接加载 TypeScript（无构建步骤）；`tsconfig.json` 只用于类型检查。

## 设计边界

- Router 只在 Pi **主会话**生效（`PI_SUBAGENT_CHILD === "1"` 守卫），worker 子会话不会加载本扩展。
- Router **不**自行 spawn 子进程、不实现 subagent 运行时、不包装内部调用 `subagent` 的 dispatch 工具；
  派发由模型直接调用 pi-subagents 已暴露的 `subagent({ agent: "router-worker", task, cwd, worktree })`。
- 无 GitHub 轮询、无 web 服务、无 daemon；除 `typescript`/`@types/node` 外无运行时依赖。
- 不轮询不 sleep；子代理完成后报告会自动唤醒主会话。