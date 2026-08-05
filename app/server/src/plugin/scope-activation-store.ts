/**
 * ScopeActivationStore — per-(scope,EP) 激活记录落盘存储（v0.0.26 F3 D1）
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §3（ScopeActivationSchema + D1 独立 entity）
 *       specs/tech/persistence/[P0]crud_store_interface.md §3（CrudStore 契约）
 *       app/server/src/plugin/plugin-policy-store.ts（CrudStore 封装范式）
 *
 * 设计：
 *   - 独立 entity ext_impl_scope_activation，按 scopeId 分片（cascade 删 scope 时整 shard 清）
 *   - 逻辑 key = (scopeId, pointId)：同 scope 内 pointId 唯一
 *   - set/delete 幂等（已存在返 ok 不重复写；不存在返 ok）
 *
 * plugin scope D6（v0.0.206 已删）历史约定（default scope 不写 activation record）：
 *   - v0.0.206 起 default 激活态同由 default.yaml 声明（default 无特权，无运行时短路）
 *   - 本 store 为 deprecated 读路径保留件（运行时不读），仍不主动为 default 写 activation
 *   - 但本 store **不强制拒绝** default 的 set（service 层是语义门；store 层保持纯存储语义，
 *     便于测试 + 避免双重校验）。若 default scope 有 activation record（理论不应有），
 *     get/has/listByScope 仍正常返回。
 */
import type { SchemaDef } from '../persistence/schema-types';
import type { StoredRecord } from '../persistence/crud-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { shardRootDir } from '../persistence/fs-paths';
import * as fs from 'node:fs';
import { ulid } from '../config/ulid';
import { ScopeActivationSchema } from './schema_defs/scope_activation';

/** ScopeActivationStore 构造参数 */
export interface ScopeActivationStoreOptions {
  /** 数据根目录（FsCrudStore root） */
  root: string;
}

/**
 * per-(scope,EP) 激活记录落盘存储。封装 CrudStore put/get/query/delete，对外暴露
 * 激活记录读写 API（逻辑 key = (scopeId, pointId)）。
 */
export class ScopeActivationStore {
  private readonly store: CompositeStore;
  private readonly root: string;
  private readonly schema: SchemaDef = ScopeActivationSchema;

  constructor(opts: ScopeActivationStoreOptions) {
    this.root = opts.root;
    const fsEngine = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount(this.schema.entity, fsEngine);
  }

  /**
   * 查 (scopeId, pointId) 激活记录（缺返 undefined）。
   * 同 scope 内按 pointId 单查（shardKey=scopeId 路由）。
   */
  get(scopeId: string, pointId: string): string | undefined {
    const rows = this.store.query(this.schema, { shardKey: scopeId });
    const hit = rows.find((r) => castPointId(r) === pointId);
    return hit ? castActivatedAt(hit) : undefined;
  }

  /** 是否激活（get 非 undefined） */
  has(scopeId: string, pointId: string): boolean {
    return this.get(scopeId, pointId) !== undefined;
  }

  /**
   * 列某 scope 已激活的 EP pointId 列表（shardKey=scopeId 路由后取 pointId 字段）。
   * 供 inventory + listActivatedPoints。
   */
  listByScope(scopeId: string): string[] {
    const rows = this.store.query(this.schema, { shardKey: scopeId });
    return rows.map((r) => castPointId(r));
  }

  /**
   * 写 (scopeId, pointId) 激活记录（幂等：已存在返 ok 不重复写）。
   * @param scopeId scope 业务 id
   * @param pointId 激活的 EP id
   * @param activatedAt 激活时间（ISO8601），缺省 new Date().toISOString()
   * @returns activated: true 表示新写入；false 表示已存在（幂等跳过）
   */
  set(
    scopeId: string,
    pointId: string,
    activatedAt: string = new Date().toISOString(),
  ): { activated: boolean } {
    // 幂等：已存在跳过（spec §3.2 set 已存在返 ok 不重复写）
    const rows = this.store.query(this.schema, { shardKey: scopeId });
    const existing = rows.find((r) => castPointId(r) === pointId);
    if (existing) return { activated: false };

    const id = ulid();
    this.store.put(this.schema, {
      id,
      scopeId,
      pointId,
      activatedAt,
    } as never);
    return { activated: true };
  }

  /**
   * 删 (scopeId, pointId) 激活记录（幂等：不存在返 ok）。
   * @returns deleted: true 表示实际删除；false 表示本就不存在
   */
  delete(scopeId: string, pointId: string): { deleted: boolean } {
    const rows = this.store.query(this.schema, { shardKey: scopeId });
    const existing = rows.find((r) => castPointId(r) === pointId);
    if (!existing) return { deleted: false };
    this.store.delete(this.schema, castId(existing), scopeId);
    return { deleted: true };
  }

  /**
   * 删某 scope 全部激活记录（整 shard 目录清，供 cascade 删 scope 用）。
   * CrudStore 接口无「删整 shard」API，直接 rmSync 整 shard 目录（落盘 json 文件树）。
   * 幂等：目录不存在返 ok。
   */
  deleteAllByScope(scopeId: string): void {
    const shardDir = shardRootDir(this.root, this.schema, scopeId);
    fs.rmSync(shardDir, { recursive: true, force: true });
  }
}

// ── 类型收窄助手（StoredRecord 宽泛，经 unknown 中转取业务字段）──

function castId(r: StoredRecord<SchemaDef>): string {
  return (r as unknown as { id: string }).id;
}
function castPointId(r: StoredRecord<SchemaDef>): string {
  return (r as unknown as { pointId: string }).pointId;
}
function castActivatedAt(r: StoredRecord<SchemaDef>): string {
  return (r as unknown as { activatedAt: string }).activatedAt;
}
