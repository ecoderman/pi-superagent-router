import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Task } from "./types.ts";
import { clip, isOpen, lastReport } from "./store.ts";

export interface RunStatusInfo {
  state?: string;
  sessionPath?: string;
  cwd?: string;
}

export interface RunDirDeps {
  env: NodeJS.ProcessEnv;
  tmpDir: string;
  getuid?: () => number | undefined;
  username?: () => string | undefined;
  homedir?: () => string | undefined;
}

const SCOPE_INVALID = /[^A-Za-z0-9._-]+/g;

/** pi-subagents 的清洗规则：非法段字符换 `-`，去掉首尾 `-`，空则 `unknown`。 */
function sanitizeScopeSegment(value: string): string {
  const sanitized = value.trim().replace(SCOPE_INVALID, "-").replace(/^-+|-+$/g, "");
  return sanitized === "" ? "unknown" : sanitized;
}

function callOrUndefined(fn: (() => string | undefined) | undefined): string | undefined {
  if (!fn) return undefined;
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * 与 pi-subagents `resolveTempScopeId` 同规则（src/shared/types.js:60-95）：
 * 有 getuid → uid-<N>；否则 USERNAME / USER / LOGNAME → os.userInfo → USERPROFILE / HOME → homedir → shared。
 * 只有让 scope 与 pi-subagents 一致，才能看到它真实的运行目录（见 docs/FIXES-v2-1.md Finding 6）。
 */
export function tempScopeId(deps: RunDirDeps): string {
  const uid = deps.getuid?.();
  if (typeof uid === "number") return `uid-${uid}`;

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = deps.env[key];
    if (value) return `user-${sanitizeScopeSegment(value)}`;
  }
  const username = callOrUndefined(deps.username);
  if (username) return `user-${sanitizeScopeSegment(username)}`;

  const home = deps.env.USERPROFILE ?? deps.env.HOME;
  if (home) return `home-${sanitizeScopeSegment(home)}`;
  const fallbackHome = callOrUndefined(deps.homedir);
  if (fallbackHome) return `home-${sanitizeScopeSegment(fallbackHome)}`;
  return "shared";
}

/**
 * 运行目录候选（BRIEF-v2 ④ + 实现在地补充，见 docs/FIXES-v2-1.md Finding 6）：
 * 1) PI_SUBAGENTS_RUN_DIR（显式覆盖；它本身或其 async-subagent-runs 子目录）
 * 2) PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs
 * 3) <tmpdir>/pi-subagents-<scopeId>/async-subagent-runs
 * 由 pickExistingDir 逐个判断存在性，取第一个存在的；都不存在 → 调用方降级。
 */
export function runDirCandidates(deps: RunDirDeps): string[] {
  const candidates: string[] = [];

  const explicit = deps.env.PI_SUBAGENTS_RUN_DIR?.trim();
  if (explicit) candidates.push(explicit, join(explicit, "async-subagent-runs"));

  const tempRoot = deps.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (tempRoot) candidates.push(join(resolve(tempRoot), "async-subagent-runs"));

  candidates.push(join(deps.tmpDir, `pi-subagents-${tempScopeId(deps)}`, "async-subagent-runs"));
  return candidates;
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 纯函数：按候选顺序取第一个满足 exists 的目录。 */
export function pickExistingDir(candidates: string[], exists: (path: string) => boolean): string | undefined {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** 运行目录不存在时的固定降级提示（④ 第 3 步）。 */
export function formatRunDirMissing(candidates: string[]): string {
  const lookedFor = candidates.length > 0 ? candidates.join("; ") : "(无法确定)";
  return `运行目录未找到（looked for: ${lookedFor}）；仅显示账本信息，state 一律回退任务状态`;
}

export async function findExistingDir(candidates: string[]): Promise<string | undefined> {
  return pickExistingDir(candidates, isExistingDir);
}

function optionalField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 宽容解析 status.json：字段缺失跳过，结构不符返回 undefined，永不抛。 */
export function parseRunStatus(raw: unknown): RunStatusInfo | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const info: RunStatusInfo = {};

  const state = optionalField(record, "state");
  if (state !== undefined) info.state = state;
  const cwd = optionalField(record, "cwd");
  if (cwd !== undefined) info.cwd = cwd;

  let sessionPath = optionalField(record, "sessionFile");
  if (sessionPath === undefined && Array.isArray(record.steps)) {
    const first = record.steps[0];
    if (typeof first === "object" && first !== null) {
      sessionPath = optionalField(first as Record<string, unknown>, "sessionFile");
    }
  }
  if (sessionPath !== undefined) info.sessionPath = sessionPath;

  return info;
}

/** 只读探测 run 目录；任何异常都当「没有信息」，不报错。 */
export async function readRunStatus(runDir: string, runId: string): Promise<RunStatusInfo | undefined> {
  try {
    const text = await readFile(join(runDir, runId, "status.json"), "utf8");
    return parseRunStatus(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * 从 subagent 的 tool_result.details 提取 runId。
 * 兼容 details.runId / details.childRunId / details.runs[*].runId；去重后唯一才返回，歧义不猜。
 */
export function extractRunId(details: unknown): string | undefined {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.trim() !== "") found.add(value.trim());
  };

  if (typeof details === "object" && details !== null) {
    const record = details as Record<string, unknown>;
    visit(record.runId);
    visit(record.childRunId);
    if (Array.isArray(record.runs)) {
      for (const entry of record.runs) {
        if (typeof entry === "object" && entry !== null) visit((entry as Record<string, unknown>).runId);
      }
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export type WorkerBucket = "active" | "done";

const ACTIVE_STATES: readonly string[] = ["queued", "running"];
// pi-subagents AsyncStatus.state 的真实枚举（pi-subagents/src/shared/types.d.ts:1919 AsyncStatus.state）
// 是 queued|running|complete|failed|partial|paused|stopped|rejected；completed/blocked 是宽容保留项。
const DONE_STATES: readonly string[] = ["complete", "completed", "failed", "partial", "stopped", "paused", "rejected", "blocked"];

/** 优先用 status.json 的 state 分桶；取不到回退账本状态。 */
export function runBucket(info: RunStatusInfo | undefined, task: Task): WorkerBucket {
  const state = info?.state;
  if (state !== undefined) {
    if (ACTIVE_STATES.includes(state)) return "active";
    if (DONE_STATES.includes(state)) return "done";
  }
  return isOpen(task) ? "active" : "done";
}

export function formatWorkerLine(task: Task, info: RunStatusInfo | undefined): string {
  const last = lastReport(task);
  const lastS = last ? `${last.status} ${clip(last.summary, 60)}` : "-";
  return `${task.id} [${task.status}] ${task.project} · run ${task.runId ?? "-"} · ${info?.state ?? "-"} · session ${info?.sessionPath ?? "?"} · last: ${lastS}`;
}

export function countBuckets(rows: readonly { bucket: WorkerBucket }[]): { active: number; done: number } {
  let active = 0;
  let done = 0;
  for (const row of rows) {
    if (row.bucket === "active") active += 1;
    else done += 1;
  }
  return { active, done };
}