# FIXES-v2-1 — v2 审查第 1 轮修复记录

审查原文：`docs/REVIEW-v2-1.md`（6 条 finding：1×P1 + 5×P2）。
权威规格：`docs/BRIEF-v2.md`（**本文件与实现均未改动 BRIEF**）。
验证：`npx tsc --noEmit && npm test` → 40 tests / 40 pass（修复前 36 tests）。

---

## P1 `router_workers` 把已完成的 worker 算成 active

- **问题**：`src/workers.ts` 的 `DONE_STATES` 写成 `["completed","failed","stopped","blocked","paused"]`，
  而 pi-subagents 的 `AsyncStatus.state` 实际枚举是
  `"queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected"`
  （`pi-subagents/src/shared/types.d.ts:1919`；终态判定见 `src/runs/background/async-job-tracker.js:29`）。
  最常见的成功终态 `complete` 落不进 DONE，`partial` / `rejected` 也漏；`completed` / `blocked` 不是 run 级状态。
  后果：`runBucket` 回退到账本状态，worker 已结束但账本还是 `running` 时被算成 active，
  `workers: N active · M done` 计数错误、默认 `active` 视图混入已结束 worker。
- **改法**：`DONE_STATES = ["complete","completed","failed","partial","stopped","paused","rejected","blocked"]`
  （保留 `completed`/`blocked` 作宽容项），并在常量上方注明真实枚举来源。
- **涉及文件**：`src/workers.ts`、`test/workers.test.ts`
  （`runBucket` 用例新增 `complete` / `partial` / `rejected` / `queued` 四条断言）。

## P2 空账本时 digest 缺 `project <name>: N open` 行

- **问题**：`buildDigest` 用了 `options.scope === "global" && tasks.length > 0`。BRIEF-v2 ⑤ 只给
  「仅在 `scope=global`」一个条件，实现多加的「账本非空」让首次安装时看不到自己项目那一行。
- **改法**：去掉 `&& tasks.length > 0`，`scope=global` 时恒输出项目统计行（`0 open` 也输出）。
  `open tasks: none` 仍单独成行。
  注：`PLAN-v2.md` 的 C1 写的是「空账本两行」，与 BRIEF-v2 ⑤ 的单一条件（仅 `scope=global`）冲突；
  本项按 BRIEF-v2 执行（空账本在 `scope=global` 下为三行），未修改任何规格文档。
- **涉及文件**：`src/prompt.ts`（含注释）、`test/store.test.ts`
  （空账本用例改为断言 3 行：`global: …`、`project alpha: 0 open`、`open tasks: none`；
  另补 `scope=project` 时仍是 2 行）。

## P2 v1 迁移的 `project` 取的是会话 cwd 而不是任务自己的 cwd

- **问题**：`migrateTaskV1(raw, project)` 的 `project` 两处都传 `legacy.project`
  （= `projectName(当前会话 cwd)`）。BRIEF-v2 ① 要求「v1 任务补 `project = basename(cwd)`」，
  这里的 `cwd` 是**任务字段**（v1 的 `router_task_open` 允许 `cwd?` 指向别的目录），
  用会话目录名会让这类任务在 `buildDigest` 的项目过滤里被隐藏/误计。
- **改法**：`migrated.project = migrated.cwd.trim() === "" ? project : basenameOf(migrated.cwd)`，
  只在任务 cwd 为空时用传入 project 兜底；判定从 `=== ""` 改为 `!migrated.project`，
  以同时覆盖旧文件缺字段（`parseTask` 的 legacy 模式给 `""`）与直接调用传入 `undefined` 的情况。
  `ownerSession` 同样用 `!migrated.ownerSession` 判定。
- **涉及文件**：`src/store.ts`、`test/store.test.ts`
  （迁移用例断言 `project === "project"`（来自 `cwd: "/old/project"`）且 `!== "old-project"`；
  新增纯函数用例覆盖「cwd 非空取 basename / cwd 空回退 / 已有 project 不动 / ownerSession 规则」）。

## P2 `router_inspect.limit` 被 schema 的 `maximum` 变成「校验拒绝」

- **问题**：schema 是 `Type.Integer({ minimum: 1, maximum: 500 })`。pi 在 `execute` 之前用
  `tool.parameters` 校验参数，`limit: 1000` 会直接变成工具参数错误，永远走不到 `clampLimit`；
  BRIEF-v2 ③ 要求的是「`limit` 必须夹到 `1..500`」，不是拒绝。
- **改法**：schema 改为 `Type.Optional(Type.Integer())`（去掉 `minimum`/`maximum`），
  让 `execute` 内的 `clampLimit` 执行夹取；`git-log` 与 `tree` 都经过它，仍落在 1..500。
  审查给的另一条岔路（改 BRIEF-v2 为「拒绝」口径）不采用：BRIEF-v2 是权威规格且禁止修改。
