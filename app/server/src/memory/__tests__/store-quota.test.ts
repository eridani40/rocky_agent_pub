/**
 * memory store-quota 单测（v0.0.247 — 存储数量硬上限纯函数）
 * 参考: specs/tech/version_logs/v0.0.247/change_plan.md（memory 子系统）
 *       app/server/src/memory/store-quota.ts
 *
 * 覆盖：
 *   - DEFAULT_MEMORY_STORE_QUOTAS = {global:50, group:30, session:20}
 *   - resolveMemoryStoreQuotas 兜底（null / 非 object session / 字段非 finite / 正常值）
 *   - countActiveEntries（archived 过滤、dir 不存在返 0、坏文件跳过）
 *   - checkMemoryStoreQuota（未超 no-op / 超限 throw + 四字段 + evolvable=false 计数文案）
 *
 * 纯函数 + 真 tmpdir fixture（countActiveEntries/checkMemoryStoreQuota 需要文件系统）。
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEMORY_STORE_QUOTAS,
  resolveMemoryStoreQuotas,
  countActiveEntries,
  checkMemoryStoreQuota,
  type MemoryStoreQuotas,
} from '../store-quota';
import { MemoryQuotaExceededError } from '../policy';
import { serializeEntryFile } from '../memory-dir-store';
import type { AppConfigService } from '../../config/app-config-service';

let tmpRoot: string;
let dir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-memstorequota-'));
  dir = join(tmpRoot, 'mem');
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造 AppConfigService 桩：get('session','default') 返 sessionRecord；其他返 undefined */
function fakeAppConfig(sessionRecord?: Record<string, unknown>): AppConfigService {
  return {
    get: (group: string, key: string) => {
      if (group === 'session' && key === 'default') return sessionRecord;
      return undefined;
    },
    set: () => {},
  } as unknown as AppConfigService;
}

/** 落盘 N 条 active entry（name=e0..eN-1） */
function seedActive(n: number, opts: { evolvable?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const e = {
      name: `e${i}`,
      intro: `intro-${i}`,
      type: 'user' as const,
      archived: false,
      evolvable: opts.evolvable === false ? false : true,
      source: 'agent' as const,
      updatedAt: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
      body: `body-${i}`,
    };
    writeFileSync(join(dir, `e${i}.md`), serializeEntryFile(e));
  }
}

// ============================================================
// DEFAULT_MEMORY_STORE_QUOTAS
// ============================================================
describe('DEFAULT_MEMORY_STORE_QUOTAS', () => {
  it('global=50 / group=30 / session=20（与注入配额同值）', () => {
    expect(DEFAULT_MEMORY_STORE_QUOTAS).toEqual({ global: 50, group: 30, session: 20 });
  });
});

// ============================================================
// resolveMemoryStoreQuotas — 兜底分支
// ============================================================
describe('resolveMemoryStoreQuotas — 兜底', () => {
  it('appConfig=null → 三层均默认 50/30/20', () => {
    expect(resolveMemoryStoreQuotas(null)).toEqual({ global: 50, group: 30, session: 20 });
  });

  it('session record 缺失（get 返 undefined）→ 三层默认', () => {
    expect(resolveMemoryStoreQuotas(fakeAppConfig(undefined))).toEqual({ global: 50, group: 30, session: 20 });
  });

  it('session record 非 object（如 string）→ 三层默认', () => {
    expect(resolveMemoryStoreQuotas(fakeAppConfig({ maxMemoryInject: 'lots' }))).toEqual({
      global: 50,
      group: 30,
      session: 20,
    });
  });

  it('字段非 finite（NaN / Infinity / string）→ 该层独立回退默认', () => {
    const ac = fakeAppConfig({
      maxMemoryInject: NaN,
      maxMemoryInjectGroup: Infinity,
      maxMemoryInjectSession: '20',
    });
    expect(resolveMemoryStoreQuotas(ac)).toEqual({ global: 50, group: 30, session: 20 });
  });

  it('部分覆盖：仅传 global → global 用值，group/session 默认', () => {
    const ac = fakeAppConfig({ maxMemoryInject: 100 });
    expect(resolveMemoryStoreQuotas(ac)).toEqual({ global: 100, group: 30, session: 20 });
  });

  it('完整覆盖：三层均传 finite 值', () => {
    const ac = fakeAppConfig({
      maxMemoryInject: 80,
      maxMemoryInjectGroup: 40,
      maxMemoryInjectSession: 10,
    });
    expect(resolveMemoryStoreQuotas(ac)).toEqual({ global: 80, group: 40, session: 10 });
  });

  it('各层独立兜底（混合 finite 与非法）', () => {
    const ac = fakeAppConfig({
      maxMemoryInject: 60,
      maxMemoryInjectGroup: NaN,
      maxMemoryInjectSession: 5,
    });
    expect(resolveMemoryStoreQuotas(ac)).toEqual({ global: 60, group: 30, session: 5 });
  });

  it('负数 finite 也接受（语义=该层禁用，由 caller 决定）', () => {
    const ac = fakeAppConfig({ maxMemoryInject: -1, maxMemoryInjectGroup: 0, maxMemoryInjectSession: 5 });
    expect(resolveMemoryStoreQuotas(ac)).toEqual({ global: -1, group: 0, session: 5 });
  });
});

