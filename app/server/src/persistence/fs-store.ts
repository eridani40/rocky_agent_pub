/**
 * FsCrudStore — CrudStore 契约的文件系统 engine（spec §2-§5）
 * 参考: specs/tech/persistence/[P0]fs_crud_store_engine.md §2-§5
 * 编排：路径 fs-paths / IO fs-io / jsonl fs-jsonl / 信封 envelope / 校验 schema-validation
 * put 主线：validateRecord → 读 existing → computeEnvelope → json/jsonl 落盘 → 返回 data+信封
 */
import type { CrudStore, PutOptions, QueryFilter, StoredRecord, RecordMeta } from './crud-types';
import type { SchemaDef, InferRecord } from './schema-types';
import { validateRecord } from './schema-validation';
import { computeEnvelope } from './envelope';
import {
  entityDir,
  resolveRecordPath,
  jsonlSegmentFile,
  shardRootPrefix,
} from './fs-paths';
import {
  atomicWriteSync,
  readJsonFileSync,
  removeFileSync,
  readDirSafeSync,
  listSegmentIdsSync,
  readDirWithTypeSync,
} from './fs-io';
import { jsonlPut, jsonlGet, jsonlDelete, jsonlQuerySegments } from './fs-jsonl';
import { withFileLock } from './file-lock';
import { acquireFsSlot, trackFsTime } from './fs-yield';
import { queryWithSlowLog } from './slow-query';

/** FsCrudStore 构造参数 */
export interface FsCrudStoreOptions {
  root: string;
  now?: () => string;   // 时间源（信封 ISO 时间；缺省 new Date().toISOString()）
  nowMs?: () => number; // 毫秒时钟（query 慢查询计时；缺省 Date.now）
}

/** 默认时间源 */
const defaultNow = () => new Date().toISOString();

/**
 * 文件系统实现的 CrudStore（spec §1）。同步语义（与 bun:sqlite 对齐）；多进程并发写不保证（spec §5）。
 */
export class FsCrudStore implements CrudStore {
  private readonly root: string;
  private readonly now: () => string;
  /** 毫秒时钟（query 慢查询计时；缺省 Date.now） */
  private readonly nowMs: () => number;

  constructor(opts: FsCrudStoreOptions) {
    this.root = opts.root;
    this.now = opts.now ?? defaultNow;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  /** 是否 jsonl 段文件格式 */
  private isJsonl(schema: SchemaDef): boolean {
    return schema.fs?.format === 'jsonl';
  }

  /** 是否分片 */
  private isSharded(schema: SchemaDef): boolean {
    return schema.fs?.sharding !== undefined;
  }

  /** 从 record 提取 shardKey（分片 schema 用） */
  private extractShardKey(schema: SchemaDef, record: Record<string, unknown>): string {
    const field = schema.fs!.sharding!.shardKeyField;
    const v = record[field];
    if (v === undefined || v === null || typeof v !== 'string') {
      throw new Error(`分片 schema ${schema.entity} 的 shardKeyField "${field}" 缺失或非字符串`);
    }
    return v;
  }

  /** 读取已落盘记录的信封（无则 undefined）— 适配 json/jsonl + 分片 */
  private readExistingMeta(
    schema: SchemaDef,
    id: string,
    shardKey: string | undefined,
  ): RecordMeta | undefined {
    if (this.isJsonl(schema)) {
      const seg = jsonlGet(this.entitySegmentDir(schema, shardKey), id);
      return seg ? pickMeta(seg as Record<string, unknown>) : undefined;
    }
    const file = resolveRecordPath(this.root, schema, id, { shardKey });
    const rec = readJsonFileSync<Record<string, unknown>>(file);
    return rec ? pickMeta(rec) : undefined;
  }

  /** 分片 jsonl 的段目录 = entityDir（含 dirTemplate） */
  private entitySegmentDir(schema: SchemaDef, shardKey: string | undefined): string {
    return entityDir(this.root, schema, shardKey);
  }

  put<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): StoredRecord<S> {
    // 1. 校验（T1）
    validateRecord(schema, record as Record<string, unknown>);

    const id = (record as unknown as { id: string }).id;
    const shardKey = this.isSharded(schema) ? this.extractShardKey(schema, record) : undefined;
    // 分片必须能取出 shardKey（已由 extractShardKey 保证）

    // 2. 读 existing 信封
    const existing = this.readExistingMeta(schema, id, shardKey);

    // 3. 计算新信封（T2 复用，可能抛 RecordExists/NotFound/VersionConflict）
    const meta = computeEnvelope({ existing, opts, now: this.now(), id });

    // 4. data + 信封合并落盘
    const stored = { ...record, ...meta } as StoredRecord<S>;
    this.writeRecord(schema, id, shardKey, stored);
    return stored;
  }

