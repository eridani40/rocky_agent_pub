/**
 * builtin rocky_context plugin — system_prompt_mapper: squad_role（v0.0.33.3 NEW）
 * 参考: specs/tech/squad/[P1]prompt_sections.md §3.1（squad_role 固定规范注入）
 *       reqs/v0.0.33.3/req6 §3/§4/§7（system prompt 不落库 + fragment 组装）
 *       reqs/v0.0.33.3/req8 §3/§5（固定 vs 动态归属 + 工具↔OKF 关系）
 *
 * 职责：按 sessionType 注入**固定规范** fragment（角色人设 / rules / 协作规则 / 工具说明）。
 * **动态上下文（todo/roster 等）不归它**（归 reminder，见 squad_reminder_providers.md）。
 *
 * Option A 分流（prompt_sections §3.1）：
 *   - leader   → prompts/content/squad/leader.md（leader 人设 + 不直接编码 + 协作 + 工具）
 *   - mate     → prompts/content/squad/mate.md（mate 人设 + 不越权 + 协作 + 工具）
 *   - squad    → prompts/content/squad/squad_chat.md（路由器人设 + 永不创作内容）
 *   - subagent / standalone（!sessionType）→ 返空（subagent 走 parent_task + IdentityHandler；
 *     standalone 走 Rocky identity / 通用 rules.md）
 *
 * 替代 member.systemPrompt 作身份正文（迁移 step1+step2，prompt_sections §7）：
 *   - identity.ts studio 分支（leader/mate/squad）→ 返空（本 mapper 接管身份正文）
 *   - rules.ts studio 分支（leader/mate/squad）→ 返空（本 mapper 接管角色规则）
 *   - standalone 分支不变（identity→Rocky / rules→通用 rules.md）
 *
 * tier=stable，priority=950（identity/rules 之后，tool_guidance 之前），参与 budget_truncate。
 * 无状态：每次 map() 重读 content 文件（PromptHandler mtime 缓存）→ compaction 友好（重建即重读）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { PromptHandler, type PromptHandlerContext, type PromptHandlerResult } from '../../../../server/src/prompts/prompt-handler';
import { readSessionType } from './squad_reminder_shared';

/** squad_role mapper：按 sessionType 加载 content fragment → 包 PromptFragment。 */
export default class SquadRoleMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const sessionType = readSessionType(ctx);
    // Option A 分流：仅 studio 三 scope 贡献；subagent/standalone 返空
    let handler: PromptHandler | null = null;
    let buildCtx: PromptHandlerContext = {};
    if (sessionType === 'leader') handler = new LeaderContentHandler();
    else if (sessionType === 'mate') handler = new MateContentHandler();
    else if (sessionType === 'squad') {
      // [v0.0.85.ui_opt F3 fix] squad_chat.md 的 {{squad_name}} 占位符在加载期由代码注入
      // 实际群聊名（LLM 会把 `{xxx.yyy}` 点号 brace 当字面量 echo；改 {{squad_name}} 走 fillTemplate）。
      // 群聊名来自 ctx.config.studioContext.squad.name（SquadRecord.name 必填；studio session 必注入）。
      const squadName = readSquadName(ctx);
      handler = new SquadChatContentHandler();
      buildCtx = squadName ? { vars: { squad_name: squadName } } : {};
    }
    else return [];
    let content = handler.build(buildCtx).content;
    if (!content) return [];
    // workStyle 追加段（v0.0.142）：仅 leader/mate 个人 session 注入自己的 workStyle，
    // 不碰 team_roster/members[]；空则不追加（无悬空标题，非 {{}} 模板占位）。
    if (sessionType === 'leader' || sessionType === 'mate') {
      const ws = readMemberWorkStyle(ctx);
      if (ws) content = `${content}\n\n## 我的工作方式\n\n${ws}`;
    }
    return [
      {
        id: 'squad_role',
        tier: 'stable',
        content,
        priority: 950,
      },
    ];
  }
}


// ============================================================
// content handlers（一个 role 一个，复用 PromptHandler mtime 缓存 + 降级）
// ============================================================

/** leader.md content handler */
class LeaderContentHandler extends PromptHandler {
  protected readonly contentFile = 'squad/leader.md';
  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    return { content: this.readContent() };
  }
}

/** mate.md content handler */
class MateContentHandler extends PromptHandler {
  protected readonly contentFile = 'squad/mate.md';
  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    return { content: this.readContent() };
  }
}

/** squad_chat.md content handler — 跑 fillTemplate 替换 {{squad_name}} → 实际群聊名 */
class SquadChatContentHandler extends PromptHandler {
  protected readonly contentFile = 'squad/squad_chat.md';
  build(ctx: PromptHandlerContext): PromptHandlerResult {
    return { content: this.fillTemplate(this.readContent(), ctx.vars ?? {}) };
  }
}

/**
 * 从 PromptCtx 读 squad 名（duck-typed，避免 import 业务类型耦合）。
 * squad chat session（role='squad'）的 studioContext.squad.name 必填；缺省返 '' → 不替换（占位符清空）。
 */
function readSquadName(ctx: PromptCtx): string {
  const squad = (ctx.config as { studioContext?: { squad?: { name?: unknown } } }).studioContext?.squad;
  const name = squad?.name;
  return typeof name === 'string' ? name : '';
}

/**
 * 从 PromptCtx 读当前 session 自己 member 的工作方式（duck-typed，避免 import 业务类型耦合）。
 * 仅 leader/mate 个人 session 的 studioContext.member 为自己（非全队 members[]）；
 * 缺省/非字符串/空串一律返 ''（调用方据此判断是否追加段）。
 */
function readMemberWorkStyle(ctx: PromptCtx): string {
  const member = (ctx.config as { studioContext?: { member?: { workStyle?: unknown } } }).studioContext?.member;
  const workStyle = member?.workStyle;
  return typeof workStyle === 'string' ? workStyle.trim() : '';
}
