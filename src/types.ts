export type TaskStatus = "queued" | "running" | "needs-human" | "done" | "failed" | "stopped";
export type ReportStatus = "progress" | "blocked" | "ready" | "failed" | "dropped";
export type ReportReason =
  | "user_request"
  | "blocked_question"
  | "rework"
  | "superseded"
  | "promoted"
  | "other";

export interface Report {
  at: string;
  status: ReportStatus;
  summary: string;
  question?: string;
  reason?: ReportReason;
}

export interface Task {
  id: string; // "t1", "t2", ...
  key: string; // 幂等键
  goal: string;
  project: string; // basename(realpath(cwd))；realpath 失败时用 cwd 原值
  cwd: string;
  ownerSession: string; // 创建该任务的会话 id；迁移任务为 "migrated"
  status: TaskStatus;
  runId?: string; // pi-subagents run id
  model?: string;
  worktree?: boolean;
  reports: Report[];
  deliverables?: string[];
  next?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ledger {
  version: 2;
  seq: number;
  tasks: Task[];
}

/**
 * 审计只记录「人对 AI 权力的决定」，不记工作流水：
 * promote 批准一条候选进全局记忆 / revoke 撤回 / grant 改权限 / migrate 一次性迁移。
 */
export type AuditKind = "promote" | "revoke" | "grant" | "migrate";

export interface AuditLine {
  n?: number; // 显式编号（1 起）。由 appendAudit 分配，读旧文件时按行动态补
  at: string;
  session: string;
  project: string;
  kind: AuditKind;
  target?: "global";
  candidate?: string; // c1
  source?: string; // "t4 / 2026-11-25"
  text?: string;
  reason?: string; // outdated | wrong | replaced | promoted
  setting?: string; // grant 改的开关
  from?: string | boolean;
  to?: string | boolean;
}

/** 工作流水：只记形状（谁/何时/从什么变成什么），不记报告正文。 */
export type EventKind = "open" | "dispatch" | "status" | "report";
export interface EventLine {
  at: string;
  kind: EventKind;
  taskId: string;
  project: string;
  session: string;
  runId?: string;
  from?: TaskStatus;
  to?: TaskStatus;
  report?: ReportStatus;
  durMs?: number;
}

export type CandidateStatus = "open" | "approved" | "rejected";

export interface Candidate {
  id: string; // "c1"
  text: string;
  source: string; // 证据：任务 id / 日期
  status: CandidateStatus;
  at: string;
  resolvedAt?: string;
}

export interface RouterConfig {
  scope: "global" | "project";
  home: string; // 绝对路径；"~" 已在 config.ts 展开
  routerReadOnly: boolean;
  workerModel: string | null;
  maxOpenShown: number;
  progressThrottleMs: number;
}