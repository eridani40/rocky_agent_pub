/**
 * send_message 工具 UT（v0.0.31 BUG-031 + BUG-032 回归锁）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §5（send_message 契约）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2（AgentRef）+ §6（工具层校验）
 *       states/v0.0.31/bugs/BUG-031-[open].md + BUG-032-[open].md
 *
 * 锁定的 BUG：
 *   - BUG-031（Critical）：inputSchema 不自描述 → 真 LLM 把 content 当对象、needReply
 *     嵌进 content，校验器按 spec 拒收，5 次重试全败。修复：schema 自描述 ContentBlock[]
 *     结构 + run 入参容错（normalize 异常形态）。
 *   - BUG-032（Major）：sender.agent.ref 用 parentAgentRef（对 subagent caller 返回
 *     parentSessionId=接收方），enrich 反查接收方 → ref 指向接收方自己。修复：改用
 *     selfAgentRef（caller self），enrich 反查 caller self → 发送方身份正确。
 *
 * 白盒：mock agentToolContext + agentManager.deliverTo 捕获投递的 message，
 *      验证 (1) 异常入参被容错接受、(2) sender.agent.ref.sessionId = caller self。
 */
import { describe, it, expect } from 'vitest';
import { sendMessageTool } from '../send-message-tool';
import type { ToolCtx, ToolInput } from '../../../tools/types';
import type { Message } from '../../../message/types';
import type { AgentToolRuntimeContext } from '../runtime-context';

/** 构造 mock rtc（subagent caller：self=CHILD，parent=PARENT） */
function makeSubagentRtc(captured: { delivered: Message | null }): AgentToolRuntimeContext {
  return {
    // parent*：caller 的父 session（spawn 首任务 sender=parent 用，send_message target='parent' 解析用）
    parentSessionId: 'PARENT-001',
    parentRunId: 'parent-run-001',
    parentType: 'leader',
    parentName: 'parent-session-title',
    parentScope: 'subagent',
    // self*：caller 自己的身份（BUG-032 send_message sender.agent.ref 用）
    selfSessionId: 'CHILD-001',
    selfType: 'subagent',
    selfName: 'subagent',
    agentManager: {
      // deliverTo：捕获投递的 message（验证 sender.agent.ref 方向）
      deliverTo: async (_sid: string, msg: Message) => {
        captured.delivered = msg;
        return { sessionId: _sid, runId: 'r', state: 'running', promise: Promise.resolve({} as never) } as never;
      },
    } as never,
    store: {} as never,
    sessionDeps: {} as never,
  };
}

/**
 * 从 message 安全提取 sender.agent（narrow source='agent'）。
 * MessageSender 是判别联合，必须先 narrow 才能访问 .agent 子结构。
 */
function getAgentSender(msg: Message | null): { ref: { type: string; sessionId: string; name: string }; needReply: boolean; inReplyTo?: string } | null {
  if (!msg || !msg.sender || msg.sender.source !== 'agent') return null;
  return msg.sender.agent;
}

/** 调 sendMessageTool.run 并捕获投递的 message */
async function runSendMessage(
  inputFields: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; delivered: Message | null; targetSid: string }> {
  const captured = { delivered: null as Message | null };
  const ctx: ToolCtx = { config: { agentToolContext: makeSubagentRtc(captured) } } as unknown as ToolCtx;
  const input: ToolInput = inputFields as unknown as ToolInput;
  const res = await sendMessageTool.run(input, ctx);
  const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = blocks.map((b) => b?.text ?? '').join('');
  return {
    text,
    isError: res.isError,
    delivered: captured.delivered,
    targetSid: captured.delivered?.sessionId ?? '',
  };
}

