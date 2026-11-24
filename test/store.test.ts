import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  appendGlobalMemoryLocked,
  appendProjectMemoryLocked,
  applyOpen,
  applyUpdate,
  clip,
  countBy,
  emptyLedger,
  readGlobalMemory,
  readProjectMemory,
  findOpen,
  formatTaskRow,
  importLegacyTasks,
  loadLedger,
  lockPath,
  memoryPath,
  migrateTaskV1,
  nextId,
  parseLedger,
  projectName,
  sameProject,
  saveLedger,
  bindRunId,
  tasksPath,
  withLedger,
  withLock,
} from "../src/store.ts";
import { buildDigest, EMPTY_DIGEST_LINE } from "../src/prompt.ts";
import type { Ledger, Task } from "../src/types.ts";

async function newHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-router-home-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function openInput(key: string, cwd: string, project = "alpha") {
  return { key, goal: `goal-${key}`, project, ownerSession: "session-1", cwd };
}

function digestOptions(project = "alpha", scope: "global" | "project" = "global") {
  return { project, scope, maxOpenShown: 20 };
}

function v1Task(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "t1",
    key: "legacy-key",
    goal: "legacy goal",
    cwd: "/old/project",
    status: "running",
    runId: "run-legacy",
    reports: [{ at: "2024-01-01T00:00:00.000Z", status: "progress", summary: "working" }],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T01:00:00.000Z",
    ...overrides,
  };
}

test("idempotent open reuses an open task, reopens after terminal", async () => {
  const home = await newHome();
  try {
    const first = await withLedger(home, (ledger) => applyOpen(ledger, openInput("build-x", home)));
    assert.equal(first.result.created, true);
    assert.equal(first.ledger.version, 2);
    assert.equal(first.result.task.project, "alpha");
    assert.equal(first.result.task.ownerSession, "session-1");

    const second = await withLedger(home, (ledger) => applyOpen(ledger, openInput("build-x", home)));
    assert.equal(second.result.created, false);
    assert.equal(second.result.task.id, first.result.task.id);
    assert.equal(second.ledger.tasks.length, 1);
    assert.equal(second.ledger.seq, 1);

    await withLedger(home, (ledger) => applyUpdate(ledger, first.result.task.id, { status: "done" }));
    const reopened = await withLedger(home, (ledger) => applyOpen(ledger, openInput("build-x", home)));
    assert.equal(reopened.result.created, true);
    assert.notEqual(reopened.result.task.id, first.result.task.id);
    assert.equal(reopened.ledger.tasks.length, 2);
    assert.equal(reopened.ledger.seq, 2);
  } finally {
    await cleanup(home);
  }
});

test("the same key opens independent tasks per project in the global ledger", async () => {
  const home = await newHome();
  try {
    const alpha = await withLedger(home, (ledger) => applyOpen(ledger, openInput("shared", home, "alpha")));
    const beta = await withLedger(home, (ledger) => applyOpen(ledger, openInput("shared", home, "beta")));
    assert.equal(alpha.result.created, true);
    assert.equal(beta.result.created, true, "A 项目的同名 key 不能让 B 项目误命中");
    assert.notEqual(beta.result.task.id, alpha.result.task.id);
    assert.equal(beta.result.task.project, "beta");

    // 同一项目内仍然幂等（大小写不敏感，与 sameProject 一致）
    const again = await withLedger(home, (ledger) => applyOpen(ledger, openInput("shared", home, "ALPHA")));
    assert.equal(again.result.created, false);
    assert.equal(again.result.task.id, alpha.result.task.id);

    const { ledger } = await loadLedger(home);
    assert.equal(ledger.tasks.length, 2);
  } finally {
    await cleanup(home);
  }
});

test("report append keeps ISO timestamps and question", () => {
  const ledger = emptyLedger();
  const { task } = applyOpen(ledger, openInput("k", "cwd"));

  applyUpdate(ledger, task.id, { report: { status: "progress", summary: "first", question: "q?" } });
  applyUpdate(ledger, task.id, { report: { status: "ready", summary: "second" } });

  assert.equal(task.reports.length, 2);
  assert.ok(!Number.isNaN(Date.parse(task.reports[0].at)));
  assert.ok(!Number.isNaN(Date.parse(task.reports[1].at)));
  assert.ok(Date.parse(task.reports[0].at) <= Date.parse(task.reports[1].at));
  assert.equal(task.reports[0].question, "q?");
  assert.equal(task.reports[1].question, undefined);
  assert.ok(!Number.isNaN(Date.parse(task.updatedAt)));
});

