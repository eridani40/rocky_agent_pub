/**
 * memory policy 单测（v0.0.112 新建；v0.0.238 改字符口径）
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §5/§5.1（长度硬限 + evolvable 治理）
 *       specs/tech/version_logs/v0.0.238/change_plan.md 模块 F（字符口径退役旧 300 词口径）
 *
 * 覆盖验收：
 *   - INTRO_CHAR_LIMIT = 50 / BODY_CHAR_LIMIT = 500
 *   - MemoryCharLimitError 携 field/current/limit；MemoryNonEvolvableError 携 name
 *   - resolvePersistedEvolvable 三语义（setEvolvable 覆盖 / 既有保留 / 新建默认）
 */
import { describe, it, expect } from 'vitest';
import {
  INTRO_CHAR_LIMIT,
  BODY_CHAR_LIMIT,
  MemoryCharLimitError,
  MemoryNonEvolvableError,
  MemoryQuotaExceededError,
  resolvePersistedEvolvable,
} from '../policy';

describe('policy — 字符硬限常量', () => {
  it('INTRO_CHAR_LIMIT = 50 / BODY_CHAR_LIMIT = 500', () => {
    expect(INTRO_CHAR_LIMIT).toBe(50);
    expect(BODY_CHAR_LIMIT).toBe(500);
  });
});

describe('policy — MemoryCharLimitError', () => {
  it('intro 超限：携 field=intro / current / limit + 消息含 exceeds 50 chars', () => {
    const err = new MemoryCharLimitError('intro', 65, INTRO_CHAR_LIMIT);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MemoryCharLimitError');
    expect(err.field).toBe('intro');
    expect(err.current).toBe(65);
    expect(err.limit).toBe(50);
    expect(err.message).toContain('exceeds 50 chars');
    expect(err.message).toContain('65');
  });

  it('body 超限：携 field=body / current / limit + 消息含 exceeds 500 chars', () => {
    const err = new MemoryCharLimitError('body', 612, BODY_CHAR_LIMIT);
    expect(err.field).toBe('body');
    expect(err.current).toBe(612);
    expect(err.limit).toBe(500);
    expect(err.message).toContain('exceeds 500 chars');
    expect(err.message).toContain('612');
  });
});

describe('policy — MemoryNonEvolvableError', () => {
  it('携 name + 消息含 non-evolvable', () => {
    const err = new MemoryNonEvolvableError('locked-entry');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MemoryNonEvolvableError');
    expect(err.entryName).toBe('locked-entry');
    expect(err.message).toContain('locked-entry');
    expect(err.message).toContain('non-evolvable');
  });
});

describe('policy — MemoryQuotaExceededError（v0.0.247 存储数量硬上限）', () => {
  it('继承 Error + name=MemoryQuotaExceededError + 携四字段', () => {
    const err = new MemoryQuotaExceededError('group', 30, 30, 0);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MemoryQuotaExceededError');
    expect(err.scope).toBe('group');
    expect(err.current).toBe(30);
    expect(err.limit).toBe(30);
    expect(err.nonEvolvableCount).toBe(0);
  });

  it('message 形态含 quota exceeded + current/limit + archive 引导', () => {
    const err = new MemoryQuotaExceededError('global', 50, 50, 0);
    expect(err.message).toContain('memory global quota exceeded');
    expect(err.message).toContain('(50/50)');
    expect(err.message).toContain('archive');
    expect(err.message).toContain('腾位');
  });

  it('nonEvolvableCount=0 → 不附 evolvable=false suffix', () => {
    const err = new MemoryQuotaExceededError('session', 20, 20, 0);
    expect(err.message).not.toContain('evolvable=false');
  });

  it('nonEvolvableCount>0 → 附「其中 X 条 evolvable=false 无法 archive」', () => {
    const err = new MemoryQuotaExceededError('group', 30, 30, 5);
    expect(err.nonEvolvableCount).toBe(5);
    expect(err.message).toContain('其中 5 条 evolvable=false 无法 archive');
  });

  it('archive 数量 N = current-limit+1（写入 1 条新所需腾出位数）', () => {
    // count==limit（最常见边界）：N=1
    const boundary = new MemoryQuotaExceededError('global', 50, 50, 0);
    expect(boundary.message).toContain('archive 1 旧条目');
    // count>limit（存量超限场景）：N=current-limit+1
    const overflow = new MemoryQuotaExceededError('global', 55, 50, 0);
    expect(overflow.message).toContain('archive 6 旧条目');
  });

  it('scope 三值均可（global/session/group）', () => {
    for (const scope of ['global', 'session', 'group'] as const) {
      const err = new MemoryQuotaExceededError(scope, 10, 10, 0);
      expect(err.scope).toBe(scope);
      expect(err.message).toContain(`memory ${scope} quota exceeded`);
    }
  });

  it('nonEvolvableCount 缺省 → 0（向后兼容默认参数）', () => {
    const err = new MemoryQuotaExceededError('global', 50, 50);
    expect(err.nonEvolvableCount).toBe(0);
    expect(err.message).not.toContain('evolvable=false');
  });
});

describe('policy.resolvePersistedEvolvable — 三语义', () => {
  it('setEvolvable 存在 → 直接用（覆盖既有/默认）', () => {
    expect(resolvePersistedEvolvable({ setEvolvable: true }, false)).toBe(true);
    expect(resolvePersistedEvolvable({ setEvolvable: false, defaultEvolvable: true }, undefined)).toBe(false);
  });

  it('无 setEvolvable + 既有 → 保留既有 evolvable', () => {
    expect(resolvePersistedEvolvable({}, false)).toBe(false);
    expect(resolvePersistedEvolvable({ defaultEvolvable: true }, false)).toBe(false);
    expect(resolvePersistedEvolvable({}, true)).toBe(true);
  });

  it('无 setEvolvable + 无既有（新建）→ defaultEvolvable ?? false', () => {
    expect(resolvePersistedEvolvable({ defaultEvolvable: true }, undefined)).toBe(true); // agent 新建
    expect(resolvePersistedEvolvable({ defaultEvolvable: false }, undefined)).toBe(false); // UI 新建
    expect(resolvePersistedEvolvable({}, undefined)).toBe(false); // 缺省 false
  });
});
