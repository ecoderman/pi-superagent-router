# pi-router v2.2 需求（增量）

> 基线：v0.2.1。本文件只描述增量：让用户能**自己输命令开任务/派任务**。

## 动机

v2.x 之前 `/router` 只有只读子命令（status/tasks/task/memory/digest），用户想开任务只能
用自然语言描述目标，由模型自行决定是否开任务。缺少一个明确的“我现在就要开这个任务”的入口。

## 变更（`src/index.ts`）

新增两个子命令，二者都**不在扩展里直接派活**，而是通过 `pi.sendUserMessage()` 触发一次
模型回合，由模型按 `ROUTER_RULES` 走 `router_task_open → subagent → router_task_update`：

| 命令 | 行为 |
|---|---|
| `/router new <目标描述>` | 空目标 → `notify("用法：/router new <目标描述>", "error")`；否则注入一条用户消息：用 Router 流程处理该目标，key 自己取稳定短标识，派发后不要手写 runId（扩展自动记），最后记账。 |
| `/router spawn <id>` | 任务不存在 → 报错；任务非 `queued` 或已有 `runId` → 报错（`不能直接派发`）；否则注入：用 `subagent({ agent: "router-worker", task, cwd })` 派发该任务，不要手写 runId 或状态。 |

其它：

- 命令 `description` 与 `getArgumentCompletions` 同步补上 `new` / `spawn`。
- 未知子命令的错误文案列出全部子命令。

## 为什么不在扩展里直接调用 subagent

Pi 文档明确不建议在工具/钩子链里递归触发 subagent 委托，且扩展直接派发会绕过模型的
brief 编写（目标/边界/验收/交付物）。走“注入用户消息 → 模型按规则执行”既保留提示词纪律，
又让 `runId` 自动绑定、任务记账、blocked 处理全部沿用同一条路径。

## 验收标准

1. `npx tsc --noEmit` 退出 0；`npm test` 全绿（44 用例不变）。
2. `/router new <目标>` 与 `/router spawn <id>` 可用；空目标、未知 id、非 queued 任务分别报错。
3. 命令 `description` 与补全包含 `new` / `spawn`。
4. 真实会话（RPC）发 `/router new ...` 后，账本出现新任务且 `runId` 自动绑定 → 已验证。
5. 版本 `0.2.2`；README 命令列表已更新。