test("report reason round-trips and legacy reports without reason stay readable", async () => {
  const home = await newHome();
  try {
    const ledger = emptyLedger();
    const { task } = applyOpen(ledger, openInput("k", "cwd"));
    applyUpdate(ledger, task.id, {
      report: { status: "blocked", summary: "need input", reason: "blocked_question" },
    });
    await saveLedger(home, ledger);

    const { ledger: restored } = await loadLedger(home);
    assert.equal(restored.tasks[0].reports[0].reason, "blocked_question");

    type LedgerShape = { tasks: { reports: Record<string, unknown>[] }[] };
    const legacy = JSON.parse(JSON.stringify(restored)) as LedgerShape;
    delete legacy.tasks[0].reports[0].reason;
    const parsedLegacy = parseLedger(legacy as unknown);
    assert.equal(parsedLegacy.tasks[0].reports[0].reason, undefined);

    const unknown = JSON.parse(JSON.stringify(restored)) as LedgerShape;
    unknown.tasks[0].reports[0].reason = "bogus";
    assert.equal(parseLedger(unknown as unknown).tasks[0].reports[0].reason, undefined, "未知 reason 忽略不回退");
  } finally {
    await cleanup(home);
  }
});

test("digest keeps global + project stats, project detail and the 40 line / 4096 char caps", () => {
  const ledger = emptyLedger();
  for (let i = 0; i < 30; i += 1) {
    applyOpen(ledger, openInput(`k${i}`, "cwd", "alpha"));
  }
  applyOpen(ledger, openInput("other-1", "cwd", "beta"));

  const digest = buildDigest(ledger.tasks, digestOptions("alpha"));
  const lines = digest.split("\n");
  assert.equal(lines[0], "global: 31 open · 0 running · 0 needs-human");
  assert.equal(lines[1], "project alpha: 30 open");
  assert.ok(lines.length <= 40);
  assert.ok(digest.length <= 4096);
  assert.ok(digest.includes("…(truncated)"));
  const taskRows = lines.filter((line) => /^t\d+ /.test(line));
  assert.ok(taskRows.length <= 20);
  assert.ok(taskRows.every((line) => line.startsWith("t") && !line.includes("other-1")));

  // long fields are clipped to their budgets (ellipsis counts toward the budget)
  const long = emptyLedger();
  const goal = "g".repeat(200);
  const next = "n".repeat(200);
  applyOpen(long, { ...openInput("long", "cwd"), goal });
  applyUpdate(long, "t1", { report: { status: "ready", summary: "s".repeat(200) }, next });
  const longDigest = buildDigest(long.tasks, digestOptions());
  assert.ok(longDigest.includes(clip(goal, 80)));
  assert.ok(longDigest.includes(clip("s".repeat(200), 60)));
  assert.ok(longDigest.includes(clip(next, 60)));
  assert.ok(!longDigest.includes("g".repeat(81)));
});

test("digest filters detail rows to the current project and keeps open tasks: none", () => {
  const ledger = emptyLedger();
  applyOpen(ledger, openInput("alpha-1", "cwd", "alpha"));
  applyOpen(ledger, openInput("beta-1", "cwd", "beta"));

  const alpha = buildDigest(ledger.tasks, digestOptions("alpha", "project"));
  const alphaLines = alpha.split("\n");
  assert.equal(alphaLines[0], "global: 2 open · 0 running · 0 needs-human");
  assert.ok(!alphaLines.some((line) => line.startsWith("project ")), "scope=project 不输出项目统计行");
  assert.ok(alpha.includes("alpha-1"));
  assert.ok(!alpha.includes("beta-1"));

  // a project with no tasks of its own still shows the global line, the project line and empty detail
  const empty = emptyLedger();
  applyOpen(empty, openInput("beta-1", "cwd", "beta"));
  const gamma = buildDigest(empty.tasks, digestOptions("gamma")).split("\n");
  assert.equal(gamma[0], "global: 1 open · 0 running · 0 needs-human");
  assert.equal(gamma[1], "project gamma: 0 open");
  assert.equal(gamma[2], EMPTY_DIGEST_LINE);
});

