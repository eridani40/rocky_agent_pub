/**
 * 信封注入 / mode / ifVersion 纯逻辑单测
 * 参考: specs/tech/persistence/[P0]crud_store_interface.md §2-§3
 *       states/v0.0.2/verify/test-plan.md §3 CrudStore 契约维度（P1/P4/P5）
 *
 * 覆盖：
 *   - computeEnvelope 首次/更新注入（createdAt/updatedAt/version 自增）
 *   - PutOptions.mode 行为（insert/replace/upsert）
 *   - PutOptions.ifVersion 乐观锁（匹配→+1、不匹配→VersionConflictError）
 *   - 错误类型构造（RecordExists/NotFound/VersionConflict）
 *
 * 纯逻辑无 IO，engine（FS/SQLite）复用本逻辑，避免重复实现。
 */
import { describe, it, expect } from 'vitest';
import {
  computeEnvelope,
  RecordExistsError,
  RecordNotFoundError,
  VersionConflictError,
  type RecordMeta,
} from '../index';

// ============================================================
// 工具：固定时间，便于断言 createdAt/updatedAt
// ============================================================
const NOW = '2026-06-19T03:10:00.000Z';
const NOW2 = '2026-06-19T03:11:00.000Z';
const tick = () => NOW;
const tick2 = () => NOW2;

// ============================================================
// P1：信封注入（首次 put）
// ============================================================
describe('computeEnvelope — 首次写入（无 existing）', () => {
  it('注入 createdAt/updatedAt/version=1', () => {
    const meta = computeEnvelope({ existing: undefined, opts: undefined, now: tick(), id: 'id-1' });
    expect(meta.createdAt).toBe(NOW);
    expect(meta.updatedAt).toBe(NOW);
    expect(meta.version).toBe(1);
  });

  it('默认 mode=upsert 在无 existing 时退化为 insert', () => {
    const meta = computeEnvelope({ existing: undefined, opts: { mode: 'upsert' }, now: tick(), id: 'id-1' });
    expect(meta.version).toBe(1);
  });
});

// ============================================================
// P1：upsert 二次写入（version 自增、updatedAt 推进）
// ============================================================
describe('computeEnvelope — upsert 更新', () => {
  const existing: RecordMeta = {
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    version: 1,
  };

  it('version 自增、updatedAt 推进、createdAt 保留', () => {
    const meta = computeEnvelope({ existing, opts: undefined, now: tick2(), id: 'id-1' });
    expect(meta.version).toBe(2);
    expect(meta.updatedAt).toBe(NOW2);
    expect(meta.createdAt).toBe('2026-06-19T00:00:00.000Z'); // 保留
  });

  it('mode 显式 upsert 行为同缺省', () => {
    const meta = computeEnvelope({ existing, opts: { mode: 'upsert' }, now: tick2(), id: 'id-1' });
    expect(meta.version).toBe(2);
  });
});

// ============================================================
// [v0.0.231] preserveUpdatedAt（纯标记写入不刷新活跃时间，version 仍 +1）
// ============================================================
describe('computeEnvelope — preserveUpdatedAt（v0.0.231）', () => {
  const existing: RecordMeta = {
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    version: 1,
  };

  it('upsert 更新 + preserveUpdatedAt:true → updatedAt 保留 existing、version+1、createdAt 保留', () => {
    const meta = computeEnvelope({
      existing,
      opts: { preserveUpdatedAt: true },
      now: tick2(),
      id: 'id-1',
    });
    expect(meta.updatedAt).toBe('2026-06-19T00:00:00.000Z'); // 保留 existing
    expect(meta.createdAt).toBe('2026-06-19T00:00:00.000Z'); // 照常保留
    expect(meta.version).toBe(2); // 仍 +1
  });

  it('缺省（不传）→ updatedAt 推进（现状回归）', () => {
    const meta = computeEnvelope({ existing, opts: undefined, now: tick2(), id: 'id-1' });
    expect(meta.updatedAt).toBe(NOW2);
  });

  it('preserveUpdatedAt:false 显式 → updatedAt 推进（与缺省一致）', () => {
    const meta = computeEnvelope({
      existing,
      opts: { preserveUpdatedAt: false },
      now: tick2(),
      id: 'id-1',
    });
    expect(meta.updatedAt).toBe(NOW2);
  });

  it('首次写（无 existing）+ preserveUpdatedAt:true → 照常注入 now（flag 仅影响更新分支）', () => {
    const meta = computeEnvelope({
      existing: undefined,
      opts: { preserveUpdatedAt: true },
      now: tick(),
      id: 'id-1',
    });
    expect(meta.updatedAt).toBe(NOW);
    expect(meta.version).toBe(1);
  });

  it('mode=replace + preserveUpdatedAt:true → 仍重置时间（replace 语义不变）', () => {
    const meta = computeEnvelope({
      existing,
      opts: { mode: 'replace', preserveUpdatedAt: true },
      now: tick2(),
      id: 'id-1',
    });
    expect(meta.updatedAt).toBe(NOW2);
  });
});

