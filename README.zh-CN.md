# pi-superagent-router（中文）

[English](README.md) · **中文**

![ci](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

**给 [pi coding agent](https://github.com/badlogic/pi-mono) 写的一个极简 super-agent 扩展。**
你对话的会话不再写代码：它决定做什么、把活派出去、把过程记下来，并且只记得住你点头的那些。

> **0.5.0 · 记忆层重做。** 源码约 2.5k 行，无运行时依赖，无守护进程，无数据库。

## 问题背景

**问题：编码会话越用越钝。** 上下文被工具输出填满，而你同时只能盯住三到五个会话——限制并行量的是注意力，不是模型。加更多指令也没用：编排者的上下文才是瓶颈，而每条新指令都在跟任务本身抢位置。

**做法：把「决定」和「执行」拆开。** 只读的 Router 判断、派活、记账；每个 worker 在自己的会话里动手，只把摘要交回来。

**效果：** 主会话始终只有一屏；每个改动都留着报告、reason 码和 run 编号，结果不对能追回是哪条任务做的。

## 架构设计

### 实现形式

做成一个 **pi 扩展**：不做事件接入，不重写并发层，不要求再装一个 CLI 当 worker。安装两条命令，装完即用——几乎零配置。

### 项目结构

```
src/
  index.ts     工具、命令、事件、只读拦截
  store.ts     账本、候选区、项目记忆、审计、流水、文件锁
  memory.ts    记忆分层、注入组装、按日期渲染
  prompt.ts    路由规则与 digest
  guard.ts     白名单与调用拦截
  inspect.ts   固定 argv 的仓库检查
  workers.ts   运行目录发现与状态
  config.ts    router.json 解析
  types.ts
agents/router-worker.md    worker 定义（可再开子代理）
test/                      六个文件，78 个用例
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

- worker 看不到 Router 的对话；Router 也看不到 worker 的过程，只收到报告。
- 账本之所以可信，是因为记账的那个会话，没有能力去动它所报告的东西。

### 设计原则

1. **编排者只读**——它要是还能改文件，你就永远说不清一个改动是谁做的。
2. **只有摘要能跨边界**——细节是指针，不是正文。
3. **写权限按爆炸半径分配**——会话与项目内 AI 自己写；跨项目的规则必须人批。
4. **注入的上下文始终有界**——每轮 4096 字符 / 60 行，末尾一行 `budget:` 说明剪了什么。
5. **不做等待**——派发即返回，报告以消息到达，没有轮询。

## 机制详解

### Agent 之间怎么交互：一次派发的完整走法

| 步骤 | 谁 | 发生什么 |
| --- | --- | --- |
| 1. 开任务 | Router | 一条任务 = 目标 + 边界 + 验收标准 + 交付物 + 失败怎么办。`key` 让它幂等：同一个目标重复提交不会开第二条。 |
| 2. 派发 | Router | 调 pi-subagents 自带的 `subagent`（`router-worker`），独立会话，可选 worktree 隔离。 |
| 3. 绑定 | 扩展 | 运行编号自动绑到任务上，记录才能指向「到底哪一次跑的」。 |
| 4. 执行 | worker | 读、写、改、跑命令，还能再开子 worker。它看不到 Router 的对话。 |
| 5. 报告 | worker | 每个节点一条：进展 / 受阻 / 可交付 / 失败 / 丢弃，带原因码和可选的提问。 |
| 6. 记账 | Router | 更新账本、决定下一步；只有任务受阻或需要人决策时才打扰你。 |
| 7. 验收 | 你 | `/router task t1` 看报告时间线，`/router audit` 看自己批准过什么。 |

两条规则防止它越跑越乱：**只有摘要跨边界**——一条任务在主会话只占一行，细节留在 `read: task/t1` 后面；**不做等待**——派发立即返回，报告以消息到达，不轮询、不 sleep。

```
你      /router new 加一个 CONTRIBUTING.md，并在 README 里链上它
Router  t1 已开 · 已派发 · 边界：只动 CONTRIBUTING.md 和 README.md
        验收：链接能跳转，别的文件不碰
  ...
Router  t1 完成 · 2 个文件 · run 4c1e · 详情见 read: task/t1
```

### 权限：三道墙

| 墙 | 怎么保证 |
| --- | --- |
| Router 不能改代码 | `write` / `edit` / `apply*` 在工具层被拦，`bash` / `powershell` / `cp` / `mv` / `rm` 同样；查仓库用 `router_inspect`（`git-status` / `git-log` / `git-diff` / `tree`，固定 argv）代替 shell。 |
| Router 不能给自己立规矩 | 它能写项目记忆和候选，但没有写 `global.md` 的工具，也没有 promote 命令。全局规则只能由人批准。 |
| worker 看不到对话 | 各自独立会话，只有报告跨过边界。 |

三道墙都由扩展强制，不靠提示词约定——提示词在长会话里一定会被破例，破了也没人知道。

### 记忆：四层 + 一个待审区

| 层 | 文件 | 谁能写 | 活多久 | 进注入吗 |
| --- | --- | --- | --- | --- |
| 全局 | `global.md`（home 下） | **人**（`/router promote`） | 永久 | 进，全部 |
| 项目 | `<仓库>/.pi/memory.md` | **模型**（`router_project_note`） | 跟着仓库走 | 进，按日期取最近的 |
| 会话 | `sessions/<id>.json` | 模型（`router_note`） | 7 天清理，最多 50 条 | 进 |
| 待审 | `candidates.md`（home 下） | **模型**（`router_candidate`） | 直到人处理，最多 5 条 | **只进计数** |

**分层的依据是「错了影响多大」，不是「听起来多重要」**：项目内写错只毁一个项目，所以让 AI 自己写；跨项目的规则写错会悄悄改掉所有项目的行为，所以必须人批。

**项目记忆跟着仓库走**：写在 `<仓库>/.pi/memory.md`，按日期分节、每行带来源，所以 `git diff` 就是审计，review、回滚、换机器都成立。

```markdown
## 2026-11-25
- 测试用 node --test 跑，不装 jest。（来源 t4）
- 锁文件在 tasks.lock，别和第二把锁混用。（来源 t2）
```

注入时**从最新一节往前取**，装进项目层的 1200 字符预算；装不下的早期小节整节省略，并标注 `…(N older sections omitted)`。

### 待审区：AI 提名，人批准

`candidates.md` 里只放「换个项目也成立、且关于用户」的判断，一行一条、必须带来源：

```markdown
- [c1] 用户偏好中文提交信息。（来源 t4 / 2026-11-25）
- [c2] 用户看结论先于过程。（来源 t9 / 2026-11-26） · 已升 2026-11-27
```

规则只有四条：正文 ≤200 字、必须带来源、未处理最多 5 条、**待审正文永不进注入**（没批准的判断不该影响行为，只有计数会出现在 `budget:` 行里）。

### 审计：只记人做的决定

`audit.jsonl` 不是操作日志，是**签名簿**：只记录「谁在什么时候给了 AI 什么权力」。

| kind | 什么时候出现 |
| --- | --- |
| `promote` | 你批准一条候选，它进了 `global.md` |
| `revoke` | 你撤回一条全局规则 |
| `grant` | 你改了 AI 的权限（如允许它写项目记忆） |
| `migrate` | 一次性迁移旧记忆 |

```jsonl
{"n":1,"at":"2026-11-25T10:02:11Z","kind":"promote","target":"global","candidate":"c1","source":"t4 / 2026-11-25","text":"用户偏好中文提交信息。"}
```

`n` 是自增编号，`/router revoke <n>` 用它定位。任务的开、派、改**不写审计**——那些事实在 `tasks.json` 和 git 里，混进来只会把真正重要的几行淹掉。

### 工作流水：只记形状，不当真相源

`events.jsonl` 记「什么时候、哪条任务、从什么状态变成什么状态」，一行约 100 字，不存报告正文：

```jsonl
{"at":"09:08:45","kind":"open","taskId":"t1","project":"router-demo","session":"01a2…"}
{"at":"09:08:47","kind":"dispatch","taskId":"t1","runId":"f4c10a5c"}
{"at":"09:08:47","kind":"status","taskId":"t1","from":"queued","to":"running"}
{"at":"09:14:58","kind":"status","taskId":"t1","from":"running","to":"done"}
```

它存在的理由只有一个：`tasks.json` 只有当下值，算不出「一次活多久、并行峰值多少、多少时间花在等人」——而这几个数正是「限制并行的是注意力」的唯一证据。写失败不影响任务，读的时候一律以 `tasks.json` 为准。

### 记忆注入：每一轮都有上界

每轮开始前从磁盘重新组装（不是从对话累积，所以是有界快照）：

| 层 | 预算（字符） | 装什么 |
| --- | --- | --- |
| `global` | 800 | 跨项目原则（8–12 条） |
| `project` | 1,200 | 本项目按日期取最近几节 |
| `session` | 600 | 本次会话的焦点与笔记 |
| `tasks` | 1,400 | 本项目未结束任务，每条一行 |
| **合计** | **4,096 字符 / 60 行** | 含末尾清单行 |

超限时**从末层往前整层丢弃**——先任务、再会话、再项目，`global` 一定保住——最后对还留下的那层截断。每一次裁剪都看得见：

```
## session
…(truncated 120 chars)
## open tasks
t1 [done] snake-html-game — … · read: task/t1
…
budget: global 320/800 · project 900/1200 · session 480/600 · tasks 0/1400 · candidates 2 pending
```

两道闸防止窗口被吃满：**先摘要化**——一条任务只占一行（key 40 / 目标 80 / 最近报告 60 / 下一步 60），细节是指针；**再封顶**——就是上面那张预算表。这个上限管的是注入的记忆块，不是整份输入；对话历史由宿主压缩，本扩展不重做一遍。

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
/router candidates                                         # 待审的全局记忆候选
/router promote c1                                         # 批准 c1 进 global.md
/router audit                                              # 我批准过什么
/router revoke 3                                           # 撤回审计第 3 号那条
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
| `router_project_note` | 写项目记忆（仓库内，按日期分节，带来源） |
| `router_note` | 会话记忆：焦点 + 短笔记 |
| `router_candidate` | 提交待审的全局记忆候选（≤200 字，必须带来源） |
| `router_memory_read` | 读 `global` / `project` / `session` / `candidates` |
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
| `/router memory [scope] [query]` | 读 `global` / `project` / `session` / `candidates`；`query` 按行过滤 |
| `/router candidates` | 待审候选列表（带 `[cN]` 编号） |
| `/router promote <cN>` | 批准候选进 `global.md`，并记一行审计 |
| `/router revoke <n>` | 撤回审计第 `n` 号那条全局规则 |
| `/router audit` | 审计视图（编号倒序，只含人的决定） |
| `/router session` | 当前会话的焦点与最近笔记 |
| `/router new <目标>` | 开任务并派发（就是"说目标"的命令形式） |
| `/router spawn <id>` | 派发一个已开但没派出去的 queued 任务 |

## 配置

`~/.pi/agent/router.json`，全部可选：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `scope` | `"global"` | 共用一个 home，或设 `project` 用 `<cwd>/.pi/router` |
| `home` | `~/.pi/agent/router` | 存储根目录（`PI_ROUTER_HOME` 可覆盖） |
| `routerReadOnly` | `true` | 移除并拦截 `write` / `edit` / `bash` |
| `workerModel` | `null` | 仅作提示；本扩展自己不派 worker |
| `maxOpenShown` | `20` | digest 里显示几行任务 |

## 状态存在哪

| 文件 | 装什么 | 谁写 |
| --- | --- | --- |
| `tasks.json` | 任务当前值 + 报告链 | 扩展 |
| `events.jsonl` | 状态变迁、派发的短行 | 扩展（尽力而为） |
| `global.md` | 全局规则 | 人（promote） |
| `candidates.md` | 待审候选 | 模型 |
| `audit.jsonl` | 人的批准与撤销 | 人 |
| `sessions/<id>.json` | 会话草稿 | 模型，7 天清 |
| `<仓库>/.pi/memory.md` | 项目记忆 | 模型 |

`scope: "project"` 时，前六项整体搬进 `<cwd>/.pi/router`；项目记忆永远在仓库里。

## 局限

- **不是沙箱。** worker 用你的权限执行，不弹审批；多个 worker 改同一仓库记得开 `worktree: true`。
- **不是自主编码器。** 它只把你给的目标派下去，不替你规划项目。
- **不是工作流引擎。** 并行、重试、worktree、mission 都是 pi-subagents 的活。
- **不是事件驱动的。** 它听的是你，不是 GitHub、飞书或 CI。
- **候选不能自动生效。** 全局规则必须人批；这是设计约束，不是待办。
- **报告不能翻页。** 详情最多回最近 20 条；更早的还在账本里，但没有工具取。
- **还没做报告归档。** 账本只增不减；阈值是 `tasks.json` 超过 5 MB 或加载超过 200 ms 时再拆。
- **还不稳定。** 0.x 阶段，工具接口可能在次版本间变化。

## 测试

78 个单元测试，`tsc --noEmit` 干净。CI：Node 22/24 跑测试，Node 20 做类型检查。用 `pi install` 在干净项目实测：10 个 `router_*` 工具、无 `write`、能从包里发现 `router-worker`，一次真实派活产出文件并自动绑定 runId。

## 致谢

执行、并发与 worktree 隔离来自 [`pi-subagents`](https://github.com/nicobailon/pi-subagents)；Router / worker 分工、工单账本与写权限分域的思路受 DeepSeek 的 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）启发。本项目是独立、非官方的极简实现，与两者均无隶属关系。MIT 许可。