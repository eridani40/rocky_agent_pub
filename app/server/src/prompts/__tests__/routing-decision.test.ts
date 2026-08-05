/**
 * ROUTING_DECISION_PROMPT 单一常量 + consolidation fork prompt 渲染 单测（v0.0.238 重写 Step 2）
 * 参考: specs/tech/agent/memory/[P0]memory_manage_tool.md §5.2（路由提示词单一源）
 *       specs/tech/agent/memory/[P0]consolidation_tier1.md §6（fork prompt {{routing_rules}} 占位符）
 *       change_plan v0.0.238 O5（Step 2 重写：必填无默认 + 全 biz 静态可用表）
 *
 * 覆盖：
 *   - ROUTING_DECISION_PROMPT 是单一非空常量，含两步决策要素（skill/memory/都不写 + scope 必填无默认）
 *   - ConsolidationHandler.build 渲染 {{routing_rules}} + {{scope_table}} + {{agents_paths}}（v0.0.238 新占位符）
 *   - consolidation.md 不再手写旧路由词汇；fork-override「默认翻 session」段已删（v0.0.238）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ROUTING_DECISION_PROMPT } from '../routing-decision';
import { ConsolidationHandler } from '../handlers/consolidation-handler';
import { __clearPromptCacheForTests } from '../prompt-handler';

describe('[v0.0.164] ROUTING_DECISION_PROMPT 产出契约', () => {
  it('产出无尾随换行（trimEnd 保拼接语义与 v0.0.153 一致）', () => {
    expect(ROUTING_DECISION_PROMPT.endsWith('\n')).toBe(false);
  });

  it('保持 Step 1 / Step 2 骨架（三处消费方靠结构定位）', () => {
    expect(ROUTING_DECISION_PROMPT).toContain('Step 1 — Decide what');
    expect(ROUTING_DECISION_PROMPT).toContain('Step 2 — Decide the scope');
    expect(ROUTING_DECISION_PROMPT).toContain('Two-step routing decision:');
  });
});

describe('ROUTING_DECISION_PROMPT 常量', () => {
  it('单一非空常量，含两步决策要素', () => {
    expect(typeof ROUTING_DECISION_PROMPT).toBe('string');
    expect(ROUTING_DECISION_PROMPT.length).toBeGreaterThan(50);
    // 第一步：skill / memory / 都不写（specs/code）
    expect(ROUTING_DECISION_PROMPT).toMatch(/skill/i);
    expect(ROUTING_DECISION_PROMPT).toMatch(/memory/i);
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('step 1');
    // 第二步：scope 必填 + global/session/group
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('step 2');
    expect(ROUTING_DECISION_PROMPT).toMatch(/global/i);
    expect(ROUTING_DECISION_PROMPT).toMatch(/session/i);
    expect(ROUTING_DECISION_PROMPT).toMatch(/group/i);
  });
});

describe('[v0.0.164] ROUTING_DECISION_PROMPT 强化条目', () => {
  it('Step 1 含 5 类反例清单（progress / current state / one-time / emotion / short-term context）', () => {
    expect(ROUTING_DECISION_PROMPT).toMatch(/Do NOT write/i);
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('progress snapshot');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('current state');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('one-time');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('emotional');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('short-term context');
  });

  it('Step 1 含 project type 澄清（rules/constraints，不是进展快照/里程碑）', () => {
    expect(ROUTING_DECISION_PROMPT).toMatch(/`project` type/);
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('rules or constraints');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('long-term');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).toContain('not progress snapshots');
  });

  it('[v0.0.238] Step 2 scope 必填无默认 + 三层语义 + biz 可用表三行', () => {
    const step2Idx = ROUTING_DECISION_PROMPT.indexOf('Step 2');
    expect(step2Idx).toBeGreaterThan(0);
    const step2Body = ROUTING_DECISION_PROMPT.slice(step2Idx);
    // 三层语义（**session** / **group** / **global**）
    expect(step2Body).toMatch(/\*\*session\*\*/);
    expect(step2Body).toMatch(/\*\*group\*\*/);
    expect(step2Body).toMatch(/\*\*global\*\*/);
    // 必填无默认（不再有 "default to global"）
    expect(step2Body.toLowerCase()).toContain('required');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).not.toContain('default to **global**');
    // 全 biz 静态可用表三行（数据以 AVAILABLE_SCOPES_BY_BIZ 为准）
    expect(step2Body.toLowerCase()).toContain('playground');
    expect(step2Body.toLowerCase()).toContain('studio');
    expect(step2Body.toLowerCase()).toContain('academy');
    // 拒绝引导：不传/传错被拒
    expect(step2Body.toLowerCase()).toMatch(/rejected|invalid_input/);
  });
});

describe('ConsolidationHandler 渲染占位符（v0.0.238 三占位符）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('build 注入 ROUTING_DECISION_PROMPT（同源）+ agents_paths/scope_table 默认空串降级，无残留占位符', () => {
    const { content } = new ConsolidationHandler().build();
    // routing_rules 占位符已替换为单一常量全文（不变量#6：同源）
    expect(content).toContain(ROUTING_DECISION_PROMPT);
    expect(content).not.toContain('{{routing_rules}}');
    // v0.0.238 新占位符缺省替空串（纯 directive，旁路不变量不破）
    expect(content).not.toContain('{{agents_paths}}');
    expect(content).not.toContain('{{scope_table}}');
    // 纯 directive：无 serialized_transcript 占位（对话历史由 snapshot 唯一承载）
    expect(content).not.toContain('{{serialized_transcript}}');
  });

  it('build(ctx) 读 vars 填 agents_paths / scope_table（静态配置，旁路不变量保持）', () => {
    const { content } = new ConsolidationHandler().build({
      vars: { agents_paths: 'AGENTS_LINE_MARK', scope_table: 'SCOPE_TABLE_MARK' },
    });
    expect(content).toContain('AGENTS_LINE_MARK');
    expect(content).toContain('SCOPE_TABLE_MARK');
    expect(content).toContain(ROUTING_DECISION_PROMPT);
  });

  it('不再手写旧路由词汇（user_memory/session_memory 旧 scope）', () => {
    const { content } = new ConsolidationHandler().build();
    expect(content).not.toContain('user_memory');
    expect(content).not.toContain('session_memory');
    expect(content).toContain(ROUTING_DECISION_PROMPT);
  });

  it('[v0.0.238] fork-override「默认翻 session」段已删（被 scope 必填取代）', () => {
    const { content } = new ConsolidationHandler().build();
    expect(content).not.toContain('Fork-override for this consolidation pass');
    expect(content).not.toContain('default to **session**');
    // 共享常量仍不含 default to session（旧默认 global 也已删）
    expect(ROUTING_DECISION_PROMPT).not.toContain('default to **session**');
    expect(ROUTING_DECISION_PROMPT.toLowerCase()).not.toContain('default to **global**');
  });
});
