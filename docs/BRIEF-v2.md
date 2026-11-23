# pi-router v2 需求（当前权威规格）

> 本文件**取代** `BRIEF.md`（v1，已交付 v0.1.0）。实现与审查一律以本文件为准。
> v1 已有的 5 个工具、digest 注入、`/router` 命令、原子写、损坏恢复**全部保留**，v2 在其上增加能力。

## 目标

把 pi-router 从「单项目记账器」升级为「**项目级/全局个人助手**」：

1. 装上扩展后，**任何用户主动打开的会话自动就是 Router**，无需指定、无需开关。
2. 所有 Router **共享同一份记忆**（跨项目）。
3. Router **只能读 + 派活**，物理上改不了文件（不是靠提示词约束）。
4. 派活后 Router **能看到 worker 的会话**（runId + session 路径 + 状态）。
5. worker 侧不受限制：有 `write/edit/bash`，可再嵌套 subagent（v1 已如此）。

## 不可更改的架构约束

- Router = Pi 主会话；worker = pi-subagents 子会话。两者靠 `PI_SUBAGENT_CHILD === "1"` 区分（v1 已实现，保留）。
- **模型层的写能力必须消失**，但**扩展代码层继续写账本**（`tasks.json` / `memory.md` 由扩展 `execute` 内部写，不经过模型工具）。
- 不自己 spawn 进程、不实现 subagent 运行时、不包装 dispatch 工具。
- 不新增运行时依赖（仅用 `node:*` + 宿主 peer 包）。
- **禁止任何代理执行 `git commit` / `git tag` / `git push`**。版本控制由 supervisor 统一负责。工作区在 git 仓库内（v0.1.0 已打 tag），`.pi/` 已 gitignore。

## 交付物变更

```
docs/BRIEF-v2.md          # 本文件（已存在）
src/types.ts              # Ledger v2、Task 增加 project/ownerSession、RouterConfig
src/config.ts             # 新增：读取 ~/.pi/agent/router.json
src/store.ts              # 全局 home、锁、v1→v2 迁移、memory 全局化
src/inspect.ts            # 新增：只读检查（git-status/git-log/git-diff/tree）
src/prompt.ts             # digest 分层（全局统计 + 当前项目明细）
src/index.ts              # setActiveTools、tool_call 拦截、router_workers、tool_result 自动记 runId、session_start 重放
test/store.test.ts        # 保留并扩展
test/guard.test.ts        # 新增：只读拦截与 inspect 白名单
test/config.test.ts       # 新增：配置解析与默认值
README.md                 # 更新：全局安装、只读行为、worker 可见性
```

## ① 全局记忆（store/types/prompt）

- 账本根目录：`config.home`，默认 `path.join(os.homedir(), ".pi", "agent", "router")`。
- 可用环境变量 `PI_ROUTER_HOME` 覆盖（优先级：env > config.json > 默认）。
- 文件：`<home>/tasks.json`、`<home>/memory.md`。
- 账本版本 2：

```ts
export interface Task {
  id: string; key: string; goal: string;
  project: string;        // 新：项目标识（见下）
  cwd: string;
  ownerSession: string;   // 新：创建该任务的会话 id
  status: TaskStatus;
  runId?: string;
  model?: string;
  worktree?: boolean;
  reports: Report[];
  deliverables?: string[];
  next?: string;
  createdAt: string; updatedAt: string;
}
export interface Ledger { version: 2; seq: number; tasks: Task[] }
```

- `project` 取值：`basename(realpath(cwd))`；cwd 无法解析时用 `cwd` 原值。同一物理项目不同层级路径应得到同一 `project`（用 realpath 归一）。
- `ownerSession` 取自 `ctx.sessionManager.getSessionId()`；取不到时用 `"unknown"`。
- **迁移**：`loadLedger` 遇到 `version === 1` 或 `<cwd>/.pi/router/tasks.json` 存在时，导入到全局账本：
  - v1 任务补 `project = basename(cwd)`、`ownerSession = "migrated"`，其余字段原样保留；
  - 导入后把旧文件改名为 `tasks.json.migrated-<ts>`（不删除，可回滚）；
  - 迁移结果参与同一把锁。
- `memory.md` 全局单文件，追加块格式改为：
  `\n## <ISO> [<project>] <section>\n<text>\n`
  `router_memory_append` 自动带上当前 `project`（可由可选参数 `project` 覆盖）。
- `router_memory_read` 支持可选 `project` 过滤（大小写不敏感匹配 `[<project>]` 前缀行及其后续内容）。

