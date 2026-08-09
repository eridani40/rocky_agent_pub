/**
 * worker-entry —— Node 侧 browser worker（单次 + 常驻循环双模式）
 * 背景：Bun 下 playwright.connectOverCDP 永久 hang（oven-sh/bun#9357），Node 下正常 →
 * browser tool 的 playwright 操作整体走本 node 子进程执行。
 * 双模式（v0.0.264）：单次（web_fetch / executeOnce）读一行任务 → launch → dispatch → 输出 → kill →
 * exit；常驻（BrowserInstanceManager）launch 带 loop:true → launch 后不退出，循环读 stdin 行
 * {requestId, action, params} → dispatch → stdout 响应；close / stdin end → kill chrome → exit(0)。
 * 跨 action 保持 lastRefs（snapshot ref → click/type 复用——「像人的浏览器」关键体验）。
 * 三流分离：stdin 任务、stdout 结果（每行 JSON）、stderr 诊断。
 * 打包约束：本文件须能被 `bun build --target=node --format=cjs --external=playwright` 打包，
 * 只用 require/import；playwright 用 require（build 时 --external 保留）。
 */
import { launchChromeAndConnect, killProcessGroup } from './chrome-launcher';
import { dispatchAction } from './worker-actions';
import type { BrowserActionParams, WorkerSessionState } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PWBrowser = any;

/** launch 任务 JSON schema（stdin 首行） */
interface LaunchTask {
  executablePath?: string;
  userDataDir: string;
  cdpPort: number;
  headless?: boolean;
  /** 连接模式标记：持久 profile（managed-profile）→ ensureProfileFree；传给 launchChromeAndConnect */
  persistent?: boolean;
  /** 常驻循环标记（仅 InstanceManager 传）：launch 后不退出，循环读 stdin 行任务 */
  loop?: boolean;
  /** 单次模式：action + params（常驻模式首行不含，走后续行） */
  action?: string;
  params?: BrowserActionParams;
}

/** 常驻循环任务行 schema（stdin 后续行） */
interface LoopTask {
  requestId: number;
  action: string;
  params?: BrowserActionParams;
}

/** 结果 JSON schema（stdout 单行输出；requestId 仅常驻循环模式带） */
interface WorkerResult {
  ok: boolean;
  requestId?: number;
  text?: string;
  /** chrome 进程 pid（launch 确认帧携带；v0.0.272 孤儿对账锚点） */
  chromePid?: number;
  error?: { kind?: string; message: string };
}

/** 退出码：成功 0 / 失败 1 */
const EXIT_OK = 0;
const EXIT_FAIL = 1;

/** 输出一行结果到 stdout（常驻模式不退出；单次模式由调用方决定 exit） */
function emitLine(result: WorkerResult): void {
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // stdout 写失败（极少见）—— 写 stderr 让调用方按退出码判失败
    process.stderr.write('[worker] stdout 写失败\n');
  }
}

/** 失败结果 helper（携带 kind + message） */
function failResult(message: string, kind?: string): WorkerResult {
  return { ok: false, error: { kind, message } };
}

/** 退出（单次模式用）：输出结果到 stdout 后 exit */
function emit(result: WorkerResult, exitCode: number): void {
  emitLine(result);
  process.exit(exitCode);
}

/**
 * 读 stdin 一行 JSON（首行用）。
 * 超时（5s）未收到任务 → 失败退出（防 caller 异常时 worker 永久挂起）。
 */
function readTaskFromStdin(): Promise<LaunchTask> {
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
          resolve(JSON.parse(line) as LaunchTask);
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
 * 循环读 stdin 行 JSON（常驻模式后续行用）。父进程关闭 stdin / error → resolve(null)（触发退出）。
 * 后续行无首行 5s 超时（常驻等待，父进程 close 触发退出）。
 */
function readLoopTasks(): AsyncIterableIterator<LoopTask | null> {
  let buffer = '';
  let resolvers: Array<(v: LoopTask | null) => void> = [];
  let ended = false;
  let done = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    // 按行派发
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const resolver = resolvers.shift();
      if (!resolver) continue; // 无等待者（不应发生）→ 丢弃
      try {
        resolver(JSON.parse(line) as LoopTask);
      } catch {
        resolver(null); // 坏行 → 视为结束（防死循环）
      }
    }
  });
  process.stdin.on('end', () => {
    ended = true;
    for (const resolver of resolvers.splice(0)) resolver(null);
  });
  process.stdin.on('error', () => {
    ended = true;
    for (const resolver of resolvers.splice(0)) resolver(null);
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<LoopTask | null>> {
      if (done) return { done: true, value: undefined };
      if (buffer.indexOf('\n') >= 0) {
        const nl = buffer.indexOf('\n');
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          return { done: false, value: JSON.parse(line) as LoopTask };
        } catch {
          done = true;
          return { done: true, value: undefined };
        }
      }
      if (ended) {
        done = true;
        return { done: true, value: undefined };
      }
      return await new Promise<LoopTask | null>((resolve) => {
        resolvers.push(resolve);
      }).then((value) => (value === null ? { done: true, value: undefined } : { done: false, value }));
    },
  };
}

