/**
 * template-loader resolveEffective 单测（spawn 解析 + derivation gate）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（spawn 契约）
 *
 * 覆盖：
 *   - derivation gate：input.derivation='parent' 一律强制 'subagent'
 *     （防 LLM 直填 parent 造 detached 顶级 session；spawn 只产派生子 agent）
 *   - 常规解析：缺省 'subagent' / role = input.role 透传 / D8 modelId inherit
 */
import { describe, it, expect } from 'vitest';
import { resolveEffective, type LoadTemplateFn } from '../template-loader';
import type { SpawnAgentInput, SubAgentTemplate } from '../types';

/** 构造最小合法 spawn input（inline systemPrompt + sync task） */
function makeInput(overrides: Partial<SpawnAgentInput>): SpawnAgentInput {
  return {
    systemPrompt: 'sp',
    task: { content: [{ type: 'text', text: 'do it' }] },
    mode: 'async',
    ...overrides,
  } as SpawnAgentInput;
}

/** 构造模板 stub（只填本测试关心的字段） */
function makeTemplate(overrides: Partial<SubAgentTemplate>): SubAgentTemplate {
  return {
    name: 'tpl',
    systemPrompt: 'tpl-sp',
    ...overrides,
  } as SubAgentTemplate;
}

const loaderOf = (tpl: SubAgentTemplate | null): LoadTemplateFn => async () => tpl;

describe('resolveEffective — derivation gate（input.derivation=parent 防 LLM 造顶级 session）', () => {
  it('template + input.derivation=parent → 强制 subagent', async () => {
    const tpl = makeTemplate({ name: 'explorer' });
    const eff = await resolveEffective(
      makeInput({ templateRef: 'explorer', derivation: 'parent' }),
      'parent-model',
      loaderOf(tpl),
    );
    expect(eff.derivation).toBe('subagent');
  });

  it('无 template（纯 inline）+ input.derivation=parent → 强制 subagent', async () => {
    const eff = await resolveEffective(
      makeInput({ derivation: 'parent' }),
      'parent-model',
    );
    expect(eff.derivation).toBe('subagent');
  });

  it('普通 template + input 未传 derivation → 缺省 subagent', async () => {
    const tpl = makeTemplate({ name: 'explorer' });
    const eff = await resolveEffective(
      makeInput({ templateRef: 'explorer' }),
      'parent-model',
      loaderOf(tpl),
    );
    expect(eff.derivation).toBe('subagent');
  });

  it('input.derivation=subagent（显式派生请求安全）→ subagent', async () => {
    const tpl = makeTemplate({ name: 'explorer' });
    const eff = await resolveEffective(
      makeInput({ templateRef: 'explorer', derivation: 'subagent' }),
      'parent-model',
      loaderOf(tpl),
    );
    expect(eff.derivation).toBe('subagent');
  });
});

describe('resolveEffective — 常规字段解析', () => {
  it('role bloodline：input 未指定 → role undefined（caller 按 parent.role 回退）', async () => {
    const eff = await resolveEffective(makeInput({}), 'parent-model');
    expect(eff.role).toBeUndefined();
    expect(eff.modelId).toBe('parent-model'); // D8：无模板 inherit parent
  });

  it('input.role 显式指定 → 透传', async () => {
    const eff = await resolveEffective(makeInput({ role: 'leader' }), 'parent-model');
    expect(eff.role).toBe('leader');
  });

  it('templateRef 找不到模板 → 抛错', async () => {
    await expect(
      resolveEffective(makeInput({ templateRef: 'ghost' }), 'parent-model'),
    ).rejects.toThrow(/template not found: ghost/);
  });
});
