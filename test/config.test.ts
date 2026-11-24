import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  configFilePath,
  defaultConfig,
  expandHome,
  loadConfig,
  parseConfig,
  resolveHome,
} from "../src/config.ts";

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-superagent-router-config-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test("defaultConfig uses the global home and documented defaults", () => {
  const config = defaultConfig("/home/tester");
  assert.deepEqual(config, {
    scope: "global",
    home: join("/home/tester", ".pi", "agent", "router"),
    routerReadOnly: true,
    workerModel: null,
    maxOpenShown: 20,
    progressThrottleMs: 60000,
  });
  assert.equal(configFilePath("/home/tester"), join("/home/tester", ".pi", "agent", "router.json"));
});

test("expandHome handles only the three ~ forms", () => {
  assert.equal(expandHome("~", "/home/t"), "/home/t");
  assert.equal(expandHome("~/", "/home/t"), join("/home/t", ""));
  assert.equal(expandHome("~/.pi/agent/router", "/home/t"), join("/home/t", ".pi/agent/router"));
  assert.equal(expandHome("~\\data", "/home/t"), join("/home/t", "data"));
  assert.equal(expandHome("  ~/x  ", "/home/t"), join("/home/t", "x"));
  assert.equal(expandHome("", "/home/t"), "");
  assert.equal(expandHome("relative/dir", "/home/t"), "relative/dir");
  assert.equal(expandHome("/abs/dir", "/home/t"), "/abs/dir");
});

test("parseConfig falls back per field and reports why", () => {
  const bad = parseConfig("not an object", "/home/t");
  assert.deepEqual(bad.config, defaultConfig("/home/t"));
  assert.ok(bad.warning?.includes("不是对象"));

  const parsed = parseConfig(
    {
      scope: "project",
      home: "~/custom-router",
      routerReadOnly: false,
      workerModel: "anthropic/claude",
      maxOpenShown: 5,
      progressThrottleMs: 1000,
    },
    "/home/t",
  );
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.config.scope, "project");
  assert.equal(parsed.config.home, resolve(join("/home/t", "custom-router")));
  assert.equal(parsed.config.routerReadOnly, false);
  assert.equal(parsed.config.workerModel, "anthropic/claude");
  assert.equal(parsed.config.maxOpenShown, 5);
  assert.equal(parsed.config.progressThrottleMs, 1000);

  const partial = parseConfig(
    { scope: "galaxy", home: 42, routerReadOnly: "yes", workerModel: 7, maxOpenShown: 0, progressThrottleMs: -1 },
    "/home/t",
  );
  const defaults = defaultConfig("/home/t");
  assert.equal(partial.config.scope, defaults.scope);
  assert.equal(partial.config.home, defaults.home);
  assert.equal(partial.config.routerReadOnly, defaults.routerReadOnly);
  assert.equal(partial.config.workerModel, defaults.workerModel);
  assert.equal(partial.config.maxOpenShown, defaults.maxOpenShown);
  assert.equal(partial.config.progressThrottleMs, defaults.progressThrottleMs);
  assert.ok(partial.warning?.includes("scope"));
  assert.ok(partial.warning?.includes("home"));
  assert.ok(partial.warning?.includes("routerReadOnly"));
  assert.ok(partial.warning?.includes("workerModel"));
  assert.ok(partial.warning?.includes("maxOpenShown"));
  assert.ok(partial.warning?.includes("progressThrottleMs"));
});

test("loadConfig treats a missing file as defaults and a broken file as a warning", async () => {
  const homeDir = await newDir();
  try {
    const missing = await loadConfig({ homedir: homeDir });
    assert.equal(missing.warning, undefined);
    assert.deepEqual(missing.config, defaultConfig(homeDir));

    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await writeFile(configFilePath(homeDir), "{ broken", "utf8");
    const broken = await loadConfig({ homedir: homeDir });
    assert.ok(broken.warning?.includes("解析失败"));
    assert.deepEqual(broken.config, defaultConfig(homeDir));

    await writeFile(
      configFilePath(homeDir),
      JSON.stringify({ scope: "project", routerReadOnly: false, maxOpenShown: 7 }),
      "utf8",
    );
    const valid = await loadConfig({ homedir: homeDir });
    assert.equal(valid.warning, undefined);
    assert.equal(valid.config.scope, "project");
    assert.equal(valid.config.routerReadOnly, false);
    assert.equal(valid.config.maxOpenShown, 7);
  } finally {
    await cleanup(homeDir);
  }
});

test("resolveHome prefers PI_ROUTER_HOME, then scope=project, then config.home", () => {
  const base = defaultConfig("/home/t");
  assert.equal(
    resolveHome("/work/proj", base, { PI_ROUTER_HOME: "~/override" }),
    resolve(join(homedir(), "override")),
  );
  assert.equal(resolveHome("/work/proj", { ...base, scope: "project" }, {}), join("/work/proj", ".pi", "router"));
  assert.equal(resolveHome("/work/proj", base, {}), resolve(join("/home/t", ".pi/agent/router")));
  assert.equal(
    resolveHome("/work/proj", { ...base, scope: "project" }, { PI_ROUTER_HOME: "   " }),
    join("/work/proj", ".pi", "router"),
    "空白 PI_ROUTER_HOME 视为未设置",
  );
});