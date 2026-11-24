import type { Task } from "./types.ts";
import { clip, countBy, isOpen, lastReport, sameProject } from "./store.ts";

export const ROUTER_RULES = [
  "你是 Router：只把目标变成任务、派给 worker、汇总结果。不读业务代码、不做实现、不给实现方案；任务内部拆解属于 worker。",
  "一个独立目标 = 一个任务 = 一个 worker。只有互相独立才并行，有依赖就排队。",
  "派发前任务说明必须写全：目标、范围/边界、验收标准、交付物、失败时怎么办。",
  "派发方式：先 router_task_open 拿 id，再 subagent({ agent: \"router-worker\", task, cwd, worktree })，然后用 router_task_update 写入 running。runId 不必手写（扩展自动记：唯一待派任务直接绑；多个时优先匹配 task 文本里的 goal，否则取最新创建者，并在结果里告诉你绑给了谁）。",
  "你不能修改文件：没有 write/edit/bash。需要查状态用 router_inspect（git-status / git-log / git-diff / tree），需要改代码就派 worker。",
  "用 router_workers 查看正在跑的 worker 与它们的 session 路径；要看过程用 subagent({ action: \"status\", id, options: { view: \"transcript\" } })。",
  "digest 里每条任务末尾的 read: task/<id> 是指针，不是内容。任务处于 needs-human、或你要向用户汇报某任务结果之前，先用 router_task_get { id } 取详情，不要只凭 last 一行下结论。",
  "取详情时报告默认只拿最近 5 条；需要更早的上下文就显式传 reports（最大 20），不要假设自己已经看全。",
  "报告到达后只做三件事：router_task_update 记账 → 决定下一步 → 必要时向人汇报。",
  "不 sleep、不轮询、不反复查 status；子代理完成会自动唤醒会话。",
  "只有 blocked / 需要人决策时才打扰用户；progress 不转述。",
  "每个重要决定只写 session/audit，不写 global/project：用 router_note 写会话短时记忆，或用 router_memory_append 写审计理由；要长期保留就请用户执行 `/router promote`。",
  "交付前先 router_task_list 确认没有遗漏的 open 任务。",
].join("\n");

export const EMPTY_DIGEST_LINE = "open tasks: none";
/** 任务行的详情指针前缀；`read: task/<id>` 可被 router_task_get 解引用。 */
export const READ_POINTER_PREFIX = " · read: task/";

const MAX_TASKS = 20;
const MAX_LINES = 40;
const MAX_CHARS = 4096;
const MARKER = "…(truncated)";

export interface DigestOptions {
  project: string;
  scope: "global" | "project";
  maxOpenShown: number;
}

function idOrder(id: string): number {
  const match = /^t(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function byCreatedThenId(a: Task, b: Task): number {
  const at = a.createdAt.localeCompare(b.createdAt);
  if (at !== 0) return at;
  return idOrder(a.id) - idOrder(b.id);
}

/** digest 明细行格式，v3 assembleMemory 的 tasks 层复用（每行尾追加 read: 指针）。 */
export function taskRow(task: Task): string {
  const last = lastReport(task);
  const lastS = last ? `${last.status} ${clip(last.summary, 60)}` : "-";
  const nextS = task.next && task.next.length > 0 ? clip(task.next, 60) : "-";
  return `${task.id} [${task.status}] ${clip(task.key, 40)} — ${clip(task.goal, 80)} · last: ${lastS} · next: ${nextS}`;
}

/** 当前项目的 open 任务，按创建时间/ id 排序（不做 limit 截断）。 */
export function projectOpenTasks(tasks: Task[], options: DigestOptions): Task[] {
  return tasks.filter(isOpen).filter((t) => sameProject(t.project, options.project)).sort(byCreatedThenId);
}

export function clampOpenShown(value: number): number {
  return Math.min(Math.max(1, value), MAX_TASKS);
}

/**
 * digest = 全局统计行（首行）+ 当前项目统计行（仅 scope=global）+ 当前项目 open 明细。
 * BRIEF-v2 ⑤ 只以 `scope=global` 为条件，所以空账本也有项目统计行，
 * 再接一行 `open tasks: none`（该行不得因全局统计而消失）。
 */
export function buildDigest(tasks: Task[], options: DigestOptions): string {
  const open = tasks.filter(isOpen);
  const lines = [
    `global: ${open.length} open · ${countBy(tasks, "running")} running · ${countBy(tasks, "needs-human")} needs-human`,
  ];

  if (options.scope === "global") {
    const projectOpen = open.filter((t) => sameProject(t.project, options.project)).length;
    lines.push(`project ${options.project}: ${projectOpen} open`);
  }

  const limit = clampOpenShown(options.maxOpenShown);
  const projectTasks = projectOpenTasks(tasks, options);
  const shown = projectTasks.slice(0, limit);
  if (shown.length === 0) {
    lines.push(EMPTY_DIGEST_LINE);
  } else {
    // 指针：详情走 router_task_get，不要把全部报告塞进上下文
    for (const task of shown) lines.push(`${taskRow(task)}${READ_POINTER_PREFIX}${task.id}`);
  }

  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= MAX_LINES) break;
    const needed = line.length + (out.length > 0 ? 1 : 0);
    if (chars + needed > MAX_CHARS) break;
    out.push(line);
    chars += needed;
  }

  const truncated = out.length < lines.length || projectTasks.length > shown.length;
  let text = out.join("\n");
  if (truncated) {
    const suffix = `\n${MARKER}`;
    const maxBodyChars = MAX_CHARS - suffix.length;
    const maxBodyLines = MAX_LINES - 1;
    if (out.length > maxBodyLines) {
      out.length = maxBodyLines;
      text = out.join("\n");
    }
    if (text.length > maxBodyChars) text = text.slice(0, maxBodyChars);
    return text + suffix;
  }
  return text;
}