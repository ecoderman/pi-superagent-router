import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Ledger, Report, ReportStatus, Task, TaskStatus } from "./types.ts";

export const ROUTER_DIR = ".pi/router";

const TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "needs-human", "done", "failed", "stopped"];
const REPORT_STATUSES: readonly ReportStatus[] = ["progress", "blocked", "ready", "failed", "dropped"];
const TERMINAL: readonly TaskStatus[] = ["done", "failed", "stopped"];

export function routerDir(cwd: string): string {
  return join(cwd, ROUTER_DIR);
}

export function tasksPath(cwd: string): string {
  return join(routerDir(cwd), "tasks.json");
}

export function memoryPath(cwd: string): string {
  return join(routerDir(cwd), "memory.md");
}

export function emptyLedger(): Ledger {
  return { version: 1, seq: 0, tasks: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`${where}: ${key} must be a string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${where}: ${key} must be a string when present`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, where: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${where}: ${key} must be a boolean when present`);
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string, where: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new TypeError(`${where}: ${key} must be an array of strings when present`);
  }
  return value as string[];
}

function parseReport(raw: unknown, where: string): Report {
  if (!isRecord(raw)) throw new TypeError(`${where}: report must be an object`);
  const at = requireString(raw, "at", where);
  const status = raw.status;
  if (!isReportStatus(status)) throw new TypeError(`${where}: report.status is not a valid ReportStatus`);
  const summary = requireString(raw, "summary", where);
  const report: Report = { at, status, summary };
  const question = optionalString(raw, "question", where);
  if (question !== undefined) report.question = question;
  return report;
}

function parseTask(raw: unknown, index: number): Task {
  const where = `ledger.tasks[${index}]`;
  if (!isRecord(raw)) throw new TypeError(`${where}: task must be an object`);
  const id = requireString(raw, "id", where);
  const key = requireString(raw, "key", where);
  const goal = requireString(raw, "goal", where);
  const cwd = requireString(raw, "cwd", where);
  const status = raw.status;
  if (!isTaskStatus(status)) throw new TypeError(`${where}: status is not a valid TaskStatus`);
  const createdAt = requireString(raw, "createdAt", where);
  const updatedAt = requireString(raw, "updatedAt", where);

  const reportsRaw = raw.reports;
  if (!Array.isArray(reportsRaw)) throw new TypeError(`${where}: reports must be an array`);
  const reports = reportsRaw.map((r, i) => parseReport(r, `${where}.reports[${i}]`));

  const task: Task = {
    id,
    key,
    goal,
    cwd,
    status,
    reports,
    createdAt,
    updatedAt,
  };

  const runId = optionalString(raw, "runId", where);
  if (runId !== undefined) task.runId = runId;
  const model = optionalString(raw, "model", where);
  if (model !== undefined) task.model = model;
  const worktree = optionalBoolean(raw, "worktree", where);
  if (worktree !== undefined) task.worktree = worktree;
  const deliverables = optionalStringArray(raw, "deliverables", where);
  if (deliverables !== undefined) task.deliverables = deliverables;
  const next = optionalString(raw, "next", where);
  if (next !== undefined) task.next = next;

  return task;
}

export function parseLedger(raw: unknown): Ledger {
  if (!isRecord(raw)) throw new TypeError("ledger: expected an object");
  if (raw.version !== 1) throw new TypeError("ledger: unsupported version");
  if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 0) {
    throw new TypeError("ledger: seq must be a non-negative integer");
  }
  if (!Array.isArray(raw.tasks)) throw new TypeError("ledger: tasks must be an array");
  const tasks = raw.tasks.map((t, i) => parseTask(t, i));
  return { version: 1, seq: raw.seq, tasks };
}

export async function loadLedger(cwd: string): Promise<{ ledger: Ledger; warning?: string }> {
  let text: string;
  try {
    text = await readFile(tasksPath(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ledger: emptyLedger() };
    throw error;
  }

  try {
    return { ledger: parseLedger(JSON.parse(text) as unknown) };
  } catch {
    const bak = join(routerDir(cwd), `tasks.json.bak-${Date.now()}`);
    try {
      await mkdir(routerDir(cwd), { recursive: true });
      await rename(tasksPath(cwd), bak);
    } catch {
      // 备份失败不阻断：仍以空账本继续。
    }
    return {
      ledger: emptyLedger(),
      warning: `账本损坏，已备份到 ${bak}，以空账本继续`,
    };
  }
}

export async function saveLedger(cwd: string, ledger: Ledger): Promise<void> {
  const dir = routerDir(cwd);
  await mkdir(dir, { recursive: true });
  const target = tasksPath(cwd);
  const tmp = join(dir, `.tasks.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function appendMemory(cwd: string, section: string, text: string): Promise<void> {
  const dir = routerDir(cwd);
  await mkdir(dir, { recursive: true });
  const block = `\n## ${new Date().toISOString()} ${section}\n${text}\n`;
  await appendFile(memoryPath(cwd), block, "utf8");
}

export async function readMemory(cwd: string): Promise<string> {
  try {
    return await readFile(memoryPath(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function isOpen(task: Task): boolean {
  return !(TERMINAL as readonly string[]).includes(task.status);
}

export function lastReport(task: Task): Report | undefined {
  return task.reports.length > 0 ? task.reports[task.reports.length - 1] : undefined;
}

export function clip(s: string, n: number): string {
  const budget = n < 1 ? 1 : n;
  if (s.length > budget) return `${s.slice(0, budget - 1)}…`;
  return s;
}

export function formatTaskRow(task: Task): string {
  const last = lastReport(task);
  const lastS = last ? `${last.status} ${clip(last.summary, 40)}` : "-";
  const nextS = task.next && task.next.length > 0 ? clip(task.next, 40) : "-";
  return `${task.id} [${task.status}] ${task.key} run:${task.runId ?? "-"} · last: ${lastS} · next: ${nextS}`;
}

export function countBy(tasks: Task[], status: TaskStatus): number {
  return tasks.filter((t) => t.status === status).length;
}

export function findOpen(ledger: Ledger, key: string): Task | undefined {
  return ledger.tasks.find((t) => t.key === key && isOpen(t));
}

export function nextId(ledger: Ledger): string {
  return `t${ledger.seq + 1}`;
}

export interface OpenInput {
  key: string;
  goal: string;
  cwd: string;
  worktree?: boolean;
  model?: string;
}

export function applyOpen(ledger: Ledger, input: OpenInput): { task: Task; created: boolean } {
  const existing = findOpen(ledger, input.key);
  if (existing) return { task: existing, created: false };

  const id = nextId(ledger);
  ledger.seq += 1;
  const now = new Date().toISOString();
  const task: Task = {
    id,
    key: input.key,
    goal: input.goal,
    cwd: input.cwd,
    status: "queued",
    reports: [],
    createdAt: now,
    updatedAt: now,
  };
  if (input.worktree !== undefined) task.worktree = input.worktree;
  if (input.model !== undefined) task.model = input.model;
  ledger.tasks.push(task);
  return { task, created: true };
}

export interface ReportInput {
  status: ReportStatus;
  summary: string;
  question?: string;
}

export interface UpdatePatch {
  status?: TaskStatus;
  runId?: string;
  report?: ReportInput;
  deliverables?: string[];
  next?: string;
}

export function applyUpdate(ledger: Ledger, id: string, patch: UpdatePatch): Task {
  const task = ledger.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);

  if (patch.report) {
    const report: Report = {
      at: new Date().toISOString(),
      status: patch.report.status,
      summary: patch.report.summary,
    };
    if (patch.report.question !== undefined) report.question = patch.report.question;
    task.reports.push(report);
  }
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.runId !== undefined) task.runId = patch.runId;
  if (patch.deliverables !== undefined) task.deliverables = patch.deliverables;
  if (patch.next !== undefined) task.next = patch.next;
  task.updatedAt = new Date().toISOString();
  return task;
}