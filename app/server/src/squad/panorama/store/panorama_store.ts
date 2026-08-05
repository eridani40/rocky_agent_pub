/**
 * PanoramaEntityStore — 泛化 KV store + board.yaml 读写 + ID 生成.
 * 参考: specs/tech/squad/[P1]panorama_store.md §2（不建 SchemaDef）/ §3（实例格式）/ §4（ID）/ §5（lastWriteMessageId）/ §6（board.yaml）
 *       specs/tech/persistence/[P0]fs_crud_store_engine.md §3.6（原子写）/ §5（并发锁）
 *       specs/tech/squad/[P1]squad_store_projection.md §2（每项一文件 + lastWriteMessageId 惯例）
 *
 * 关键设计（store.md §2）：
 *   - 不为每个 entity 注册 SchemaDef——store 操作以 (entityName, id) 为 key，读写原始 JSON.
 *   - 复用 fs-io 原子写（atomicWriteSync: tmp→fsync→rename）+ withFileLock（进程内并发串行）.
 *   - 实例合法性靠校验引擎（validation/）在写入前校验，store 只负责文件读写 + 信封.
 *
 * 落盘路径（store.md §1）：
 *   data_dir/squads/{squadId}/panorama/board.yaml
 *   data_dir/squads/{squadId}/panorama/entities/{entity}/{id}.json
 *   data_dir/squads/{squadId}/panorama/events.jsonl
 *   data_dir/squads/{squadId}/panorama/.state/counters.json
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  atomicWriteSync, readJsonFileSync, removeFileSync,
  readDirSafeSync, ensureDirSync,
} from '../../../persistence/fs-io';
import { withFileLock } from '../../../persistence/file-lock';
import type { PanoramaSchema } from '../dsl/types';
import type { MigrationStore } from '../migration/apply_migration';
import { EventStore } from './events';
import type { PanoramaEvent, EventSource } from './events';

// ── 信封（store.md §3） ─────────────────────────────────────

export interface PanoramaEnvelope {
  createdAt: string;
  updatedAt: string;
  version: number;
}

// ── store 构造参数 ──────────────────────────────────────────

export interface PanoramaStoreOpts {
  /** data_dir 根 */
  root: string;
  /** squad id */
  squadId: string;
  /** 时间源（测试可固定） */
  now?: () => string;
}

// ── PanoramaEntityStore ─────────────────────────────────────

/**
 * 泛化实体 store + board.yaml 管理 + 事件流.
 * 实现 MigrationStore 接口供 migration 引擎调用.
 */
export class PanoramaEntityStore implements MigrationStore {
  private readonly root: string;
  private readonly squadId: string;
  private readonly now: () => string;
  private readonly _events: EventStore;

  constructor(opts: PanoramaStoreOpts) {
    this.root = opts.root;
    this.squadId = opts.squadId;
    this.now = opts.now ?? (() => new Date().toISOString());
    this._events = new EventStore({
      panoramaDir: this.panoramaDir,
      now: this.now,
    });
  }

  // ── 路径计算（store.md §1 目录布局） ──────────────────────

  get panoramaDir(): string {
    return join(this.root, 'squads', this.squadId, 'panorama');
  }

  private entityDir(entity: string): string {
    return join(this.panoramaDir, 'entities', entity);
  }

  private entityFile(entity: string, id: string): string {
    return join(this.entityDir(entity), `${id}.json`);
  }

  private boardFile(): string {
    return join(this.panoramaDir, 'board.yaml');
  }

  private countersFile(): string {
    return join(this.panoramaDir, '.state', 'counters.json');
  }

  // ── 泛化 KV CRUD（store.md §2） ───────────────────────────

  /** 列实体全部实例（扫描 entities/{entity}/*.json） */
  listInstances(entity: string): Record<string, unknown>[] {
    return readDirSafeSync(this.entityDir(entity))
      .filter(f => f.endsWith('.json'))
      .map(f => readJsonFileSync<Record<string, unknown>>(this.entityFile(entity, f.replace(/\.json$/, ''))))
      .filter((v): v is Record<string, unknown> => v !== undefined);
  }

  /** 读单实例；不存在返 undefined */
  getInstance(entity: string, id: string): Record<string, unknown> | undefined {
    return readJsonFileSync<Record<string, unknown>>(this.entityFile(entity, id));
  }

  /** 判断 id 是否存在（实例写唯一性校验用） */
  hasId(entity: string, id: string): boolean {
    return this.getInstance(entity, id) !== undefined;
  }

  /**
   * 写实例（原子）.
   * 自动维护信封（createdAt/updatedAt/version）+ 可选 lastWriteMessageId.
   */
  putInstance(
    entity: string, id: string,
    record: Record<string, unknown>,
    options?: { messageId?: string | null; now?: string },
  ): Record<string, unknown> {
    const existing = this.getInstance(entity, id);
    const now = options?.now ?? this.now();
    const envelope: PanoramaEnvelope = existing
      ? {
          createdAt: (existing._envelope as PanoramaEnvelope | undefined)?.createdAt ?? now,
          updatedAt: now,
          version: ((existing._envelope as PanoramaEnvelope | undefined)?.version ?? 0) + 1,
        }
      : { createdAt: now, updatedAt: now, version: 1 };

    const full = {
      ...record,
      id,
      _envelope: envelope,
      ...(options?.messageId !== undefined ? { lastWriteMessageId: options.messageId } : {}),
    };
    atomicWriteSync(this.entityFile(entity, id), JSON.stringify(full, null, 2));
    return full;
  }

