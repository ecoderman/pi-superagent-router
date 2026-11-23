# pi-router v2 实施计划（可执行）

本文件只做实现规划，不写 `src/` 代码。目标读者：一个不了解上下文的工程师，拿到本文件即可按顺序落地 v2。

- 权威需求：`docs/BRIEF-v2.md`（取代 `docs/BRIEF.md`）。凡本文件与 BRIEF-v2 冲突，BRIEF-v2 胜。
- 已交付基线：`docs/BRIEF.md` + `docs/PLAN.md` + `docs/FIXES-1.md`（v0.1.0；`src/{index,prompt,store,types}.ts`，8 个测试全绿）。
- API 速查：`docs/API-NOTES.md`；需要时查 `@earendil-works/pi-coding-agent/docs/extensions.md`、`pi-subagents/docs/{observability,extension-api}.md`（只读）。
- 硬规则：只改 `pi-router/` 内文件；**禁止** `git commit/tag/push/reset`；不新增运行时依赖（host 包留在 `peerDependencies`）；`../repo` 只读。

开工前基线确认（应当通过）：

```bash
cd pi-router && npx tsc --noEmit && npm test     # 8 tests pass
```

---

## 1. 规格冲突的裁决（先读，落地按此执行）

BRIEF-v2 有 7 处需要裁决的地方；下表是**本计划的裁决**，实现与审查都按此执行，每处在代码里用一行注释说明理由。

| # | 冲突 | 裁决 |
|---|---|---|
| C1 | ⑤ 要 digest 首行全局统计，② 要「无任务时 `open tasks: none`」，v1 测试断言 `buildDigest([]) === "open tasks: none"` | 空账本的精确输出改为两行：`global: 0 open · 0 running · 0 needs-human` + `open tasks: none`。该行仍出现，只是不再唯一。v1 测试改断言新常量。 |
| C2 | ③ 层 C 示例 reason 是 `Router 只读：请派 worker` / `Router 不用 bash：请用 router_inspect`，验收 5 要求 reason 以 `Router 只读` 开头 | 两条语义都保留，但**都**以 `Router 只读` 开头：shell 类 → `Router 只读：Router 不用 bash，请用 router_inspect 查状态`；写类 → `Router 只读：Router 不能改文件，请派 worker（subagent）`。 |
| C3 | ① 说 `loadLedger` 负责迁移（写盘），② 说读路径不取锁 → 读路径不能写盘 | 拆两层：`loadLedger(home, { legacy })` **只读不取锁**，对旧账本做**内存导入**（digest/list 立刻看到旧任务）；**持久迁移**（落盘 + 改名）只在 `withLedger()` 锁内发生，旧文件因此只被改名一次。 |
| C4 | ① 「v1 任务其余字段原样保留」 vs 全局账本 id 必须唯一（v1 的 `t1` 会撞全局已有 `t1`） | `importLegacyTasks` 无冲突时**逐字保留原 id**；仅目标已有同 id 时从目标 `seq` 重新分配，并把映射写进返回的 `idMap`。`seq` 取两者最大值。 |
| C5 | ② 「所有写路径在锁内」包含 append，但 v1 `appendMemory` 是裸 `appendFile` | 对外用 `appendMemoryLocked()`（取锁 → `appendFile` → 释放）；保留 `appendMemoryUnlocked()` 给测试/内部。 |
| C6 | ④ `router_workers` 默认 `active`，但账本里可能全是没 `runId` 的 `queued`，运行目录也可能不存在 | 候选行 = 有 `runId` 的任务 ∪ `isOpen()` 的任务；`active/done` 优先用 `status.json` 的 `state`，取不到回退账本 `status`（`isOpen` → active）。运行目录不存在 → 全部回退账本 + 一行提示，不抛错。 |
| C7 | BRIEF-v2 清单只有 `src/{types,config,store,inspect,prompt,index}.ts` + 3 个测试；但验收 11 要 runId 提取「通过**导出的纯函数**单测」，而 `src/index.ts` 有 `typebox` 运行时 import，测试不该 import 它 | 新增两个 host-free 小模块：`src/guard.ts`（③ 层 A/C 纯函数，BRIEF-v2 自己已命名 `test/guard.test.ts`）与 `src/workers.ts`（④ 纯函数），测试对应 `test/guard.test.ts`、`test/workers.test.ts`。理由：纯函数必须能被 `node --test` 在无宿主包环境下导入（延续 v1 `PLAN.md` §0 第 3 条）。 |

其它已定事项（无冲突，只需记住）：

- `scope: "project"` 时 `home = <cwd>/.pi/router`，此时 `home` 与「v1 旧账本目录」是同一目录 → **整体跳过迁移**（否则自己改名自己）。
- `router.json` 的 `progressThrottleMs` 只解析、不实现行为（BRIEF-v2 只把它列进配置）。README 说明「预留」。
- `/router` 保持 v1 五个子命令，**不新增** `workers`（BRIEF-v2 未要求，避免扩范围）。

---

## 2. 文件级实施顺序与改动点

| 步骤 | 文件 | 动作 | 依赖 |
|---|---|---|---|
| 1 | `src/types.ts` | 改 | — |
| 2 | `src/config.ts` | 新增 | types |
| 3 | `src/guard.ts` | 新增 | — |
| 4 | `src/inspect.ts` | 新增 | — |
| 5 | `src/workers.ts` | 新增 | types, store（纯函数） |
| 6 | `src/store.ts` | 重写 | types |
| 7 | `src/prompt.ts` | 改 | types, store |
| 8 | `src/index.ts` | 改 | 全部 |
| 9 | `test/store.test.ts` | 扩展 | store, prompt |
| 10 | `test/config.test.ts` | 新增 | config |
| 11 | `test/guard.test.ts` | 新增 | guard, inspect |
| 12 | `test/workers.test.ts` | 新增 | workers, store |
| 13 | `package.json` | 改 | — |
| 14 | `README.md` | 改 | — |

执行顺序建议：1 → 2/3/4/5（互不依赖，可先写）→ 6 → 7 → 8 → `npx tsc --noEmit`（此前的 index.ts 编译错误窗口在 8 之前属正常）→ 9/10/11/12（先各跑 `node --test test/xxx.test.ts`）→ 13 → 14 → 全量 `npx tsc --noEmit && npm test` → grep 禁词 → `git status --porcelain`（只应有工作区改动）。

### 2.1 `src/types.ts`（改）

```ts
export type TaskStatus = "queued" | "running" | "needs-human" | "done" | "failed" | "stopped";   // 不变
export type ReportStatus = "progress" | "blocked" | "ready" | "failed" | "dropped";             // 不变
export interface Report { at: string; status: ReportStatus; summary: string; question?: string } // 不变

export interface Task {
  id: string; key: string; goal: string;
  project: string;       // 新：basename(realpath(cwd))，取不到用 cwd 原值
  cwd: string;
  ownerSession: string;  // 新：ctx.sessionManager.getSessionId() ?? "unknown"；迁移任务为 "migrated"
  status: TaskStatus;
  runId?: string; model?: string; worktree?: boolean;
  reports: Report[]; deliverables?: string[]; next?: string;
  createdAt: string; updatedAt: string;
}

export interface Ledger { version: 2; seq: number; tasks: Task[] }   // version 1 → 2

export interface RouterConfig {          // 新
  scope: "global" | "project";
  home: string;                          // 绝对路径；"~" 已在 config.ts 展开
  routerReadOnly: boolean;
  workerModel: string | null;
  maxOpenShown: number;
  progressThrottleMs: number;
}
```

纯类型改动，无运行时逻辑。

### 2.2 `src/config.ts`（新增；零宿主依赖）

