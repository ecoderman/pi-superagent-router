# pi-router 实施计划（可执行）

本计划只做实现规划，不写 src 代码、不创建 package.json。目标读者：一个不了解上下文的工程师，拿到本文件即可按顺序实现。

- 权威需求：`BRIEF.md`（唯一权威）+ `API-NOTES.md`
- 参考骨架：`../repo/src/*.ts`（只抄骨架，**不抄** `../repo/src/subagent/`）
- 运行环境：Windows，Node v24（原生 TS type stripping），`type: module`

---

## 0. 关键设计决策（先读，避免返工）

1. **Router 扩展只在主会话生效**。index.ts 工厂函数顶部必须：
   ```ts
   if (process.env.PI_SUBAGENT_CHILD === "1") return;
   ```
   否则 worker（后台子会话会加载主会话 ambient extensions）也会拿到 router 工具和 ROUTER_RULES，违反「Router = 主会话」约束。同时在 `agents/router-worker.md` frontmatter 加 `extensions: []`，双保险禁止 worker 加载 router 扩展。

2. **Router 不注册、不包装 `subagent` 工具**。Worker 派发由模型直接调用 pi-subagents 已暴露的 `subagent({ agent: "router-worker", task, cwd, worktree })`，Router 只通过 ROUTER_RULES 告知模型怎么调用。5 个 router 工具只做记账/读账，绝不在 `execute` 里调 `ctx.executeTool("subagent", ...)`。

3. **store.ts / prompt.ts 零宿主依赖**。只 import `node:*` 和 `./types.ts`，不 import `@earendil-works/pi-coding-agent`、不 import `typebox`。这样 `node --test` 无需宿主包即可运行。只有 index.ts import 宿主类型和 typebox。

4. **路径用 `.pi` 字面量**（BRIEF 明确要求 `.pi/router/`），不 import `CONFIG_DIR_NAME`，保证 store/prompt 可独立测试。若未来要品牌化目录名，只改 store.ts 里的单个常量即可（见风险 R5）。

5. **`type: module` 必须有**（package.json），否则 NodeNext 下 `.ts` 被当 CJS，`import { Type } from "typebox"`（ESM-only）运行时报错。BRIEF 没反对加这个字段。

---

## 1. 文件级实施顺序

按此顺序实现，每个文件完成后即可被下一个依赖；最后再写 package.json / tsconfig，然后 typecheck + test。

### 1.1 `src/types.ts`（第一步，纯类型，零依赖）

完全照抄 BRIEF 数据模型，导出（无运行时逻辑）：

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

### 1.2 `src/store.ts`（第二步，依赖 types.ts，零宿主依赖）

职责：账本读写（原子写 + 损坏备份）、memory 读写、以及幂等/追加/digest 用到的**纯函数**。

导出清单与签名（伪代码，落实时为具体 TS）：

```ts
import { mkdir, readFile, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Ledger, Task, Report, ReportStatus, TaskStatus } from "./types.ts";

// 路径
export const ROUTER_DIR = ".pi/router";
export function routerDir(cwd: string): string;   // join(cwd, ".pi", "router")
export function tasksPath(cwd: string): string;    // join(dir, "tasks.json")
export function memoryPath(cwd: string): string;   // join(dir, "memory.md")

// 账本
export function emptyLedger(): Ledger;             // { version: 1, seq: 0, tasks: [] }
export function parseLedger(raw: unknown): Ledger; // 结构校验，非法抛 TypeError
export async function loadLedger(cwd: string): Promise<{ ledger: Ledger; warning?: string }>;
export async function saveLedger(cwd: string, ledger: Ledger): Promise<void>;

// memory
export async function appendMemory(cwd: string, section: string, text: string): Promise<void>;
export async function readMemory(cwd: string): Promise<string>; // 不存在返回 ""
```

纯函数（无 IO，单测对象）：

