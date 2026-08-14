/**
 * worker-mode-impl —— headless/managed-profile 共用的 WorkerModeImpl
 * 参考: specs/tech/version_logs/v0.0.266/change_plan.md Delta（registry 重构）
 *       specs/tech/agent/tools/[P1]browser_instance_manager.md §3/§4（worker-based 生命周期）
 *
 * headless/managed-profile 注册同一 impl 实例两键；mode 差异（headless→mkdtemp+headless flag /
 * managed→resolveUserDataDir+persistent flag）是 impl 内部行为，不在 manager。
 * 无状态：不持有实例表；资源操作全经 handle 私有扩展（WorkerHandle）。
 * 泄漏防护四要素（kill 进程组/删 headless 目录/释放端口/删持久化记录）在 close 全路径必达。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserActionParams,
  BrowserExecuteResult,
  BrowserLaunchOptions,
  PersistedInstanceRecord,
} from './types';
import type { BrowserHandle, CloseResult, ExecuteCtx, LaunchResult, ModeImpl, ModeImplEnv } from './mode-impl';
import { resolveUserDataDir, DEFAULT_PROFILE_NAME } from './profile';
import { defaultSpawn, type WorkerSpawnDeps } from './node-worker-driver';
import { spawnPersistentWorker, launchConfirm, waitExit, withAbort } from './persistent-worker';
import { isPidAlive, killProcessGroupByPid, toRecord, errMsg } from './instance-record';
import { formatSnapshotText } from '../snapshot-store';

const LAUNCH_CONFIRM_TIMEOUT_MS = 20_000;
const CLOSE_EXIT_TIMEOUT_MS = 3_000;

/** WorkerModeImpl 构造参数（spawn 注入测试 mock；launchConfirm 超时可选） */
export interface WorkerModeImplOptions {
  spawn?: NonNullable<WorkerSpawnDeps['spawn']>;
  launchConfirmTimeoutMs?: number;
}

/** WorkerHandle —— worker-based 实例私有扩展（manager 不读这些字段） */
export interface WorkerHandle extends BrowserHandle {
  /** managed-profile: 持久目录; headless: mkdtemp 临时目录 */
  userDataDir?: string;
  /** managed-profile: 持久目录名（台账记录用） */
  profileName?: string;
  /** headless/managed-profile 独占端口（instance 生命周期内固定） */
  cdpPort?: number;
  /** 常驻 worker（node 子进程 + 请求路由） */
  worker?: import('./types').PersistentWorker;
  /** worker 子进程 pid（killProcessGroup 用 + 持久化记录核心） */
  workerPid?: number;
  /** chrome 主进程 pid（v0.0.272 launch 确认帧上报；close 超时/孤儿回收的精确锚点） */
  chromePid?: number;
  /** 是否已写入实例记录文件（防重复写；close 后清 false 幂等标记） */
  persisted: boolean;
}

/**
 * WorkerModeImpl（headless/managed-profile 共用；registry 注册两键）。
 * 实现从原 instance-manager worker 段迁移，行为等价（worker 协议/端口/持久化语义不变）。
 * execute 崩溃/cdp_timeout/abort 仅置 handle.state='dead'，close 收尾由 manager 统一执行。
 */
export class WorkerModeImpl implements ModeImpl {
  private readonly spawnFn: NonNullable<WorkerSpawnDeps['spawn']>;
  private readonly launchTimeoutMs: number;
  constructor(opts: WorkerModeImplOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.launchTimeoutMs = opts.launchConfirmTimeoutMs ?? LAUNCH_CONFIRM_TIMEOUT_MS;
  }

  async launch(key: string, opts: BrowserLaunchOptions, env: ModeImplEnv): Promise<LaunchResult> {
    const isManaged = opts.mode === 'managed-profile';
    const profileName = isManaged ? (opts.profileName ?? DEFAULT_PROFILE_NAME) : undefined;
    const userDataDir = isManaged
      ? resolveUserDataDir(env.dataDir, profileName)
      : mkdtempSync(join(tmpdir(), 'rocky-browser-instance-'));
    let cdpPort: number;
    try {
      cdpPort = await env.allocatePort();
    } catch (e) {
      if (!isManaged) rmSync(userDataDir, { recursive: true, force: true });
      return { ok: false, error: { kind: 'port_exhausted', message: errMsg(e) } };
    }
    const handle: WorkerHandle = {
      key,
      mode: opts.mode,
      ...(profileName ? { profileName } : {}),
      userDataDir,
      cdpPort,
      persisted: false,
      state: 'starting',
      createdAt: env.now(),
      lastUsedAt: env.now(),
    };    let spawned: ReturnType<typeof spawnPersistentWorker>;
    try {
      spawned = spawnPersistentWorker(this.spawnFn, {
        executablePath: opts.executablePath,
        userDataDir,
        cdpPort,
        headless: !isManaged ? true : undefined,
        persistent: isManaged, // 连接模式（managed-profile → ensureProfileFree）
        loop: true,
      });
    } catch (e) {
      if (!isManaged) rmSync(userDataDir, { recursive: true, force: true });
      env.releasePort(cdpPort);
      return { ok: false, error: { message: `launch spawn 失败: ${errMsg(e)}` } };
    }
    handle.workerPid = spawned.child.pid ?? 0; // 失败路径 killProcessGroup 锚点
    handle.worker = spawned.worker;
    const launchOutcome = await launchConfirm(spawned.launchReady, this.launchTimeoutMs);
    if (!launchOutcome.ok) {
      handle.state = 'dead';
      await this.close(handle, env);
      return { ok: false, error: launchOutcome.error ?? { message: 'launch 失败' } };
    }
    handle.chromePid = launchOutcome.chromePid; // 确认帧携带（旧 worker undefined 兼容）
    handle.state = 'ready';
    try {
      env.ledger.insert(toRecord(handle));
      handle.persisted = true;
    } catch (e) {
      console.warn(`[worker-mode-impl] ledger.insert 失败（best-effort）: ${errMsg(e)}`);
    }
    return { ok: true, handle, text: `launched ${opts.mode}` };
  }