```ts
// 唯一实现放在这里，别的模块不要重复拼这段路径：defaultConfig() 直接调 store.ts 的 defaultHome()
// （config.ts → store.ts 单向依赖，store.ts 不 import config.ts，无循环、都是 host-free）
export interface ConfigReadResult { config: RouterConfig; warning?: string }
export interface LoadConfigOptions { env?: NodeJS.ProcessEnv; homedir?: string }

export function defaultConfig(homeDir?: string): RouterConfig;
// { scope:"global", home: defaultHome(homeDir),     // = join(homeDir ?? os.homedir(), ".pi", "agent", "router")
//   routerReadOnly:true, workerModel:null, maxOpenShown:20, progressThrottleMs:60000 }

export function configFilePath(homeDir?: string): string;   // join(homeDir ?? os.homedir(), ".pi", "agent", "router.json")
export function expandHome(value: string, homeDir?: string): string;
// 先 trim："" → ""；"~" → homeDir；"~/" 或 "~\\" 开头 → join(homeDir, rest)；其它原样返回

export function parseConfig(raw: unknown, homeDir?: string): ConfigReadResult;   // 纯函数
// raw 非 object → { config: defaultConfig(homeDir), warning: "router.json 不是对象，已回退默认" }
// 逐字段校验：scope ∈ {"global","project"}；home 非空 string（过 expandHome）；routerReadOnly boolean；
// workerModel string|null；maxOpenShown / progressThrottleMs 正整数。
// 单字段非法 → 该字段回退默认，并把 "字段名: 期望类型" 收进 warning（多字段用 "；" 连接）。

export async function loadConfig(options?: LoadConfigOptions): Promise<ConfigReadResult>;
// readFile(configFilePath(homeDir))：ENOENT → 默认且无 warning；
// JSON.parse 失败 → 默认 + warning "router.json 解析失败（<message>），已回退默认"；
// 其它 IO 错误（EACCES 等）→ 默认 + warning。永不抛。

export function resolveHome(cwd: string, config: RouterConfig, env?: NodeJS.ProcessEnv): string;
// 优先级：1) env.PI_ROUTER_HOME（trim 非空）→ resolve(expandHome(...))
//         2) config.scope === "project" → join(cwd, ".pi", "router")
//         3) resolve(expandHome(config.home))
```

要点：返回值一律过 `resolve()`（全绝对路径，日志可读）；`expandHome` 只认 `~` 三种形态，不碰 shell；类型错只回退该字段。

### 2.3 `src/guard.ts`（新增；零依赖）

```ts
export const KEEP_TOOLS: readonly string[];
// ["read","grep","find","ls","subagent",
//  "router_task_open","router_task_update","router_task_list",
//  "router_memory_append","router_memory_read","router_workers","router_inspect"]
// 顺序取 BRIEF-v2 ③ 的顺序，作为稳定常量数组（验收 4 比对集合，不看顺序）

export const BLOCKED_TOOL_NAMES: readonly string[];      // ["bash","powershell","cp","mv","rm"]
export const BLOCKED_TOOL_PREFIXES: readonly string[];   // ["write","edit","apply"]

export function shouldBlockTool(toolName: string): boolean;
// 小写后：等值命中 BLOCKED_TOOL_NAMES → true；命中任一前缀 startsWith → true；否则 false。
// 等值集合里放 cp/mv/rm 是 BRIEF-v2 ③「覆盖 cp/mv/rm 等工具名（若宿主提供）」的落地方式：
// 宿主没有这些工具时该条永不触发，无副作用。

export function blockReason(toolName: string): string;
// shell 类（bash/powershell）→ `Router 只读：Router 不用 ${toolName}，请用 router_inspect 查状态`
// 其它（写类）           → `Router 只读：Router 不能改文件，请派 worker（subagent）`
// 两者都以 "Router 只读" 开头（见 C2）

export function isChildSession(env?: NodeJS.ProcessEnv): boolean;   // (env ?? process.env).PI_SUBAGENT_CHILD === "1"
```

### 2.4 `src/inspect.ts`（新增；零宿主依赖；③ 层 B）

```ts
export type InspectCmd = "git-status" | "git-log" | "git-diff" | "tree";
export const INSPECT_COMMANDS: readonly InspectCmd[];   // 上面四个，顺序固定

export function clampLimit(value: number | undefined, fallback: number): number;
// 非有限数（undefined/NaN/Infinity）→ fallback；否则 min(500, max(1, trunc(value)))

export interface InspectInvocation { command: string; args: string[] }
export function inspectArgv(cmd: string, limit?: number): InspectInvocation | undefined;
// "git-status" → { command: "git", args: ["status","--porcelain=v1","--branch"] }        // 忽略 limit
// "git-log"    → { command: "git", args: ["log","--oneline","-n", String(clampLimit(limit, 20))] }
// "git-diff"   → { command: "git", args: ["diff","--stat"] }                             // 忽略 limit
// "tree"       → undefined   // 由 treeEntries 实现
// 其它字符串    → undefined   // 白名单拒绝（测试点）

export interface TreeEntry { path: string; kind: "file" | "dir" }
export function treeEntries(root: string, limit: number, maxDepth?: number): Promise<TreeEntry[]>;
// 深度上限 maxDepth ?? 2（root 直接子项 = depth 1）；条目上限 clampLimit(limit, 200)；
// 目录 path 末尾追加 "/"；跳过 SKIP_DIRS = new Set(["node_modules", ".git", ".pi"])；
// readdir({ withFileTypes: true }) 递归；单个目录读取失败（EACCES/ENOENT）静默跳过。

export function formatTree(entries: TreeEntry[]): string;   // 每行一条 path；空数组 → "(空目录)"
```

`pi.exec` 的调用留在 `src/index.ts`（本模块保持零宿主依赖）。

### 2.5 `src/workers.ts`（新增；④ 的纯函数；只 import types + store 纯函数）

```ts
import type { Task } from "./types.ts";
import { clip, isOpen, lastReport } from "./store.ts";   // 只用纯函数，模块顶层无 IO

export interface RunStatusInfo { state?: string; sessionPath?: string; cwd?: string }

export function runDirCandidates(env: NodeJS.ProcessEnv, tmpDir: string, username: () => string | undefined): string[];
// env.PI_SUBAGENTS_RUN_DIR trim 非空 → [that]
// 否则：const user = username(); user ? [join(tmpDir, `pi-subagents-user-${user}`, "async-subagent-runs")] : []
// 返回 [] → 调用方按「运行目录未找到」降级

export function findExistingDir(candidates: string[]): Promise<string | undefined>;   // 逐个 stat，isDirectory 命中即返回

export function parseRunStatus(raw: unknown): RunStatusInfo | undefined;
// 非 object → undefined；state / cwd 取可选 string；sessionPath = sessionFile ?? steps[0].sessionFile
// （运行中的 async run 只在 steps[0] 里有 session 路径，见 pi-subagents/docs/observability.md）；结构不符 → undefined，不抛

export function readRunStatus(runDir: string, runId: string): Promise<RunStatusInfo | undefined>;
// readFile(join(runDir, runId, "status.json")) → JSON.parse → parseRunStatus；任何异常 → undefined

export function extractRunId(details: unknown): string | undefined;
// 收集三个形状里的 string runId：details.runId / details.childRunId / details.runs[*].runId
// Set 去重后 size === 1 → 返回；size === 0 或 > 1 → undefined（歧义不猜）

export type WorkerBucket = "active" | "done";
export function runBucket(info: RunStatusInfo | undefined, task: Task): WorkerBucket;
// state ∈ {"queued","running"} → "active"；∈ {"completed","failed","stopped","blocked","paused"} → "done"；
// 其它/缺失 → 账本回退：isOpen(task) ? "active" : "done"

export function formatWorkerLine(task: Task, info: RunStatusInfo | undefined): string;
// `<id> [<status>] <project> · run <runId ?? "-"> · <state ?? "-"> · session <sessionPath ?? "?"> · last: <reportStatus> <clip(summary,60)>`
// last 缺失 → "last: -"（clip/lastReport 来自 store.ts，都是纯函数）

export function countBuckets(rows: readonly { bucket: WorkerBucket }[]): { active: number; done: number };
```

### 2.6 `src/store.ts`（重写；零宿主依赖）

**路径（改成 home 视角）**

