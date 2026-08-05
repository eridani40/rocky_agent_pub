/**
 * NodeWorkerDriver —— BrowserDriver 实现（mode ① headless / ② managed-profile）
 *
 * Bun 主进程不直接调 playwright.connectOverCDP（永久 hang），
 * 改 spawn node 子进程（browser-worker.cjs）执行 connectOverCDP + action + cleanup。
 *
 * 设计：
 *   - executeOnce(opts, action, params, signal)：spawn worker → 写任务 JSON 到 stdin →
 *     读 stdout 第一行结果 JSON → 返回 {ok,text?,error?}
 *   - 三流分离：stdin 任务 / stdout 结果（单行）/ stderr 诊断
 *   - 超时（30s）+ AbortSignal 取消（abort → kill worker 进程组，防 hang）
 *   - worker 路径：resolveWorkerPath 双路径探测（packaged=同目录 worker-entry.js tsc 产物；
 *     dev=browser-worker.cjs bundle），node 从脚本位置向上找 node_modules
 *
 * connect(opts) 不实现（headless/managed-profile 不走长 session；attach 由 ChromeMcpDriver）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import type {
  BrowserDriver,
  BrowserSession,
  BrowserConnectOptions,
  BrowserActionParams,
  BrowserExecuteResult,
} from './types';
import { BrowserError } from './types';
import { resolveUserDataDir, DEFAULT_PROFILE_NAME } from './profile';
import { allocateCdpPort, netPortBusy, type PortBusyFn } from './cdp-port';
import { killProcessGroup } from './chrome-launcher';

/** worker.cjs 默认单次执行超时（ms）。navigate/snapshot 一般 <10s，screenshot/evaluate 留余量 */
export const WORKER_TIMEOUT_MS = 30_000;

/** 可注入依赖（测试 mock spawn / sleep 用）。spawn 类型与 chrome-launcher.LaunchDeps 对齐 */
export interface WorkerSpawnDeps {
  /**
   * spawn 注入点（测试用）。生产用 node child_process.spawn。
   * mock 时返回可 emit stdout/stderr/exit 的假 ChildProcess。
   */
  spawn?: (
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
  ) => ChildProcess;
}

/** NodeWorkerDriver 构造参数（同 PlaywrightDriverOptions） */
export interface NodeWorkerDriverOptions {
  /** app dataDir（resolveUserDataDir 用，profile 目录解析） */
  dataDir: string;
  /** 端口占用探测（默认 netPortBusy，per-profile 端口段分配） */
  portBusy?: PortBusyFn;
  /** spawn 注入（测试 mock） */
  spawnDeps?: WorkerSpawnDeps;
}

/**
 * NodeWorkerDriver（mode ① + ② 共用实例）。
 * 每次 executeOnce 全新 spawn worker，per-call 端口 + userDataDir 解析（与 PlaywrightDriver.connect 同口径）。
 */
export class NodeWorkerDriver implements BrowserDriver {
  readonly mode = 'headless' as const; // 实际 mode 按 opts 推断（与 PlaywrightDriver 一致）
  private readonly dataDir: string;
  private readonly portBusy: PortBusyFn;
  private readonly spawnFn: NonNullable<WorkerSpawnDeps['spawn']>;
  private readonly usedPorts = new Set<number>();

  constructor(opts: NodeWorkerDriverOptions) {
    this.dataDir = opts.dataDir;
    this.portBusy = opts.portBusy ?? netPortBusy;
    this.spawnFn = opts.spawnDeps?.spawn ?? defaultSpawn;
  }

  /**
   * headless/managed-profile 不走长 session（attach 由 ChromeMcpDriver）。
   * 调用此方法表示代码路径错（tool.ts 应调 executeOnce）。
   */
  async connect(): Promise<BrowserSession> {
    throw new BrowserError(
      'unknown',
      'NodeWorkerDriver 不支持长 session（用 executeOnce 一次性执行）',
    );
  }

  /**
   * 一次性执行：spawn node worker → 写任务 → 读结果 → 清理。
   * @param opts 连接选项（profileName/headless/executablePath/userDataDir）
   * @param action navigate/snapshot/click/type/evaluate/listPages/selectPage/screenshot
   * @param params action 参数
   * @param signal 取消信号（abort → kill worker 进程组）
   */
  async executeOnce(
    opts: BrowserConnectOptions,
    action: string,
    params: BrowserActionParams,
    signal?: AbortSignal,
  ): Promise<BrowserExecuteResult> {
    // 解析连接参数（与 PlaywrightDriver.connect 同口径）
    const persistent = !!opts.profileName;
    const profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;
    const userDataDir =
      opts.userDataDir ??
      (persistent
        ? resolveUserDataDir(this.dataDir, profileName)
        : mkdtempSync(join(tmpdir(), 'rocky-browser-worker-')));
    const cdpPort = await allocateCdpPort(this.usedPorts, this.portBusy);
    this.usedPorts.add(cdpPort);

    const task = {
      executablePath: opts.executablePath,
      userDataDir,
      cdpPort,
      headless: persistent ? opts.headless : opts.headless ?? true,
      persistent,
      action,
      params,
    };

    return this.runWorker(task, signal);
  }