  async execute(
    handle: BrowserHandle,
    action: string,
    params: BrowserActionParams,
    ctx: ExecuteCtx,
  ): Promise<BrowserExecuteResult> {
    const wh = handle as WorkerHandle;
    if (ctx.signal?.aborted) return { ok: false, error: { message: 'browser: 请求已取消（abort）' } };
    try {
      // abort 事件 → 置 dead（manager 收尾 close；worker exit → reject pending 防 hang）
      const r = await withAbort(ctx.signal, wh.worker!.send(action, params), () => {
        handle.state = 'dead';
      });
      if (!r.ok && r.error?.kind === 'cdp_timeout') {
        handle.state = 'dead'; // action 超时 → manager 收尾 close
      }
      if (r.ok && action === 'screenshot' && r.text) {
        return (await this.saveScreenshot(r.text, ctx)) ?? r;
      }
      return r;
    } catch (e) {
      // worker exit（崩溃）→ pending reject → worker_crashed
      handle.state = 'dead';
      return { ok: false, error: { kind: 'worker_crashed', message: `worker 崩溃: ${errMsg(e)}，请重新 launch` } };
    }
  }

  async close(handle: BrowserHandle, env: ModeImplEnv): Promise<CloseResult> {
    const wh = handle as WorkerHandle;
    if (wh.state !== 'dead' && wh.worker) {
      try {
        wh.worker.child.stdin?.write(
          JSON.stringify({ requestId: wh.worker.nextReqId++, action: 'close', params: {} }) + '\n',
        );
      } catch {
        /* 进程已死，走兜底 */
      }
      await waitExit(wh.worker.child, CLOSE_EXIT_TIMEOUT_MS); // 3s 超时 killProcessGroup 兜底
    }
    if (wh.workerPid) {
      safeCleanup(handle.key, 'killProcessGroup', () => killProcessGroupByPid(wh.workerPid!));
      wh.workerPid = undefined;
    }
    // 裁决⑤/⑥：chrome 是 detached 独立进程组，kill(-workerPid) 杀不到——
    // close 末尾统一校验 chromePid 是否仍存活（覆盖 waitExit 超时 / worker 崩溃 / 正常退出但
    // chrome 残留），存活则 killProcessGroupByPid(chromePid)（负 pid 杀全家）。幂等：已退出 no-op。
    if (wh.chromePid && isPidAlive(wh.chromePid)) {
      safeCleanup(handle.key, 'chrome 进程组（close 后存活兜底）', () => killProcessGroupByPid(wh.chromePid!));
    }
    wh.chromePid = undefined; // chromePid 仅 close 兜底用，清后防重复
    if (wh.mode === 'headless' && wh.userDataDir) {
      safeCleanup(handle.key, 'headless 目录', () => rmSync(wh.userDataDir!, { recursive: true, force: true }));
      wh.userDataDir = undefined;
    }
    if (wh.cdpPort) {
      env.releasePort(wh.cdpPort);
      wh.cdpPort = undefined;
    }
    if (wh.persisted) {
      safeCleanup(handle.key, 'ledger.delete', () => env.ledger.delete(handle.key));
      wh.persisted = false;
    }
    wh.worker = undefined;
    handle.state = 'dead'; // 幂等：二次 close 全字段已清 → no-op
    return { ok: true }; // v0.0.336 CloseResult：worker close 全 safeCleanup best-effort 不抛 → ok
  }

  cleanupOrphan(rec: PersistedInstanceRecord, env: ModeImplEnv): void {
    // 裁决⑤：孤儿记录优先精确杀 chrome 组（detached 独立组；负 pid 杀全家含 worker）；
    // 旧记录（v0.0.272 前无 chromePid）退回杀 workerPid 组
    if (rec.chromePid) {
      killProcessGroupByPid(rec.chromePid);
    } else if (isPidAlive(rec.workerPid)) {
      killProcessGroupByPid(rec.workerPid);
    }
    if (rec.mode === 'headless' && rec.userDataDir) rmSync(rec.userDataDir, { recursive: true, force: true });
    env.ledger.delete(rec.key);
  }

  /** screenshot 落盘（INV-157-1/3）：decode base64 JSON → ctx.snapshot.save → 路径文本 */
  private async saveScreenshot(
    text: string,
    ctx: ExecuteCtx,
  ): Promise<BrowserExecuteResult | undefined> {
    if (!ctx.snapshot) return undefined; // 无 sink → 原样透传（impl 级测试不落盘）
    try {
      const parsed = JSON.parse(text) as { mime?: string; data?: string };
      if (!parsed.mime || !parsed.data) {
        return { ok: false, error: { message: 'browser screenshot: worker 返回数据缺 mime/data' } };
      }
      const r2 = await ctx.snapshot.save(Buffer.from(parsed.data, 'base64'), parsed.mime);
      return { ok: true, text: formatSnapshotText({ relPath: r2.relPath, source: 'browser' }) };
    } catch (e) {
      return { ok: false, error: { message: `browser screenshot 落盘失败: ${errMsg(e)}` } };
    }
  }
}

/** 泄漏防护单项清理（失败 catch 记 warn 不静默） */
function safeCleanup(key: string, label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[worker-mode-impl] ${label} 清理失败 ${key}: ${errMsg(e)}`);
  }
}