// ============================================================
// countActiveEntries
// ============================================================
describe('countActiveEntries', () => {
  it('dir 不存在 → 0', () => {
    expect(countActiveEntries(join(tmpRoot, 'ghost'))).toBe(0);
  });

  it('空 dir → 0', () => {
    mkdirSync(dir, { recursive: true });
    expect(countActiveEntries(dir)).toBe(0);
  });

  it('N 条 active → N', () => {
    seedActive(5);
    expect(countActiveEntries(dir)).toBe(5);
  });

  it('archived 条目不计入（includeArchived:false）', () => {
    mkdirSync(dir, { recursive: true });
    // 3 active + 2 archived
    for (let i = 0; i < 3; i++) {
      const e = {
        name: `a${i}`, intro: 'i', type: 'user' as const, archived: false,
        evolvable: true, source: 'agent' as const, updatedAt: '', body: 'b',
      };
      writeFileSync(join(dir, `a${i}.md`), serializeEntryFile(e));
    }
    for (let i = 0; i < 2; i++) {
      const e = {
        name: `x${i}`, intro: 'i', type: 'user' as const, archived: true,
        evolvable: true, source: 'agent' as const, updatedAt: '', body: 'b',
      };
      writeFileSync(join(dir, `x${i}.md`), serializeEntryFile(e));
    }
    expect(countActiveEntries(dir)).toBe(3);
  });

  it('坏文件跳过不计入', () => {
    seedActive(2);
    writeFileSync(join(dir, 'broken.md'), '---\nmetadata:\n  type: bogus\n---\nb\n');
    writeFileSync(join(dir, 'not-md.txt'), 'garbage');
    expect(countActiveEntries(dir)).toBe(2);
  });
});

