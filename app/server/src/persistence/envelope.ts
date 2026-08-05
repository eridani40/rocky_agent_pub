/**
 * CrudStore 信封注入 / mode / ifVersion 纯逻辑辅助
 * 参考: specs/tech/persistence/[P0]crud_store_interface.md §2.3 / §3.3
 *
 * 设计目的（task.json T2 §6）：FS / SQLite engine 都要执行「注入信封 + mode 决策 +
 * ifVersion 乐观锁」三件事，逻辑完全相同；抽到此处纯函数复用，避免每个 engine
 * 重复实现导致行为分叉。
 *
 * 接口 `computeEnvelope`：根据 existing（落盘当前信封，可为 undefined）+ PutOptions +
 * 当前时间 now，返回应写入的新信封 RecordMeta，或在语义冲突时抛错。
 *
 * 这是纯逻辑（无 IO），engine 负责把返回的 RecordMeta 与实体 data 合并后落盘。
 */
import {
  RecordExistsError,
  RecordNotFoundError,
  VersionConflictError,
} from './errors';
import type { PutMode, PutOptions, RecordMeta } from './crud-types';

/** computeEnvelope 的入参 */
export interface ComputeEnvelopeInput {
  /** 落盘当前的信封；undefined 表示主键不存在（首次写） */
  existing: RecordMeta | undefined;
  /** put 选项（mode / ifVersion） */
  opts: PutOptions | undefined;
  /** 当前时间（isoDate），engine 应传真实 now；测试可固定 */
  now: string;
  /** 主键 id（用于错误信息定位冲突记录） */
  id: string;
}

/**
 * 计算写入后的信封（纯逻辑，spec §2.3 + §3.3）。
 *
 * 规则：
 *   - mode='insert'：existing 存在 → RecordExistsError；否则首次注入（v=1）
 *   - mode='replace'：existing 不存在 → RecordNotFoundError；存在则重置时间 + version+1
 *   - mode='upsert'（缺省）：存在则更新（createdAt 保留 + updatedAt 推进 + v+1），否则首次注入
 *   - ifVersion：与 existing.version 不匹配 → VersionConflictError{expected,actual}
 *     （首次写带 ifVersion 视为冲突，actual=0 语义「期望存在但实际无」）
 *   - 首次注入：createdAt=updatedAt=now, version=1
 *
 * ifVersion 检查在 mode 检查之后（mode 决定「是否允许写」，ifVersion 决定「版本是否对得上」）。
 */
export function computeEnvelope(input: ComputeEnvelopeInput): RecordMeta {
  const { existing, opts, now, id } = input;
  const mode: PutMode = opts?.mode ?? 'upsert';
  const exists = existing !== undefined;

  // 1) mode 决策（spec §2.3 PutMode）
  if (mode === 'insert' && exists) {
    throw new RecordExistsError(id);
  }
  if (mode === 'replace' && !exists) {
    throw new RecordNotFoundError(id);
  }

  // 2) ifVersion 乐观锁检查（spec §2.3 PutOptions.ifVersion）
  if (opts?.ifVersion !== undefined) {
    const actualVersion = exists ? existing!.version : 0;
    if (opts.ifVersion !== actualVersion) {
      throw new VersionConflictError({
        expected: opts.ifVersion,
        actual: actualVersion,
        id,
      });
    }
  }

  // 3) 计算新信封
  if (!exists) {
    // 首次注入（insert/upsert 走此分支；replace 已在 step 1 抛错）
    return { createdAt: now, updatedAt: now, version: 1 };
  }

  if (mode === 'replace') {
    // replace：重置时间 + version+1（spec §2.3 'replace'）
    return {
      createdAt: now, // 重置
      updatedAt: now,
      version: existing!.version + 1,
    };
  }

  // upsert（含缺省）更新：createdAt 保留 + updatedAt 推进 + version+1
  // [v0.0.231] preserveUpdatedAt=true 时保留 existing.updatedAt（version 仍 +1）——
  //   纯标记字段写入不刷新活跃时间（session pinned 置顶，用户裁决 2026-08-01）。
  return {
    createdAt: existing!.createdAt, // 保留
    updatedAt: opts?.preserveUpdatedAt === true ? existing!.updatedAt : now,
    version: existing!.version + 1,
  };
}
