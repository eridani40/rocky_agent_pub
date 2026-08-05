/**
 * loadTemplate —— sub-agent 模板加载 + D8 resolution 规则
 * 参考: specs/tech/multi_agent/[P1]subagent_templates.md §4（resolution 规则 — D8 修订）
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §4（eff = resolve(input, template)）
 *
 * D8 resolution（subagent_templates §4）：
 *   eff.systemPrompt = input.systemPrompt ?? template?.systemPrompt  // 无模板且无 inline → error
 *   eff.tools        = input.tools        ?? template?.tools
 *   eff.skills       = input.skills       ?? template?.skills
 *   eff.modelId      = template?.modelId ?? parent.modelId  // ★ spawn 入参无 modelId，不可覆盖模板 modelId
 *
 * 三种用法：
 *   ① 纯模板（templateRef only）→ eff.modelId = template.modelId
 *   ② 纯 inline（systemPrompt+tools 无 templateRef）→ eff.modelId = parent.modelId（inherit）
 *   ③ 模板+覆盖（templateRef + 覆盖 systemPrompt/tools/skills）→ eff.modelId 仍 = template.modelId
 *
 * 单文件 ≤300 行（纯函数 + JSDoc）。
 */
import type { SubAgentTemplate, SpawnAgentInput } from './types';
import type { Role, Derivation } from '@app/shared';

/**
 * EffectiveConfig —— spawn 解析后的「生效配置」（derivation §4 childConfig）。
 * createSession + buildSessionConfigFromDeps 用这些字段构造 child session + SessionConfig。
 *
 * role + derivation：role 缺省 parent.role bloodline；derivation 恒 'subagent'
 * （spawn 只产派生子 agent——input.derivation='parent' 一律被 gate 强制回 'subagent'）。
 */
export interface EffectiveConfig {
  /** 生效 systemPrompt（input.X ?? template.X；无模板且无 inline → resolveEffective 抛错） */
  systemPrompt: string;
  /** 生效 tools 白名单（input.X ?? template.X） */
  tools: string[] | undefined;
  /** 生效 skills（input.X ?? template.X） */
  skills: string[] | undefined;
  /** ★ D8 生效 modelId（template?.modelId ?? parent.modelId；spawn 入参无 modelId 不可覆盖） */
  modelId: string;
  /** 派生自哪个模板标签（input.templateRef ?? null；inline spawn 无 templateRef=null） */
  subAgentTemplateType: string | null;
  /** 生效 Role（input.role ?? parent.role bloodline） */
  role: Role | undefined;
  /** 生效 Derivation（恒 'subagent'；input.derivation='parent' 被 gate 强制回 'subagent'） */
  derivation: Derivation;
}

/** loadTemplate 函数签名（存储后端由 bootstrap 注入；本文件提供默认 fallback null） */
export type LoadTemplateFn = (name: string) => Promise<SubAgentTemplate | null>;

/**
 * 默认 loadTemplate fallback：返 null。
 * spawn 引用 templateRef 但此 loader 返 null → resolveEffective 抛「template not found」error。
 * 生产由 bootstrap 注入真实 loader（读 dev_config sub_agent_templates 组）。
 */
export const defaultLoadTemplate: LoadTemplateFn = async (_name: string) => null;

/**
 * 解析 spawn 入参 + 模板 → EffectiveConfig（derivation §4 + subagent_templates §4 D8）。
 *
 * 三种用法 model 解析（D8）：
 *   - 有模板 → eff.modelId = template.modelId ?? parent.modelId（模板可指定 model；模板无 model → inherit parent）
 *   - 无模板 → eff.modelId = parent.modelId（纯 inline 只能 inherit parent）
 *   - 模板+覆盖 → eff.modelId 仍 = template.modelId ?? parent.modelId（spawn 入参无 modelId，无法覆盖模板）
 *
 * role/derivation 解析：
 *   - eff.role = input.role ?? parent.role（bloodline；undefined 由 caller 按上下文回退）
 *   - eff.derivation 恒 'subagent'：input.derivation='parent' 是 LLM 可控输入，一律强制回
 *     'subagent'（防 LLM 直填 parent 造 detached 顶级 session，绕过派生拓扑）。
 *
 * @param input       SpawnAgentInput（templateRef / systemPrompt / tools / skills / task / role / derivation）
 * @param parentModelId parent.modelId（D8 inherit 用）
 * @param loadTemplate 模板加载器（默认 fallback null；task-3 完成后注入真实实现）
 * @returns EffectiveConfig（systemPrompt/tools/skills/modelId/subAgentTemplateType/role/derivation）
 * @throws Error templateRef 找不到模板 / 无模板且无 inline systemPrompt
 */
export async function resolveEffective(
  input: SpawnAgentInput,
  parentModelId: string,
  loadTemplate: LoadTemplateFn = defaultLoadTemplate,
): Promise<EffectiveConfig> {
  const template = input.templateRef ? await loadTemplate(input.templateRef) : null;
  // templateRef 提供但找不到模板 → error（subagent_templates §4：loadTemplate 找不到 → spawn 拒绝）
  if (input.templateRef && !template) {
    throw new Error(`spawn: template not found: ${input.templateRef}`);
  }
  // 无模板且无 inline systemPrompt → error（derivation §4）
  if (!template && (!input.systemPrompt || input.systemPrompt.length === 0)) {
    throw new Error(
      'spawn: systemPrompt required when no templateRef',
    );
  }
  // D8：eff.modelId = template?.modelId ?? parent.modelId（spawn 入参无 modelId，不可覆盖模板 modelId）
  const modelId = template?.modelId ?? parentModelId;
  // role/derivation 解析
  const role = input.role;
  // derivation gate：input.derivation='parent' 是 LLM 可控输入——一律强制 'subagent'
  // （防 LLM 直填 parent 造 detached 顶级 session，绕过派生拓扑）。
  const derivation: Derivation = 'subagent';
  return {
    systemPrompt: input.systemPrompt ?? template!.systemPrompt,
    tools: input.tools ?? template?.tools,
    skills: input.skills ?? template?.skills,
    modelId,
    subAgentTemplateType: input.templateRef ?? null,
    role,
    derivation,
  };
}