## ② 并发锁（store）

- 所有写路径（open/update/append/migrate）必须在锁内执行：
  - 锁文件 `<home>/tasks.lock`，用 `fs.open(path, "wx")` 独占创建，内容 `{ pid, at }`。
  - 获取失败退避重试（25ms 起，指数到 200ms），总超时 3000ms；超时抛错。
  - 锁文件 mtime 超过 10s 视为陈旧，允许接管（先 unlink 再重试一次）。
  - `finally` 中释放（unlink），释放失败忽略。
- 读路径（digest、list、命令、工具只读操作）不取锁，接受最终一致。
- 测试必须覆盖：并发 20 次 open 不丢任务、`seq` 无重复。

## ③ 硬只读（index/inspect）

三层，缺一不可：

**层 A：拿掉工具**（`session_start` 中执行，且每次 `before_agent_start` 兜底重放）
```ts
const KEEP = ["read", "grep", "find", "ls", "subagent",
  "router_task_open", "router_task_update", "router_task_list",
  "router_memory_append", "router_memory_read", "router_workers", "router_inspect"];
pi.setActiveTools(KEEP);
```
- 必须在 `session_start`（new/resume/fork/reload 都触发）里执行，保证每个会话都是只读 Router。
- 必须在 `PI_SUBAGENT_CHILD !== "1"` 时才执行（子会话不碰）。
- 若 `config.routerReadOnly === false`，跳过层 A 与层 B（逃生开关，默认 true）。

**层 B：`router_inspect`**（替代 bash）
- 参数：`{ cmd: "git-status" | "git-log" | "git-diff" | "tree", limit?: number }`
- 固定 argv，不接受自由字符串、不接受 shell 元字符：
  - `git-status` → `git status --porcelain=v1 --branch`
  - `git-log` → `git log --oneline -n <limit ?? 20>`
  - `git-diff` → `git diff --stat`
  - `tree` → 内部 fs 遍历，深度 ≤ 2，条目 ≤ `limit ?? 200`，跳过 `node_modules`、`.git`、`.pi`
- 用 `pi.exec(cmd, argv, { cwd: ctx.cwd, timeout: 10_000 })`；错误以文本返回（`isError: false`，附带 exit code），不抛。
- `limit` 必须夹到 `1..500`。

**层 C：`tool_call` 拦截兜底**
```ts
pi.on("tool_call", async (event) => {
  if (!readOnlyEnabled) return;
  if (event.toolName === "write" || event.toolName === "edit") return { block: true, reason: "Router 只读：请派 worker" };
  if (event.toolName === "bash") return { block: true, reason: "Router 不用 bash：请用 router_inspect" };
});
```
- 覆盖 `cp`/`mv`/`rm` 等工具名（若宿主提供）：任何名字以 `write`/`edit`/`apply` 开头或等于 `bash`/`powershell` 的一律拦，理由文案固定前缀 `Router 只读`。

## ④ worker 可见性（index）

**`router_workers`**：`{ status?: "active" | "done" | "all" }`（默认 `active`）
- 数据来源：账本（若有 `runId`）+ 只读探测 pi-subagents 运行目录。
- 运行目录发现顺序：
  1. 环境变量 `PI_SUBAGENTS_RUN_DIR`（若设置）
  2. `path.join(os.tmpdir(), "pi-subagents-user-" + os.userInfo().username, "async-subagent-runs")`
  3. 找不到就只输出账本信息并注明「运行目录未找到」
- 每个 run 尝试读 `<runDir>/<runId>/status.json`；缺失/损坏则忽略，不报错。
- 输出行格式：`<taskId> [<taskStatus>] <project> · run <runId> · <state> · session <sessionPath ?? "?"> · last: <reportStatus> <summary≤60>`
- 顶部统计：`workers: N active · M done`。
- 只读：绝不修改 run 目录。

**自动记账（`tool_result` hook）**
- 监听 `toolName === "subagent"` 的成功结果，从 `details` 中提取 `runId`（兼容 `details.runId` / `details.runs[0].runId` / `details.childRunId`），若当前存在唯一 `queued` 且无 `runId` 的任务，则写入 `runId` 并置 `running`。
- 提取失败或存在歧义（>1 个候选）时**不猜**，静默跳过。
- 该写入同样走锁。

## ⑤ 配置与自动进入（config/index）

`~/.pi/agent/router.json`（可缺省，缺省即默认值）：

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