describe('send_message BUG-031：inputSchema 自描述 + 入参容错', () => {
  it('schema 的 content 字段含 items.text block 结构描述（自描述）', () => {
    const schema = sendMessageTool.definition.inputSchema as {
      properties: { content: { items?: { properties?: Record<string, unknown> } } };
    };
    const itemsProps = schema.properties.content.items?.properties;
    expect(itemsProps).toBeDefined();
    expect(itemsProps?.type).toBeDefined();
    expect(itemsProps?.text).toBeDefined();
  });

  it('形态 D（spec 权威）：content=ContentBlock[] + needReply 顶层 boolean → 接受', async () => {
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: [{ type: 'text', text: 'hi' }],
      needReply: true,
    });
    expect(isError).toBe(false);
    expect(getAgentSender(delivered)?.needReply).toBe(true);
    expect((delivered?.content as Array<{ type: string; text: string }>)[0]?.text).toBe('hi');
  });

  it('形态 A（BUG-031 实测）：content={item:{text},needReply:true} → 提取 needReply + content', async () => {
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: {
        item: { type: 'text', text: '你探查到几个文件？请告诉我数量' },
        needReply: true,
      },
      // needReply 顶层缺失（LLM 嵌进 content）
    });
    expect(isError).toBe(false);
    expect(getAgentSender(delivered)?.needReply).toBe(true);
    expect((delivered?.content as Array<{ type: string; text: string }>)[0]?.text).toBe('你探查到几个文件？请告诉我数量');
  });

  it('形态 B：content=单 block 对象（{type:text,text}）→ 包成数组', async () => {
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: { type: 'text', text: '单 block' },
      needReply: false,
    });
    expect(isError).toBe(false);
    expect(Array.isArray(delivered?.content)).toBe(true);
    expect((delivered?.content as Array<{ type: string; text: string }>)[0]?.text).toBe('单 block');
  });

  it('形态 C：content=字符串 → 包成 [{type:text,text}]', async () => {
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: '纯字符串消息',
      needReply: false,
    });
    expect(isError).toBe(false);
    expect((delivered?.content as Array<{ type: string; text: string }>)[0]?.text).toBe('纯字符串消息');
  });

  it('形态：needReply 完全缺失（顶层 + content 内都无）→ default:true 生效（UC-13，spec §5.1）', async () => {
    // v0.0.68 R5：needReply 移出 required，改 default:true
    //   - engine.validateInput 末尾 default-fill 注入 input.needReply=true（生产路径）
    //   - 此处直接调 run（绕过 engine）→ normalize 内兜底 ?? true
    //   两路径都落库 sender.agent.needReply=true
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(isError).toBe(false);
    expect(getAgentSender(delivered)?.needReply).toBe(true);
  });

  it('形态：needReply 显式 false → 落库 false（不被 default:true 覆盖，UC-14）', async () => {
    // v0.0.68 R5：显式 false 必须保留（!== undefined 判定走 default-fill 跳过 + normalize typeof boolean 保留）
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: [{ type: 'text', text: 'fyi' }],
      needReply: false,
    });
    expect(isError).toBe(false);
    expect(getAgentSender(delivered)?.needReply).toBe(false);
  });

  it('形态：content block 缺 text → error', async () => {
    const { isError, text } = await runSendMessage({
      target: 'parent',
      content: [{ type: 'text' }],
      needReply: false,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/text/i);
  });

  it('inReplyTo 嵌在 content 对象内 → 提取到顶层', async () => {
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: {
        item: { type: 'text', text: '回复' },
        needReply: false,
        inReplyTo: 'MSG-ORIG-001',
      },
    });
    expect(isError).toBe(false);
    expect(getAgentSender(delivered)?.inReplyTo).toBe('MSG-ORIG-001');
  });
});

describe('send_message BUG-032：sender.agent.ref 必须是 caller self（非 parent）', () => {
  it('subagent caller：sender.agent.ref.sessionId = CHILD（发送方 self），不是 PARENT（接收方）', async () => {
    const { isError, delivered } = await runSendMessage({
      target: 'parent',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(isError).toBe(false);
    const ref = getAgentSender(delivered)?.ref;
    expect(ref?.sessionId).toBe('CHILD-001'); // caller self，非 PARENT-001
    expect(ref?.sessionId).not.toBe('PARENT-001'); // 反向断言：不是接收方
  });

  it('subagent caller：ref.type/selfType = subagent（caller self type）', async () => {
    const { delivered } = await runSendMessage({
      target: 'parent',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(getAgentSender(delivered)?.ref.type).toBe('subagent');
  });

  it('target=parent 别名正确路由到 PARENT-001（接收方），sender.ref 仍是 self CHILD', async () => {
    const { delivered, targetSid } = await runSendMessage({
      target: 'parent',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    // targetSid = 接收方（PARENT）
    expect(targetSid).toBe('PARENT-001');
    // sender.ref.sessionId = 发送方（CHILD）
    expect(getAgentSender(delivered)?.ref.sessionId).toBe('CHILD-001');
    // 两者必须不同（防 enrich 反查错向的根本保证）
    expect(getAgentSender(delivered)?.ref.sessionId).not.toBe(targetSid);
  });

  it('target=sessionId 字串：路由到该 sid，sender.ref 仍是 self CHILD', async () => {
    const { delivered, targetSid } = await runSendMessage({
      target: 'PARENT-001',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(targetSid).toBe('PARENT-001');
    expect(getAgentSender(delivered)?.ref.sessionId).toBe('CHILD-001');
  });
});

describe('send_message：subagent scope 拓扑校验（a2a_protocol §6）', () => {
  it('subagent caller 向非 parent 的 sid → 拒绝（仅可达 parent）', async () => {
    const { isError, text } = await runSendMessage({
      target: 'OTHER-SESSION-002',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/parent/i);
  });
});