```ts
const TERMINAL: readonly TaskStatus[] = ["done", "failed", "stopped"];
export function isOpen(t: Task): boolean;                 // !TERMINAL.includes(t.status)
export function lastReport(t: Task): Report | undefined;
export function clip(s: string, n: number): string;       // 结果 length <= n
export function formatTaskRow(t: Task): string;           // /router 列表行
export function countBy(tasks: Task[], status: TaskStatus): number;
export function findOpen(ledger: Ledger, key: string): Task | undefined;
export function nextId(ledger: Ledger): string;           // "t" + (seq + 1)

export interface OpenInput { key: string; goal: string; cwd: string; worktree?: boolean; model?: string }
export function applyOpen(ledger: Ledger, input: OpenInput): { task: Task; created: boolean };

export interface ReportInput { status: ReportStatus; summary: string; question?: string }
export interface UpdatePatch { status?: TaskStatus; runId?: string; report?: ReportInput; deliverables?: string[]; next?: string }
export function applyUpdate(ledger: Ledger, id: string, patch: UpdatePatch): Task; // 未知 id 抛 Error
```

`clip`：`n<1` 按 1；`s.length > n ? s.slice(0, n-1) + "…" : s`（`…`=U+2026，length 1）。

`formatTaskRow`（仅 `/router status|tasks` 用，与 §2.3 digest 行不同）：
```text
<t.id> [<status>] <key> run:<runId|-> · last: <status> <clip(summary,40)> · next: <clip(next,40)|->
```

`applyOpen` 幂等语义：
- `findOpen(ledger, key)` 命中（key 相同且 isOpen）→ `{ task: 命中, created: false }`，不动 seq。
- 否则 `id = nextId(ledger)`（先取 `seq+1` 并 `seq++`）；`status="queued"`、`reports=[]`、`createdAt=updatedAt=now`；`worktree/model` 缺省 `undefined`。

`applyUpdate` 语义：
- 按 `id` 找任务，未命中 `throw new Error("no task " + id)`。
- `report?` → push `{ at: isoNow, status, summary, question? }` 到 `reports`。
- `status/runId/deliverables/next` 各自非 `undefined` 才写（deliverables 整体替换）。
- 有写操作即置 `updatedAt = isoNow`（空 patch 也置，简单一致）。

### 1.3 `src/prompt.ts`（第三步，依赖 types.ts + store.ts 纯函数）

零宿主依赖。

```ts
import type { Task } from "./types.ts";
import { clip, isOpen, lastReport, countBy } from "./store.ts";

export const ROUTER_RULES: string;   // §3.3，9 条语义逐一保留
export function buildDigest(tasks: Task[]): string;  // §2.3
```

`ROUTER_RULES` 是多行模板字符串；写完用 9 个关键词自检：只拆/派/收/记；一目标一任务一 worker；依赖区分并行/排队；派发说明五要素；派发三步 open→subagent→update(runId+running)；报告三件事；不 sleep/轮询；blocked 才打扰；决策写 memory；交付前 list 确认。

### 1.4 `src/index.ts`（第四步，唯一 import 宿主的文件）

```ts
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadLedger, saveLedger, applyOpen, applyUpdate, appendMemory, readMemory, countBy, isOpen, formatTaskRow, tasksPath, memoryPath, emptyLedger } from "./store.ts";
import { buildDigest, ROUTER_RULES } from "./prompt.ts";
import type { Ledger, Task } from "./types.ts";

export default function piRouter(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return; // 关键守卫，见 §0
  // 1) 5 个 pi.registerTool
  // 2) pi.registerCommand("router", ...)
  // 3) pi.on("before_agent_start", ...)
  // 4) pi.on("session_start", ...)
}
```

`execute` 的 `params` 用显式局部接口（不依赖 TypeBox v1 Static 推断）：

```ts
type OpenParams = { key: string; goal: string; cwd?: string; worktree?: boolean; model?: string };
type UpdateParams = { id: string; status?: Task["status"]; runId?: string;
  report?: { status: Task["reports"][number]["status"]; summary: string; question?: string };
  deliverables?: string[]; next?: string };
type ListParams = { status?: Task["status"] | "open" };
type MemoryAppendParams = { section: string; text: string };
type MemoryReadParams = { query?: string; maxChars?: number };
```

工具 schema / execute 流程见 §3。

### 1.5 `test/store.test.ts`（第五步，node:test）

只 import：`node:test`、`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`，以及 `../src/store.ts`、`../src/prompt.ts`。用 `mkdtemp(join(tmpdir(), "pi-router-"))` 建临时 cwd，每个 test 后清理。用例见 §4。

### 1.6 `agents/router-worker.md`（第六步）

见 §3.4。注意加 `extensions: []`（§0 第 1 条）。

