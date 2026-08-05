/**
 * ChannelBindingStore —— channel_bindings 域的双向索引存储
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.4（binding 双向唯一 D6）
 *       specs/tech/channel/[P0]channel_manager.md §3.8（store 接口）
 *       specs/tech/persistence/[P0]crud_store_interface.md（SchemaDef 约定）
 *
 * 设计：
 *   - 落盘路径：{root}/channel_bindings/<configId>__<conversationId>.json
 *   - 正向索引：(configId, conversationId) → binding（一对一覆盖）
 *   - 反向索引：sessionId → binding（唯一，channel D6 不变量；违反时 bind 上游报错）
 *   - 落盘字段 instanceId→configId 走 MigrationManager 一次性迁移（channel-binding-config-id）
 *
 * 反向索引在内存维护（启动 bootstrap 扫盘恢复），FsCrudStore 持久化正向记录。
 */
import type { SchemaDef, InferRecord } from '../persistence/schema-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import type { ChannelBinding } from './types';

/** channel_bindings entity SchemaDef（扁平布局，id=复合键） */
export const ChannelBindingSchema = {
  entity: 'channel_bindings',
  engine: 'file',
  fields: {
    id: { type: 'string', required: true },
    configId: { type: 'string', required: true },
    conversationId: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    boundBy: { type: 'string', required: true },
    boundAt: { type: 'number', required: true },
  },
} as const satisfies SchemaDef;

export type ChannelBindingRecord = InferRecord<typeof ChannelBindingSchema>;

/** 构造复合主键（file 命名约定：`<configId>__<conversationId>`） */
export function bindingId(configId: string, conversationId: string): string {
  return `${configId}__${conversationId}`;
}

/** ChannelBindingStore 构造参数 */
export interface ChannelBindingStoreOptions {
  /** 数据根目录 */
  root: string;
}

/**
 * 双向索引 binding 存储：
 *   - 正键 (configId, conversationId) → binding
 *   - 反键 sessionId → binding（唯一，违反抛错）
 *
 * 反向索引内存维护（Map<sessionId, binding>），put/delete 同步更新；
 * 进程重启后 bootstrap 时由消费方（ChannelManager.bootstrap）遍历 store.query 重建。
 */
export class ChannelBindingStore {
  private readonly store: CompositeStore;
  /** 反向索引 sessionId → binding（唯一） */
  private readonly bySession: Map<string, ChannelBinding> = new Map();

  constructor(opts: ChannelBindingStoreOptions) {
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount(ChannelBindingSchema.entity, fs);
  }

  /**
   * 启动恢复：扫盘所有 binding，重建反向索引。
   * 由 ChannelManager.bootstrap 在 connect 之前调用一次。
   */
  rebuildReverseIndex(): void {
    this.bySession.clear();
    const records = this.store.query(ChannelBindingSchema, {});
    for (const r of records) {
      const b = r as unknown as ChannelBinding;
      // 反向唯一破坏（脏盘）：后写覆盖前写，log 但不抛（不阻塞启动）
      this.bySession.set(b.sessionId, b);
    }
  }

  /** 查正向（未绑返 null） */
  get(configId: string, conversationId: string): ChannelBinding | null {
    const rec = this.store.get(ChannelBindingSchema, bindingId(configId, conversationId));
    return rec ? (rec as unknown as ChannelBinding) : null;
  }

  /** 查反向（sessionId → binding；唯一，未绑返 null） */
  findBySession(sessionId: string): ChannelBinding | null {
    const b = this.bySession.get(sessionId);
    return b ?? null;
  }

  /**
   * upsert（覆盖该 (config, conversation) 旧值；同步维护反向索引）。
   * **不**在此做反向唯一检查（由 ChannelManager.bind 上游做，便于抛业务 code）。
   */
  upsert(b: ChannelBinding): void {
    const record = { ...b, id: bindingId(b.configId, b.conversationId) };
    // 先处理正向覆盖的旧 binding（若旧 sessionId 与新不同 → 从反向索引清旧）
    const old = this.get(b.configId, b.conversationId);
    if (old && old.sessionId !== b.sessionId) {
      this.bySession.delete(old.sessionId);
    }
    this.store.put(ChannelBindingSchema, record as unknown as ChannelBindingRecord);
    this.bySession.set(b.sessionId, { ...b, id: record.id });
  }

  /** 删正向（同步清反向） */
  delete(configId: string, conversationId: string): void {
    const id = bindingId(configId, conversationId);
    const existing = this.get(configId, conversationId);
    if (existing) {
      this.bySession.delete(existing.sessionId);
    }
    this.store.delete(ChannelBindingSchema, id);
  }

  /** 按 session 删（session DELETE 兜底，孤儿清理）；返被清的 (configId, conversationId) 列表 */
  deleteBySession(sessionId: string): { configId: string; conversationId: string }[] {
    const b = this.bySession.get(sessionId);
    if (!b) return [];
    this.store.delete(ChannelBindingSchema, bindingId(b.configId, b.conversationId));
    this.bySession.delete(sessionId);
    return [{ configId: b.configId, conversationId: b.conversationId }];
  }

  /** 按 config 删（config DELETE 兜底）；返被清的 sessionId 列表 */
  deleteByInstance(configId: string): string[] {
    const cleared: string[] = [];
    // 扫反向索引找该 config 的所有 binding
    for (const [sid, b] of this.bySession) {
      if (b.configId === configId) {
        this.store.delete(ChannelBindingSchema, bindingId(b.configId, b.conversationId));
        this.bySession.delete(sid);
        cleared.push(sid);
      }
    }
    return cleared;
  }

  /** 该 config 的 binding 数（GET /config/channels 聚合展示用） */
  countByInstance(configId: string): number {
    let n = 0;
    for (const b of this.bySession.values()) {
      if (b.configId === configId) n++;
    }
    return n;
  }

  /** 列该 config 的所有 binding（connect 成功后重建 accumulator 用） */
  listByInstance(configId: string): ChannelBinding[] {
    const out: ChannelBinding[] = [];
    for (const b of this.bySession.values()) {
      if (b.configId === configId) out.push(b);
    }
    return out;
  }
}
