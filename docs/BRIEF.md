# pi-router — 开发简报（唯一权威需求）

一个**极简 superagent（Router）**的 pi 扩展实现。Router 只做四件事：拆任务、派任务、收报告、记账。
任务的内部拆解与执行全部交给 **pi-subagents** 的 worker 子代理，worker 可自行再开子代理。

## 架构约束（不可更改）

- Router = pi 主会话。扩展只提供「账本工具 + 路由提示词注入 + `/router` 命令」。
- 派发使用 pi-subagents 已有的 `subagent` 工具，**不得**自己 spawn 子进程、**不得**自己实现 subagent 运行时、**不得**包装一个内部调用 `subagent` 的 dispatch 工具。
- Worker = `.pi/agents/router-worker.md` 定义的 agent，frontmatter 必须含 `tools: read, write, edit, bash, grep, find, ls, subagent`（末尾 `subagent` 用于嵌套授权）。
- 记忆 = 磁盘文件：`.pi/router/tasks.json`（结构化事实）+ `.pi/router/memory.md`（append-only 决策记录）。不使用 SQL。
- 无 GitHub 轮询、无 web 服务、无 daemon。不引入除 typescript/@types/node 以外的运行时依赖。

## 交付物（文件路径必须一致）

```
pi-router/
  package.json          # name: pi-router, "pi": { "extensions": ["./src/index.ts"] }
                        # peerDependencies: @earendil-works/pi-coding-agent: "*", typebox: "*"
                        # devDependencies: typescript, @types/node
                        # scripts: typecheck, test
  tsconfig.json         # strict, noEmit, module nodenext / moduleResolution nodenext, allowImportingTsExtensions
  src/index.ts          # 扩展入口：注册工具、命令、事件
  src/store.ts          # 账本读写（原子写）+ 摘要生成（纯函数，可测）
  src/prompt.ts         # ROUTER_RULES 常量 + buildDigest()
  src/types.ts          # Task / Report 类型
  agents/router-worker.md
  test/store.test.ts    # node:test，覆盖幂等、追加报告、摘要行数上限、原子写
  README.md             # 安装、用法、设计边界
```

## 数据模型（src/types.ts）

```ts
export type TaskStatus = "queued" | "running" | "needs-human" | "done" | "failed" | "stopped";
export type ReportStatus = "progress" | "blocked" | "ready" | "failed" | "dropped";

export interface Report { at: string; status: ReportStatus; summary: string; question?: string }

export interface Task {
  id: string;            // "t1", "t2", ...
  key: string;           // 幂等键
  goal: string;
  cwd: string;
  status: TaskStatus;
  runId?: string;        // pi-subagents run id
  model?: string;
  worktree?: boolean;
  reports: Report[];
  deliverables?: string[];
  next?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ledger { version: 1; seq: number; tasks: Task[] }
```

## 工具（名字与参数固定）

| 工具名 | 参数 | 行为 |
|---|---|---|
| `router_task_open` | `{ key, goal, cwd?, worktree?, model? }` | 按 `key` 幂等：若存在且状态不是 done/failed/stopped，直接返回既有任务；否则新建 `queued`。返回 `id`、`status`、账本路径。 |
| `router_task_update` | `{ id, status?, runId?, report?: {status,summary,question?}, deliverables?, next? }` | 更新字段；`report` 追加到 `reports[]`（时间戳 ISO）；状态变更写 `updatedAt`。未知 id 抛错。 |
| `router_task_list` | `{ status?: TaskStatus \| "open" }` | 紧凑表格：id/status/key/runId/last report/next。`open` = 非 done/failed/stopped。 |
| `router_memory_append` | `{ section, text }` | 追加 `\n## <ISO 时间> <section>\n<text>\n` 到 memory.md（appendFile，不重写）。 |
| `router_memory_read` | `{ query?, maxChars? }` | 无 query 返回全文（默认截断 8000 字符）；有 query 做大小写不敏感的行过滤，返回命中行 + 行号。 |

约定：
- 所有路径基于 `ctx.cwd`；目录不存在则创建。
- `tasks.json` 写入必须 **temp 文件 + rename** 原子替换，不得直接 `writeFile` 覆盖。
- 工具返回 `{ content: [{ type: "text", text }], details: {...} }`。
- 工具描述要写成给模型看的操作指引（何时用、下一步做什么）。