```ts
export function tasksPath(home: string): string;        // join(home, "tasks.json")
export function memoryPath(home: string): string;       // join(home, "memory.md")
export function lockPath(home: string): string;         // join(home, "tasks.lock")
export function projectRouterDir(cwd: string): string;  // join(cwd, ".pi", "router")  ← scope=project 的 home & v1 旧账本目录
export function defaultHome(homeDir?: string): string;  // join(homeDir ?? os.homedir(), ".pi", "agent", "router")
```

删除 v1 的 `routerDir(cwd)` 与 `ROUTER_DIR` 常量（语义已分裂为 `projectRouterDir` 与 `home`）；`test/store.test.ts` 里所有 `routerDir(cwd)` 调用改为直接用 `home`。

**项目名**

```ts
export function basenameOf(p: string): string;                 // 去掉尾部 / 与 \ 后 basename；结果空 → 返回原值
export async function projectName(cwd: string): Promise<string>;
// try { return basenameOf(await realpath(cwd)); } catch { return basenameOf(cwd) || cwd; }
export function sameProject(a: string, b: string): boolean;     // a.toLowerCase() === b.toLowerCase()
```

**账本读写**

```ts
export function emptyLedger(): Ledger;                        // { version: 2, seq: 0, tasks: [] }
export function parseLedger(raw: unknown): Ledger;
// 只接受 version === 2；沿用 v1 parseTask 的逐字段收窄，新增 project / ownerSession 必填 string；任一非法 throw TypeError

export function parseLegacyLedger(raw: unknown): { seq: number; tasks: Task[] } | undefined;
// 接受 version 1（也接受 2）；task 缺 project/ownerSession 由 migrateTaskV1 补齐；任一非法 → undefined（不抛）

export function migrateTaskV1(raw: Task, project: string): Task;
// 浅拷贝：project ??= 参数 project，ownerSession ??= "migrated"，其余字段逐字保留（C4）

export interface ImportResult { ledger: Ledger; imported: number; idMap: Record<string, string> }
export function importLegacyTasks(target: Ledger, legacy: { seq: number; tasks: Task[] }, project: string): ImportResult;
// 1) 去重：target 已有同 (key && createdAt) 的任务 → 跳过（崩溃重试幂等，见 §4）
// 2) id 冲突（target 已有同 id）→ 从 target.seq 递增分配新 id 并记入 idMap
// 3) 无冲突 → 保留原 id
// 4) target.seq = max(target.seq, legacy.seq, 已分配的最大序号)

export interface ReadLedgerOptions { legacy?: { dir: string; project: string } }
export async function loadLedger(home: string, options?: ReadLedgerOptions): Promise<{ ledger: Ledger; warning?: string }>;
// 只读、不取锁。损坏 → 备份 tasks.json.bak-<ts> + 空账本 + warning（沿用 v1）
// options.legacy 且 tasksPath(legacy.dir) !== tasksPath(home) → 内存导入（不落盘、不改名），
//   warning 追加 "旧账本待迁移（首次写操作时完成）"（C3）

export async function saveLedger(home: string, ledger: Ledger): Promise<void>;
// 低层原子写（tmp + rename，沿用 v1 实现）。注释：调用者必须已持锁（测试除外）
```

**锁**

```ts
export interface LockOptions { timeoutMs?: number; staleMs?: number }    // 默认 3000 / 10000
export async function withLock<T>(home: string, fn: () => Promise<T>, options?: LockOptions): Promise<T>;

export interface LedgerOptions extends LockOptions { legacy?: { dir: string; project: string } }
export interface LedgerTxn<T> { ledger: Ledger; result: T; warning?: string }
export async function withLedger<T>(home: string, fn: (ledger: Ledger) => T | Promise<T>, options?: LedgerOptions): Promise<LedgerTxn<T>>;
// withLock(home, async () => { const { ledger, warning } = await migrateLocked(home, options);   // 步骤见 §4.1
//                              const result = await fn(ledger); await saveLedger(home, ledger);
//                              return { ledger, result, warning }; })

async function migrateLocked(home: string, options?: LedgerOptions): Promise<{ ledger: Ledger; warning?: string }>;
// 内部函数（不导出）：锁内读 + 导入 + 落盘 + 改名，顺序严格按 §4.1；无 legacy 时等价于 loadLedger 的读分支
```

**memory（全局单文件）**

```ts
export function formatMemoryBlock(project: string, section: string, text: string, at?: string): string;
// `\n## ${at ?? new Date().toISOString()} [${project}] ${section}\n${text}\n`

export async function appendMemoryLocked(home: string, project: string, section: string, text: string, options?: LockOptions): Promise<void>;
export async function appendMemoryUnlocked(home: string, project: string, section: string, text: string): Promise<void>;
// mkdir(home, { recursive: true }) → appendFile(memoryPath(home), formatMemoryBlock(...), "utf8")

export async function readMemory(home: string): Promise<string>;    // 不存在 → ""
export function filterMemoryByProject(text: string, project: string): string;
// 逐行扫描：`^##\s+\S+\s+\[([^\]]+)\]` 命中且 group1 与 project 大小写不敏感相等 →
// 保留该 header 行与其后正文行，直到下一个以 "## " 开头的行。无 [project] 标记的旧块不匹配。
```

**纯函数（签名不变，语义不变）**：`isOpen`、`lastReport`、`clip`、`formatTaskRow`、`countBy`、`findOpen`、`nextId`、`applyUpdate`。

```ts
export interface OpenInput { key: string; goal: string; project: string; ownerSession: string; cwd: string; worktree?: boolean; model?: string }
export function applyOpen(ledger: Ledger, input: OpenInput): { task: Task; created: boolean };   // v1 语义 + 新建时写 project/ownerSession

