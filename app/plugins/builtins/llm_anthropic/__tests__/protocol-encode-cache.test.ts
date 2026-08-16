/**
 * protocol-encode cache control 单测
 * 参考:
 *   - specs/tech/agent/providers_and_models/anthropic_impl.md §4（cache control 2bp）
 *   - specs/tech/version_logs/v0.0.8/change_log.md §10
 *
 * 校验点：
 *   - encode 产出含 2 个 cache_control breakpoint（system 末 block + 最后 message 末 block）
 *   - string system 自动转 content block array（type:text + cache_control）
 *   - 无 system（无 role:system message）时跳过 system bp（只 1 bp 在最后 message）
 *   - ttl=ephemeral（无显式 ttl 字段）
 *   - task-1 已做的字段名对齐不被破坏（tool_call→tool_use 的 input 等）
 *   - messages 为空时只 system bp（无最后 message bp）
 */
import { describe, it, expect } from 'vitest';
import { encodeAnthropicMessages } from '../protocol-encode';
import type { CanonicalRequest } from '../../../../server/src/llm/protocol';
import type { ContentBlock, Message } from '../../../../server/src/llm/protocol-types';

/** 构造最小 CanonicalRequest（仅 messages + 最小 params） */
function req(messages: Message[]): CanonicalRequest {
  return {
    modelId: 'claude-test',
    messages,
    params: { maxTokens: 1024 },
  };
}