test("digest of an empty ledger still shows the project line and open tasks: none", () => {
  const digest = buildDigest(emptyLedger().tasks, digestOptions());
  assert.deepEqual(digest.split("\n"), [
    "global: 0 open · 0 running · 0 needs-human",
    "project alpha: 0 open",
    EMPTY_DIGEST_LINE,
  ]);
  assert.equal(EMPTY_DIGEST_LINE, "open tasks: none");

  const done = emptyLedger();
  applyOpen(done, openInput("k", "cwd"));
  applyUpdate(done, "t1", { status: "done" });
  assert.ok(buildDigest(done.tasks, digestOptions()).endsWith(EMPTY_DIGEST_LINE));

  // scope=project 不输出项目统计行，空账本只有全局统计 + open tasks: none
  assert.deepEqual(buildDigest(emptyLedger().tasks, digestOptions("alpha", "project")).split("\n"), [
    "global: 0 open · 0 running · 0 needs-human",
    EMPTY_DIGEST_LINE,
  ]);
});

test("atomic save leaves no tmp files and round-trips", async () => {
  const home = await newHome();
  try {
    const ledger = emptyLedger();
    applyOpen(ledger, openInput("k", home));
    applyUpdate(ledger, "t1", { runId: "run-1", status: "running" });
    await saveLedger(home, ledger);
    await saveLedger(home, ledger);

    const entries = await readdir(home);
    assert.ok(entries.includes("tasks.json"));
    assert.ok(!entries.some((e) => e.endsWith(".tmp")));

    const { ledger: restored, warning } = await loadLedger(home);
    assert.equal(warning, undefined);
    assert.equal(restored.version, 2);
    assert.equal(restored.tasks.length, 1);
    assert.equal(restored.tasks[0].runId, "run-1");
    assert.equal(restored.tasks[0].status, "running");
    assert.equal(restored.tasks[0].project, "alpha");
    assert.equal(restored.tasks[0].ownerSession, "session-1");
  } finally {
    await cleanup(home);
  }
});

test("corrupted ledger is backed up by the locked write path, not by the read path", async () => {
  const home = await newHome();
  try {
    const ledger = emptyLedger();
    applyOpen(ledger, openInput("k", home));
    await saveLedger(home, ledger);

    await writeFile(tasksPath(home), "{not valid json", "utf8");

    // 读路径只报告，不改盘（BRIEF-v2 ②：读路径不取锁，不能做无锁 rename）
    const read = await loadLedger(home);
    assert.ok(read.warning !== undefined);
    assert.equal(read.ledger.tasks.length, 0);
    const before = await readdir(home);
    assert.ok(!before.some((e) => e.startsWith("tasks.json.bak-")), "读路径不得备份/改名");

    // 首次写入在锁内备份并重置
    const txn = await withLedger(home, (current) => applyOpen(current, openInput("k2", home)));
    assert.ok(txn.warning?.includes("已备份"), `写入路径应报告备份：${txn.warning}`);

    const entries = await readdir(home);
    assert.ok(entries.some((e) => e.startsWith("tasks.json.bak-")));

    const { ledger: restored, warning } = await loadLedger(home);
    assert.equal(warning, undefined);
    assert.equal(restored.tasks.length, 1);
  } finally {
    await cleanup(home);
  }
});

test("unknown id throws; global and project memory stay in separate files", async () => {
  const home = await newHome();
  try {
    assert.throws(() => applyUpdate(emptyLedger(), "t999", {}), /no task t999/);

    assert.equal(await readGlobalMemory(home), "");
    assert.equal(await readProjectMemory(home, "alpha"), "");

    await appendGlobalMemoryLocked(home, "回答用中文");
    await appendProjectMemoryLocked(home, "alpha", "why split this way");

    const global = await readGlobalMemory(home);
    assert.ok(global.includes("回答用中文"));
    assert.ok(!global.includes("why split this way"));

    const project = await readProjectMemory(home, "alpha");
    assert.ok(project.includes("why split this way"));
    assert.ok(!project.includes("回答用中文"));

    assert.equal(await readProjectMemory(home, "missing"), "");

    // 项目名带路径分隔符必须 fail-closed，不能写到 home 之外
    await assert.rejects(() => appendProjectMemoryLocked(home, "../evil", "x"), /memory scope/);
  } finally {
    await cleanup(home);
  }
});

