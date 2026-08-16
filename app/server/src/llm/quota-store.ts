/**
 * quota-store — 全局额度快照内存权威源（v0.0.363 T1）
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.2
 *
 * 语义：QuotaSyncService 每轮 syncOnce 全量覆盖写入；两消费端（squad 额度弹层 +
 * 全局模型页）经 GET /provider/quota 读 store 秒开；store 更新经 SSE provider_quota
 * topic 推送打开中的页面。
 *
 * 不持久化（老板 20:33 ①）：额度快照时效性强，重启后启动即跑首轮同步补齐（15s 内），
 * 持久化旧值反而误导。纯数据无 IO。
 */

import type { QuotaSnapshot } from './provider-types';

/** store 读视图（GET /provider/quota 响应体同构） */
export interface QuotaStoreView {
  items: QuotaSnapshot[];
  lastSyncedAt: number | null;
}

/**
 * 全局额度 store（进程级单例语义，由 bootstrap-store-phase 构造注入）。
 * 内存 Map<providerId, QuotaSnapshot>；全量覆盖写（含 error item——错误态也是状态）。
 */
export class QuotaStore {
  private readonly snapshots = new Map<string, QuotaSnapshot>();
  private syncedAt: number | null = null;

  /** 全量覆盖写（syncOnce 完成时调用；items 为空数组也推进 lastSyncedAt——零 native provider 也是有效同步） */
  replaceAll(items: QuotaSnapshot[], syncedAt: number): void {
    this.snapshots.clear();
    for (const item of items) {
      this.snapshots.set(item.providerId, item);
    }
    this.syncedAt = syncedAt;
  }

  /** 读视图（GET 端点直接序列化返回） */
  view(): QuotaStoreView {
    return { items: [...this.snapshots.values()], lastSyncedAt: this.syncedAt };
  }

  /** store 是否为空（启动空窗判定：GET 空时异步触发首轮） */
  isEmpty(): boolean {
    return this.snapshots.size === 0;
  }

  /** 最近同步时刻（POST /provider/quota/sync 响应字段） */
  get lastSyncedAt(): number | null {
    return this.syncedAt;
  }
}