/**
 * 单次执行（web_fetch / executeOnce）：launch → dispatch 单个 action → 输出 → kill → exit。
 * 任何阶段失败都输出 failResult 到 stdout（保证 caller 能读结果），exit 1。
 */
async function runOnce(task: LaunchTask): Promise<void> {
  let browser: PWBrowser;
  let kill: () => Promise<void>;
  try {
    const r = await launchChromeAndConnect({
      executablePath: task.executablePath,
      userDataDir: task.userDataDir,
      cdpPort: task.cdpPort,
      headless: task.headless,
      persistent: !!task.persistent,
    });
    browser = r.browser;
    kill = r.kill;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kind = (e as { kind?: string }).kind; // chrome-launcher 抛 BrowserError（带 kind）
    return emit(failResult(`launch 失败: ${msg}`, kind), EXIT_FAIL);
  }

  // 执行 action；任何异常都视为 fail。注意 emit 内 process.exit 立即终止 node，
  // async finally 来不及跑——cleanup 必须在 emit 前 await。
  let result: WorkerResult;
  try {
    const text = await dispatchAction(browser, task.action ?? '', task.params ?? {}, { lastRefs: {} });
    result = { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = failResult(`action "${task.action ?? ''}" 失败: ${msg}`, 'unknown');
  }
  // 必清 chrome（进程组 SIGKILL，避免孤儿），失败也忽略（不影响结果输出）
  try {
    await kill();
  } catch {
    /* ignore cleanup error */
  }
  emit(result, result.ok ? EXIT_OK : EXIT_FAIL);
}

/**
 * 常驻循环（BrowserInstanceManager）：launch → emit launched → 循环读任务 → dispatch → emit。
 * close / stdin end → kill chrome → exit(0)。
 */
async function runPersistent(task: LaunchTask): Promise<void> {
  let browser: PWBrowser;
  let kill: () => Promise<void>;
  try {
    const r = await launchChromeAndConnect({
      executablePath: task.executablePath,
      userDataDir: task.userDataDir,
      cdpPort: task.cdpPort,
      headless: task.headless,
      persistent: !!task.persistent, // 连接模式标记（managed-profile 才 ensureProfileFree）
    });
    browser = r.browser;
    kill = r.kill;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kind = (e as { kind?: string }).kind;
    return emit(failResult(`launch 失败: ${msg}`, kind), EXIT_FAIL);
  }

  // launch 确认帧（InstanceManager 等它 → state=ready）；chromePid = browser.process()?.pid（孤儿对账锚点）
  const chromePid = browser?.process?.()?.pid as number | undefined;
  emitLine({ ok: true, text: 'launched', chromePid });

  // 跨 action 会话状态：lastRefs 在常驻循环内保持（snapshot ref → click/type 复用）
  const state: WorkerSessionState = { lastRefs: {} };

  for await (const line of readLoopTasks()) {
    if (!line) {
      // stdin end（父进程关闭）→ kill chrome → exit
      try {
        await kill();
      } catch {
        /* ignore */
      }
      process.exit(EXIT_OK);
    }
    if (line.action === 'close') {
      // 显式 close：kill chrome → emit 确认 → exit(0)
      try {
        await kill();
      } catch {
        /* ignore */
      }
      emitLine({ ok: true, text: 'closed' });
      process.exit(EXIT_OK);
    }
    // 常规 action：dispatch → emit 响应（不退出，chrome 常驻）
    let result: WorkerResult;
    try {
      const text = await dispatchAction(browser, line.action, line.params ?? {}, state);
      result = { ok: true, text };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = failResult(`action "${line.action}" 失败: ${msg}`, 'unknown');
    }
    emitLine({ requestId: line.requestId, ok: result.ok, text: result.text, error: result.error });
  }
}

/**
 * 入口：读首行任务 → loop:true 走常驻循环，否则单次。
 */
async function main(): Promise<void> {
  let task: LaunchTask;
  try {
    task = await readTaskFromStdin();
  } catch (e) {
    return emit(failResult(e instanceof Error ? e.message : String(e), 'unknown'), EXIT_FAIL);
  }
  if (task.loop === true) {
    await runPersistent(task);
  } else {
    await runOnce(task);
  }
}

void main();
