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
import { sendMessageTool, normalizeContentBlocks } from '../send-message-tool';
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

// ============================================================
// [v0.0.311] result targetName 返回（后端解析可读名覆盖 subagent 等场景）
// ============================================================
describe('send_message [v0.0.331]：normalizeContentBlocks 公共函数全形态（D4 语义唯一来源）', () => {
  it('array 正常形态（含 type:text）→ 原样保留', () => {
    expect(normalizeContentBlocks([{ type: 'text', text: 'hi' }])).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('array 缺 type（[{text}]）→ 补 type:"text"（治本核心）', () => {
    expect(normalizeContentBlocks([{ text: 'hi' }])).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('array 多块缺 type → 逐块补 type:"text"', () => {
    expect(normalizeContentBlocks([{ text: 'a' }, { text: 'b' }])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('string → 包成 [{type:"text",text:str}]（形态 C）', () => {
    expect(normalizeContentBlocks('纯字符串')).toEqual([{ type: 'text', text: '纯字符串' }]);
  });

  it('object 单 block（{type:"text",text}）→ 包成数组（形态 B）', () => {
    expect(normalizeContentBlocks({ type: 'text', text: '单 block' })).toEqual([
      { type: 'text', text: '单 block' },
    ]);
  });

  it('object 包裹信封（{item:{text}}）→ 解包 .item（形态 A）', () => {
    expect(normalizeContentBlocks({ item: { text: '解包' } })).toEqual([
      { type: 'text', text: '解包' },
    ]);
  });

  it('object 包裹信封（{item, needReply}）→ 解包 .item 且忽略包裹字段（形态 A 完整）', () => {
    expect(normalizeContentBlocks({ item: { text: '解包' }, needReply: true })).toEqual([
      { type: 'text', text: '解包' },
    ]);
  });

  it('block 缺 text → error 形态（text 非 string 语义不变）', () => {
    expect(normalizeContentBlocks([{ type: 'text' }])).toEqual({
      error: 'send_message: content block missing text string',
    });
  });

  it('block 非 object（number）→ error 形态', () => {
    expect(normalizeContentBlocks([42])).toEqual({
      error: 'send_message: content block must be object',
    });
  });

  it('number（非 string/object/array）→ error 形态', () => {
    expect(normalizeContentBlocks(42)).toEqual({
      error: 'send_message: content must be array of {type:"text",text:string} blocks (or a single block/string)',
    });
  });

  it('空数组 → error 形态（must be non-empty）', () => {
    expect(normalizeContentBlocks([])).toEqual({
      error: 'send_message: content must be non-empty array',
    });
  });

  it('未知 type 不透传（{type:"image",text}）→ 归一为 text block（防脏数据落库）', () => {
    expect(normalizeContentBlocks([{ type: 'image', text: 'x' }])).toEqual([
      { type: 'text', text: 'x' },
    ]);
  });
});

describe('send_message [v0.0.311]：result 含 targetName', () => {
  /** 构造带 store.getSession mock 的 subagent rtc */
  function makeRtcWithStore(
    captured: { delivered: Message | null },
    sessionTitle: string | null,
  ): AgentToolRuntimeContext {
    return {
      parentSessionId: 'PARENT-001',
      parentRunId: 'parent-run-001',
      parentType: 'leader',
      parentName: 'parent-session-title',
      parentScope: 'subagent',
      selfSessionId: 'CHILD-001',
      selfType: 'subagent',
      selfName: 'subagent',
      agentManager: {
        deliverTo: async (_sid: string, msg: Message) => {
          captured.delivered = msg;
          return { sessionId: _sid, runId: 'r', state: 'running', promise: Promise.resolve({} as never) } as never;
        },
      } as never,
      store: {
        getSession: async () =>
          sessionTitle
            ? ({ id: 'PARENT-001', title: sessionTitle } as never)
            : null,
      } as never,
      sessionDeps: {} as never,
    };
  }

  /**
   * [v0.0.340 决策 1] 构造带 squad 成员 target session + memberStore mock 的 rtc。
   * @param session target session record（squadId/memberId 可空：null → 无 session）
   * @param memberStore mock memberStore（getMember 返回实时名 / undefined = member 已删）
   */
  function makeRtcWithMember(
    captured: { delivered: Message | null },
    session: { title: string | null; squadId?: string; memberId?: string } | null,
    memberStore?: {
      getMember: (squadId: string, memberId: string) => Promise<{ name: string } | undefined>;
    },
  ): AgentToolRuntimeContext {
    return {
      parentSessionId: 'PARENT-001',
      parentRunId: 'parent-run-001',
      parentType: 'leader',
      parentName: 'parent-session-title',
      parentScope: 'subagent',
      selfSessionId: 'CHILD-001',
      selfType: 'subagent',
      selfName: 'subagent',
      agentManager: {
        deliverTo: async (_sid: string, msg: Message) => {
          captured.delivered = msg;
          return { sessionId: _sid, runId: 'r', state: 'running', promise: Promise.resolve({} as never) } as never;
        },
      } as never,
      store: {
        getSession: async () =>
          session
            ? ({
                id: 'PARENT-001',
                title: session.title,
                ...(session.squadId !== undefined ? { squadId: session.squadId } : {}),
                ...(session.memberId !== undefined ? { memberId: session.memberId } : {}),
              } as never)
            : null,
      } as never,
      ...(memberStore ? { memberStore: memberStore as never } : {}),
      sessionDeps: {} as never,
    };
  }

  async function runWithStore(
    inputFields: Record<string, unknown>,
    sessionTitle: string | null,
  ): Promise<{ text: string }> {
    const captured = { delivered: null as Message | null };
    const ctx: ToolCtx = { config: { agentToolContext: makeRtcWithStore(captured, sessionTitle) } } as unknown as ToolCtx;
    const res = await sendMessageTool.run(inputFields as unknown as ToolInput, ctx);
    const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
    return { text: blocks.map((b) => b?.text ?? '').join('') };
  }

  async function runWithMember(
    inputFields: Record<string, unknown>,
    session: { title: string | null; squadId?: string; memberId?: string } | null,
    memberStore?: {
      getMember: (squadId: string, memberId: string) => Promise<{ name: string } | undefined>;
    },
  ): Promise<{ text: string }> {
    const captured = { delivered: null as Message | null };
    const ctx: ToolCtx = { config: { agentToolContext: makeRtcWithMember(captured, session, memberStore) } } as unknown as ToolCtx;
    const res = await sendMessageTool.run(inputFields as unknown as ToolInput, ctx);
    const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
    return { text: blocks.map((b) => b?.text ?? '').join('') };
  }

  it('target=parent 别名 → result JSON 含 targetName（从 session.title 解析）', async () => {
    const { text } = await runWithStore(
      { target: 'parent', content: [{ type: 'text', text: 'hi' }], needReply: false },
      'Darvin',
    );
    const parsed = JSON.parse(text);
    expect(parsed.messageId).toBeDefined();
    expect(parsed.targetName).toBe('Darvin');
  });

  it('target=AgentRef object 带 name → result JSON targetName 用 ref.name（优先于 session.title）', async () => {
    const { text } = await runWithStore(
      {
        target: { type: 'leader', sessionId: 'PARENT-001', name: 'boss' },
        content: [{ type: 'text', text: 'hi' }],
        needReply: false,
      },
      'should-not-use-title',
    );
    const parsed = JSON.parse(text);
    expect(parsed.targetName).toBe('boss');
  });

  it('session.title 为空 → result JSON 不含 targetName 字段（前端 fallback）', async () => {
    const { text } = await runWithStore(
      { target: 'parent', content: [{ type: 'text', text: 'hi' }], needReply: false },
      null,
    );
    const parsed = JSON.parse(text);
    expect(parsed.messageId).toBeDefined();
    expect(parsed.targetName).toBeUndefined();
  });

  // ── [v0.0.340 决策 1] 成员名权威源 = memberStore：target session 是 squad 成员 → 反查实时名 ──
  it('[v0.0.340] target 是 squad 成员（squadId+memberId）且 memberStore 反查有实时名 → targetName 用 member 名（优先于 title 快照）', async () => {
    const { text } = await runWithMember(
      { target: 'parent', content: [{ type: 'text', text: 'hi' }], needReply: false },
      { title: '旧名快照', squadId: 'SQ-1', memberId: 'MEM-1' },
      {
        getMember: async () => ({ name: '新名字' }),
      },
    );
    const parsed = JSON.parse(text);
    expect(parsed.targetName).toBe('新名字');
  });

  it('[v0.0.340] member 已删（getMember undefined）→ fallback session.title（不抛错）', async () => {
    const { text } = await runWithMember(
      { target: 'parent', content: [{ type: 'text', text: 'hi' }], needReply: false },
      { title: '旧名快照', squadId: 'SQ-1', memberId: 'MEM-GONE' },
      {
        getMember: async () => undefined,
      },
    );
    const parsed = JSON.parse(text);
    expect(parsed.targetName).toBe('旧名快照');
  });

  it('[v0.0.340] target 非 squad 成员（无 squadId/memberId，如 subagent）→ title fallback（不反查）', async () => {
    const { text } = await runWithMember(
      { target: 'parent', content: [{ type: 'text', text: 'hi' }], needReply: false },
      { title: 'subagent-title' },
      {
        getMember: async () => ({ name: '不应被使用' }),
      },
    );
    const parsed = JSON.parse(text);
    expect(parsed.targetName).toBe('subagent-title');
  });
});