describe('encodeAnthropicMessages — cache control 2bp', () => {
  it('string system 自动转 content block array 且末 block 带 cache_control', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ];
    const body = encodeAnthropicMessages(req(messages));

    const system = body['system'] as Record<string, unknown>[];
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(1);
    expect(system[0]!).toMatchObject({
      type: 'text',
      text: '你是助手',
      cache_control: { type: 'ephemeral' },
    });
    // ttl 默认 ephemeral：不显式 ttl 字段
    expect(system[0]!.cache_control).not.toHaveProperty('ttl');
  });

  it('完整 encode 含恰好 2 个 cache_control breakpoint（system 末 + 最后 message 末）', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: '历史' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: '最后一块' },
        ],
      },
    ];
    const body = encodeAnthropicMessages(req(messages));

    // 统计 cache_control 出现次数
    const allBlocks: Record<string, unknown>[] = [];
    allBlocks.push(...(body['system'] as Record<string, unknown>[]));
    for (const m of body['messages'] as { content: Record<string, unknown>[] }[]) {
      allBlocks.push(...m.content);
    }
    const withCache = allBlocks.filter((b) => b.cache_control !== undefined);
    expect(withCache).toHaveLength(2);

    // bp#1: system 末 block
    const sysBlocks = body['system'] as Record<string, unknown>[];
    expect(sysBlocks[sysBlocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });

    // bp#2: 最后 message 最后 block
    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    const lastMsg = msgs[msgs.length - 1]!;
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    // 倒数第二个 block 不应有 cache_control
    expect(lastMsg.content[lastMsg.content.length - 2]!.cache_control).toBeUndefined();
  });

  it('无 system message 时只 1 个 bp（最后 message 末 block），body 无 system 字段', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const body = encodeAnthropicMessages(req(messages));

    expect(body['system']).toBeUndefined();

    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });

    // 全量仅 1 个 bp
    const allBlocks: Record<string, unknown>[] = [];
    for (const m of msgs) allBlocks.push(...m.content);
    const withCache = allBlocks.filter((b) => b.cache_control !== undefined);
    expect(withCache).toHaveLength(1);
  });

  it('messages 为空（仅 system）时只 system bp（无最后 message bp）', () => {
    const messages: Message[] = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }];
    const body = encodeAnthropicMessages(req(messages));

    const system = body['system'] as Record<string, unknown>[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });

    expect(body['messages']).toEqual([]);
  });

  it('cache_control 不破坏 task-1 字段名对齐（tool_call→tool_use input 等）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'tc1', name: 'read', arguments: { path: '/a' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: 'tc1', content: [{ type: 'text', text: 'r' }], isError: false },
        ],
      },
    ];
    const body = encodeAnthropicMessages(req(messages));
    const msgs = body['messages'] as { role: string; content: Record<string, unknown>[] }[];

    // [v0.0.25 BUG-002] encode 边界 role:tool → user（库内 Message 仍 role:tool）。
    // 倒数第一条原为 tool message，wire 映射后 role=user，其最后 block（tool_result）应被加 cache_control。
    const lastMsg = msgs[msgs.length - 1]!;
    expect(lastMsg.role).toBe('user');
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
    expect(lastBlock.type).toBe('tool_result');
    expect(lastBlock.tool_use_id).toBe('tc1'); // task-1 字段名对齐保留
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' }); // bp 注入
  });

  it('多 block message：仅最后 block 带 bp，前面 block 不带', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 's' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
          { type: 'text', text: 'c' },
        ],
      },
    ];
    const body = encodeAnthropicMessages(req(messages));
    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    const content = msgs[0]!.content;
    expect(content[0]!.cache_control).toBeUndefined();
    expect(content[1]!.cache_control).toBeUndefined();
    expect(content[2]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

/**
 * [v0.0.361 T5] 三断点体系（change_plan §1.3 老板 20:34 终版补丁）
 * wire body 断点齐三处：bp#1 system 末 + bp#T tools 末位 + bp#2 最末 message 最末 block。
 * Anthropic 上限 4 断点，三断点合规。三层各自锚定：
 *   system 段变更 → bp#T/bp#2 命中 tools+messages 前缀；
 *   tools 变更 → bp#1/bp#2 命中 system+messages；
 *   messages 每轮 append → bp#2 命中。
 */
describe('v0.0.361 T5 — 三断点体系（bp#1 system 末 + bp#T tools 末位 + bp#2 messages 末）', () => {
  /** 构造带 tools 的 request（makeRequest 无 tools 路径，独立构造） */
  function reqWithTools(tools: unknown[]): CanonicalRequest {
    return {
      modelId: 'claude-test',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
      ],
      params: { maxTokens: 1024 },
      tools,
    };
  }

  it('bp#T：tools 末位 tool 注入 cache_control，其余 tool 不带', () => {
    const body = encodeAnthropicMessages(
      reqWithTools([
        { name: 'read', description: '读文件', inputSchema: { type: 'object', properties: {} } },
        { name: 'write', description: '写文件', inputSchema: { type: 'object', properties: {} } },
        { name: 'bash', description: '跑命令', inputSchema: { type: 'object', properties: {} } },
      ]),
    );
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(3);
    // 末位 tool 带 cache_control（bp#T）
    expect(tools[2]!.cache_control).toEqual({ type: 'ephemeral' });
    // 前两个 tool 不带
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toBeUndefined();
  });

  it('bp#T：单 tool 时该 tool 即末位，带 cache_control', () => {
    const body = encodeAnthropicMessages(
      reqWithTools([{ name: 'todo', description: '待办', inputSchema: { type: 'object', properties: {} } }]),
    );
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('wire body 三断点计数（system 末 + tools 末位 + 最末 message 末 block）恰好 3', () => {
    const body = encodeAnthropicMessages(
      reqWithTools([
        { name: 'read', description: '读文件', inputSchema: { type: 'object', properties: {} } },
        { name: 'bash', description: '跑命令', inputSchema: { type: 'object', properties: {} } },
      ]),
    );

    // 统计全 wire body cache_control 出现次数（system blocks + tools + messages blocks）
    let count = 0;
    const system = body['system'] as Record<string, unknown>[];
    count += system.filter((b) => b.cache_control !== undefined).length;
    const tools = body['tools'] as Record<string, unknown>[];
    count += tools.filter((t) => t.cache_control !== undefined).length;
    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    for (const m of msgs) count += m.content.filter((b) => b.cache_control !== undefined).length;

    // 恰好 3 断点：bp#1 + bp#T + bp#2（Anthropic 上限 4，合规）
    expect(count).toBe(3);

    // 三处落位各自断言
    expect(system[system.length - 1]!.cache_control).toEqual({ type: 'ephemeral' }); // bp#1
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' }); // bp#T
    const lastMsg = msgs[msgs.length - 1]!;
    expect(
      lastMsg.content[lastMsg.content.length - 1]!.cache_control,
    ).toEqual({ type: 'ephemeral' }); // bp#2
  });

  it('无 tools 时退化为 2 断点（system 末 + 最末 message 末）——bp#T 不落', () => {
    const body = encodeAnthropicMessages(reqWithTools([]));
    expect(body['tools']).toBeUndefined();

    let count = 0;
    const system = body['system'] as Record<string, unknown>[];
    count += system.filter((b) => b.cache_control !== undefined).length;
    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    for (const m of msgs) count += m.content.filter((b) => b.cache_control !== undefined).length;
    expect(count).toBe(2);
  });

  it('bp#T 前缀稳定：tools 不变时两次 encode 的末位 tool 断点字节一致', () => {
    const tools = [
      { name: 'read', description: '读文件', inputSchema: { type: 'object', properties: {} } },
    ];
    const b1 = encodeAnthropicMessages(reqWithTools(tools));
    const b2 = encodeAnthropicMessages(reqWithTools(tools));
    const t1 = (b1['tools'] as Array<Record<string, unknown>>)[0]!;
    const t2 = (b2['tools'] as Array<Record<string, unknown>>)[0]!;
    expect(t1.cache_control).toEqual(t2.cache_control);
  });
});

/**
 * 背景：历史 reminder 块 append-only 全保留进 wire（drop 删除）+ bp#2 固定打最末
 * message 最末 block（避让扫描删除）。tool_result 带 reminder 不破坏 prompt caching——
 * 历史块进 transcript 后字节不变 → bp#2 前缀 = 稳定历史 + 本轮新块。
 * 校验点：
 *   1. 最末 tool 消息带 reminder：wire 保留该 reminder + bp#2 落在该 reminder block（最末 block）
 *   2. 多 tool 轮次各带 reminder（模拟长 run）：wire 全保留（历史块不 drop）
 *   3. reminder 位置不变时 bp#2 落点稳定（cache 前缀稳定段不变）
 */
describe('v0.0.361 T5 — tool 消息带 reminder 的 encode 配合（历史块保留 + bp#2 固定末位）', () => {
  /** 构造一个 tool 轮次：assistant tool_call → tool_result + reminder（isSystemReminder text block） */
  function toolTurn(toolCallId: string, resultText: string, reminderText: string): Message[] {
    return [
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: toolCallId, name: 'read', arguments: { path: '/a' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId, content: [{ type: 'text', text: resultText }], isError: false },
          // 块级 isSystemReminder 标记（text block 携带，wire 层不输出该字段）
          { type: 'text', text: reminderText, isSystemReminder: true },
        ],
      },
    ];
  }

  /** 取 wire messages 全部 text 文本（扁平） */
  function allTexts(body: ReturnType<typeof encodeAnthropicMessages>): string[] {
    const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
    return msgs.flatMap((m) => m.content.map((b) => (b.type === 'text' ? (b.text as string) : '')));
  }

  it('最末 tool 消息带 reminder：wire 保留该 reminder + bp#2 落在最末 reminder block', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      ...toolTurn('tc1', 'r1', '[squad:agents] 团队状态 v1'),
    ];
    const body = encodeAnthropicMessages(req(messages));
    const msgs = body['messages'] as { role: string; content: Record<string, unknown>[] }[];

    // 最末 wire message = tool_result + reminder（role tool→user 映射）
    const lastMsg = msgs[msgs.length - 1]!;
    expect(lastMsg.role).toBe('user');
    // ① 保留 reminder：wire 含 reminder 文本（历史块 append-only 全保留）
    expect(allTexts(body)).toContain('[squad:agents] 团队状态 v1');
    // ② bp#2 固定打最末 block（= reminder block，避让扫描已删）
    const reminderBlock = lastMsg.content.find(
      (b) => b.type === 'text' && b.text === '[squad:agents] 团队状态 v1',
    )!;
    expect(reminderBlock.cache_control).toEqual({ type: 'ephemeral' });
    // reminder 是最后一块（bp#2 落位于此）
    expect(lastMsg.content[lastMsg.content.length - 1]).toBe(reminderBlock);
    // tool_result 正文块（reminder 前一 block）无 cache_control
    const toolResultBlock = lastMsg.content.find((b) => b.type === 'tool_result')!;
    expect(toolResultBlock.cache_control).toBeUndefined();
  });

  it('多 tool 轮次各带 reminder（长 run）：wire 全保留（历史块不 drop）', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      ...toolTurn('tc1', 'r1', '[reminder] 第1轮'),
      ...toolTurn('tc2', 'r2', '[reminder] 第2轮'),
      ...toolTurn('tc3', 'r3', '[reminder] 第3轮'),
    ];
    const body = encodeAnthropicMessages(req(messages));
    const texts = allTexts(body);

    // [v0.0.361 T5] 历史 reminder 全保留进 wire（append-only；transcript 字节不变 → 前缀稳定）
    const reminderTexts = texts.filter((t) => t.startsWith('[reminder]'));
    expect(reminderTexts).toEqual(['[reminder] 第1轮', '[reminder] 第2轮', '[reminder] 第3轮']);
  });

  it('reminder 位置不变时 bp#2 落点稳定（cache 前缀稳定段不变）', () => {
    const mkMsgs = (reminderText: string): Message[] => [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      ...toolTurn('tc1', 'r1', reminderText),
    ];
    // reminder 文本变化但位置不变（始终是最后一块）→ 两次 encode 落点一致
    const b1 = encodeAnthropicMessages(req(mkMsgs('[reminder] v1')));
    const b2 = encodeAnthropicMessages(req(mkMsgs('[reminder] v2')));

    const locate = (body: ReturnType<typeof encodeAnthropicMessages>) => {
      const msgs = body['messages'] as { content: Record<string, unknown>[] }[];
      const last = msgs[msgs.length - 1]!;
      const cacheIdx = last.content.findIndex((b) => b.cache_control !== undefined);
      return {
        cacheIdx,
        cacheType: last.content[cacheIdx]?.type,
        contentLen: last.content.length,
        lastType: last.content[last.content.length - 1]?.type,
      };
    };
    expect(locate(b1)).toEqual(locate(b2));
    // [v0.0.361 T5] 落点 = 最末 block（reminder text block），恒定不避让
    expect(locate(b1).cacheType).toBe('text');
    expect(locate(b1).cacheIdx).toBe(locate(b1).contentLen - 1);
    expect(locate(b1).lastType).toBe('text'); // reminder 块（text）
  });
});
