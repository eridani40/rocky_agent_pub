// app/server/src/tools/browser/chrome-launcher.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs3 = require("node:fs");

// app/server/src/tools/browser/chrome-discover.ts
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_child_process = require("node:child_process");

// app/server/src/tools/browser/types.ts
class BrowserError extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.name = "BrowserError";
    this.kind = kind;
  }
}

// app/server/src/tools/browser/chrome-discover.ts
var CHROMIUM_BUNDLE_IDS = new Set([
  "com.google.chrome",
  "com.google.chrome.canary",
  "org.chromium.chromium",
  "com.microsoft.edgemac",
  "com.brave.browser",
  "com.vivaldi.vivaldi",
  "com.operasoftware.opera",
  "company.thebrowser.browser",
  "ru.yandex.desktop.yandex-browser"
]);
var MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
];
var LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
  "/snap/bin/chromium"
];
var defaultDeps = () => ({
  exists: import_node_fs.existsSync,
  readdir: import_node_fs.readdirSync,
  execFileSync: import_node_child_process.execFileSync,
  homedir: import_node_os.homedir
});
function discoverChromeExecutable(userPath, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (userPath) {
    if (d.exists(userPath))
      return userPath;
    throw new BrowserError("chrome_not_found", `用户配置 executablePath="${userPath}" 不存在`);
  }
  const sys = detectDefaultBrowser(d);
  if (sys)
    return sys;
  const hardcoded = findHardcodedCandidate(d);
  if (hardcoded)
    return hardcoded;
  throw new BrowserError("chrome_not_found", "chrome 未找到：请安装 chrome 或在 config 配置 browser.executablePath");
}
function detectDefaultBrowser(d) {
  const platform = process.platform;
  if (platform === "darwin")
    return detectMacDefault(d);
  if (platform === "linux")
    return detectLinuxDefault(d);
  return;
}
function detectMacDefault(d) {
  try {
    const plistPath = import_node_path.join(d.homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    if (!d.exists(plistPath))
      return;
    const json = d.execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
      timeout: 4000
    });
    const parsed = JSON.parse(json);
    const handlers = parsed.LSHandlers ?? [];
    const bundleId = handlers.find((h) => h.LSHandlerURLScheme === "https")?.LSHandlerRoleAll ?? handlers.find((h) => h.LSHandlerURLScheme === "http")?.LSHandlerRoleAll;
    if (!bundleId || !CHROMIUM_BUNDLE_IDS.has(bundleId))
      return;
    const appPath = d.execFileSync("osascript", ["-e", `tell application "Finder" to application file id "${bundleId}" as text`], {
      timeout: 4000
    }).trim().replace(/:$/, "/");
    if (!appPath)
      return;
    const execName = readBundleExecutable(bundleId, appPath, d);
    const execPath = import_node_path.join(posixAppPath(appPath), "Contents", "MacOS", execName);
    return d.exists(execPath) ? execPath : undefined;
  } catch {
    return;
  }
}
function readBundleExecutable(bundleId, appPath, d) {
  try {
    const infoPlist = import_node_path.join(posixAppPath(appPath), "Contents", "Info.plist");
    const json = d.execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlist], { timeout: 4000 });
    const info = JSON.parse(json);
    if (info.CFBundleExecutable)
      return info.CFBundleExecutable;
  } catch {}
  return bundleId.split(".").pop() ?? "chrome";
}
function posixAppPath(appPath) {
  let p = appPath.replace(/:$/, "");
  if (p.startsWith("Macintosh HD"))
    p = p.slice("Macintosh HD".length);
  return p.replace(/:/g, "/");
}
function detectLinuxDefault(d) {
  try {
    const desktop = d.execFileSync("xdg-settings", ["get", "default-web-browser"], { timeout: 4000 }).trim();
    if (!desktop)
      return;
    const dirs = [
      import_node_path.join(d.homedir(), ".local/share/applications", desktop),
      `/usr/share/applications/${desktop}`
    ];
    const file = dirs.find((p) => d.exists(p));
    if (!file)
      return;
    const content = import_node_fs.readFileSync(file, "utf8");
    const execLine = content.split(`
`).map((l) => l.trim()).filter((l) => l.startsWith("Exec=") && !l.startsWith("TryExec="))[0];
    if (!execLine)
      return;
    const cmd = execLine.slice("Exec=".length).split(/\s+/)[0];
    if (!cmd)
      return;
    if (cmd.startsWith("/"))
      return d.exists(cmd) ? cmd : undefined;
    const resolved = d.execFileSync("which", [cmd], { timeout: 4000 }).trim().split(`
`)[0];
    return resolved && d.exists(resolved) ? resolved : undefined;
  } catch {
    return;
  }
}
function findHardcodedCandidate(d) {
  const platform = process.platform;
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(...MAC_CANDIDATES);
    candidates.push(...playwrightChromiumCandidatesMac(d));
  }
  if (platform === "linux") {
    candidates.push(...LINUX_CANDIDATES);
    candidates.push(...playwrightChromiumCandidatesLinux(d));
  }
  return candidates.find((p) => d.exists(p));
}
function listChromiumDirs(d, base) {
  try {
    return d.readdir(base).filter((name) => name.startsWith("chromium-"));
  } catch {
    return [];
  }
}
function playwrightChromiumCandidatesLinux(d) {
  const base = import_node_path.join(d.homedir(), ".cache", "ms-playwright");
  return listChromiumDirs(d, base).map((dir) => import_node_path.join(base, dir, "chrome-linux", "chrome"));
}
function playwrightChromiumCandidatesMac(d) {
  const base = import_node_path.join(d.homedir(), "Library", "Caches", "ms-playwright");
  const execRel = import_node_path.join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  const dirs = listChromiumDirs(d, base);
  const out = [];
  for (const dir of dirs) {
    out.push(import_node_path.join(base, dir, "chrome-mac-arm64", execRel));
    out.push(import_node_path.join(base, dir, "chrome-mac", execRel));
  }
  return out;
}

