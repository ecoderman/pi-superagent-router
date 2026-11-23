# PLAN-v3 — 分层记忆 + 写权限收口

> 权威规格 `docs/BRIEF-v3.md`；本计划只定文件级顺序、算法边界与风险，不写完整实现。
> 基线：BRIEF-v2 / v2.1 / v2.2 / REVIEW-v2 已交付。仅改 pi-router 工作区，不动 BRIEF*/PLAN*/REVIEW*，不执行 git 写命令。

## 1. 文件级顺序与边界
新增 `src/memory.ts`（纯函数域，不读盘），导出：
- `type MemoryScope = "global"|"project"|"session"|"audit"`
- `interface MemoryTarget { scope: MemoryScope; scopeId?: string }`
- `validateMemoryTarget(t: MemoryTarget): void` —— 违例抛 `Error("memory scope: ...")`
- `interface SessionNote { at: string; text: string }`
- `interface SessionState { version:1; sessionId; project; focus; notes:SessionNote[]; updatedAt }`
- `emptySession(sessionId, project): SessionState`
- `parseSessionState(raw: unknown): SessionState | undefined`
- `appendSessionNote(state, text, focus?): SessionState` —— 追加 note + 更新 focus + notes FIFO 50（纯）
- `serializeSession(state): string`
- `interface LayerBudget { global; project; session; tasks }`；`DEFAULT_LAYER_BUDGET = { global:800, project:1200, session:600, tasks:1400 }`
- `interface AssembledLayer { layer; chars; truncated }`；`interface AssembledContext { text; layers }`
- `assembleMemory(input): AssembledContext`
- `type AuditKind = "note"|"task_open"|"task_update"|"dispatch"|"promote"|"migrate"`
- `interface AuditLine { at; session; project; kind; taskId?; runId?; reason?; text? }`
- `truncateText(text, n=200): string`；`formatAuditLine(line): string`
- `parseMemoryBlocks(text): { global: string[]; projects: Record<string,string[]> }`（纯，异常上抛）

`src/store.ts` 增 I/O + 锁（不动纯函数）：
- 路径：`sessionsDir / sessionPath / auditPath / globalMemoryPath / projectMemoryPath / legacyMemoryPath`
- `readGlobalMemory / readProjectMemory / readSession` —— ENOENT 返回 `""`/`undefined`，不抛
- `writeSessionLocked / appendSessionNoteLocked / pruneSessions(home, maxAgeMs=7d)`
- `appendAudit(home, line)`（单行 appendFile，失败静默）；`readAudit(home, { project?, limit? })`
- `migrateMemory(home)`（锁内、幂等、失败保留原文件）
- `resolveMemoryTarget(scope, project, sessionId): MemoryTarget`；`readScopedMemory(home, target, opts)`

`src/prompt.ts`：`ROUTER_RULES` 第 10 条改为「模型只写 session/audit；长期保留走 /router promote」；导出 `taskRow` + `projectOpenTasks` 供 `buildDigest` 与 `memory.ts` 复用；`buildDigest` 保留作读盘失败兜底。
`src/index.ts`：工具/命令 wiring + `before_agent_start` / `session_start` / `tool_result`。
`src/types.ts`：`Report` 增 `reason?: ReportReason`；`Ledger.version` 保持 2。

## 2. assembleMemory 截断算法
固定顺序 `## global` → `## project <name>` → `## session` → `## open tasks`：
1) 预算 = `DEFAULT_LAYER_BUDGET` overlay `input.budget`（每项 clamp ≥ 0）。
2) 各层渲染标题 + 正文：global/project 用原文；session 用 focus 行 + notes 逐行；tasks 用 `projectOpenTasks(...)`，每行尾追加 ` · read: task/<id>`。
3) 每层独立截断：正文空 → 输出 `(empty)` 且 `chars=0`；超预算 → 保留 head + `…(truncated <n> chars)`，`chars=` 保留源字符数。
4) 空层不省略标题；空行拼接各层，记录每层 `chars/truncated`。
5) 全局封顶：先保留 manifest 行 `budget: global C/800 · project P/1200 · session S/600 · tasks T/1400`；正文限 `4096 - manifest.length - 1` 字符且 ≤ 59 行，从末层向前 trim（整层丢弃 → 行/字符截断），trim 过则补 `…(truncated)`。
6) 返回 `{ text: body + "\n" + manifest, layers }`；`layers.chars` 取封顶后实际值。
纯函数；总上限 4096 字符 / 60 行；manifest 恒在末行。

