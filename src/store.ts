import { appendFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { Ledger, Report, ReportStatus, Task, TaskStatus } from "./types.ts";

const TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "needs-human", "done", "failed", "stopped"];
const REPORT_STATUSES: readonly ReportStatus[] = ["progress", "blocked", "ready", "failed", "dropped"];
const TERMINAL: readonly TaskStatus[] = ["done", "failed", "stopped"];

const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const DEFAULT_LOCK_STALE_MS = 10_000;
/** goal 少于这个长度时不用来做派发文本匹配，避免短词误命中。 */
const MIN_GOAL_FOR_MATCH = 8;
const BACKOFF_START_MS = 25;
const BACKOFF_MAX_MS = 200;

/** 全局账本根的默认位置：<home>/.pi/agent/router */
export function defaultHome(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".pi", "agent", "router");
}

/** v1 的项目级账本目录；scope=project 时它就是 home，也是旧账本的导入来源。 */
export function projectRouterDir(cwd: string): string {
  return join(cwd, ".pi", "router");
}

export function tasksPath(home: string): string {
  return join(home, "tasks.json");
}

export function memoryPath(home: string): string {
  return join(home, "memory.md");
}

export function lockPath(home: string): string {
  return join(home, "tasks.lock");
}

export function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const name = basename(trimmed);
  return name === "" ? path : name;
}

/** 同一物理项目不同层级/大小写路径应得到同一个 project 名；realpath 失败时用 cwd 原值（BRIEF-v2 ①）。 */
export async function projectName(cwd: string): Promise<string> {
  try {
    return basenameOf(await realpath(cwd));
  } catch {
    return cwd;
  }
}

