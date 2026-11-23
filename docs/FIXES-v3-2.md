# FIXES-v3-2 — pi-router v3 第二轮返修（reviewer round 2）

只修 reviewer 列出的 3 条问题，未做无关重构。未执行任何 git 写命令。

## 修复记录

### 1. `router_task_get` reports=0 夹取 bug（P1-1）

- 问题：`src/index.ts` 里 `task.reports.slice(-count)` 在 `clampReports(...)` 返回 `0` 时
  变成 `slice(-0) === slice(0)`，把全部报告都返回，违反「夹取 0..20」的 0 端语义。
- 修复：把取最近 N 条的逻辑抽成纯函数 `latestReports(reports, count)`（`src/memory.ts`），
  `count <= 0` 返回空数组；`src/index.ts` 改为调用 `latestReports(task.reports, count)`。
- 用例：新增 `latestReports returns the last N reports and is empty for zero`。

### 2. `ROUTER_RULES` 第 10 条仍写 v2 memory.md（P1-2）

- 问题：`src/prompt.ts:14` 仍是「每个重要决定写一行理由到 memory.md」。
- 修复：改为只写 session/audit，长期保留走 `/router promote`：
  「每个重要决定只写 session/audit，不写 global/project：用 router_note 写会话短时空记忆，
  或用 router_memory_append 写审计理由；要长期保留就请用户执行 `/router promote`。」

### 3. README 计数 + 审计行 helper 级测试（P2）

- `README.md` 工具白名单计数从 「7 个」改为「9 个」。
- `README.md` 测试文件说明从「store / guard / config / workers 四个文件」
  改为「store / guard / config / workers / memory 五个文件」。
- 审计行 helper：抽 `makeAuditLine(input)`（`src/memory.ts`）供 `src/index.ts` 的
  `auditLine` 复用；新增用例覆盖 `task_open` / `task_update` / `dispatch` 三种 kind 的
  `at/session/project/kind` 及其它扩展字段。

## 未采纳/未处理项（非本轮 ISSUES）

- P2-5（`store.ts` 遗留 `appendMemoryUnlocked/Locked`、`readMemory`、`filterMemoryByProject`
  死代码）、P2-6（迁移非事务）、P2-7（audit 视图无行号）不在本轮 ISSUES 列表，按
  「不做无关重构」原则未动。

## 验证

```text
cd pi-router
npx tsc --noEmit     -> exit 0
npm test             -> 65/65 pass
```