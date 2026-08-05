/**
 * PluginPolicyStore — plugin policy 落盘存储（CrudStore engine:'file' 封装）
 * 参考: specs/tech/config/[P0]plugin_config_service.md §4.4（落盘）
 *       specs/tech/config/[P0]plugin_config.md（数据形状）
 *       specs/tech/config/[P0]ext_impl_scope.md §4（F2 复合 key + D2 编码 + D3 lazy migrate）
 *
 * 设计：
 *   - 复用 T1 config 模式（CompositeStore + FsCrudStore + ULID），不重造
 *   - 单 entity plugin_policy，kind 字段分片（plugin / impl 两个 shard 目录）
 *   - 稀疏 delta 语义：未写入 → get 返 undefined（视为未配置，按代码默认 enabled=true）
 *   - 「恢复默认 = 删 record」（plugin_config_service §3）
 *
 * 数据形状：
 *   - plugin 级（kind='plugin', key=pluginId, data={enabled?, configValues?}）— 不分 scope
 *   - ext impl 级（kind='impl', key=${scopeId}::${implId}（D2 复合 key），
 *     data={enabled?, order?, configValues?}）
 *
 * [v0.0.55] 删 `exclusive?: boolean` 字段——三种 cardinality 共用 enabled+order 数据模型。
 *
 * [v0.0.26] impl 级 key 由单 implId 改为复合 `${scopeId}::${implId}`：
 *   - 复合 key 编码进 plugin_policy.key 字段（D2，schema 字段不变，persistence 层零改动）
 *   - `::` 分隔符无歧义（scopeId/implId 皆 snake_case，不含 `::`），split('::') 解码安全
 *   - 分片键仍用 kind（不引入 scopeId 分片，spec §4.2 理由 2：避免 default shard 巨大）
 */
import type { SchemaDef } from '../persistence/schema-types';
import type { StoredRecord } from '../persistence/crud-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { ulid } from '../config/ulid';
import { PluginPolicySchema } from './schema_defs/plugin_policy';

/** plugin 级 policy data 形状（稀疏：字段全可缺，缺即未配置） */
export interface PluginPolicyData {
  enabled?: boolean;
  configValues?: Record<string, unknown>;
}

/**
 * ext impl 级 policy data 形状（稀疏；order 仅 ordered 点用）。
 * [v0.0.55] 删 `exclusive?: boolean`——三种 cardinality 共用 enabled+order 数据模型：
 *   - exclusive：active = enabled 者；多个取 effective order 最小者（plugin-manager exclusivePick）
 *   - setExclusive 改 enabled 互斥（目标 enabled=true + 同 point 其他 enabled=false）
 */
export interface ExtImplPolicyData {
  enabled?: boolean;
  order?: number;
  configValues?: Record<string, unknown>;
}

/** PluginPolicyStore 构造参数 */
export interface PluginPolicyStoreOptions {
  /** 数据根目录（FsCrudStore root） */
  root: string;
}

/** list 返回的记录形态（含 key + data）；impl 级 key 是复合 `${scopeId}::${implId}` */
export interface PluginPolicyListEntry<TData> {
  key: string;
  data: TData;
}

/** [v0.0.26] impl 级 list 返回形态（解码出 scopeId + implId，便于 cascade/inventory） */
export interface ExtImplPolicyListEntry extends PluginPolicyListEntry<ExtImplPolicyData> {
  scopeId: string;
  implId: string;
}

/** 复合 key 分隔符（spec §4.2 D2：`::` 无歧义，scopeId/implId 皆 snake_case 不含 `::`） */
const KEY_SEP = '::';

/**
 * 编码复合 key 为 `${scopeId}::${implId}`。
 * 无歧义保证：scopeId/implId 皆 snake_case（[a-z0-9_]），不含 `::`，split('::') 安全。
 */
function encodeImplKey(scopeId: string, implId: string): string {
  return `${scopeId}${KEY_SEP}${implId}`;
}