## 提示词注入（src/prompt.ts + index.ts）

`before_agent_start` 返回 `{ systemPrompt: event.systemPrompt + "\n\n" + ROUTER_RULES + "\n\n" + digest }`。

`ROUTER_RULES` 必须包含这些规则（措辞可润色，语义不得弱化）：

1. 你是 Router：只把目标变成任务、派给 worker、汇总结果。不读业务代码、不做实现、不给实现方案；任务内部拆解属于 worker。
2. 一个独立目标 = 一个任务 = 一个 worker。只有互相独立才并行，有依赖就排队。
3. 派发前任务说明必须写全：目标、范围/边界、验收标准、交付物、失败时怎么办。
4. 派发方式：先 `router_task_open` 拿 id，再调用 `subagent({ agent: "router-worker", task, cwd, worktree })`，然后用 `router_task_update` 写入 `runId` 与 `running`。
5. 报告到达后只做三件事：`router_task_update` 记账 → 决定下一步 → 必要时向人汇报。
6. 不 sleep、不轮询、不反复查 status；子代理完成会自动唤醒会话。
7. 只有 `blocked` / 需要人决策时才打扰用户；`progress` 不转述。
8. 每个重要决定写一行理由到 memory.md（为什么这样拆、为什么换方案）。
9. 交付前先 `router_task_list` 确认没有遗漏的 open 任务。

`digest` 要求：
- 只列 open 任务，最多 20 条；每条一行：`id [status] key — goal(≤80 字符) · last: <status> <summary(≤60)> · next: <≤60>`。
- 顶部一行统计：`open: N · running: M · needs-human: K`。
- 整个 digest ≤ 40 行、≤ 4096 字符，超出按行截断并注明 `…(truncated)`。
- 无 open 任务时输出 `open tasks: none`。

## `/router` 命令

- 无参数或 `status`：`ctx.ui.setWidget("router", lines)` 显示统计 + open 任务。
- `tasks`：同 status。
- `task <id>`：该任务全部报告。
- `memory [query]`：读 memory（query 过滤）。
- `digest`：打印将注入的 digest。
- 同时在 `session_start` / 每次变更后调用 `ctx.ui.setStatus("router", "...")`，格式：`router ● <open> open · <running> running`，无任务时 `undefined`。

## 错误处理

- 账本损坏（JSON 解析失败）：备份为 `tasks.json.bak-<ts>`，以空账本继续，并在命令输出与工具结果中警告，不得崩溃。
- 工具参数校验交给 typebox；业务错误抛出 `Error("...")`。

## 验收标准（reviewer 逐条核对）

1. `npm install && npx tsc --noEmit` 通过，零错误。
2. `npm test` 通过（node:test，至少 4 个用例：幂等 open、报告追加、digest 行数/长度上限、原子写无残留 tmp 文件）。
3. 5 个工具名与参数与上表完全一致；`/router` 命令可用。
4. 代码中不存在 `child_process`、`spawn(`、`--mode rpc`、`-ne`；不存在自造 subagent 队列/进程管理。
5. tasks.json 写入为 temp+rename；memory.md 为 append。
6. digest 有硬上限（40 行 / 4096 字符），且用测试覆盖。
7. package.json 的 host 包放在 `peerDependencies` 且版本 `"*"`，`dependencies` 为空或不含 host 包。
8. README 说明：本地加载方式（`pi -e ./src/index.ts`、`.pi/extensions/`）、需要安装 pi-subagents、worker agent 放在 `.pi/agents/`、账本位置。
9. `agents/router-worker.md` frontmatter 含 `subagent` 工具与「最终报告必须含交付物 / 验证方式 / BLOCKED: 一行问题」的指令。
10. 无 `any`（必要时用 `unknown` + 收窄）；无 `@ts-ignore`。

## 参考材料（只读，不要修改）

- 设计取舍与「不要抄什么」：`../` 无；见本文件。参考仓库：`../repo/src/*.ts`（抄骨架，不抄 `src/subagent/`）。
- pi 扩展 API：`C:/Users/Tom/AppData/Roaming/npm/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- pi 包清单：同目录 `docs/packages.md`
- pi-subagents agent 定义：`C:/Users/Tom/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md`
- pi-subagents 工具参数：`C:/Users/Tom/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md`

注意：Windows 环境，Node v24（原生 TS type stripping），路径使用 `node:path` 处理。