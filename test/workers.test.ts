import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyLedger, applyOpen, applyUpdate } from "../src/store.ts";
import {
  countBuckets,
  extractRunId,
  findExistingDir,
  formatRunDirMissing,
  formatWorkerLine,
  parseRunStatus,
  pickExistingDir,
  readRunStatus,
  runBucket,
  runDirCandidates,
  tempScopeId,
} from "../src/workers.ts";
import type { Task } from "../src/types.ts";

function task(overrides: Partial<Task> = {}): Task {
  const ledger = emptyLedger();
  const { task: opened } = applyOpen(ledger, {
    key: "k",
    goal: "g",
    project: "proj",
    ownerSession: "s",
    cwd: "/work/proj",
  });
  return { ...opened, ...overrides };
}

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-router-workers-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test("extractRunId accepts the three shapes and refuses ambiguity", () => {
  assert.equal(extractRunId({ runId: "r1" }), "r1");
  assert.equal(extractRunId({ runs: [{ runId: "r1" }, { runId: "r1" }] }), "r1");
  assert.equal(extractRunId({ runs: [{ runId: "r1" }, { runId: "r2" }] }), undefined);
  assert.equal(extractRunId({ childRunId: "c1" }), "c1");
  assert.equal(extractRunId({ runId: "r1", childRunId: "c1" }), undefined);
  assert.equal(extractRunId({}), undefined);
  assert.equal(extractRunId(undefined), undefined);
  assert.equal(extractRunId("r1"), undefined);
  assert.equal(extractRunId({ runId: 42 }), undefined);
  assert.equal(extractRunId({ runId: "   " }), undefined);
});

test("parseRunStatus is lenient and readRunStatus never throws", async () => {
  assert.deepEqual(parseRunStatus({ state: "running", sessionFile: "/s.jsonl", cwd: "/w" }), {
    state: "running",
    sessionPath: "/s.jsonl",
    cwd: "/w",
  });
  assert.deepEqual(parseRunStatus({ state: "completed", steps: [{ sessionFile: "/nested.jsonl" }] }), {
    state: "completed",
    sessionPath: "/nested.jsonl",
  });
  assert.deepEqual(parseRunStatus({}), {});
  assert.equal(parseRunStatus("nope"), undefined);
  assert.equal(parseRunStatus(null), undefined);
  assert.equal(parseRunStatus([1, 2]), undefined);

  const runDir = await newDir();
  try {
    assert.equal(await readRunStatus(runDir, "missing"), undefined);

    await mkdir(join(runDir, "run-ok"), { recursive: true });
    await writeFile(join(runDir, "run-ok", "status.json"), JSON.stringify({ state: "running" }), "utf8");
    assert.deepEqual(await readRunStatus(runDir, "run-ok"), { state: "running" });

    await mkdir(join(runDir, "run-bad"), { recursive: true });
    await writeFile(join(runDir, "run-bad", "status.json"), "{ broken", "utf8");
    assert.equal(await readRunStatus(runDir, "run-bad"), undefined);
  } finally {
    await cleanup(runDir);
  }
});

test("runDirCandidates accepts PI_SUBAGENTS_RUN_DIR itself and its async-subagent-runs child", () => {
  const candidates = runDirCandidates({
    env: { PI_SUBAGENTS_RUN_DIR: " /custom/runs ", USERNAME: "alice" },
    tmpDir: "/tmp",
  });
  assert.equal(candidates[0], "/custom/runs");
  assert.equal(candidates[1], join("/custom/runs", "async-subagent-runs"));
  assert.ok(candidates.includes(join("/tmp", "pi-subagents-user-alice", "async-subagent-runs")));
});

test("runDirCandidates puts PI_SUBAGENTS_TEMP_ROOT ahead of the tmp scope", () => {
  assert.deepEqual(
    runDirCandidates({ env: { PI_SUBAGENTS_TEMP_ROOT: "custom-root", USERNAME: "alice" }, tmpDir: "/tmp" }),
    [
      join(resolve("custom-root"), "async-subagent-runs"),
      join("/tmp", "pi-subagents-user-alice", "async-subagent-runs"),
    ],
  );
});

