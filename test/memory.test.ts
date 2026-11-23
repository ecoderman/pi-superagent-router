import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionNote,
  assembleMemory,
  clampReports,
  emptySession,
  formatAuditLine,
  latestReports,
  makeAuditLine,
  parseAuditLine,
  parseMemoryBlocks,
  parseSessionState,
  serializeSession,
  truncateText,
  validateMemoryTarget,
} from "../src/memory.ts";
import {
  appendAudit,
  appendGlobalMemoryLocked,
  appendProjectMemoryLocked,
  appendSessionNoteLocked,
  applyOpen,
  emptyLedger,
  migrateMemory,
  memoryPath,
  pruneSessions,
  readAudit,
  readGlobalMemory,
  readProjectMemory,
  readSession,
  sessionPath,
} from "../src/store.ts";

async function newHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-router-memory-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function digestOptions(project = "alpha") {
  return { project, scope: "global" as const, maxOpenShown: 20 };
}

test("validateMemoryTarget rejects illegal scope/scopeId combinations", () => {
  assert.throws(() => validateMemoryTarget({ scope: "global", scopeId: "x" }), /memory scope:/);
  assert.throws(() => validateMemoryTarget({ scope: "audit", scopeId: "x" }), /memory scope:/);
  assert.throws(() => validateMemoryTarget({ scope: "project" }), /memory scope:/);
  assert.throws(() => validateMemoryTarget({ scope: "session", scopeId: "" }), /memory scope:/);
  assert.throws(() => validateMemoryTarget({ scope: "project", scopeId: "a/b" }), /memory scope:/);
  assert.throws(() => validateMemoryTarget({ scope: "session", scopeId: "a\\b" }), /memory scope:/);
  assert.throws(() => validateMemoryTarget({ scope: "project", scopeId: ".." }), /memory scope:/);
  assert.throws(() => validateMemoryTarget({ scope: "bogus" as never }), /memory scope:/);

  validateMemoryTarget({ scope: "global" });
  validateMemoryTarget({ scope: "audit" });
  validateMemoryTarget({ scope: "project", scopeId: "pi-router" });
  validateMemoryTarget({ scope: "session", scopeId: "session-1" });
});

test("assembleMemory orders four layers, emits (empty) and the manifest line", () => {
  const result = assembleMemory({
    global: "",
    project: "",
    projectName: "alpha",
    session: undefined,
    tasks: [],
    digestOptions: digestOptions(),
  });

  const text = result.text;
  const gi = text.indexOf("## global");
  const pi = text.indexOf("## project alpha");
  const si = text.indexOf("## session");
  const ti = text.indexOf("## open tasks");
  assert.ok(gi >= 0 && pi > gi && si > pi && ti > si);
  assert.ok(text.includes("## global\n(empty)"));
  assert.ok(text.includes("## project alpha\n(empty)"));
  assert.ok(text.includes("## session\n(empty)"));
  assert.ok(text.includes("## open tasks\n(empty)"));
  assert.ok(text.includes("budget: global 0/800 · project 0/1200 · session 0/600 · tasks 0/1400"));
  assert.ok(text.split("\n").length <= 60);
  assert.ok(text.length <= 4096);
  assert.deepEqual(
    result.layers.map((layer) => layer.layer),
    ["global", "project", "session", "tasks"],
  );
});

test("assembleMemory truncates each layer independently and reports it", () => {
  const ledger = emptyLedger();
  applyOpen(ledger, { key: "k", goal: "goal", project: "alpha", ownerSession: "s", cwd: "/a" });

  const result = assembleMemory({
    global: "g".repeat(1000),
    project: "p".repeat(1500),
    projectName: "alpha",
    session: { version: 1, sessionId: "s", project: "alpha", focus: "f".repeat(700), notes: [], updatedAt: "now" },
    tasks: ledger.tasks,
    digestOptions: digestOptions(),
  });

  assert.ok(result.text.includes("…(truncated 200 chars)"));
  assert.ok(result.text.includes("…(truncated 300 chars)"));
  const global = result.layers.find((layer) => layer.layer === "global");
  const project = result.layers.find((layer) => layer.layer === "project");
  const session = result.layers.find((layer) => layer.layer === "session");
  assert.equal(global?.truncated, true);
  assert.equal(global?.chars, 800);
  assert.equal(project?.truncated, true);
  assert.equal(project?.chars, 1200);
  assert.equal(session?.truncated, true);
  assert.ok(result.text.length <= 4096);
  assert.ok(result.text.split("\n").length <= 60);
});

