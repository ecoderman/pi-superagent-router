# FIXES-v2-2 — v2 审查第 2 轮修复记录

审查结论（原文由 supervisor 转述，本轮审查者无 shell/写权限，未复跑命令）：
`ISSUES: 7` / `VERDICT: FAIL`，1×P1 + 6×P2，merge 裁决 BLOCK。
权威规格：`docs/BRIEF-v2.md`（本文件与实现均**未改动** BRIEF-v2 / BRIEF）。
验证：`npx tsc --noEmit` → 0；`npm test` → **42 tests / 42 pass**（修复前 40 tests）。

---

## P1 `findOpen` / `applyOpen` 的 key 幂等跨项目串味

- **问题**：`src/store.ts` 的 `findOpen(ledger, key)` 只比对 `key` 与 `isOpen`，不看 `project`；
  `applyOpen` 把 `input.project` 写进新任务却不参与查找。v1 每项目一份账本，`key` 天然项目内唯一；
  v2 全局账本后，A 项目存在 open 的 `key` 时，B 项目用同名 key 调 `router_task_open` 会命中 A 的任务、
  返回 `created:false`，随后派的是 B 的活、记的是 A 的任务（goal/project/ownerSession 全错），且不报错。
- **改法**：`findOpen(ledger, key, project?)` 增加可选 project，匹配条件追加
  `(project === undefined || sameProject(t.project, project))`（大小写不敏感，与 `sameProject` 一致）；
  `applyOpen` 传 `input.project`。`project` 省略时保留旧的全局查找，仅供内部/测试。
  工具参数不变（BRIEF-v2 验收 2）。
- **涉及文件**：`src/store.ts`、`test/store.test.ts`
  （新增用例「the same key opens independent tasks per project in the global ledger」：同 key 两个项目
  → 两条任务、各自 `created:true`、id 不同；同项目大小写不同仍幂等；
  `pure helpers` 用例补 `findOpen(..., "alpha"/"ALPHA"/"beta")` 三条断言）。

## P2 `RouterState` 缓存不含 cwd，会话换 cwd 后用过期的 project / 迁移源目录

- **问题**：`ensureState` 一旦 `cached` 就永远返回第一次构建的值。`ExtensionCommandContext` 的
  `switchSession` / `newSession` 可以换 cwd，之后 digest 项目过滤、`applyOpen` 写入的 project、
  `router_memory_append` 的项目标记、以及**迁移源目录**都会指向旧项目（可能把别的项目的 v1 账本导入全局账本）。
- **改法**：`RouterState` 增加 `cwd`；`ensureState` 改为 `cached && cached.cwd === ctx.cwd` 才复用；
  并发构建缓存同样按 cwd 区分（`building: { cwd, promise }`），避免 cwd 切换时误用上一个 cwd 的构建中结果。
- **涉及文件**：`src/index.ts`（无新增测试：`src/index.ts` 依赖 `typebox` 与宿主包，`node --test` 无法导入；
  与 v2 既有的「纯函数才可单测」边界一致，见 `docs/PLAN-v2.md` C7）。

## P2 任务的 `project` 取会话 cwd，不取任务自己的 cwd

- **问题**：`router_task_open` 支持 `cwd` 覆盖，但 `project` 恒为 `st.project`；而 `migrateTaskV1`
  按任务自己的 cwd 取 project。同一语义两套取值，为别的目录开的任务会被算进当前项目的 digest 明细与
  `project <name>: N open` 计数。
- **改法**：`const project = params.cwd ? await projectName(params.cwd) : st.project;`
  （`projectName` 已是导出的异步纯函数，realpath 归一与 `Task.project` 的注释口径一致）。
- **涉及文件**：`src/index.ts`（同上，index 层无单测；纯函数 `projectName` 已有用例覆盖）。

## P2 迁移的 `idMap`（重编号映射）被丢弃，id 变化对模型静默

- **问题**：`importLegacyTasks` 在 id 冲突时把 `t1→t2` 记进 `idMap`，`migrateLocked` 只解构
  `{ imported }`，映射从未出现在 warning / 工具结果里。叠加读路径的内存导入，模型在首次写前看到的是
  「当下算出来的 id」，落盘后可能不同，随后 `router_task_update t5` 会静默命中别的任务或报 `no task t5`。
- **改法**：
  - `migrateLocked` 解构 `{ imported, idMap }`，映射非空时 warning 追加
    `旧账本任务 id 冲突，已重编号：t1→t2、…`。
  - `loadLedger` 的读路径提示改为
    `旧账本待迁移（首次写操作时完成；其中的任务 id 以首次写入落盘结果为准）`。
