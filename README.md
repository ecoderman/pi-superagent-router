# pi-superagent-router

![ci](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

**A minimal super-agent extension for the [pi coding agent](https://github.com/badlogic/pi-mono).**
The session you talk to stops writing code: it decides what to do, hands the work to workers, and keeps the ledger.

> **0.4.0 · first public release.** ~1k lines, no runtime dependencies, no daemon, no database.

## The problem

Two ceilings are unavoidable. A session goes blunt as its context fills, and human attention only covers three to five live sessions at once.

More instructions do not fix either. The orchestrator's context is the bottleneck, and every added instruction competes with the task itself.

So the fix is not a longer prompt but a split: a read-only Router that judges and keeps books, and workers that do the work. Worth it for long-running work you return to and must explain later; for a one-off edit, a plain `pi` session is cheaper.

## Architecture

### Where it comes from

Borrowed from DeepSeek's [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) and its design essay. Its judgement: **how good one task gets depends on the model; how many tasks advance depends on human attention.** So it does not make one session smarter — it moves conversation, task state, authority and execution into separate places.

| DeepSeek's concept | Here |
| --- | --- |
| Router / Worker split | the session you talk to loses `write` / `edit` / `bash`; workers get their own sessions |
| Ticket | `router_task_*`: idempotent by key, report + reason code + runId, detail on demand |
| Mandate | writes scoped: `session` / `audit` for the model, `project` / `global` only by a human command |
| Summary-only handoff | only a compacted report crosses; detail sits behind `read: task/t3` |
| State on disk | one ledger file; one summary restores the scene |
| Source / Trigger | **not ported** |
| Concurrency, worktrees | **delegated to [`pi-subagents`](https://github.com/nicobailon/pi-subagents)** |

### How it ships

A **pi extension**: no event intake, no rebuilt concurrency layer, no second CLI to wire in. Install is two commands and it works immediately — almost zero configuration.

### Project layout

```
src/
  index.ts     tools, commands, events, read-only enforcement
  store.ts     ledger, file lock, migration
  memory.ts    three scopes + assembleMemory
  prompt.ts    router rules + digest
  guard.ts     keep-list and call blocking
  inspect.ts   fixed-argv repository inspection
  workers.ts   run-directory discovery and status
  config.ts    router.json parsing
  types.ts
agents/router-worker.md    the worker definition (may spawn nested subagents)
test/                      six files, 71 cases
examples/router.json
.github/workflows/ci.yml
```

### Agent hierarchy

```
you
└── Router  (main session)      read · inspect · dispatch · record     no write / edit / bash
    └── worker  (own session)   read · write · edit · bash · subagent
        └── nested worker       same capabilities
```

- A worker never sees the Router's conversation; the Router never sees a worker's transcript, only its final report.
- The Router's ledger is trustworthy because the session keeping the books cannot touch what it reports on.

### Design principles

1. **The orchestrator is read-only** — otherwise you can never say who made a change.
2. **Only summaries cross the boundary** — detail is a pointer, not a payload.
3. **Context stays bounded** — 4096 characters / 60 lines per turn, plus a `budget:` line saying what was cut.
4. **Write permissions are scoped** — enforced by the extension, not by the prompt.
5. **Nothing waits** — dispatch returns, reports arrive as messages, no polling.

Principles 1, 2 and 4 come from DeepSeek's Router and Mandate design; 3 applies the same reasoning to the window itself; 5 exists because pi has no event loop to park a dispatch in.

### Memory layers

| Layer | File | Writer | Lifetime |
| --- | --- | --- | --- |
| `global` | `global.md` | **human** (`/router promote`) | permanent, cross-project |
| `project` | `projects/<project>.md` | **human** (`/router promote`) | permanent, per project |
| `session` | `sessions/<id>.json` | model (`router_note`) | pruned after 7 days |
| audit | `audit.jsonl` | extension | append-only, numbered for promotion |

`router_memory_append` writes only to the audit log and tells the model to ask a human; `/router promote 2 project` is the one path from a decision to durable memory. That is Mandate in miniature: an agent may record what it decided, but cannot grant itself the right to decide for you next time.

### What a dispatch looks like

```
you     /router new add a CONTRIBUTING.md and link it from the README
Router  t1 opened · dispatched · boundary: CONTRIBUTING.md + README.md
        acceptance: link resolves, nothing else touched
  ...
Router  t1 done · 2 files · run 4c1e · detail: read: task/t1
```

Wrong result? `/router task t1` shows the report and reason code; `/router memory audit` shows the decisions made at the time. No reconstructing intent from a diff.

## Quick start

```bash
pi install npm:pi-subagents
pi install git:github.com/ecoderman/pi-superagent-router
```

```bash
cd your-project && pi
```

Everyday use is plain language. Slash commands are just shortcuts for it:

```
> tidy up the locking in src/store.ts, fix any path that forgets to release, keep the tests green
Router  t1 opened · dispatched · boundary: src/store.ts
        acceptance: every lock released, existing tests green
  ...
Router  t1 done · 1 file · run 4c1e · detail: read: task/t1
```

```
/router new add a CONTRIBUTING.md and link it from the README   # same thing, as a command
/router status                                                   # one line per open task
/router task t1                                                  # what it did, and why
```

> **Read-only mode comes first.** Every session that loads this extension becomes a read-only Router, including the one you code in. Disable with `{"routerReadOnly": false}` in `~/.pi/agent/router.json`, or use `pi -ne`.

## Requirements

| Requirement | Why |
| --- | --- |
| [pi](https://github.com/badlogic/pi-mono) `>= 1.5` | host runtime |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | the `subagent` tool and worker runtime; without it the Router can only keep books |
| Node.js `>= 20` | pi loads the extension as TypeScript; the test suite needs `>= 22.6` |

`router-worker` ships in the package (`"pi": { "subagents": { "agents": ["./agents"] } }`), no manual copy.

## Tools

| Tool | Purpose |
| --- | --- |
| `router_task_open` / `_update` / `_list` / `_get` | ledger: idempotent by key, reason codes, detail on demand |
| `router_note` | session memory: focus + short notes |
| `router_memory_append` | audit only, cannot touch shared memory |
| `router_memory_read` | read `global` / `project` / `session` / `audit` |
| `router_workers` | runId, state, session path, last report |
| `router_inspect` | `git-status` / `git-log` / `git-diff` / `tree`, fixed argv |

Dispatching uses pi-subagents' own `subagent` tool — not wrapped, not reimplemented.

## Commands

| Command | What it does |
| --- | --- |
| `/router status` | one line per open task, plus open / running / needs-human counts |
| `/router tasks` | alias of `status` |
| `/router task <id>` | full report timeline for one task |
| `/router digest` | the exact block injected into the prompt this turn — what the model actually sees |
| `/router memory [scope] [query]` | read `global` / `project` / `session` / `audit`; `query` filters lines |
| `/router session` | this session's focus and recent notes |
| `/router new <goal>` | open a task and dispatch it (the command form of saying the goal) |
| `/router spawn <id>` | dispatch a queued task that was opened but never sent |
| `/router promote <n> [global\|project]` | copy audit line `n` (1 = newest) into global or project memory |

## Configuration

`~/.pi/agent/router.json`, all optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `scope` | `"global"` | one shared home, or `project` for `<cwd>/.pi/router` |
| `home` | `~/.pi/agent/router` | storage root (`PI_ROUTER_HOME` overrides) |
| `routerReadOnly` | `true` | remove and block `write` / `edit` / `bash` |
| `workerModel` | `null` | hint only; this extension never dispatches workers |
| `maxOpenShown` | `20` | task rows shown in the digest |

## Limitations

- **Not a sandbox.** Workers run with your permissions, no approval prompt. Use `worktree: true` when several touch one repo.
- **Not an autonomous coder.** It dispatches the goals you give it; it does not plan your project.
- **Not a workflow engine.** Parallelism, retries, worktrees and missions are pi-subagents' job.
- **Not event-driven.** DeepSeek's system listens to GitHub, Feishu and CI; this one listens to you.
- **Not stable.** `0.x`: the tool surface may change between minor versions.

## Tests

71 unit tests, `tsc --noEmit` clean. CI: suite on Node 22/24, typecheck on Node 20. Verified with `pi install` in a clean project: nine `router_*` tools, no `write`, `router-worker` discovered, one real dispatch produced a file with an auto-bound runId.

## Credits

Architecture, philosophy and vocabulary: DeepSeek's [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT). Execution, concurrency and worktree isolation: [`pi-subagents`](https://github.com/nicobailon/pi-subagents). This is an independent, unofficial minimal implementation, unaffiliated with either project. MIT licensed.

---

# pi-superagent-router（中文）

![ci](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

**给 [pi coding agent](https://github.com/badlogic/pi-mono) 写的一个极简 super-agent 扩展。**
你对话的会话不再写代码：它决定做什么、把活派出去、把过程记下来。

> **0.4.0 · 首个公开版本。** 约 1k 行，无运行时依赖，无守护进程，无数据库。

## 问题背景

编码会话有两个绕不过去的上限：会话本身会随上下文膨胀而变钝，人的注意力也只够同时照看三到五个会话。

靠"多交代几句"解决不了，因为编排者的上下文就是瓶颈，每多一条指令就多一分干扰。

所以真正要做的是把「决定」和「执行」拆开：一个只读的 Router 负责判断和记账，worker 负责动手。值得用在需要反复回来、事后要能解释清楚的长活上；临时改一处小地方，普通 `pi` 会话更省事。

## 架构设计

### 设计来源

借鉴 DeepSeek 的 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) 及其设计文章。核心判断是：**单个任务做得多好取决于模型；能同时推进多少任务取决于人的注意力。** 所以它不去把单个会话做聪明，而是把对话、任务状态、权限和执行挪到各自该在的位置。

| DeepSeek 的概念 | 在这里对应什么 |
| --- | --- |
| Router / Worker 两层分工 | 你对话的会话失去 `write` / `edit` / `bash`；worker 有自己的会话 |
| 工单（Ticket） | `router_task_*`：按 key 幂等，带报告、reason 码、runId，要细节时再取 |
| 授权范围（Mandate） | 写入分域：`session` / `audit` 给模型，`project` / `global` 只能由人下令写 |
| 只交接摘要 | 只有压缩报告跨过去，细节留在 `read: task/t3` 后面 |
| 状态落盘 | 账本就是磁盘上一个文件，一份摘要恢复现场 |
| 事件源（Source / Trigger） | **本期没有移植** |
| 并发、worktree | **交给 [`pi-subagents`](https://github.com/nicobailon/pi-subagents)** |

### 实现形式

做成一个 **pi 扩展**：不做事件接入，不重写并发层，不要求再装一个 CLI 当 worker。安装两条命令，装完即用——几乎零配置。

### 项目结构

```
src/
  index.ts     工具、命令、事件、只读拦截
  store.ts     账本、文件锁、迁移
  memory.ts    三层记忆与 assembleMemory
  prompt.ts    路由规则与 digest
  guard.ts     白名单与调用拦截
  inspect.ts   固定 argv 的仓库检查
  workers.ts   运行目录发现与状态
  config.ts    router.json 解析
  types.ts
agents/router-worker.md    worker 定义（可再开子代理）
test/                      六个文件，71 个用例
examples/router.json
.github/workflows/ci.yml
```

### Agent 层级

```
你
└── Router（主会话）      读 · 查 · 派活 · 记账          没有 write / edit / bash
    └── worker（独立会话） read · write · edit · bash · subagent
        └── 嵌套 worker    能力同上
```

- worker 看不到 Router 的对话；Router 也看不到 worker 的完整过程，只收到最终报告。
- 账本之所以可信，是因为记账的那个会话，没有能力去动它所报告的东西。

### 设计原则

1. **编排者只读**——它要是还能改文件，你就永远说不清一个改动是谁做的。
2. **只有摘要能跨边界**——细节是指针，不是正文。
3. **上下文始终有界**——每轮 4096 字符 / 60 行，末尾一行 `budget:` 说明剪了什么。
4. **写权限按作用域分开**——由扩展强制，提示词改不了。
5. **不做等待**——派发即返回，报告以消息到达，没有轮询。

第 1、2、4 条来自 DeepSeek 的 Router 与 Mandate；第 3 条把同样的道理用回窗口本身；第 5 条是因为 pi 没有事件循环，派发没地方挂着等。

### 记忆分层

| 层 | 文件 | 谁能写 | 生命周期 |
| --- | --- | --- | --- |
| `global` | `global.md` | **人**（`/router promote`） | 永久，跨项目 |
| `project` | `projects/<项目>.md` | **人**（`/router promote`） | 每项目永久 |
| `session` | `sessions/<id>.json` | 模型（`router_note`） | 7 天后清理 |
| 审计 | `audit.jsonl` | 扩展 | 仅追加，带行号供晋升 |

`router_memory_append` 只写审计，并提醒模型找人晋升；`/router promote 2 project` 是决策变成持久记忆的唯一入口。这就是缩小版的 Mandate：agent 可以记下自己做了什么决定，但没法给自己签发「下次替你做主」的权限。

### 动线示例

```
你      /router new 加一个 CONTRIBUTING.md，并在 README 里链上它
Router  t1 已开 · 已派发 · 边界：只动 CONTRIBUTING.md 和 README.md
        验收：链接能跳转，别的文件不碰
  ...
Router  t1 完成 · 2 个文件 · run 4c1e · 详情见 read: task/t1
```

结果不对？`/router task t1` 看报告和 reason 码，`/router memory audit` 看当时的决策。不用从 diff 反推它是怎么想的。

## 快速开始

```bash
pi install npm:pi-subagents
pi install git:github.com/ecoderman/pi-superagent-router
```

```bash
cd 你的项目 && pi
```

日常就是直接说人话，斜杠命令只是快捷方式：

```
> 把 src/store.ts 的锁收尾理一遍，顺手把漏释放的地方修掉，测试要保持通过
Router  t1 已开 · 已派发 · 边界：src/store.ts
        验收：锁一定会释放，现有测试保持绿色
  ...
Router  t1 完成 · 1 个文件 · run 4c1e · 详情见 read: task/t1
```

```
/router new 加一个 CONTRIBUTING.md 并在 README 里链接它   # 同一件事，用命令表达
/router status                                             # 每个未结束任务一行
/router task t1                                            # 它做了什么，以及为什么
```

> **先知道只读模式。** 加载了这个扩展的会话都会变成只读 Router，包括你平时写代码的那个。要关掉：`~/.pi/agent/router.json` 里写 `{"routerReadOnly": false}`，或用 `pi -ne`。

## 依赖

| 依赖 | 为什么需要 |
| --- | --- |
| [pi](https://github.com/badlogic/pi-mono) `>= 1.5` | 宿主运行时 |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | 提供 `subagent` 工具和 worker 运行时；没它 Router 只能记账 |
| Node.js `>= 20` | 扩展由 pi 的 TypeScript 加载器加载；测试套件需要 `>= 22.6` |

`router-worker` 随包发布（`"pi": { "subagents": { "agents": ["./agents"] } }`），不用手动拷贝。

## 工具

| 工具 | 作用 |
| --- | --- |
| `router_task_open` / `_update` / `_list` / `_get` | 账本：按 key 幂等、reason 码、按需取详情 |
| `router_note` | 会话记忆：焦点 + 短笔记 |
| `router_memory_append` | 只写审计，碰不到共享记忆 |
| `router_memory_read` | 读 `global` / `project` / `session` / `audit` |
| `router_workers` | runId、状态、会话路径、最后一条报告 |
| `router_inspect` | `git-status` / `git-log` / `git-diff` / `tree`，固定 argv |

派活用 pi-subagents 自带的 `subagent` 工具——不包一层，也不重写。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/router status` | 每个未结束任务一行，附 open / running / needs-human 计数 |
| `/router tasks` | 与 `status` 相同 |
| `/router task <id>` | 单个任务的完整报告时间线 |
| `/router digest` | 这一轮实际注入系统提示的那一段——模型真正看到的 |
| `/router memory [scope] [query]` | 读 `global` / `project` / `session` / `audit`；`query` 按行过滤 |
| `/router session` | 当前会话的焦点与最近笔记 |
| `/router new <目标>` | 开任务并派发（就是"说目标"的命令形式） |
| `/router spawn <id>` | 派发一个已开但没派出去的 queued 任务 |
| `/router promote <n> [global\|project]` | 把审计第 `n` 行（1 = 最新）晋升到全局或项目记忆 |

## 配置

`~/.pi/agent/router.json`，全部可选：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `scope` | `"global"` | 共用一个 home，或设 `project` 用 `<cwd>/.pi/router` |
| `home` | `~/.pi/agent/router` | 存储根目录（`PI_ROUTER_HOME` 可覆盖） |
| `routerReadOnly` | `true` | 移除并拦截 `write` / `edit` / `bash` |
| `workerModel` | `null` | 仅作提示；本扩展自己不派 worker |
| `maxOpenShown` | `20` | digest 里显示几行任务 |

## 局限

- **不是沙箱。** worker 用你的权限执行，不弹审批；多个 worker 改同一仓库记得开 `worktree: true`。
- **不是自主编码器。** 它只把你给的目标派下去，不替你规划项目。
- **不是工作流引擎。** 并行、重试、worktree、mission 都是 pi-subagents 的活。
- **不是事件驱动的。** DeepSeek 那套在听 GitHub、飞书和 CI，这一套在听你。
- **还不稳定。** 0.x 阶段，工具接口可能在次版本间变化。

## 测试

71 个单元测试，`tsc --noEmit` 干净。CI：Node 22/24 跑测试，Node 20 做类型检查。用 `pi install` 在干净项目实测：9 个 `router_*` 工具、无 `write`、能从包里发现 `router-worker`，一次真实派活产出文件并自动绑定 runId。

## 致谢

架构、理念与术语来自 DeepSeek 的 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）；执行、并发与 worktree 隔离来自 [`pi-subagents`](https://github.com/nicobailon/pi-subagents)。本项目是独立、非官方的极简实现，与两者均无隶属关系。MIT 许可。