export function sameProject(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function emptyLedger(): Ledger {
  return { version: 2, seq: 0, tasks: [] };
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

/**
 * strict: 当前账本（version 2）要求 project / ownerSession 必填。
 * legacy: v1 任务允许这两个字段缺失，由 migrateTaskV1 补齐；缺失先落成空串。
 */
function parseTask(raw: unknown, index: number, mode: "strict" | "legacy"): Task {
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

  const project = mode === "strict" ? requireString(raw, "project", where) : (optionalString(raw, "project", where) ?? "");
  const ownerSession =
    mode === "strict" ? requireString(raw, "ownerSession", where) : (optionalString(raw, "ownerSession", where) ?? "");

  const task: Task = {
    id,
    key,
    goal,
    project,
    cwd,
    ownerSession,
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

function parseSeq(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new TypeError("ledger: seq must be a non-negative integer");
  }
  return raw;
}

export function parseLedger(raw: unknown): Ledger {
  if (!isRecord(raw)) throw new TypeError("ledger: expected an object");
  if (raw.version !== 2) throw new TypeError("ledger: unsupported version");
  const seq = parseSeq(raw.seq);
  if (!Array.isArray(raw.tasks)) throw new TypeError("ledger: tasks must be an array");
  const tasks = raw.tasks.map((t, i) => parseTask(t, i, "strict"));
  return { version: 2, seq, tasks };
}

/** 宽松解析旧账本（version 1 或 2）；结构非法返回 undefined，不抛。 */
export function parseLegacyLedger(raw: unknown): { seq: number; tasks: Task[] } | undefined {
  try {
    if (!isRecord(raw)) return undefined;
    if (raw.version !== 1 && raw.version !== 2) return undefined;
    const seq = parseSeq(raw.seq);
    if (!Array.isArray(raw.tasks)) return undefined;
    const tasks = raw.tasks.map((t, i) => parseTask(t, i, "legacy"));
    return { seq, tasks };
  } catch {
    return undefined;
  }
}

export function migrateTaskV1(raw: Task, project: string): Task {
  const migrated: Task = { ...raw };
  if (!migrated.project) {
    // BRIEF-v2 ①：v1 任务补 `project = basename(任务自己的 cwd)`。v1 的 cwd 可指向别的目录，
    // 所以不能用创建会话的项目顶替；只有任务 cwd 为空时才用传入 project 兜底。
    migrated.project = migrated.cwd.trim() === "" ? project : basenameOf(migrated.cwd);
  }
  if (!migrated.ownerSession) migrated.ownerSession = "migrated";
  return migrated;
}

export interface ImportResult {
  ledger: Ledger;
  imported: number;
  idMap: Record<string, string>;
}

function highestIdSeq(tasks: Task[]): number {
  let highest = 0;
  for (const task of tasks) {
    const match = /^t(\d+)$/.exec(task.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * 把旧账本任务合并进全局账本。
 * - 去重键 (key, createdAt)：崩溃后重试不会重复导入
 * - id 冲突时从 seq 重新分配，无冲突则逐字保留原 id
 */
export function importLegacyTasks(target: Ledger, legacy: { seq: number; tasks: Task[] }, project: string): ImportResult {
  const idMap: Record<string, string> = {};
  let imported = 0;

  for (const raw of legacy.tasks) {
    const task = migrateTaskV1(raw, project);
    const alreadyThere = target.tasks.some((t) => t.key === task.key && t.createdAt === task.createdAt);
    if (alreadyThere) continue;

    if (target.tasks.some((t) => t.id === task.id)) {
      target.seq += 1;
      const newId = `t${target.seq}`;
      idMap[task.id] = newId;
      task.id = newId;
    }
    target.tasks.push(task);
    imported += 1;
  }

  target.seq = Math.max(target.seq, legacy.seq, highestIdSeq(target.tasks));
  return { ledger: target, imported, idMap };
}

interface ReadLedgerResult {
  ledger: Ledger;
  warning?: string;
}

function joinWarnings(warnings: string[]): string | undefined {
  return warnings.length > 0 ? warnings.join("；") : undefined;
}

function backupName(home: string): string {
  return join(home, `tasks.json.bak-${Date.now()}`);
}

type LedgerReadMode = "read" | "locked";

/**
 * 读账本文件（不取锁）。
 * - 不存在 → 空账本
 * - version 1 → 内存升级为 v2（project/ownerSession 用 projectFallback 补），不落盘
 * - 损坏 → 只报告；备份（rename）只在锁内写路径做，见 corruptLedger
 */
async function readLedgerFile(home: string, projectFallback: string, mode: LedgerReadMode): Promise<ReadLedgerResult> {
  let text: string;
  try {
    text = await readFile(tasksPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ledger: emptyLedger() };
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return corruptLedger(home, mode);
  }

  try {
    return { ledger: parseLedger(raw) };
  } catch {
    const legacy = parseLegacyLedger(raw);
    if (legacy) {
      const upgraded = emptyLedger();
      for (const task of legacy.tasks) upgraded.tasks.push(migrateTaskV1(task, projectFallback));
      upgraded.seq = Math.max(legacy.seq, highestIdSeq(upgraded.tasks));
      return { ledger: upgraded };
    }
    return corruptLedger(home, mode);
  }
}

/**
 * 账本损坏时的处理。
 * - 读模式（BRIEF-v2 ②「读路径不取锁」）只返回 warning，绝不改盘：无锁 rename 可能把别的进程
 *   刚原子写入的好文件当成损坏文件抢走（锁协议漏洞）。
 * - 锁模式（migrateLocked 已持锁）才真正备份为 tasks.json.bak-<ts>。
 */
async function corruptLedger(home: string, mode: LedgerReadMode): Promise<ReadLedgerResult> {
  if (mode === "read") {
    return {
      ledger: emptyLedger(),
      warning: `账本损坏（${tasksPath(home)}）；只读路径不改动文件，下次写入时备份并重置`,
    };
  }

  const bak = backupName(home);
  try {
    await mkdir(home, { recursive: true });
    await rename(tasksPath(home), bak);
    return { ledger: emptyLedger(), warning: `账本损坏，已备份到 ${bak}，以空账本继续` };
  } catch (error) {
    return {
      ledger: emptyLedger(),
      warning: `账本损坏，备份失败（${(error as Error).message}），以空账本继续`,
    };
  }
}

export interface ReadLedgerOptions {
  legacy?: { dir: string; project: string };
}

/**
 * 只读路径（digest / list / 命令 / 只读工具）：不取锁，接受最终一致。
 * 旧账本只在此做内存导入，落盘 + 改名留给 withLedger 的锁内迁移（C3）。
 */
export async function loadLedger(home: string, options?: ReadLedgerOptions): Promise<{ ledger: Ledger; warning?: string }> {
  const legacy = options?.legacy;
  const { ledger, warning } = await readLedgerFile(home, legacy?.project ?? "unknown", "read");
  const warnings: string[] = warning ? [warning] : [];

  if (legacy && tasksPath(legacy.dir) !== tasksPath(home)) {
    const old = await readLegacyFile(legacy.dir);
    if (old) {
      importLegacyTasks(ledger, old, legacy.project);
      // id 冲突的重编号只在锁内落盘时才最终确定，读路径的内存预览可能与之不同（见 migrateLocked）。
      warnings.push("旧账本待迁移（首次写操作时完成；其中的任务 id 以首次写入落盘结果为准）");
    }
  }

  return { ledger, warning: joinWarnings(warnings) };
}

async function readLegacyFile(dir: string): Promise<{ seq: number; tasks: Task[] } | undefined> {
  let text: string;
  try {
    text = await readFile(tasksPath(dir), "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseLegacyLedger(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

async function saveLedgerWithRetry(target: string, payload: string, tmp: string): Promise<void> {
  const delays = [20, 40, 80];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
      await writeFile(tmp, payload, "utf8");
    }
  }
}

/** 低层原子写（temp + rename）。调用者必须已持锁（测试除外）。 */
export async function saveLedger(home: string, ledger: Ledger): Promise<void> {
  await mkdir(home, { recursive: true });
  const target = tasksPath(home);
  const tmp = join(home, `.tasks.json.${process.pid}.${randomUUID()}.tmp`);
  const payload = JSON.stringify(ledger, null, 2);
  try {
    await writeFile(tmp, payload, "utf8");
    await saveLedgerWithRetry(target, payload, tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

export interface LedgerOptions extends LockOptions {
  legacy?: { dir: string; project: string };
}

export interface LedgerTxn<T> {
  ledger: Ledger;
  result: T;
  warning?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function acquireLock(home: string, options?: LockOptions): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
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
        await handle.close(); // Windows：句柄必须立刻关掉，否则别人无法 unlink
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const contended = code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!contended) throw error;

      if (!tookOver && (await isStale(path, staleMs))) {
        tookOver = true; // 每个调用者最多接管一次，避免活锁
        try {
          await rm(path, { force: true });
        } catch {
          // 别人已释放
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`router: 账本锁超时（${timeoutMs}ms，${path}）`);
      }
      await sleep(Math.min(delay, BACKOFF_MAX_MS) + Math.floor(Math.random() * 11));
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }
}

export async function withLock<T>(home: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  await acquireLock(home, options);
  try {
    return await fn();
  } finally {
    try {
      await rm(lockPath(home), { force: true });
    } catch {
      // 释放失败忽略
    }
  }
}

/**
 * 锁内迁移（§4.1 顺序：读全局 → 解析旧版本 → 去重合并 → 落盘 → 旧文件改名）。
 * scope=project 时 legacy.dir === home，整体跳过。
 */
async function migrateLocked(home: string, options?: LedgerOptions): Promise<ReadLedgerResult> {
  const legacy = options?.legacy;
  const { ledger, warning } = await readLedgerFile(home, legacy?.project ?? "unknown", "locked");
  const warnings: string[] = warning ? [warning] : [];

  if (!legacy || tasksPath(legacy.dir) === tasksPath(home)) {
    return { ledger, warning: joinWarnings(warnings) };
  }

  const oldPath = tasksPath(legacy.dir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(oldPath, "utf8")) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ledger, warning: joinWarnings(warnings) };
    warnings.push(`旧账本无法读取（${(error as Error).message}），已跳过迁移`);
    return { ledger, warning: joinWarnings(warnings) };
  }

  const parsed = parseLegacyLedger(raw);
  if (!parsed) {
    const broken = `${oldPath}.legacy-broken-${Date.now()}`;
    try {
      await rename(oldPath, broken);
      warnings.push(`旧账本损坏，已改名到 ${broken} 并跳过迁移`);
    } catch {
      warnings.push("旧账本损坏，改名失败，已跳过迁移");
    }
    return { ledger, warning: joinWarnings(warnings) };
  }

  const { imported, idMap } = importLegacyTasks(ledger, parsed, legacy.project);
  await saveLedger(home, ledger); // 先落盘，崩溃后重试靠 (key, createdAt) 去重保持幂等

  try {
    await rename(oldPath, `${oldPath}.migrated-${Date.now()}`);
  } catch (error) {
    warnings.push(`旧账本改名失败（${(error as Error).message}），下次写入会重试`);
  }

  if (imported > 0) warnings.push(`已从旧账本导入 ${imported} 个任务`);
  const renamed = Object.entries(idMap);
  if (renamed.length > 0) {
    // id 与全局账本冲突时会被重编号；映射必须显式告知，否则模型仍按旧 id 更新，会命中别的任务。
    warnings.push(`旧账本任务 id 冲突，已重编号：${renamed.map(([from, to]) => `${from}→${to}`).join("、")}`);
  }
  return { ledger, warning: joinWarnings(warnings) };
}

export async function withLedger<T>(
  home: string,
  fn: (ledger: Ledger) => T | Promise<T>,
  options?: LedgerOptions,
): Promise<LedgerTxn<T>> {
  return withLock(
    home,
    async () => {
      const { ledger, warning } = await migrateLocked(home, options);
      const result = await fn(ledger);
      await saveLedger(home, ledger);
      return { ledger, result, warning };
    },
    options,
  );
}

export function formatMemoryBlock(project: string, section: string, text: string, at?: string): string {
  return `\n## ${at ?? new Date().toISOString()} [${project}] ${section}\n${text}\n`;
}

export async function appendMemoryUnlocked(
  home: string,
  project: string,
  section: string,
  text: string,
): Promise<void> {
  await mkdir(home, { recursive: true });
  await appendFile(memoryPath(home), formatMemoryBlock(project, section, text), "utf8");
}

export async function appendMemoryLocked(
  home: string,
  project: string,
  section: string,
  text: string,
  options?: LockOptions,
): Promise<void> {
  await withLock(home, () => appendMemoryUnlocked(home, project, section, text), options);
}

export async function readMemory(home: string): Promise<string> {
  try {
    return await readFile(memoryPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

const MEMORY_HEADER = /^##\s+\S+\s+\[([^\]]+)\]/;

/** 只保留 `[<project>]`（大小写不敏感）匹配的块；无标记的旧块不匹配。 */
export function filterMemoryByProject(text: string, project: string): string {
  if (text === "") return "";
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines) {
    const header = MEMORY_HEADER.exec(line);
    if (header) {
      keeping = sameProject(header[1], project);
      if (keeping) kept.push(line);
      continue;
    }
    if (line.startsWith("## ")) {
      keeping = false;
      continue;
    }
    if (keeping) kept.push(line);
  }
  return kept.join("\n");
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

/**
 * key 的幂等范围是「项目」（v1 每项目一份账本时的语义）。全局账本下必须带 project，
 * 否则 A 项目的 open 任务会让 B 项目同名 key 误命中（project/goal/runId 全串到别的项目）。
 * project 省略时保留旧的全局查找，仅供内部与测试使用。
 */
export function findOpen(ledger: Ledger, key: string, project?: string): Task | undefined {
  return ledger.tasks.find(
    (t) => t.key === key && isOpen(t) && (project === undefined || sameProject(t.project, project)),
  );
}

export function nextId(ledger: Ledger): string {
  return `t${ledger.seq + 1}`;
}

export interface OpenInput {
  key: string;
  goal: string;
  project: string;
  ownerSession: string;
  cwd: string;
  worktree?: boolean;
  model?: string;
}

export function applyOpen(ledger: Ledger, input: OpenInput): { task: Task; created: boolean } {
  const existing = findOpen(ledger, input.key, input.project);
  if (existing) return { task: existing, created: false };

  const id = nextId(ledger);
  ledger.seq += 1;
  const now = new Date().toISOString();
  const task: Task = {
    id,
    key: input.key,
    goal: input.goal,
    project: input.project,
    cwd: input.cwd,
    ownerSession: input.ownerSession,
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

/**
 * tool_result 自动记 runId：仅当账本里恰好一个「queued 且无 runId」的候选时写入。
 * 0 或 >1 个候选一律不猜。
 */
/**
 * 把 `subagent` 返回的 runId 绑定到最可能对应的任务。
 *
 * 规则（v2.1）：
 * 1. 候选 = `queued` 且无 `runId` 的任务；没有候选则不绑定。
 * 2. 唯一候选 → 直接绑定（`single`）。
 * 3. 多个候选时，优先用派发文本匹配 `goal`（忽略大小写与空白；`goal` 少于 8 字符不参与以免误匹配），
 *    命中唯一则用 `goal`，命中多个取其中最新创建者。
 * 4. 仍无法区分 → 取最新创建的候选（`newest`），并把规则告知调用方以便提示模型。
 */
export type RunIdRule = "single" | "goal" | "newest";

export interface RunIdBinding {
  task: Task;
  rule: RunIdRule;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function newestFirst(a: Task, b: Task): number {
  const at = b.createdAt.localeCompare(a.createdAt);
  if (at !== 0) return at;
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

export function bindRunId(ledger: Ledger, runId: string, taskText?: string): RunIdBinding | undefined {
  const candidates = ledger.tasks.filter((t) => t.status === "queued" && t.runId === undefined);
  if (candidates.length === 0) return undefined;

  let picked: Task | undefined;
  let rule: RunIdRule = "single";

  if (candidates.length === 1) {
    picked = candidates[0];
  } else {
    const haystack = taskText === undefined ? "" : normalizeForMatch(taskText);
    const matched =
      haystack === ""
        ? []
        : candidates.filter((t) => {
            const goal = normalizeForMatch(t.goal);
            return goal.length >= MIN_GOAL_FOR_MATCH && haystack.includes(goal);
          });
    if (matched.length > 0) {
      picked = [...matched].sort(newestFirst)[0];
      rule = "goal";
    } else {
      picked = [...candidates].sort(newestFirst)[0];
      rule = "newest";
    }
  }

  picked.runId = runId;
  picked.status = "running";
  picked.updatedAt = new Date().toISOString();
  return { task: picked, rule };
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