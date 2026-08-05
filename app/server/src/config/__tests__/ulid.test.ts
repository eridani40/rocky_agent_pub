/**
 * ULID 生成器单测 — 格式 + 单调性
 * 参考: ULID 规范 https://github.com/ulid/spec
 *
 * 覆盖：
 *   - 长度 26 字符
 *   - 字符集 Crockford Base32（无 I/L/O/U）
 *   - 同进程连续生成单调非递减
 *   - 批量生成无重复
 */
import { describe, it, expect } from 'vitest';
import { ulid } from '../ulid';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('ulid 格式', () => {
  it('长度恒为 26 字符', () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid().length).toBe(26);
    }
  });

  it('字符集为 Crockford Base32（不含 I/L/O/U）', () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toMatch(CROCKFORD);
    }
  });
});

describe('ulid 单调性', () => {
  it('连续生成单调非递减', () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(ulid());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! >= ids[i - 1]!).toBe(true);
    }
  });

  it('批量生成无重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(ulid());
    expect(ids.size).toBe(10000);
  });
});
