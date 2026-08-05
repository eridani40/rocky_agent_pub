/**
 * biz-scope-rules 单测（v0.0.238 新建）
 * 参考: specs/tech/version_logs/v0.0.238/change_plan.md 模块 A（6 符号）+ 架构决策 O4/O5
 *       specs/prd/overall/14-prompt-quality-governance.md §14.2.3（可用表 + 必填）
 *
 * 覆盖验收（acceptanceCriteria 3）：
 *   - 6 符号全导出
 *   - resolveBizScopeKind：三 biz 直通 + kind 缺失/未知兜底 playground（不抛错）
 *   - renderScopeTableForPrompt：三 biz 三段齐全（可用层 + 三层语义 + 必填规则）
 *   - scopeRequiredErrorText / scopeUnavailableErrorText 文案含可用层
 */
import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_SCOPES_BY_BIZ,
  resolveBizScopeKind,
  renderScopeTableForPrompt,
  scopeRequiredErrorText,
  scopeUnavailableErrorText,
  type BizScopeKind,
} from '../biz-scope-rules';

describe('biz-scope-rules — AVAILABLE_SCOPES_BY_BIZ', () => {
  it('三 biz 可用层与 PRD D7 一致', () => {
    expect(AVAILABLE_SCOPES_BY_BIZ.playground).toEqual(['session', 'global']);
    expect(AVAILABLE_SCOPES_BY_BIZ.studio).toEqual(['group', 'global']);
    expect(AVAILABLE_SCOPES_BY_BIZ.academy).toEqual(['session', 'group', 'global']);
  });
});

describe('biz-scope-rules.resolveBizScopeKind — biz 解析', () => {
  it('三 biz 直通', () => {
    expect(resolveBizScopeKind({ kind: { biz: 'playground' } })).toBe('playground');
    expect(resolveBizScopeKind({ kind: { biz: 'studio' } })).toBe('studio');
    expect(resolveBizScopeKind({ kind: { biz: 'academy' } })).toBe('academy');
  });

  it('kind 缺失 → playground（tier2 run 无 kind 兜底）', () => {
    expect(resolveBizScopeKind({})).toBe('playground');
    expect(resolveBizScopeKind({ kind: undefined })).toBe('playground');
    expect(resolveBizScopeKind({ kind: null })).toBe('playground');
  });

  it('kind.biz 未知值 → playground（容错不抛错）', () => {
    expect(resolveBizScopeKind({ kind: { biz: 'unknown' } })).toBe('playground');
    expect(resolveBizScopeKind({ kind: { biz: '' } })).toBe('playground');
    expect(resolveBizScopeKind({ kind: { biz: undefined } })).toBe('playground');
  });

  it('MUST NOT 抛错（容忍各种非法入参）', () => {
    expect(() => resolveBizScopeKind(null)).not.toThrow();
    expect(() => resolveBizScopeKind(undefined)).not.toThrow();
    expect(() => resolveBizScopeKind('string')).not.toThrow();
    expect(resolveBizScopeKind(null)).toBe('playground');
    expect(resolveBizScopeKind(undefined)).toBe('playground');
  });
});

describe('biz-scope-rules.renderScopeTableForPrompt — 三段齐全', () => {
  const assertThreeSegments = (biz: BizScopeKind) => {
    const out = renderScopeTableForPrompt(biz);
    // 段 ① 本 biz 可用层（含配额 20/30/50）
    expect(out).toContain('可用 scope 层');
    for (const s of AVAILABLE_SCOPES_BY_BIZ[biz]) {
      expect(out).toContain(s);
    }
    // 段 ② 三层语义
    expect(out).toContain('session = 仅本会话');
    expect(out).toContain('group = 本团队共享');
    expect(out).toContain('global = 跨项目全局');
    // 段 ③ 必填规则
    expect(out).toContain('必填');
    return out;
  };

  it('playground：三段齐全（可用层 session/global，不含 group）', () => {
    const out = assertThreeSegments('playground');
    expect(out).toContain('配额 20');
    expect(out).toContain('配额 50');
  });

  it('studio：三段齐全（可用层 group/global，不含 session）', () => {
    const out = assertThreeSegments('studio');
    expect(out).toContain('配额 30');
    expect(out).toContain('配额 50');
  });

  it('academy：三段齐全（三层全开）', () => {
    const out = assertThreeSegments('academy');
    expect(out).toContain('配额 20');
    expect(out).toContain('配额 30');
    expect(out).toContain('配额 50');
  });
});

describe('biz-scope-rules — 错误文案函数', () => {
  it('scopeRequiredErrorText 含 biz 可用层 + 示例', () => {
    const pg = scopeRequiredErrorText('playground');
    expect(pg).toContain('required');
    expect(pg).toContain('session');
    expect(pg).toContain('global');
    expect(pg).toContain('playground');
    expect(pg).toMatch(/Example.*scope/);

    const studio = scopeRequiredErrorText('studio');
    expect(studio).toContain('group');
    expect(studio).toContain('global');
    expect(studio).not.toContain('session（');
  });

  it('scopeUnavailableErrorText 含非法值 + biz 可用层 + 引导', () => {
    const msg = scopeUnavailableErrorText('studio', 'session');
    expect(msg).toContain('"session"');
    expect(msg).toContain('studio');
    expect(msg).toContain('group');
    expect(msg).toContain('global');
    expect(msg).toMatch(/Choose one of/);
  });
});
