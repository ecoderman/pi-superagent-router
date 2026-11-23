# FIXES-1 — 审查者第 1 轮问题修复记录

## P1（阻塞）主会话守卫使用了不存在的环境变量

- **问题**：`src/index.ts` 工厂函数顶部用 `if (process.env.PI_SUBAGENT_ID) return;` 判定「非主会话」。
  参考 pi-subagents 运行时从不设置 `PI_SUBAGENT_ID`，子会话判定是 `process.env.PI_SUBAGENT_CHILD === "1"`。
  `undefined` 恒为假 → 守卫永远不触发，后台子会话会泄漏加载 router 的 5 个工具与 `ROUTER_RULES` 注入。
- **改法**：改为 `if (process.env.PI_SUBAGENT_CHILD === "1") return;`，并同步注释。
- **涉及文件**：`src/index.ts`、`README.md`（设计边界描述）、`PLAN.md`（§0 / §1.4 / §3.5 的 R6 引用，避免后续按陈旧计划再错一次）。

## P2（非阻塞，现已修复）底栏状态未按 BRIEF「每次变更后」刷新

- **问题**：`render` 只在 `session_start` 与 `/router` 命令末尾调用；`router_task_open` / `router_task_update`
  两个写工具落盘后未刷新 `ctx.ui.setStatus`，工具变更后底栏不会即时更新。
- **改法**：在两个写工具的 `saveLedger` 之后补 `render(ctx, ledger)`。
- **涉及文件**：`src/index.ts`。

## P2（非阻塞，现已修复）隐藏条件与 BRIEF 不符

- **问题**：`render` 用 `open === 0` 决定返回 `undefined`，而 BRIEF 原文是「无任务时 `undefined`」。
- **改法**：改为 `ledger.tasks.length === 0 ? undefined : ...`。这样仅有终态任务（done/failed/stopped）时仍显示
  `router ● 0 open · 0 running`，只在账本完全没有任务时隐藏，与 BRIEF 一致。
- **判断说明**：审查意见里「存在 running 任务但 0 个 open 时会错误隐藏」的举例本身不成立——`running` 是非终态，
  会被 `isOpen` 计入 open。但结论（隐藏条件应放宽为「无任务」）正确，故按结论修复，不按这个举例的措辞修改语义。
- **涉及文件**：`src/index.ts`、`PLAN.md`（§3.5 的 render 示例同步）。

## P2（仅记录，不阻塞，不做代码改动）账本 read-modify-write 无锁

- **问题**：`applyOpen` / `applyUpdate` 是「读全量 → 改 → 原子写」，并行工具调用/多进程可能丢更新。
- **处理**：**记录不修复**。BRIEF 未要求并发/多进程一致性；单 agent 串行调用下无影响。引入锁会新增运行时状态与复杂度，超出 BRIEF 范围，且无验收点要求。
- **涉及文件**：无代码改动；此处仅记录该已知限制。