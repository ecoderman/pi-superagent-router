# REVIEW — pi-router v2（合并记录）

审查共 3 轮正式审查 + 1 轮最终验收，均只读。审查者无 shell 权限，`tsc`/`npm test` 由 supervisor 复跑。

| 轮次 | 结果 | 要点 |
|---|---|---|
| review-v2-1 | FAIL | 1×P1 + 5×P2：`workers.ts` 状态枚举缺 `complete/partial/rejected`；digest 空账本项目行；迁移 project 取值；`router_inspect.limit` 应为夹取而非拒绝；读路径不应写盘；运行目录发现与 pi-subagents 真实实现不符 |
| fix-v2-1 | — | 6 条全修；Finding 6 经 supervisor 裁决采用「实现超集」（`PI_SUBAGENTS_RUN_DIR` → `PI_SUBAGENTS_TEMP_ROOT` → `tmpdir/pi-subagents-<scopeId>`），并在 README 写明发现顺序 |
| review-v2-2 | FAIL | 1×P1 + 6×P2：`findOpen` 未按 project 作用域；`ensureState` 未按 cwd 失效；`router_task_open` 的 project 取值；迁移 id 冲突静默重编号；config/ledger 双 warning 只注入一个；`/router status` 缺 project 列；README home 优先级表述 |
| fix-v2-2 | — | 7 条全修，补 2 个测试用例（40 → 42） |
| review-v2-3 | PASS with notes | 14 条验收全部通过；无 P0/P1 |
| review-v2-final | PASS with notes | 无 blocker；5 条 P2 为 report-only |

## 最终 5 条 P2（supervisor 已全部修复）

1. `src/types.ts` project 注释与实现相反（realpath 失败用 cwd 原值）→ 注释改正。
2. `test/store.test.ts` 20 并发用例用默认 3s 锁超时，慢机器可能偶发失败 → 该用例显式 `timeoutMs: 15000`。
3. `src/config.ts` `LoadConfigOptions.env` 声明后从未读取（死参数）→ 删除字段。
4. `src/index.ts` `ensureState` 在 `buildState` reject 后永久复用 rejected promise → 失败时清空 in-flight 缓存。
5. `docs/README.md` 索引漂移 → 本文件与 `FIXES-v2-2.md` 已补入。

## Supervisor 复核（实际执行的验证）

```
cd pi-router
npx tsc --noEmit    → exit 0
npm test            → 42/42 pass
grep child_process|spawn(|--mode rpc|-ne  → 无命中
grep ": any"|@ts-ignore|as any            → 无命中
package.json        → 0.2.0，dependencies 为空，host 包在 peerDependencies
```

真实 pi 进程端到端冒烟（不依赖测试桩）：

1. **只读生效**：Router 会话可用工具恰为 12 个 KEEP 项（`read/grep/find/ls/subagent/router_*`），要求它调用 `write` 时回答 `NOT_AVAILABLE`。
2. **全局账本 + 迁移**：`PI_ROUTER_HOME` 指到临时目录后开任务，生成 `version: 2` 账本，`project=router-demo`、`ownerSession=<session id>`；`router-demo/.pi/router/tasks.json` 的 2 条 v1 任务自动导入为 `ownerSession: "migrated"`，原文件改名为 `tasks.json.migrated-<ts>`。
3. **worker 可见**：`router_workers` 输出 1 active + 2 done，含 session 路径；运行目录缺失时按设计降级（不抛错）。
4. **自动记 runId（唯一候选）**：单任务场景下派发后 `runId` 自动写入账本，无需手工补录；任务完成后置 `done`。

## 已知限制（v2.1 待办）

- **runId 自动绑定在多候选时跳过**：当账本中同时存在多个 `queued` 且无 `runId` 的任务时，按规格「歧义时不猜」直接跳过，用户需手工补录。真实多任务场景下这会退化。建议 v2.1 改为：优先匹配 `subagent` task 文本中包含其 `goal` 的候选，否则取最近创建的 queued 候选，并在结果中注明所选任务。
- 多会话共享账本时，各会话看不到彼此的 worker 唤醒（唤醒只回到发起会话）；跨会话 resume 受 pi-subagents 限制（`Resume: unavailable`）。