  /** 删实例；返回是否实际删除 */
  deleteInstance(entity: string, id: string): boolean {
    return removeFileSync(this.entityFile(entity, id));
  }

  // ── board.yaml（DSL 主面，store.md §6） ───────────────────

  /** 读 board.yaml → PanoramaSchema；不存在返 null */
  readBoard(): PanoramaSchema | null {
    try {
      const raw = readFileSync(this.boardFile(), 'utf8');
      return parseYaml(raw) as PanoramaSchema;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /** 写 board.yaml（原子：tmp→fsync→rename，store.md §6） */
  writeBoard(schema: PanoramaSchema): void {
    const content = stringifyYaml(schema);
    atomicWriteSync(this.boardFile(), content);
  }

  // ── ID 生成（store.md §4） ────────────────────────────────

  /**
   * 取下一个 entity 内唯一 ID（{entity}-{seq}，4 位 padded）.
   * seq = per-entity 自增计数器（.state/counters.json，withFileLock 串行 read-modify-write）.
   */
  async nextId(entity: string): Promise<string> {
    const file = this.countersFile();
    return withFileLock(file, async () => {
      const counters = readJsonFileSync<Record<string, number>>(file) ?? {};
      const seq = (counters[entity] ?? 0) + 1;
      counters[entity] = seq;
      ensureDirSync(join(this.panoramaDir, '.state'));
      atomicWriteSync(file, JSON.stringify(counters, null, 2));
      return `${entity}-${String(seq).padStart(4, '0')}`;
    });
  }

  // ── 事件流（代理 EventStore） ─────────────────────────────

  /** 追加事件到 events.jsonl */
  appendEvent(event: Omit<PanoramaEvent, 'seq' | 'ts'> & Partial<Pick<PanoramaEvent, 'ts'>>): number {
    return this._events.append(event).seq;
  }

  /** 用预分配 seq 追加事件（migration 审计用，与 nextSeq 配对） */
  appendEventWithSeq(seq: number, event: Omit<PanoramaEvent, 'seq' | 'ts'> & Partial<Pick<PanoramaEvent, 'ts'>>): void {
    this._events.appendWithSeq(seq, event);
  }

  /** 读取事件流 */
  readEvents(since = 0, limit = 100): PanoramaEvent[] {
    return this._events.read(since, limit);
  }

  /** 订阅事件流（进程内，SSE 推送用） */
  subscribe(fn: (event: PanoramaEvent) => void): () => void {
    return this._events.subscribe(fn);
  }

  /** 取下一个 seq（MigrationStore 接口） */
  nextSeq(): number {
    return this._events.allocateSeq();
  }

  // ── 便捷写入（带事件流记录） ──────────────────────────────

  /** 创建实例 + 写 entity.created 事件 */
  createInstance(
    entity: string, id: string,
    record: Record<string, unknown>,
    options?: { messageId?: string | null; source?: EventSource },
  ): Record<string, unknown> {
    const created = this.putInstance(entity, id, record, options);
    this._events.append({
      type: 'entity.created',
      entity,
      id,
      summary: `新增 ${entity} ${id}`,
      payload: { id, record: created },
      source: options?.source ?? 'api',
      messageId: options?.messageId ?? null,
    });
    return created;
  }

  /** 更新实例 + 写 entity.updated 事件 */
  updateInstance(
    entity: string, id: string,
    record: Record<string, unknown>,
    options?: { messageId?: string | null; source?: EventSource },
  ): Record<string, unknown> | undefined {
    const updated = this.putInstance(entity, id, record, options);
    this._events.append({
      type: 'entity.updated',
      entity,
      id,
      summary: `更新 ${entity} ${id}`,
      payload: { id, record: updated },
      source: options?.source ?? 'api',
      messageId: options?.messageId ?? null,
    });
    return updated;
  }

  /** 跃迁实例 + 写 entity.transition 事件 */
  transitionInstance(
    entity: string, id: string,
    field: string, from: string, to: string,
    options?: { messageId?: string | null; source?: EventSource },
  ): Record<string, unknown> | undefined {
    const inst = this.getInstance(entity, id);
    if (!inst) return undefined;
    const updated = this.putInstance(entity, id, { ...inst, [field]: to }, options);
    this._events.append({
      type: 'entity.transition',
      entity,
      id,
      summary: `${id}: ${from} → ${to}`,
      payload: { id, from, to, field },
      source: options?.source ?? 'drag',
      messageId: options?.messageId ?? null,
    });
    return updated;
  }

  /** 删除实例 + 写 entity.deleted 事件 */
  removeInstance(
    entity: string, id: string,
    options?: { messageId?: string | null; source?: EventSource },
  ): boolean {
    const deleted = this.deleteInstance(entity, id);
    if (deleted) {
      this._events.append({
        type: 'entity.deleted',
        entity,
        id,
        summary: `删除 ${entity} ${id}`,
        payload: { id },
        source: options?.source ?? 'api',
        messageId: options?.messageId ?? null,
      });
    }
    return deleted;
  }
}