export function setRunIdIfUnclaimed(ledger: Ledger, runId: string): Task | undefined;
// 候选 = ledger.tasks.filter(t => t.status === "queued" && t.runId === undefined)
// 恰好 1 个 → 写 runId、status = "running"、updatedAt = now 并返回该 task；0 或 >1 → undefined（不猜）
```

### 2.7 `src/prompt.ts`（改）

```ts
export const ROUTER_RULES: string;            // v1 九条 + 下面三条改写/新增
export const EMPTY_DIGEST_LINE = "open tasks: none";
export interface DigestOptions { project: string; scope: "global" | "project"; maxOpenShown: number }
export function buildDigest(tasks: Task[], options: DigestOptions): string;
```

digest 结构（顺序固定）：

1. 第 1 行：`global: <open> open · <running> running · <needs-human> needs-human`（统计**全部**传入任务，即全局账本）。
2. 第 2 行，仅 `options.scope === "global"`：`project <project>: <该项目 open 数> open`。
3. 明细：`tasks.filter(t => isOpen(t) && sameProject(t.project, options.project))`，按 `createdAt` 升序、同时间按 id 数字升序，取前 `min(maxOpenShown, 20)` 条，行格式沿用 v1。
4. 第 3 步结果为空 → 追加一行 `open tasks: none`（C1）。
5. 仍受 40 行 / 4096 字符上限 + `…(truncated)` 收尾（沿用 v1「先堆积再补 marker」算法，`MAX_LINES`/`MAX_CHARS` 不变）。

`ROUTER_RULES` 增量（语义必须保留，措辞可润色）：

- 改写第 4 条：派发三步 `router_task_open` → `subagent({ agent: "router-worker", task, cwd, worktree })` → `router_task_update` 写 `running`；**`runId` 可省略（扩展会自动记）**，但 `subagent` 调用与 `router_task_open` 的 key 必须对应。
- 新增：你**不能修改文件**（没有 write/edit/bash）；查状态用 `router_inspect`，要改代码就派 worker。
- 新增：用 `router_workers` 看正在跑的 worker 与它们的 session 路径；要看过程用 `subagent({ action: "status", id, options: { view: "transcript" } })`。
- 其余 7 条逐字保留。

### 2.8 `src/index.ts`（改；唯一 import 宿主的文件）

```ts
export default function piRouter(pi: ExtensionAPI): void {
  if (isChildSession()) return;    // 沿用 v1 守卫（架构约束不变）

  interface RouterState { config: RouterConfig; home: string; project: string; legacy: { dir: string; project: string }; warning?: string }
  let state: RouterState | undefined;                       // 惰性缓存，会话内只算一次
  const ensureState = async (ctx: ExtensionContext): Promise<RouterState>;
  // loadConfig() → home = resolveHome(ctx.cwd, config) → project = await projectName(ctx.cwd)
  // → legacy = { dir: projectRouterDir(ctx.cwd), project } → 缓存并返回（配置 warning 一起存）

  const readOnly = (): boolean => state?.config.routerReadOnly ?? true;   // 未知时按只读（fail-safe）
```

工具 / 事件改动表：

| 位置 | 改动 |
|---|---|
| `router_task_open` | `withLedger(home, l => applyOpen(l, { key, goal, project: st.project, ownerSession: ctx.sessionManager.getSessionId() ?? "unknown", cwd: params.cwd ?? ctx.cwd, worktree, model }))`；`details.ledgerPath = tasksPath(home)` |
| `router_task_update` | 同样改 `withLedger`（`runId`/`report`/`status` 一致） |
| `router_task_list` | `loadLedger(home, { legacy })`（只读） |
| `router_memory_append` | 参数加 `project?: string`（默认 `st.project`）→ `appendMemoryLocked(home, project, section, text)`；`details = { path, project, section }` |
| `router_memory_read` | 参数加 `project?: string`；读全文后先过 `filterMemoryByProject`（若有 project），再走 v1 query/行号过滤与 `maxChars` |
| `router_workers`（新） | 参数 `{ status?: "active" \| "done" \| "all" }`（默认 `active`）；流程见 §6 |
| `router_inspect`（新） | 参数 `{ cmd, limit? }`；流程见下方骨架 + §5 |
| `before_agent_start` | `ensureState` → `applyReadOnlyTools(pi, st.config)`（层 A 兜底重放）→ `buildDigest(ledger.tasks, { project, scope, maxOpenShown })` → 注入 `ROUTER_RULES` + digest；`config.workerModel` 非空时注入块顶部加一行 `worker model: <id>` |
| `session_start` | `ensureState` → `applyReadOnlyTools(pi, st.config)`（层 A 主执行点）→ `render` |
| `tool_call`（新） | 见 §5 |
| `tool_result`（新） | 见 §7 |
| `/router` | 子命令不变；`memory [query]` 改用全局 `readMemory(home)`；`render` 计数口径不变（整个账本） |

```ts
function applyReadOnlyTools(pi: ExtensionAPI, config: RouterConfig): void {
  if (isChildSession()) return;          // 子会话不碰（③ 层 A）
  if (!config.routerReadOnly) return;    // 逃生开关 false 时跳过层 A 与层 B
  pi.setActiveTools([...KEEP_TOOLS]);    // 每次都传同一常量数组 → 集合稳定，不引入额外 prompt 抖动
}
```

`router_inspect` 的 `execute` 骨架（层 B）：

```ts
const { cmd } = params;
if (cmd === "tree") {
  const limit = clampLimit(params.limit, 200);
  const entries = await treeEntries(ctx.cwd, limit);
  return { content: [{ type: "text", text: formatTree(entries) }],
           details: { cmd, count: entries.length, truncated: entries.length >= limit }, isError: false };
}
const invocation = inspectArgv(cmd, params.limit);
if (!invocation) {
  return { content: [{ type: "text", text: `不支持的 cmd：${String(cmd)}（支持 git-status | git-log | git-diff | tree）` }],
           details: { cmd }, isError: false };
}
try {
  const r = await pi.exec(invocation.command, invocation.args, { cwd: ctx.cwd, timeout: 10_000 });
  const tail = r.stderr ? `\n[stderr]\n${r.stderr}` : "";
  return { content: [{ type: "text", text: `$ ${invocation.command} ${invocation.args.join(" ")} (exit ${r.code})\n${r.stdout}${tail}` }],
           details: { cmd, code: r.code, truncated: r.truncated }, isError: false };
} catch (error) {
  // git 不存在 / 超时 / cwd 非仓库：都以文本返回，不抛（③ 层 B）
  return { content: [{ type: "text", text: `inspect ${cmd} 失败：${(error as Error).message}` }],
           details: { cmd }, isError: false };
}
```

### 2.9 测试文件与脚本

- `test/store.test.ts`：v1 八个用例改为 home 视角 + v2 字段 + `withLedger`，新增 §3/§4 的锁、并发、迁移、digest 两行统计用例。
- `test/config.test.ts`（新）：`parseConfig` 默认值/坏 JSON/单字段类型错、`expandHome`、`resolveHome` 三级优先级、`defaultConfig().home` 形状。
- `test/guard.test.ts`（新）：`shouldBlockTool`、`blockReason` 前缀、`KEEP_TOOLS` 集合相等、`clampLimit`、`inspectArgv`（含未知 cmd 拒绝）、`treeEntries`（深度 2、跳过 `node_modules`/`.git`/`.pi`、limit）。
- `test/workers.test.ts`（新）：`extractRunId` 三形状 + 歧义 + 空、`parseRunStatus`、`runDirCandidates`、`formatWorkerLine`、`findExistingDir([]) === undefined`。

`package.json`：

```json
"version": "0.2.0",
"scripts": {
  "typecheck": "tsc --noEmit",
  "test": "node --test test/store.test.ts test/guard.test.ts test/config.test.ts test/workers.test.ts"
}
```

`test` 脚本必须写**显式文件列表**：Windows 的 npm 脚本由 cmd.exe 执行，不会展开 `test/*.test.ts`；本机 Node v24.19 上 `node --test test/`（目录形式）也会以 `MODULE_NOT_FOUND` 失败（已实测）。`dependencies` 仍不存在，host 包与 `typebox` 仍只在 `peerDependencies`。

---

## 3. 锁：实现细节与并发测试

### 3.1 锁文件协议

- 路径 `<home>/tasks.lock`，内容 `{ "pid": <number>, "at": "<ISO>" }`（仅用于诊断；判定陈旧只看 mtime）。
- 获取：`fs.open(lockPath, "wx")`（`O_CREAT|O_EXCL`，原子独占创建）→ 写内容 → **立即 close**。
- 为什么必须立即 close：Windows 上「被打开的文件不能 unlink / 不能替换」；若持有句柄，别的进程释放时会 `EPERM/EBUSY`。
- 释放：`rm(lockPath, { force: true })`，包在 `finally` 里，失败**忽略**（`try/catch` 吞掉）。
- 只有 `acquire` 成功的那个调用者才 release；超时抛错时**不**删锁（锁可能属于别人）。

### 3.2 获取算法（可直接转 TS）

```ts
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_STALE_MS = 10_000;
const BACKOFF_START_MS = 25;
const BACKOFF_MAX_MS = 200;

async function acquireLock(home: string, options?: LockOptions): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const path = lockPath(home);
  await mkdir(home, { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let delay = BACKOFF_START_MS;
  let tookOver = false;

  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
      } finally {
        await handle.close();            // Windows：句柄必须立刻关掉
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const contended = code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!contended) throw error;       // 目录不可写等真实错误直接抛

      if (!tookOver && (await isStale(path, staleMs))) {
        tookOver = true;                 // 每个调用者最多接管一次，避免活锁
        try { await rm(path, { force: true }); } catch { /* 别人已释放 */ }
        continue;                        // 立刻重试，不 sleep
      }
      if (Date.now() >= deadline) {
        throw new Error(`router: 账本锁超时（${timeoutMs}ms，${path}）`);
      }
      await sleep(Math.min(delay, BACKOFF_MAX_MS) + Math.floor(Math.random() * 11));  // 抖动 ≤10ms 打散同步重试
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try { return Date.now() - (await stat(path)).mtimeMs > staleMs; }
  catch { return false; }               // 已消失 → 下一轮 open 立刻成功
}

