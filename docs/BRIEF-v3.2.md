# pi-router v3.2（增量）：让 `read: task/<id>` 指针真正被使用

> 基线 v0.3.1。此前 digest 只在 `assembleMemory` 的 tasks 层加了 `read: task/<id>`，
> 但规则里没告诉模型「什么时候必须去解引用」，指针等于装饰。

## 变更

1. `src/prompt.ts`
   - `buildDigest` 的每条任务行也追加指针（与 `assembleMemory` 的 tasks 层一致），
     并导出 `READ_POINTER_PREFIX = " · read: task/"` 供测试与复用。
   - `ROUTER_RULES` 新增两条（紧随 router_workers 那条）：
     - 任务处于 `needs-human`、或要向用户汇报某任务结果之前，先用 `router_task_get { id }` 取详情，
       不要只凭 `last` 一行下结论；
     - 取详情时报告默认最近 5 条，需要更早上下文显式传 `reports`（最大 20），不要假设已看全。

2. `test/prompt.test.ts`（新增，已加入 `npm test`）
   - 断言只读/写权限/不轮询等硬约束仍在；
   - 断言指针规则存在（`read: task/<id>`、`router_task_get`、`needs-human`、`向用户汇报`、`最近 5 条`、`20`）；
   - 断言 `buildDigest` 每条展示的任务都带指针，且空账本不带指针、仍输出 `open tasks: none`。

## 验收

1. `npx tsc --noEmit` 退出 0；`npm test` 全绿（71 用例）。
2. `buildDigest` 与 `assembleMemory` 的 tasks 层都带 `read: task/<id>`。
3. 空账本输出 `open tasks: none` 且无指针。
4. `ROUTER_RULES` 含上述两条 deref 规则。
5. 版本 `0.3.2`；`package.json` 的 test 脚本包含 `test/prompt.test.ts`。
