/**
 * instance-manager —— BrowserInstanceManager（session×mode[:profile] 常驻浏览器实例管理器）
 * 参考: specs/tech/agent/tools/[P1]browser_instance_manager.md §3-§8 + change_plan v0.0.266 Delta（T3 registry 重构）
 *
 * T3 收敛：manager = key 计算 + 句柄表 + registry 分发 + 状态机。
 * 零 `mode ===` 判断；不读 handle 私有字段；launch/execute/close 全经 impl（崩溃/失活置 dead →
 * manager 收尾 closeInstance）；usedPorts 归 manager（env 暴露）；attach 依赖经 env 透传 impl。
 */
import type { BrowserActionParams, BrowserExecuteResult, BrowserLaunchOptions, PersistedInstanceRecord } from './types';
import type { BrowserHandle, ExecuteCtx, ModeImplEnv, ModeImplRegistry } from './mode-impl';
import type { ChromeMcpDriver } from './chrome-mcp-driver';
import type { BrowserInstanceLedger } from './instance-ledger';
import { allocateCdpPort, netPortBusy, type PortBusyFn } from './cdp-port';
import { killProcessGroupByPid, errMsg } from './instance-record';
import { rmSync } from 'node:fs';
import type { ChromeScanResult, OrphanChromeCtx } from './orphan-scan';
import { scanRockyChromeProcesses, isOrphanChrome, buildOrphanCtx } from './orphan-scan';
import type { WorkerHandle } from './worker-mode-impl';

/** 默认 idle 超时（15 分钟） */
export const BROWSER_INSTANCE_IDLE_TIMEOUT_MS = 15 * 60_000;

/** 默认周期对账间隔（10 分钟；unref 不阻塞退出） */
export const BROWSER_INSTANCE_RECONCILE_INTERVAL_MS = 10 * 60_000;

/** 可注入依赖（registry/ledger 必填；portBusy/now/idle/attach/reconcile 可选） */
export interface InstanceManagerDeps {
  dataDir: string;
  /** mode → impl 路由（headless/managed 共键 + attach 键） */
  registry: ModeImplRegistry;
  /** 资源台账（v0.0.334 B3：启动自检/对账数据源，替代 browser-instances.json） */
  ledger: BrowserInstanceLedger;
  portBusy?: PortBusyFn;
  now?: () => number;
  idleTimeoutMs?: number;
  /** attach 驱动（ChromeMcpDriver 单例，bootstrap 注入；经 env 透传 impl） */
  attachDriver?: ChromeMcpDriver;
  /** attach switch 门禁（读 connectorManager.getState switch；经 env 透传 impl） */
  isAttachEnabled?: () => boolean;
  /** 周期对账间隔 ms（缺省 10min；≤0 关闭周期扫描，测试注入短值） */
  reconcileIntervalMs?: number;
  /** ps 扫描注入（测试 mock；缺省真 ps -axo → ChromeScanResult 双段：all 全量表 + candidates marker chrome） */
  scanProcesses?: () => Promise<ChromeScanResult>;
}

/** key = `${sessionId}:${mode}`（三模式统一，profileName 不进 key；owner 天然隔离） */
export function instanceKey(sessionId: string, opts: BrowserLaunchOptions): string {
  return `${sessionId}:${opts.mode}`;
}

/** mode 展示文本（仅 mode；实例已由 handle 承载 profile，避免 opts.profileName 误导） */
function modeLabel(opts: BrowserLaunchOptions): string {
  return opts.mode;
}

/** 前置校验返回类型 */
type AssertResult = { ok: true; instance: BrowserHandle } | { ok: false; error: { kind: string; message: string } };