// ============================================================
// checkMemoryStoreQuota
// ============================================================
describe('checkMemoryStoreQuota', () => {
  const Q: MemoryStoreQuotas = { global: 3, group: 2, session: 1 };

  it('count < limit → no-op（不抛）', () => {
    seedActive(2);
    expect(() => checkMemoryStoreQuota(dir, 'global', Q)).not.toThrow();
  });

  it('count == limit → throw（边界：等于即拒，写入会让 count+1 超 limit）', () => {
    seedActive(3);
    expect(() => checkMemoryStoreQuota(dir, 'global', Q)).toThrow(MemoryQuotaExceededError);
  });

  it('count > limit → throw', () => {
    seedActive(5);
    expect(() => checkMemoryStoreQuota(dir, 'global', Q)).toThrow(MemoryQuotaExceededError);
  });

  it('throw 错误携 scope/current/limit 四字段', () => {
    seedActive(3);
    try {
      checkMemoryStoreQuota(dir, 'global', Q);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as MemoryQuotaExceededError;
      expect(err).toBeInstanceOf(MemoryQuotaExceededError);
      expect(err.name).toBe('MemoryQuotaExceededError');
      expect(err.scope).toBe('global');
      expect(err.current).toBe(3);
      expect(err.limit).toBe(3);
      expect(err.nonEvolvableCount).toBe(0);
    }
  });

  it('message 含 quota exceeded + current/limit + archive 引导', () => {
    seedActive(3);
    try {
      checkMemoryStoreQuota(dir, 'session', Q);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('memory session quota exceeded');
      expect(msg).toContain('(3/1)');
      expect(msg).toContain('archive');
    }
  });

  it('各 scope 独立：session=1 / group=2 / global=3 互不影响', () => {
    seedActive(2);
    // count=2：session(1) 超 → throw；group(2) 边界等 → throw；global(3) 未超 → no-op
    expect(() => checkMemoryStoreQuota(dir, 'session', Q)).toThrow();
    expect(() => checkMemoryStoreQuota(dir, 'group', Q)).toThrow();
    expect(() => checkMemoryStoreQuota(dir, 'global', Q)).not.toThrow();
  });

  it('evolvable=false 计入配额（防绕过）+ 文案带「其中 X 条 evolvable=false 无法 archive」', () => {
    seedActive(3, { evolvable: false }); // 3 条全 evolvable=false
    try {
      checkMemoryStoreQuota(dir, 'global', Q);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as MemoryQuotaExceededError;
      expect(err.nonEvolvableCount).toBe(3);
      expect(err.message).toContain('其中 3 条 evolvable=false 无法 archive');
    }
  });

  it('混合 evolvable：nonEvolvableCount 只数 evolvable=false 的 active 条目', () => {
    mkdirSync(dir, { recursive: true });
    // 2 条 evolvable=true + 1 条 evolvable=false
    for (const [name, ev] of [['a', true], ['b', true], ['c', false]] as const) {
      const e = {
        name, intro: 'i', type: 'user' as const, archived: false,
        evolvable: ev, source: 'agent' as const, updatedAt: '', body: 'b',
      };
      writeFileSync(join(dir, `${name}.md`), serializeEntryFile(e));
    }
    try {
      checkMemoryStoreQuota(dir, 'global', Q); // count=3, limit=3 → throw
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as MemoryQuotaExceededError).nonEvolvableCount).toBe(1);
      expect((e as Error).message).toContain('其中 1 条 evolvable=false');
    }
  });

  it('archived 的 evolvable=false 不计入 nonEvolvableCount', () => {
    mkdirSync(dir, { recursive: true });
    // 3 条 active evolvable=true + 2 条 archived evolvable=false
    for (let i = 0; i < 3; i++) {
      const e = {
        name: `a${i}`, intro: 'i', type: 'user' as const, archived: false,
        evolvable: true, source: 'agent' as const, updatedAt: '', body: 'b',
      };
      writeFileSync(join(dir, `a${i}.md`), serializeEntryFile(e));
    }
    for (let i = 0; i < 2; i++) {
      const e = {
        name: `x${i}`, intro: 'i', type: 'user' as const, archived: true,
        evolvable: false, source: 'agent' as const, updatedAt: '', body: 'b',
      };
      writeFileSync(join(dir, `x${i}.md`), serializeEntryFile(e));
    }
    try {
      checkMemoryStoreQuota(dir, 'global', Q); // active=3, limit=3 → throw
      throw new Error('should have thrown');
    } catch (e) {
      // archived 的 evolvable=false 不算
      expect((e as MemoryQuotaExceededError).nonEvolvableCount).toBe(0);
    }
  });

  it('opts.evolvableFalseCount 显式传入 → 不再扫描 listMetas（直接用）', () => {
    seedActive(3); // 实际 evolvable=true，但 caller 显式传 5
    try {
      checkMemoryStoreQuota(dir, 'global', Q, { evolvableFalseCount: 5 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as MemoryQuotaExceededError).nonEvolvableCount).toBe(5);
      expect((e as Error).message).toContain('其中 5 条 evolvable=false');
    }
  });

  it('opts.evolvableFalseCount=0 → 不附 evolvable suffix', () => {
    seedActive(3);
    try {
      checkMemoryStoreQuota(dir, 'global', Q, { evolvableFalseCount: 0 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('evolvable=false');
    }
  });
});
