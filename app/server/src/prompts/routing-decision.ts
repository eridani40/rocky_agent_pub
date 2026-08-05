/**
 * ROUTING_DECISION_PROMPT — 记忆/技能路由决策提示词（两步决策，单一文案源）
 * 参考: specs/tech/agent/memory/[P0]memory_manage_tool.md §5.2（路由提示词）
 *       specs/tech/agent/skills/[P0]skill_manage_tool.md §11（skill 侧引用）
 *       specs/tech/agent/memory/[P0]consolidation_tier1.md §6（fork prompt 落点）
 *       specs/tech/version_logs/v0.0.153/change_plan.md T3-b
 *
 * 单一源（不变量#6）：本常量被三处引用，措辞**绝不复制粘贴**：
 *   1. `memory_manage` tool description（tools/memory-manage.ts）
 *   2. `skill_manage` tool description（tools/skill-manage.ts）
 *   3. consolidation fork-2 prompt（prompts/content/consolidation.md 经 {{routing_rules}} 注入）
 *
 * 文案通用（三处共读）：只描述「写什么 / 写哪个 scope」的两步通用规则；
 *   各工具 description 各自补充 scope 语义消歧（skill session=项目级 workspace vs
 *   memory session=单会话），不放进本通用常量以免自相矛盾。
 *
 * 正文来自 content/routing_decision.md，本文件内部私有 RoutingDecisionHandler 读取该文件；
 * ROUTING_DECISION_PROMPT 仍是模块顶层即时求值的字符串常量（三处消费方零改动）。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from './prompt-handler';

/**
 * RoutingDecisionHandler（模块私有，不导出）：读 content/routing_decision.md 正文，无占位符。
 * 仅供本文件内部即时求值 ROUTING_DECISION_PROMPT 使用。
 */
class RoutingDecisionHandler extends PromptHandler {
  protected readonly contentFile = 'routing_decision.md';

  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    return { content: this.readContent() };
  }
}

/**
 * 两步路由决策文案（第一步 skill/memory/都不写；第二步 global/session）。
 * 缩进/换行即最终注入形态，caller 直接拼接进 description / fork prompt。
 * `.trimEnd()` 去掉 md 文件结尾的换行符，还原为与旧内联模板字面量完全一致的字符串
 * （原字面量以 `...narrower context.` 收尾，无尾随换行）。
 */
export const ROUTING_DECISION_PROMPT = new RoutingDecisionHandler().build({}).content.trimEnd();
