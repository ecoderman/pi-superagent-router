import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockReason,
  BLOCKED_TOOL_NAMES,
  BLOCKED_TOOL_PREFIXES,
  isChildSession,
  KEEP_TOOLS,
  shouldBlockTool,
} from "../src/guard.ts";
import { clampLimit, formatTree, inspectArgv, INSPECT_COMMANDS, treeEntries } from "../src/inspect.ts";

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-superagent-router-guard-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test("KEEP_TOOLS is exactly the documented read-only set", () => {
  const expected = [
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
  assert.deepEqual([...KEEP_TOOLS].sort(), [...expected].sort());
  assert.equal(new Set(KEEP_TOOLS).size, KEEP_TOOLS.length);
});

test("shouldBlockTool blocks write/edit/bash and lets read-only tools through", () => {
  for (const name of ["write", "edit", "bash", "powershell", "apply_patch", "apply_diff", "Write", "EDIT"]) {
    assert.equal(shouldBlockTool(name), true, `${name} should be blocked`);
  }
  for (const name of ["read", "grep", "find", "ls", "subagent", "router_inspect", "router_task_open", "router_workers"]) {
    assert.equal(shouldBlockTool(name), false, `${name} should pass`);
  }
  assert.deepEqual([...BLOCKED_TOOL_NAMES], ["bash", "powershell", "cp", "mv", "rm"]);
  assert.deepEqual([...BLOCKED_TOOL_PREFIXES], ["write", "edit", "apply"]);
  for (const name of ["cp", "mv", "rm"]) assert.equal(shouldBlockTool(name), true);
});

test("blockReason always starts with Router 只读 and names the way out", () => {
  assert.ok(blockReason("write").startsWith("Router 只读"));
  assert.ok(blockReason("edit").startsWith("Router 只读"));
  assert.ok(blockReason("bash").startsWith("Router 只读"));
  assert.ok(blockReason("bash").includes("router_inspect"));
  assert.ok(blockReason("write").includes("subagent"));
});

test("isChildSession only follows PI_SUBAGENT_CHILD", () => {
  assert.equal(isChildSession({}), false);
  assert.equal(isChildSession({ PI_SUBAGENT_CHILD: "0" }), false);
  assert.equal(isChildSession({ PI_SUBAGENT_CHILD: "1" }), true);
});

test("clampLimit clamps to 1..500 and falls back on non-finite input", () => {
  assert.equal(clampLimit(undefined, 20), 20);
  assert.equal(clampLimit(Number.NaN, 20), 20);
  assert.equal(clampLimit(Number.POSITIVE_INFINITY, 20), 20);
  assert.equal(clampLimit(0, 20), 1);
  assert.equal(clampLimit(-5, 20), 1);
  assert.equal(clampLimit(1000, 20), 500);
  assert.equal(clampLimit(42, 20), 42);
  assert.equal(clampLimit(3.9, 20), 3);
});

test("inspectArgv only accepts the four fixed commands", () => {
  assert.deepEqual(INSPECT_COMMANDS, ["git-status", "git-log", "git-diff", "tree"]);
  assert.deepEqual(inspectArgv("git-status", 999), {
    command: "git",
    args: ["status", "--porcelain=v1", "--branch"],
  });
  assert.deepEqual(inspectArgv("git-diff"), { command: "git", args: ["diff", "--stat"] });
  assert.deepEqual(inspectArgv("git-log"), { command: "git", args: ["log", "--oneline", "-n", "20"] });
  assert.deepEqual(inspectArgv("git-log", 5), { command: "git", args: ["log", "--oneline", "-n", "5"] });
  assert.deepEqual(inspectArgv("git-log", 10_000), { command: "git", args: ["log", "--oneline", "-n", "500"] });
  assert.equal(inspectArgv("tree"), undefined);
  assert.equal(inspectArgv("rm -rf /"), undefined);
  assert.equal(inspectArgv("git push"), undefined);
});

test("treeEntries honours depth 2, skips vendor dirs and respects limit", async () => {
  const root = await newDir();
  try {
    await mkdir(join(root, "src", "nested", "deeper"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".pi", "router"), { recursive: true });
    await writeFile(join(root, "top.txt"), "top", "utf8");
    await writeFile(join(root, "src", "a.ts"), "a", "utf8");
    await writeFile(join(root, "src", "nested", "b.ts"), "b", "utf8");
    await writeFile(join(root, "src", "nested", "deeper", "c.ts"), "c", "utf8");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "", "utf8");
    await writeFile(join(root, ".git", "config"), "", "utf8");
    await writeFile(join(root, ".pi", "router", "tasks.json"), "{}", "utf8");

    const entries = await treeEntries(root, 200);
    const paths = entries.map((entry) => entry.path);
    assert.ok(paths.includes("top.txt"));
    assert.ok(paths.includes("src/"));
    assert.ok(paths.includes("src/a.ts"));
    assert.ok(paths.includes("src/nested/"));
    assert.ok(!paths.some((path) => path.includes("b.ts")), "depth 3 files are not listed");
    assert.ok(!paths.some((path) => path.includes("deeper")), "depth 3 is not listed");
    assert.ok(!paths.some((path) => path.startsWith("node_modules")));
    assert.ok(!paths.some((path) => path.startsWith(".git")));
    assert.ok(!paths.some((path) => path.startsWith(".pi")));
    assert.equal(entries.find((entry) => entry.path === "src/")?.kind, "dir");
    assert.equal(entries.find((entry) => entry.path === "src/a.ts")?.kind, "file");

    const limited = await treeEntries(root, 2);
    assert.equal(limited.length, 2);

    const capped = await treeEntries(root, 10_000);
    assert.ok(capped.length <= 500);

    assert.equal(formatTree([]), "(空目录)");
    assert.equal(formatTree([{ path: "a/", kind: "dir" }, { path: "a/b.txt", kind: "file" }]), "a/\na/b.txt");
  } finally {
    await cleanup(root);
  }
});