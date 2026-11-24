import type { Report, Task } from "./types.ts";
import type { DigestOptions } from "./prompt.ts";
import { clampOpenShown, projectOpenTasks, taskRow } from "./prompt.ts";

export type MemoryScope = "global" | "project" | "session" | "audit";

export interface MemoryTarget {
  scope: MemoryScope;
  scopeId?: string;
}

export interface SessionNote {
  at: string;
  text: string;
}

export interface SessionState {
  version: 1;
  sessionId: string;
  project: string;
  focus: string;
  notes: SessionNote[];
  updatedAt: string;
}

export type AuditKind = "note" | "task_open" | "task_update" | "dispatch" | "promote" | "migrate";

export interface AuditLine {
  at: string;
  session: string;
  project: string;
  kind: AuditKind;
  taskId?: string;
  runId?: string;
  reason?: string;
  text?: string;
}

export interface LayerBudget {
  global: number;
  project: number;
  session: number;
  tasks: number;
}

export type AssembledLayerKind = "global" | "project" | "session" | "tasks";

export interface AssembledLayer {
  layer: AssembledLayerKind;
  chars: number;
  truncated: boolean;
}

export interface AssembledContext {
  text: string;
  layers: AssembledLayer[];
}

export interface AssembleMemoryInput {
  global: string;
  project: string;
  projectName: string;
  session: SessionState | undefined;
  tasks: Task[];
  digestOptions: DigestOptions;
  budget?: Partial<LayerBudget>;
}

const MAX_SESSION_NOTES = 50;
const MAX_CHARS = 4096;
const MAX_LINES = 60;
const GLOBAL_TRUNCATED = "…(truncated)";

export const DEFAULT_LAYER_BUDGET: LayerBudget = {
  global: 800,
  project: 1200,
  session: 600,
  tasks: 1400,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "global" || value === "project" || value === "session" || value === "audit";
}

function isAuditKind(value: unknown): value is AuditKind {
  return (
    value === "note" ||
    value === "task_open" ||
    value === "task_update" ||
    value === "dispatch" ||
    value === "promote" ||
    value === "migrate"
  );
}

/** 数据层校验：global/audit 不得带 scopeId；project/session 必须给非空且不含路径逃逸片段的 scopeId。 */
export function validateMemoryTarget(target: MemoryTarget): void {
  if (!isMemoryScope(target.scope)) {
    throw new Error(`memory scope: 未知 scope ${String(target.scope)}`);
  }
  if (target.scope === "global" || target.scope === "audit") {
    if (target.scopeId !== undefined) {
      throw new Error(`memory scope: ${target.scope} 不得带 scopeId`);
    }
    return;
  }
  const id = target.scopeId;
  if (typeof id !== "string" || id === "") {
    throw new Error(`memory scope: ${target.scope} 必须提供非空 scopeId`);
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error("memory scope: scopeId 含非法路径片段");
  }
}

export function emptySession(sessionId: string, project: string): SessionState {
  return {
    version: 1,
    sessionId,
    project,
    focus: "",
    notes: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 宽松解析会话文件：结构非法返回 undefined，不抛。 */
export function parseSessionState(raw: unknown): SessionState | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version !== 1) return undefined;
  if (typeof raw.sessionId !== "string") return undefined;
  if (typeof raw.project !== "string") return undefined;
  if (typeof raw.focus !== "string") return undefined;
  if (typeof raw.updatedAt !== "string") return undefined;
  if (!Array.isArray(raw.notes)) return undefined;

  const notes: SessionNote[] = [];
  for (const entry of raw.notes) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.at !== "string" || typeof entry.text !== "string") return undefined;
    notes.push({ at: entry.at, text: entry.text });
  }

  return {
    version: 1,
    sessionId: raw.sessionId,
    project: raw.project,
    focus: raw.focus,
    notes,
    updatedAt: raw.updatedAt,
  };
}

/** 纯函数：追加 note、可更新 focus，notes 最多 50 条 FIFO。 */
export function appendSessionNote(state: SessionState, text: string, focus?: string): SessionState {
  const now = new Date().toISOString();
  const notes = [...state.notes, { at: now, text }];
  const trimmed = notes.length > MAX_SESSION_NOTES ? notes.slice(notes.length - MAX_SESSION_NOTES) : notes;
  return {
    version: 1,
    sessionId: state.sessionId,
    project: state.project,
    focus: focus !== undefined ? focus : state.focus,
    notes: trimmed,
    updatedAt: now,
  };
}

export function serializeSession(state: SessionState): string {
  return JSON.stringify(state, null, 2);
}

export function formatSessionText(state: SessionState): string {
  const lines = [`focus: ${state.focus || "(none)"}`];
  for (const note of state.notes) lines.push(`- ${note.at} ${note.text}`);
  return lines.join("\n");
}

/** text 截断到 n 字符（超过直接切掉，不做省略号）。 */
export function truncateText(text: string, n = 200): string {
  return text.length <= n ? text : text.slice(0, n);
}

