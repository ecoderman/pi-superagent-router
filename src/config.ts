import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RouterConfig } from "./types.ts";
import { defaultHome } from "./store.ts";

export interface ConfigReadResult {
  config: RouterConfig;
  warning?: string;
}

export interface LoadConfigOptions {
  homedir?: string;
}

function baseHomeDir(homeDir?: string): string {
  if (homeDir !== undefined && homeDir !== "") return homeDir;
  const home = homedir();
  if (home !== "") return home;
  return process.cwd();
}

export function defaultConfig(homeDir?: string): RouterConfig {
  return {
    scope: "global",
    home: defaultHome(baseHomeDir(homeDir)),
    routerReadOnly: true,
    workerModel: null,
    maxOpenShown: 20,
    progressThrottleMs: 60000,
  };
}

export function configFilePath(homeDir?: string): string {
  return join(baseHomeDir(homeDir), ".pi", "agent", "router.json");
}

/** 只认 `~`、`~/`、`~\` 三种形态；不做环境变量展开、不调 shell。 */
export function expandHome(value: string, homeDir?: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "~") return baseHomeDir(homeDir);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(baseHomeDir(homeDir), trimmed.slice(2));
  }
  return trimmed;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 逐字段校验；单字段非法只回退该字段，并把原因收进 warning。 */
export function parseConfig(raw: unknown, homeDir?: string): ConfigReadResult {
  const config = defaultConfig(homeDir);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config, warning: "router.json 不是对象，已回退默认" };
  }

  const record = raw as Record<string, unknown>;
  const problems: string[] = [];

  if (record.scope !== undefined) {
    if (record.scope === "global" || record.scope === "project") config.scope = record.scope;
    else problems.push('scope: 期望 "global" 或 "project"');
  }
  if (record.home !== undefined) {
    if (typeof record.home === "string" && record.home.trim() !== "") config.home = resolve(expandHome(record.home, homeDir));
    else problems.push("home: 期望非空字符串");
  }
  if (record.routerReadOnly !== undefined) {
    if (typeof record.routerReadOnly === "boolean") config.routerReadOnly = record.routerReadOnly;
    else problems.push("routerReadOnly: 期望布尔值");
  }
  if (record.workerModel !== undefined) {
    if (record.workerModel === null || typeof record.workerModel === "string") config.workerModel = record.workerModel;
    else problems.push("workerModel: 期望字符串或 null");
  }
  if (record.maxOpenShown !== undefined) {
    if (isPositiveInteger(record.maxOpenShown)) config.maxOpenShown = record.maxOpenShown;
    else problems.push("maxOpenShown: 期望正整数");
  }
  if (record.progressThrottleMs !== undefined) {
    if (isPositiveInteger(record.progressThrottleMs)) config.progressThrottleMs = record.progressThrottleMs;
    else problems.push("progressThrottleMs: 期望正整数");
  }

  return { config, warning: problems.length > 0 ? `router.json 字段无效（${problems.join("；")}），已回退默认` : undefined };
}

/** 读配置；永不抛。ENOENT → 默认且无 warning。 */
export async function loadConfig(options?: LoadConfigOptions): Promise<ConfigReadResult> {
  const homeDir = options?.homedir;
  let text: string;
  try {
    text = await readFile(configFilePath(homeDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig(homeDir) };
    return {
      config: defaultConfig(homeDir),
      warning: `router.json 读取失败（${(error as Error).message}），已回退默认`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      config: defaultConfig(homeDir),
      warning: `router.json 解析失败（${(error as Error).message}），已回退默认`,
    };
  }

  return parseConfig(raw, homeDir);
}

/** 优先级：PI_ROUTER_HOME > scope=project 的 <cwd>/.pi/router > config.home。 */
export function resolveHome(cwd: string, config: RouterConfig, env?: NodeJS.ProcessEnv): string {
  const override = (env ?? process.env).PI_ROUTER_HOME;
  if (typeof override === "string" && override.trim() !== "") return resolve(expandHome(override));
  if (config.scope === "project") return join(cwd, ".pi", "router");
  return resolve(expandHome(config.home));
}