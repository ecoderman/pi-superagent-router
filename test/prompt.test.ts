import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, EMPTY_DIGEST_LINE, ROUTER_RULES } from "../src/prompt.ts";
import { applyOpen, emptyLedger } from "../src/store.ts";

test("ROUTER_RULES keeps the non-negotiable constraints", () => {
  // 只读：不许自己改文件
  assert.ok(ROUTER_RULES.includes("你不能修改文件"));
  assert.ok(ROUTER_RULES.includes("router_inspect"));
  // 写权限：模型只能写 session / audit
  assert.ok(ROUTER_RULES.includes("router_note"));
  assert.ok(ROUTER_RULES.includes("/router promote"));
  assert.ok(!ROUTER_RULES.includes("写 global/project 记忆"));
  // 不等待、不轮询
  assert.ok(ROUTER_RULES.includes("不 sleep、不轮询"));
});

test("ROUTER_RULES makes the read: task/<id> pointer actionable", () => {
  assert.ok(ROUTER_RULES.includes("read: task/<id>"));
  assert.ok(ROUTER_RULES.includes("router_task_get"));
  // 明确“汇报前必须先 deref”
  assert.ok(ROUTER_RULES.includes("needs-human"));
  assert.ok(ROUTER_RULES.includes("向用户汇报"));
  // 明确分页语义，避免模型以为拿到的是全量
  assert.ok(ROUTER_RULES.includes("最近 5 条"));
  assert.ok(ROUTER_RULES.includes("20"));
});

test("digest rows carry a read: pointer for every shown task", () => {
  const ledger = emptyLedger();
  applyOpen(ledger, { key: "k1", goal: "目标一", project: "alpha", ownerSession: "s", cwd: "/tmp" });
  applyOpen(ledger, { key: "k2", goal: "目标二", project: "alpha", ownerSession: "s", cwd: "/tmp" });
  const digest = buildDigest(ledger.tasks, { project: "alpha", scope: "project", maxOpenShown: 20 });
  assert.ok(digest.includes("read: task/t1"), digest);
  assert.ok(digest.includes("read: task/t2"), digest);
  assert.equal(digest.split("read: task/").length - 1, 2);
});

test("empty ledger still reports open tasks: none", () => {
  const digest = buildDigest(emptyLedger().tasks, { project: "alpha", scope: "project", maxOpenShown: 20 });
  assert.ok(digest.startsWith("global: 0 open"), digest);
  assert.ok(digest.includes(EMPTY_DIGEST_LINE), digest);
  assert.ok(!digest.includes("read: task/"));
});