export interface AuditLineInput {
  at: string;
  session: string;
  project: string;
  kind: AuditKind;
  taskId?: string;
  runId?: string;
  reason?: string;
  text?: string;
}

/** 由扩展代码构造审计行；必填 at/session/project/kind，其余可选字段缺省不写。 */
export function makeAuditLine(input: AuditLineInput): AuditLine {
  const line: AuditLine = {
    at: input.at,
    session: input.session,
    project: input.project,
    kind: input.kind,
  };
  if (input.taskId !== undefined) line.taskId = input.taskId;
  if (input.runId !== undefined) line.runId = input.runId;
  if (input.reason !== undefined) line.reason = input.reason;
  if (input.text !== undefined) line.text = input.text;
  return line;
}

export function formatAuditLine(line: AuditLine): string {
  const record: Record<string, unknown> = {
    at: line.at,
    session: line.session,
    project: line.project,
    kind: line.kind,
  };
  if (line.taskId !== undefined) record.taskId = line.taskId;
  if (line.runId !== undefined) record.runId = line.runId;
  if (line.reason !== undefined) record.reason = line.reason;
  if (line.text !== undefined) record.text = truncateText(line.text);
  return JSON.stringify(record);
}

/** 宽松解析单行审计：字段缺失/类型错返回 undefined，不抛。 */
export function parseAuditLine(raw: unknown): AuditLine | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.at !== "string") return undefined;
  if (typeof raw.session !== "string") return undefined;
  if (typeof raw.project !== "string") return undefined;
  if (!isAuditKind(raw.kind)) return undefined;

  const line: AuditLine = { at: raw.at, session: raw.session, project: raw.project, kind: raw.kind };
  if (typeof raw.taskId === "string") line.taskId = raw.taskId;
  if (typeof raw.runId === "string") line.runId = raw.runId;
  if (typeof raw.reason === "string") line.reason = raw.reason;
  if (typeof raw.text === "string") line.text = raw.text;
  return line;
}

export interface MemoryBlockParse {
  global: string[];
  projects: Record<string, string[]>;
}

/**
 * 解析 v2 memory.md：`## <ISO> [<project>] <section>` 与 `## <ISO> <section>` 两种块头。
 * 块文本按原顺序保留；异常由调用方处理。
 */