// ============================================================
// P5：mode 行为
// ============================================================
describe('computeEnvelope — mode 行为', () => {
  const existing: RecordMeta = {
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    version: 3,
  };

  it('insert + existing → 抛 RecordExistsError', () => {
    expect(() =>
      computeEnvelope({ existing, opts: { mode: 'insert' }, now: tick2(), id: 'id-1' }),
    ).toThrowError(RecordExistsError);
  });

  it('insert + 无 existing → 注入 version=1（首次）', () => {
    const meta = computeEnvelope({ existing: undefined, opts: { mode: 'insert' }, now: tick(), id: 'id-1' });
    expect(meta.version).toBe(1);
    expect(meta.createdAt).toBe(NOW);
  });

  it('replace + existing → 重置时间 + version+1', () => {
    const meta = computeEnvelope({ existing, opts: { mode: 'replace' }, now: tick2(), id: 'id-1' });
    expect(meta.version).toBe(4);
    expect(meta.createdAt).toBe(NOW2); // replace 重置时间
    expect(meta.updatedAt).toBe(NOW2);
  });

  it('replace + 无 existing → 抛 RecordNotFoundError', () => {
    expect(() =>
      computeEnvelope({ existing: undefined, opts: { mode: 'replace' }, now: tick(), id: 'id-1' }),
    ).toThrowError(RecordNotFoundError);
  });
});

// ============================================================
// P4：ifVersion 乐观锁
// ============================================================
describe('computeEnvelope — ifVersion 乐观锁', () => {
  const existing: RecordMeta = {
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    version: 2,
  };

  it('ifVersion 匹配 → version+1', () => {
    const meta = computeEnvelope({ existing, opts: { ifVersion: 2 }, now: tick2(), id: 'id-1' });
    expect(meta.version).toBe(3);
  });

  it('ifVersion 不匹配 → VersionConflictError{expected,actual}', () => {
    try {
      computeEnvelope({ existing, opts: { ifVersion: 1 }, now: tick2(), id: 'id-1' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VersionConflictError);
      const err = e as VersionConflictError;
      expect(err.expected).toBe(1);
      expect(err.actual).toBe(2);
    }
  });

  it('ifVersion 在无 existing（首次写） → 抛 VersionConflictError（actual=0 语义）', () => {
    // 首次写带 ifVersion 是调用方逻辑错误：期望存在但实际无
    expect(() =>
      computeEnvelope({ existing: undefined, opts: { ifVersion: 1 }, now: tick(), id: 'id-1' }),
    ).toThrowError(VersionConflictError);
  });

  it('ifVersion 与 mode 组合：replace + ifVersion 匹配 → 重置时间 + version+1', () => {
    const meta = computeEnvelope({
      existing,
      opts: { mode: 'replace', ifVersion: 2 },
      now: tick2(),
      id: 'id-1',
    });
    expect(meta.version).toBe(3);
    expect(meta.createdAt).toBe(NOW2); // replace 重置
  });
});

// ============================================================
// 错误类型构造
// ============================================================
describe('错误类型构造', () => {
  it('RecordExistsError 实例化', () => {
    const err = new RecordExistsError('id-xxx');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RecordExistsError');
    expect(err.message).toContain('id-xxx');
  });

  it('RecordNotFoundError 实例化', () => {
    const err = new RecordNotFoundError('id-yyy');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RecordNotFoundError');
    expect(err.message).toContain('id-yyy');
  });

  it('VersionConflictError 携带 expected/actual', () => {
    const err = new VersionConflictError({ expected: 1, actual: 2, id: 'id-zzz' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('VersionConflictError');
    expect(err.expected).toBe(1);
    expect(err.actual).toBe(2);
    expect(err.message).toContain('1');
    expect(err.message).toContain('2');
  });
});