test("pure helpers behave at boundaries", () => {
  assert.equal(clip("abc", 1), "…");
  assert.equal(clip("abc", 4), "abc");
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip("", 10), "");

  const ledger = emptyLedger();
  assert.equal(nextId(ledger), "t1");
  applyOpen(ledger, openInput("a", "c"));
  assert.equal(nextId(ledger), "t2");
  assert.equal(findOpen(ledger, "a")?.id, "t1");
  assert.equal(findOpen(ledger, "a", "alpha")?.id, "t1");
  assert.equal(findOpen(ledger, "a", "ALPHA")?.id, "t1", "项目匹配大小写不敏感");
  assert.equal(findOpen(ledger, "a", "beta"), undefined, "别的项目的同名 key 不命中");
  assert.equal(findOpen(ledger, "missing"), undefined);
  assert.equal(countBy(ledger.tasks, "queued"), 1);
  assert.equal(countBy(ledger.tasks, "running"), 0);

  applyUpdate(ledger, "t1", { runId: "r1", report: { status: "progress", summary: "working" } });
  const row = formatTaskRow(ledger.tasks[0]);
  assert.ok(row.startsWith("t1 [queued] a run:r1"));
  assert.ok(row.includes("last: progress"));
});

test("parseLedger rejects version 1 and accepts a v2 round-trip", () => {
  const ledger = emptyLedger();
  applyOpen(ledger, openInput("k", "cwd"));
  const roundTripped = parseLedger(JSON.parse(JSON.stringify(ledger)) as unknown);
  assert.equal(roundTripped.version, 2);
  assert.equal(roundTripped.tasks[0].project, "alpha");

  const legacy = { version: 1, seq: 1, tasks: [v1Task()] };
  assert.throws(() => parseLedger(legacy), /unsupported version/);
});

test("migrateTaskV1 derives project from the task cwd, not from the session project", () => {
  const fromCwd = migrateTaskV1(v1Task() as unknown as Task, "session-project");
  assert.equal(fromCwd.project, "project");
  assert.equal(fromCwd.ownerSession, "migrated");

  const emptyCwd = migrateTaskV1(v1Task({ cwd: "" }) as unknown as Task, "session-project");
  assert.equal(emptyCwd.project, "session-project", "任务 cwd 为空时才用传入 project 兜底");

  const kept = migrateTaskV1(
    v1Task({ project: "kept", ownerSession: "kept-owner" }) as unknown as Task,
    "session-project",
  );
  assert.equal(kept.project, "kept");
  assert.equal(kept.ownerSession, "kept-owner");
});

test("v1 ledger migrates into the global ledger and the old file is renamed", async () => {
  const home = await newHome();
  const legacyDir = await newHome();
  try {
    const legacy = { version: 1, seq: 1, tasks: [v1Task()] };
    await writeFile(tasksPath(legacyDir), JSON.stringify(legacy), "utf8");

    const options = { legacy: { dir: legacyDir, project: "old-project" } };

    // read path imports in memory without touching the old file
    const preview = await loadLedger(home, options);
    assert.equal(preview.ledger.tasks.length, 1);
    // BRIEF-v2 ①：project 来自「任务自己的 cwd」（/old/project → project），不是当前会话的项目名
    assert.equal(preview.ledger.tasks[0].project, "project");
    assert.equal(preview.ledger.tasks[0].ownerSession, "migrated");
    assert.ok(await readFile(tasksPath(legacyDir), "utf8"));

    // the first write persists the migration and renames the old file
    const txn = await withLedger(home, (ledger) => ledger.tasks.length, options);
    assert.equal(txn.result, 1);
    const entries = await readdir(legacyDir);
    assert.ok(!entries.includes("tasks.json"));
    assert.equal(entries.filter((e) => e.startsWith("tasks.json.migrated-")).length, 1);

    const persisted = await loadLedger(home);
    assert.equal(persisted.warning, undefined);
    assert.equal(persisted.ledger.version, 2);
    assert.equal(persisted.ledger.tasks.length, 1);
    const task = persisted.ledger.tasks[0];
    assert.equal(task.id, "t1");
    assert.equal(task.key, "legacy-key");
    assert.equal(task.goal, "legacy goal");
    assert.equal(task.project, "project", "迁移任务的 project 取任务 cwd 的 basename");
    assert.notEqual(task.project, "old-project", "不能用创建会话的项目名顶替任务自己的 cwd");
    assert.equal(task.ownerSession, "migrated");
    assert.equal(task.runId, "run-legacy");
    assert.equal(task.reports.length, 1);
    assert.equal(task.createdAt, "2024-01-01T00:00:00.000Z");

    // second write is idempotent: no duplication, still exactly one migrated file
    const again = await withLedger(home, (ledger) => ledger.tasks.length, options);
    assert.equal(again.result, 1);
    assert.equal(again.ledger.seq, persisted.ledger.seq);
    const after = await readdir(legacyDir);
    assert.equal(after.filter((e) => e.startsWith("tasks.json.migrated-")).length, 1);
  } finally {
    await cleanup(home);
    await cleanup(legacyDir);
  }
});

