import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir, userInfo, tmpdir } from "node:os";
import {
  appendAudit,
  appendGlobalMemoryLocked,
  appendProjectMemoryLocked,
  appendSessionNoteLocked,
  applyOpen,
  applyUpdate,
  auditPath,
  bindRunId,
  countBy,
  formatTaskRow,
  isOpen,
  loadLedger,
  migrateMemory,
  projectName,
  projectRouterDir,
  pruneSessions,
  readAudit,
  readGlobalMemory,
  readProjectMemory,
  readSession,
  tasksPath,
  withLedger,
  type UpdatePatch,
} from "./store.ts";
import {
  assembleMemory,
  clampReports,
  formatAuditLine,
  formatSessionText,
  latestReports,
  makeAuditLine,
  type AssembledContext,
  type AuditKind,
  type AuditLine,
  type MemoryScope,
} from "./memory.ts";
import { loadConfig, resolveHome } from "./config.ts";
import { blockReason, isChildSession, KEEP_TOOLS, shouldBlockTool } from "./guard.ts";
import { clampLimit, formatTree, inspectArgv, INSPECT_COMMANDS, treeEntries } from "./inspect.ts";
import { buildDigest, ROUTER_RULES } from "./prompt.ts";
import {
  countBuckets,
  extractRunId,
  findExistingDir,
  formatRunDirMissing,
  formatWorkerLine,
  readRunStatus,
  runBucket,
  runDirCandidates,
  type RunStatusInfo,
  type WorkerBucket,
} from "./workers.ts";
import type { Ledger, RouterConfig, Task } from "./types.ts";

const TASK_STATUSES = ["queued", "running", "needs-human", "done", "failed", "stopped"] as const;
const REPORT_STATUSES = ["progress", "blocked", "ready", "failed", "dropped"] as const;
const REASONS = ["user_request", "blocked_question", "rework", "superseded", "promoted", "other"] as const;
const MEMORY_SCOPES = ["global", "project", "session", "audit"] as const;

const StatusEnum = Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)));
const ReportEnum = Type.Union(REPORT_STATUSES.map((s) => Type.Literal(s)));
const ReasonEnum = Type.Union(REASONS.map((s) => Type.Literal(s)));

const openSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  goal: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  worktree: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
});
type OpenParams = Static<typeof openSchema>;

const updateSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: Type.Optional(StatusEnum),
  runId: Type.Optional(Type.String()),
  report: Type.Optional(
    Type.Object({
      status: ReportEnum,
      summary: Type.String(),
      question: Type.Optional(Type.String()),
    }),
  ),
  deliverables: Type.Optional(Type.Array(Type.String())),
  next: Type.Optional(Type.String()),
  reason: Type.Optional(ReasonEnum),
});
type UpdateParams = Static<typeof updateSchema>;

const listSchema = Type.Object({
  status: Type.Optional(Type.Union([...TASK_STATUSES.map((s) => Type.Literal(s)), Type.Literal("open")])),
});
type ListParams = Static<typeof listSchema>;

const memoryAppendSchema = Type.Object({
  section: Type.String(),
  text: Type.String(),
});
type MemoryAppendParams = Static<typeof memoryAppendSchema>;

const memoryReadSchema = Type.Object({
  scope: Type.Optional(Type.Union(MEMORY_SCOPES.map((s) => Type.Literal(s)))),
  query: Type.Optional(Type.String()),
  maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
});
type MemoryReadParams = Static<typeof memoryReadSchema>;

const noteSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  focus: Type.Optional(Type.String()),
});
type NoteParams = Static<typeof noteSchema>;

const taskGetSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  reports: Type.Optional(Type.Integer()),
});
type TaskGetParams = Static<typeof taskGetSchema>;

const workersSchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("done"), Type.Literal("all")])),
});
type WorkersParams = Static<typeof workersSchema>;

const inspectSchema = Type.Object({
  cmd: Type.Union(INSPECT_COMMANDS.map((cmd) => Type.Literal(cmd))),
  // 不设 minimum/maximum：BRIEF-v2 ③ 要求 limit 被“夹到 1..500”，而不是被 schema 校验拒绝；
  // 夹取在 execute 内由 clampLimit 完成（超出范围的历史调用仍会到达 clampLimit）。
  limit: Type.Optional(Type.Integer()),
});
type InspectParams = Static<typeof inspectSchema>;

const WORKERS_ROW_LIMIT = 50;