- `scope: "project"` 时 `home = <cwd>/.pi/router`（保持 v1 行为，供不想全局共享的用户）。
- `home` 支持 `~` 展开。
- 配置读取失败（JSON 坏 / 字段类型错）→ 记录 warning 并回退默认，不崩溃。
- `workerModel` 仅作为 digest 顶部一行提示写进 systemPrompt（`worker model: <id>`），扩展本身不派活、不改模型。

## 提示词（prompt）

`ROUTER_RULES` 在 v1 九条基础上追加/改写三条（语义必须保留）：

- 你**不能修改文件**：没有 write/edit/bash。需要查状态用 `router_inspect`，需要改代码就派 worker。
- 派活后写 `runId` 可省略（扩展会自动记），但 `subagent` 调用与 `router_task_open` 的 key 必须对应。
- 用 `router_workers` 查看正在跑的 worker 与它们的 session 路径；要看过程用 `subagent({action:"status", id, options:{view:"transcript"}})`。

digest 变更：
- 首行：`global: <open 总数> open · <running> running · <needs-human> needs-human`
- 次行（仅在 `scope=global`）：`project <name>: <open N> open`
- 其余为**当前项目**的任务明细（最多 20 条），格式沿用 v1。
- 保留 40 行 / 4096 字符硬上限与 `…(truncated)`。
- 无任务时 `open tasks: none`（此行不得因全局统计而消失，全局统计单独成行）。

## 验收标准（reviewer 逐条核对，编号引用）

1. `cd pi-router && npx tsc --noEmit` 退出码 0；`npm test` 全绿。
2. 5 个 v1 工具名/参数不变；`/router` 子命令（status/tasks/task/memory/digest）仍可用。
3. 新增工具 `router_workers`、`router_inspect` 参数与本文一致。
4. `session_start` 中调用 `pi.setActiveTools`，白名单恰为本文 `KEEP`（顺序可不同，集合必须一致）；`PI_SUBAGENT_CHILD=1` 时不执行。
5. `tool_call` 拦截覆盖 `write`/`edit`/`bash`，reason 以 `Router 只读` 开头。
6. 账本 v2：`version === 2`、`task.project`、`task.ownerSession` 存在；v1 文件可迁移且不改动原文件（改名为 `.migrated-<ts>`）。
7. 写路径全部在锁内；并发测试（20 并发 open）无丢失、`seq` 唯一。
8. 账本/memory 默认写入 `~/.pi/agent/router/`；`PI_ROUTER_HOME` 与 config `home` 能覆盖；`scope: project` 回退到 `<cwd>/.pi/router`。
9. digest 有全局统计行 + 项目明细行，仍是 ≤40 行 / ≤4096 字符，且有测试。
10. `router_workers` 在运行目录不存在时优雅降级（输出账本信息 + 提示），不抛错。
11. `tool_result` 自动记 runId 仅在唯一候选时生效，歧义时跳过（可通过导出的纯函数单测）。
12. 无 `child_process`、无 `spawn(`、无 `--mode rpc`、无 `-ne`；无 `any`/`@ts-ignore`；`dependencies` 为空，host 包留在 `peerDependencies`。
13. `package.json` 版本升到 `0.2.0`；`README.md` 更新全局安装、只读行为、`router_workers`/`router_inspect`、全局账本位置与迁移说明。
14. 代理未执行任何 `git commit`/`git tag`/`git push`（`git status --porcelain` 只需显示工作区改动）。

## 测试要求（node:test，至少 10 个用例）

- 幂等 open（保留 v1 用例）
- 报告追加（保留）
- digest 上限（保留，改为断言 v2 两行统计）
- 原子写无 tmp 残留（保留）
- 损坏账本备份（保留）
- **v1→v2 迁移**：构造 v1 文件 → 迁移后字段正确、原文件改名
- **全局 home 覆盖**：`PI_ROUTER_HOME` 与 `scope: project`
- **并发 20 open**：任务数 = 20、id 唯一
- **只读拦截**：`shouldBlockTool("write"/"edit"/"bash"/"read")` 纯函数
- **inspect 白名单**：未知 cmd 被拒、`limit` 夹取
- **runId 提取**：唯一候选写入、歧义跳过（纯函数）

## 工作方式

- 代理**只改工作区文件**，不碰 git 历史。
- 完成后由 supervisor 执行：`npx tsc --noEmit && npm test` → 审查 → 提交（`feat(v2): ...`）→ tag `v0.2.0`。