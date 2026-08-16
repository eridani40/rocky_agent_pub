/**
 * quota-sync-service — 全局额度周期同步任务（v0.0.363 T1）
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.2/§1.4
 *
 * 语义：server 全局后台任务——每 interval（默认 5min）跑一轮 collectQuotaSnapshots
 * → QuotaStore 全量覆盖（含 error item）→ SSE provider_quota topic 广播（group _all）。
 * 启动立即首轮（15s 内补齐重启空窗）；GET 空窗/POST sync 触发的增量走同一 syncOnce。
 *
 * 并发/节流：inFlight flag（上一轮未完跳过触发）+ lastTriggeredAt 30s 节流
 * （多页面同时打开触发增量不叠加）。SIGTERM/SIGINT trap 清 interval。
 */
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import type { QuotaStore } from './quota-store';
import { collectQuotaSnapshots } from '../handlers/provider-quota';
import type { ReplayableEventBus } from '../agent/event-hub';
import { PROVIDER_QUOTA_TOPIC, PROVIDER_QUOTA_BROADCAST_GROUP } from './quota-events';

/** 默认同步周期 5min（ms） */
export const DEFAULT_QUOTA_SYNC_INTERVAL_MS = 300_000;

/** 触发节流窗口 30s（ms）——多页面同时打开触发增量不叠加 */
export const QUOTA_SYNC_THROTTLE_MS = 30_000;

/** 节流跳过原因（POST /provider/quota/sync 响应 reason 字段值） */
export type QuotaSyncSkipReason = 'in_flight' | 'throttled';

/**
 * 解析同步周期 env 配置。
 * QUOTA_SYNC_INTERVAL_MS 缺省 300000；非法值（NaN/非正数）回落默认（容错不炸启动）。
 * packaged 护栏语义：仅 dev/prod env 层读取（同既有 env 惯例）。
 */
export function parseQuotaSyncIntervalMs(
  raw: string | undefined,
): number {
  if (raw === undefined) return DEFAULT_QUOTA_SYNC_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUOTA_SYNC_INTERVAL_MS;
  return Math.floor(n);
}

/**
 * 全局额度同步服务（bootstrap-store-phase 构造 + start；registerTopic 先于 start）。
 * syncOnce 失败 fail-silent（catch + console.warn）——统计类容错语义，不炸周期任务。
 */
export class QuotaSyncService {
  private readonly svc: AppConfigService;
  private readonly pluginManager: PluginManager;
  private readonly store: QuotaStore;
  private readonly bus: ReplayableEventBus | undefined;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private lastTriggeredMs = 0;
  private trapRegistered = false;

  constructor(opts: {
    svc: AppConfigService;
    pluginManager: PluginManager;
    store: QuotaStore;
    /** SSE 广播 bus（provider_quota topic；测试可不传 = 跳过 emit） */
    bus?: ReplayableEventBus;
    /** 周期 ms（缺省 DEFAULT_QUOTA_SYNC_INTERVAL_MS；UT 可传小值） */
    intervalMs?: number;
  }) {
    this.svc = opts.svc;
    this.pluginManager = opts.pluginManager;
    this.store = opts.store;
    this.bus = opts.bus;
    this.intervalMs = opts.intervalMs ?? DEFAULT_QUOTA_SYNC_INTERVAL_MS;
  }

  /** 是否有轮次在跑（UT/POST sync reason 用） */
  isInFlight(): boolean {
    return this.inFlight;
  }

  /** 上次触发时刻（UT introspect + POST sync 响应字段；0=从未触发） */
  get lastTriggeredAt(): number {
    return this.lastTriggeredMs;
  }

  /**
   * 触发一次同步（POST sync / GET 空窗异步触发入口）。
   * 返回 null = 已接受（实际执行 fire-and-forget）；返回 reason = 跳过原因。
   */
  triggerSync(): QuotaSyncSkipReason | null {
    if (this.inFlight) return 'in_flight';
    const now = Date.now();
    if (this.lastTriggeredMs !== 0 && now - this.lastTriggeredMs < QUOTA_SYNC_THROTTLE_MS) {
      return 'throttled';
    }
    // fire-and-forget：调用方（handler）不 await，执行态由 store/SSE 传达
    void this.syncOnce().catch(() => {
      // syncOnce 内部已 catch；此 catch 兜底防未处理 rejection
    });
    return null;
  }

  /**
   * 跑一轮同步：collect → store 全量覆盖 → SSE emit。
   * 错误隔离：collect 整体失败不写 store、不推进 lastSyncedAt（保留上轮有效值），
   * fail-silent 不抛（周期任务不被打崩）。
   */
  async syncOnce(): Promise<void> {
    if (this.inFlight) return; // 周期触发防重入（change_plan §1.2）
    this.inFlight = true;
    this.lastTriggeredMs = Date.now();
    try {
      const items = await collectQuotaSnapshots(this.svc, this.pluginManager);
      const syncedAt = Date.now();
      this.store.replaceAll(items, syncedAt);
      // SSE 推送（bus 未注入时跳过——纯 store UT 场景）；timestamp ISO 字符串（app-task-lock 先例）
      if (this.bus) {
        const view = this.store.view();
        this.bus.emit(PROVIDER_QUOTA_BROADCAST_GROUP, {
          data: view,
          timestamp: new Date(syncedAt).toISOString(),
        });
      }
    } catch (e) {
      console.warn('[quota-sync] syncOnce failed (fail-silent, keep last store):', e);
    } finally {
      this.inFlight = false;
    }
  }

  /** 启动：立即跑首轮（fire-and-forget 不阻塞启动）+ interval 周期任务 + shutdown trap */
  start(): void {
    if (this.timer !== undefined) return; // 幂等
    // 启动首轮（15s 内补齐重启空窗——change_plan §1.2；15s timeout 在 impl 内）
    void this.syncOnce().catch(() => {
      // syncOnce 内部已 catch，此 catch 兜底防未处理 rejection
    });
    this.timer = setInterval(() => {
      void this.syncOnce().catch(() => {
        // 同上：兜底防未处理 rejection
      });
    }, this.intervalMs);
    this.registerShutdownTrap();
  }

  /** 停止周期任务（UT 显式清理 + SIGTERM trap 调用） */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** interval 句柄（UT introspect：验证 start/stop 生命周期） */
  hasTimer(): boolean {
    return this.timer !== undefined;
  }

  /** SIGTERM/SIGINT trap 清 interval（squad-runtime.registerShutdownTrap 同模式；幂等 flag 防重复挂载） */
  private registerShutdownTrap(): void {
    if (this.trapRegistered) return;
    this.trapRegistered = true;
    const handler = (): void => {
      try {
        this.stop();
      } catch {
        // trap 内吞错（防进程退出时抛 uncaught）
      }
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  }
}