/**
 * 解码复合 key `${scopeId}::${implId}` 为 [scopeId, implId]。
 * 不含 `::` 视为旧格式（单 implId），返回 undefined（仅 migrate 处理旧 key）。
 */
function decodeImplKey(key: string): { scopeId: string; implId: string } | undefined {
  const idx = key.indexOf(KEY_SEP);
  if (idx < 0) return undefined; // 旧格式单 implId
  return { scopeId: key.slice(0, idx), implId: key.slice(idx + KEY_SEP.length) };
}

/**
 * 解析重载签名为复合 key。
 *   单参 (implId)            → 'default::implId'（向后兼容 T3/T4 现有调用）
 *   双参 (scopeId, implId)   → 'scopeId::implId'（per-scope）
 * getImpl/deleteImpl 共用（两者重载形状一致）。
 */
function resolveImplKey(scopeIdOrImplId: string, implId?: string): string {
  return implId === undefined
    ? encodeImplKey('default', scopeIdOrImplId)
    : encodeImplKey(scopeIdOrImplId, implId);
}

/**
 * plugin policy 落盘存储。封装 CrudStore put/get/query/delete，对外暴露
 * 两级（plugin / impl）稀疏 delta 读写 API。
 *
 * plugin 级 API 不分 scope（PRD OUT：plugin.enabled 全局开关）。
 * impl 级 API [v0.0.26] 加 scopeId 维度：单参重载 ≡ default（向后兼容 T3/T4 现有调用零改动），
 * 双参重载按 (scopeId, implId) 复合 key 读写。
 */
export class PluginPolicyStore {
  private readonly store: CompositeStore;
  private readonly schema: SchemaDef = PluginPolicySchema;

  constructor(opts: PluginPolicyStoreOptions) {
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount(this.schema.entity, fs);
  }

  // ── plugin 级（不分 scope，PRD OUT：plugin.enabled 全局）──

  /** 取 plugin 级 record（缺返 undefined） */
  getPlugin(pluginId: string): PluginPolicyData | undefined {
    return this.getOne('plugin', pluginId) as PluginPolicyData | undefined;
  }

  /** 写 plugin 级 record（upsert） */
  setPlugin(pluginId: string, data: PluginPolicyData): void {
    this.setOne('plugin', pluginId, data);
  }

  /** 删 plugin 级 record（恢复默认） */
  deletePlugin(pluginId: string): void {
    this.deleteOne('plugin', pluginId);
  }

  /** list 所有 plugin 级 record（供 persist 聚合用） */
  listPlugins(): PluginPolicyListEntry<PluginPolicyData>[] {
    return this.listKind<PluginPolicyData>('plugin');
  }

  // ── ext impl 级（[v0.0.26] 复合 key + scopeId 维度，spec §4.2）──

  /**
   * 取某 impl 的 policy。
   * 单参重载 ≡ default scope（向后兼容，T3/T4 现有调用零改动）。
   * 双参重载按 (scopeId, implId) 复合 key 读写。
   * 缺返 undefined（视为未配置，按代码默认）。
   */
  getImpl(implId: string): ExtImplPolicyData | undefined;
  getImpl(scopeId: string, implId: string): ExtImplPolicyData | undefined;
  getImpl(scopeIdOrImplId: string, implId?: string): ExtImplPolicyData | undefined {
    return this.getOne('impl', resolveImplKey(scopeIdOrImplId, implId)) as
      | ExtImplPolicyData
      | undefined;
  }

  /**
   * 写某 impl 的 policy（upsert）。
   * 单参重载 ≡ default scope（向后兼容）；双参重载按 (scopeId, implId) 复合 key。
   */
  setImpl(implId: string, data: ExtImplPolicyData): void;
  setImpl(scopeId: string, implId: string, data: ExtImplPolicyData): void;
  setImpl(
    scopeIdOrImplId: string,
    implIdOrData: string | ExtImplPolicyData,
    data?: ExtImplPolicyData,
  ): void {
    if (data === undefined) {
      // 单参重载：setImpl(implId, data) ≡ default
      this.setOne('impl', encodeImplKey('default', scopeIdOrImplId), implIdOrData);
    } else {
      // 双参重载：setImpl(scopeId, implId, data)
      this.setOne('impl', encodeImplKey(scopeIdOrImplId, implIdOrData as string), data);
    }
  }