- **涉及文件**：`src/store.ts`、`test/store.test.ts`
  （新增用例「legacy id renumbering is reported by the migration warning」：全局账本已占 `t1`，
  旧账本 `t1` 迁移后读路径 warning 含「以首次写入落盘结果为准」，锁内迁移 warning 含「已重编号」与 `t1→t2`）。

## P2 配置 warning 被账本 warning 覆盖

- **问题**：`before_agent_start` 里 `const ledgerWarning = warning ?? st.warning;`——账本有 warning 时，
  `router.json` 的字段回退提示（例如 `routerReadOnly` 类型错）在 systemPrompt 里完全消失，
  而它恰恰是「只读开关未生效」的唯一线索。
- **改法**：新增 `mergedWarnings(...)`（去重、丢空串），`before_agent_start` 把
  **两条** warning 各自作为一行 `[router 警告] …` 注入；`warningPrefix` 复用同一个合并函数。
  同一类问题在 `/router` 命令的收尾 notify 里也存在（`warning ?? st.warning`），一并按同样口径
  逐条 notify（同一缺陷、同一语义，非新范围）。
- **涉及文件**：`src/index.ts`（index 层无单测，理由同上）。

## P2 `/router status` 行不带 project

- **问题**：`statusLines` 直接 `formatTaskRow(task)`；`router_task_list` 已加 `${task.project} · ` 前缀，
  全局账本下同一个 widget 混着多项目任务而无从区分。
- **改法**：`statusLines` 改为 `lines.push(\`${task.project} · ${formatTaskRow(task)}\`)`，与 list 一致。
- **涉及文件**：`src/index.ts`（index 层无单测，理由同上）。

## P2 README 的 home 优先级表述与实现不符

- **问题**：README 写「`PI_ROUTER_HOME` > 配置 `home` > 默认」，实际 `resolveHome` 是
  `PI_ROUTER_HOME` > `scope=project` 的 `<cwd>/.pi/router` > `config.home` > 默认；
  同时设 `scope:"project"` 与 `home` 时 `home` 被忽略。实现符合 BRIEF-v2 ⑤，只需改文档。
- **改法**：改成实现口径并明确写出「`scope: "project"` 时 `home` 不生效」。代码未改。
- **涉及文件**：`README.md`。

---

## 未处理项（审查「观察」区，不计入 ISSUES）

以下为审查 D 节之后的「观察（不计入 ISSUES）」，本轮**未改动**，理由如下（均非本轮 7 条 finding）：

- `open(...,"wx")` 成功后 `writeFile` 抛错会残留 0 字节锁 → 最长 10s 后被判陈旧。
  这是 BRIEF-v2 ② 锁协议（只按 mtime 判陈旧）的既有边界，修复需改协议（写内容与判陈旧解耦），
  超出本轮 7 条修复范围；当前失败模式是「最多等 10s」，不会丢数据。
- digest 字符上限分支无用例真正触发：属测试覆盖增强，不是缺陷；现有 40 行/4096 字符上限与
  `…(truncated)` 已被用例断言。
- `config.ts` 的 `LoadConfigOptions.env` 声明未使用：删除属无关清理，避免扩大本轮 diff。
- `types.ts:10` 注释「realpath 失败时退回 cwd 的 basename」与实现（退回 cwd 原值，符合 BRIEF-v2 ①）不符：
  纯注释文字，不影响行为；为避免把文档修订混进 P1/P2 修复 diff，本轮未动，建议 supervisor 统一处理。
- `tool_result` 自动记 runId 的「唯一候选」是全局唯一（跨项目容易因别的项目遗留 `queued` 而跳过）：
  这是 BRIEF-v2 ④ 的字面行为，改动会偏离规格；README 已建议「一次只派一个任务」的用法。
- 运行目录发现是 BRIEF-v2 ④ 的实现在地超集（`PI_SUBAGENTS_TEMP_ROOT`、`uid-<N>`）：
  FIXES-v2-1 Finding 6 已有 supervisor 裁决，本轮不动。
- `docs/FIXES-v2-1.md` 引用的 `docs/REVIEW-v2-1.md` 不存在：审查者无写权限，REVIEW 正文本轮由
  supervisor 另行落盘；本文件同样不猜测其内容，只在开头记录转述的结论。

## 验证

```bash
cd "E:/Code/PI code/agent_test/pi-router"
npx tsc --noEmit        # 0
npm test                # 42 tests, 42 pass
git status --porcelain  # 仅工作区改动，无 staged / 无 commit / 无 tag
```