/**
 * SingletonLock 单元测试（白盒）
 * 覆盖：
 *   - readSingletonLockTarget 解析 host-pid 格式（mock readlink）
 *   - 非标准格式 → undefined
 *   - clearStaleSingletonLocks：僵尸锁（pid 死）→ 删
 *   - clearStaleSingletonLocks：活锁（pid 活）→ 不删
 *   - ensureProfileFree：僵尸锁清后通过；活锁 → profile_in_use
 */
import { describe, it, expect } from 'vitest';
import {
  readSingletonLockTarget,
  clearStaleSingletonLocks,
  ensureProfileFree,
  SINGLETON_LOCK,
} from '../singleton-lock';
import { BrowserError } from '../types';

describe('readSingletonLockTarget', () => {
  it('标准 host-pid 格式 → 解析成功', () => {
    const t = readSingletonLockTarget('/x/SingletonLock', () => 'myhost-12345');
    expect(t).toEqual({ host: 'myhost', pid: 12345 });
  });

  it('非标准格式 → undefined', () => {
    expect(readSingletonLockTarget('/x', () => 'garbage')).toBeUndefined();
    expect(readSingletonLockTarget('/x', () => 'onlyhost')).toBeUndefined();
  });

  it('readlink 抛错 → undefined', () => {
    expect(readSingletonLockTarget('/x', () => {
      throw new Error('not a link');
    })).toBeUndefined();
  });
});

describe('clearStaleSingletonLocks', () => {
  const dir = '/user-data';
  const lockPath = `${dir}/${SINGLETON_LOCK}`;

  it('无锁文件 → false', () => {
    expect(clearStaleSingletonLocks(dir, { exists: () => false })).toBe(false);
  });

  it('僵尸锁（pid 死）→ 清理 → true', () => {
    const unlinked: string[] = [];
    const r = clearStaleSingletonLocks(dir, {
      exists: (p) => p === lockPath,
      readlink: () => 'host-99999',
      pidAlive: () => false, // 进程已死
      unlink: (p) => {
        unlinked.push(p);
      },
    });
    expect(r).toBe(true);
    // 至少删了 SingletonLock
    expect(unlockedContains(unlinked, SINGLETON_LOCK)).toBe(true);
  });

  it('活锁（pid 活）→ 不删 → false', () => {
    const unlinked: string[] = [];
    const r = clearStaleSingletonLocks(dir, {
      exists: (p) => p === lockPath,
      readlink: () => 'host-100',
      pidAlive: () => true,
      unlink: (p) => {
        unlinked.push(p);
      },
    });
    expect(r).toBe(false);
    expect(unlinked.length).toBe(0);
  });

  it('非标准锁格式 → 不处理 → false', () => {
    const r = clearStaleSingletonLocks(dir, {
      exists: (p) => p === lockPath,
      readlink: () => 'garbage',
      pidAlive: () => false,
      unlink: () => {},
    });
    expect(r).toBe(false);
  });
});

describe('ensureProfileFree', () => {
  const dir = '/user-data';
  const lockPath = `${dir}/${SINGLETON_LOCK}`;

  it('僵尸锁 → 清后通过（不抛）', () => {
    expect(() =>
      ensureProfileFree(dir, {
        exists: (p) => p === lockPath,
        readlink: () => 'host-99999',
        pidAlive: () => false,
        unlink: () => {},
      }),
    ).not.toThrow();
  });

  it('活锁 → 抛 profile_in_use', () => {
    try {
      ensureProfileFree(dir, {
        exists: (p) => p === lockPath,
        readlink: () => 'host-100',
        pidAlive: () => true,
        unlink: () => {},
      });
      expect.fail('应抛 profile_in_use');
    } catch (e) {
      expect(e).toBeInstanceOf(BrowserError);
      expect((e as BrowserError).kind).toBe('profile_in_use');
    }
  });

  it('无锁 → 直接通过', () => {
    expect(() =>
      ensureProfileFree(dir, { exists: () => false, readlink: () => '', pidAlive: () => true, unlink: () => {} }),
    ).not.toThrow();
  });
});

function unlockedContains(arr: string[], name: string): boolean {
  return arr.some((p) => p.endsWith(`/${name}`));
}
