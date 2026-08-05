/**
 * Side-run Reminder 注入器（cache 前缀之后注入，零污染）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]forked_reminder.md（主契约 §2-§6）
 *
 * 定位：旁路 run（runKind=summary/consolidate）专属 reminder，注入位置在 cache 前缀之后
 * （snapshot 之后、userMessage 之前），作独立 user-role message。不复用 system_reminder_injector
 * （旁路 scope 禁用它，防污染 cache 前缀）。
 *
 * 不变量（§6）：
 *   1. cache 前缀不变（snapshot.system + snapshot.messages 不被 reminder 触碰）
 *   2. 只旁路 run 注入（顶层/subagent 不调本注入器）
 *   3. reminder 文案的 allowedTools 与 buildRunDeps 的 allowedTools 同源（resolveToolSet(effectiveKind,
 *      {tools: snapshot.tools 名表}) 产出，= snapshot ∩ toolBound，注册序；reminder 广告的工具 = 实际可执行的，避免对齐缝）
 *   4. compaction 强制零工具（runKind=summary + allowedTools=[]）
 */
import { ulid } from '../config/ulid';
import type { Message } from '../message/types';
import { SideRunReminderHandler } from '../prompts/handlers/side-run-reminder-handler';

/** 注入器入参（§2.1 SideRunReminderInput） */
export interface SideRunReminderInput {
  /** 实际可执行工具白名单（buildRunDeps 经 resolveToolSet(effectiveKind, {tools: snapshot.tools 名表}) 产出，= snapshot ∩ toolBound，注册序） */
  allowedTools: string[];
  /** runKind（summary / consolidate）——文案按 runKind 微调（§3.3） */
  runKind: string;
  /** 所属 session（构造 Message 必填字段） */
  sessionId: string;
}

/**
 * 构造 side-run reminder 文案（§3 文案模板）。
 *
 * 通用骨架（§3.1）+ 两态 actualToolsDescription 分叉（§3.2）+ runKind 微调（§3.3）。
 * 两态：
 *   - allowedTools=[] → 零工具（compaction）
 *   - allowedTools=[...] → 限定白名单
 *
 * @param input  见 SideRunReminderInput 字段说明
 * @returns  reminder 文案字符串
 */
export function buildReminderText(input: SideRunReminderInput): string {
  const { allowedTools, runKind } = input;
  const handler = new SideRunReminderHandler();

  // 两态 actualToolsDescription（§3.2）——判断逻辑留在本函数，文案正文走 handler 读 md
  const actualToolsDescription =
    allowedTools.length === 0 ? handler.readToolsNone() : `[${allowedTools.join(', ')}]`;

  // runKind 微调（§3.3）——「选哪个 tail」的判断留在本函数，只传 key 给 handler
  const modeTailKey = runKind === 'summary' || runKind === 'consolidate' ? runKind : '';

  return handler.build({
    vars: {
      mode_key: runKind,
      actual_tools_description: actualToolsDescription,
      mode_tail_key: modeTailKey,
    },
  }).content;
}

/**
 * 构造 side-run reminder message（user-role，cache 之后注入）。
 *
 * 返回独立 user-role message（sender.source='system' 标记系统注入，不进 a2a 拓扑）。
 * caller（buildRunDeps wireInitState）把本 message 插入在 snapshot 之后、userMessage 之前——
 * cache 前缀（snapshot.system + snapshot.messages）完全不变（§2.2）。
 *
 * @param input  见 SideRunReminderInput 字段说明
 * @returns  user-role Message（content 单 text block，sender.source='system'）
 */
export function injectSideRunReminder(input: SideRunReminderInput): Message {
  return {
    id: ulid(),
    sessionId: input.sessionId,
    role: 'user',
    content: [{ type: 'text', text: buildReminderText(input) }],
    sender: { source: 'system', system: { kind: 'reminder' } },
  };
}