### 1.7 `README.md`（第七步）

覆盖 §5 验收 8 全部条目：`pi -e ./src/index.ts`、`.pi/extensions/`、安装 pi-subagents、worker 放 `.pi/agents/`、账本位置 `.pi/router/`、设计边界。

### 1.8 `package.json` + `tsconfig.json`（最后，实施时可创建）

```jsonc
// package.json
{
  "name": "pi-router",
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit", "test": "node --test test/store.test.ts" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*", "typebox": "*" },
  "devDependencies": { "typescript": "^5.5.0", "@types/node": "^24.0.0" },
  "pi": { "extensions": ["./src/index.ts"] }
}
// 无 dependencies；host 包绝不能放 dependencies
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
    "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src", "test"]
}
```

最后按 §5 顺序 `npm install` → `npx tsc --noEmit` → `npm test`。

---

## 2. store.ts 关键算法（伪代码可直接转 TS）

### 2.1 原子写（temp + rename）

```ts
async function saveLedger(cwd: string, ledger: Ledger): Promise<void> {
  const dir = routerDir(cwd);
  await mkdir(dir, { recursive: true });
  const target = tasksPath(cwd);
  const tmp = join(dir, `.tasks.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true }); // 失败时清理，成功时 rm 对已 rename 的名字是 no-op
  }
}
```

要点：
- tmp 与 target **同一目录**，`rename` 同盘原子替换；Windows 上 Node 用 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 可覆盖已有文件。
- 不复用固定 temp 名，避免并发进程互相覆盖；随机后缀保证唯一。
- 成功后目录里只有 `tasks.json`（可能还有 `memory.md`、`*.bak-*`），**无 `*.tmp` 残留**（测试断言点）。

### 2.2 幂等 open + 未知 id 报错

```ts
// 幂等：open 状态下同 key 复用
function findOpen(ledger, key) {
  return ledger.tasks.find((t) => t.key === key && isOpen(t));
}

function applyOpen(ledger, input) {
  const existing = findOpen(ledger, input.key);
  if (existing) return { task: existing, created: false };
  const id = nextId(ledger);        // "t" + (ledger.seq + 1)
  ledger.seq += 1;                  // 与 id 同步递增
  const now = new Date().toISOString();
  const task = {
    id, key: input.key, goal: input.goal, cwd: input.cwd,
    status: "queued",
    ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    reports: [], createdAt: now, updatedAt: now,
  };
  ledger.tasks.push(task);
  return { task, created: true };
}

function applyUpdate(ledger, id, patch) {
  const task = ledger.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  if (patch.report) {
    task.reports.push({ at: new Date().toISOString(),
      status: patch.report.status, summary: patch.report.summary,
      ...(patch.report.question !== undefined ? { question: patch.report.question } : {}) });
  }
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.runId !== undefined) task.runId = patch.runId;
  if (patch.deliverables !== undefined) task.deliverables = patch.deliverables;
  if (patch.next !== undefined) task.next = patch.next;
  task.updatedAt = new Date().toISOString();
  return task;
}
```

### 2.3 digest 生成与硬上限

```ts
const MAX_TASKS = 20, MAX_LINES = 40, MAX_CHARS = 4096;
const MARKER = "…(truncated)";

