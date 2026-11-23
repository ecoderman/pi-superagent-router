# Pi 扩展「before_agent_start」事件：可返回 { systemPrompt } 覆盖本轮系统提示
# 工具注册：pi.registerTool({ name, description, parameters, async execute(id, params, signal, onUpdate, ctx) })
# 命令：pi.registerCommand(name, { description, handler(args, ctx) })
# UI：ctx.ui.setStatus(key, text|undefined)、ctx.ui.setWidget(key, lines)、ctx.ui.notify(msg, level)
# 类型导入：import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
# 参数 schema：import { Type } from "typebox"
# session 事件：pi.on("session_start", (e, ctx) => ...)、pi.on("session_shutdown", ...)
#
# 注意：扩展由 pi 直接加载 TS（无构建步骤）；tsconfig 只用于类型检查。