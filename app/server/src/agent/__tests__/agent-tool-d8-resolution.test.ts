/**
 * D8 model 解析三用法 UT（v0.0.28 task-2）
 * 参考: specs/tech/multi_agent/[P1]subagent_templates.md §4（D8 resolution 规则）
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §4（eff.modelId = template?.modelId ?? parent.modelId）
 *       states/v0.0.28/task.json tasks[1] acceptance「D8 model 解析三用法精确」
 *
 * 覆盖三用法（subagent_templates §4）：
 *   ① 纯模板（templateRef only）→ eff.modelId = template.modelId
 *   ② 纯 inline（systemPrompt+tools 无 templateRef）→ eff.modelId = parent.modelId（inherit）
 *   ③ 模板+覆盖（templateRef + 覆盖 systemPrompt/tools/skills）→ eff.modelId 仍 = template.modelId
 *     （modelId 不在 spawn 入参，无法覆盖模板 modelId）
 *   - 无模板且无 inline systemPrompt → error
 *   - templateRef 找不到模板 → error
 *
 * 白盒：直接测 resolveEffective 纯函数（template-loader.ts）。
 */
import { describe, it, expect } from 'vitest';
import { resolveEffective, defaultLoadTemplate } from '../tools/template-loader';
import type { SubAgentTemplate, SpawnAgentInput } from '../tools/types';
import type { LoadTemplateFn } from '../tools/template-loader';

const PARENT_MODEL = 'parent-model-001';
const TEMPLATE_MODEL = 'explorer-model-002';

/** explorer 模板（带 modelId，builtin） */
const explorerTemplate: SubAgentTemplate = {
  name: 'explorer',
  description: '只读探索',
  systemPrompt: '你是 explorer 子 agent，只读探索',
  tools: ['read', 'web_search', 'web_fetch', 'send_message'],
  skills: [],
  modelId: TEMPLATE_MODEL,
  builtin: true,
};

/** explorer 模板（modelId=null inherit parent） */
const explorerInheritTemplate: SubAgentTemplate = {
  ...explorerTemplate,
  modelId: null,
};

const loadExplorer: LoadTemplateFn = async (name) =>
  name === 'explorer' ? explorerTemplate : null;
const loadInherit: LoadTemplateFn = async (name) =>
  name === 'explorer' ? explorerInheritTemplate : null;

describe('D8 model 解析三用法', () => {
  it('① 纯模板（templateRef only）→ eff.modelId = template.modelId', async () => {
    const input: SpawnAgentInput = {
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查 X' }] },
      mode: 'sync',
    };
    const eff = await resolveEffective(input, PARENT_MODEL, loadExplorer);
    expect(eff.modelId).toBe(TEMPLATE_MODEL);
    expect(eff.subAgentTemplateType).toBe('explorer');
    expect(eff.systemPrompt).toBe(explorerTemplate.systemPrompt);
    expect(eff.tools).toEqual(explorerTemplate.tools);
  });

  it('② 纯 inline（systemPrompt+tools 无 templateRef）→ eff.modelId = parent.modelId（inherit）', async () => {
    const input: SpawnAgentInput = {
      systemPrompt: '你是自定义子 agent',
      tools: ['read', 'bash'],
      task: { content: [{ type: 'text', text: '做 Y' }] },
      mode: 'async',
    };
    const eff = await resolveEffective(input, PARENT_MODEL, loadExplorer);
    expect(eff.modelId).toBe(PARENT_MODEL); // ★ inherit parent
    expect(eff.subAgentTemplateType).toBeNull(); // inline spawn 无 templateRef
    expect(eff.systemPrompt).toBe('你是自定义子 agent');
    expect(eff.tools).toEqual(['read', 'bash']);
  });

  it('③ 模板+覆盖（templateRef + 覆盖 systemPrompt/tools/skills）→ eff.modelId 仍 = template.modelId', async () => {
    const input: SpawnAgentInput = {
      templateRef: 'explorer',
      systemPrompt: '覆盖 explorer 的人设',
      tools: ['read'], // 覆盖工具白名单
      skills: ['custom-skill'],
      task: { content: [{ type: 'text', text: '探查 Z' }] },
      mode: 'sync',
    };
    const eff = await resolveEffective(input, PARENT_MODEL, loadExplorer);
    expect(eff.modelId).toBe(TEMPLATE_MODEL); // ★ 仍 = template.modelId（spawn 入参无 modelId，无法覆盖）
    expect(eff.subAgentTemplateType).toBe('explorer');
    expect(eff.systemPrompt).toBe('覆盖 explorer 的人设'); // systemPrompt 覆盖生效
    expect(eff.tools).toEqual(['read']); // tools 覆盖生效
    expect(eff.skills).toEqual(['custom-skill']); // skills 覆盖生效
  });

  it('模板 modelId=null → eff.modelId = parent.modelId（模板不指定 = inherit parent）', async () => {
    const input: SpawnAgentInput = {
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查' }] },
      mode: 'sync',
    };
    const eff = await resolveEffective(input, PARENT_MODEL, loadInherit);
    expect(eff.modelId).toBe(PARENT_MODEL); // 模板 modelId=null → inherit parent
  });
});

describe('resolveEffective 错误分支', () => {
  it('无模板且无 inline systemPrompt → error', async () => {
    const input = {
      task: { content: [{ type: 'text', text: '任务' }] },
      mode: 'sync',
    } as SpawnAgentInput;
    await expect(resolveEffective(input, PARENT_MODEL, defaultLoadTemplate))
      .rejects.toThrow(/systemPrompt required/);
  });

  it('templateRef 找不到模板 → error', async () => {
    const input: SpawnAgentInput = {
      templateRef: 'nonexistent',
      task: { content: [{ type: 'text', text: '任务' }] },
      mode: 'sync',
    };
    await expect(resolveEffective(input, PARENT_MODEL, defaultLoadTemplate))
      .rejects.toThrow(/template not found: nonexistent/);
  });
});
