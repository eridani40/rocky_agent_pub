/**
 * ConsolidationTier2PromptHandler 单测（白盒 vitest）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §5.1 §6
 *
 * 覆盖：build() 占位符替换（含 session 语境全传 / 全局语境缺省兜底文案）；
 *       parseResult() 从 <result> 标签解析 action/detail，含容错（缺标签/缺字段）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __clearPromptCacheForTests } from '../prompt-handler';
import { ConsolidationTier2PromptHandler } from '../handlers/consolidation-tier2-handler';
import { ROUTING_DECISION_PROMPT } from '../routing-decision';

describe('ConsolidationTier2PromptHandler.build', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('全局块（无 session_memory_full/session_summary）→ 占位符全部替换，session 相关走兜底文案', () => {
    const c = new ConsolidationTier2PromptHandler()
      .build({
        vars: {
          domain: 'skill',
          entries_list: '- foo | evolvable=true | updated=2026-01-01\n  a skill',
          capacity_limit: '3 / 100',
        },
      })
      .content;
    expect(c).not.toContain('{{domain}}');
    expect(c).not.toContain('{{entries_list}}');
    expect(c).not.toContain('{{capacity_limit}}');
    expect(c).not.toContain('{{session_memory_full}}');
    expect(c).not.toContain('{{session_summary}}');
    expect(c).toContain('skill');
    expect(c).toContain('3 / 100');
    expect(c).toContain('not applicable — this is a global-scope pass');
    // 4 阶段 + Output 契约齐全
    expect(c).toContain('Phase 1');
    expect(c).toContain('Phase 4');
    expect(c).toContain('<result>');
  });

  it('单 session 块（全传）→ session_memory_full/session_summary 用实际值而非兜底文案', () => {
    const c = new ConsolidationTier2PromptHandler()
      .build({
        vars: {
          domain: 'memory',
          entries_list: '- bar | evolvable=true | updated=2026-01-01\n  a memory',
          capacity_limit: '5 / 30',
          session_memory_full: '## bar\nfull body text',
          session_summary: 'this session discussed X',
        },
      })
      .content;
    expect(c).toContain('full body text');
    expect(c).toContain('this session discussed X');
    expect(c).not.toContain('not applicable');
  });

  it('未传 vars（build({})）→ 不抛错，占位符全替空/兜底', () => {
    const c = new ConsolidationTier2PromptHandler().build({}).content;
    expect(c).not.toContain('{{domain}}');
    expect(c).toContain('not applicable — this is a global-scope pass');
  });

  it('[v0.0.164] Phase 2.5 质量审查段：{{routing_rules}} 替换为 ROUTING_DECISION_PROMPT 全文（判据单一源）', () => {
    const c = new ConsolidationTier2PromptHandler()
      .build({
        vars: {
          domain: 'memory',
          entries_list: '- foo | evolvable=true | updated=2026-01-01\n  a memory',
          capacity_limit: '5 / 30',
        },
      })
      .content;
    // 装配后含 Phase 2.5 段（Phase 3 前）
    expect(c).toContain('Phase 2.5 — Quality review');
    // 3 类质量问题分类
    expect(c).toContain('process-snapshot');
    expect(c).toContain('scope-picked-wrong');
    expect(c).toContain('superseded-by-newer');
    // 判据引 routing_rules 占位符已被 ROUTING_DECISION_PROMPT 全文替换（同源，无残留占位符）
    expect(c).not.toContain('{{routing_rules}}');
    expect(c).toContain(ROUTING_DECISION_PROMPT);
    // Phase 2.5 明确 evolvable=false 依旧 read-only（保 v0.0.151 铁律）
    expect(c).toMatch(/evolvable=false[\s\S]{0,80}read-only/i);
  });

  it('[v0.0.164] Output 契约加可选 quality_archived action 值', () => {
    const c = new ConsolidationTier2PromptHandler().build({}).content;
    // action 枚举含 quality_archived（parseResult 兜底 processed，识别更多值即可）
    expect(c).toMatch(/action:\s*merged\s*\|\s*archived\s*\|\s*quality_archived/);
  });

  it('[v0.0.164] Phase 1/2/3/4 骨架保留（parseResult 依赖 <result> 标签位置）', () => {
    const c = new ConsolidationTier2PromptHandler().build({}).content;
    expect(c).toContain('Phase 1');
    // Phase 2 保留原样（不与 Phase 2.5 撞名）
    expect(c).toMatch(/\[Phase 2 — Gather/);
    expect(c).toContain('Phase 3');
    expect(c).toContain('Phase 4');
    expect(c).toContain('<result>');
    expect(c).toContain('</result>');
    // Phase 2.5 出现在 Phase 3 之前
    const p25 = c.indexOf('Phase 2.5');
    const p3 = c.indexOf('Phase 3');
    expect(p25).toBeGreaterThan(0);
    expect(p3).toBeGreaterThan(p25);
  });
});

describe('ConsolidationTier2PromptHandler.parseResult', () => {
  it('标准 <result> 标签 → 正确解析 action + detail', () => {
    const answer = [
      'I merged two duplicate entries.',
      '<result>',
      'action: merged',
      'detail: merged two entries about deployment steps',
      '</result>',
    ].join('\n');
    const r = ConsolidationTier2PromptHandler.parseResult(answer);
    expect(r.action).toBe('merged');
    expect(r.detail).toBe('merged two entries about deployment steps');
  });

  it('detail 跨多行 → 取标签内 detail: 之后全部内容', () => {
    const answer = '<result>\naction: archived\ndetail: line one\nline two\n</result>';
    const r = ConsolidationTier2PromptHandler.parseResult(answer);
    expect(r.action).toBe('archived');
    expect(r.detail).toContain('line one');
    expect(r.detail).toContain('line two');
  });

  it('缺 <result> 标签 → action 兜底 processed，detail 取全文截断', () => {
    const answer = 'nothing worth consolidating today, no tools called.';
    const r = ConsolidationTier2PromptHandler.parseResult(answer);
    expect(r.action).toBe('processed');
    expect(r.detail).toContain('nothing worth consolidating');
  });

  it('标签内缺 action/detail 字段 → 各自兜底', () => {
    const answer = '<result>\nsomething else entirely\n</result>';
    const r = ConsolidationTier2PromptHandler.parseResult(answer);
    expect(r.action).toBe('processed');
    expect(r.detail).toContain('something else entirely');
  });
});