export function parseMemoryBlocks(text: string): MemoryBlockParse {
  const result: MemoryBlockParse = { global: [], projects: {} };
  const lines = text.split(/\r?\n/);
  let current: { kind: "global" | "project"; project?: string; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current || current.lines.length === 0) return;
    const block = current.lines.join("\n");
    if (current.kind === "global") result.global.push(block);
    else if (current.project !== undefined) (result.projects[current.project] ??= []).push(block);
    current = undefined;
  };

  for (const line of lines) {
    const withProject = /^##\s+(\S+)\s+\[([^\]]+)\]\s+(\S.*)$/.exec(line);
    if (withProject) {
      flush();
      current = { kind: "project", project: withProject[2], lines: [line] };
      continue;
    }
    const plain = /^##\s+(\S+)\s+(\S.*)$/.exec(line);
    if (plain) {
      flush();
      current = { kind: "global", lines: [line] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else if (line.trim() !== "") {
      throw new Error("memory.md 含无法识别的非块文本");
    }
  }
  flush();
  return result;
}

interface RenderedLayer {
  key: AssembledLayerKind;
  title: string;
  display: string;
  chars: number;
  truncated: boolean;
}

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function resolveBudget(partial?: Partial<LayerBudget>): LayerBudget {
  return {
    global: clampBudget(partial?.global ?? DEFAULT_LAYER_BUDGET.global),
    project: clampBudget(partial?.project ?? DEFAULT_LAYER_BUDGET.project),
    session: clampBudget(partial?.session ?? DEFAULT_LAYER_BUDGET.session),
    tasks: clampBudget(partial?.tasks ?? DEFAULT_LAYER_BUDGET.tasks),
  };
}

function sessionBody(session: SessionState | undefined): string {
  return session === undefined ? "" : formatSessionText(session);
}

function tasksBody(input: AssembleMemoryInput): string {
  const open = projectOpenTasks(input.tasks, input.digestOptions);
  const limit = clampOpenShown(input.digestOptions.maxOpenShown);
  return open
    .slice(0, limit)
    .map((task) => `${taskRow(task)} · read: task/${task.id}`)
    .join("\n");
}

function renderLayer(key: AssembledLayerKind, title: string, source: string, budget: number): RenderedLayer {
  if (source === "") return { key, title, display: "(empty)", chars: 0, truncated: false };
  if (source.length > budget) {
    const kept = source.slice(0, budget);
    const dropped = source.length - budget;
    return {
      key,
      title,
      display: `${kept}…(truncated ${dropped} chars)`,
      chars: budget,
      truncated: true,
    };
  }
  return { key, title, display: source, chars: source.length, truncated: false };
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

function trimTo(text: string, maxChars: number, maxLines: number): string {
  let lines = text.split("\n");
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  let result = lines.join("\n");
  if (result.length > maxChars) result = result.slice(0, maxChars);
  return result;
}

interface CappedBody {
  body: string;
  droppedCount: number;
  charTrimmed: boolean;
}

function capBody(blocks: string[], maxChars: number, maxLines: number): CappedBody {
  const marker = GLOBAL_TRUNCATED;
  const fits = (body: string, chars: number, lines: number): boolean =>
    body.length <= chars && lineCount(body) <= lines;

  const full = blocks.join("\n\n");
  if (fits(full, maxChars, maxLines)) {
    return { body: full, droppedCount: 0, charTrimmed: false };
  }

  const availChars = Math.max(0, maxChars - marker.length - 1);
  const availLines = Math.max(1, maxLines - 1);
  let kept = blocks.length;
  while (kept > 1 && !fits(blocks.slice(0, kept).join("\n\n"), availChars, availLines)) {
    kept -= 1;
  }

  let body = blocks.slice(0, kept).join("\n\n");
  let charTrimmed = false;
  if (!fits(body, availChars, availLines)) {
    body = trimTo(body, availChars, availLines);
    charTrimmed = true;
  }
  return { body: `${body}\n${marker}`, droppedCount: blocks.length - kept, charTrimmed };
}

function manifestText(layers: readonly RenderedLayer[], budget: LayerBudget): string {
  return (
    `budget: global ${layers[0].chars}/${budget.global} · ` +
    `project ${layers[1].chars}/${budget.project} · ` +
    `session ${layers[2].chars}/${budget.session} · ` +
    `tasks ${layers[3].chars}/${budget.tasks}`
  );
}

/**
 * 纯函数：把四层记忆组装成 prompt 文本。
 * 顺序固定 `## global → ## project <name> → ## session → ## open tasks`，每层独立预算，
 * 总量封顶 4096 字符 / 60 行，末尾恒有 manifest 行。
 */
export function assembleMemory(input: AssembleMemoryInput): AssembledContext {
  const budget = resolveBudget(input.budget);
  const layers: RenderedLayer[] = [
    renderLayer("global", "## global", input.global, budget.global),
    renderLayer("project", `## project ${input.projectName}`, input.project, budget.project),
    renderLayer("session", "## session", sessionBody(input.session), budget.session),
    renderLayer("tasks", "## open tasks", tasksBody(input), budget.tasks),
  ];

  const blocks = layers.map((layer) => `${layer.title}\n${layer.display}`);

  // 先按封顶前的 manifest 长度给正文留预算；重算后的 manifest 分子只会缩短，不会让总量超 4096。
  const manifestBudget = manifestText(layers, budget);
  const maxBodyChars = Math.max(0, MAX_CHARS - manifestBudget.length - 1);
  const maxBodyLines = MAX_LINES - 1;
  const capped = capBody(blocks, maxBodyChars, maxBodyLines);

  for (let i = layers.length - capped.droppedCount; i < layers.length; i += 1) {
    layers[i].chars = 0;
    layers[i].truncated = true;
  }
  if (capped.charTrimmed) {
    // capBody 从末层向前 trim，char 截断只会发生在最后保留的一层。
    const index = layers.length - capped.droppedCount - 1;
    const last = layers[index];
    if (last) {
      const markerLength = GLOBAL_TRUNCATED.length;
      const body = capped.body.slice(0, Math.max(0, capped.body.length - markerLength - 1));
      const prefixLength = blocks.slice(0, index).reduce((sum, block) => sum + block.length + 2, 0);
      const retainedBlockChars = Math.max(0, body.length - prefixLength);
      const retainedContent = Math.max(0, retainedBlockChars - (last.title.length + 1));
      // 层内已截断时 chars 是预算上限；全局封顶只能进一步减少实际保留的源字符数。
      last.chars = last.truncated ? Math.min(last.chars, retainedContent) : retainedContent;
      last.truncated = true;
    }
  }

  const manifest = manifestText(layers, budget);
  return {
    text: `${capped.body}\n${manifest}`,
    layers: layers.map((layer) => ({
      layer: layer.key,
      chars: layer.chars,
      truncated: layer.truncated,
    })),
  };
}

/** router_task_get 的 reports 参数夹取到 0..20（默认 5）。 */
export function clampReports(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5;
  const integer = Math.trunc(value);
  return Math.min(20, Math.max(0, integer));
}

/** router_task_get 最近 N 条报告；count=0 返回空数组，不能用 slice(-0) 退回全部。 */
export function latestReports(reports: readonly Report[], count: number): Report[] {
  if (count <= 0) return [];
  return reports.slice(-count);
}

/**
 * 审计视图：给每行加 `[n]` 前缀，n 与 `/router promote <n>` 一致（1 = 最新一行）。
 * 便于用户直接把编号抄进 promote，不用人工数行。
 */
export function formatAuditView(lines: readonly AuditLine[]): string {
  if (lines.length === 0) return "";
  return lines.map((line, index) => `[${lines.length - index}] ${formatAuditLine(line)}`).join("\n");
}