/** BrowserInstanceManager —— 平台级常驻浏览器实例管理器（构造即开机自检 + shutdown hook） */
export class BrowserInstanceManager {
  private readonly instances = new Map<string, BrowserHandle>();
  private readonly usedPorts = new Set<number>();
  private readonly registry: ModeImplRegistry;
  private readonly dataDir: string;
  private readonly ledger: BrowserInstanceLedger;
  private readonly portBusy: PortBusyFn;
  private readonly nowFn: () => number;
  private readonly idleTimeoutMs: number;
  private readonly env: ModeImplEnv;
  private readonly reconcileIntervalMs: number | undefined;
  private readonly scanProcesses: () => Promise<ChromeScanResult>;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: InstanceManagerDeps) {
    this.registry = deps.registry;
    this.dataDir = deps.dataDir;
    this.ledger = deps.ledger;
    this.portBusy = deps.portBusy ?? netPortBusy;
    this.nowFn = deps.now ?? Date.now;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? BROWSER_INSTANCE_IDLE_TIMEOUT_MS;
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? BROWSER_INSTANCE_RECONCILE_INTERVAL_MS;
    this.scanProcesses = deps.scanProcesses ?? (() => scanRockyChromeProcesses());
    this.env = {
      dataDir: deps.dataDir,
      now: () => this.nowFn(),
      allocatePort: () => allocateCdpPort(this.usedPorts, this.portBusy),
      releasePort: (port) => void this.usedPorts.delete(port),
      ledger: deps.ledger,
      attachDriver: deps.attachDriver,
      isAttachEnabled: deps.isAttachEnabled,
      // v0.0.334 fix：attach 失活即时摘表（绑定 F4 discardInstance，箭头保持 this）
      discardInstance: (key) => this.discardInstance(key),
    };
    this.cleanupOrphans();
    // 裁决⑥：启动 fire-and-forget 对账扫描（不阻塞构造；失败仅 warn，不影响服务起来）
    void this.reconcileOrphans().catch((e) =>
      console.warn(`[browser-instance-manager] 启动对账失败: ${errMsg(e)}`),
    );
    this.registerShutdownHooks();
    this.startReconcileInterval();
  }

  /** 开机自检：读台账 → 按 rec.mode 查 registry → impl.cleanupOrphan → 全清 */
  private cleanupOrphans(): void {
    let records: PersistedInstanceRecord[];
    try {
      records = this.ledger.listAll();
    } catch (e) {
      console.warn(`[browser-instance-manager] 开机自检读台账失败: ${errMsg(e)}`);
      return;
    }
    for (const rec of records) {
      try { this.registry.get(rec.mode).cleanupOrphan?.(rec, this.env); } catch (e) {
        console.warn(`[browser-instance-manager] 开机自检清理记录失败 ${rec.key}: ${errMsg(e)}`);
      }
    }
    // 启动时无合法实例，全部记录=残留，处理完一次性清空（幂等）
    try {
      this.ledger.clearAll();
    } catch (e) {
      console.warn(`[browser-instance-manager] 开机自检清空台账失败: ${errMsg(e)}`);
    }
  }

  /**
   * 对账扫描（裁决②③）：活跃 pid 集合（instances 含 starting/closing + 持久化记录）∪
   * 全量 ps 扫描 diff → 孤儿 chrome 回收（kill 进程组 + 删 rocky headless 目录 + 记录同步）。
   * 三层判定防误杀：①chromePidSet 精确 ②ppid∈workerPidSet（旧记录兼容）③ppid cmdline 含
   * worker-entry（launch 中保护）→ 否则孤儿。失败仅 warn（best-effort，不阻塞主流程）。
   * C1 修复：scan 双段返回——all（全量进程表）建 procByPid（ppid 反查 worker-entry 必须全量），
   * candidates（marker chrome）才是回收判定对象（worker-entry 进程本身不在候选不被回收）。
   */
  private async reconcileOrphans(): Promise<void> {
    let scan: ChromeScanResult;
    try {
      scan = await this.scanProcesses();
    } catch (e) {
      console.warn(`[browser-instance-manager] 对账扫描失败: ${errMsg(e)}`);
      return;
    }
    if (scan.candidates.length === 0) return;
    // 活跃集合：instances（含 starting/closing）+ 持久化记录。reconcile 需读进程 pid——
    // 架构裁决②显式要求 active set 含 instances，此处是「不读 handle 私有字段」的受控例外
    const chromePidSet = new Set<number>();
    const workerPidSet = new Set<number>();
    for (const inst of this.instances.values()) {
      const wh = inst as WorkerHandle;
      if (wh.workerPid) workerPidSet.add(wh.workerPid);
      if (wh.chromePid) chromePidSet.add(wh.chromePid);
    }
    let records: PersistedInstanceRecord[] = [];
    try { records = this.ledger.listAll(); } catch { records = []; }
    for (const rec of records) {
      workerPidSet.add(rec.workerPid);
      if (rec.chromePid) chromePidSet.add(rec.chromePid);
    }
    // procByPid 基于全量进程表（含 worker-entry node 进程 → 第三层 ppid 反查生效）
    const { procByPid } = buildOrphanCtx(scan.all);
    const ctx: OrphanChromeCtx = { chromePidSet, workerPidSet, procByPid };
    for (const proc of scan.candidates) {
      if (!isOrphanChrome(proc, ctx)) continue;
      console.warn(`[browser-instance-manager] 对账回收孤儿 chrome pid=${proc.pid} ppid=${proc.ppid}`);
      try { killProcessGroupByPid(proc.pid); } catch (e) {
        console.warn(`[browser-instance-manager] 孤儿 chrome kill 失败 pid=${proc.pid}: ${errMsg(e)}`);
      }
      if (proc.userDataDir) {
        try { rmSync(proc.userDataDir, { recursive: true, force: true }); } catch (e) {
          console.warn(`[browser-instance-manager] 孤儿目录删除失败 ${proc.userDataDir}: ${errMsg(e)}`);
        }
        // 记录同步：孤儿 chrome 的 rocky 目录匹配记录 → ledger.delete（防记录残留下次启动误判）
        for (const rec of records) {
          if (rec.userDataDir === proc.userDataDir) this.ledger.delete(rec.key);
        }
      }
    }
  }

  /** 周期对账（裁决⑥：10min setInterval unref，不阻塞进程退出；≤0 关闭） */
  private startReconcileInterval(): void {
    const ms = this.reconcileIntervalMs;
    if (!ms || ms <= 0) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileOrphans().catch((e) =>
        console.warn(`[browser-instance-manager] 周期对账失败: ${errMsg(e)}`),
      );
    }, ms);
    this.reconcileTimer.unref();
  }

  /** 停止周期对账（shutdown/测试清理用；unref 已不阻塞退出） */
  stopReconcileInterval(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  /** shutdown hook 注册（幂等：模块级标记位防重复挂载） */
  registerShutdownHooks(): void {
    if (globalThis.__browserInstanceManagerShutdownHookRegistered) return;
    globalThis.__browserInstanceManagerShutdownHookRegistered = true;
    const trap = (): void => { void this.releaseAll().catch(() => { /* shutdown 吞错 */ }); };
    process.on('beforeExit', trap);
    process.on('SIGTERM', trap);
    process.on('SIGINT', trap);
  }

  /** 显式启动/复用。幂等：ready 复用（同 session 同 mode 重复 launch = 复用，不换 profile）；非 ready → 清理旧 + impl.launch 新建 */
  async launch(
    sessionId: string,
    opts: BrowserLaunchOptions,
    ctx?: { signal?: AbortSignal },
  ): Promise<BrowserExecuteResult> {
    const key = instanceKey(sessionId, opts);
    const existing = this.instances.get(key);
    if (existing?.state === 'ready') {
      existing.lastUsedAt = this.nowFn();
      // 复用文本用 handle 存的首次 profileName（不读 opts.profileName——可能缺/不同）
      const handle = existing as { profileName?: string };
      return {
        ok: true,
        text: `reuse ${opts.mode}${handle.profileName ? ` (profile: ${handle.profileName})` : ''}`,
      };
    }
    if (existing) {
      try { await this.closeInstance(key, existing); } catch (e) {
        console.warn(`[browser-instance-manager] launch 前清理旧实例失败 ${key}: ${errMsg(e)}`);
      }
    }
    // H7：ctx?.signal 透传 impl.launch（attach 超时 abort 感知；worker impl 忽略）
    const r = await this.registry.get(opts.mode).launch(key, opts, this.env, ctx?.signal);
    if (!r.ok) return { ok: false, error: r.error };
    this.instances.set(r.handle.key, r.handle);
    return { ok: true, text: r.text };
  }

  /** 执行 action：前置校验 → registry 分发 impl.execute（三模式统一路由） */
  async execute(
    sessionId: string,
    opts: BrowserLaunchOptions,
    action: string,
    params: BrowserActionParams,
    ctx: ExecuteCtx = {},
  ): Promise<BrowserExecuteResult> {
    const key = instanceKey(sessionId, opts);
    const asserted = await this.assertReadyInstance(key, opts);
    if (!asserted.ok) return { ok: false, error: asserted.error };
    const r = await this.registry.get(opts.mode).execute(asserted.instance, action, params, ctx);
    asserted.instance.lastUsedAt = this.nowFn(); // idle 计时刷新（成功/失败都刷，对齐原语义）
    if (asserted.instance.state === 'dead') {
      // v0.0.336 三层一致补防（独立复审裁决）：closeInstance 清理失败（ok=false 转抛）不逃逸出 execute——
      // catch 住保留表项可重试，返回原 r（attach_lost/worker_crashed 等预期文案），不降级 RUNTIME_ERROR。
      try {
        await this.closeInstance(key, asserted.instance); // impl.close 幂等兜底 + 删表
      } catch (e) {
        console.warn(`[browser-instance-manager] execute 失活收尾清理失败 ${key}: ${errMsg(e)}`);
      }
    }
    return r;
  }

  /** 显式关闭（无实例 → 明确报错提示先 launch；有实例重复 close 仍幂等） */
  async close(sessionId: string, opts: BrowserLaunchOptions): Promise<BrowserExecuteResult> {
    const key = instanceKey(sessionId, opts);
    const inst = this.instances.get(key);
    if (!inst) {
      return {
        ok: false,
        error: {
          kind: 'no_browser_instance',
          message: `当前会话没有 ${opts.mode} 浏览器实例，请先调用 browser(action="launch")`,
        },
      };
    }
    // v0.0.336 三层一致：closeInstance 清理失败抛错（impl.close ok=false 转抛）→ catch 诚实返回 error，
    // 不穿透调用方；instances 表项已保留（closeInstance 不删表），可重试 close。
    try {
      const tip = await this.closeInstance(key, inst);
      return { ok: true, text: tip ?? 'closed' };
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'close_incomplete',
          message: `close 清理不完整（实例保留可重试）: ${errMsg(e)}`,
        },
      };
    }
  }

  /** session 结束兜底：kill 该 session 全部 instance（key 前缀匹配） */
  async releaseSession(sessionId: string): Promise<void> {
    await this.releaseKeys([...this.instances.keys()].filter((k) => k.startsWith(`${sessionId}:`)));
  }

  /** 全部关闭（shutdown hook 用） */
  async releaseAll(): Promise<void> {
    await this.releaseKeys([...this.instances.keys()]);
  }

  /** 批量 close（releaseSession/releaseAll 共用；单实例失败 warn 不中断） */
  private async releaseKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      const inst = this.instances.get(key);
      if (!inst) continue;
      try { await this.closeInstance(key, inst); } catch (e) {
        console.warn(`[browser-instance-manager] release 清理失败 ${key}: ${errMsg(e)}`);
      }
    }
  }

  /** 测试观察口（不属公共 API）：当前实例数 */
  get size(): number { return this.instances.size; }

  /**
   * 即时摘表（v0.0.334 fix：attach 失活即时清内存 instance）。
   * 专供 impl 在失活等「资源已死、无需走 impl.close」场景下即时摘表，让 size/listAll 实时准确。
   * 同步无副作用（仅删内存 Map）；不调 impl.close（attach 失活时 MCP 连接已断，无需 disconnect）；
   * 不动台账（台账由 impl 自删，见 attach-mode-impl.execute 失活分支）。
   * 幂等：key 不存在 no-op。
   */
  discardInstance(key: string): void {
    this.instances.delete(key);
  }

  /** 前置校验抽公共：instance 存在 + ready + idle lazy check */
  private async assertReadyInstance(key: string, opts: BrowserLaunchOptions): Promise<AssertResult> {
    const inst = this.instances.get(key);
    if (!inst || inst.state !== 'ready') {
      return { ok: false, error: { kind: 'no_browser_instance', message: `当前会话没有 ${modeLabel(opts)} 浏览器实例，请先调用 browser(action="launch")` } };
    }
    // idle lazy check：超时 → 自动 close + 提示重新 launch
    if (this.nowFn() - inst.lastUsedAt > this.idleTimeoutMs) {
      // v0.0.336 三层一致补防（独立复审裁决）：closeInstance 清理失败（ok=false 转抛）不逃逸出
      // assertReadyInstance——catch 住保留表项可重试，仍返回 idle_timeout 预期文案（不降级 RUNTIME_ERROR）。
      try {
        await this.closeInstance(key, inst);
      } catch (e) {
        console.warn(`[browser-instance-manager] idle timeout 收尾清理失败 ${key}: ${errMsg(e)}`);
      }
      return { ok: false, error: { kind: 'idle_timeout', message: '浏览器实例已闲置关闭，请重新 launch' } };
    }
    inst.lastUsedAt = this.nowFn();
    return { ok: true, instance: inst };
  }

  /** 单实例关闭：registry 分发 impl.close（资源清理全在 impl）+ 删表；返回 impl 提示文本（无则 undefined） */
  private async closeInstance(key: string, inst: BrowserHandle): Promise<string | void> {
    let tip: string | void;
    try {
      const result = await this.registry.get(inst.mode).close(inst, this.env);
      // v0.0.336 三层一致（leader 约束 2）：impl.close 返回 ok=false → 清理失败诚实上报，
      // **不删 instances**（保留表项让调用方知状态未归零，可重试 close），返回 error。
      if (!result.ok) {
        console.warn(`[browser-instance-manager] close 清理不完整 ${key}: ${result.error.message}`);
        throw new Error(result.error.message); // 转为抛错走下方 catch 统一不删表路径
      }
      tip = result.text;
    } catch (e) {
      // impl.close 抛错 或 ok=false 转抛错：catch 仅 warn，**仍不删表**（诚实报失败，三层一致：
      // 清理失败 → 内存 Map 保留表项 → 调用方/下次 close 可重试，杜绝「close 没清干净却报成功」）。
      console.warn(`[browser-instance-manager] close 清理失败 ${key}: ${errMsg(e)}`);
      tip = undefined;
      // 不 return tip，继续走下方 throw 让 manager.close 返回 error（诚实上报）
      throw e;
    }
    this.instances.delete(key);
    return tip;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __browserInstanceManagerShutdownHookRegistered: boolean | undefined;
}
