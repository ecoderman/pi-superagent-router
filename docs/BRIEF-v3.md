# pi-router v3 需求：分层记忆 + 写权限收口

> 基线 v0.2.2（`docs/BRIEF.md` v1、`docs/BRIEF-v2.md`、`docs/BRIEF-v2.1.md`、`docs/BRIEF-v2.2.md` 已交付）。
> 本文件是**唯一权威规格**。不实现分类器（`input` hook 分诊留到以后）。

## 设计原则（来自 dsh-superagent 的实现核对）

1. **事实结构化，注入卡片化**：进 prompt 的永远是「有界卡片 + `read:` 指针」，原文按需读。
2. **写权限分域**：Router（模型）只能写 **session 层** 与 **审计**；`global` / `project` 只能由人晋升。
3. **每层独立预算，总量封顶**：超限截断并输出 manifest，让模型知道自己被剪了什么。
4. **不新增运行时依赖**，只读模型工具集保持不变（新增工具必须仍是只读语义）。

## ① 记忆层：四个存储位置

```
<home>/
  tasks.json                 事实层（v2 已有，不改 schema，仅 Report 增可选 reason）
  global.md                  全局层：人写。模型只读
  projects/<project>.md      项目层：人/晋升写入。模型只读
  sessions/<sessionId>.json  会话层：模型可写（router_note），会话启动清理过期
  audit.jsonl                审计：append-only，扩展代码写，模型只读
```

- `<home>` 沿用 v2 的解析：`PI_ROUTER_HOME` > `PI_ROUTER_HOME` 配置 > 默认 `~/.pi/agent/router`。
- `<project>` 用现有 `projectName(cwd)`（realpath 的 basename，失败退回 cwd 原值）。
- `<sessionId>` 用 `ctx.sessionManager.getSessionId()`；取不到时用 `"unknown"`。
- 会话过期：`session_start` 时删除 `sessions/*.json` 中 `mtime` 超过 **7 天** 的文件；删除失败忽略。
- 所有目录按需创建（`mkdir -p` 语义）；**读取路径不得因文件不存在而抛错**。

### 记忆写入约束（数据层校验，等价于 SQL CHECK）