export async function withLock<T>(home: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  await acquireLock(home, options);
  try { return await fn(); }
  finally { try { await rm(lockPath(home), { force: true }); } catch { /* 释放失败忽略 */ } }
}
```

参数与 BRIEF-v2 ② 的对应关系：起始 25ms、指数翻倍封顶 200ms、总超时 3000ms、mtime 陈旧阈值 10s、陈旧则「unlink + 立刻重试一次」、`finally` 释放且失败忽略。（`sleep(ms)` 就是 `await new Promise((r) => setTimeout(r, ms))`，其余 import：`mkdir`/`open`/`rm`/`stat` 来自 `node:fs/promises`。）

**不做的事**（避免返工）：不做 pid 存活探测（BRIEF-v2 只要求 mtime 判陈旧）；不做重入计数；不做跨线程队列。`withLock` 内部**不得**再调 `withLock`/`withLedger`（无重入）——写路径只在最外层取一次锁，内部用 `readLedgerUnlocked`/`saveLedger`/`appendMemoryUnlocked`。

### 3.3 写路径清单（② 的落地核对表）

| 入口 | 是否持锁 | 说明 |
|---|---|---|
| `router_task_open` / `router_task_update` | ✅ `withLedger` | 读 → 迁移 → 改 → 原子写 |
| 迁移（落盘 + 改名） | ✅ 在 `withLedger` 内 | 与业务改动同一把锁（BRIEF-v2 ① 最后一句） |
| `router_memory_append` | ✅ `appendMemoryLocked` | 与账本锁同一把锁（同 home） |
| `tool_result` 自动记 runId | ✅ `withLedger` | 见 §7 |
| `loadLedger`（digest/list/`/router`/workers/只读工具） | ❌ | 接受最终一致（② 最后一段） |

### 3.4 并发测试怎么写得不 flaky

用例 `test/store.test.ts` → `test("20 concurrent opens under the ledger lock keep every task")`：

```ts
const home = await mkdtemp(join(tmpdir(), "pi-router-lock-"));
try {
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    withLedger(home, (ledger) => applyOpen(ledger, {
      key: `k${i}`, goal: `g${i}`, project: "p", ownerSession: "test", cwd: home,
    }))));
  const { ledger } = await loadLedger(home);
  assert.equal(ledger.tasks.length, 20);
  assert.equal(new Set(ledger.tasks.map((t) => t.id)).size, 20);
  assert.equal(ledger.seq, 20);
  const entries = await readdir(home);
  assert.ok(!entries.includes("tasks.lock"));            // 锁已释放
  assert.ok(!entries.some((e) => e.endsWith(".tmp")));   // 无 tmp 残留
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
```

不 flaky 的 9 条硬要求：

1. **每个用例独占 home**（`mkdtemp`），绝不共享 `~/.pi` 或固定路径 → 用例间无竞争；`node --test` 多文件并行也不冲突。
2. **只断言终局不变量**（条数、id 集合大小、`seq`），不断言到达顺序、不断言中间态。
3. **断言集合而非顺序**：`new Set(...).size`；`seq === 20` 由「每次成功 open 恰好 +1 且不丢」保证。
4. **断言锁已释放 + 无 `.tmp` 残留**，这样锁泄漏或原子写失败会显式失败而不是偶发。
5. **不用 `sleep` 制造竞争**：竞争由 `Promise.all` 自然产生；串行化由锁保证。20 个临界区各约 1–3ms，默认 3000ms 超时余量 ≥20×。
6. **超时用例注入参数**，不靠等待：`withLock(home, fn, { timeoutMs: 150 })` 配合预先手工创建 `tasks.lock`，断言 `assert.rejects(..., /账本锁超时/)`；同时断言锁文件仍在（别人的锁不被删）。
7. **陈旧锁用例注入 `staleMs`**：手工建 `tasks.lock` 后 `utimes(lockPath, old, old)` 把 mtime 设到 20s 前，再以 `staleMs: 10_000` 调 `withLedger` → 成功且退出后锁消失；不依赖真实 10s 等待。
8. **清理用 `rm(..., { force: true, maxRetries: 5, retryDelay: 20 })`**：Windows 上刚 close 的文件仍可能短暂 `EPERM`（杀毒/索引器）。清理失败不应让测试失败或污染下一个用例。
9. **不跨进程**：跨进程正确性由 `O_EXCL` 语义保证，测试只覆盖同进程并发；不要为了"更真实"去 spawn 子进程（会引入不稳定与 `child_process` 禁词风险）。

`test/workers.test.ts`、`test/config.test.ts`、`test/guard.test.ts` 全部是纯函数用例（无 IO，除 `treeEntries` 用 `mkdtemp`），天然不 flaky。

---

## 4. v1 → v2 迁移：顺序、幂等、回滚

### 4.1 迁移触发条件（BRIEF-v2 ①）

在 `withLedger(home, fn, { legacy: { dir, project } })` 的锁内，按此顺序：

1. `dir === home`（`scope: "project"` 或旧文件就在全局目录）→ **跳过整个迁移**。
2. 读全局 `tasks.json`（不存在 → 空账本；损坏 → 备份 `tasks.json.bak-<ts>` + 空账本 + warning，沿用 v1）。
3. `stat(tasksPath(dir))`：不存在 → 只返回当前账本。
4. 读 + `JSON.parse` + `parseLegacyLedger`：
   - 结构非法 → **不导入**，把旧文件改名为 `tasks.json.legacy-broken-<ts>`（不删除，可人工修回），warning 记录「旧账本损坏，已改名跳过」。这样后续加载不会再反复警告。
5. `importLegacyTasks(ledger, legacy, project)` → 内存合并（补 `project`、`ownerSession = "migrated"`，id 冲突见 C4）。
6. `saveLedger(home, merged)`（**先落盘**，原子写）。
7. `rename(tasksPath(dir), tasksPath(dir) + ".migrated-" + Date.now())`（同目录改名，**不删除**，可回滚）。
8. 合并后的账本交给 `fn`，随后再存一次（业务改动）。

**为什么先落盘再改名**：反序（先改名后落盘）会在崩溃时丢掉旧任务（虽然能从 `.migrated-*` 手工恢复）；先落盘 + 第 4.2 步的去重让「崩溃后重试」安全。改动顺序必须与这里一致，测试按此断言。

### 4.2 幂等（崩溃中断 / 重复运行）

- 正常路径的幂等来自「改名后旧文件不再存在」。
- 崩溃窗口（第 6 步成功、第 7 步前中断）的幂等来自 `importLegacyTasks` 的去重键 **`(key, createdAt)`**：全局账本已有同键同创建时间的任务 → 跳过，`imported === 0` 时仍然执行第 7 步改名。
- 因此「连续调用两次 `withLedger`」与「第一次在第 6 步后崩溃、第二次重跑」结果一致：任务条数不变、`seq` 不增长。
- 测试点：迁移后再次 `withLedger` → `ledger.tasks.length` 不变，且目录里只有**一个** `tasks.json.migrated-*`。

### 4.3 回滚（改名不删除）

三种回滚动作，都只依赖文件系统，不需要代码支持：

| 想回到 | 操作 |
|---|---|
| v1 项目账本 | 把 `tasks.json.migrated-<ts>` 改回 `<cwd>/.pi/router/tasks.json`；全局账本里这批任务按需手工删（或整份 `tasks.json` 换成备份） |
| 迁移前的全局账本 | 全局账本全程原子写，迁移前后的版本都在；需要时用 `tasks.json.bak-<ts>`（损坏分支）或版本控制里的历史副本 |
| 关闭全局共享 | `router.json` 设 `scope: "project"` → `home` 回到 `<cwd>/.pi/router`，全局账本原样留在 `~/.pi/agent/router/` 不再被读写（不丢数据） |

### 4.4 与读路径的关系（C3）

- `loadLedger(home, { legacy })` 只做**内存导入**：digest、`router_task_list`、`/router` 在第一次写操作之前就能看到旧任务。
- 内存导入与锁内导入用**同一个** `importLegacyTasks`，因此 id 分配结果一致（去重 + 顺序确定），不会出现「digest 里的 id 和落盘后的 id 不同」。
- 读路径**不**改名、**不**落盘、不取锁 → 满足 ② 的「读路径不取锁」。

---

## 5. 层 A（KEEP / setActiveTools）与层 C（tool_call）的纯函数切分

### 5.1 切分原则

| 关注点 | 纯函数（`src/guard.ts`，可单测） | 宿主胶水（`src/index.ts`，不可单测） |
|---|---|---|
| 白名单 | `KEEP_TOOLS` | `pi.setActiveTools([...KEEP_TOOLS])` |
| 是否生效 | `isChildSession(env)` | 工厂顶部早退 + `applyReadOnlyTools` 内二次判断 |
| 拦截判定 | `shouldBlockTool(name)` / `blockReason(name)` | `pi.on("tool_call", ...)` 只做 `if (shouldBlockTool(...)) return { block, reason }` |

`pi.on("tool_call")` 的整个 handler 体保持 3 行以内，所有可测逻辑在 `guard.ts`：

```ts
pi.on("tool_call", async (event) => {
  if (!readOnly()) return;                                  // config.routerReadOnly（未知时 true）
  if (!shouldBlockTool(event.toolName)) return;
  return { block: true, reason: blockReason(event.toolName) };
});
```

### 5.2 层 A 的执行点与顺序

1. **工厂顶部**：`if (isChildSession()) return;`（子会话不注册任何东西——沿用 v1，双保险由 `agents/router-worker.md` 的 `extensions: []` 提供）。
2. **`session_start`（主执行点）**：`ensureState` → `applyReadOnlyTools(pi, st.config)` → `render`。`session_start` 的 `reason` 覆盖 `startup|reload|new|resume|fork`，所以每个新会话自动就是只读 Router。
3. **`before_agent_start`（兜底重放）**：每轮开跑前再调一次 `applyReadOnlyTools`。原因见 §8 风险 R5：`pi.setActiveTools` 会**忽略尚未注册的名字**，若 `subagent`（pi-subagents 提供）在 `session_start` 时还没注册，第一轮拿到的工具集里就没有 `subagent`；每轮重放可在它注册后自动补齐。
4. 不把 KEEP 与「当前 active 集合」做并集（那会把 `bash` 之类加回来），永远传常量数组本身。

### 5.3 「先 setActiveTools 还是先 registerTool」

- 本扩展的 6 个工具（5 个 v1 + `router_workers`/`router_inspect`，共 7 个名字）在工厂函数里同步注册，**注册即激活**。
- 因此**不**在工厂内调用 `setActiveTools`（那时数组还不完整、且会在后续 `registerTool` 后被覆盖）；只依赖第 5.2 步的 2、3 两个时点。
- 常量数组顺序固定，重复调用同一集合时集合不变 → 不产生额外的 prompt/tool 声明抖动（docs/extensions.md：Pi 会 diff 结果集）。

### 5.4 层 B 的边界

- `router_inspect` 只接 `InspectCmd` 四个值（TypeBox `Type.Union` 枚举 + `inspectArgv` 二道白名单）。
- 固定 argv，不接受自由字符串、不接受 shell 元字符（无 `sh -c`、无引号拼接）。
- `limit` 在 schema 上是 `Type.Integer({ minimum: 1, maximum: 500 })`，代码里再 `clampLimit` 一次（防御模型/脚本绕过 schema）。
- `tree` 不调用 `pi.exec`，纯 `fs/promises` 遍历（深度 ≤2、条目 ≤ `limit ?? 200`、跳过 `node_modules`/`.git`/`.pi`）。
- 任何失败（git 不存在、超时、非仓库）都以文本返回 `isError: false`（③ 层 B 明确要求不抛）。

---

## 6. `router_workers`：运行目录发现、status.json 解析、失败降级

### 6.1 流程

```ts
async function collectWorkers(st: RouterState, wanted: "active" | "done" | "all") {
  const { ledger } = await loadLedger(st.home, { legacy: st.legacy });          // 只读，不取锁
  const candidates = runDirCandidates(process.env, os.tmpdir(), () => safeUsername());
  const runDir = await findExistingDir(candidates);                             // undefined → 降级
  const rows: { task: Task; info?: RunStatusInfo; bucket: WorkerBucket }[] = [];
  for (const task of ledger.tasks) {
    if (!task.runId && !isOpen(task)) continue;                                 // 终态且无 runId 的不列
    const info = task.runId && runDir ? await readRunStatus(runDir, task.runId) : undefined;
    rows.push({ task, info, bucket: runBucket(info, task) });
  }
  const filtered = wanted === "all" ? rows : rows.filter((r) => r.bucket === wanted);
  return { runDir, candidates, filtered, counts: countBuckets(rows) };
}

