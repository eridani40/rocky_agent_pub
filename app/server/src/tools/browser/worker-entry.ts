/**
 * worker-entry —— Node 侧一次性 browser worker
 *
 * 背景：Bun 运行时下 playwright.chromium.connectOverCDP() 永久 hang（oven-sh/bun#9357），
 * Node 下正常。方案：browser tool 的 playwright 操作整体改走本 node 子进程执行。
 *
 * 设计：一次性执行器（无会话状态保持，对齐 browser tool 一次性调用模式）：
 *   1. 从 stdin 读一行任务 JSON
 *   2. spawn chrome（复用 chrome-launcher.launchChromeAndConnect：进程组 + cdp-ready + connectOverCDP）
 *   3. dispatch 单个 action（参照 playwright-session.ts 实现，纯 playwright page 操作）
 *   4. stdout 输出一行结果 JSON（{ok,text?,error?}）—— 其他诊断信息写 stderr
 *   5. cleanup chrome（killProcessGroup），exit
 *
 * 三流分离：stdin 任务、stdout 结果（单行）、stderr 诊断——避免 chrome stderr 污染结果 JSON。
 *
 * 重要：本文件必须能被 `bun build --target=node --format=cjs --external=playwright` 打包，
 * 故只用 require/import，不依赖 bun-only API。playwright 用 require（build 时 --external 保留）。
 */
import { launchChromeAndConnect, killProcessGroup } from './chrome-launcher';
import { dispatchAction } from './worker-actions';
import type { BrowserActionParams } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PWBrowser = any;

/** 任务 JSON schema（stdin 输入） */
interface WorkerTask {
  executablePath?: string;
  userDataDir: string;
  cdpPort: number;
  headless?: boolean;
  persistent: boolean;
  action: string;
  params: BrowserActionParams;
}

/** 结果 JSON schema（stdout 单行输出） */
interface WorkerResult {
  ok: boolean;
  text?: string;
  error?: { kind?: string; message: string };
}

/** 退出码：成功 0 / 失败 1 */
const EXIT_OK = 0;
const EXIT_FAIL = 1;

/**
 * 输出结果到 stdout（单行 JSON）后退出。
 * 始终输出到 stdout（即使失败），调用方读 stdout 第一行即结果。
 */
function emit(result: WorkerResult, exitCode: number): void {
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // stdout 写失败（极少见）—— 退路：写 stderr 让调用方按退出码判失败
    process.stderr.write('[worker] stdout 写失败\n');
  }
  process.exit(exitCode);
}

/** 失败结果 helper（携带 kind + message） */
function failResult(message: string, kind?: string): WorkerResult {
  return { ok: false, error: { kind, message } };
}

/**
 * 读 stdin 一行（任务 JSON）。
 * 超时（5s）未收到任务 → 失败退出（防 caller 异常时 worker 永久挂起）。
 */
function readTaskFromStdin(): Promise<WorkerTask> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error('等待 stdin 任务超时（5s）'));
    }, 5000);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        try {
          resolve(JSON.parse(line) as WorkerTask);
        } catch (e) {
          reject(new Error(`任务 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      if (!buf) reject(new Error('stdin 关闭前未收到任务'));
    });
    process.stdin.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`stdin 错误: ${e.message}`));
    });
  });
}

/**
 * 入口：读 stdin 任务 → launch chrome + connectOverCDP → 执行 action → 输出结果 → cleanup。
 * 任何阶段失败都输出 failResult 到 stdout（保证 caller 能读结果），exit 1。
 */
async function main(): Promise<void> {
  let task: WorkerTask;
  try {
    task = await readTaskFromStdin();
  } catch (e) {
    return emit(failResult(e instanceof Error ? e.message : String(e), 'unknown'), EXIT_FAIL);
  }

  // launch chrome（spawn + waitForCdp + connectOverCDP）—— Node 下 connectOverCDP 正常
  let browser: PWBrowser;
  let kill: () => Promise<void>;
  try {
    const r = await launchChromeAndConnect({
      executablePath: task.executablePath,
      userDataDir: task.userDataDir,
      cdpPort: task.cdpPort,
      headless: task.headless,
      persistent: task.persistent,
    });
    browser = r.browser;
    kill = r.kill;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // chrome-launcher 抛 BrowserError（带 kind），尝试解析 kind 透传
    const kind = (e as { kind?: string }).kind;
    return emit(failResult(`launch 失败: ${msg}`, kind), EXIT_FAIL);
  }

  // 执行 action；任何异常都视为 fail（含 chrome 不稳定 / action 参数错 / ref 未找到）
  // 注意：emit 内 process.exit 立即终止 node，async finally 来不及跑——cleanup 必须在 emit 前 await。
  let result: WorkerResult;
  try {
    const text = await dispatchAction(browser, task.action, task.params);
    result = { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = failResult(`action "${task.action}" 失败: ${msg}`, 'unknown');
  }
  // 必清 chrome（进程组 SIGKILL，避免孤儿），失败也忽略（不影响结果输出）
  try {
    await kill();
  } catch {
    /* ignore cleanup error */
  }
  emit(result, result.ok ? EXIT_OK : EXIT_FAIL);
}

void main();
