/**
 * ConsolidationTier2PromptHandler — tier2（天级离线整理）task message 模板
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §5.1 §6
 *
 * 与 tier1 `ConsolidationHandler`（consolidation.md，实时收集语气）职责不同——本 handler
 * 服务三个独立工作块（全局 skill / 全局 memory / 单 session memory）共用同一套 4 阶段
 * 文案骨架（Orient → Gather → Consolidate → Prune），靠 `vars.domain` 区分 skill/memory
 * 措辞、`vars.session_memory_full`/`session_summary` 区分是否单 session 语境（全局块调用方
 * 不传这两个 var，走本类兜底的"不适用"文案）。
 *
 * 本文件是纯 leaf 工具（zero 依赖 agent/consolidation-tier2/* 业务模块），
 * `SYSTEM_PROMPT` + `parseResult()` 供三个 block 文件复用，避免它们之间产生循环依赖。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';
import { ROUTING_DECISION_PROMPT } from '../routing-decision';

/** parseResult 解析出的结构化结果（与 agent/consolidation-tier2/runner.ts 的 BlockResult 结构等价，
 *  仅靠 TS 结构化类型对齐，不做跨层类型 import，保持本文件零依赖） */
export interface ConsolidationTier2ParsedResult {
  action: string;
  detail: string;
}

/**
 * t2 专用 system prompt（tier2 spec §5.1：纯文本常量，不经 buildSessionConfigFromDeps/
 * system_prompt_mapper 管线——forked snapshot.system 直接用它，天然不含 skill catalog 段）。
 */
export class ConsolidationTier2PromptHandler extends PromptHandler {
  protected readonly contentFile = 'consolidation_tier2.md';

  static readonly SYSTEM_PROMPT =
    'You are a scheduled background maintenance agent performing tier-2 (offline, daily) ' +
    'consolidation of previously-collected skill/memory entries written during live conversations. ' +
    'There is no user present — you act autonomously by calling tools directly, and nothing you say ' +
    'is shown to anyone. You never physically delete anything (only archive/disable, which is ' +
    'reversible), and you must respect evolvable=false governance: edits to non-evolvable entries are ' +
    'rejected by the tool itself — do not retry, just skip.';

  /**
   * 产出该工作块的 task message 正文。`ctx.vars.domain` = 'skill' | 'memory'；
   * `session_memory_full`/`session_summary` 仅单 session 块传（全局块省略，走兜底文案）。
   */
  build(ctx: PromptHandlerContext): PromptHandlerResult {
    const template = this.readContent();
    const content = this.fillTemplate(template, {
      domain: ctx.vars?.domain ?? '',
      entries_list: ctx.vars?.entries_list ?? '',
      capacity_limit: ctx.vars?.capacity_limit ?? '',
      session_memory_full:
        ctx.vars?.session_memory_full ??
        '(not applicable — this is a global-scope pass, no single session to gather from)',
      session_summary:
        ctx.vars?.session_summary ?? '(not applicable — this is a global-scope pass)',
      // scope 必填后，tier2 必须显式告知 LLM 用哪个 scope 落 archive/disable
      write_scope: ctx.vars?.write_scope ?? 'global',
      // 判据单一源：Phase 2.5 质量审查段的判据直接引 ROUTING_DECISION_PROMPT 全文
      // （不复制 routing 措辞进 tier2 prompt，防漂移；三处消费方共读同一源）
      routing_rules: ROUTING_DECISION_PROMPT,
    });
    return { content };
  }

  /**
   * 从整理 agent 的最终 answer 解析 `<result>` 标签（§6 Output 约定）→ {action, detail}。
   * 容错：标签缺失 / 字段缺失时给合理兜底，不抛错（best-effort，caller 不因解析失败中断）。
   */
  static parseResult(answer: string): ConsolidationTier2ParsedResult {
    const open = '<result>';
    const close = '</result>';
    const startIdx = answer.indexOf(open);
    const endIdx = answer.lastIndexOf(close);
    const tagged =
      startIdx >= 0 && endIdx > startIdx
        ? answer.slice(startIdx + open.length, endIdx).trim()
        : answer.trim();
    const actionMatch = /action:\s*(\S+)/i.exec(tagged);
    const detailMatch = /detail:\s*([\s\S]*)/i.exec(tagged);
    const action = actionMatch?.[1] ? actionMatch[1].trim() : 'processed';
    const detail = detailMatch?.[1] ? detailMatch[1].trim() : tagged.slice(0, 800);
    return { action, detail };
  }
}

export default ConsolidationTier2PromptHandler;