test("tempScopeId mirrors pi-subagents resolveTempScopeId", () => {
  assert.equal(tempScopeId({ env: {}, tmpDir: "/tmp", getuid: () => 1000 }), "uid-1000");
  assert.equal(tempScopeId({ env: { USERNAME: "alice" }, tmpDir: "/tmp" }), "user-alice");
  assert.equal(tempScopeId({ env: { USER: "bob" }, tmpDir: "/tmp", username: () => "ignored" }), "user-bob");
  assert.equal(tempScopeId({ env: {}, tmpDir: "/tmp", username: () => "carol" }), "user-carol");
  assert.equal(tempScopeId({ env: { HOME: "/home/erin" }, tmpDir: "/tmp" }), "home-home-erin");
  assert.equal(tempScopeId({ env: {}, tmpDir: "/tmp", homedir: () => "/home/frank" }), "home-home-frank");
  assert.equal(tempScopeId({ env: {}, tmpDir: "/tmp" }), "shared");
  assert.equal(tempScopeId({ env: { USERNAME: "!!!" }, tmpDir: "/tmp" }), "user-unknown");
  assert.equal(
    runDirCandidates({ env: {}, tmpDir: "/tmp" })[0],
    join("/tmp", "pi-subagents-shared", "async-subagent-runs"),
    "没有任何 scope 信息时回退 shared",
  );
});

test("pickExistingDir picks the first existing candidate", () => {
  assert.equal(pickExistingDir(["/a", "/b", "/c"], (path) => path === "/b"), "/b");
  assert.equal(pickExistingDir(["/a", "/b"], () => false), undefined);
  assert.equal(pickExistingDir([], () => true), undefined);
});

test("formatRunDirMissing names the candidates it looked for", () => {
  const one = formatRunDirMissing(["/tmp/runs"]);
  assert.ok(one.startsWith("运行目录未找到"));
  assert.ok(one.includes("/tmp/runs"));
  assert.ok(one.includes("仅显示账本信息"));
  assert.ok(formatRunDirMissing([]).includes("(无法确定)"));
});

test("findExistingDir returns the first directory that exists", async () => {
  const root = await newDir();
  try {
    const existing = join(root, "runs");
    await mkdir(existing, { recursive: true });
    assert.equal(await findExistingDir([]), undefined);
    assert.equal(await findExistingDir([join(root, "missing"), existing]), existing);
    assert.equal(await findExistingDir([join(root, "missing")]), undefined);
  } finally {
    await cleanup(root);
  }
});

test("runBucket prefers status.json state and falls back to the ledger", () => {
  const open = task();
  const done = task({ status: "done" });
  assert.equal(runBucket({ state: "running" }, open), "active");
  assert.equal(runBucket({ state: "queued" }, open), "active");
  assert.equal(runBucket({ state: "complete" }, open), "done", "pi-subagents 最常见的成功终态");
  assert.equal(runBucket({ state: "partial" }, open), "done");
  assert.equal(runBucket({ state: "rejected" }, open), "done");
  assert.equal(runBucket({ state: "completed" }, open), "done");
  assert.equal(runBucket({ state: "blocked" }, open), "done");
  assert.equal(runBucket({ state: "weird" }, open), "active");
  assert.equal(runBucket(undefined, done), "done");
  assert.equal(runBucket({}, open), "active");
  assert.deepEqual(
    countBuckets([{ bucket: "active" }, { bucket: "done" }, { bucket: "active" }]),
    { active: 2, done: 1 },
  );
});

test("formatWorkerLine degrades gracefully when run info is missing", () => {
  const withInfo = formatWorkerLine(
    task({ status: "running", runId: "run-7" }),
    { state: "running", sessionPath: "/sessions/abc.jsonl" },
  );
  assert.equal(
    withInfo,
    "t1 [running] proj · run run-7 · running · session /sessions/abc.jsonl · last: -",
  );

  const bare = formatWorkerLine(task(), undefined);
  assert.ok(bare.includes("run -"));
  assert.ok(bare.includes("session ?"));
  assert.ok(bare.endsWith("last: -"));

  const reported = task();
  applyUpdate(
    { version: 2, seq: 1, tasks: [reported] },
    reported.id,
    { report: { status: "blocked", summary: "s".repeat(120) } },
  );
  const line = formatWorkerLine(reported, { state: "running", sessionPath: "/s.jsonl" });
  assert.ok(line.includes("last: blocked"));
  assert.ok(line.includes("s".repeat(59) + "…"));
});