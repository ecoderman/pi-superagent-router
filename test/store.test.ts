import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMemory,
  applyOpen,
  applyUpdate,
  clip,
  countBy,
  emptyLedger,
  findOpen,
  formatTaskRow,
  loadLedger,
  nextId,
  readMemory,
  routerDir,
  saveLedger,
  tasksPath,
} from "../src/store.ts";
import { buildDigest } from "../src/prompt.ts";

async function newCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-router-"));
}

async function cleanup(cwd: string): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
}

test("idempotent open reuses an open task, reopens after terminal", async () => {
  const cwd = await newCwd();
  try {
    const ledger = emptyLedger();
    const first = applyOpen(ledger, { key: "build-x", goal: "build x", cwd });
    await saveLedger(cwd, ledger);

    const second = applyOpen(ledger, { key: "build-x", goal: "build x", cwd });
    await saveLedger(cwd, ledger);

    assert.equal(second.created, false);
    assert.equal(second.task.id, first.task.id);
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.seq, 1);

    applyUpdate(ledger, first.task.id, { status: "done" });
    await saveLedger(cwd, ledger);

    const reopened = applyOpen(ledger, { key: "build-x", goal: "build x", cwd });
    assert.equal(reopened.created, true);
    assert.notEqual(reopened.task.id, first.task.id);
    assert.equal(ledger.tasks.length, 2);
    assert.equal(ledger.seq, 2);
  } finally {
    await cleanup(cwd);
  }
});

test("report append keeps ISO timestamps and question", async () => {
  const cwd = await newCwd();
  try {
    const ledger = emptyLedger();
    const { task } = applyOpen(ledger, { key: "k", goal: "g", cwd });

    applyUpdate(ledger, task.id, { report: { status: "progress", summary: "first", question: "q?" } });
    applyUpdate(ledger, task.id, { report: { status: "ready", summary: "second" } });

    assert.equal(task.reports.length, 2);
    assert.ok(!Number.isNaN(Date.parse(task.reports[0].at)));
    assert.ok(!Number.isNaN(Date.parse(task.reports[1].at)));
    assert.ok(Date.parse(task.reports[0].at) <= Date.parse(task.reports[1].at));
    assert.equal(task.reports[0].question, "q?");
    assert.equal(task.reports[1].question, undefined);
    assert.ok(!Number.isNaN(Date.parse(task.updatedAt)));
  } finally {
    await cleanup(cwd);
  }
});

test("digest enforces 40 line / 4096 char caps and truncation marker", async () => {
  const cwd = await newCwd();
  try {
    const ledger = emptyLedger();
    for (let i = 0; i < 30; i += 1) {
      applyOpen(ledger, { key: `k${i}`, goal: `goal-${i}`, cwd });
    }
    const digest = buildDigest(ledger.tasks);
    assert.ok(digest.includes("…(truncated)"));
    assert.ok(digest.split("\n").length <= 40);
    assert.ok(digest.length <= 4096);
    const taskRows = digest.split("\n").filter((l) => /^t\d+ /.test(l));
    assert.ok(taskRows.length <= 20);

    // long fields are clipped to their budgets (ellipsis counts toward the budget)
    const long = emptyLedger();
    const goal = "g".repeat(200);
    const next = "n".repeat(200);
    applyOpen(long, { key: "long", goal, cwd });
    applyUpdate(long, "t1", { report: { status: "ready", summary: "s".repeat(200) }, next });
    const longDigest = buildDigest(long.tasks);
    assert.ok(longDigest.includes(clip(goal, 80)));
    assert.ok(longDigest.includes(clip("s".repeat(200), 60)));
    assert.ok(longDigest.includes(clip(next, 60)));
    assert.ok(!longDigest.includes("g".repeat(81)));
  } finally {
    await cleanup(cwd);
  }
});

test("digest returns fixed empty text when no open tasks", () => {
  const ledger = emptyLedger();
  assert.equal(buildDigest(ledger.tasks), "open tasks: none");

  applyOpen(ledger, { key: "k", goal: "g", cwd: "x" });
  applyUpdate(ledger, "t1", { status: "done" });
  assert.equal(buildDigest(ledger.tasks), "open tasks: none");
});

test("atomic save leaves no tmp files and round-trips", async () => {
  const cwd = await newCwd();
  try {
    const ledger = emptyLedger();
    applyOpen(ledger, { key: "k", goal: "g", cwd });
    applyUpdate(ledger, "t1", { runId: "run-1", status: "running" });
    await saveLedger(cwd, ledger);
    await saveLedger(cwd, ledger);

    const entries = await readdir(routerDir(cwd));
    assert.ok(entries.includes("tasks.json"));
    assert.ok(!entries.some((e) => e.endsWith(".tmp")));

    const { ledger: restored, warning } = await loadLedger(cwd);
    assert.equal(warning, undefined);
    assert.equal(restored.tasks.length, 1);
    assert.equal(restored.tasks[0].runId, "run-1");
    assert.equal(restored.tasks[0].status, "running");
  } finally {
    await cleanup(cwd);
  }
});

test("corrupted ledger is backed up and reset with a warning", async () => {
  const cwd = await newCwd();
  try {
    const ledger = emptyLedger();
    applyOpen(ledger, { key: "k", goal: "g", cwd });
    await saveLedger(cwd, ledger);

    await writeFile(tasksPath(cwd), "{not valid json", "utf8");
    const { ledger: reset, warning } = await loadLedger(cwd);

    assert.ok(warning !== undefined);
    assert.equal(reset.tasks.length, 0);

    const entries = await readdir(routerDir(cwd));
    assert.ok(entries.some((e) => e.startsWith("tasks.json.bak-")));

    const reledger = emptyLedger();
    applyOpen(reledger, { key: "k2", goal: "g2", cwd });
    await saveLedger(cwd, reledger);
    const { ledger: restored } = await loadLedger(cwd);
    assert.equal(restored.tasks.length, 1);
  } finally {
    await cleanup(cwd);
  }
});

test("unknown id throws; memory appends and reads", async () => {
  const cwd = await newCwd();
  try {
    assert.throws(() => applyUpdate(emptyLedger(), "t999", {}), /no task t999/);

    assert.equal(await readMemory(cwd), "");
    await appendMemory(cwd, "decision", "why split this way");
    await appendMemory(cwd, "change", "switched approach");
    const text = await readMemory(cwd);
    assert.ok(text.includes("## "));
    assert.ok(text.includes("decision"));
    assert.ok(text.includes("switched approach"));

    const direct = await readFile(join(routerDir(cwd), "memory.md"), "utf8");
    assert.equal(direct, text);
  } finally {
    await cleanup(cwd);
  }
});

test("pure helpers behave at boundaries", () => {
  assert.equal(clip("abc", 1), "…");
  assert.equal(clip("abc", 4), "abc");
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip("", 10), "");

  const ledger = emptyLedger();
  assert.equal(nextId(ledger), "t1");
  applyOpen(ledger, { key: "a", goal: "A", cwd: "c" });
  assert.equal(nextId(ledger), "t2");
  assert.equal(findOpen(ledger, "a")?.id, "t1");
  assert.equal(findOpen(ledger, "missing"), undefined);
  assert.equal(countBy(ledger.tasks, "queued"), 1);
  assert.equal(countBy(ledger.tasks, "running"), 0);

  applyUpdate(ledger, "t1", { runId: "r1", report: { status: "progress", summary: "working" } });
  const row = formatTaskRow(ledger.tasks[0]);
  assert.ok(row.startsWith("t1 [queued] a run:r1"));
  assert.ok(row.includes("last: progress"));
});