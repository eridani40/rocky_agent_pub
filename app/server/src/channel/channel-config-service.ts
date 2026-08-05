/**
 * ChannelConfigService —— channel_config 域的逻辑服务
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.7（ChannelConfigService）
 *       specs/tech/config/connector-config-service.ts（同款套路）
 *
 * 设计：
 *   - 落盘 {root}/channel_config/<id>.json（扁平布局，FsCrudStore upsert）
 *   - 多 config：一个 implId（feishu）可有多份 config（每份独立 credentials/connect/binding）
 *   - appSecret GET 明文返回（secret mask 收敛到前端展示层）；mergeChannelSecret 在 handler 层（channel-redact.ts）
 */
import type { SchemaDef, InferRecord } from '../persistence/schema-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { ulid } from '../config/ulid';
import type { ChannelConfig } from './types';

/** channel_config entity SchemaDef（扁平布局，id=ULID） */
export const ChannelConfigSchema = {
  entity: 'channel_config',
  engine: 'file',
  fields: {
    id: { type: 'string', required: true },
    implId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    enabled: { type: 'boolean', required: true },
    config: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

export type ChannelConfigRecord = InferRecord<typeof ChannelConfigSchema>;

/** ChannelConfigService 构造参数 */
export interface ChannelConfigServiceOptions {
  /** 数据根目录 */
  root: string;
}

/**
 * channel_config 域逻辑服务（仿 ConnectorConfigService，但多 config 列表形态）。
 *
 * 用法（ChannelManager 持有）：
 *   const svc = new ChannelConfigService({ root: DATA_DIR });
 *   svc.create({ implId: 'feishu', name: '公司 IM', config: { appId, appSecret } });
 *   svc.list();  // 含已 redact 的 appSecret
 */
export class ChannelConfigService {
  private readonly store: CompositeStore;

  constructor(opts: ChannelConfigServiceOptions) {
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount(ChannelConfigSchema.entity, fs);
  }

  /** 全部 config（appSecret 明文，secret mask 收敛到前端展示层） */
  list(): ChannelConfig[] {
    return this.store.query(ChannelConfigSchema, {}) as unknown as ChannelConfig[];
  }

  /** 单个 config（appSecret 明文）；不存在返 undefined */
  get(id: string): ChannelConfig | undefined {
    const rec = this.store.get(ChannelConfigSchema, id);
    return rec ? (rec as unknown as ChannelConfig) : undefined;
  }

  /** 取原始（未 redact）config；ChannelManager.connect 读凭证用 */
  getRaw(id: string): ChannelConfig | undefined {
    const rec = this.store.get(ChannelConfigSchema, id);
    return rec ? (rec as unknown as ChannelConfig) : undefined;
  }

  /** 新建 config（ulid + enabled 默认 true） */
  create(input: {
    implId: string;
    name: string;
    config: Record<string, unknown>;
    enabled?: boolean;
  }): ChannelConfig {
    const config: ChannelConfig = {
      id: ulid(),
      implId: input.implId,
      name: input.name,
      enabled: input.enabled ?? true,
      config: { ...input.config },
    };
    this.store.put(ChannelConfigSchema, config as unknown as ChannelConfigRecord);
    return config;
  }

  /** 部分更新（merge 到 existing；config 字段是整体替换） */
  update(id: string, patch: Partial<Omit<ChannelConfig, 'id'>>): ChannelConfig | undefined {
    const existing = this.store.get(ChannelConfigSchema, id);
    if (!existing) return undefined;
    const cur = existing as unknown as ChannelConfig;
    const next: ChannelConfig = {
      id: cur.id,
      implId: patch.implId ?? cur.implId,
      name: patch.name ?? cur.name,
      enabled: patch.enabled ?? cur.enabled,
      config: patch.config ?? cur.config,
      // createdAt/updatedAt/version 是 store 信封字段（RESERVED），不能在 put 时携带，由 store 自动注入
    };
    this.store.put(ChannelConfigSchema, next as unknown as ChannelConfigRecord);
    return next;
  }

  /** setEnabled：toggle switch intent（专用方法，避免误改其他字段） */
  setEnabled(id: string, enabled: boolean): void {
    this.update(id, { enabled });
  }

  /** 删除 */
  delete(id: string): boolean {
    return this.store.delete(ChannelConfigSchema, id);
  }
}
