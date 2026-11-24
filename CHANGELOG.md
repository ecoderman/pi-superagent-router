# Changelog

> **0.4.0 is the first public release.** Entries below it were internal
> development milestones and were never published; they are kept here as a
> record of how the design evolved.

## 0.4.0 — first public release

- `package.json`: declare `pi.subagents.agents = ["./agents"]` so `router-worker`
  is discovered straight from the package (no manual copy).
- Add `LICENSE` (MIT), `CHANGELOG.md`, `examples/`, and GitHub Actions CI
  (Node 20/24: `tsc --noEmit` + `npm test`).
- Pin host packages in `devDependencies` for reproducible typechecks; they stay
  `peerDependencies: "*"` at runtime.
- README rewritten as user-facing documentation (English + full Chinese).
- Development specs, plans, reviews and fix logs removed from the tree; they
  remain in git history (`git show <tag>:docs/BRIEF-v3.md`).

## 0.3.2 — actionable read pointers

- `buildDigest` rows now carry `· read: task/<id>` like the assembled tasks layer.
- Two new router rules: dereference with `router_task_get` before reporting or for
  `needs-human` tasks; reports default to the latest 5, pass `reports` (max 20) for more.
- New `test/prompt.test.ts`.

## 0.3.1 — v3 review follow-ups

- Removed dead v2 memory helpers; tests now exercise the scoped stores.
- Migration writes each target atomically (temp+rename) and skips files that
  already carry the migration marker, so re-runs are idempotent.
- `formatAuditView()` numbers audit lines newest-first to match `/router promote <n>`.

## 0.3.0 — layered memory and write-permission boundary

- Four scoped stores: `global.md`, `projects/<project>.md`, `sessions/<id>.json`,
  `audit.jsonl`; `memory.md` migrated once and renamed `.migrated-<ts>`.
- `assembleMemory()`: per-layer budgets, 4096 chars / 60 lines cap, empty-layer
  markers, `read: task/<id>` pointers, `budget:` manifest.
- New tools `router_note` and `router_task_get`; `router_memory_append` narrowed
  to audit only; `/router promote` lets a human promote audit lines.
- `scopeId` escape guards (`/`, `\`, `..`) enforced on every write path.

## 0.2.2 — manual commands

- `/router new <goal>` and `/router spawn <id>`.

## 0.2.1 — runId binding

- Bind a dispatched `subagent` run to the most likely task: single candidate, else
  goal-text match, else newest; report the choice when it was heuristic.

## 0.2.0 — global assistant

- Ledger moved to a shared home (`~/.pi/agent/router`), schema v2 with `project`
  and `ownerSession`; v1 ledgers migrated automatically.
- File lock (wx + backoff + stale takeover) around every write.
- Hard read-only Router: `setActiveTools` keeps 12 entries, `tool_call` blocks
  writes/shell, `router_inspect` replaces bash.
- `router_workers` lists workers with run ids and session paths.

## 0.1.0 — first release

- Five ledger tools, digest injection, `/router` command, atomic ledger writes,
  corrupted-ledger recovery, worker agent definition, 8 tests.
