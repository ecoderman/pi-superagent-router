# pi-superagent-router

**English** · [中文](README.zh-CN.md)

![ci](https://github.com/ecoderman/pi-superagent-router/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

**A minimal super-agent extension for the [pi coding agent](https://github.com/badlogic/pi-mono).**
The session you talk to stops writing code: it decides what to do, hands the work to workers, and keeps the ledger.

> **0.4.0 · first public release.** ~1k lines, no runtime dependencies, no daemon, no database.

## The problem

**A coding session goes blunt.** Its context fills with tool output, and you can only keep three to five sessions in view — so attention, not the model, caps how much runs at once.

**Split deciding from doing.** A read-only Router judges, dispatches and keeps the ledger; each worker does the work in its own session.

**The effect.** Your session stays one screen long, every change keeps its report, reason code and runId, and parallel tasks stop polluting each other.

## Architecture

### Where it comes from

Borrowed from DeepSeek's [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) and its design essay. Its judgement: **how good one task gets depends on the model; how many tasks advance depends on human attention.** So it does not make one session smarter — it moves conversation, task state, authority and execution into separate places.

| DeepSeek's concept | Here |
| --- | --- |
| Router / Worker split | the session you talk to loses `write` / `edit` / `bash`; workers get their own sessions |
| Ticket | `router_task_*`: idempotent by key, report + reason code + runId, detail on demand |
| Mandate | writes scoped: `session` / `audit` for the model, `project` / `global` only by a human command |
| Summary-only handoff | only a compacted report crosses; detail sits behind `read: task/t3` |
| State on disk | one ledger file; one summary restores the scene |
| Source / Trigger | **not ported** |
| Concurrency, worktrees | **delegated to [`pi-subagents`](https://github.com/nicobailon/pi-subagents)** |

### How it ships

A **pi extension**: no event intake, no rebuilt concurrency layer, no second CLI to wire in. Install is two commands and it works immediately — almost zero configuration.

### Project layout

```
src/
  index.ts     tools, commands, events, read-only enforcement
  store.ts     ledger, file lock, migration
  memory.ts    three scopes + assembleMemory
  prompt.ts    router rules + digest
  guard.ts     keep-list and call blocking
  inspect.ts   fixed-argv repository inspection
  workers.ts   run-directory discovery and status
  config.ts    router.json parsing
  types.ts
agents/router-worker.md    the worker definition (may spawn nested subagents)
test/                      six files, 71 cases
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

- A worker never sees the Router's conversation; the Router never sees a worker's transcript, only its final report.
- The Router's ledger is trustworthy because the session keeping the books cannot touch what it reports on.

### Design principles

1. **The orchestrator is read-only** — otherwise you can never say who made a change.
2. **Only summaries cross the boundary** — detail is a pointer, not a payload.
3. **Context stays bounded** — 4096 characters / 60 lines per turn, plus a `budget:` line saying what was cut.
4. **Write permissions are scoped** — enforced by the extension, not by the prompt.
5. **Nothing waits** — dispatch returns, reports arrive as messages, no polling.

Principles 1, 2 and 4 come from DeepSeek's Router and Mandate design; 3 applies the same reasoning to the window itself; 5 exists because pi has no event loop to park a dispatch in.

### Memory layers

| Layer | File | Writer | Lifetime |
| --- | --- | --- | --- |
| `global` | `global.md` | **human** (`/router promote`) | permanent, cross-project |
| `project` | `projects/<project>.md` | **human** (`/router promote`) | permanent, per project |
| `session` | `sessions/<id>.json` | model (`router_note`) | pruned after 7 days |
| audit | `audit.jsonl` | extension | append-only, numbered for promotion |

`router_memory_append` writes only to the audit log and tells the model to ask a human; `/router promote 2 project` is the one path from a decision to durable memory. That is Mandate in miniature: an agent may record what it decided, but cannot grant itself the right to decide for you next time.

### What a dispatch looks like

```
you     /router new add a CONTRIBUTING.md and link it from the README
Router  t1 opened · dispatched · boundary: CONTRIBUTING.md + README.md
        acceptance: link resolves, nothing else touched
  ...
Router  t1 done · 2 files · run 4c1e · detail: read: task/t1
```

Wrong result? `/router task t1` shows the report and reason code; `/router memory audit` shows the decisions made at the time. No reconstructing intent from a diff.

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
| `router_note` | session memory: focus + short notes |
| `router_memory_append` | audit only, cannot touch shared memory |
| `router_memory_read` | read `global` / `project` / `session` / `audit` |
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
| `/router memory [scope] [query]` | read `global` / `project` / `session` / `audit`; `query` filters lines |
| `/router session` | this session's focus and recent notes |
| `/router new <goal>` | open a task and dispatch it (the command form of saying the goal) |
| `/router spawn <id>` | dispatch a queued task that was opened but never sent |
| `/router promote <n> [global\|project]` | copy audit line `n` (1 = newest) into global or project memory |

## Configuration

`~/.pi/agent/router.json`, all optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `scope` | `"global"` | one shared home, or `project` for `<cwd>/.pi/router` |
| `home` | `~/.pi/agent/router` | storage root (`PI_ROUTER_HOME` overrides) |
| `routerReadOnly` | `true` | remove and block `write` / `edit` / `bash` |
| `workerModel` | `null` | hint only; this extension never dispatches workers |
| `maxOpenShown` | `20` | task rows shown in the digest |

## Limitations

- **Not a sandbox.** Workers run with your permissions, no approval prompt. Use `worktree: true` when several touch one repo.
- **Not an autonomous coder.** It dispatches the goals you give it; it does not plan your project.
- **Not a workflow engine.** Parallelism, retries, worktrees and missions are pi-subagents' job.
- **Not event-driven.** DeepSeek's system listens to GitHub, Feishu and CI; this one listens to you.
- **Not stable.** `0.x`: the tool surface may change between minor versions.

## Tests

71 unit tests, `tsc --noEmit` clean. CI: suite on Node 22/24, typecheck on Node 20. Verified with `pi install` in a clean project: nine `router_*` tools, no `write`, `router-worker` discovered, one real dispatch produced a file with an auto-bound runId.

## Credits

Architecture, philosophy and vocabulary: DeepSeek's [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT). Execution, concurrency and worktree isolation: [`pi-subagents`](https://github.com/nicobailon/pi-subagents). This is an independent, unofficial minimal implementation, unaffiliated with either project. MIT licensed.