function buildDigest(tasks) {
  const open = tasks.filter(isOpen);
  if (open.length === 0) return "open tasks: none";

  const lines = [
    `open: ${open.length} · running: ${countBy(open, "running")} · needs-human: ${countBy(open, "needs-human")}`
  ];
  for (const t of open.slice(0, MAX_TASKS)) {
    const last = lastReport(t);
    const lastS = last ? `${last.status} ${clip(last.summary, 60)}` : "-";
    const nextS = t.next && t.next.length ? clip(t.next, 60) : "-";
    lines.push(`${t.id} [${t.status}] ${clip(t.key, 40)} — ${clip(t.goal, 80)} · last: ${lastS} · next: ${nextS}`);
  }

  // 先按预算堆积干净的行，再决定是否补 marker
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= MAX_LINES) break;
    const needed = line.length + (out.length ? 1 : 0);
    if (chars + needed > MAX_CHARS) break;
    out.push(line);
    chars += needed;
  }
  const truncated = out.length < lines.length;
  let text = out.join("\n");
  if (truncated) {
    const suffix = "\n" + MARKER;
    const maxBodyChars = MAX_CHARS - suffix.length;
    const maxBodyLines = MAX_LINES - 1;
    if (out.length > maxBodyLines) { out.length = maxBodyLines; text = out.join("\n"); }
    if (text.length > maxBodyChars) text = text.slice(0, maxBodyChars);
    return text + suffix;
  }
  return text;
}
```

不变量（reviewer 可核对）：
- 正常最多 1 行统计 + 20 行任务 = 21 行，40 行上限是安全网。
- marker 后总行数 ≤ 40、总字符 ≤ 4096；只有确实丢行时才输出 `…(truncated)`。
- 无 open 任务时返回固定字符串 `open tasks: none`。
- `clip` 中省略号本身计入 `n`，所以 goal/summary/next 各字段严格 ≤ 80/60/60。

### 2.4 账损坏恢复 + memory

```ts
async function loadLedger(cwd) {
  const dir = routerDir(cwd);
  let text: string;
  try {
    text = await readFile(tasksPath(cwd), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ledger: emptyLedger() };
    throw e;
  }
  try {
    return { ledger: parseLedger(JSON.parse(text)) };
  } catch {
    const bak = join(dir, `tasks.json.bak-${Date.now()}`);
    try { await mkdir(dir, { recursive: true }); await rename(tasksPath(cwd), bak); } catch { /* 备份失败不阻断 */ }
    return { ledger: emptyLedger(), warning: `ledger 损坏，已备份到 ${bak}，以空账本继续` };
  }
}

async function appendMemory(cwd, section, text) {
  const dir = routerDir(cwd);
  await mkdir(dir, { recursive: true });
  const block = `\n## ${new Date().toISOString()} ${section}\n${text}\n`;
  await appendFile(memoryPath(cwd), block, "utf8");   // appendFile = 追加，不重写
}

