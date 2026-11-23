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
  cwd: string;
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
  version: 1;
  seq: number;
  tasks: Task[];
}