function safeUsername(): string | undefined {
  try { return os.userInfo().username || undefined; } catch { return undefined; }   // 极少数 Windows 环境会抛
}
```

### 6.2 输出格式

```text
workers: <N active> active · <M done> done
<taskId> [<taskStatus>] <project> · run <runId|-> · <state|-> · session <sessionPath|"?"|-> · last: <reportStatus|-> <summary≤60>
...
```

- 首行统计口径：**未过滤**的 `countBuckets(rows)`（`active`/`done` 各自数量），即使 `status` 过滤成其他桶也照原样显示。
- 行顺序：`active` 在前（按 `updatedAt` 降序），`done` 在后（按 `updatedAt` 降序）。
- 行数上限 50，超出追加 `…(+N more)`（账本可能积累很多终态任务；BRIEF-v2 未规定，取一个保守上限，避免刷爆上下文）。
- `details`：`{ runDir, candidates, rows: [...精简字段], active, done, degraded }`。

### 6.3 运行目录发现（BRIEF-v2 ④ 三步，逐字落地）

1. `env.PI_SUBAGENTS_RUN_DIR`（trim 非空）——**只**用它，不再尝试其它候选。
2. `path.join(os.tmpdir(), "pi-subagents-user-" + os.userInfo().username, "async-subagent-runs")`。
3. 都不存在 → 只输出账本信息并注明「运行目录未找到」。

`runDirCandidates` 把「拼路径」变成纯函数（`username` 作为注入参数，测试传 `() => "tester"`）；`findExistingDir` 负责 IO。降级提示文本固定：

```text
运行目录未找到（looked for: <候选1>[; <候选2>]）；仅显示账本信息，state 一律回退任务状态
```

### 6.4 `status.json` 解析（宽容、失败即忽略）

- 只读 `<runDir>/<runId>/status.json`，**绝不写**运行目录（④「只读」）。
- `parseRunStatus` 取三个字段：`state`、`sessionPath`（`sessionFile ?? steps[0]?.sessionFile`）、`cwd`。字段缺失/类型不符 → 该字段 `undefined`，整体仍返回对象；顶层不是 object → `undefined`。
- `readRunStatus` 的 ENOENT / JSON 损坏 / 权限错误 / 目录不存在 **全部** → `undefined`，不产生任何 warning、不抛（④「缺失/损坏则忽略，不报错」）。
- `runId` 来自账本，不信任文件名列表；不对 `status.json` 的 `results`/`children` 做递归（v2 不需要）。

### 6.5 降级矩阵（验收 10 的核对点）

| 情况 | 行为 |
|---|---|
| 运行目录不存在 | 列出账本行（`state` 用 `-`），加「运行目录未找到」提示，`degraded: true` |
| `runId` 存在但目录里没有该 run | 该行 `state`/`session` 为 `-`/`?`，其余正常 |
| `status.json` 损坏 | 同上，不报错 |
| 账本不存在 | 空行列表 + `workers: 0 active · 0 done` + 提示（不抛） |
| 账本损坏 | 走 `loadLedger` 的备份/重置 + warning 文本前置 `⚠`，工具照常返回 |

---

## 7. runId 自动提取：纯函数设计 + `tool_result` 接线

### 7.1 三种 `details` 形状（④）

| 来源 | 形状 | 取值 |
|---|---|---|
| 后台 run 完成通知 / 部分 async 结果 | `{ runId: string }` | `details.runId` |
| 分组通知（一次多个完成） | `{ runs: [{ runId }, ...] }` | `details.runs[*].runId` |
| 子会话/嵌套 run 提示 | `{ childRunId: string }` | `details.childRunId` |

### 7.2 纯函数（`src/workers.ts`）

```ts
export function extractRunId(details: unknown): string | undefined {
  const found = new Set<string>();
  const visit = (value: unknown): void => { if (typeof value === "string" && value.trim() !== "") found.add(value.trim()); };

  if (typeof details === "object" && details !== null) {
    const record = details as Record<string, unknown>;
    visit(record.runId);
    visit(record.childRunId);
    const runs = record.runs;
    if (Array.isArray(runs)) {
      for (const entry of runs) {
        if (typeof entry === "object" && entry !== null) visit((entry as Record<string, unknown>).runId);
      }
    }
  }
  return found.size === 1 ? [...found][0] : undefined;   // 0 或 >1（歧义）→ 不猜
}
```

歧义处理：`runs` 里两个不同 runId → `size === 2` → `undefined`；两个相同（分组通知重复）→ 去重后 `size === 1` → 返回。空串/非字符串一律忽略。

单测（`test/workers.test.ts`）：

- `{ runId: "r1" }` → `"r1"`
- `{ runs: [{ runId: "r1" }, { runId: "r1" }] }` → `"r1"`（去重后唯一）
- `{ runs: [{ runId: "r1" }, { runId: "r2" }] }` → `undefined`（歧义跳过）
- `{ childRunId: "c1" }` → `"c1"`
- `{}` / `undefined` / `"r1"` / `{ runId: 42 }` → `undefined`

### 7.3 写入侧（`setRunIdIfUnclaimed`，纯函数，在 `store.ts`）

「唯一候选」的判定是**账本侧**的，也必须可单测：

- 候选 = `status === "queued" && runId === undefined` 的任务。
- 恰好 1 个 → 写 `runId`、`status = "running"`、`updatedAt`；
- 0 个（没有待派任务）或 ≥2 个（分不清是谁）→ **不猜**，返回 `undefined`，账本不变。

单测：3 个 queued 任务 → 不写入；1 个 queued → 写入且状态变 `running`；已带 `runId` 的 queued 不算候选。

### 7.4 `tool_result` 接线（`src/index.ts`）

```ts
pi.on("tool_result", async (event, ctx) => {
  if (event.toolName !== "subagent") return;        // 只看派活结果
  if (event.isError) return;                        // 失败结果不记
  const runId = extractRunId(event.details);
  if (!runId) return;                               // 提取失败/歧义 → 静默跳过
  try {
    const st = await ensureState(ctx);
    await withLedger(st.home, (ledger) => { setRunIdIfUnclaimed(ledger, runId); }, { legacy: st.legacy });
  } catch {
    // 记账失败绝不改变工具结果（④「静默跳过」的等价处理：不打扰模型）
  }
  return;                                            // 不返回补丁 → 结果原样透传
});
```

约束：

- handler **只**返回 `undefined`（不修改 `content`/`details`），避免影响 subagent 结果渲染。
- 整个写入包 `try/catch`：锁超时等错误不能把「subagent 成功」变成失败。
- 写入走 `withLedger`（② 要求该写路径同样在锁内），耗时通常 <5ms；最坏等锁 3s，仅影响结果投递时序，不影响正确性（§8 R8）。
- `progress` 流式更新（`tool_execution_update`）不触发本 handler，只有最终 `tool_result` 触发一次。

---

## 8. 风险点与规避（含 Windows 特有语义）

**R1 `fs.open(path, "wx")` 的独占语义**
`"wx"` = `O_CREAT|O_EXCL`，NTFS 上是原子的：并发创建同一路径只有一个成功，其余 `EEXIST`。但 Windows 上还可能返回 `EPERM`/`EACCES`/`EBUSY`（杀毒、索引器、SMB 重定向、文件被别的句柄持有）——这些在竞争语义上与 `EEXIST` 等价，**必须**一起按「争用」重试（§3.2 `contended` 判定），否则并发测试会偶发失败。真正的错误（`ENOENT` 父目录缺失、`ENOSPC`）直接抛。

**R2 Windows 上 unlink 打开中的文件会失败**
所以锁句柄写完立刻 `close()`；释放放 `finally` 并吞异常。如果忘记 close，20 并发测试会偶发「锁超时」而不是「锁竞争」。

**R3 `rename` 语义**
- 同目录 `rename(tmp, tasks.json)` 在 Windows 上映射到 `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`，可覆盖已有文件，是原子替换的最佳可用手段。
- 但目标被别的进程打开时（编辑器、AV 扫描、`read` 工具正在读）会 `EPERM`/`EBUSY`；**建议**在 `saveLedger` 里给 `rename` 加 3 次重试（间隔 20/40/80ms），其它错误照抛。这是 v1 没有的新增健壮性，不改变原子写语义。
- 跨卷 rename 会 `EXDEV`：tmp 必须与目标同目录（v1 已满足，保持）。
- 迁移里的旧文件改名用同目录 `rename`（同上），因此不会跨卷。

**R4 `~` 展开**
- 只处理 `~`、`~/`、`~\` 三种前缀（Windows 上 `~` 不是合法盘符，不存在歧义）；不做环境变量展开、不调用 shell。
- `os.homedir()` 在 Windows 取 `USERPROFILE`（可能为空）→ 兜底到 `HOME`，再兜底 `process.cwd()`；`defaultConfig()` 与 `configFilePath()` 共用同一个 `homeDir` 解析函数。
- 配置里写相对路径（如 `"home": ".pi/router"`）时按 `process.cwd()` 解析（`resolve()`），并在 README 里明确「建议写绝对路径或 `~` 形式」。

**R5 `setActiveTools` 与 subagent 工具共存（顺序问题）**
- `pi.setActiveTools()` **忽略尚未注册的名字**：如果 `pi-subagents` 的 `subagent` 在 `session_start` 时还没注册，第一次调用后 active 集合里就没有 `subagent`，Router 无法派活。
- 规避：`before_agent_start` 每轮重放（BRIEF-v2 ③ 已要求）；工具注册发生在首轮 LLM 请求之前，重放能保证首轮就带 `subagent`。
- 反向风险：`pi.setActiveTools` 在非 `direct`/`model-only` exposure 的工具上会被忽略（`subagent` 是 `direct`，无影响）。
- 建议（可选、非阻塞）：`before_agent_start` 里若 `pi.getAllTools()` 中不存在 `subagent`，在注入块加一行 `⚠ 未检测到 pi-subagents 的 subagent 工具`，把「装漏了扩展」这种环境问题显式化。实现成本 3 行，不影响验收。

**R6 `realpath` 与大小写**
- Windows 路径大小写不敏感，但字符串比较敏感。`projectName` 用 `realpath` 得到磁盘上的真实大小写，因此 `E:/Code/x` 与 `e:/code/x` 归一；`realpath` 失败（权限/不存在/UNC 超长）时退回 `basenameOf(cwd)`，此时大小写可能不一致 → 所有项目比较统一走 `sameProject()`（`toLowerCase` 比较），memory 的 `[project]` 过滤也大小写不敏感。
- `realpath` 结果末尾带不带分隔符都过 `basenameOf` 处理。

**R7 只读层对「用户自己的会话」的影响（不可逆体验变化）**
拿走 `bash`/`write`/`edit` 后，用户在这个会话里也不能手工改代码。这是 BRIEF-v2 的目标行为，但必须：① `/router` 或启动时不要误导；② README 明确逃生开关 `"routerReadOnly": false`；③ 拦截 reason 文案直接告诉模型「改用 router_inspect / 派 worker」，避免模型反复重试同一工具。

**R8 `tool_result` 里同步写账本的延迟**
最坏情况等锁 3s，会让 subagent 结果到模型的时间被推迟。缓解：只写一个字段；不读写大对象；失败静默。若将来嫌慢，可改成「内存队列 + 下次写操作合并」，但 v2 不做（BRIEF-v2 要求「该写入同样走锁」）。

**R9 `progressThrottleMs` / `workerModel` 的语义边界**
`workerModel` 只作为 digest 顶部一行提示，**不**改模型、**不**派活（⑤ 明确）；`progressThrottleMs` 在 v2 只是配置项（不实现节流），README 标注「预留」，避免 reviewer 认为漏实现。

**R10 BRIEF-v2 未覆盖但会踩到的两点**
- 运行目录命名：上游实际是 `<tmpdir>/pi-subagents-<scopeId>/async-subagent-runs`，Windows 上 `scopeId = user-<USERNAME>`（`process.getuid` 不存在），与 BRIEF-v2 给的 `user-<os.userInfo().username>` 一致；若机器设了 `PI_SUBAGENTS_TEMP_ROOT`，默认路径不存在 → 走 ④ 第 3 步降级（符合验收 10）。若后续想支持该变量，只需在 `runDirCandidates` 追加一个候选，**本计划不追加**（避免偏离 BRIEF-v2 的三步顺序）。
- 前台 `subagent` 结果的 `details.results[].runId` 不在 BRIEF-v2 列出的三种形状内 → 本计划不实现（避免与歧义规则打架）。若 reviewer 认为需要，追加一条 `results[*].runId` 到同一 `Set` 即可，单测同步加一例。

---

## 9. 实施后自检（对照 BRIEF-v2 验收 1–14）

### 9.1 命令

```bash
cd pi-router
npx tsc --noEmit                                   # 验收 1
npm test                                           # 验收 1（4 个测试文件，≥10 用例）
grep -rn "child_process\|spawn(\|--mode rpc\|-ne\b" src test || echo "禁词干净"     # 验收 12
grep -rn ": any\|@ts-ignore" src test || echo "无 any/ts-ignore"                    # 验收 12
node -e "const p=require('./package.json');console.log(p.version, p.dependencies ?? 'no deps', Object.keys(p.peerDependencies))"  # 验收 12/13
git status --porcelain                             # 验收 14：只有工作区改动，没有 commit/tag/push
```

### 9.2 逐条核对表

| 验收 | 落地位置 | 自检方式 |
|---|---|---|
| 1 tsc/test 绿 | 全部 | 9.1 前两条命令 |
| 2 v1 五工具名/参数不变、`/router` 五子命令 | `src/index.ts` | 逐个对照 `docs/BRIEF.md` 工具表；`/router` 分支未改 |
| 3 新工具参数一致 | `router_workers { status? }`、`router_inspect { cmd, limit? }` | 对照 BRIEF-v2 ④/③；schema 与 execute 同名参数 |
| 4 `session_start` 调 `setActiveTools(KEEP)` 且子会话跳过 | `applyReadOnlyTools` + `session_start` | 代码走查 + `test/guard.test.ts` 断言 `KEEP_TOOLS` 集合 |
| 5 `tool_call` 拦 `write/edit/bash` 且 reason 以 `Router 只读` 开头 | `guard.ts` + `index.ts` handler | `test/guard.test.ts` 覆盖 write/edit/bash/powershell/apply_* /cp/mv/rm 与 read 放行；`blockReason` 断言前缀 |
| 6 账本 v2 + 迁移改名 | `types.ts`、`store.ts` | `test/store.test.ts`：迁移用例断言 `project`/`ownerSession`/原字段/`.migrated-*` |
| 7 写路径全在锁内 + 20 并发 | `withLock`/`withLedger`/`appendMemoryLocked` | §3.3 表逐个走查 + 并发用例 |
| 8 默认 `~/.pi/agent/router`、`PI_ROUTER_HOME`、`scope: project` | `config.ts`、`index.ts` | `test/config.test.ts` |
| 9 digest 全局行 + 项目明细 + 上限 | `prompt.ts` | `test/store.test.ts` 的 digest 用例（首行 `global:`、次行 `project`、≤40 行/≤4096 字符、`…(truncated)`） |
| 10 workers 优雅降级 | `workers.ts` + `router_workers` | `findExistingDir([]) === undefined` + 降级文本用例 |
| 11 runId 唯一候选写入、歧义跳过 | `extractRunId` + `setRunIdIfUnclaimed` | `test/workers.test.ts` / `test/store.test.ts` |
| 12 无 child_process/无 any/无依赖 | 全部 | 9.1 grep + package.json 检查 |
| 13 版本 0.2.0 + README 更新 | `package.json`、`README.md` | README 需覆盖：全局安装（`~/.pi/agent/extensions/` 或 `pi -e ./src/index.ts`）、只读行为与逃生开关、`router_workers`/`router_inspect`、全局账本位置 `~/.pi/agent/router/`、迁移说明与回滚（改名不删）、`progressThrottleMs` 预留 |
| 14 未动 git 历史 | — | `git status --porcelain` 只显示改动文件；不执行任何提交类命令 |

### 9.3 测试用例清单（≥10，实际约 20）

`test/store.test.ts`：① 幂等 open（v1）② 报告追加（v1）③ digest 上限 + v2 两行统计（v1 改造）④ 原子写无 tmp（v1）⑤ 损坏备份（v1）⑥ 未知 id / memory 读写（v1）⑦ 纯函数边界（v1）⑧ v1→v2 迁移字段与改名 ⑨ 迁移幂等（二次调用不增长）⑩ 20 并发 open（不丢任务、seq 唯一、无锁残留、无 tmp）⑪ 陈旧锁接管（注入 `staleMs` + `utimes`）⑫ 锁超时（注入 `timeoutMs: 150`，`assert.rejects`）⑬ digest 项目过滤（别的项目任务不进明细）。
`test/config.test.ts`：⑭ 默认值 ⑮ 坏 JSON → warning + 默认 ⑯ 字段类型错只回退该字段 ⑰ `expandHome` 三形态 ⑱ `resolveHome` 三级优先级（含 `scope: project`）。
`test/guard.test.ts`：⑲ `shouldBlockTool` 正反例 + `blockReason` 前缀 ⑳ `KEEP_TOOLS` 集合相等 ㉑ `clampLimit` 边界 ㉒ `inspectArgv` 三种 git 命令 + `tree`/未知 cmd 返回 undefined ㉓ `treeEntries` 深度/跳过/limit。
`test/workers.test.ts`：㉔ `extractRunId` 五例 ㉕ `parseRunStatus` 宽容解析 ㉖ `runDirCandidates` 两分支 ㉗ `formatWorkerLine` 缺失字段 ㉘ `findExistingDir([])`。

---

## 摘要（5 行）

1. 顺序：types → config/guard/inspect/workers（host-free 纯函数）→ store（home 视角 + 锁 + 迁移）→ prompt → index（层 A/B/C + workers + tool_result）；test 与 package.json/README 收尾。
2. 锁：`open("wx")` + 25→200ms 指数退避/3s 超时/10s mtime 陈旧接管（每调用者一次）/句柄立即 close/`finally` unlink；20 并发测试只断言终局不变量，超时与陈旧用注入参数而非 sleep。
3. 迁移：`withLedger` 锁内「读全局 → 解析旧版本 → `(key, createdAt)` 去重合并 → 落盘 → 旧文件改名 `.migrated-<ts>`」，读路径只做内存导入，回滚靠改名不删。
4. 只读：KEEP 常量在 `session_start` 与 `before_agent_start` 双点 `setActiveTools`（子会话跳过），拦截判定全在 `guard.ts` 纯函数（reason 统一 `Router 只读` 前缀）；inspect 走固定 argv + `clampLimit`。
5. 可见性：运行目录三步发现 + `status.json` 宽容解析 + 全量降级；`extractRunId` 三形状去重后「唯一才用」，配合 `setRunIdIfUnclaimed` 的唯一 queued 候选，歧义一律不猜。
