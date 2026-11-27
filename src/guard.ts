/** 层 A：Router 会话只保留这些工具（顺序稳定，集合由 BRIEF-v2 ③ 固定）。 */
export const KEEP_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "subagent",
  "router_task_open",
  "router_task_update",
  "router_task_list",
  "router_project_note",
  "router_candidate",
  "router_memory_read",
  "router_note",
  "router_task_get",
  "router_workers",
  "router_inspect",
];

/** shell 类：等值命中。cp/mv/rm 是 BRIEF-v2 ③「若宿主提供」的兜底。 */
export const BLOCKED_TOOL_NAMES: readonly string[] = ["bash", "powershell", "cp", "mv", "rm"];
/** 写类：任何以此开头的工具名都拦（write / edit / apply_patch / apply_diff ...）。 */
export const BLOCKED_TOOL_PREFIXES: readonly string[] = ["write", "edit", "apply"];

const SHELL_TOOL_NAMES: readonly string[] = ["bash", "powershell"];

export function shouldBlockTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  if (BLOCKED_TOOL_NAMES.includes(name)) return true;
  return BLOCKED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 两条语义都保留，且统一以 `Router 只读` 开头（BRIEF-v2 验收 5）。 */
export function blockReason(toolName: string): string {
  const name = toolName.toLowerCase();
  if (SHELL_TOOL_NAMES.includes(name)) return `Router 只读：Router 不用 ${name}，请用 router_inspect 查状态`;
  return "Router 只读：Router 不能改文件，请派 worker（subagent）";
}

export function isChildSession(env?: NodeJS.ProcessEnv): boolean {
  return (env ?? process.env).PI_SUBAGENT_CHILD === "1";
}