/**
 * builtin rocky_context plugin — system_prompt_mapper: tool_guidance
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.4
 *       specs/tech/agent/context/[P0]system_prompt.md §4（tool_guidance / stable tier）
 *       specs/tech/agent/context/[P0]prompt_content_files.md §4（委托 ToolGuidanceHandler）
 *
 * 职责：贡献工具使用说明片段（stable tier）。v0.0.22 起 mapper 拼 tool_list 从 config.tools
 * 读 definition name + intro（优先）或 description（fallback）→ 传 ToolGuidanceHandler.build({vars:{tool_list}})
 * 替换模板 {{tool_list}} 占位符。空 list → handler 返空 → mapper 不贡献。
 * EP: system_prompt_mapper，priority 600，tier=stable。
 *
 * tool 形态（tools/types.ts §Tool）：{ definition: { name, description, intro?, inputSchema } }
 * SessionConfig.tools 为 unknown[]（避免 context 层反向依赖 tools 模块），duck-typed 读 definition。
 * v0.0.146: 优先 intro（一句话短简介），完整 description 留给 tool schema 避免冗余。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { ToolGuidanceHandler } from '../../../../server/src/prompts/handlers/tool-guidance-handler';

/** tool_guidance mapper：拼 tool_list 传 handler → 包 PromptFragment */
export default class ToolGuidanceMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const tools = ctx.config.tools ?? [];
    const lines: string[] = [];
    for (const t of tools) {
      const def = readDefinition(t);
      if (!def) continue;
      // 优先 intro（system prompt 专用一句话）；无则 fallback description。
      const descText = def.intro ?? def.description;
      const desc = descText ? ` — ${descText}` : '';
      lines.push(`- \`${def.name}\`${desc}`);
    }
    if (lines.length === 0) return [];
    const toolList = lines.join('\n');
    const content = new ToolGuidanceHandler().build({ vars: { tool_list: toolList } }).content;
    return [
      {
        id: 'tool_guidance',
        tier: 'stable',
        content,
        priority: 600,
      },
    ];
  }
}

/**
 * duck-typed 读 tool.definition（不依赖 tools 模块类型，避免 context 层反向依赖）。
 * 返回 intro（system prompt 短简介，可选）+ description（完整说明，可选）。
 */
function readDefinition(tool: unknown): { name: string; intro?: string; description?: string } | null {
  if (!tool || typeof tool !== 'object') return null;
  const def = (tool as { definition?: unknown }).definition;
  if (!def || typeof def !== 'object') return null;
  const name = (def as { name?: unknown }).name;
  if (typeof name !== 'string') return null;
  const introRaw = (def as { intro?: unknown }).intro;
  const desc = (def as { description?: unknown }).description;
  return {
    name,
    intro: typeof introRaw === 'string' ? introRaw : undefined,
    description: typeof desc === 'string' ? desc : undefined,
  };
}
