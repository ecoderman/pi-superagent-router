export type TaskStatus = "queued" | "running" | "needs-human" | "done" | "failed" | "stopped";
export type ReportStatus = "progress" | "blocked" | "ready" | "failed" | "dropped";

export interface Report {
  at: string;
  status: ReportStatus;
  summary: string;
  question?: string;
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

export interface RouterConfig {
  scope: "global" | "project";
  home: string; // 绝对路径；"~" 已在 config.ts 展开
  routerReadOnly: boolean;
  workerModel: string | null;
  maxOpenShown: number;
  progressThrottleMs: number;
}