  /**
   * spawn worker 子进程并通信。提取出便于测试 mock spawn。
   * 全程捕获：超时 / abort / worker exit 非 0 / stdout 解析失败 都转成 {ok:false,error}。
   */
  private async runWorker(
    task: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrowserExecuteResult> {
    const workerPath = resolveWorkerPath();
    // cwd 设为 worktree 根（node 从 cjs 向上找 node_modules，worktree 根有 node_modules/playwright）
    const cwd = process.cwd();
    const child = this.spawnFn('node', [workerPath], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 共享状态：resolved 防多次 resolve；finishResolver 用于 abort/超时主动 resolve
    let resolved = false;
    let stderrBuf = '';
    let timer: NodeJS.Timeout | undefined;
    let finishResolver: ((r: BrowserExecuteResult) => void) | undefined;

    /** 统一收尾：kill 进程组 + 拼 stderr + resolve promise */
    const finish = (r: BrowserExecuteResult): void => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      // stderr 拼进失败 message 利排障（成功时丢弃）
      if (!r.ok && stderrBuf.trim()) {
        r.error = r.error ?? { message: '' };
        r.error.message = `${r.error.message}（worker stderr: ${stderrBuf.slice(-500).trim()}）`;
      }
      try {
        killProcessGroup(child); // 进程组 SIGKILL（chrome-launcher 复用）
      } catch {
        /* ignore cleanup error */
      }
      finishResolver?.(r);
    };

    // AbortSignal 取消：abort → 主动 finish（kill + resolve 取消结果，防 hang）
    if (signal) {
      if (signal.aborted) {
        return { ok: false, error: { message: 'browser: 请求已取消（abort）' } };
      }
      signal.addEventListener(
        'abort',
        () =>
          finish({
            ok: false,
            error: { message: 'browser: 请求已取消（abort）' },
          }),
        { once: true },
      );
    }

    // 写任务 JSON + 换行到 stdin，结束 stdin（worker 读到一行即开始）
    try {
      child.stdin?.write(JSON.stringify(task) + '\n');
      child.stdin?.end();
    } catch (e) {
      // stdin 写失败 → cleanup worker 进程组（防孤儿）后返回错误
      try {
        killProcessGroup(child);
      } catch {
        /* ignore */
      }
      return { ok: false, error: { message: `worker stdin 写失败: ${errMsg(e)}` } };
    }

    // 读 stdout（取第一行 = 结果 JSON），stderr 收诊断
    return new Promise<BrowserExecuteResult>((resolve) => {
      finishResolver = resolve;
      let stdoutBuf = '';

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (resolved) return;
        stdoutBuf += chunk;
        const nl = stdoutBuf.indexOf('\n');
        if (nl >= 0) {
          const line = stdoutBuf.slice(0, nl);
          let parsed: BrowserExecuteResult;
          try {
            parsed = JSON.parse(line) as BrowserExecuteResult;
          } catch (e) {
            parsed = { ok: false, error: { message: `worker stdout 非 JSON: ${errMsg(e)}` } };
          }
          finish(parsed);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk;
        if (stderrBuf.length > 8 * 1024) stderrBuf = stderrBuf.slice(-8 * 1024);
      });

      // 超时：worker 在 WORKER_TIMEOUT_MS 内未输出结果 → kill + 超时错误
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            error: { kind: 'cdp_timeout', message: `worker 执行超时（${WORKER_TIMEOUT_MS}ms）` },
          }),
        WORKER_TIMEOUT_MS,
      );

      // worker 进程意外退出（exit 非 0 / 未输出结果）→ 按失败处理
      child.on('exit', (code, sig) => {
        if (resolved) return;
        if (code === 0) {
          // 正常退出但没读到 stdout 结果（不该发生）—— 兜底
          finish({ ok: false, error: { message: 'worker 退出但未输出结果' } });
        } else {
          finish({
            ok: false,
            error: { message: `worker 异常退出 code=${code} sig=${sig ?? ''}` },
          });
        }
      });

      child.on('error', (e) => {
        if (resolved) return;
        finish({ ok: false, error: { message: `worker spawn error: ${e.message}` } });
      });
    });
  }
}

/**
 * 默认 spawn：node + worker.cjs（cwd/env 由调用方设）。
 * packaged Electron 下 server 进程内跑、process.env 无 PATH → 字面 'node' 崩 ENOENT，
 * 故检测 process.versions.electron 改用 process.execPath + ELECTRON_RUN_AS_NODE=1（纯 node 语义）；dev 走原 'node'。
 * 参考: memory `packaged-spawn-external-binary-exec-path`、CLAUDE.md「持续可打包护栏」③
 */
export function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcess {
  // packaged Electron（server 进程内跑）：spawn Electron binary under ELECTRON_RUN_AS_NODE=1 = 纯 node 语义
  if (process.versions.electron) {
    return spawn(process.execPath, args, {
      ...opts,
      detached: true,
      env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' },
    } as object) as ChildProcess;
  }
  // dev：cmd='node'（PATH 有 node），args / stdio / env 透传不变
  return spawn(cmd, args, { ...opts, detached: true } as object) as ChildProcess;
}

/**
 * 解析 worker 脚本绝对路径（本文件同目录），双路径 existsSync 探测：
 *   - 优先 worker-entry.js：tsc 编译产物，packaged（dist/ 同目录）真实命中，
 *     其 require('./chrome-launcher'/'./snapshot-ref'/'playwright') 在 dist 均可解析。
 *   - 否则 browser-worker.cjs：dev bundle（__dirname=src 时命中；tsc 不把 .cjs 拷进 dist，
 *     packaged 下无此文件 → 不探测会直接 spawn ENOENT）。
 * 两者同源（worker-entry.ts），通信协议一致（stdin task / stdout result）。
 */
function resolveWorkerPath(): string {
  // __dirname 在 bun build 产物（cjs）+ ts 源码（tsx/vitest）下都可用
  const dir = dirname(__filename);
  const compiled = join(dir, 'worker-entry.js');
  if (existsSync(compiled)) return compiled;
  return join(dir, 'browser-worker.cjs');
}

/** 错误信息提取 helper */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