async function readMemory(cwd) {
  try { return await readFile(memoryPath(cwd), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw e; }
}
```

`parseLedger(raw: unknown)`（无 `any`，逐字段收窄）：
- `raw` 非 object → throw；`version !== 1` → throw；`seq` 非 `number` 或 `<0` → throw；`tasks` 非 `Array` → throw。
- 每个 task：`id/key/goal/cwd/status/createdAt/updatedAt` 必须 `string`，`status` 必须在 TaskStatus 枚举内，`reports` 必须是数组（否则 throw）。可选字段不做强校验，缺失按 `undefined`。
- 任何失败都 throw，由 `loadLedger` 捕获走「备份 + 空账本」分支。

---

## 3. index.ts：5 个工具 schema / execute 流程，事件与命令

### 3.1 typebox schema 草案（5 个，工具名与参数名固定）

工具返回值统一：`{ content: [{ type: "text", text }], details: {...} }`。工具描述写成给模型看的操作指引（何时用、下一步做什么）。

```ts
const ENUM_STATUS = ["queued","running","needs-human","done","failed","stopped"] as const;
const ENUM_REPORT = ["progress","blocked","ready","failed","dropped"] as const;
const StatusEnum = Type.Union(ENUM_STATUS.map((s) => Type.Literal(s)));
const ReportEnum = Type.Union(ENUM_REPORT.map((s) => Type.Literal(s)));

// 1. router_task_open
parameters: Type.Object({
  key: Type.String({ minLength: 1 }),
  goal: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  worktree: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
})

// 2. router_task_update
parameters: Type.Object({
  id: Type.String({ minLength: 1 }),
  status: Type.Optional(StatusEnum),
  runId: Type.Optional(Type.String()),
  report: Type.Optional(Type.Object({
    status: ReportEnum,
    summary: Type.String(),
    question: Type.Optional(Type.String()),
  })),
  deliverables: Type.Optional(Type.Array(Type.String())),
  next: Type.Optional(Type.String()),
})

// 3. router_task_list
parameters: Type.Object({
  status: Type.Optional(Type.Union([...ENUM_STATUS.map(Type.Literal), Type.Literal("open")])),
})

// 4. router_memory_append
parameters: Type.Object({
  section: Type.String(),
  text: Type.String(),
})

// 5. router_memory_read
parameters: Type.Object({
  query: Type.Optional(Type.String()),
  maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
})
```

注意：TypeBox v1（`typebox` 包，Sinclair 新 API）支持 `Type.Object/String/Optional/Union/Literal/Integer/Array/Boolean`；`minLength`/`minimum` 是标准 JSON Schema 关键字。不要用 `@sinclair/typebox` 旧包名、不要用 `Type.Refine`（Pi 校验不执行 refine，见 extensions.md）。

### 3.2 execute 流程（每个工具）

每个 mutate 工具成功后调一次 `refreshStatus(pi, ctx, ledger)`（见 §3.5）更新底部状态。加载账本产生的 `warning` 一律拼进返回 text（如 `⚠ 账本已重置：…`），工具照常工作、不崩溃。

**router_task_open**
1. `const { ledger, warning } = await loadLedger(ctx.cwd)`。
2. `const { task, created } = applyOpen(ledger, { key, goal, cwd: params.cwd ?? ctx.cwd, worktree, model })`。
3. `await saveLedger(ctx.cwd, ledger)`（即使 idempotent 命中也要落盘，保证在建目录首次 open 时 materialize 账本）。
4. text：`created` 时提示「已开任务 <id>「<goal 截断>」queued；下一步：调用 subagent({ agent: "router-worker", task, cwd, worktree }) 后用 router_task_update 记 runId 与 running」；命中时提示「幂等命中既有任务 <id> <status>」。
5. details：`{ id, key, status, created, ledgerPath: tasksPath(ctx.cwd) }`。

**router_task_update**
1. load。2. `const task = applyUpdate(ledger, params.id, { status, runId, report, deliverables, next })`（未知 id 在此 throw，被 pi 包装为工具错误）。3. save。
4. text：回显 `task.id [status]`，若 append 了 report 提示「报告已追加，共 <n> 条」。
5. details：`{ id, status, reports: task.reports.length, updatedAt, ledgerPath }`。

**router_task_list**
1. load。2. `const pred = params.status === "open" ? isOpen : (t) => t.status === params.status`；无 `status` 列全部。
3. text：`open: N · running: M · needs-human: K` 一行统计 + 每条 `formatTaskRow`（或「无匹配任务」）。
4. details：`{ tasks: <过滤后 Task[]>, open, running, needsHuman }`。

**router_memory_append**
1. 无 ledger。2. `await appendMemory(ctx.cwd, params.section, params.text)`。
3. text：`已追加到 <memoryPath>`。details：`{ path, section }`。

**router_memory_read**
1. `const text = await readMemory(ctx.cwd)`。2. `maxChars = params.maxChars ?? 8000`。
3. 无 query：`text.slice(0, maxChars)`（注意字符预算）；有 query：大小写不敏感行过滤，输出 `行号: 行内容`，同样受 maxChars 截断。
4. 空文件/不存在：text 为「memory 为空」。details：`{ path, matchedLines?, truncated: boolean }`。

### 3.3 `ROUTER_RULES` 内容（语义逐条保留的模板）

````text
你是 Router：只把目标变成任务、派给 worker、汇总结果。不读业务代码、不做实现、不给实现方案；任务内部拆解属于 worker。
一个独立目标 = 一个任务 = 一个 worker。只有互相独立才并行，有依赖就排队。
派发前任务说明必须写全：目标、范围/边界、验收标准、交付物、失败时怎么办。
派发方式：先 router_task_open 拿 id，再 subagent({ agent: "router-worker", task, cwd, worktree })，然后用 router_task_update 写入 runId 与 running。
报告到达后只做三件事：router_task_update 记账 → 决定下一步 → 必要时向人汇报。
不 sleep、不轮询、不反复查 status；子代理完成会自动唤醒会话。
只有 blocked / 需要人决策时才打扰用户；progress 不转述。
每个重要决定写一行理由到 memory.md（为什么这样拆、为什么换方案）。
交付前先 router_task_list 确认没有遗漏的 open 任务。
````

### 3.4 `agents/router-worker.md`

```markdown
---
name: router-worker
description: Router task worker — implement/decompose one assigned task; may open nested subagents.
tools: read, write, edit, bash, grep, find, ls, subagent
extensions: []
---
（正文：你是 router worker，执行 Router 下发的单个任务；可自行拆解并派嵌套 subagent；不重写 Router 账本/记忆。
最终报告必须包含：
1) Deliverables: 改动/产出文件路径；
2) Verification: 运行过的命令及结果；
3) 若 blocked 或需人决策：恰一行 `BLOCKED: <一句话问题>`。）
```

frontmatter 必须逐字满足 BRIEF 的 `tools` 列表（subagent 在末尾）；`extensions: []` 是防 worker 加载 router 扩展的双保险（§0）。

### 3.5 事件与命令

```ts
// 底部状态统一封装（ctx 分别来自事件/命令 handler）
function render(ctx: ExtensionContext, ledger: Ledger) {
  const open = ledger.tasks.filter(isOpen).length;
  const running = countBy(ledger.tasks, "running");
  ctx.ui.setStatus(
    "router",
    ledger.tasks.length === 0 ? undefined : `router ● ${open} open · ${running} running`,
  );
}

