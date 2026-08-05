/**
 * ConsolidationHandler — fork-2 整理 task message 模板（读 content/consolidation.md + 占位符替换）。
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2d.3
 *       specs/tech/agent/memory/[P0]consolidation_tier1.md §3/§4
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md §1（旁路不变量）
 *
 * task message = 纯 directive（旁路不变量，与 fork-1 summary 同契约）：
 *   snapshot 是唯一信息源（对话历史已在旁路 buffer 中），prompt 只下指令——
 *   不复述 serialized_transcript / 不注入 old_summary（复述 = 对话历史发两遍）。
 *
 * 动态数据（v0.0.238 起 build 读 ctx.vars，但 vars 只承载静态配置，旁路不变量保持）：
 * - routing_rules：单一文案常量 ROUTING_DECISION_PROMPT（不变量#6：四处同源，不手写路由）
 * - agents_paths / scope_table：caller（plugin startConsolidation）从 ctx.config 算的静态配置
 *   （AGENTS.md 路径表 + 按 biz 渲染的 scope 规则段）；缺省替空串——降级不抛错
 *
 * 与 CompactHandler 同模式：模板正文文件化，build() 替换占位符产出 fork-2 的完整 task
 * message 文本。memory_skill_consolidation handler 调本类构造 user message。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';
import { ROUTING_DECISION_PROMPT } from '../routing-decision';

/** ConsolidationHandler：读 consolidation.md 模板 + 替换 routing_rules/agents_paths/scope_table 占位符 */
export class ConsolidationHandler extends PromptHandler {
  protected readonly contentFile = 'consolidation.md';

  build(ctx?: PromptHandlerContext): PromptHandlerResult {
    const template = this.readContent();
    // routing_rules → 单一文案常量 ROUTING_DECISION_PROMPT（不变量#6：四处同源，不手写路由）
    // agents_paths / scope_table → caller 从 ctx.config 算的静态配置（缺省替空串降级，不抛错）
    const content = this.fillTemplate(template, {
      routing_rules: ROUTING_DECISION_PROMPT,
      agents_paths: ctx?.vars?.agents_paths ?? '',
      scope_table: ctx?.vars?.scope_table ?? '',
    });
    return { content };
  }
}

export default ConsolidationHandler;
