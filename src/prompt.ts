import type { Task } from "./types.ts";
import { clip, countBy, isOpen, lastReport } from "./store.ts";

export const ROUTER_RULES = [
  "你是 Router：只把目标变成任务、派给 worker、汇总结果。不读业务代码、不做实现、不给实现方案；任务内部拆解属于 worker。",
  "一个独立目标 = 一个任务 = 一个 worker。只有互相独立才并行，有依赖就排队。",
  "派发前任务说明必须写全：目标、范围/边界、验收标准、交付物、失败时怎么办。",
  "派发方式：先 router_task_open 拿 id，再 subagent({ agent: \"router-worker\", task, cwd, worktree })，然后用 router_task_update 写入 runId 与 running。",
  "报告到达后只做三件事：router_task_update 记账 → 决定下一步 → 必要时向人汇报。",
  "不 sleep、不轮询、不反复查 status；子代理完成会自动唤醒会话。",
  "只有 blocked / 需要人决策时才打扰用户；progress 不转述。",
  "每个重要决定写一行理由到 memory.md（为什么这样拆、为什么换方案）。",
  "交付前先 router_task_list 确认没有遗漏的 open 任务。",
].join("\n");

const MAX_TASKS = 20;
const MAX_LINES = 40;
const MAX_CHARS = 4096;
const MARKER = "…(truncated)";

export function buildDigest(tasks: Task[]): string {
  const open = tasks.filter(isOpen);
  if (open.length === 0) return "open tasks: none";

  const lines = [
    `open: ${open.length} · running: ${countBy(open, "running")} · needs-human: ${countBy(open, "needs-human")}`,
  ];
  for (const task of open.slice(0, MAX_TASKS)) {
    const last = lastReport(task);
    const lastS = last ? `${last.status} ${clip(last.summary, 60)}` : "-";
    const nextS = task.next && task.next.length > 0 ? clip(task.next, 60) : "-";
    lines.push(
      `${task.id} [${task.status}] ${clip(task.key, 40)} — ${clip(task.goal, 80)} · last: ${lastS} · next: ${nextS}`,
    );
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

  const truncated = out.length < lines.length || open.length > MAX_TASKS;
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