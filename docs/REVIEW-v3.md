# REVIEW — pi-router v3（分层记忆 + 写权限收口）

审查者无 shell/写权限，三份 REVIEW 正文由审查者返回、由 supervisor 汇总。`tsc` / `npm test` 全部由 supervisor 复跑。

| 轮次 | 结果 | 要点 |
|---|---|---|
| review-v3-1 | FAIL（3） | `scopeId` 逃逸校验未接入写路径（P0）；全局封顶后 manifest/chars 未重算（P1）；缺验收 2 的断言（P2） |
| fix-v3-1 | — | 三条全修：`validateMemoryTarget` 接入所有写入口与迁移；manifest 在 4096/60 封顶后重建；补 mtime 不变断言（59 → 63 用例） |
| review-v3-2 | FAIL（7） | `reports=0` 时 `slice(-0)` 返回全量（P1）；审计缺工具级单测；`ROUTER_RULES` 仍指向 `memory.md`；README 工具数写错（7→9）等 |
| fix-v3-2 | — | 新增 `latestReports` / `makeAuditLine` 并接线；规则 10 改为 `router_note` + `/router promote`；README 更正（63 → 65 用例） |
| review-v3-3 | FAIL（1） | 仅剩 P1：`package-lock.json` 版本仍为 0.2.2（`package.json` 已是 0.3.0） |
| fix（supervisor 直接修） | PASS | lockfile 顶层与 `packages[""]` 版本同步为 0.3.0 |
| review-v3-final | 超时（30min） | 未产出结论；不阻塞——第 3 轮仅剩的 P1 已修复并由 supervisor 复核 |

## 3 条 report-only P2（未修，记录在案）

- `store.ts` 中 v2 遗留的 memory helpers 已无人调用（死代码）。
- `migrateMemory` 非事务性：中途失败可能留下部分已写文件（原 `memory.md` 始终保留，可回滚）。
- `/router memory audit` 不显示行号，`promote <行号>` 需人工数行。

## Supervisor 复核（实跑）

```
npx tsc --noEmit → exit 0
npm test         → 65/65 pass
禁词扫描         → 无 child_process/spawn(/--mode rpc；-ne 仅出现在 non-negative/run-newest
any / @ts-ignore → 无
package.json     → 0.3.0，dependencies 为空
```

真实进程冒烟（`PI_ROUTER_HOME` 指向临时目录，未污染真实账本）：

1. **工具面**：9 个 `router_*` 工具含 `router_note` / `router_task_get`；仍无 `write/edit/bash`。
2. **写权限**：`router_memory_append` 只产生 `audit.jsonl` 一行（`kind:"note"`），`global.md` / `projects/*.md` 内容与 mtime 不变；返回文案提示 `/router promote`。
3. **会话层**：`router_note` 写入 `sessions/<sessionId>.json`，`focus` 与 `notes` 正确。
4. **迁移**：临时 `memory.md`（1 个 `[demo]` 块 + 1 个无标记块）→ `projects/demo.md` + `global.md`，原文件改名 `memory.md.migrated-<ts>`，`audit.jsonl` 记录 `imported 2 blocks (global 1, project 1)`，幂等。
5. **注入**：系统提示含 `## global` 层与 `budget: global 111/800 · project 0/1200 · session 0/600 · tasks 0/1400` manifest 行。