test("assembleMemory appends read: task/<id> pointers and filters to the current project", () => {
  const ledger = emptyLedger();
  applyOpen(ledger, { key: "k1", goal: "goal one", project: "alpha", ownerSession: "s", cwd: "/a" });
  applyOpen(ledger, { key: "k2", goal: "goal two", project: "beta", ownerSession: "s", cwd: "/b" });

  const result = assembleMemory({
    global: "",
    project: "",
    projectName: "alpha",
    session: undefined,
    tasks: ledger.tasks,
    digestOptions: digestOptions(),
  });

  assert.ok(result.text.includes(" · read: task/t1"));
  assert.ok(result.text.includes("goal one"));
  assert.ok(!result.text.includes("goal two"));
});

test("assembleMemory enforces the 4096/60 hard caps with oversized budgets", () => {
  const result = assembleMemory({
    global: "g".repeat(6000),
    project: "",
    projectName: "alpha",
    session: undefined,
    tasks: [],
    digestOptions: digestOptions(),
    budget: { global: 10000, project: 1200, session: 600, tasks: 1400 },
  });

  assert.ok(result.text.length <= 4096);
  assert.ok(result.text.split("\n").length <= 60);
  assert.ok(result.text.includes("…(truncated)"));
  const lastLine = result.text.trimEnd().split("\n").pop();
  assert.ok(lastLine?.startsWith("budget: "));
});

test("assembleMemory recomputes manifest and layers.chars after the global cap", () => {
  const result = assembleMemory({
    global: "g".repeat(6000),
    project: "",
    projectName: "alpha",
    session: undefined,
    tasks: [],
    digestOptions: digestOptions(),
    budget: { global: 10000, project: 1200, session: 600, tasks: 1400 },
  });

  const global = result.layers.find((layer) => layer.layer === "global");
  assert.ok(global);
  assert.ok(global.chars > 0 && global.chars < 6000, `global chars 应反映封顶后实际值：${global.chars}`);
  const lastLine = result.text.trimEnd().split("\n").pop();
  assert.ok(lastLine?.includes(`global ${global.chars}/10000`), lastLine);
  assert.ok(lastLine?.includes("project 0/1200"), lastLine);
  assert.ok(result.text.length <= 4096);
});

test("session state round-trips and notes are capped at 50 FIFO with focus update", () => {
  const state = emptySession("s1", "alpha");
  assert.equal(state.version, 1);

  const focused = appendSessionNote(state, "note 1", "验证分层");
  assert.equal(focused.focus, "验证分层");
  assert.equal(focused.notes.length, 1);
  const parsed = parseSessionState(JSON.parse(serializeSession(focused)) as unknown);
  assert.deepEqual(parsed, focused);

  let filled = emptySession("s1", "alpha");
  for (let i = 0; i < 60; i += 1) filled = appendSessionNote(filled, `n${i}`);
  assert.equal(filled.notes.length, 50);
  assert.equal(filled.notes[0].text, "n10");
  assert.equal(filled.notes[49].text, "n59");

  assert.equal(parseSessionState("bad"), undefined);
  assert.equal(parseSessionState({ version: 2 }), undefined);
});

test("audit lines serialize, truncate text to 200 chars, and parse round-trip", () => {
  const line = { at: "iso", session: "s", project: "p", kind: "note" as const, text: "x".repeat(250) };
  const json = formatAuditLine(line);
  const parsedJson = JSON.parse(json) as { text: string };
  assert.equal(parsedJson.text.length, 200);
  assert.ok(json.includes(`"text":"${"x".repeat(200)}"`));

  assert.equal(truncateText("abc", 2), "ab");
  assert.equal(truncateText("abc"), "abc");

  const parsed = parseAuditLine(JSON.parse(json) as unknown);
  assert.equal(parsed?.kind, "note");
  assert.equal(parsed?.text?.length, 200);
  assert.equal(parseAuditLine({ at: "a" }), undefined);
});

test("makeAuditLine assembles required fields for task_open/task_update/dispatch", () => {
  const opened = makeAuditLine({ at: "iso", session: "s", project: "alpha", kind: "task_open", taskId: "t1" });
  assert.deepEqual(opened, { at: "iso", session: "s", project: "alpha", kind: "task_open", taskId: "t1" });

  const updated = makeAuditLine({
    at: "iso",
    session: "s",
    project: "beta",
    kind: "task_update",
    taskId: "t2",
    reason: "blocked_question",
    text: "need input",
  });
  assert.deepEqual(updated, {
    at: "iso",
    session: "s",
    project: "beta",
    kind: "task_update",
    taskId: "t2",
    reason: "blocked_question",
    text: "need input",
  });

  const dispatched = makeAuditLine({
    at: "iso",
    session: "s",
    project: "alpha",
    kind: "dispatch",
    taskId: "t1",
    runId: "run-1",
  });
  assert.deepEqual(dispatched, {
    at: "iso",
    session: "s",
    project: "alpha",
    kind: "dispatch",
    taskId: "t1",
    runId: "run-1",
  });
});

