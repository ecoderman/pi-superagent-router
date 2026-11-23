# pi-router v2.1 需求（增量）

> 基线：v0.2.0（`docs/BRIEF-v2.md` 已交付）。本文件只描述 v2.1 的增量，其余行为不变。

## 动机

v2 的 runId 自动绑定规则是「账本里恰好一个 `queued` 且无 `runId` 的候选才写入，歧义则跳过」。
真实多任务场景（先开几个任务、再逐个派发）下这条规则**几乎必然触发歧义**，导致：

- `runId` 永远不落账，`router_workers` 显示 `run: -`；
- 任务停在 `queued`，即使 worker 已完成；
- 用户/模型只能手工补录，而模型往往不知道要补。

实测复现：账本中有遗留 `t3 queued` + 新建 `t4 queued`，派发 t4 的 worker 后，`t4` 仍是 `run:-`。

## 变更

`src/store.ts` 用 `bindRunId(ledger, runId, taskText?)` 取代 `setRunIdIfUnclaimed(ledger, runId)`：

```ts
export type RunIdRule = "single" | "goal" | "newest";
export interface RunIdBinding { task: Task; rule: RunIdRule }

export function bindRunId(ledger: Ledger, runId: string, taskText?: string): RunIdBinding | undefined;
```

规则（按序）：

1. 候选 = `status === "queued" && runId === undefined`；候选为 0 → 返回 `undefined`（不动作）。
2. 候选恰好 1 个 → 绑定，`rule = "single"`。
3. 候选 ≥ 2 个：
   - 若提供了 `taskText`：把 `taskText` 与每个候选的 `goal` 都做归一化（小写、空白折叠），
     取「`goal` 长度 ≥ 8 且被 `taskText` 包含」的候选；
   - 命中 ≥ 1 个 → 取其中**最新创建**者，`rule = "goal"`；
   - 命中 0 个 → 取全部候选中**最新创建**者，`rule = "newest"`。
4. 「最新创建」= `createdAt` 降序，同刻再按 `id` 数字序降序。
5. 绑定时写 `runId`、`status = "running"`、`updatedAt`。

`src/index.ts` 的 `tool_result` hook：

- 从 `event.input.task` 取派发文本作为 `taskText`（非字符串则视为未提供）。
- `rule === "single"` → 静默。
- `rule === "goal"` / `"newest"` → 在工具结果 `content` 末尾追加一行
  `\n[router] runId 已自动绑定到 <taskId>（<原因>）。`，让模型知道绑给了谁，避免重复派发或手工补录。
- 失败仍静默（不改变 `subagent` 结果）。

`src/prompt.ts` 规则 4 与 `README.md` 的 worker 可见性段落同步为上述语义。

## 验收标准

1. `npx tsc --noEmit` 退出 0；`npm test` 全绿（≥ 44 用例）。
2. 存在 `bindRunId` 且 `setRunIdIfUnclaimed` 已移除（无残留引用）。
3. 单测覆盖：唯一候选、无候选、已绑定不被抢、goal 匹配优先于新旧、goal 过短不参与、无匹配回落最新。
4. 真实场景验证：账本同时有两个 `queued` 任务时派发其中**较旧**的一个且派发文本包含其 `goal`，
   `runId` 必须绑定到该较旧任务（证明 goal 规则优先于 recency）。
5. 非 `single` 绑定会在工具结果里追加一行以 `[router] runId 已自动绑定到` 开头的提示。
6. 版本号为 `0.2.1`；`README.md` 与 `docs/README.md` 已更新。

## 已知限制（保留在文档里）

- 启发式可能绑错：并行派发且派发文本互不包含对方 `goal` 时退化为「最新创建」。
  精确控制时用 `router_task_update { id, runId }` 覆盖（后写生效）。