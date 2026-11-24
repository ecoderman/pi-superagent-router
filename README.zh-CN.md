# pi-superagent-router（中文）

[English](README.md) · **中文**

![ci](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

**给 [pi coding agent](https://github.com/badlogic/pi-mono) 写的一个极简 super-agent 扩展。**
你对话的会话不再写代码：它决定做什么、把活派出去、把过程记下来。

> **0.4.0 · 首个公开版本。** 约 1k 行，无运行时依赖，无守护进程，无数据库。

## 问题背景

**问题：编码会话越用越钝。** 上下文被工具输出填满，而你同时只能盯住三到五个会话——限制并行量的是注意力，不是模型。

**做法：把「决定」和「执行」拆开。** 只读的 Router 判断、派活、记账；每个 worker 在自己的会话里动手。

**效果：** 主会话始终只有一屏摘要；每个改动都留着报告、reason 码和 runId；并行任务互不污染。

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
