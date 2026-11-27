# pi-superagent-router

**English** · [中文](README.zh-CN.md)

![ci](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

**A minimal super-agent extension for the [pi coding agent](https://github.com/badlogic/pi-mono).**
The session you talk to stops writing code: it decides what to do, hands the work to workers, keeps the ledger, and remembers only what you approve.

> **0.5.0 · memory layer rebuilt.** ~2.5k lines of source, no runtime dependencies, no daemon, no database.

## The problem

**A coding session goes blunt.** Its context fills with tool output, and you can only keep three to five sessions in view — so attention, not the model, caps how much runs at once. More instructions do not fix it: the orchestrator's context is the bottleneck, and every added instruction competes with the task itself.

**Split deciding from doing.** A read-only Router judges, dispatches and keeps the ledger; each worker does the work in its own session and reports back a summary.

**The effect.** Your session stays one screen long, every change keeps its report, reason code and run id, and a wrong result can be traced back to the task that produced it.

## Architecture

### How it ships

A **pi extension**: no event intake, no rebuilt concurrency layer, no second CLI to wire in. Install is two commands and it works immediately — almost zero configuration.

### Project layout

```
src/
  index.ts     tools, commands, events, read-only enforcement
  store.ts     ledger, candidates, project memory, audit, events, file lock
  memory.ts    layers, injection assembly, date-section rendering
  prompt.ts    router rules + digest
  guard.ts     keep-list and call blocking
  inspect.ts   fixed-argv repository inspection
  workers.ts   run-directory discovery and status
  config.ts    router.json parsing
  types.ts
agents/router-worker.md    the worker definition (may spawn nested subagents)
test/                      six files, 78 cases
examples/router.json
.github/workflows/ci.yml
```

### Agent hierarchy

```
you
└── Router  (main session)      read · inspect · dispatch · record     no write / edit / bash
    └── worker  (own session)   read · write · edit · bash · subagent
        └── nested worker       same capabilities
```

- A worker never sees the Router's conversation; the Router never sees a worker's transcript, only its reports.
- The ledger is trustworthy because the session keeping the books cannot touch what it reports on.

### Design principles

1. **The orchestrator is read-only** — otherwise you can never say who made a change.
2. **Only summaries cross the boundary** — detail is a pointer, not a payload.
3. **Write rights follow blast radius** — the model writes what is scoped to one session or one repo; cross-project rules need a human.
4. **The injected context is bounded** — 4096 characters / 60 lines per turn, with a `budget:` line saying what was cut.
5. **Nothing waits** — dispatch returns, reports arrive as messages, no polling.

## How it works

### One dispatch, end to end

| Step | Who | What happens |
| --- | --- | --- |
| 1. open | Router | A task is a goal, a boundary, an acceptance check, the deliverables, and what to do on failure. The `key` makes it idempotent: resubmitting the same goal never opens a second task. |
| 2. dispatch | Router | `subagent({ agent: "router-worker", task, cwd, worktree })` — pi-subagents' own tool, with its own session. |
| 3. bind | extension | The `runId` is bound to the task automatically, so the record points at the run that did the work. |
| 4. work | worker | Reads, writes, edits, runs commands, may spawn nested workers. It cannot see the Router's conversation. |
| 5. report | worker | One report per checkpoint: `progress` / `blocked` / `ready` / `failed` / `dropped`, plus an optional reason code and question. |
| 6. record | Router | Updates the ledger, decides the next step, and only interrupts you when the task is blocked or needs a decision. |
| 7. verify | you | `/router task t1` shows the report timeline; `/router audit` shows what you approved. |

Two rules keep this from degrading. **Only summaries cross**: a task occupies one line, detail sits behind `read: task/t1`. **Nothing waits**: dispatch returns immediately, reports arrive as messages, no polling and no sleeping.

```
you     tidy up the locking in src/store.ts, fix any path that forgets to release, keep the tests green
Router  t1 opened · dispatched · boundary: src/store.ts
        acceptance: every lock released, existing tests green
  ...
Router  t1 done · 1 file · run 4c1e · detail: read: task/t1
```

### Permissions: three walls

| Wall | How it is enforced |
| --- | --- |
| The Router cannot change code | `write` / `edit` / `apply*` are blocked at the tool layer; so are `bash`, `powershell`, `cp`, `mv`, `rm`. `router_inspect` (`git-status` / `git-log` / `git-diff` / `tree`, fixed argv) replaces the shell. |
| The Router cannot write its own rules | It can write project memory and candidates, but has no tool for `global.md` and no promote command. Cross-project rules only enter through a human. |
| Workers cannot see the conversation | Separate sessions. Only the report crosses the boundary. |

### Memory: four layers plus a review queue

| Layer | File | Writer | Lifetime | Injected |
| --- | --- | --- | --- | --- |
| global | `global.md` (in home) | **human** (`/router promote`) | permanent | all of it |
| project | `<repo>/.pi/memory.md` | **model** (`router_project_note`) | lives with the repo | newest date sections |
| session | `sessions/<id>.json` | model (`router_note`) | pruned after 7 days, 50 notes max | yes |
| candidates | `candidates.md` (in home) | **model** (`router_candidate`) | until a human decides, 5 open max | **count only** |

**Layers are split by blast radius, not by how important a fact feels.** A wrong project note ruins one repo, so the model writes it. A wrong cross-project rule silently changes behaviour everywhere, so a human signs it.

**Project memory lives with the repo**: `<repo>/.pi/memory.md`, one date section per day, every line carrying its source. That makes `git diff` the audit trail — reviewable, revertible, and it survives a machine swap.

```markdown
## 2026-11-25
- Tests run with node --test, no jest. (source t4)
- The lock file is tasks.lock; do not mix in a second lock. (source t2)
```

Injection takes **newest sections first** until the 1,200-character project budget is full; older sections are dropped whole and marked `…(N older sections omitted)`.

### The review queue: the model nominates, you decide

`candidates.md` holds only judgements that are **about the user and true across repos**, one per line, always with a source:

```markdown
- [c1] User prefers commit messages in Chinese. (source t4 / 2026-11-25)
- [c2] User wants the conclusion before the process. (source t9 / 2026-11-26) · promoted 2026-11-27
```

Four rules: text ≤200 chars, a source is mandatory, at most 5 open candidates, and **candidate text is never injected** — an unapproved judgement must not change behaviour. Only the count appears, on the `budget:` line.

### Audit: only human decisions

`audit.jsonl` is not an operations log; it is a **signature book** — who gave the AI which power, and when.

| kind | When it appears |
| --- | --- |
| `promote` | you approved a candidate into `global.md` |
| `revoke` | you withdrew a global rule |
| `grant` | you changed what the AI may write (e.g. project memory) |
| `migrate` | one-off migration of old memory |

```jsonl
{"n":1,"at":"2026-11-25T10:02:11Z","kind":"promote","target":"global","candidate":"c1","source":"t4 / 2026-11-25","text":"User prefers commit messages in Chinese."}
```

`n` is a monotonically increasing number; `/router revoke <n>` uses it. Opening, dispatching and updating tasks are **not** audited — those facts live in `tasks.json` and git, and putting them here only drowns the handful of lines that matter.

### Work events: shape only, never the source of truth

`events.jsonl` records "when, which task, from which state to which", about 100 bytes a line, never report text:

```jsonl
{"at":"09:08:45","kind":"open","taskId":"t1","project":"router-demo","session":"01a2…"}
{"at":"09:08:47","kind":"dispatch","taskId":"t1","runId":"f4c10a5c"}
{"at":"09:08:47","kind":"status","taskId":"t1","from":"queued","to":"running"}
{"at":"09:14:58","kind":"status","taskId":"t1","from":"running","to":"done"}
```

It exists for one reason: `tasks.json` holds only current values, so it cannot answer "how long did this take, what was the peak parallelism, how much time went into waiting" — and those are the only evidence that attention, not the model, is the limit. Writes are best-effort; reads always trust `tasks.json`.

### Memory injection: bounded every turn

Before each turn the extension assembles the block from disk (not from the conversation, so it is a bounded snapshot rather than an accumulation):

| Layer | Budget (chars) | What it carries |
| --- | --- | --- |
| global | 800 | cross-project principles (8–12 lines) |
| project | 1,200 | the newest date sections of this repo |
| session | 600 | focus and notes for this session |
| tasks | 1,400 | open tasks for this repo, one line each |
| **total** | **4,096 chars / 60 lines** | manifest line included |

When it overflows, whole layers are dropped **from the end backwards** — tasks, then session, then project, with `global` always surviving — and the last surviving layer is truncated. Every cut is visible:

```
## session
…(truncated 120 chars)
## open tasks
t1 [done] snake-html-game — … · read: task/t1
…
budget: global 320/800 · project 900/1200 · session 480/600 · tasks 0/1400 · candidates 2 pending
```

Two gates keep the window from filling up. **Summarise first**: a task is one line (key 40 / goal 80 / last report 60 / next 60), detail is a pointer. **Cap second**: the budgets above. The cap covers the injected memory block, not the whole input — the conversation history is the host's to compact, and this extension does not reimplement it.

## Quick start

```bash
pi install npm:pi-subagents
pi install git:github.com/ecoderman/pi-superagent-router
```

```bash
cd your-project && pi
```

Everyday use is plain language. Slash commands are just shortcuts for it:

```
> tidy up the locking in src/store.ts, fix any path that forgets to release, keep the tests green
Router  t1 opened · dispatched · boundary: src/store.ts
        acceptance: every lock released, existing tests green
  ...
Router  t1 done · 1 file · run 4c1e · detail: read: task/t1
```

```
/router new add a CONTRIBUTING.md and link it from the README   # same thing, as a command
/router status                                                   # one line per open task
/router task t1                                                  # what it did, and why
/router candidates                                               # candidates awaiting review
/router promote c1                                               # approve c1 into global.md
/router audit                                                    # what I approved
/router revoke 3                                                 # withdraw audit line 3
```

> **Read-only mode comes first.** Every session that loads this extension becomes a read-only Router, including the one you code in. Disable with `{"routerReadOnly": false}` in `~/.pi/agent/router.json`, or use `pi -ne`.

## Requirements

| Requirement | Why |
| --- | --- |
| [pi](https://github.com/badlogic/pi-mono) `>= 1.5` | host runtime |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | the `subagent` tool and worker runtime; without it the Router can only keep books |
| Node.js `>= 20` | pi loads the extension as TypeScript; the test suite needs `>= 22.6` |

`router-worker` ships in the package (`"pi": { "subagents": { "agents": ["./agents"] } }`), no manual copy.

## Tools

| Tool | Purpose |
| --- | --- |
| `router_task_open` / `_update` / `_list` / `_get` | ledger: idempotent by key, reason codes, detail on demand |
| `router_project_note` | write project memory (in-repo, date section, with source) |
| `router_note` | session memory: focus + short notes |
| `router_candidate` | nominate a cross-project memory candidate (≤200 chars, source required) |
| `router_memory_read` | read `global` / `project` / `session` / `candidates` |
| `router_workers` | runId, state, session path, last report |
| `router_inspect` | `git-status` / `git-log` / `git-diff` / `tree`, fixed argv |

Dispatching uses pi-subagents' own `subagent` tool — not wrapped, not reimplemented.

## Commands

| Command | What it does |
| --- | --- |
| `/router status` | one line per open task, plus open / running / needs-human counts |
| `/router tasks` | alias of `status` |
| `/router task <id>` | full report timeline for one task |
| `/router digest` | the exact block injected into the prompt this turn — what the model actually sees |
| `/router memory [scope] [query]` | read `global` / `project` / `session` / `candidates`; `query` filters lines |
| `/router candidates` | open candidates, with `[cN]` ids |
| `/router promote <cN>` | approve a candidate into `global.md` and append one audit line |
| `/router revoke <n>` | withdraw the global rule recorded by audit line `n` |
| `/router audit` | audit view, newest first, human decisions only |
| `/router session` | this session's focus and recent notes |
| `/router new <goal>` | open a task and dispatch it (the command form of saying the goal) |
| `/router spawn <id>` | dispatch a queued task that was opened but never sent |

## Configuration

`~/.pi/agent/router.json`, all optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `scope` | `"global"` | one shared home, or `project` for `<cwd>/.pi/router` |
| `home` | `~/.pi/agent/router` | storage root (`PI_ROUTER_HOME` overrides) |
| `routerReadOnly` | `true` | remove and block `write` / `edit` / `bash` |
| `workerModel` | `null` | hint only; this extension never dispatches workers |
| `maxOpenShown` | `20` | task rows shown in the digest |

## Where state lives

| File | Holds | Writer |
| --- | --- | --- |
| `tasks.json` | current task values + report chains | extension |
| `events.jsonl` | state transitions and dispatches, shape only | extension (best-effort) |
| `global.md` | cross-project rules | human (promote) |
| `candidates.md` | candidates awaiting review | model |
| `audit.jsonl` | approvals and withdrawals | human |
| `sessions/<id>.json` | session drafts | model, 7-day TTL |
| `<repo>/.pi/memory.md` | project memory | model |

With `scope: "project"` the first six move into `<cwd>/.pi/router`; project memory always stays in the repo.

## Limitations

- **Not a sandbox.** Workers run with your permissions, no approval prompt. Use `worktree: true` when several touch one repo.
- **Not an autonomous coder.** It dispatches the goals you give it; it does not plan your project.
- **Not a workflow engine.** Parallelism, retries, worktrees and missions are pi-subagents' job.
- **Not event-driven.** It listens to you, not to GitHub, Feishu or CI.
- **Candidates never self-activate.** Global rules require a human; that is a design constraint, not a backlog item.
- **No history paging.** Detail is the last 20 reports per task; earlier ones stay in the ledger but have no tool to page them.
- **No report archiving yet.** The ledger only grows; the threshold for splitting it is 5 MB or 200 ms load time.
- **Not stable.** `0.x`: the tool surface may change between minor versions.

## Tests

78 unit tests, `tsc --noEmit` clean. CI: suite on Node 22/24, typecheck on Node 20. Verified with `pi install` in a clean project: ten `router_*` tools, no `write`, `router-worker` discovered, one real dispatch produced a file with an auto-bound runId.

## Credits

Execution, concurrency and worktree isolation: [`pi-subagents`](https://github.com/nicobailon/pi-subagents). The router / worker split, ticket ledger and scoped write permissions were inspired by DeepSeek's [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT). This is an independent, unofficial minimal implementation, unaffiliated with either project. MIT licensed.