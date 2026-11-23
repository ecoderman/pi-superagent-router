import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type InspectCmd = "git-status" | "git-log" | "git-diff" | "tree";

export const INSPECT_COMMANDS: readonly InspectCmd[] = ["git-status", "git-log", "git-diff", "tree"];

export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".pi"]);

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

export function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, integer));
}

export interface InspectInvocation {
  command: string;
  args: string[];
}

/**
 * 固定 argv 白名单：只接受四个 cmd，绝不把模型文本拼进命令。
 * `tree` 返回 undefined，由 treeEntries 走内部 fs 遍历。
 */
export function inspectArgv(cmd: string, limit?: number): InspectInvocation | undefined {
  switch (cmd) {
    case "git-status":
      return { command: "git", args: ["status", "--porcelain=v1", "--branch"] };
    case "git-log":
      return { command: "git", args: ["log", "--oneline", "-n", String(clampLimit(limit, 20))] };
    case "git-diff":
      return { command: "git", args: ["diff", "--stat"] };
    default:
      return undefined;
  }
}

export interface TreeEntry {
  path: string;
  kind: "file" | "dir";
}

function toDisplay(path: string): string {
  return path.split(sep).join("/");
}

/** 内部 fs 遍历：深度 ≤ maxDepth（root 直接子项 = 1）、条目 ≤ limit、跳过 SKIP_DIRS。 */
export async function treeEntries(root: string, limit: number, maxDepth = 2): Promise<TreeEntry[]> {
  const cap = clampLimit(limit, 200);
  const entries: TreeEntry[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (entries.length >= cap) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 单个目录读不到（EACCES/ENOENT）静默跳过
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (entries.length >= cap) return;
      if (SKIP_DIRS.has(dirent.name)) continue;
      const full = join(dir, dirent.name);
      const display = toDisplay(relative(root, full));
      if (dirent.isDirectory()) {
        entries.push({ path: `${display}/`, kind: "dir" });
        if (depth < maxDepth) await walk(full, depth + 1);
      } else {
        entries.push({ path: display, kind: "file" });
      }
    }
  };

  await walk(root, 1);
  return entries;
}

export function formatTree(entries: TreeEntry[]): string {
  if (entries.length === 0) return "(空目录)";
  return entries.map((entry) => entry.path).join("\n");
}