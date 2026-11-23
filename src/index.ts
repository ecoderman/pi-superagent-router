import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyOpen,
  applyUpdate,
  appendMemory,
  countBy,
  formatTaskRow,
  isOpen,
  loadLedger,
  memoryPath,
  readMemory,
  saveLedger,
  tasksPath,
  type UpdatePatch,
} from "./store.ts";
import { buildDigest, ROUTER_RULES } from "./prompt.ts";
import type { Ledger, Task } from "./types.ts";

const TASK_STATUSES = ["queued", "running", "needs-human", "done", "failed", "stopped"] as const;
const REPORT_STATUSES = ["progress", "blocked", "ready", "failed", "dropped"] as const;

const StatusEnum = Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)));
const ReportEnum = Type.Union(REPORT_STATUSES.map((s) => Type.Literal(s)));

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
  query: Type.Optional(Type.String()),
  maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
});
type MemoryReadParams = Static<typeof memoryReadSchema>;

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
  for (const task of ledger.tasks.filter(isOpen)) lines.push(formatTaskRow(task));
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

function memoryView(text: string, query: string | undefined, maxChars: number): {
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

export default function piRouter(pi: ExtensionAPI): void {
  // 关键守卫：Router 只在 pi 主会话生效；子会话运行时设置 PI_SUBAGENT_CHILD=1。
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerTool({
    name: "router_task_open",
    label: "Router: Open Task",
    description:
      "按幂等键开一个 Router 任务并拿到 id。若同 key 的开放任务已存在则直接复用，不重开。开完后下一步应调用 subagent({ agent: \"router-worker\", task, cwd, worktree }) 派发，再用 router_task_update 记录 runId 与 running。",
    promptSnippet: "Router: 为独立目标开/复用一个任务并返回 id",
    parameters: openSchema,
    async execute(_toolCallId, params: OpenParams, _signal, _onUpdate, ctx) {
      const { ledger, warning } = await loadLedger(ctx.cwd);
      const { task, created } = applyOpen(ledger, {
        key: params.key,
        goal: params.goal,
        cwd: params.cwd ?? ctx.cwd,
        worktree: params.worktree,
        model: params.model,
      });
      await saveLedger(ctx.cwd, ledger);
      render(ctx, ledger);

      const text = created
        ? `已开任务 ${task.id} [${task.status}]（key=${task.key}）。下一步：调用 subagent({ agent: "router-worker", task, cwd, worktree }) 派发，再用 router_task_update 写 runId 与 running。`
        : `幂等命中既有任务 ${task.id} [${task.status}]（key=${task.key}）。`;
      const prefix = warning ? `⚠ ${warning}\n` : "";
      return {
        content: [{ type: "text", text: `${prefix}${text}` }],
        details: { id: task.id, key: task.key, status: task.status, created, ledgerPath: tasksPath(ctx.cwd) },
      };
    },
  });

  pi.registerTool({
    name: "router_task_update",
    label: "Router: Update Task",
    description:
      "更新 Router 任务：改状态、记 runId、追加一条报告、替换交付物或写下一步。报告会自动追加时间戳。未知 id 会报错。派发 worker 后用它写 runId 与 running；报告到达后也用它记账。",
    promptSnippet: "Router: 更新任务状态/runId/报告/交付物/下一步",
    parameters: updateSchema,
    async execute(_toolCallId, params: UpdateParams, _signal, _onUpdate, ctx) {
      const { ledger, warning } = await loadLedger(ctx.cwd);
      const patch: UpdatePatch = {
        status: params.status,
        runId: params.runId,
        report: params.report,
        deliverables: params.deliverables,
        next: params.next,
      };
      const task = applyUpdate(ledger, params.id, patch);
      await saveLedger(ctx.cwd, ledger);
      render(ctx, ledger);

      const reportNote = params.report ? `；报告已追加，共 ${task.reports.length} 条` : "";
      const text = `${task.id} [${task.status}]${reportNote}`;
      const prefix = warning ? `⚠ ${warning}\n` : "";
      return {
        content: [{ type: "text", text: `${prefix}${text}` }],
        details: {
          id: task.id,
          status: task.status,
          reports: task.reports.length,
          updatedAt: task.updatedAt,
          ledgerPath: tasksPath(ctx.cwd),
        },
      };
    },
  });

  pi.registerTool({
    name: "router_task_list",
    label: "Router: List Tasks",
    description:
      "列出 Router 任务。无 status 列全部；status=open 列所有未结束任务；也可按 queued/running/needs-human/done/failed/stopped 过滤。交付前用它确认没有遗漏的 open 任务。",
    promptSnippet: "Router: 列出/过滤账本里的任务",
    parameters: listSchema,
    async execute(_toolCallId, params: ListParams, _signal, _onUpdate, ctx) {
      const { ledger, warning } = await loadLedger(ctx.cwd);
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
      const body = tasks.length === 0 ? ["(无匹配任务)"] : tasks.map(formatTaskRow);
      const text = `${stats}\n${body.join("\n")}`;
      const prefix = warning ? `⚠ ${warning}\n` : "";
      return {
        content: [{ type: "text", text: `${prefix}${text}` }],
        details: { tasks, open, running, needsHuman },
      };
    },
  });

  pi.registerTool({
    name: "router_memory_append",
    label: "Router: Append Memory",
    description:
      "把一行决策理由追加到 .pi/router/memory.md（append-only，不重写）。section 用于归类，text 是理由正文。每个重要决定都该记一条。",
    promptSnippet: "Router: 追加一条决策记录到 memory.md",
    parameters: memoryAppendSchema,
    async execute(_toolCallId, params: MemoryAppendParams, _signal, _onUpdate, ctx) {
      await appendMemory(ctx.cwd, params.section, params.text);
      const path = memoryPath(ctx.cwd);
      return {
        content: [{ type: "text", text: `已追加到 ${path}` }],
        details: { path, section: params.section },
      };
    },
  });

  pi.registerTool({
    name: "router_memory_read",
    label: "Router: Read Memory",
    description:
      "读取 .pi/router/memory.md。无 query 返回全文（默认最多 8000 字符，可用 maxChars 调整）；有 query 则大小写不敏感过滤，返回命中行与行号。",
    promptSnippet: "Router: 读取/过滤 memory.md",
    parameters: memoryReadSchema,
    async execute(_toolCallId, params: MemoryReadParams, _signal, _onUpdate, ctx) {
      const text = await readMemory(ctx.cwd);
      const maxChars = params.maxChars ?? 8000;
      const view = memoryView(text, params.query, maxChars);
      return {
        content: [{ type: "text", text: view.lines.join("\n") }],
        details: { path: memoryPath(ctx.cwd), matchedLines: view.matched, truncated: view.truncated },
      };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const { ledger, warning } = await loadLedger(ctx.cwd);
    const digest = buildDigest(ledger.tasks);
    const warn = warning ? `\n\n[router 账本警告] ${warning}` : "";
    return { systemPrompt: `${event.systemPrompt}\n\n${ROUTER_RULES}\n\n${digest}${warn}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    const { ledger } = await loadLedger(ctx.cwd);
    render(ctx, ledger);
  });

  pi.registerCommand("router", {
    description: "router: status | tasks | task <id> | memory [query] | digest",
    handler: async (args, ctx) => {
      const { ledger, warning } = await loadLedger(ctx.cwd);
      const input = (args ?? "").trim();

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
        ctx.ui.setWidget("router", [buildDigest(ledger.tasks)]);
      } else if (input === "memory" || input.startsWith("memory ")) {
        const query = input === "memory" ? undefined : input.slice(7).trim();
        const text = await readMemory(ctx.cwd);
        ctx.ui.setWidget("router", memoryView(text, query, 8000).lines);
      } else {
        ctx.ui.notify("router: 未知子命令，支持 status | tasks | task <id> | memory [query] | digest", "error");
        return;
      }

      render(ctx, ledger);
      if (warning) ctx.ui.notify(`router: ${warning}`, "warning");
    },
  });
}