interface RouterState {
  cwd: string;
  config: RouterConfig;
  home: string;
  project: string;
  legacy: { dir: string; project: string };
  warning?: string;
}

function mergedWarnings(...warnings: (string | undefined)[]): string[] {
  return [...new Set(warnings.filter((warning): warning is string => typeof warning === "string" && warning !== ""))];
}

function warningPrefix(...warnings: (string | undefined)[]): string {
  const all = mergedWarnings(...warnings);
  return all.length > 0 ? `⚠ ${all.join("；")}\n` : "";
}

function sessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() || "unknown";
  } catch {
    return "unknown";
  }
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/** 层 A：把 Router 会话的工具集换成只读白名单。子会话与逃生开关 false 都跳过。 */
function applyReadOnlyTools(pi: ExtensionAPI, config: RouterConfig): void {
  if (isChildSession()) return;
  if (!config.routerReadOnly) return;
  pi.setActiveTools([...KEEP_TOOLS]);
}

function render(ctx: ExtensionContext, ledger: Ledger): void {
  const open = ledger.tasks.filter(isOpen).length;
  const running = countBy(ledger.tasks, "running");
  ctx.ui.setStatus(
    "router",
    ledger.tasks.length === 0 ? undefined : `router ● ${open} open · ${running} running`,
  );
}

function statusLines(ledger: Ledger): string[] {
  const open = ledger.tasks.filter(isOpen).length;
  const running = countBy(ledger.tasks, "running");
  const needsHuman = countBy(ledger.tasks, "needs-human");
  const lines = [`router — open: ${open} · running: ${running} · needs-human: ${needsHuman}`];
  // 全局账本下同一个 widget 会混着多项目任务，行首带 project（与 router_task_list 一致）。
  for (const task of ledger.tasks.filter(isOpen)) lines.push(`${task.project} · ${formatTaskRow(task)}`);
  return lines;
}

function taskReportLines(task: Task): string[] {
  const lines = [`${task.id} [${task.status}] ${task.key} — ${task.goal}`];
  if (task.reports.length === 0) {
    lines.push("(无报告)");
  } else {
    for (const report of task.reports) {
      lines.push(
        `[${report.at}] ${report.status} ${report.summary}${report.question ? ` (question: ${report.question})` : ""}`,
      );
    }
  }
  return lines;
}

function memoryView(
  text: string,
  query: string | undefined,
  maxChars: number,
): {
  lines: string[];
  matched?: number;
  truncated: boolean;
} {
  const q = query?.trim();
  if (!q) {
    if (!text) return { lines: ["memory 为空"], truncated: false };
    const truncated = text.length > maxChars;
    const body = truncated ? text.slice(0, maxChars) : text;
    return { lines: truncated ? [`${body}\n…(truncated)`] : [body], truncated };
  }

  const needle = q.toLowerCase();
  const rawLines = text === "" ? [] : text.split(/\r?\n/);
  const rows: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    if (rawLines[i].toLowerCase().includes(needle)) rows.push(`${i + 1}: ${rawLines[i]}`);
  }
  if (rows.length === 0) {
    return { lines: [`memory 中没有匹配 "${q}" 的行`], matched: 0, truncated: false };
  }
  let joined = rows.join("\n");
  const truncated = joined.length > maxChars;
  if (truncated) joined = `${joined.slice(0, maxChars)}\n…(truncated)`;
  return { lines: [joined], matched: rows.length, truncated };
}

function auditLine(st: RouterState, ctx: ExtensionContext, kind: AuditKind, extra?: Partial<AuditLine>): AuditLine {
  return makeAuditLine({
    at: new Date().toISOString(),
    session: sessionId(ctx),
    project: st.project,
    kind,
    ...extra,
  });
}

function sectionView(title: string, body: string): string {
  return `## ${title}\n${body === "" ? "(empty)" : body}`;
}

async function scopedMemoryText(
  st: RouterState,
  ctx: ExtensionContext,
  scope: MemoryScope | undefined,
  auditLimit = 40,
): Promise<string> {
  if (scope === "audit") {
    const lines = await readAudit(st.home, { limit: auditLimit });
    return lines.length === 0 ? "" : lines.map(formatAuditLine).join("\n");
  }
  if (scope === "global") return readGlobalMemory(st.home);
  if (scope === "project") return readProjectMemory(st.home, st.project);
  if (scope === "session") {
    const state = await readSession(st.home, sessionId(ctx));
    return state === undefined ? "" : formatSessionText(state);
  }

  const [globalText, projectText, sessionState] = await Promise.all([
    readGlobalMemory(st.home),
    readProjectMemory(st.home, st.project),
    readSession(st.home, sessionId(ctx)),
  ]);
  return [
    sectionView("global", globalText),
    sectionView("project", projectText),
    sectionView("session", sessionState === undefined ? "" : formatSessionText(sessionState)),
  ].join("\n\n");
}