pi.on("before_agent_start", async (event, ctx) => {
  const { ledger, warning } = await loadLedger(ctx.cwd);
  const digest = buildDigest(ledger.tasks);
  const warn = warning ? `\n\n[router 账本警告] ${warning}` : "";
  return { systemPrompt: event.systemPrompt + "\n\n" + ROUTER_RULES + "\n\n" + digest + warn };
});

pi.on("session_start", async (_event, ctx) => {
  const { ledger } = await loadLedger(ctx.cwd);
  render(ctx, ledger);
});

pi.registerCommand("router", {
  description: "router: status | tasks | task <id> | memory [query] | digest",
  handler: async (args, ctx) => {
    const { ledger, warning } = await loadLedger(ctx.cwd);
    const a = (args ?? "").trim();
    if (!a || a === "status" || a === "tasks") {
      ctx.ui.setWidget("router", statusLines(ledger));     // 统计 + open 行
    } else if (a.startsWith("task ")) {
      const id = a.slice(5).trim();
      const t = ledger.tasks.find((x) => x.id === id);
      if (!t) { ctx.ui.notify(`router: 无任务 ${id}`, "error"); return; }
      ctx.ui.setWidget("router", taskReportLines(t));       // 标题 + 全部报告
    } else if (a === "digest") {
      ctx.ui.setWidget("router", [buildDigest(ledger.tasks)]);
    } else if (a === "memory" || a.startsWith("memory ")) {
      const q = a === "memory" ? undefined : a.slice(7).trim();
      ctx.ui.setWidget("router", memoryLines(await readMemory(ctx.cwd), q)); // 未封装则内联过滤
    } else {
      ctx.ui.notify("router: 未知子命令，支持 status|tasks|task|memory|digest", "error");
    }
    render(ctx, ledger);
    if (warning) ctx.ui.notify(`router: ${warning}`, "warning");
  },
});
```

`statusLines(ledger)`：首行 `router — open: N · running: M · needs-human: K`，随后对 `tasks.filter(isOpen)` 逐条 `formatTaskRow`（可选 `.slice(-15).reverse()`，参考骨架 behavior）。`taskReportLines(t)`：`t.id [t.status] key — goal` + 每条 `reports: [at] status summary (question?)`。`memoryLines`：无 query 全量、有 query 行过滤（大小写不敏感，`行号: 内容`），截断 8000。

---

## 4. 测试用例清单（`test/store.test.ts`，node:test）

统一 helper：`newCwd()` 用 `mkdtemp`；每个用例独用 cwd，`afterEach`/`try-finally` 里 `rm(dir, { recursive: true, force: true })`。

1. **幂等 open（BRIEF 验收 2 要求之一）**
   - 同 key 连续两次 `applyOpen`+`saveLedger`：第二次 `created=false`、id 相同、`seq` 不变、tasks 长度 1。
   - 把该任务 `applyUpdate` 为 `done` 后，再同 key `applyOpen`：得到新 id、`created=true`。

2. **报告追加 + 时间戳**
   - open → 两次 `applyUpdate`（各带一个 report）→ `reports.length===2`；`at` 均为 ISO 字符串且非递减；`updatedAt` 被更新；question 可选字段正确透传/缺省。

3. **digest 行数/长度硬上限（BRIEF 验收 6）**
   - 造 30 个 open 任务：`buildDigest` 返回的任务行 ≤ 20，总行数 ≤ 40，总 `length ≤ 4096`，且含 `…(truncated)`。
   - 造长 goal/summary/next（各 >80/60/60）的少数任务，校验每字段被截到 ≤80/60/60（省略号计入预算）；长内容触发字符截断时仍 ≤4096 且含 `…(truncated)`。
   - 空账本：`buildDigest([])` === `"open tasks: none"`。
   - 全部 done 的账本同样返回 `"open tasks: none"`。

4. **原子写无残留 tmp（BRIEF 验收 2 要求之一）**
   - `applyOpen` + 多次 `saveLedger` 后 `readdir(routerDir(cwd))`，断言不存在任何以 `.tmp` 结尾的文件；`tasks.json` 存在且可再次 `loadLedger` 还原数据。

5. **账本损坏恢复（安全网）**
   - 直接往 `tasks.json` 写非法 JSON，`loadLedger` 返回 `warning!==undefined`、`ledger.tasks.length===0`，且目录出现 `tasks.json.bak-*`；再次 `saveLedger` 正常。

6. **未知 id 报错 / memory append+read**
   - `applyUpdate(ledger, "t999", {})` 抛 `Error`。
   - `appendMemory` 两次后 `readMemory` 含两段 `## <ISO> <section>`；memory 不存在时 `readMemory` 返回 `""`。