## 3. session 并发 + 7 天清理
- 复用 `<home>/tasks.lock` 的 `withLock`：读-改-写串行，与 tasks.json / promote / migrate 同锁互斥，不交错损坏。
- 原子写沿用 `saveLedger` 风格（temp + rename + EPERM/EBUSY 重试），在 `writeSessionLocked` 内完成。
- `pruneSessions`：`session_start` 时 `withLock` 下读 `sessions/*.json`，`stat.mtime` 超 7 天 `rm(force)`；删除失败忽略；目录按需 mkdir。

## 4. audit.jsonl 写点（6 处）
单行原子：`formatAuditLine` → `JSON.stringify`（`text` 已 `truncateText≤200`；换行由 JSON 转义）→ 追加 `\n` 后一次 `appendFile`；先 mkdir；失败 try/catch 静默。
1) `router_task_open` 成功后 —— `kind:"task_open"`（taskId）
2) `router_task_update` 成功后 —— `kind:"task_update"`（taskId, reason?, summary）
3) `tool_result` 自动记 runId —— `kind:"dispatch"`（taskId, runId）
4) `router_memory_append` —— `kind:"note"`（text = `[section] ` + text）
5) `/router promote` —— `kind:"promote"`
6) 迁移 —— `kind:"migrate"`（text = `imported N blocks (global a, project b)`）
字段 `at/session/project/kind` 必填；`taskId/runId/reason/text` 可选。

## 5. memory.md 迁移解析
- 两种块头：`^## (\S+) \[([^\]]+)\] (\S.*)$`（带 `[project]`）与 `^## (\S+) (\S.*)$`（无 project）。
- `parseMemoryBlocks` 按行切块：带 `[project]` → `projects` 桶；不带 → `global` 桶；保留原块头 + 体与顺序。
- `migrateMemory`：锁内 read → parse（异常上抛）→ 追加到 `global.md` / `projects/<p>.md`（不覆盖）→ 每文件尾补 `<!-- migrated from memory.md at <ISO> -->` → 原文件 `rename` 为 `memory.md.migrated-<ts>` → 写 `kind:"migrate"`。
- 幂等：`memory.md` ENOENT（已改名）→ 直接返回；parse/append 失败 → 不 rename，保留原文件并返回 warning，不删数据。

## 6. MemoryTarget 校验 + scopeId 逃逸
- `validateMemoryTarget`：scope 必须四选一；`global`/`audit` → scopeId 必须 undefined；`project`/`session` → scopeId 非空且不匹配 `/[/\\]|\.\./`；否则抛 `Error("memory scope: ...")`。
- store 拼接路径前必须先 validate；工具侧 scopeId 由扩展从 ctx 解析（project=当前 project、session=当前 sessionId），绝不接受模型传 scopeId。
- 单测：global 带 scopeId；project/session 缺 scopeId；scopeId 含 `/`、`\`、`..`。

## 7. 风险
- Windows：路径分隔 `\` 与 `..` 均拒绝；rename 覆盖已有目标走 `saveLedgerWithRetry` 的 EPERM/EBUSY 重试；锁句柄先 close 再 unlink。
- 并发：session/promote/migrate 全走 `tasks.lock`；audit 单行 appendFile 不取锁，跨进程极端下可能行间交错（接受，规格只要求单行不跨写）。
- 只读工具：`KEEP_TOOLS` 增 `router_note` / `router_task_get`，无任何写 global/project 工具；`guard.test.ts` 同步；`router_memory_append` 语义改为仅写审计。
- `Report.reason` 兼容：可选枚举；`Ledger.version` 保持 2；`parseReport` 对缺失 reason 不报错、未知值忽略/回退，旧账本可读。
