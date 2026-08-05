/**
 * resolveMentionProviders 单元测试（v0.0.68 D8）
 * 参考: specs/tech/mention/resolver.md §3 PROVIDER_MATRIX 6 行 + default 兜底
 *       app/shared/src/mention-resolver.ts（被测文件）
 *
 * 锁定契约：
 *   - 6 个矩阵 key 各返回对应 provider 集合（顺序稳定 = popover tab 排列）
 *   - 不在矩阵内的 kind → default 兜底 [file, skill]
 *   - 返回副本（caller mutate 不污染内部矩阵）
 *   - studio/squad/parent 含 member，其余 studio main 单聊（leader/mate）不含 member
 */
import { describe, it, expect } from 'vitest';
import { resolveMentionProviders } from '../src/mention-resolver';
import type { ResolverSessionKind } from '../src/mention-resolver';

describe('resolveMentionProviders — PROVIDER_MATRIX 6 行', () => {
  it('playground/rocky/parent → [file, skill]', () => {
    const kind: ResolverSessionKind = { biz: 'playground', role: 'rocky', derivation: 'parent' };
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill']);
  });

  it('playground/subagent/subagent → [file, skill]', () => {
    const kind: ResolverSessionKind = {
      biz: 'playground',
      role: 'rocky',
      derivation: 'subagent',
    };
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill']);
  });

  it('studio/squad/parent → [file, skill, workitem, member]（唯一含 member）', () => {
    const kind: ResolverSessionKind = { biz: 'studio', role: 'squad', derivation: 'parent' };
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill', 'workitem', 'member']);
  });

  it('studio/leader/parent → [file, skill, workitem]（无 member）', () => {
    const kind: ResolverSessionKind = { biz: 'studio', role: 'leader', derivation: 'parent' };
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill', 'workitem']);
  });

  it('studio/mate/parent → [file, skill, workitem]（无 member）', () => {
    const kind: ResolverSessionKind = { biz: 'studio', role: 'mate', derivation: 'parent' };
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill', 'workitem']);
  });

  it('studio/subagent/subagent → [file, skill]', () => {
    const kind: ResolverSessionKind = {
      biz: 'studio',
      role: 'squad',
      derivation: 'subagent',
    };
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill']);
  });
});

describe('resolveMentionProviders — default 兜底', () => {
  it('未在矩阵内的 biz → default [file, skill]', () => {
    // biz 枚举只有 'playground' | 'studio'，构造非法值断言兜底（cast 绕类型）
    const kind = { biz: 'unknown', role: 'rocky', derivation: 'parent' } as unknown as ResolverSessionKind;
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill']);
  });

  it('未在矩阵内的 role 组合 → default [file, skill]', () => {
    // studio + rocky（rocky 是 playground 专用 role）→ 不在矩阵 → default 兜底
    const kind = { biz: 'studio', role: 'rocky', derivation: 'parent' } as ResolverSessionKind;
    expect(resolveMentionProviders(kind)).toEqual(['file', 'skill']);
  });
});

describe('resolveMentionProviders — 纯函数契约', () => {
  it('返回副本：caller mutate 不污染后续调用', () => {
    const kind: ResolverSessionKind = { biz: 'studio', role: 'squad', derivation: 'parent' };
    const r1 = resolveMentionProviders(kind);
    r1.push('workitem' as never); // mutate 返回值
    const r2 = resolveMentionProviders(kind);
    expect(r2).toEqual(['file', 'skill', 'workitem', 'member']);
  });
});