test("parseMemoryBlocks splits project-tagged and global blocks preserving text", () => {
  const text = [
    "## 2026-01-01T00:00:00.000Z [alpha] decision",
    "alpha body",
    "",
    "## 2026-01-02T00:00:00.000Z global decision",
    "global body",
    "## 2026-01-03T00:00:00.000Z [beta] plan",
    "beta body",
  ].join("\n");

  const parsed = parseMemoryBlocks(text);
  assert.equal(parsed.global.length, 1);
  assert.ok(parsed.global[0].includes("global decision"));
  assert.ok(parsed.global[0].includes("global body"));
  assert.equal(parsed.projects.alpha.length, 1);
  assert.equal(parsed.projects.beta.length, 1);
  assert.ok(parsed.projects.alpha[0].includes("[alpha] decision"));
  assert.ok(parsed.projects.beta[0].includes("beta body"));
});

test("clampReports clamps to 0..20 with default 5", () => {
  assert.equal(clampReports(undefined), 5);
  assert.equal(clampReports(-2), 0);
  assert.equal(clampReports(0), 0);
  assert.equal(clampReports(7), 7);
  assert.equal(clampReports(100), 20);
});

test("latestReports returns the last N reports and is empty for zero", () => {
  const reports = [
    { at: "iso1", status: "progress" as const, summary: "r1" },
    { at: "iso2", status: "ready" as const, summary: "r2" },
    { at: "iso3", status: "failed" as const, summary: "r3" },
  ];

  assert.deepEqual(latestReports(reports, 0), []);
  assert.deepEqual(latestReports(reports, 2), reports.slice(1));
  assert.deepEqual(latestReports(reports, 5), reports);
});

test("session files persist notes and focus under the ledger lock", async () => {
  const home = await newHome();
  try {
    assert.equal(await readSession(home, "s1"), undefined);
    const first = await appendSessionNoteLocked(home, "s1", "alpha", "note 1", "focus A");
    assert.equal(first.focus, "focus A");
    assert.equal(first.notes.length, 1);
    const second = await appendSessionNoteLocked(home, "s1", "alpha", "note 2");
    assert.equal(second.focus, "focus A");
    assert.equal(second.notes.length, 2);

    const restored = await readSession(home, "s1");
    assert.equal(restored?.sessionId, "s1");
    assert.equal(restored?.project, "alpha");
    assert.equal(restored?.focus, "focus A");
    assert.equal(restored?.notes.length, 2);
  } finally {
    await cleanup(home);
  }
});

test("pruneSessions removes session files older than 7 days", async () => {
  const home = await newHome();
  try {
    await appendSessionNoteLocked(home, "old", "alpha", "note");
    await appendSessionNoteLocked(home, "new", "alpha", "note");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(sessionPath(home, "old"), old, old);
    await pruneSessions(home);
    assert.equal(await readSession(home, "old"), undefined);
    assert.ok(await readSession(home, "new"));
  } finally {
    await cleanup(home);
  }
});

test("audit appends one JSON line per write and readAudit filters by project and limit", async () => {
  const home = await newHome();
  try {
    await appendAudit(home, { at: "iso1", session: "s", project: "alpha", kind: "note", text: "a1" });
    await appendAudit(home, { at: "iso2", session: "s", project: "beta", kind: "note", text: "b1" });
    await appendAudit(home, { at: "iso3", session: "s", project: "alpha", kind: "task_open", taskId: "t1" });

    const all = await readAudit(home);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((line) => line.project), ["alpha", "beta", "alpha"]);

    const alpha = await readAudit(home, { project: "ALPHA" });
    assert.equal(alpha.length, 2);
    assert.ok(alpha.every((line) => line.project === "alpha"));

    const lastTwo = await readAudit(home, { limit: 2 });
    assert.deepEqual(lastTwo.map((line) => line.project), ["beta", "alpha"]);
  } finally {
    await cleanup(home);
  }
});