// app/server/src/tools/browser/launch-args.ts
function isHeadlessForcedByLinuxEnv(env = process.env, platform = process.platform) {
  if (platform !== "linux")
    return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
function resolveHeadless(input) {
  if (typeof input.headlessOverride === "boolean")
    return input.headlessOverride;
  const env = input.env ?? process.env;
  const envVal = env.ROCKY_BROWSER_HEADLESS;
  if (envVal === "1" || envVal === "true")
    return true;
  if (envVal === "0" || envVal === "false")
    return false;
  if (input.linuxNoDisplay)
    return true;
  return false;
}
var BASE_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-features=Translate,MediaRouter",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
  "--no-proxy-server"
];
function buildChromeLaunchArgs(input) {
  const headless = resolveHeadless({
    headlessOverride: input.headlessOverride,
    linuxNoDisplay: input.linuxNoDisplay
  });
  const args = [
    `--remote-debugging-port=${input.cdpPort}`,
    `--user-data-dir=${input.userDataDir}`,
    ...BASE_FLAGS
  ];
  if (headless) {
    args.push("--headless=new");
    args.push("--disable-gpu");
  }
  if (input.noSandbox) {
    args.push("--no-sandbox");
  }
  if (process.platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  return args;
}
var BASE_FLAGS_COUNT = BASE_FLAGS.length;

// app/server/src/tools/browser/cdp-ready.ts
var CDP_POLL_INTERVAL_MS = 200;
var CDP_POLL_TIMEOUT_MS = 1e4;
async function waitForCdpReady(port, deps = {}) {
  const fetch2 = deps.fetch ?? defaultFetch;
  const interval = deps.intervalMs ?? CDP_POLL_INTERVAL_MS;
  const timeout = deps.timeoutMs ?? CDP_POLL_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const url = `http://127.0.0.1:${port}/json/version`;
  const start = now();
  while (true) {
    try {
      const res = await fetch2(url);
      if (res.ok || res.status === 200) {
        if (isReadyWithWsField(res))
          return;
        if (res.body === undefined && res.webSocketDebuggerUrl === undefined)
          return;
      }
    } catch {}
    if (now() - start >= timeout) {
      throw new BrowserError("cdp_timeout", `chrome CDP 端口 ${port} 在 ${timeout}ms 内未就绪`);
    }
    await sleep(interval);
  }
}
function isReadyWithWsField(res) {
  if (res.webSocketDebuggerUrl !== undefined) {
    return res.webSocketDebuggerUrl.length > 0;
  }
  if (res.body !== undefined) {
    try {
      const parsed = JSON.parse(res.body);
      const ws = parsed.webSocketDebuggerUrl;
      return typeof ws === "string" && ws.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}
var defaultFetch = async (url) => {
  const res = await fetch(url);
  const body = res.ok ? await res.text() : undefined;
  return { ok: res.ok, status: res.status, body };
};
function cdpEndpointUrl(port) {
  return `http://127.0.0.1:${port}`;
}

// app/server/src/tools/browser/singleton-lock.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var SINGLETON_LOCK = "SingletonLock";
var SINGLETON_SOCKET = "SingletonSocket";
var SINGLETON_COOKIE = "SingletonCookie";
function readSingletonLockTarget(lockPath, readlink = import_node_fs2.readlinkSync) {
  let target;
  try {
    target = readlink(lockPath);
  } catch {
    return;
  }
  const m = target.match(/^(?<host>.+)-(?<pid>\d+)$/);
  if (!m || !m.groups)
    return;
  const pid = Number.parseInt(m.groups.pid, 10);
  if (!Number.isFinite(pid))
    return;
  return { host: m.groups.host, pid };
}
function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function ensureProfileFree(userDataDir, deps = {}) {
  const readlink = deps.readlink ?? import_node_fs2.readlinkSync;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const exists = deps.exists ?? import_node_fs2.existsSync;
  const unlink = deps.unlink ?? ((p) => import_node_fs2.unlinkSync(p));
  const lockPath = import_node_path2.join(userDataDir, SINGLETON_LOCK);
  if (!exists(lockPath))
    return;
  const target = readSingletonLockTarget(lockPath, readlink);
  if (!target)
    return;
  if (pidAlive(target.pid)) {
    throw new BrowserError("profile_in_use", `browser profile 正被另一 chrome 进程占用 (pid=${target.pid})：请关闭该 chrome 或换 profile`);
  }
  for (const name of [SINGLETON_LOCK, SINGLETON_SOCKET, SINGLETON_COOKIE]) {
    const p = import_node_path2.join(userDataDir, name);
    try {
      if (exists(p))
        unlink(p);
    } catch {}
  }
}

// app/server/src/tools/browser/chrome-launcher.ts
var CONNECT_CDP_TIMEOUT_MS = 15000;
async function launchChromeAndConnect(input, deps = {}) {
  const executable = discoverChromeExecutable(input.executablePath, deps);
  try {
    return await tryLaunch(input, executable, deps);
  } catch (e) {
    if (e instanceof BrowserError && e.kind === "launch_failed" && !isConnectFailure(e)) {
      throw e;
    }
    const firstMsg = e instanceof Error ? e.message : String(e);
    try {
      return await tryLaunch(input, executable, deps);
    } catch (e2) {
      const secondMsg = e2 instanceof Error ? e2.message : String(e2);
      throw new BrowserError("launch_failed", `connectOverCDP 重试仍失败（首次: ${firstMsg}; 二次: ${secondMsg}）`);
    }
  }
}
function isConnectFailure(e) {
  return e.message.includes("connectOverCDP") || e.kind === "cdp_timeout";
}
async function tryLaunch(input, executable, deps) {
  if (input.persistent) {
    ensureProfileFree(input.userDataDir);
  }
  import_node_fs3.mkdirSync(input.userDataDir, { recursive: true });
  const args = buildChromeLaunchArgs({
    cdpPort: input.cdpPort,
    userDataDir: input.userDataDir,
    headlessOverride: input.headless,
    linuxNoDisplay: isHeadlessForcedByLinuxEnv()
  });
  const spawnFn = deps.spawn ?? ((cmd, a) => spawnChromeProcess(cmd, a));
  let child;
  try {
    child = spawnFn(executable, args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError("launch_failed", `chrome 启动失败: ${withChromiumHint(msg)}`);
  }
  const stderrBuf = collectStderr(child);
  const waitForCdp = deps.waitForCdp ?? ((port) => waitForCdpReady(port));
  try {
    await waitForCdp(input.cdpPort);
  } catch (e) {
    killProcessGroup(child);
    const tail = readStderrTail(stderrBuf);
    const baseMsg = e instanceof Error ? e.message : String(e);
    throw new BrowserError("cdp_timeout", tail ? `${baseMsg}（chrome stderr 尾: ${tail}）` : baseMsg);
  }
  const connectCDP = deps.connectCDP ?? defaultConnectCDP;
  let browser;
  try {
    browser = await connectCDP(cdpEndpointUrl(input.cdpPort), CONNECT_CDP_TIMEOUT_MS);
  } catch (e) {
    killProcessGroup(child);
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError("launch_failed", `connectOverCDP 失败: ${withChromiumHint(msg)}`);
  }
  return {
    browser,
    kill: async () => {
      killProcessGroup(child);
    }
  };
}
function spawnChromeProcess(cmd, a) {
  return import_node_child_process2.spawn(cmd, a, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
}
function killProcessGroup(child) {
  try {
    if (child.pid && !child.killed) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {}
}
function collectStderr(child) {
  const buf = [];
  const MAX = 8 * 1024;
  try {
    const stderr = child.stderr;
    if (!stderr)
      return buf;
    let total = 0;
    stderr.on("data", (chunk) => {
      if (total >= MAX)
        return;
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      total += s.length;
      buf.push(s);
    });
  } catch {}
  return buf;
}
function readStderrTail(buf) {
  if (buf.length === 0)
    return "";
  const joined = buf.join("");
  return joined.slice(-500).replace(/\n+/g, " ").trim();
}
var defaultConnectCDP = async (endpoint, timeoutMs) => {
  const { chromium } = require("playwright");
  const task = chromium.connectOverCDP(endpoint);
  if (!timeoutMs)
    return task;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`connectOverCDP: Timeout ${timeoutMs}ms exceeded.`)), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
};
function withChromiumHint(msg) {
  const CHROMIUM_MISSING_PATTERNS = [
    "Executable doesn't exist",
    "browserType.launch",
    "chromium" + " not found",
    "chromium-"
  ];
  const hit = CHROMIUM_MISSING_PATTERNS.some((p) => msg.includes(p));
  if (!hit)
    return msg;
  return `${msg}
chromium 未安装，请运行 \`bunx playwright install chromium\`（首次 bun install 会自动拉取，离线/受限环境可手动执行）`;
}

// app/server/src/tools/browser/snapshot-ref.ts
var ROLE_NAME_RE = /^(\s*)-?\s*([a-zA-Z][\w-]*)(?:\s*\[ref=[^\]]*\])?\s*(?::\s*)?"(.*)"$/;
function parseSnapshotNodes(text) {
  const counters = new Map;
  const nodes = [];
  for (const rawLine of text.split(`
`)) {
    const m = rawLine.match(ROLE_NAME_RE);
    if (!m)
      continue;
    const role = m[2];
    const name = m[3];
    if (!name)
      continue;
    const key = `${role}\x00${name}`;
    const nth = counters.get(key) ?? 0;
    counters.set(key, nth + 1);
    nodes.push({ role, name, nth });
  }
  return nodes;
}
function buildRefId(role, name, nth) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  return `${role}-${slug || "elem"}-${nth}`;
}
function buildSnapshotResult(text, format) {
  const nodes = parseSnapshotNodes(text);
  const refs = {};
  for (const n of nodes) {
    const id = buildRefId(n.role, n.name, n.nth);
    refs[id] = { role: n.role, name: n.name, nth: n.nth };
  }
  return { snapshot: text, refs };
}
function lookupRef(refs, ref) {
  const info = refs[ref];
  if (!info)
    throw new Error(`browser ref "${ref}" 未找到（请先 snapshot）`);
  return info;
}

// app/server/src/tools/browser/worker-actions.ts
async function dispatchAction(browser, action, params) {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  let page = ctx.pages()[0];
  if (!page)
    page = await ctx.newPage();
  let lastRefs = {};
  switch (action) {
    case "navigate": {
      const url = params.url ?? "";
      if (!url)
        throw new Error("browser navigate: url 必填");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return `navigated to ${url}`;
    }
    case "render": {
      const url = params.url ?? "";
      if (!url)
        throw new Error("browser render: url 必填");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return await page.content();
    }
    case "snapshot": {
      const format = params.format ?? "aria";
      const mode = format === "ai" ? "ai" : "default";
      let text;
      try {
        text = await page.locator("body").ariaSnapshot({ mode });
      } catch {
        text = await page.ariaSnapshot({ mode });
      }
      const result = buildSnapshotResult(text, format);
      lastRefs = result.refs;
      return JSON.stringify(result);
    }
    case "click": {
      const ref = params.ref ?? "";
      if (!ref)
        throw new Error("browser click: ref 必填");
      const info = lookupRef(lastRefs, ref);
      const locator = page.getByRole(info.role, { name: info.name, exact: true }).nth(info.nth);
      await locator.click({ timeout: 5000 });
      return `clicked ${ref}`;
    }
    case "type": {
      const ref = params.ref ?? "";
      const text = params.text ?? "";
      if (!ref)
        throw new Error("browser type: ref 必填");
      const info = lookupRef(lastRefs, ref);
      const locator = page.getByRole(info.role, { name: info.name, exact: true }).nth(info.nth);
      await locator.fill(text, { timeout: 5000 });
      return `typed into ${ref}`;
    }
    case "listPages": {
      const pages = ctx.pages();
      const out = pages.map((p, i) => ({
        id: String(p.url ? p.url() : `page-${i}`),
        url: p.url ? p.url() : "",
        selected: i === 0
      }));
      return JSON.stringify(out);
    }
    case "selectPage": {
      return `selected page ${params.ref ?? ""}`;
    }
    case "evaluate": {
      const script = params.text ?? "";
      const r = await page.evaluate(script);
      return JSON.stringify(r);
    }
    case "screenshot": {
      const data = await page.screenshot({ type: "png" });
      return JSON.stringify({ mime: "image/png", data: data.toString("base64") });
    }
    default:
      throw new Error(`browser: 未知 action "${action}"`);
  }
}

// app/server/src/tools/browser/worker-entry.ts
var EXIT_OK = 0;
var EXIT_FAIL = 1;
function emit(result, exitCode) {
  try {
    process.stdout.write(JSON.stringify(result) + `
`);
  } catch {
    process.stderr.write(`[worker] stdout 写失败
`);
  }
  process.exit(exitCode);
}
function failResult(message, kind) {
  return { ok: false, error: { kind, message } };
}
function readTaskFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error("等待 stdin 任务超时（5s）"));
    }, 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf(`
`);
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(new Error(`任务 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      if (!buf)
        reject(new Error("stdin 关闭前未收到任务"));
    });
    process.stdin.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`stdin 错误: ${e.message}`));
    });
  });
}
async function main() {
  let task;
  try {
    task = await readTaskFromStdin();
  } catch (e) {
    return emit(failResult(e instanceof Error ? e.message : String(e), "unknown"), EXIT_FAIL);
  }
  let browser;
  let kill;
  try {
    const r = await launchChromeAndConnect({
      executablePath: task.executablePath,
      userDataDir: task.userDataDir,
      cdpPort: task.cdpPort,
      headless: task.headless,
      persistent: task.persistent
    });
    browser = r.browser;
    kill = r.kill;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kind = e.kind;
    return emit(failResult(`launch 失败: ${msg}`, kind), EXIT_FAIL);
  }
  let result;
  try {
    const text = await dispatchAction(browser, task.action, task.params);
    result = { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = failResult(`action "${task.action}" 失败: ${msg}`, "unknown");
  }
  try {
    await kill();
  } catch {}
  emit(result, result.ok ? EXIT_OK : EXIT_FAIL);
}
main();
