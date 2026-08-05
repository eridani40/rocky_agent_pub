/**
 * KvConfigService — app_config 通用 KV 逻辑服务基类
 * 参考: specs/tech/config/[P0]app_config.md §5（AppConfigService）
 *
 * 设计：
 *   - service **只裸 KV 读写，不聚合、不做默认回退**
 *   - 多级配置 overlay 聚合在消费方（LlmClient），service 不域特化
 *
 * 底经 persistence（CompositeStore mount entity→FsCrudStore）。
 * 稀疏 delta 语义：记录缺失即未配置，get 返 undefined。
 *
 * 子类只需通过 constructor 传入对应 SchemaDef（entity 不同），其余 get/set 逻辑完全复用。
 */
import type { SchemaDef } from '../persistence/schema-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { ulid } from './ulid';

/** KvConfigService 构造参数 */
export interface KvConfigServiceOptions {
  /** 数据根目录（FsCrudStore root，所有 entity 路径从此起拼接） */
  root: string;
}

/**
 * 通用 KV config 服务基类。
 *
 * 持有 schema + CompositeStore，get/set 按 (group, key) 寻址。
 * group 既是分片键（schema.fs.sharding.shardKeyField='group'）也是逻辑分类。
 */
export abstract class KvConfigService {
  /** 该 service 绑定的 entity schema */
  protected readonly schema: SchemaDef;
  /** 按 entity 路由的 CompositeStore（mount 该 entity → FsCrudStore） */
  protected readonly store: CompositeStore;

  constructor(schema: SchemaDef, opts: KvConfigServiceOptions) {
    this.schema = schema;
    // 一个 FsCrudStore 实例承载该 entity 的所有 shard 目录
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount(schema.entity, fs);
  }

  /**
   * 裸 KV 读：取某 (group, key) 的 data；记录不存在返回 undefined。
   *
   * 实现：query 该 group 的 shard（shardKey=group），按 record.key===key 过滤命中首条。
   * @param group 分片键 + 逻辑分类
   * @param key 组内逻辑 key
   * @returns 命中返 data；缺失返 undefined（视为未配置，service 不回退默认）
   */
  get(group: string, key: string): unknown | undefined {
    const hit = this.findRecord(group, key);
    return hit ? (hit as unknown as { data: unknown }).data : undefined;
  }

  /**
   * 私有：按 (group, key) 查单条 record（get/set/delete 共用）。
   * StoredRecord<SchemaDef> 是宽泛类型，经 unknown 中转访问具体业务字段（key/data/id）。
   */
  private findRecord(group: string, key: string): unknown | undefined {
    const rows = this.store.query(this.schema, { shardKey: group });
    return rows.find((r) => (r as unknown as { key: string }).key === key);
  }

  /**
   * 列某 group 下所有 record（key + data），供 GET /config/{app,dev}?group=<g> 整组取用。
   * @returns [{ key, data }, ...]；group 无 record 返空数组
   */
  listGroup(group: string): { key: string; data: unknown }[] {
    const rows = this.store.query(this.schema, { shardKey: group });
    return rows.map((r) => {
      const rec = r as unknown as { key: string; data: unknown };
      return { key: rec.key, data: rec.data };
    });
  }

  /**
   * 裸 KV 写：创建/更新 (group, key) 的 data。
   *
   * 实现：先 query 该 group shard 找现有 record（key 命中），命中则复用其 id 走 update，
   * 否则生成新 ULID 作 id 走 insert。upsert 语义（key 同 group 已存在则更新否则 insert）。
   * @param group 分片键 + 逻辑分类
   * @param key 组内逻辑 key
   * @param data 值（恒为 json，简单值或嵌套树）
   */
  set(group: string, key: string, data: unknown): void {
    const existing = this.findRecord(group, key);
    const id = existing
      ? (existing as unknown as { id: string }).id
      : ulid();
    this.store.put(this.schema, { id, group, key, data } as never);
  }

  /**
   * 裸 KV 删：删除 (group, key) 的 record。
   *
   * 实现：query 该 group shard 找命中 record（key 匹配），有则按其 id 走 CompositeStore.delete
   * 物理移除落盘文件；不存在返 false（idempotent，不抛错）。
   *
   * 用途：sub_agent_templates group 的模板删除（spec api 10-multi-agent §5.3）。
   * 仅 sub_agent_templates group 允许删（其他 group 拒绝，由调用方/handler 门控）。
   *
   * @param group 分片键 + 逻辑分类
   * @param key 组内逻辑 key
   * @returns true=已删除；false=record 不存在（idempotent）
   */
  delete(group: string, key: string): boolean {
    const existing = this.findRecord(group, key);
    if (!existing) return false;
    const id = (existing as unknown as { id: string }).id;
    return this.store.delete(this.schema, id, group);
  }

  /**
   * 整组原子提交：一次性写入该 group 的多个 (key, data)。
   *
   * 语义（specs/tech/version_logs/v0.0.5/change_log.md §修订3）：
   *   - 原子性：同 group 全成功/全失败。底层 CrudStore 单 entity 单 shard 目录，
   *     本实现一次性 query 当前 group shard（读现有 record → 复用 id 走 update，
   *     新 key 生成 ULID 走 insert），按顺序 put。任一 put 抛错时整体失败（抛出），
   *     已 put 成功的 record 不可回滚（FsCrudStore 无事务，按 spec 接受「半完成」
   *     语义但实现尽量减小出错窗口：items 数组在写前完成 query + id 分配）。
   *   - 仅该 group shard record 读/写：query 用 `{ shardKey: group }`，put 全用同 group，
   *     不会触碰其他 group shard 目录。
   *   - 空 items：no-op，直接返回（不抛错）。
   *
   * @param group 分片键 + 逻辑分类
   * @param items 该 group 全部 (key, data)（upsert：key 已存在则覆盖，否则新增）
   */
  setGroup(group: string, items: { key: string; data: unknown }[]): void {
    // 空 items no-op（items 空数组 → 200 no-op）
    if (items.length === 0) return;
    // 一次性读当前 group shard 的现有 record（仅该 group），用于按 key 复用 id（upsert）
    const rows = this.store.query(this.schema, { shardKey: group });
    for (const item of items) {
      const existing = rows.find(
        (r) => (r as unknown as { key: string }).key === item.key,
      );
      const id = existing
        ? (existing as unknown as { id: string }).id
        : ulid();
      // 全部 put 用同一 group，落到同一 shard 目录；其他 group shard 不读不写
      this.store.put(
        this.schema,
        { id, group, key: item.key, data: item.data } as never,
      );
    }
  }
}