test("appendAudit never mutates global.md or project memory files", async () => {
  const home = await newHome();
  const globalFile = join(home, "global.md");
  const projectFile = join(home, "projects", "alpha.md");
  try {
    await appendGlobalMemoryLocked(home, "global memory body");
    await appendProjectMemoryLocked(home, "alpha", "project memory body");

    const beforeGlobal = await stat(globalFile);
    const beforeProject = await stat(projectFile);
    const globalText = await readFile(globalFile, "utf8");
    const projectText = await readFile(projectFile, "utf8");

    await appendAudit(home, { at: "iso", session: "s", project: "alpha", kind: "note", text: "audit only" });

    const afterGlobal = await stat(globalFile);
    const afterProject = await stat(projectFile);
    assert.equal(afterGlobal.mtimeMs, beforeGlobal.mtimeMs);
    assert.equal(afterProject.mtimeMs, beforeProject.mtimeMs);
    assert.equal(await readFile(globalFile, "utf8"), globalText);
    assert.equal(await readFile(projectFile, "utf8"), projectText);
  } finally {
    await cleanup(home);
  }
});

test("migrateMemory splits legacy memory.md, renames it, and is idempotent", async () => {
  const home = await newHome();
  try {
    await writeFile(
      memoryPath(home),
      [
        "## 2026-01-01T00:00:00.000Z [alpha] decision",
        "alpha body",
        "",
        "## 2026-01-02T00:00:00.000Z plain",
        "global body",
      ].join("\n"),
      "utf8",
    );

    const first = await migrateMemory(home);
    assert.equal(first.warning, undefined);

    const entries = await readdir(home);
    assert.ok(!entries.includes("memory.md"));
    assert.equal(entries.filter((entry) => entry.startsWith("memory.md.migrated-")).length, 1);

    const globalText = await readGlobalMemory(home);
    assert.ok(globalText.includes("## 2026-01-02T00:00:00.000Z plain"));
    assert.ok(globalText.includes("global body"));
    assert.ok(globalText.includes("<!-- migrated from memory.md at "));

    const projectText = await readProjectMemory(home, "alpha");
    assert.ok(projectText.includes("[alpha] decision"));
    assert.ok(projectText.includes("alpha body"));
    assert.ok(projectText.includes("<!-- migrated from memory.md at "));

    const audit = await readAudit(home);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].kind, "migrate");
    assert.ok(audit[0].text?.includes("imported 2 blocks (global 1, project 1)"));

    const second = await migrateMemory(home);
    assert.equal(second.warning, undefined);
    assert.equal((await readdir(home)).filter((entry) => entry.startsWith("memory.md.migrated-")).length, 1);
  } finally {
    await cleanup(home);
  }
});

test("migrateMemory keeps the original file when parsing fails", async () => {
  const home = await newHome();
  try {
    const original = "not a memory block\njust text";
    await writeFile(memoryPath(home), original, "utf8");
    const result = await migrateMemory(home);
    assert.ok(result.warning?.includes("迁移失败"));
    assert.equal(await readFile(memoryPath(home), "utf8"), original);
    assert.equal(await readGlobalMemory(home), "");
    assert.equal(await readProjectMemory(home, "alpha"), "");
  } finally {
    await cleanup(home);
  }
});

test("memory write paths reject path-escaping scopeIds", async () => {
  const home = await newHome();
  try {
    await assert.rejects(appendProjectMemoryLocked(home, "../evil", "text"), /memory scope:/);
    await assert.rejects(appendSessionNoteLocked(home, "a/b", "alpha", "text"), /memory scope:/);
    await assert.rejects(appendSessionNoteLocked(home, "..", "alpha", "text"), /memory scope:/);
  } finally {
    await cleanup(home);
  }
});

test("migrateMemory rejects escaped [project] tags and keeps the legacy file", async () => {
  const home = await newHome();
  const original = [
    "## 2026-01-01T00:00:00.000Z [../../evil] decision",
    "evil body",
    "",
    "## 2026-01-02T00:00:00.000Z plain",
    "global body",
  ].join("\n");
  try {
    await writeFile(memoryPath(home), original, "utf8");
    const result = await migrateMemory(home);
    assert.ok(result.warning?.includes("迁移失败"), result.warning);
    assert.equal(await readFile(memoryPath(home), "utf8"), original);
    assert.equal(await readGlobalMemory(home), "");
    assert.equal(await readProjectMemory(home, "alpha"), "");
    await assert.rejects(readFile(join(home, "projects", "..", "..", "evil.md"), "utf8"));
  } finally {
    await cleanup(home);
  }
});