test("legacy import keeps ids when free and renumbers on collision", () => {
  const target: Ledger = emptyLedger();
  applyOpen(target, openInput("existing", "cwd"));
  assert.equal(target.tasks[0].id, "t1");
  const duplicateRaw = v1Task({ id: "t9", key: "another", createdAt: "2024-02-01T00:00:00.000Z" });
  target.tasks.push(migrateTaskV1(duplicateRaw as unknown as Task, "p"));

  const result = importLegacyTasks(
    target,
    { seq: 9, tasks: [v1Task() as unknown as Task, duplicateRaw as unknown as Task] },
    "p",
  );
  assert.equal(result.imported, 1, "the (key, createdAt) duplicate is skipped");
  const imported = target.tasks.find((t) => t.key === "legacy-key");
  assert.ok(imported);
  assert.equal(imported.id, "t2", "t1 collides with the existing task, so it is renumbered");
  assert.equal(result.idMap.t1, "t2");
  assert.equal(target.seq, 9);
});

test("legacy id renumbering is reported by the migration warning", async () => {
  const home = await newHome();
  const legacyDir = await newHome();
  try {
    const existing = emptyLedger();
    applyOpen(existing, openInput("current", home)); // 占住 t1
    await saveLedger(home, existing);
    await writeFile(tasksPath(legacyDir), JSON.stringify({ version: 1, seq: 1, tasks: [v1Task()] }), "utf8");

    const options = { legacy: { dir: legacyDir, project: "old-project" } };
    const preview = await loadLedger(home, options);
    assert.ok(
      preview.warning?.includes("以首次写入落盘结果为准"),
      `读路径应提醒 id 以落盘结果为准：${preview.warning}`,
    );

    const txn = await withLedger(home, (ledger) => ledger.tasks.length, options);
    assert.equal(txn.result, 2);
    assert.ok(txn.warning?.includes("已重编号"), `落盘迁移应报告重编号：${txn.warning}`);
    assert.ok(txn.warning?.includes("t1→t2"), `迁移 warning 应带 id 映射：${txn.warning}`);
    const migrated = txn.ledger.tasks.find((task) => task.key === "legacy-key");
    assert.equal(migrated?.id, "t2");
  } finally {
    await cleanup(home);
    await cleanup(legacyDir);
  }
});

test("20 concurrent opens under the ledger lock keep every task", async () => {
  const home = await newHome();
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withLedger(home, (ledger) => applyOpen(ledger, openInput(`k${i}`, home)), {
          timeoutMs: 15_000,
        }),
      ),
    );
    const { ledger } = await loadLedger(home);
    assert.equal(ledger.tasks.length, 20);
    assert.equal(new Set(ledger.tasks.map((t) => t.id)).size, 20);
    assert.equal(ledger.seq, 20);
    const entries = await readdir(home);
    assert.ok(!entries.includes("tasks.lock"));
    assert.ok(!entries.some((e) => e.endsWith(".tmp")));
  } finally {
    await cleanup(home);
  }
});

test("lock timeout rejects and leaves the foreign lock in place", async () => {
  const home = await newHome();
  try {
    await writeFile(lockPath(home), JSON.stringify({ pid: 1, at: new Date().toISOString() }), "utf8");
    await assert.rejects(withLock(home, async () => "never", { timeoutMs: 150 }), /账本锁超时/);
    const entries = await readdir(home);
    assert.ok(entries.includes("tasks.lock"), "别人的锁不能被删");
  } finally {
    await cleanup(home);
  }
});