（补充纯函数单测：`clip` 边界、`formatTaskRow`、`countBy`、`findOpen`、`nextId` 递增。）

---

## 5. 风险点与规避

- **R1 Windows 路径/换行**：一律 `node:path` `join`，不用手拼 `/` 或 `\\`；文件读写 UTF-8；`rename` 用同目录替换（§2.1）。测试用 `os.tmpdir()`+`mkdtemp`，不依赖当前盘符。
- **R2 rename 语义与残留 tmp**：tmp 名带 `process.pid + randomUUID`，`finally { rm(tmp, { force: true }) }`；测试断言 `.tmp` 残留为 0。
- **R3 tsconfig/NodeNext 选项**：`module/moduleResolution=NodeNext` + `allowImportingTsExtensions`（必须配合 `noEmit`）+ `type:module`；相对 import 必须写 `.ts` 后缀。缺任一条会 typecheck/运行时失败。`types:["node"]` 防止 `NodeJS.ErrnoException` 缺类型。
- **R4 peerDependencies**：host 包与 typebox 只放 `peerDependencies` `"*"`，`dependencies` 为空；`npm install` 会 auto-install peers 供 typecheck/test。绝不能把 host 包塞进 `dependencies`（验收 7）。
- **R5 宿主品牌化目录名 vs `.pi`**：按 BRIEF 用 `.pi` 字面量；若将来要兼容 `CONFIG_DIR_NAME`，只改 store.ts 的 `ROUTER_DIR` 一处为 `join(CONFIG_DIR_NAME, "router")`（会引入宿主 import，需相应把 test 也补宿主包）。本计划默认不动。
- **R6 worker 误加载 router 扩展**：双保险——index 工厂顶部 `if (process.env.PI_SUBAGENT_CHILD === "1") return;` + worker frontmatter `extensions: []`。否则 worker 会看到 ROUTER_RULES/工具，环回成「子 Router」。
- **R7 拒绝模式**：不 import `child_process`、不写 `spawn(`/`exec(`、不出现 `--mode rpc`/`-ne` 字符串、不自建队列/进程管理（验收 4 会 grep）。派发只能靠模型调用 pi-subagents 原生 `subagent`。
- **R8 无 any / 无 @ts-ignore**：JSON 解析用 `unknown` + 逐字段收窄（`parseLedger`）；typebox params 用显式局部接口或 `Static<typeof schema>`；错误统一 `throw new Error(...)`。
- **R9 测试不依赖宿主包**：store/prompt 零宿主 import，`node --test` 直接可跑；typebox 只出现在 index.ts，测试文件不碰。
- **R10 长行/digest 预算**：`clip` 把省略号计入字段预算；digest 用「先堆积 + 补 marker」算法保证 ≤40 行且 ≤4096 字符（§2.3）。

---

## 验收自检（实施后按 BRIEF §验收 1–10 逐条对照）

`npm install` → `npx tsc --noEmit`（零错误）→ `npm test`（≥4 用例）→ grep 检查 R7 禁词 → 核对 5 工具名/参数、`/router`、原子写、append、digest 上限、peerDeps、README、worker frontmatter、无 any/@ts-ignore。