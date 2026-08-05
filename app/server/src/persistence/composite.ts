/**
 * CompositeStore — 按 entity 寻址到已挂载 engine 实例的路由层
 * 参考: specs/tech/persistence/[P0]crud_store_interface.md §3.4 + §4（示例）
 *       states/v0.0.2/task.json keyDecisions.engineRouting
 *
 * 设计（crud §3.4）：
 *   - 一个应用可同时挂多个 engine 实例并存（fs / sqlite / ...）。
 *   - CompositeStore implements CrudStore，把 put/get/query/delete 按 schema.entity
 *     转发给 mount(entity, engine) 注册过的 engine 实例。
 *   - 挂载关系由 schema.engine 决定（entity 用哪个 engine）；调用方 mount 时声明，
 *     CompositeStore 路由时只看 schema.entity（不关心 engine 字段）。
 *   - 未挂载 entity → EntityNotMountedError（task.json T5 §1）。
 *
 * CompositeStore 自身不存数据，只是路由表；具体落盘归底层 engine。
 */
import type {
  CrudStore,
  PutOptions,
  QueryFilter,
  StoredRecord,
} from './crud-types';
import type { SchemaDef, InferRecord } from './schema-types';
import { EntityNotMountedError } from './errors';

/**
 * engine 可能实现的 async 扩展（spec §4.3）。
 * FsCrudStore 有 putAsync/deleteAsync；SqliteCrudStore 无 → CompositeStore 退化为 Promise.resolve(sync)。
 * 不在 CrudStore interface 上加，避免污染所有 engine。
 */
type MaybeAsyncEngine = CrudStore & {
  putAsync?<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): Promise<StoredRecord<S>>;
  deleteAsync?<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): Promise<boolean>;
};

/**
 * 按 entity 路由的 CompositeStore。
 *
 * 用法：
 *   const { store: sqliteCrud } = await createCrudSqlDriver('./data/crud.sqlite');
 *   const store = new CompositeStore()
 *     .mount('transcript', new FsCrudStore({ root: './data' }))
 *     .mount('app_config', sqliteCrud);
 *   store.put(MessageSchema, msg);      // → FsCrudStore（业务 transcript schema，agent/schema_defs/message.ts）
 *   store.put(AppConfigSchema, cfg);    // → SqliteCrudStore
 */
export class CompositeStore implements CrudStore {
  /** entity 名 → engine 实例 的路由表 */
  private readonly mounts = new Map<string, CrudStore>();

  /**
   * 挂载 entity 到 engine 实例（返回 this 支持链式调用）。
   * 同一 entity 重复 mount 以最后一次为准（覆盖）。
   * @param entity entity 名（必须与 schema.entity 一致才能路由到该 engine）
   * @param engine 该 entity 使用的 engine 实例
   */
  mount(entity: string, engine: CrudStore): this {
    this.mounts.set(entity, engine);
    return this;
  }

  /** 按 schema.entity 取已挂载 engine；未挂载抛 EntityNotMountedError */
  private route(schema: SchemaDef): CrudStore {
    const engine = this.mounts.get(schema.entity);
    if (!engine) {
      throw new EntityNotMountedError(schema.entity);
    }
    return engine;
  }

  put<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): StoredRecord<S> {
    return this.route(schema).put(schema, record, opts);
  }

  get<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): StoredRecord<S> | undefined {
    return this.route(schema).get(schema, id, shardKey);
  }

  delete<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): boolean {
    return this.route(schema).delete(schema, id, shardKey);
  }

  /**
   * async put forwarder（spec §4.3）：engine 有 putAsync（FsCrudStore）→ 委托；
   * 否则（SqliteCrudStore）→ 退化为 Promise.resolve(sync put)。
   * 让 caller 继续用 CompositeStore surface，不必直持 FsCrudStore 引用。
   */
  async putAsync<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): Promise<StoredRecord<S>> {
    const engine = this.route(schema) as MaybeAsyncEngine;
    return typeof engine.putAsync === 'function'
      ? engine.putAsync(schema, record, opts)
      : Promise.resolve(engine.put(schema, record, opts));
  }

  /** async delete forwarder（spec §4.3）：同 putAsync，engine 无则退化为 Promise.resolve(sync delete) */
  async deleteAsync<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): Promise<boolean> {
    const engine = this.route(schema) as MaybeAsyncEngine;
    return typeof engine.deleteAsync === 'function'
      ? engine.deleteAsync(schema, id, shardKey)
      : Promise.resolve(engine.delete(schema, id, shardKey));
  }

  query<S extends SchemaDef>(schema: S, filter: QueryFilter): StoredRecord<S>[] {
    return this.route(schema).query(schema, filter);
  }
}