```ts
export type MemoryScope = "global" | "project" | "session" | "audit";
export interface MemoryTarget { scope: MemoryScope; scopeId?: string }
// 校验：global → scopeId 必须 undefined；project/session → scopeId 必须非空且不含路径分隔符
```
- 违反时抛 `Error("memory scope: ...")`，**必须有单测**。
- `scopeId` 中含 `/`、`\`、`..` 一律拒绝（防止越权写到别的项目文件）。

### 会话层文件格式

```json
{
  "version": 1,
  "sessionId": "…",
  "project": "pi-router",
  "focus": "正在验证记忆分层",          // 最近一次 router_note 的 focus，可为空
  "notes": [{ "at": "ISO", "text": "…" }],   // 最多保留最近 50 条，FIFO
  "updatedAt": "ISO"
}
```
- 写入走文件锁（复用 `<home>/tasks.lock`）或单独 `sessions.lock`；同一进程内串行即可，但**不得与 tasks.json 写交错损坏**。
- `notes` 超过 50 条时丢弃最旧。

### 审计格式（每行一个 JSON）

```json
{"at":"ISO","session":"…","project":"…","kind":"note|task_open|task_update|dispatch|promote|migrate","taskId":"t3","runId":null,"reason":"user_request","text":"≤200 字符"}
```
- 由**扩展代码**在以下时机追加：`router_task_open` 成功后、`router_task_update` 成功后、`subagent` 自动记 runId 时、`router_memory_append`、`/router promote`、迁移。
- `text` 截断到 200 字符，`reason` 可缺省。
- 追加使用 `appendFile`，**单行不跨写**；失败静默（不得影响主流程）。

## ② 工具面变更

| 工具 | 变化 |
|---|---|
| `router_memory_read` | 参数改为 `{ scope?: "global" | "project" | "session" | "audit", query?, maxChars? }`。默认按 `global → project → session` 顺序返回三段拼接；`query` 做大小写不敏感行过滤（沿用 v2 语义）；`audit` 返回最近 N 行（默认 40）。 |
| `router_memory_append` | **语义改变**：只写 `audit.jsonl`（`kind:"note"`），**绝不写 global/project**。返回文本必须包含「已记入审计；要长期保留请让我执行 `/router promote`」。参数保留 `{ section, text }`，`section` 拼进 `text` 前缀。 |
| `router_note` | **新增**。参数 `{ text, focus? }`。写当前会话 `sessions/<id>.json`（追加 note，可更新 focus）。返回写入后的 `notes` 条数与当前 `focus`。 |
| `router_task_get` | **新增**。参数 `{ id, reports?: number }`。返回单个任务的完整字段 + 最近 `reports` 条（默认 5，夹取 0..20）。这就是 digest 里 `read: task/<id>` 指针的目标。 |
| 其余 v1/v2 工具 | 不变（`router_task_open` / `router_task_update` / `router_task_list` / `router_inspect` / `router_workers`）。 |

`KEEP_TOOLS` 追加 `router_note`、`router_task_get`，**不得加入任何写 global/project 的工具**。`test/guard.test.ts` 的集合断言同步更新。

### `router_task_update` 增加 `reason`

- 可选枚举：`user_request | blocked_question | rework | superseded | promoted | other`。
- 写进 `Report.reason`（`types.ts` 里 `Report` 增可选字段，Ledger 版本 **保持 2**，向后兼容）。
- 同时写进该次审计行。

## ③ 上下文组装：`assemble()` 取代现在的 digest 拼接

新文件 `src/memory.ts` 导出：

```ts
export interface LayerBudget { global: number; project: number; session: number; tasks: number } // 字符预算
export interface AssembledLayer { layer: "global" | "project" | "session" | "tasks"; chars: number; truncated: boolean }
export interface AssembledContext { text: string; layers: AssembledLayer[] }

export function assembleMemory(input: {
  global: string; project: string; projectName: string;
  session: SessionState | undefined;
  tasks: Task[];
  digestOptions: DigestOptions;              // 复用 v2 的 project/scope/maxOpenShown
  budget?: Partial<LayerBudget>;
}): AssembledContext;
```

- 默认预算：`global 800 / project 1200 / session 600 / tasks 1400`，总上限 **≤ 4096 字符**、**≤ 60 行**（沿用 v2 的 4096 硬上限，行数从 40 放宽到 60 因为多了三层标题行）。
- 顺序固定：`## global` → `## project <name>` → `## session` → `## open tasks`。
- 每层独立截断，截断处加 `…(truncated <n> chars)`；空层输出该层标题 + `(empty)`（**不省略标题**，让模型知道有这一层）。
- 末尾追加一行 manifest：`budget: global 320/800 · project 0/1200 · session 90/600 · tasks 1100/1400`。
- `tasks` 层沿用 v2 `buildDigest` 的内容，但每行末尾追加 ` · read: task/<id>`。
- 纯函数，不读盘；读盘在 `index.ts` 完成（便于单测）。

`before_agent_start` 改为：读取四份来源 → `assembleMemory(...)` → `${event.systemPrompt}\n\n${ROUTER_RULES}\n\n${assembled.text}`。
**若读盘失败**（除 ENOENT）→ 用 v2 的 digest 兜底并注入一条 `[router 警告]`，不得让 hook 抛错。

## ④ `/router` 命令

保留全部 v2 子命令，新增：

| 子命令 | 行为 |
|---|---|
| `memory [scope] [query]` | `scope` 可为 `global`/`project`/`session`/`audit`；无参时按默认三段 |
| `promote <audit行号> [global|project]` | 把 audit 第 n 行（从 1 开始，倒序计数）的 `text` 追加到 `global.md` 或 `projects/<project>.md`，并写一条 `kind:"promote"` 审计；目标缺省 `project` |
| `session` | 显示当前会话的 focus 与最近 5 条 note |