  /** 落盘单条记录（json / jsonl 分发） */
  private writeRecord<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey: string | undefined,
    stored: StoredRecord<S>,
  ): void {
    if (this.isJsonl(schema)) {
      const dir = this.entitySegmentDir(schema, shardKey);
      jsonlPut(dir, id, stored, schema.fs?.jsonlMaxCount ?? 1000);
      return;
    }
    const file = resolveRecordPath(this.root, schema, id, { shardKey });
    atomicWriteSync(file, JSON.stringify(stored, null, 2));
  }

  get<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): StoredRecord<S> | undefined {
    this.assertShardKeyIfSharded(schema, shardKey, 'get');
    if (this.isJsonl(schema)) {
      const seg = jsonlGet(this.entitySegmentDir(schema, shardKey), id);
      return seg as StoredRecord<S> | undefined;
    }
    const file = resolveRecordPath(this.root, schema, id, { shardKey });
    return readJsonFileSync<StoredRecord<S>>(file);
  }

  delete<S extends SchemaDef>(schema: S, id: string, shardKey?: string): boolean {
    this.assertShardKeyIfSharded(schema, shardKey, 'delete');
    if (this.isJsonl(schema)) {
      return jsonlDelete(this.entitySegmentDir(schema, shardKey), id);
    }
    const file = resolveRecordPath(this.root, schema, id, { shardKey });
    return removeFileSync(file);
  }

  /** async put — sync put 外包 withFileLock；同 lockPath FIFO 串行无丢更新。engine 专有扩展，不在 CrudStore interface 上（spec §4.1/§4.2） */
  async putAsync<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): Promise<StoredRecord<S>> {
    const id = (record as unknown as { id: string }).id;
    const shardKey = this.isSharded(schema) ? this.extractShardKey(schema, record) : undefined;
    return withFileLock(this.targetWritePath(schema, id, shardKey), async () => {
      await acquireFsSlot();
      const t0 = process.hrtime.bigint();
      const result = this.put(schema, record, opts);
      trackFsTime(process.hrtime.bigint() - t0);
      return result;
    });
  }

  /** async delete — sync delete 外包 withFileLock；同 lockPath 串行，第二个返 false（spec §4.1） */
  async deleteAsync<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey?: string,
  ): Promise<boolean> {
    this.assertShardKeyIfSharded(schema, shardKey, 'deleteAsync');
    return withFileLock(this.targetWritePath(schema, id, shardKey), async () => {
      await acquireFsSlot();
      const t0 = process.hrtime.bigint();
      const result = this.delete(schema, id, shardKey);
      trackFsTime(process.hrtime.bigint() - t0);
      return result;
    });
  }

  /** 写锁路径（§4.2）：jsonl→entity 段目录（roll 改段名仍同段目录防漏锁）、json→record 文件 */
  private targetWritePath<S extends SchemaDef>(
    schema: S,
    id: string,
    shardKey: string | undefined,
  ): string {
    if (this.isJsonl(schema)) return this.entitySegmentDir(schema, shardKey);
    return resolveRecordPath(this.root, schema, id, { shardKey });
  }

  query<S extends SchemaDef>(schema: S, filter: QueryFilter): StoredRecord<S>[] {
    // 慢查询性能日志埋点（sink 未注册/开关 false 均零副作用，见 slow-query.ts）
    return queryWithSlowLog('fs', schema, filter, () => {
      const records = this.collectAll(schema, filter);
      return applyFilter(records, filter) as StoredRecord<S>[];
    }, this.nowMs);
  }

  /** 拉取候选记录集合（按 shardKey 单 shard 或 scatter 全 shard） */
  private collectAll<S extends SchemaDef>(schema: S, filter: QueryFilter): Record<string, unknown>[] {
    if (!this.isSharded(schema)) {
      // 不分片：扫 entity 目录
      return this.scanEntityDir(schema, entityDir(this.root, schema));
    }

    if (filter.shardKey) {
      // 单 shard
      const dir = entityDir(this.root, schema, filter.shardKey);
      return this.scanEntityDir(schema, dir);
    }

    // scatter：遍历所有 shard 目录（spec §3.7 性能差，标注）
    const shardPrefix = shardRootPrefix(this.root, schema);
    const shardEntries = readDirWithTypeSync(shardPrefix).filter((e) => e.isDirectory);
    const out: Record<string, unknown>[] = [];
    for (const shard of shardEntries) {
      const dir = entityDir(this.root, schema, shard.name);
      out.push(...this.scanEntityDir(schema, dir));
    }
    return out;
  }

  /** 扫描某个 entity 目录（json 单文件 / jsonl 段聚合）下所有记录 */
  private scanEntityDir<S extends SchemaDef>(
    schema: S,
    dir: string,
  ): Record<string, unknown>[] {
    if (this.isJsonl(schema)) {
      return jsonlQuerySegments(dir);
    }
    const files = readDirSafeSync(dir).filter((f) => f.endsWith('.json'));
    const out: Record<string, unknown>[] = [];
    for (const f of files) {
      const rec = readJsonFileSync<Record<string, unknown>>(`${dir}/${f}`);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** 分片 schema 的 point 访问必须传 shardKey（spec §3.6 / crud §3.6） */
  private assertShardKeyIfSharded(
    schema: SchemaDef,
    shardKey: string | undefined,
    op: string,
  ): void {
    if (this.isSharded(schema) && shardKey === undefined) {
      throw new Error(
        `分片 entity ${schema.entity} 的 ${op} 必须传 shardKey 才能路由（spec §3.6）`,
      );
    }
  }
}

// ============================================================
// 辅助：信封字段提取 + query 过滤排序
// ============================================================

function pickMeta(rec: Record<string, unknown>): RecordMeta {
  return {
    createdAt: rec.createdAt as string,
    updatedAt: rec.updatedAt as string,
    version: rec.version as number,
  };
}

/** 应用 ids/createdAfter/createdBefore/order/limit（spec §4 query） */
function applyFilter(
  records: Record<string, unknown>[],
  filter: QueryFilter,
): Record<string, unknown>[] {
  let out = records.slice();
  if (filter.ids) {
    const set = new Set(filter.ids);
    out = out.filter((r) => set.has(r.id as string));
  }
  if (filter.createdAfter) {
    out = out.filter((r) => (r.createdAt as string) > filter.createdAfter!);
  }
  if (filter.createdBefore) {
    out = out.filter((r) => (r.createdAt as string) < filter.createdBefore!);
  }
  const order = filter.order ?? 'createdAtDesc';
  out.sort((a, b) =>
    order === 'createdAtAsc'
      ? (a.createdAt as string).localeCompare(b.createdAt as string)
      : (b.createdAt as string).localeCompare(a.createdAt as string),
  );
  if (filter.limit !== undefined) out = out.slice(0, filter.limit);
  return out;
}
