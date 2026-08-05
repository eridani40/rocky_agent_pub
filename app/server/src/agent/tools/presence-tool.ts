/**
 * presence 工具 —— 成员当前工作标记（[v0.0.116] 新增）
 * 参考: specs/tech/squad/[P1]squad_tools.md §6a（presence 工具：set/clear，leader/mate 可用）
 *       specs/tech/squad/[P1]data_model.md §1.2b（currentWork 形状）
 *       specs/tech/version_logs/v0.0.116/change_plan-part2.md §6
 *
 * 职责：成员用自由文本标记「当前正在做的事」。
 *   - action=set：写自己 member.currentWork = { text, updatedAt: now }
 *   - action=clear：置 member.currentWork = null
 *
 * 越权防护（UC-14）：只写 selfMemberId（从 runtime-context 取），不接受 memberId 参数。
 * 不记 lastWriteMessageId：currentWork 不驱动 reminder 变化检测（team-status 每轮直出）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import { readRuntimeContext } from './runtime-context';
import type { MemberRecord } from '../schema_defs/squad/member';

/**
 * presence 工具（单例导出，registry defaultTools 引用）。
 * 从 ctx.config.agentToolContext 读 runtime context（selfSquadId/selfMemberId/memberStore）。
 */
export const presenceTool: Tool = {
  definition: {
    name: 'presence',
    description:
      'Set or clear your current work status (presence). ' +
      'action="set" marks what you are currently working on (text required). ' +
      'action="clear" removes your current work status. ' +
      'Only writes your own status (self member); available to leader and mate only.',
    intro: 'Set or clear your current work status.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'clear'],
          description: 'set — mark current work (text required); clear — remove status',
        },
        text: {
          type: 'string',
          description: 'Current work description (required when action=set)',
        },
      },
    },
  },
  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const rtc = readRuntimeContext(ctx.config);

    // 校验：必须是 squad session（有 selfSquadId + selfMemberId + memberStore）
    if (!rtc.selfSquadId) {
      return errorResult('presence tool is only available in squad sessions (leader/mate)');
    }
    if (!rtc.selfMemberId) {
      return errorResult('presence tool requires selfMemberId (not available in this session type)');
    }
    if (!rtc.memberStore) {
      return errorResult('presence tool: memberStore not available');
    }

    const action = String(input.action ?? '');

    // 计算目标 currentWork：set→{text,updatedAt}（text 空 → error）；clear→null；其他 action → error
    let currentWork: { text: string; updatedAt: string } | null;
    if (action === 'set') {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) {
        return errorResult('presence_text_required: text is required when action=set');
      }
      currentWork = { text, updatedAt: new Date().toISOString() };
    } else if (action === 'clear') {
      currentWork = null;
    } else {
      return errorResult(`presence tool: unknown action "${action}". Valid: set | clear`);
    }

    // read-modify-write：剥信封（createdAt/updatedAt/version 由 store 管理，putMember 不接受）后写 currentWork
    const member = await rtc.memberStore.getMember(rtc.selfSquadId, rtc.selfMemberId);
    if (!member) {
      return errorResult(`presence tool: member ${rtc.selfMemberId} not found`);
    }
    const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = member as unknown as Record<string, unknown>;
    void _ca; void _ua; void _v;

    await rtc.memberStore.putMember({ ...(rest as object), currentWork } as MemberRecord);
    return textResult(JSON.stringify({ ok: true }));
  },
};
