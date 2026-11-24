# pi-router

[![ci](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml/badge.svg)](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A minimal **superagent** for the [pi coding agent](https://github.com/badlogic/pi-mono): the main session becomes a read-only **Router** that dispatches self-contained tasks to `pi-subagents` workers, while a three-layer memory keeps track of what happened.

> **0.4.0 — first public release.** Small, opinionated, still `0.x`: the API may change.
> Built and reviewed over several internal milestones; their design specs and review
> logs remain in the git history.

---

## English

### What it is

pi-router turns the session you are talking to into a dispatcher, not an implementer:

```
you ──► Router (this session, read-only)
          │  decides what to delegate, writes the brief
          ▼
        subagent({ agent: "router-worker", ... })     ← pi-subagents runs it
          │
          ▼
        worker (its own session: write/edit/bash, may spawn nested subagents)
          │
          └──► final report ──► Router records it in the ledger
```

The Router **cannot modify files**: `write` / `edit` / `bash` are removed from its tool set, so it can only read, inspect, dispatch, and keep records. Workers keep full capabilities.

### Requirements

| Requirement | Why |
|---|---|
| [pi](https://github.com/badlogic/pi-mono) `>= 1.5` | host runtime |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | it provides the `subagent` tool and the worker runtime; **without it the Router can only keep records, not dispatch** |
| Node.js `>= 20` | pi loads the extension as TypeScript itself; the **test suite** needs `>= 22.6` (native type stripping), and CI runs `tsc` on 20, the suite on 22/24 |

```bash
pi install npm:pi-subagents
pi install git:github.com/<you>/pi-superagent-router   # private: SSH or `gh auth` required
```

The `router-worker` agent ships inside the package and is picked up automatically through
`package.json` → `"pi": { "subagents": { "agents": ["./agents"] } }`. No manual copy needed.

Verify the install:

```
pi -p "list your router_* tools; is write available? is agent router-worker listed?"
```

Expect the nine `router_*` tools, no `write`, and `router-worker` in the agent list.

### Quick start

```bash
cd your-project
pi
```

```
/router new add a CONTRIBUTING.md and link it from the README
/router status
/router task t1
```

Or just describe the goal — the Router follows the same flow.

### Three-layer memory

Memory is split by **scope**, not by folder. All writes flow through the extension, never through model-facing tools.

| Layer | File | Who writes | Lifetime |
|---|---|---|---|
| `global` | `<home>/global.md` | **humans only** (`/router promote`) | permanent, shared across projects |
| `project` | `<home>/projects/<project>.md` | **humans only** (`/router promote`) | permanent per project |
| `session` | `<home>/sessions/<sessionId>.json` | the model (`router_note`) | pruned after 7 days |
| audit | `<home>/audit.jsonl` | the extension | append-only |

- `<home>` defaults to `~/.pi/agent/router/`. One shared home is fine: every task carries a `project` field, and `projects/<project>.md` is one file per project. Set `"scope": "project"` in the config to give each repo its own `.pi/router/` instead (this also makes `global.md` per-repo).
- Each turn, `assembleMemory()` injects a bounded view: `## global` → `## project` → `## session` → `## open tasks`, with per-layer budgets, a hard cap of 4096 characters / 60 lines, and a `budget:` manifest line so the model knows what was truncated.
- Task rows end with a pointer, `· read: task/t3`; the model dereferences it with `router_task_get { id }` before reporting or when a task is `needs-human`.
- The model **cannot** append to `global` / `project`. `router_memory_append` writes an audit line and tells the model to ask a human for promotion. `/router promote <n> [global|project]` copies audit line `n` (newest = 1) into the chosen layer.

### Tools

| Tool | Parameters | Purpose |
|---|---|---|
| `router_task_open` | `{ key, goal, cwd?, worktree?, model? }` | idempotent by `key`; returns a task id |
| `router_task_update` | `{ id, status?, runId?, report?, deliverables?, next?, reason? }` | record state, append a report, tag a reason code |
| `router_task_list` | `{ status? }` | compact table; `open` filters unfinished work |
| `router_task_get` | `{ id, reports? }` | full task + latest N reports (0–20); the pointer target |
| `router_memory_read` | `{ scope?, query?, maxChars? }` | read `global` / `project` / `session` / `audit`, or all three layers |
| `router_memory_append` | `{ section, text }` | **audit only**; never writes shared memory |
| `router_note` | `{ text, focus? }` | session memory (focus + notes, FIFO 50) |
| `router_workers` | `{ status?: "active" \| "done" \| "all" }` | run id, state, session path, last report per worker |
| `router_inspect` | `{ cmd: "git-status" \| "git-log" \| "git-diff" \| "tree", limit? }` | the only shell-like access; fixed argv, no free-form input |

`subagent` is pi-subagents' tool, used directly — pi-router does not wrap or reimplement it.

### Commands

```
/router status | tasks | task <id> | digest
/router memory [scope] [query]     scope: global | project | session | audit
/router session
/router new <goal>                 start a task and dispatch it
/router spawn <id>                 dispatch a queued task
/router promote <n> [global|project]
```

### Read-only mode

By default **every** session that loads the extension becomes a read-only Router, including the one you use for coding. Escape hatches:

```json
// ~/.pi/agent/router.json  (or <cwd>/.pi/router.json, or $PI_ROUTER_HOME)
{ "routerReadOnly": false }
```

or start a plain session with `pi -ne` (no extensions).

Configuration reference:

| Field | Default | Meaning |
|---|---|---|
| `scope` | `"global"` | `global` = one shared home; `project` = `<cwd>/.pi/router` |
| `home` | `~/.pi/agent/router` | storage root; ignored when `scope` is `project` |
| `routerReadOnly` | `true` | remove `write`/`edit`/`bash` and block them |
| `workerModel` | `null` | shown in the prompt as a hint; pi-router does not launch workers |
| `maxOpenShown` | `20` | task rows shown in the digest |
| `progressThrottleMs` | `60000` | reserved for worker progress relays |

`PI_ROUTER_HOME` overrides the storage root entirely.

### Safety and limitations

- Workers run **without approval prompts** as your OS user. pi-router only removes tools from the Router; it is not a sandbox. Use `worktree: true` when parallel workers touch the same repo.
- A worker's transcript never enters the Router's context — only its final message (and reports you record). Inspect details with `subagent({ action: "status", id, options: { view: "transcript" } })` or `router_workers`.
- `runId` is bound automatically: a single queued task is bound directly; with several, the dispatch text is matched against task goals, falling back to the newest task, and the binding is reported in the tool result. Override with `router_task_update { id, runId }`.
- Workers can only be resumed from the session that launched them (`pi-subagents` limitation).
- Migration from 0.2.x: a legacy `memory.md` is split into `global.md` + `projects/<p>.md` once and renamed `.migrated-<ts>`; idempotent, and the original is kept when parsing fails.

### Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test, 71 cases
```

Layout: `src/` (extension), `agents/` (worker definition), `test/`, `examples/`. Design specifications, plans, reviews and fix logs from every release are in the git history (`git log --oneline`, `git show <tag>:docs/BRIEF-v3.md`).

License: MIT.

---

## 中文

> **0.4.0 —— 首个公开发布版本。** 小而克制，仍是 `0.x`，接口可能变动。
> 之前经历了若干内部里程碑，其设计规格与审查记录保留在 git 历史里。

### 这是什么

pi-router 把你正在对话的会话变成一个**调度者**，而不是执行者：

```
你 ──► Router（当前会话，只读）
         │  判断该派什么活、写任务说明书
         ▼
       subagent({ agent: "router-worker", ... })     ← 由 pi-subagents 实际执行
         │
         ▼
       worker（独立会话：write/edit/bash，可再开子代理）
         │
         └──► 最终报告 ──► Router 记账
```

Router **不能改文件**：`write` / `edit` / `bash` 被移出工具集，它只能读、查状态、派活、记账。worker 保持完整能力。

### 依赖

| 依赖 | 原因 |
|---|---|
| [pi](https://github.com/badlogic/pi-mono) `>= 1.5` | 宿主运行时 |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | 提供 `subagent` 工具与 worker 运行时；**没装它 Router 只能记账、无法派活** |
| Node.js `>= 20` | 扩展由 pi 自己的 TypeScript 加载器加载；**测试套件**需要 `>= 22.6`（原生 type stripping），CI 在 20 上只跑 `tsc`，在 22/24 上跑测试 |

```bash
pi install npm:pi-subagents
pi install git:github.com/<you>/pi-superagent-router   # 私有仓库需要 SSH 或 gh auth
```

`router-worker` 随包发布，通过 `package.json` 的 `"pi": { "subagents": { "agents": ["./agents"] } }` 自动被发现，**不需要手动拷贝**。

安装后验证：

```
pi -p "列出你的 router_* 工具；write 是否可用？可用 agent 里是否有 router-worker？"
```

预期：9 个 `router_*` 工具、没有 `write`、agent 列表里有 `router-worker`。

### 快速上手

```bash
cd 你的项目
pi
```

```
/router new 加一个 CONTRIBUTING.md 并在 README 里链接它
/router status
/router task t1
```

也可以直接用自然语言描述目标，Router 会走同样的流程。

### 三层记忆

记忆按**作用域**分层，而不是按目录堆叠。所有写入都由扩展完成，不经过模型工具。

| 层 | 文件 | 谁能写 | 生命周期 |
|---|---|---|---|
| `global` | `<home>/global.md` | **只有人**（`/router promote`） | 永久，跨项目共享 |
| `project` | `<home>/projects/<项目>.md` | **只有人**（`/router promote`） | 每项目永久 |
| `session` | `<home>/sessions/<会话id>.json` | 模型（`router_note`） | 7 天后清理 |
| 审计 | `<home>/audit.jsonl` | 扩展 | 仅追加 |

- `<home>` 默认 `~/.pi/agent/router/`。共用一个 home 没有问题：每条任务带 `project` 字段，`projects/<项目>.md` 一项目一文件。把配置里的 `"scope"` 设成 `"project"` 可让每个仓库拥有自己的 `.pi/router/`（代价是 `global.md` 也变成每仓一份）。
- 每轮 `assembleMemory()` 注入一个有界视图：`## global` → `## project` → `## session` → `## open tasks`，每层独立预算，硬上限 4096 字符 / 60 行，并附一行 `budget:` 清单让模型知道被剪了什么。
- 任务行末尾带指针 `· read: task/t3`；模型在汇报前、或任务处于 `needs-human` 时用 `router_task_get { id }` 解引用。
- 模型**不能**写 `global` / `project`。`router_memory_append` 只写审计并提示模型请人晋升；`/router promote <n> [global|project]` 把审计第 `n` 行（1 = 最新）复制到目标层。

### 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `router_task_open` | `{ key, goal, cwd?, worktree?, model? }` | 按 `key` 幂等开任务，返回 id |
| `router_task_update` | `{ id, status?, runId?, report?, deliverables?, next?, reason? }` | 改状态、追加报告、打 reason 码 |
| `router_task_list` | `{ status? }` | 紧凑表格；`open` 过滤未完成 |
| `router_task_get` | `{ id, reports? }` | 完整任务 + 最近 N 条报告（0–20），指针目标 |
| `router_memory_read` | `{ scope?, query?, maxChars? }` | 读 `global` / `project` / `session` / `audit` 或三层拼接 |
| `router_memory_append` | `{ section, text }` | **只写审计**，绝不写共享记忆 |
| `router_note` | `{ text, focus? }` | 会话记忆（focus + notes，FIFO 50） |
| `router_workers` | `{ status?: "active" \| "done" \| "all" }` | 每个 worker 的 runId / 状态 / 会话路径 / 最后报告 |
| `router_inspect` | `{ cmd: "git-status" \| "git-log" \| "git-diff" \| "tree", limit? }` | 唯一近似 shell 的入口；固定 argv，不接受自由字符串 |

`subagent` 是 pi-subagents 的工具，直接使用——pi-router 不包装、不重写。

### 命令

```
/router status | tasks | task <id> | digest
/router memory [scope] [query]     scope: global | project | session | audit
/router session
/router new <目标>                 开任务并派发
/router spawn <id>                 派发一个 queued 任务
/router promote <n> [global|project]
```

### 只读模式

默认**所有**加载了该扩展的会话都会变成只读 Router，包括你平时写代码的那个。逃生方式：

```json
// ~/.pi/agent/router.json（也可放 <cwd>/.pi/router.json，或用 $PI_ROUTER_HOME）
{ "routerReadOnly": false }
```

或者用 `pi -ne` 起一个不加载任何扩展的普通会话。

配置项：

| 字段 | 默认 | 含义 |
|---|---|---|
| `scope` | `"global"` | `global` 共用一个 home；`project` 用 `<cwd>/.pi/router` |
| `home` | `~/.pi/agent/router` | 存储根目录；`scope` 为 `project` 时忽略 |
| `routerReadOnly` | `true` | 移除并拦截 `write`/`edit`/`bash` |
| `workerModel` | `null` | 仅作为提示注入，pi-router 自己不派 worker |
| `maxOpenShown` | `20` | digest 里显示的任务行数 |
| `progressThrottleMs` | `60000` | 预留给 worker 进度汇报 |

`PI_ROUTER_HOME` 可整体覆盖存储根目录。

### 安全与已知限制

- worker **不经审批**、以你的系统用户身份执行。pi-router 只是收走 Router 的写工具，**不是沙箱**。多个 worker 改同一仓库时用 `worktree: true`。
- worker 的完整对话不会进入 Router 上下文，只有最终消息（以及你记录的报告）。要看过程用 `subagent({ action: "status", id, options: { view: "transcript" } })` 或 `router_workers`。
- `runId` 自动绑定：唯一待派任务直接绑；多个时按派发文本匹配 goal，匹配不到取最新，并在工具结果里说明绑给了谁。需要精确控制时用 `router_task_update { id, runId }` 覆盖。
- 跨会话无法 resume worker（pi-subagents 限制：只有发起它的会话能 resume）。
- 从 0.2.x 迁移：旧的 `memory.md` 会一次性拆成 `global.md` + `projects/<项目>.md`，原文件改名 `.migrated-<ts>`；幂等，解析失败时保留原文件。

### 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test，71 个用例
```

目录：`src/`（扩展）、`agents/`（worker 定义）、`test/`、`examples/`。每个版本的设计规格、实施计划、审查记录与返修日志都在 git 历史里（`git log --oneline`、`git show <tag>:docs/BRIEF-v3.md`）。

License: MIT。