interface WorkerRow {
  task: Task;
  info: RunStatusInfo | undefined;
  bucket: WorkerBucket;
}

function workerRowOrder(a: WorkerRow, b: WorkerRow): number {
  if (a.bucket !== b.bucket) return a.bucket === "active" ? -1 : 1;
  return b.task.updatedAt.localeCompare(a.task.updatedAt);
}

export default function piRouter(pi: ExtensionAPI): void {
  // 关键守卫：Router 只在 pi 主会话生效；子会话运行时设置 PI_SUBAGENT_CHILD=1。
  if (isChildSession()) return;

  let cached: RouterState | undefined;
  let building: { cwd: string; promise: Promise<RouterState> } | undefined;

  const buildState = async (ctx: ExtensionContext): Promise<RouterState> => {
    const { config, warning } = await loadConfig();
    const home = resolveHome(ctx.cwd, config);
    const project = await projectName(ctx.cwd);
    return { cwd: ctx.cwd, config, home, project, legacy: { dir: projectRouterDir(ctx.cwd), project }, warning };
  };

  // 缓存按 cwd 失效：会话内 switchSession/newSession 能换 cwd，项目名、账本 home 与迁移源目录都必须重算。
  const ensureState = async (ctx: ExtensionContext): Promise<RouterState> => {
    if (cached && cached.cwd === ctx.cwd) return cached;
    if (building && building.cwd === ctx.cwd) return building.promise;
    const promise = buildState(ctx).then(
      (state) => {
        cached = state;
        if (building?.promise === promise) building = undefined;
        return state;
      },
      (error: unknown) => {
        // 失败不缓存：否则同一 cwd 会永久复用 rejected promise，扩展在此目录下失效。
        if (building?.promise === promise) building = undefined;
        throw error;
      },
    );
    building = { cwd: ctx.cwd, promise };
    return promise;
  };

  // 未知配置时按只读处理（fail-safe）。
  const readOnly = (): boolean => cached?.config.routerReadOnly ?? true;

  const collectWorkers = async (state: RouterState, wanted: WorkersParams["status"]) => {
    const { ledger, warning } = await loadLedger(state.home, { legacy: state.legacy });
    const candidates = runDirCandidates({
      env: process.env,
      tmpDir: tmpdir(),
      getuid: () => process.getuid?.(),
      username: safeUsername,
      homedir: () => homedir(),
    });
    const runDir = await findExistingDir(candidates);

    const rows: WorkerRow[] = [];
    for (const task of ledger.tasks) {
      if (!task.runId && !isOpen(task)) continue;
      const info = task.runId && runDir ? await readRunStatus(runDir, task.runId) : undefined;
      rows.push({ task, info, bucket: runBucket(info, task) });
    }
    rows.sort(workerRowOrder);

    const counts = countBuckets(rows);
    const mode = wanted ?? "active";
    const filtered = mode === "all" ? rows : rows.filter((row) => row.bucket === mode);
    return { ledger, warning, candidates, runDir, rows, filtered, counts, mode };
  };

  pi.registerTool({
    name: "router_task_open",
    label: "Router: Open Task",
    description:
      "按幂等键开一个 Router 任务并拿到 id。若同 key 的开放任务已存在则直接复用，不重开。开完后下一步应调用 subagent({ agent: \"router-worker\", task, cwd, worktree }) 派发，再用 router_task_update 记录 running（runId 可省略，扩展会自动记）。",
    promptSnippet: "Router: 为独立目标开/复用一个任务并返回 id",
    parameters: openSchema,
    async execute(_toolCallId, params: OpenParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const cwd = params.cwd ?? ctx.cwd;
      // 显式 cwd 的任务算到它自己的项目下（与 migrateTaskV1 同口径），否则会混进当前项目的 digest。
      const project = params.cwd ? await projectName(params.cwd) : st.project;
      const txn = await withLedger(
        st.home,
        (ledger) =>
          applyOpen(ledger, {
            key: params.key,
            goal: params.goal,
            project,
            ownerSession: sessionId(ctx),
            cwd,
            worktree: params.worktree,
            model: params.model,
          }),
        { legacy: st.legacy },
      );
      const { task, created } = txn.result;
      render(ctx, txn.ledger);
      await appendAudit(st.home, auditLine(st, ctx, "task_open", { project: task.project, taskId: task.id }));

      const text = created
        ? `已开任务 ${task.id} [${task.status}]（key=${task.key}，project=${task.project}）。下一步：调用 subagent({ agent: "router-worker", task, cwd, worktree }) 派发，再用 router_task_update 写 running（runId 可省略）。`
        : `幂等命中既有任务 ${task.id} [${task.status}]（key=${task.key}）。`;
      return {
        content: [{ type: "text", text: `${warningPrefix(st.warning, txn.warning)}${text}` }],
        details: { id: task.id, key: task.key, status: task.status, created, project: task.project, ledgerPath: tasksPath(st.home) },
      };
    },
  });

  pi.registerTool({
    name: "router_task_update",
    label: "Router: Update Task",
    description:
      "更新 Router 任务：改状态、记 runId、追加一条报告、替换交付物或写下一步。报告会自动追加时间戳。未知 id 会报错。派发 worker 后用它写 running；报告到达后也用它记账。",
    promptSnippet: "Router: 更新任务状态/runId/报告/交付物/下一步",
    parameters: updateSchema,
    async execute(_toolCallId, params: UpdateParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const patch: UpdatePatch = {
        status: params.status,
        runId: params.runId,
        report: params.report
          ? {
              status: params.report.status,
              summary: params.report.summary,
              question: params.report.question,
              reason: params.reason,
            }
          : undefined,
        deliverables: params.deliverables,
        next: params.next,
      };
      const txn = await withLedger(st.home, (ledger) => applyUpdate(ledger, params.id, patch), { legacy: st.legacy });
      const task = txn.result;
      render(ctx, txn.ledger);
      await appendAudit(
        st.home,
        auditLine(st, ctx, "task_update", {
          project: task.project,
          taskId: task.id,
          reason: params.reason,
          text: params.report?.summary,
        }),
      );

      const reportNote = params.report ? `；报告已追加，共 ${task.reports.length} 条` : "";
      const text = `${task.id} [${task.status}]${reportNote}`;
      return {
        content: [{ type: "text", text: `${warningPrefix(st.warning, txn.warning)}${text}` }],
        details: {
          id: task.id,
          status: task.status,
          reports: task.reports.length,
          updatedAt: task.updatedAt,
          ledgerPath: tasksPath(st.home),
        },
      };
    },
  });

  pi.registerTool({
    name: "router_task_list",
    label: "Router: List Tasks",
    description:
      "列出 Router 任务（全局账本）。无 status 列全部；status=open 列所有未结束任务；也可按 queued/running/needs-human/done/failed/stopped 过滤。每行带 project，便于区分项目。交付前用它确认没有遗漏的 open 任务。",
    promptSnippet: "Router: 列出/过滤账本里的任务",
    parameters: listSchema,
    async execute(_toolCallId, params: ListParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const { ledger, warning } = await loadLedger(st.home, { legacy: st.legacy });
      const predicate =
        params.status === undefined
          ? () => true
          : params.status === "open"
            ? (t: Task) => isOpen(t)
            : (t: Task) => t.status === params.status;
      const tasks = ledger.tasks.filter(predicate);

      const open = ledger.tasks.filter(isOpen).length;
      const running = countBy(ledger.tasks, "running");
      const needsHuman = countBy(ledger.tasks, "needs-human");

      const stats = `open: ${open} · running: ${running} · needs-human: ${needsHuman}`;
      const body = tasks.length === 0 ? ["(无匹配任务)"] : tasks.map((task) => `${task.project} · ${formatTaskRow(task)}`);
      const text = `${stats}\n${body.join("\n")}`;
      return {
        content: [{ type: "text", text: `${warningPrefix(st.warning, warning)}${text}` }],
        details: { tasks, open, running, needsHuman, ledgerPath: tasksPath(st.home) },
      };
    },
  });

  pi.registerTool({
    name: "router_memory_append",
    label: "Router: Append Memory",
    description:
      "把一条决策理由追加到审计日志 audit.jsonl（append-only）。只写审计，绝不写 global/project；要长期保留请让用户执行 /router promote。section 用于归类，会拼进 text 前缀。",
    promptSnippet: "Router: 追加一条决策记录到审计日志",
    parameters: memoryAppendSchema,
    async execute(_toolCallId, params: MemoryAppendParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const text = `[${params.section}] ${params.text}`;
      await appendAudit(st.home, auditLine(st, ctx, "note", { text }));
      return {
        content: [{ type: "text", text: "已记入审计；要长期保留请让我执行 `/router promote`" }],
        details: { path: auditPath(st.home), section: params.section },
      };
    },
  });

  pi.registerTool({
    name: "router_memory_read",
    label: "Router: Read Memory",
    description:
      "读取分层记忆。scope 可为 global/project/session/audit；缺省按 global → project → session 三段拼接。query 大小写不敏感行过滤（沿用 v2 语义）；audit 返回最近 40 行。",
    promptSnippet: "Router: 读取/过滤分层记忆",
    parameters: memoryReadSchema,
    async execute(_toolCallId, params: MemoryReadParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const text = await scopedMemoryText(st, ctx, params.scope, 40);
      const view = memoryView(text, params.query, params.maxChars ?? 8000);
      return {
        content: [{ type: "text", text: view.lines.join("\n") }],
        details: {
          scope: params.scope ?? null,
          matchedLines: view.matched,
          truncated: view.truncated,
        },
      };
    },
  });

  pi.registerTool({
    name: "router_note",
    label: "Router: Session Note",
    description:
      "写当前会话的短时记忆 sessions/<id>.json：追加一条 note（最多保留 50 条），可用 focus 更新当前关注点。返回写入后的 notes 条数与当前 focus。",
    promptSnippet: "Router: 写当前会话的短时记忆",
    parameters: noteSchema,
    async execute(_toolCallId, params: NoteParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const state = await appendSessionNoteLocked(st.home, sessionId(ctx), st.project, params.text, params.focus);
      return {
        content: [
          {
            type: "text",
            text: `已记入会话：notes ${state.notes.length} 条 · focus: ${state.focus || "(无)"}`,
          },
        ],
        details: { sessionId: state.sessionId, notes: state.notes.length, focus: state.focus },
      };
    },
  });

  pi.registerTool({
    name: "router_task_get",
    label: "Router: Get Task",
    description:
      "读取单个任务的完整字段与最近 reports 条报告（默认 5，夹取 0..20）。这是 digest 里 read: task/<id> 指针的目标。",
    promptSnippet: "Router: 读取单个任务的完整字段与最近报告",
    parameters: taskGetSchema,
    async execute(_toolCallId, params: TaskGetParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const { ledger, warning } = await loadLedger(st.home, { legacy: st.legacy });
      const task = ledger.tasks.find((t) => t.id === params.id);
      if (!task) throw new Error(`no task ${params.id}`);

      const count = clampReports(params.reports);
      const reports = latestReports(task.reports, count);
      const lines = [
        `${task.id} [${task.status}] ${task.key} — ${task.goal}`,
        `project: ${task.project}`,
        `cwd: ${task.cwd}`,
        `ownerSession: ${task.ownerSession}`,
        `runId: ${task.runId ?? "-"}`,
        `worktree: ${task.worktree ?? false}`,
        `model: ${task.model ?? "-"}`,
        `deliverables: ${task.deliverables?.join(", ") ?? "-"}`,
        `next: ${task.next ?? "-"}`,
        `createdAt: ${task.createdAt}`,
        `updatedAt: ${task.updatedAt}`,
        `reports（最近 ${reports.length} 条）:`,
      ];
      for (const report of reports) {
        const reason = report.reason ? ` (reason: ${report.reason})` : "";
        const question = report.question ? ` (question: ${report.question})` : "";
        lines.push(`[${report.at}] ${report.status} ${report.summary}${reason}${question}`);
      }

      return {
        content: [{ type: "text", text: `${warningPrefix(st.warning, warning)}${lines.join("\n")}` }],
        details: { task, reports, reportsTotal: task.reports.length, ledgerPath: tasksPath(st.home) },
      };
    },
  });

  pi.registerTool({
    name: "router_workers",
    label: "Router: Workers",
    description:
      "查看派出去的 worker：runId、状态、session 路径与最后一条报告。status=active（默认）看未结束的，done 看已结束的，all 全看。只读探测 pi-subagents 运行目录；目录不存在时降级为账本信息。要看过程用 subagent({ action: \"status\", id, options: { view: \"transcript\" } })。",
    promptSnippet: "Router: 查看 worker 的 runId / 状态 / session 路径",
    parameters: workersSchema,
    async execute(_toolCallId, params: WorkersParams, _signal, _onUpdate, ctx) {
      const st = await ensureState(ctx);
      const collected = await collectWorkers(st, params.status);
      const lines = [`workers: ${collected.counts.active} active · ${collected.counts.done} done`];

      if (!collected.runDir) lines.push(formatRunDirMissing(collected.candidates));

      if (collected.filtered.length === 0) {
        lines.push("(无匹配 worker)");
      } else {
        for (const row of collected.filtered.slice(0, WORKERS_ROW_LIMIT)) {
          lines.push(formatWorkerLine(row.task, row.info));
        }
        const overflow = collected.filtered.length - WORKERS_ROW_LIMIT;
        if (overflow > 0) lines.push(`…(+${overflow} more)`);
      }

      return {
        content: [{ type: "text", text: `${warningPrefix(st.warning, collected.warning)}${lines.join("\n")}` }],
        details: {
          runDir: collected.runDir ?? null,
          candidates: collected.candidates,
          active: collected.counts.active,
          done: collected.counts.done,
          degraded: collected.runDir === undefined,
          rows: collected.filtered.map((row) => ({
            id: row.task.id,
            status: row.task.status,
            project: row.task.project,
            runId: row.task.runId ?? null,
            state: row.info?.state ?? null,
            sessionPath: row.info?.sessionPath ?? null,
            bucket: row.bucket,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "router_inspect",
    label: "Router: Inspect",
    description:
      "只读检查当前项目：git-status / git-log / git-diff / tree。Router 没有 bash，查状态一律用它。参数固定，不接受自由命令；limit 对 git-log 的条数与 tree 的条目数生效（1..500）。",
    promptSnippet: "Router: 只读检查 git 状态与目录树（替代 bash）",
    parameters: inspectSchema,
    async execute(_toolCallId, params: InspectParams, _signal, _onUpdate, ctx) {
      if (params.cmd === "tree") {
        const limit = clampLimit(params.limit, 200);
        const entries = await treeEntries(ctx.cwd, limit);
        return {
          content: [{ type: "text", text: formatTree(entries) }],
          details: { cmd: params.cmd, count: entries.length, truncated: entries.length >= limit },
          isError: false,
        };
      }

      const invocation = inspectArgv(params.cmd, params.limit);
      if (!invocation) {
        return {
          content: [
            { type: "text", text: `不支持的 cmd：${String(params.cmd)}（支持 git-status | git-log | git-diff | tree）` },
          ],
          details: { cmd: params.cmd },
          isError: false,
        };
      }

      try {
        const result = await pi.exec(invocation.command, invocation.args, { cwd: ctx.cwd, timeout: 10_000 });
        const tail = result.stderr ? `\n[stderr]\n${result.stderr}` : "";
        return {
          content: [
            {
              type: "text",
              text: `$ ${invocation.command} ${invocation.args.join(" ")} (exit ${result.code})\n${result.stdout}${tail}`,
            },
          ],
          details: { cmd: params.cmd, code: result.code, truncated: result.truncated },
          isError: false,
        };
      } catch (error) {
        // git 不存在 / 超时 / cwd 非仓库：都以文本返回，不抛（层 B）。
        return {
          content: [{ type: "text", text: `inspect ${params.cmd} 失败：${(error as Error).message}` }],
          details: { cmd: params.cmd },
          isError: false,
        };
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const st = await ensureState(ctx);
    applyReadOnlyTools(pi, st.config); // 层 A 兜底重放（R5：subagent 可能注册得比 session_start 晚）
    const { ledger, warning } = await loadLedger(st.home, { legacy: st.legacy });
    const digestOptions = {
      project: st.project,
      scope: st.config.scope,
      maxOpenShown: st.config.maxOpenShown,
    };
    const modelLine = st.config.workerModel ? `worker model: ${st.config.workerModel}\n` : "";

    let assembled: AssembledContext;
    let memoryWarning: string | undefined;
    try {
      const migration = await migrateMemory(st.home);
      if (migration.warning) memoryWarning = migration.warning;
      const [globalText, projectText, sessionState] = await Promise.all([
        readGlobalMemory(st.home),
        readProjectMemory(st.home, st.project),
        readSession(st.home, sessionId(ctx)),
      ]);
      assembled = assembleMemory({
        global: globalText,
        project: projectText,
        projectName: st.project,
        session: sessionState,
        tasks: ledger.tasks,
        digestOptions,
      });
    } catch (error) {
      // 读盘失败（除 ENOENT）时回退 v2 digest，绝不让 hook 抛错。
      const digest = buildDigest(ledger.tasks, digestOptions);
      const notes = mergedWarnings(warning, st.warning, `记忆读取失败（${(error as Error).message}），已回退 digest`).map(
        (message) => `[router 警告] ${message}`,
      );
      if (!pi.getAllTools().some((tool) => tool.name === "subagent")) {
        notes.push("⚠ 未检测到 pi-subagents 的 subagent 工具，Router 无法派活");
      }
      const warn = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
      return { systemPrompt: `${event.systemPrompt}\n\n${ROUTER_RULES}\n\n${modelLine}${digest}${warn}` };
    }

    const notes = mergedWarnings(warning, st.warning, memoryWarning).map((message) => `[router 警告] ${message}`);
    if (!pi.getAllTools().some((tool) => tool.name === "subagent")) {
      notes.push("⚠ 未检测到 pi-subagents 的 subagent 工具，Router 无法派活");
    }
    const warn = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
    return { systemPrompt: `${event.systemPrompt}\n\n${ROUTER_RULES}\n\n${modelLine}${assembled.text}${warn}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    const st = await ensureState(ctx);
    applyReadOnlyTools(pi, st.config); // 层 A 主执行点：new/resume/fork/reload 都会走到
    const { ledger } = await loadLedger(st.home, { legacy: st.legacy });
    render(ctx, ledger);
    const migration = await migrateMemory(st.home);
    if (migration.warning) ctx.ui.notify(`router: ${migration.warning}`, "warning");
    await pruneSessions(st.home);
  });

  pi.on("tool_call", async (event) => {
    if (!readOnly()) return;
    if (!shouldBlockTool(event.toolName)) return;
    return { block: true, reason: blockReason(event.toolName) };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    if (event.isError) return;
    const runId = extractRunId(event.details);
    if (!runId) return;
    const taskText = typeof event.input.task === "string" ? event.input.task : undefined;
    try {
      const st = await ensureState(ctx);
      const bound = await withLedger(
        st.home,
        (ledger) => bindRunId(ledger, runId, taskText),
        { legacy: st.legacy },
      );
      const binding = bound.result;
      if (!binding) return;
      await appendAudit(
        st.home,
        auditLine(st, ctx, "dispatch", { project: binding.task.project, taskId: binding.task.id, runId }),
      );
      // 非唯一候选的绑定告诉模型一声，避免它以为 runId 没记上而重复派发或手工补录。
      if (binding.rule === "single") return;
      const why = binding.rule === "goal" ? "按派发文本匹配 goal" : "多个待派发任务，取最新创建者";
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n[router] runId 已自动绑定到 ${binding.task.id}（${why}）。` },
        ],
      };
    } catch {
      // 自动记账失败绝不改变 subagent 结果，也不打扰模型。
    }
    return;
  });

  pi.registerCommand("router", {
    description:
      "router: status | tasks | task <id> | memory [scope] [query] | digest | new <goal> | spawn <id> | promote <行号> [global|project] | session",
    getArgumentCompletions: (prefix) =>
      ["status", "tasks", "task ", "memory ", "digest", "new ", "spawn ", "promote ", "session"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value.trim() })),
    handler: async (args, ctx) => {
      const st = await ensureState(ctx);
      const { ledger, warning } = await loadLedger(st.home, { legacy: st.legacy });
      const input = (args ?? "").trim();
      const digestOptions = {
        project: st.project,
        scope: st.config.scope,
        maxOpenShown: st.config.maxOpenShown,
      };

      if (!input || input === "status" || input === "tasks") {
        ctx.ui.setWidget("router", statusLines(ledger));
      } else if (input.startsWith("task ")) {
        const id = input.slice(5).trim();
        const task = ledger.tasks.find((t) => t.id === id);
        if (!task) {
          ctx.ui.notify(`router: 无任务 ${id}`, "error");
          return;
        }
        ctx.ui.setWidget("router", taskReportLines(task));
      } else if (input === "digest") {
        ctx.ui.setWidget("router", [buildDigest(ledger.tasks, digestOptions)]);
      } else if (input === "memory" || input.startsWith("memory ")) {
        const rest = input === "memory" ? "" : input.slice(7).trim();
        const tokens = rest === "" ? [] : rest.split(/\s+/);
        let scope: MemoryScope | undefined;
        let query: string | undefined;
        if (tokens.length > 0 && (MEMORY_SCOPES as readonly string[]).includes(tokens[0])) {
          scope = tokens[0] as MemoryScope;
          query = tokens.slice(1).join(" ") || undefined;
        } else {
          query = rest === "" ? undefined : rest;
        }
        const text = await scopedMemoryText(st, ctx, scope, 40);
        ctx.ui.setWidget("router", memoryView(text, query, 8000).lines);
      } else if (input === "session") {
        const state = await readSession(st.home, sessionId(ctx));
        if (!state) {
          ctx.ui.setWidget("router", ["(当前会话无记忆)"]);
        } else {
          const lines = [`focus: ${state.focus || "(无)"}`];
          const notes = state.notes.slice(-5);
          if (notes.length === 0) lines.push("(无 note)");
          else for (const note of notes) lines.push(`[${note.at}] ${note.text}`);
          ctx.ui.setWidget("router", lines);
        }
      } else if (input === "promote" || input.startsWith("promote ")) {
        const rest = input === "promote" ? "" : input.slice(8).trim();
        const tokens = rest === "" ? [] : rest.split(/\s+/);
        const n = tokens.length > 0 ? Number.parseInt(tokens[0], 10) : Number.NaN;
        if (!Number.isInteger(n) || n < 1 || (tokens[1] !== undefined && tokens[1] !== "global" && tokens[1] !== "project")) {
          ctx.ui.notify("用法：/router promote <audit行号> [global|project]", "error");
          return;
        }
        const target: "global" | "project" = tokens[1] === "global" ? "global" : "project";
        const audit = await readAudit(st.home);
        if (n > audit.length) {
          ctx.ui.notify(`router: 审计只有 ${audit.length} 行，无第 ${n} 行`, "error");
          return;
        }
        const line = audit[audit.length - n];
        if (!line.text || line.text.trim() === "") {
          ctx.ui.notify(`router: 审计第 ${n} 行没有可晋升的 text`, "error");
          return;
        }
        if (target === "global") await appendGlobalMemoryLocked(st.home, line.text);
        else await appendProjectMemoryLocked(st.home, st.project, line.text);
        await appendAudit(st.home, auditLine(st, ctx, "promote", { taskId: line.taskId, reason: "promoted", text: line.text }));
        ctx.ui.notify(
          `router: 已晋升审计第 ${n} 行到 ${target === "global" ? "global.md" : `projects/${st.project}.md`}`,
          "info",
        );
      } else if (input.startsWith("new ")) {
        // 手动开任务：不在扩展里派活，而是把指令交给模型，由它按 ROUTER_RULES 走
        // router_task_open -> subagent -> router_task_update 的完整流程。
        const goal = input.slice(4).trim();
        if (goal === "") {
          ctx.ui.notify("用法：/router new <目标描述>", "error");
          return;
        }
        pi.sendUserMessage(
          `用 Router 流程处理这个目标：${goal}\n` +
            "先 router_task_open 建任务（key 自己取一个稳定的短标识），再派 router-worker，" +
            "派发后不要手写 runId（扩展会自动记），最后 router_task_update 记账。",
        );
      } else if (input.startsWith("spawn ")) {
        const id = input.slice(6).trim();
        const task = ledger.tasks.find((t) => t.id === id);
        if (!task) {
          ctx.ui.notify(`router: 无任务 ${id}`, "error");
          return;
        }
        if (task.status !== "queued" || task.runId !== undefined) {
          ctx.ui.notify(`router: ${task.id} 状态为 ${task.status}，不能直接派发`, "error");
          return;
        }
        pi.sendUserMessage(
          `派发任务 ${task.id}（key=${task.key}，目标：${task.goal}，cwd：${task.cwd}）。` +
            "用 subagent({ agent: \"router-worker\", task, cwd }) 派发，不要手写 runId 或状态，扩展会自动记。",
        );
      } else {
        ctx.ui.notify(
          "router: 支持 status | tasks | task <id> | memory [scope] [query] | digest | new <目标> | spawn <id> | promote <行号> [global|project] | session",
          "error",
        );
        return;
      }

      render(ctx, ledger);
      for (const message of mergedWarnings(warning, st.warning)) ctx.ui.notify(`router: ${message}`, "warning");
    },
  });
}