`/router promote` 的写入必须走文件锁，并在成功后 `notify`。

## ⑤ 迁移（不能丢数据）

`<home>/memory.md`（v2 的单一文件）在首次访问时拆分：

1. 解析 `## <ISO> [<project>] <section>` 与 `## <ISO> <section>` 两种块头；
2. 带 `[project]` 的块 → `projects/<project>.md`（保留原块文本与顺序）；不带 → `global.md`；
3. 追加写（不覆盖已有内容）；末尾补一行 `<!-- migrated from memory.md at <ISO> -->`；
4. 原文件改名 `memory.md.migrated-<ts>`；
5. 写一条 `kind:"migrate"` 审计，`text` 记「imported N blocks (global a, project b)」。
- 迁移必须**幂等**：文件已改名则不再执行。
- 迁移失败（解析异常）→ 保留原文件不动，返回 warning，**不得删数据**。

## 验收标准（逐条可核对）

1. `npx tsc --noEmit` 退出 0；`npm test` 全绿（≥ 56 用例）。
2. `router_memory_append` 只写 `audit.jsonl`：调用前后 `global.md`/`projects/*.md` 的 mtime 与内容不变（用例断言）。
3. `router_note` 写 `sessions/<id>.json`：focus 更新、notes 追加、超过 50 条 FIFO（用例）。
4. `router_task_get` 返回完整任务与最近 N 条报告，`reports` 夹取到 0..20（用例）。
5. `assembleMemory`：四层顺序正确、每层独立预算、总量 ≤4096 字符 / ≤60 行、空层输出 `(empty)`、manifest 行存在（用例逐项断言）。
6. `MemoryTarget` 校验：`global` 带 `scopeId` 抛错；`project`/`session` 缺 `scopeId` 抛错；`scopeId` 含 `/`、`\`、`..` 抛错（用例）。
7. 迁移：`memory.md` 中带/不带 `[project]` 的块分别落到 `projects/<p>.md` / `global.md`，原文保留、原文件改名、幂等（用例）。
8. 审计：`router_task_open`/`router_task_update`/自动记 runId 各产生一行，字段 `at/session/project/kind` 齐全（用例）。
9. `Report.reason` 可选枚举生效；账本 `version` 仍为 2，旧账本可读（用例）。
10. `KEEP_TOOLS` 含 `router_note`、`router_task_get`，且不含任何写 global/project 的工具；无 `write`/`edit`/`bash`（`guard.test.ts`）。
11. 只读性不变：模型侧无文件写工具；记忆写入全部经由扩展代码。
12. 无 `child_process`/`spawn(`/`--mode rpc`/`-ne`；无 `any`/`@ts-ignore`；`dependencies` 为空。
13. 版本 `0.3.0`；README 增「记忆分层」「写权限」「/router promote」三节；`docs/README.md` 索引补 BRIEF-v3。
14. 代理未执行任何 git 写操作。

## 测试要求（node:test，新增 ≥ 12 用例）

- assembleMemory：顺序 / 预算 / 总量 / 空层 / manifest / 指针 `read: task/<id>`
- MemoryTarget 校验（4 种非法输入）
- session 读取、note 追加、FIFO 50、focus 更新
- audit 追加与按 project 过滤、`text` 200 字符截断
- 迁移拆分 + 幂等 + 解析失败保留原文件
- `router_task_get` 夹取
- `Report.reason` 往返

## 工作方式

- 只改工作区文件；**不执行任何 git 命令**（版本控制由 supervisor 负责）。
- 不改 `docs/BRIEF*.md`、不改 `docs/PLAN*.md`。
- 完成后必须实跑 `npx tsc --noEmit && npm test` 并把真实输出摘要写进报告。
- 任何无法满足的验收项必须显式说明，不得静默跳过。