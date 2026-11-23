# FIXES — pi-router v3 第一轮修复（对应 REVIEW-v3-1）

> 只改工作区源码/测试；未执行 git commit/tag/push/add。修复 3 个 reviewer 结论条目的全部内容。

## P0 — `validateMemoryTarget` 从未接入写路径（scopeId 逃逸）

### 根因
`validateMemoryTarget`（src/memory.ts:101）全工程仅有定义与 memory.test.ts 引用；
`migrateMemory`/`appendProjectMemoryLocked`/`appendSessionNoteLocked` 直接 `join` 拼接路径后 `appendFile`，
未对本层校验 scopeId，`memory.md` 的 `[../../evil]` 标签可把块写到 `<home>` 之外。

### 修复
- `src/store.ts` 导入 `validateMemoryTarget`。
- `writeSessionLocked`/`appendSessionNoteLocked` 入口先
  `validateMemoryTarget({ scope: "session", scopeId })`。
- `appendProjectMemoryLocked` 入口先
  `validateMemoryTarget({ scope: "project", scopeId: project })`。
- `migrateMemory` 在解析后、任何 `mkdir`/`appendFile` 之前，对 `Object.keys(projects)`
  逐个 `validateMemoryTarget({ scope: "project", scopeId: project })`；
  任一非法标签抛错 → 外层 catch 整体失败并保留原 `memory.md`，绝不写入 `<home>` 之外。

选择“整次迁移失败并保留原文件”而非“跳过非法块”：安全异常应显式暴露，避免静默丢块。

## P1 — `assembleMemory` 的 manifest 与 `layers.chars` 未按全局封顶后重算

### 根因
`src/memory.ts` 的 `assembleMemory` 在 `capBody` 之前计算 manifest；封顶后仅把整层丢弃层
`chars` 置 0 并给 char 截断层打 `truncated`，manifest 仍显示封顶前分子，char 截断保留层的
`chars` 未降到实际保留值，与 body/`layers` 自相矛盾。

### 修复
- 仍先用封顶前的 `manifestText(layers, budget)` 计算正文预算（保证重算后总量不超 4096）。
- `capBody` 后：丢弃层 `chars=0, truncated=true`；对 char 截断保留层按 `capped.body`
  反推实际保留块字符数，减去 `title + \n` 得到实留源字符数（层内已截断时以层预算为上界），
  再置 `truncated=true`。
- 最后用修正后的 `layers` 重新生成 manifest，再拼 `body + "\n" + manifest`。
- 分子只会缩短，最终总长保持 ≤4096，manifest 恒为末行。

## P2 — 验收 2 的「用例断言」缺失

### 根因
BRIEF-v3 验收 2 要求对 `router_memory_append` 不改变 `global.md`/`projects/*.md`
内容与 mtime 有用例断言；原测试只覆盖 `appendAudit`/`readAudit` 与纯函数。

### 修复
`test/memory.test.ts` 新增用例「appendAudit never mutates global.md or project memory files」：
写入 `global.md` 与 `projects/alpha.md` 后记录二者 `mtime` 与内容，调用 `appendAudit`，
断言 mtime 与内容均不变（store 层等价于工具层的 `router_memory_append` 写点）。

## 新增/增强测试（test/memory.test.ts，共 +4 用例）

1. `assembleMemory recomputes manifest and layers.chars after the global cap` — 防 P1 回归。
2. `appendAudit never mutates global.md or project memory files` — 落 P2 验收断言。
3. `memory write paths reject path-escaping scopeIds` — 防 P0 写入口回归。
4. `migrateMemory rejects escaped [project] tags and keeps the legacy file` — 防 P0 迁移回归。

## 验证

```
cd pi-router
npx tsc --noEmit   → exit 0（无输出）
npm test           → 63/63 pass（新增 4 用例后由 59 → 63）
git status --short → 变更/新增均在暂存区之外（未 git add）
```

残余风险：
- 读路径 `readSession`/`readProjectMemory` 未加 `validateMemoryTarget`，仍可能把含路径分隔符的
  scopeId 传入 `join`；本轮按 reviewer 结论仅收口写路径 + 迁移，读路径不影响越权写。
- `projectName` 在 `realpath` 失败时按规格回落 cwd 原值，可能含路径分隔符；此时
  `/router promote` 的 project 目标会被新增校验拒绝（fail-closed），符合“防越权”取舍。