test("stale lock is taken over once and released", async () => {
  const home = await newHome();
  try {
    await writeFile(lockPath(home), JSON.stringify({ pid: 1, at: "2024-01-01T00:00:00.000Z" }), "utf8");
    const old = new Date(Date.now() - 20_000);
    await utimes(lockPath(home), old, old);

    const txn = await withLedger(home, (ledger) => applyOpen(ledger, openInput("k", home)), {
      staleMs: 10_000,
      timeoutMs: 2000,
    });
    assert.equal(txn.result.created, true);
    assert.equal(txn.ledger.tasks.length, 1);
    const entries = await readdir(home);
    assert.ok(!entries.includes("tasks.lock"));
  } finally {
    await cleanup(home);
  }
});

test("bindRunId binds the only queued task, ignores non-candidates, and never steals a bound task", () => {
  const single = emptyLedger();
  applyOpen(single, openInput("a", "cwd"));
  const claimed = bindRunId(single, "run-1");
  assert.equal(claimed?.task.id, "t1");
  assert.equal(claimed?.rule, "single");
  assert.equal(single.tasks[0].runId, "run-1");
  assert.equal(single.tasks[0].status, "running");

  const already = emptyLedger();
  applyOpen(already, openInput("a", "cwd"));
  applyUpdate(already, "t1", { runId: "manual" });
  assert.equal(bindRunId(already, "run-3"), undefined);
  assert.equal(already.tasks[0].runId, "manual");
  assert.equal(already.tasks[0].status, "queued");

  const none = emptyLedger();
  assert.equal(bindRunId(none, "run-4"), undefined);
});

test("bindRunId prefers a goal match in the dispatch text over recency", () => {
  const ledger = emptyLedger();
  applyOpen(ledger, openInput("older", "cwd"));
  applyOpen(ledger, openInput("newer", "cwd"));
  ledger.tasks[0].goal = "学完机器学习课程并产出章节笔记";
  ledger.tasks[1].goal = "整理一份季度财务复盘报告";
  // older 的 createdAt 更早，确保 recency 规则会选 newer
  ledger.tasks[0].createdAt = "2026-01-01T00:00:00.000Z";
  ledger.tasks[1].createdAt = "2026-02-01T00:00:00.000Z";

  const byGoal = bindRunId(ledger, "run-goal", "请在 book/ 下继续，目标是：学完机器学习课程并产出章节笔记");
  assert.equal(byGoal?.task.id, "t1");
  assert.equal(byGoal?.rule, "goal");
  assert.equal(ledger.tasks[0].status, "running");
  assert.equal(ledger.tasks[1].runId, undefined);
});

test("bindRunId falls back to the newest queued task and reports the rule", () => {
  const ledger = emptyLedger();
  applyOpen(ledger, openInput("older", "cwd"));
  applyOpen(ledger, openInput("newer", "cwd"));
  ledger.tasks[0].createdAt = "2026-01-01T00:00:00.000Z";
  ledger.tasks[1].createdAt = "2026-02-01T00:00:00.000Z";

  const bound = bindRunId(ledger, "run-newest", "some dispatch text without a matching goal");
  assert.equal(bound?.task.id, "t2");
  assert.equal(bound?.rule, "newest");

  const shortGoals = emptyLedger();
  applyOpen(shortGoals, openInput("a", "cwd", "写笔记"));
  applyOpen(shortGoals, openInput("b", "cwd", "写报告"));
  shortGoals.tasks[0].createdAt = "2026-01-01T00:00:00.000Z";
  shortGoals.tasks[1].createdAt = "2026-02-01T00:00:00.000Z";
  // goal 少于 8 字符不参与匹配，因此即便派发文本包含「写笔记」也走 newest
  const shortBound = bindRunId(shortGoals, "run-short", "去做写笔记那件事");
  assert.equal(shortBound?.task.id, "t2");
  assert.equal(shortBound?.rule, "newest");
});

test("projectName normalises realpath and falls back to the raw cwd", async () => {
  const dir = await newHome();
  try {
    assert.ok(sameProject(await projectName(dir), basename(dir)));
    const missing = join(dir, "does", "not", "exist");
    assert.equal(await projectName(missing), missing, "realpath 失败时用 cwd 原值");
  } finally {
    await cleanup(dir);
  }
});