- **涉及文件**：`src/index.ts`（schema + 注释）。夹取逻辑与 `inspectArgv` 白名单本身未变，
  已有测试 `test/guard.test.ts` 覆盖 `clampLimit(1000, 20) === 500`、`clampLimit(0, 20) === 1`。

## P2 损坏账本的备份在**读路径**上做了无锁 rename

- **问题**：`loadLedger`（BRIEF-v2 ② 明确「读路径不取锁」）在解析失败时调用 `backupCorrupt`，
  直接 `rename(tasks.json, tasks.json.bak-<ts>)`。这是无锁的破坏性写：另一进程持锁刚用
  temp+rename 换好新文件时，本进程仍可能把新文件当「损坏文件」改名走，造成一次任务丢失 + 账本重置。
- **改法**：`readLedgerFile` 增加 `mode: "read" | "locked"`：
  - `read`（`loadLedger`）：只返回 `warning` + 空账本，**不改盘**（提示「只读路径不改动文件，下次写入时备份并重置」）；
  - `locked`（`migrateLocked`，已持 `<home>/tasks.lock`）：才 `rename` 成 `tasks.json.bak-<ts>`，
    改名失败也只 warning + 空账本。
- **涉及文件**：`src/store.ts`、`test/store.test.ts`
  （损坏账本用例改为：读路径无 `.bak-*` 文件且只报 warning；随后 `withLedger` 一次才产生备份并重置）、
  `README.md`（账本一节说明「写路径的锁内备份」）。

## P2 运行目录发现用了 pi-subagents 不存在的环境变量

- **问题**：BRIEF-v2 ④ 逐字实现 `PI_SUBAGENTS_RUN_DIR` → `<tmpdir>/pi-subagents-user-<username>/async-subagent-runs`，
  但 pi-subagents 实际只认 `PI_SUBAGENTS_TEMP_ROOT`，运行根是
  `<tmpdir>/pi-subagents-<scopeId>/async-subagent-runs`，`scopeId` 在有 `getuid` 时是 `uid-<N>`
  （`pi-subagents/src/shared/types.js:60-107`）。设自定义 temp root 的用户与 Linux 用户会永久显示
  「运行目录未找到」，`router_workers` 的 session 路径/状态能力退化成只有账本信息。
- **裁决**：supervisor 选 (A)「实现超集」，并同步 README。BRIEF-v2 文本**未修改**，本项记为
  「对 BRIEF-v2 ④ 的实现在地补充」。
- **改法**（`src/workers.ts`）：
  - 拆成两个纯函数：`runDirCandidates(deps)` 只推导候选（注入 `env` / `tmpDir` / `getuid` /
    `username` / `homedir`），`pickExistingDir(candidates, exists)` 只做「取第一个存在者」（注入 `exists`）；
    `findExistingDir` 只是 `pickExistingDir(candidates, isExistingDir)` 的 IO 包装。
  - 候选顺序：① `PI_SUBAGENTS_RUN_DIR`（显式覆盖；它本身或其 `async-subagent-runs` 子目录都接受）
    ② `resolve(PI_SUBAGENTS_TEMP_ROOT)/async-subagent-runs` ③
    `<tmpdir>/pi-subagents-<scopeId>/async-subagent-runs` ④ 都不存在 → 保持原有降级输出，不抛错。
  - `tempScopeId(deps)` 与 pi-subagents `resolveTempScopeId` 同规则：有 `getuid` → `uid-<N>`；
    否则 `USERNAME` / `USER` / `LOGNAME` → `os.userInfo().username` → `USERPROFILE` / `HOME` →
    `homedir()` → `shared`，段清洗 `[^A-Za-z0-9._-]+` → `-` 并去首尾 `-`，空则 `unknown`。
- **涉及文件**：`src/workers.ts`、`src/index.ts`（传 `getuid`/`username`/`homedir` 依赖）、
  `test/workers.test.ts`（新增：显式覆盖含子目录、`TEMP_ROOT` 优先于 tmp scope、`tempScopeId`
  的 uid/用户名/home/shared 推导、`pickExistingDir` 选择规则）、`README.md`（Worker 可见性一节写发现顺序）。

---

## 未按审查建议做的事（含理由）

- **没有改 `docs/BRIEF-v2.md`**：硬规则禁止；Finding 4 / Finding 6 的「改口径」分支因此只能选实现侧方案
  （4 采用夹取；6 采用 supervisor 批准的实现在地补充 + README 说明）。
- **没有把 `limit` 改成「越界即拒绝」**：BRIEF-v2 ③ 原文是「夹到 1..500」。
- **没有放宽生产锁默认值**：审查观察项提到 20 并发用例在慢 CI 上可能接近 3s 上限；本次未调整生产默认值，
  但 `test/store.test.ts` 的并发用例实测约 2.3s（退避上限 200ms + 抖动），仍在 3s 内。

## 验证

```bash
cd "E:/Code/PI code/agent_test/pi-router"
npx tsc --noEmit      # 0
npm test              # 40 tests, 40 pass
git status --porcelain  # 仅工作区改动，无 staged / 无 commit / 无 tag
```