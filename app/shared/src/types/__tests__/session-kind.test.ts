/**
 * SessionKind 类型单元测试（slim kind + runKind 扁平 + SessionContext + 两层校验）
 * 参考: specs/tech/agent/session/[P0]session_kind.md §1-§5
 *       app/shared/src/types/session-kind.ts（被测文件）
 *
 * 覆盖：
 *   - SessionKind slim 构造（4 字段：biz/role/derivation/runKind；runKind 缺省 'main'）
 *   - getter：isStudio / isSubagent / isMainRun
 *   - canonicalId()（4 段纯拼接）
 *   - validateSessionKind（K1/K3 role⇒biz + K5 runKind 闭合枚举）
 *   - validateSessionContext（C1-C3）
 *   - isStudioMainSession helper
 */
import { describe, it, expect } from 'vitest';
import {
  SessionKind,
  SessionKindValidationError,
  isStudioMainSession,
  validateSessionKind,
  validateSessionContext,
} from '../session-kind';
import type { SessionContext } from '../session-kind';

describe('SessionKind slim 构造', () => {
  it('playground parent main + runKind 缺省', () => {
    const k = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });
    expect(k.biz).toBe('playground');
    expect(k.role).toBe('rocky');
    expect(k.derivation).toBe('parent');
    expect(k.runKind).toBe('main'); // 缺省 'main'
  });

  it('studio leader parent + runKind 显式 summary', () => {
    const k = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'parent', runKind: 'summary' });
    expect(k.runKind).toBe('summary');
  });

  it('studio leader subagent', () => {
    const k = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'subagent' });
    expect(k.canonicalId()).toBe('studio-leader:subagent:main');
  });

  it('consolidate runKind', () => {
    const k = new SessionKind({ biz: 'studio', role: 'mate', derivation: 'parent', runKind: 'consolidate' });
    expect(k.isMainRun).toBe(false);
    expect(k.canonicalId()).toBe('studio-mate:parent:consolidate');
  });
});

describe('SessionKind getter — isMainRun（v0.0.204 替 isForked）', () => {
  it('runKind=main → true', () => {
    const k = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });
    expect(k.isMainRun).toBe(true);
  });
  it('runKind=summary → false', () => {
    const k = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'summary' });
    expect(k.isMainRun).toBe(false);
  });
  it('runKind=consolidate → false', () => {
    const k = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'consolidate' });
    expect(k.isMainRun).toBe(false);
  });
});

describe('SessionKind getter — isStudio/isSubagent', () => {
  it('studio + parent', () => {
    const k = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'parent' });
    expect(k.isStudio).toBe(true);
    expect(k.isSubagent).toBe(false);
  });
  it('playground + subagent', () => {
    const k = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'subagent' });
    expect(k.isStudio).toBe(false);
    expect(k.isSubagent).toBe(true);
  });
});

describe('SessionKind.canonicalId（4 段纯拼接）', () => {
  it('playground-rocky:parent:main', () => {
    expect(new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' }).canonicalId())
      .toBe('playground-rocky:parent:main');
  });
  it('studio-squad:parent:main', () => {
    expect(new SessionKind({ biz: 'studio', role: 'squad', derivation: 'parent' }).canonicalId())
      .toBe('studio-squad:parent:main');
  });
  it('studio-leader:subagent:main', () => {
    const k = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'subagent' });
    expect(k.canonicalId()).toBe('studio-leader:subagent:main');
  });
});

