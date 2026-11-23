# pi-router

极简 superagent（**Router**）的 Pi 扩展：只拆任务、派任务、收报告、记账。任务的内部拆解与执行
全部交给 [pi-subagents](https://github.com/earendil-works/pi-subagents) 的 `router-worker` 子代理。

## 它做什么

- 5 个记账工具：`router_task_open` / `router_task_update` / `router_task_list` /
  `router_memory_append` / `router_memory_read`。
- 注入路由规则与「open tasks digest」到主会话系统提示。
- `/router` 命令查看账本状态、任务报告、digest 与 memory。
- 账本 = `.pi/router/tasks.json`（结构化事实）+ `.pi/router/memory.md`（append-only 决策记录）。

## 本地加载方式

两种方式二选一：

```bash
# 方式一：直接加载源码入口（开发推荐，无构建步骤）
pi -e ./src/index.ts

# 方式二：复制到项目 local extensions 目录（auto-discovery，可 /reload 热加载）
#   cp -r pi-router .pi/extensions/pi-router
# 或全局：
#   cp -r pi-router ~/.pi/agent/extensions/pi-router
```

在 `.pi/config.json` 里也可以用 `"extensions": ["./src/index.ts"]` 显式引用本目录。

## 依赖

- 需要安装 **pi-subagents**，因为它提供 `subagent` 工具与 worker agent 运行时。
- 需要把 worker agent 放到 **`.pi/agents/router-worker.md`**（即本仓库 `agents/router-worker.md`）。
  其 frontmatter 必须允许 `read, write, edit, bash, grep, find, ls, subagent`（`subagent` 在末尾
  用于嵌套授权），并设 `extensions: []` 防止 worker 再加载 router 扩展。
- `@earendil-works/pi-coding-agent` 与 `typebox` 是 `peerDependencies`，运行时由 Pi 提供；本项目不把它们塞进 `dependencies`。

## 账本位置

- 账本：`.pi/router/tasks.json`（原子写：temp 文件 + rename）
- 记忆：`.pi/router/memory.md`（append-only，从不重写）
- 损坏账本会被备份为 `.pi/router/tasks.json.bak-<ts>`，并以空账本继续工作并在输出中警告。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test（覆盖幂等 open、报告追加、digest 上限、原子写残留等）
```

扩展由 Pi 直接加载 TypeScript（无构建步骤）；`tsconfig.json` 只用于类型检查。

## 设计边界

- Router 只在 Pi **主会话**生效（`PI_SUBAGENT_CHILD === "1"` 守卫），worker 子会话不会加载本扩展。
- Router **不**自行 spawn 子进程、不实现 subagent 运行时、不包装内部调用 `subagent` 的 dispatch 工具；
  派发由模型直接调用 pi-subagents 已暴露的 `subagent({ agent: "router-worker", task, cwd, worktree })`。
- 无 GitHub 轮询、无 web 服务、无 daemon；除 `typescript`/`@types/node` 外无运行时依赖。
- 不轮询不 sleep；子代理完成后报告会自动唤醒主会话。