  /**
   * 删某 impl 的 policy（恢复默认）。
   * 单参重载 ≡ default scope（向后兼容）；双参重载按 (scopeId, implId) 复合 key。
   */
  deleteImpl(implId: string): void;
  deleteImpl(scopeId: string, implId: string): void;
  deleteImpl(scopeIdOrImplId: string, implId?: string): void {
    this.deleteOne('impl', resolveImplKey(scopeIdOrImplId, implId));
  }

  /**
   * list impl 级 record。
   * 无参重载：列全 scope 全 impl（兼容旧调用，供 persist 聚合）。
   * 带 scopeId：只列该 scope 下所有 impl policy（前缀过滤 `${scopeId}::`，供 inventory + cascade）。
   */
  listImpls(): PluginPolicyListEntry<ExtImplPolicyData>[];
  listImpls(scopeId: string): ExtImplPolicyListEntry[];
  listImpls(scopeId?: string): PluginPolicyListEntry<ExtImplPolicyData>[] | ExtImplPolicyListEntry[] {
    const rows = this.listKind<ExtImplPolicyData>('impl');
    if (scopeId === undefined) {
      // 无参：全量（兼容旧调用）
      return rows;
    }
    // 带 scopeId：前缀过滤 + 解码出 scopeId/implId
    const prefix = `${scopeId}${KEY_SEP}`;
    return rows
      .filter((r) => r.key.startsWith(prefix))
      .map((r) => {
        const dec = decodeImplKey(r.key)!; // 前缀匹配保证可解码
        return { key: r.key, data: r.data, scopeId: dec.scopeId, implId: dec.implId };
      });
  }

  /**
   * [v0.0.26] 列某 scope 下某 point 的所有 impl policy（供 activateEp snapshot 复制 default + deactivate 清理）。
   * 在 listImpls(scopeId) 基础上按 pointImplIds 集合过滤。
   */
  listImplsByPoint(
    scopeId: string,
    _pointId: string,
    pointImplIds: string[],
  ): ExtImplPolicyListEntry[] {
    // pointId 是 EP 逻辑身份（contract 常量），不进存储 key；仅按 implIds 集合过滤该 scope 的 record。
    const idSet = new Set(pointImplIds);
    return this.listImpls(scopeId).filter((e) => idSet.has(e.implId));
  }

  // ── 内部：单条读写（kind 分片路由）──

  private getOne(kind: string, key: string): unknown | undefined {
    const rows = this.store.query(this.schema, { shardKey: kind });
    const hit = rows.find((r) => castKey(r) === key);
    return hit ? castData(hit) : undefined;
  }

  private setOne(kind: string, key: string, data: unknown): void {
    const rows = this.store.query(this.schema, { shardKey: kind });
    const existing = rows.find((r) => castKey(r) === key);
    const id = existing ? castId(existing) : ulid();
    this.store.put(this.schema, { id, kind, key, data } as never);
  }

  private deleteOne(kind: string, key: string): void {
    const rows = this.store.query(this.schema, { shardKey: kind });
    const existing = rows.find((r) => castKey(r) === key);
    if (existing) this.store.delete(this.schema, castId(existing), kind);
  }

  private listKind<TData>(kind: string): PluginPolicyListEntry<TData>[] {
    return this.store
      .query(this.schema, { shardKey: kind })
      .map((r) => ({ key: castKey(r), data: castData(r) as TData }));
  }
}

// ── 类型收窄助手（StoredRecord 宽泛，经 unknown 中转取业务字段）──

function castKey(r: StoredRecord<SchemaDef>): string {
  return (r as unknown as { key: string }).key;
}
function castId(r: StoredRecord<SchemaDef>): string {
  return (r as unknown as { id: string }).id;
}
function castData(r: StoredRecord<SchemaDef>): unknown {
  return (r as unknown as { data: unknown }).data;
}