describe('validateSessionKind — K1/K3/K4/K5', () => {
  it('K1: role=leader 但 biz=playground → throw', () => {
    expect(() => validateSessionKind({ biz: 'playground', role: 'leader', derivation: 'parent' }))
      .toThrow(SessionKindValidationError);
    expect(() => validateSessionKind({ biz: 'playground', role: 'leader', derivation: 'parent' }))
      .toThrow(/biz='studio'/);
  });
  it('K1: role=squad 但 biz=playground → throw', () => {
    expect(() => validateSessionKind({ biz: 'playground', role: 'squad', derivation: 'parent' }))
      .toThrow(SessionKindValidationError);
  });
  it('K3: role=rocky 但 biz=studio → throw', () => {
    expect(() => validateSessionKind({ biz: 'studio', role: 'rocky', derivation: 'parent' }))
      .toThrow(/biz='playground'/);
  });
  // [v0.0.210] K4: academy 三角色 ⇒ biz='academy'
  it('K4: role=head_teacher 但 biz=playground → throw', () => {
    expect(() => validateSessionKind({ biz: 'playground', role: 'head_teacher', derivation: 'parent' }))
      .toThrow(/biz='academy'/);
  });
  it('K4: role=coach 但 biz=studio → throw', () => {
    expect(() => validateSessionKind({ biz: 'studio', role: 'coach', derivation: 'parent' }))
      .toThrow(/biz='academy'/);
  });
  it('K4: role=student 但 biz=playground → throw', () => {
    expect(() => validateSessionKind({ biz: 'playground', role: 'student', derivation: 'parent' }))
      .toThrow(/biz='academy'/);
  });
  it('K5: runKind 非法字符串 → throw（闭合枚举校验）', () => {
    expect(() => validateSessionKind({
      biz: 'playground', role: 'rocky', derivation: 'parent',
      runKind: 'invalid' as 'main',
    })).toThrow(/main, summary, consolidate/);
  });
  it('K5 合法: runKind=consolidate → 不抛', () => {
    expect(() => validateSessionKind({
      biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'consolidate',
    })).not.toThrow();
  });
  it('合法组合 playground parent main → 不抛', () => {
    expect(() => validateSessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' }))
      .not.toThrow();
  });
  it('合法组合 studio leader parent main → 不抛', () => {
    expect(() => validateSessionKind({ biz: 'studio', role: 'leader', derivation: 'parent' }))
      .not.toThrow();
  });
  // [v0.0.210] 合法 academy 组合
  it('合法组合 academy head_teacher parent main → 不抛', () => {
    expect(() => validateSessionKind({ biz: 'academy', role: 'head_teacher', derivation: 'parent' }))
      .not.toThrow();
  });
  it('合法组合 academy coach parent main → 不抛', () => {
    expect(() => validateSessionKind({ biz: 'academy', role: 'coach', derivation: 'parent' }))
      .not.toThrow();
  });
  it('合法组合 academy student parent main → 不抛', () => {
    expect(() => validateSessionKind({ biz: 'academy', role: 'student', derivation: 'parent' }))
      .not.toThrow();
  });
});

describe('validateSessionContext — C1-C6', () => {
  it('C1: derivation=subagent 无 parentSessionId → throw', () => {
    expect(() => validateSessionContext(
      { biz: 'playground', role: 'rocky', derivation: 'subagent' },
      {},
    )).toThrow(/parentSessionId/);
  });
  it('C1 合法: subagent + parentSessionId → 不抛', () => {
    expect(() => validateSessionContext(
      { biz: 'playground', role: 'rocky', derivation: 'subagent' },
      { parentSessionId: 'p' },
    )).not.toThrow();
  });
  it('C2: studio parent 无 squadId → throw', () => {
    expect(() => validateSessionContext(
      { biz: 'studio', role: 'squad', derivation: 'parent' },
      {},
    )).toThrow(/squadId/);
  });
  it('C3: role=leader parent 无 memberId → throw', () => {
    expect(() => validateSessionContext(
      { biz: 'studio', role: 'leader', derivation: 'parent' },
      { squadId: 's' },
    )).toThrow(/memberId/);
  });
  it('合法组合 studio leader parent → 不抛', () => {
    const ctx: SessionContext = { squadId: 's', memberId: 'm' };
    expect(() => validateSessionContext(
      { biz: 'studio', role: 'leader', derivation: 'parent' }, ctx,
    )).not.toThrow();
  });
  // [v0.0.210] C4-C6 academy 校验
  it('C4: academy parent 无 classroomId → throw', () => {
    expect(() => validateSessionContext(
      { biz: 'academy', role: 'head_teacher', derivation: 'parent' },
      {},
    )).toThrow(/classroomId/);
  });
  it('C4 合法: head_teacher parent + classroomId → 不抛', () => {
    expect(() => validateSessionContext(
      { biz: 'academy', role: 'head_teacher', derivation: 'parent' },
      { classroomId: 'c1' },
    )).not.toThrow();
  });
  it('C5: coach parent 无 trainingTaskId → throw', () => {
    expect(() => validateSessionContext(
      { biz: 'academy', role: 'coach', derivation: 'parent' },
      { classroomId: 'c1' },
    )).toThrow(/trainingTaskId/);
  });
  it('C5 合法: coach parent + classroomId + trainingTaskId → 不抛', () => {
    expect(() => validateSessionContext(
      { biz: 'academy', role: 'coach', derivation: 'parent' },
      { classroomId: 'c1', trainingTaskId: 't1' },
    )).not.toThrow();
  });
  it('C6: student parent 无 studentId → throw', () => {
    expect(() => validateSessionContext(
      { biz: 'academy', role: 'student', derivation: 'parent' },
      { classroomId: 'c1' },
    )).toThrow(/studentId/);
  });
  it('C6: student parent 有 studentId 但无 versionId → throw', () => {
    expect(() => validateSessionContext(
      { biz: 'academy', role: 'student', derivation: 'parent' },
      { classroomId: 'c1', studentId: 's1' },
    )).toThrow(/versionId/);
  });
  it('C6 合法: student parent + classroomId + studentId + versionId → 不抛', () => {
    expect(() => validateSessionContext(
      { biz: 'academy', role: 'student', derivation: 'parent' },
      { classroomId: 'c1', studentId: 's1', versionId: 'v1' },
    )).not.toThrow();
  });
});

describe('isStudioMainSession helper（v0.0.204 derivation parent 改名）', () => {
  it('studio + parent + leader → true', () => {
    const k = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'parent' });
    expect(isStudioMainSession(k)).toBe(true);
  });
  it('studio + parent + rocky → false（rocky 非 studio 角色）', () => {
    const k = new SessionKind({ biz: 'studio', role: 'rocky', derivation: 'parent' });
    expect(isStudioMainSession(k)).toBe(false);
  });
  it('playground + parent + rocky → false（playground 不误命中）', () => {
    const k = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });
    expect(isStudioMainSession(k)).toBe(false);
  });
  it('studio subagent → false', () => {
    const k = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'subagent' });
    expect(isStudioMainSession(k)).toBe(false);
  });
});
