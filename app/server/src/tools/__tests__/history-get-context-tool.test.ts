/**
 * history_get_context 工具单测（UT）
 * 参考: specs/tech/agent/tools/[P1]history_get_context_tool.md §2/§3/§4/§6（契约 + around 实现）
 *       specs/tech/version_logs/v0.0.126/change_plan.md UT 关键覆盖点
 *
 * 覆盖：
 *   - sessionId + messageId required（缺 → 错误提示，不抛错）
 *   - around 组合调用（beforeId=messageId, limit=before + fromId=messageId, limit=after+1）
 *   - 空 result → 友好提示（messageId 不存在）
 *   - formatContextWindow 锚点标记 + 文本透出
 *   - 截断：单 message > 8k chars 截断 + offload 标记
 *   - 截断：tool_result > 25k chars 截断
 *   - image block → [image: omitted]
 *   - historyToolDeps 缺失 → RUNTIME_ERROR
 *   - definition.name='history_get_context' + inputSchema.required=['sessionId','messageId']
 *
 * 隔离策略：mock sessionStore.getMessages（捕获 beforeId/fromId/limit 入参）。
 */
import { describe, it, expect } from 'vitest';
import { historyGetContextTool, formatContextWindow } from '../history-get-context-tool';
import type { ToolCtx, ToolRunResult } from '../types';
import type { Message, ContentBlock } from '../../message/types';

// ── helpers ──────────────────────────────────────────────────────────

/** mock sessionStore.getMessages —— 捕获 range 入参 + 返回固定 items */
function mockSessionStore(
  beforeResult: { items: Message[]; hasMore: boolean },
  afterResult: { items: Message[]; hasMore: boolean },
) {
  const calls: Array<{ range: Record<string, unknown> }> = [];
  const sessionStore = {
    async getMessages(
      _sessionId: string,
      range?: { beforeId?: string; fromId?: string; upToId?: string; limit?: number },
    ): Promise<{ items: Message[]; hasMore: boolean }> {
      calls.push({ range: range ?? {} });
      // 按 range 形态分发：beforeId 在 → before；fromId 在 → after
      if (range?.beforeId) return beforeResult;
      if (range?.fromId) return afterResult;
      return { items: [], hasMore: false };
    },
    calls,
  };
  return sessionStore;
}

/** 构造 ToolCtx */
function ctxOf(overrides: {
  sessionStore?: ReturnType<typeof mockSessionStore>;
  omitDeps?: boolean;
} = {}): ToolCtx {
  const cfg: Record<string, unknown> = {
    tools: [],
    sessionId: 'S-CURRENT',
  };
  if (!overrides.omitDeps) {
    cfg.historyToolDeps = {
      searchEngine: { search: () => [] }, // 不用，占位
      sessionStore: overrides.sessionStore ?? mockSessionStore({ items: [], hasMore: false }, { items: [], hasMore: false }),
    };
  }
  return {
    config: cfg as unknown as ToolCtx['config'],
    workdir: '/tmp/test',
  };
}

function textOf(r: ToolRunResult): string {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe('text');
  return (r.content[0] as { type: 'text'; text: string }).text;
}

/** 构造一条 Message */
function msg(id: string, role: 'user' | 'assistant', content: ContentBlock[]): Message {
  return { id, sessionId: 'S-001', role, content };
}

// ── 测试数据 ──────────────────────────────────────────────────────────

const BEFORE_MSGS: Message[] = [
  msg('01HV0000000000000000000001', 'user', [{ type: 'text', text: '前一条用户消息' }]),
  msg('01HV0000000000000000000002', 'assistant', [{ type: 'text', text: '前一条助手回复' }]),
];
const ANCHOR_MSG: Message = msg(
  '01HV0000000000000000000003',
  'user',
  [{ type: 'text', text: '锚点消息' }],
);
const AFTER_MSGS: Message[] = [
  ANCHOR_MSG,
  msg('01HV0000000000000000000004', 'assistant', [{ type: 'text', text: '后一条助手回复' }]),
];

// ── tests ─────────────────────────────────────────────────────────────

describe('history_get_context tool', () => {
  describe('definition', () => {
    it('name + required 对齐 spec §2', () => {
      expect(historyGetContextTool.definition.name).toBe('history_get_context');
      const schema = historyGetContextTool.definition.inputSchema as Record<string, unknown>;
      expect(schema.required).toEqual(['sessionId', 'messageId']);
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.sessionId).toBeDefined();
      expect(props.messageId).toBeDefined();
      expect(props.before).toBeDefined();
      expect(props.after).toBeDefined();
    });

    it('description 提示配合 history_search 使用', () => {
      expect(historyGetContextTool.definition.description).toContain('history_search');
    });
  });

  describe('sessionId/messageId required', () => {
    it('两者都缺 → 错误提示', async () => {
      const r = await historyGetContextTool.run({}, ctxOf());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('sessionId 和 messageId 必填');
    });

    it('仅 sessionId → 错误提示', async () => {
      const r = await historyGetContextTool.run({ sessionId: 'S-001' }, ctxOf());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('sessionId 和 messageId 必填');
    });

    it('非 string 入参 → 错误提示', async () => {
      const r = await historyGetContextTool.run(
        { sessionId: 123, messageId: 'M' },
        ctxOf(),
      );
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('必填');
    });
  });

  describe('around 组合调用（核心 — 不改 MessageRange）', () => {
    it('before 段调 getMessages(beforeId=messageId, limit=before)', async () => {
      const ss = mockSessionStore(
        { items: BEFORE_MSGS, hasMore: false },
        { items: AFTER_MSGS, hasMore: false },
      );
      await historyGetContextTool.run(
        { sessionId: 'S-001', messageId: '01HV0000000000000000000003', before: 5, after: 5 },
        ctxOf({ sessionStore: ss }),
      );
      expect(ss.calls).toHaveLength(2);
      const beforeCall = ss.calls.find((c) => c.range.beforeId);
      expect(beforeCall).toBeDefined();
      expect(beforeCall!.range.beforeId).toBe('01HV0000000000000000000003');
      expect(beforeCall!.range.limit).toBe(5);
    });

    it('after 段调 getMessages(fromId=messageId, limit=after+1)', async () => {
      const ss = mockSessionStore(
        { items: BEFORE_MSGS, hasMore: false },
        { items: AFTER_MSGS, hasMore: false },
      );
      await historyGetContextTool.run(
        { sessionId: 'S-001', messageId: '01HV0000000000000000000003', before: 5, after: 5 },
        ctxOf({ sessionStore: ss }),
      );
      const afterCall = ss.calls.find((c) => c.range.fromId);
      expect(afterCall).toBeDefined();
      expect(afterCall!.range.fromId).toBe('01HV0000000000000000000003');
      expect(afterCall!.range.limit).toBe(6); // after + 1（含锚点）
    });

    it('before/after 默认 5/5', async () => {
      const ss = mockSessionStore(
        { items: BEFORE_MSGS, hasMore: false },
        { items: AFTER_MSGS, hasMore: false },
      );
      await historyGetContextTool.run(
        { sessionId: 'S-001', messageId: '01HV0000000000000000000003' },
        ctxOf({ sessionStore: ss }),
      );
      const beforeCall = ss.calls.find((c) => c.range.beforeId);
      const afterCall = ss.calls.find((c) => c.range.fromId);
      expect(beforeCall!.range.limit).toBe(5);
      expect(afterCall!.range.limit).toBe(6);
    });

    it('before/after 上限 50（spec §2 inputSchema.maximum=50）', async () => {
      const ss = mockSessionStore(
        { items: BEFORE_MSGS, hasMore: false },
        { items: AFTER_MSGS, hasMore: false },
      );
      await historyGetContextTool.run(
        { sessionId: 'S-001', messageId: '01HV0000000000000000000003', before: 100, after: 100 },
        ctxOf({ sessionStore: ss }),
      );
      const beforeCall = ss.calls.find((c) => c.range.beforeId);
      const afterCall = ss.calls.find((c) => c.range.fromId);
      expect(beforeCall!.range.limit).toBe(50);
      expect(afterCall!.range.limit).toBe(51); // 50 + 1
    });

    it('合并去重保 id 升序（beforeRes 不含锚点，afterRes 含锚点）', async () => {
      const ss = mockSessionStore(
        { items: BEFORE_MSGS, hasMore: false },
        { items: AFTER_MSGS, hasMore: false },
      );
      const r = await historyGetContextTool.run(
        { sessionId: 'S-001', messageId: '01HV0000000000000000000003' },
        ctxOf({ sessionStore: ss }),
      );
      const text = textOf(r);
      // 按 [id 开头的行（角色 tag 行）查找，避免 header msg=... 干扰
      const tagLines = text.split('\n').filter((l) => l.startsWith('['));
      // 4 条角色 tag 行，按 id 升序
      expect(tagLines).toHaveLength(4);
      expect(tagLines[0]).toContain('01HV0000000000000000000001');
      expect(tagLines[1]).toContain('01HV0000000000000000000002');
      expect(tagLines[2]).toContain('01HV0000000000000000000003'); // 锚点
      expect(tagLines[3]).toContain('01HV0000000000000000000004');
    });
  });

  describe('空 result', () => {
    it('messageId 不存在 → 友好提示（不抛错）', async () => {
      const ss = mockSessionStore(
        { items: [], hasMore: false },
        { items: [], hasMore: false },
      );
      const r = await historyGetContextTool.run(
        { sessionId: 'S-001', messageId: 'NOT-EXIST' },
        ctxOf({ sessionStore: ss }),
      );
      expect(r.isError).toBe(false);
      expect(textOf(r)).toContain('未找到 messageId=NOT-EXIST');
    });
  });

  describe('formatContextWindow 锚点 + 截断', () => {
    it('锚点 message 行末标 *', () => {
      const text = formatContextWindow([...BEFORE_MSGS, ANCHOR_MSG], '01HV0000000000000000000003');
      // header 行也含 messageId（msg=...），需找 [role=...] 行
      const anchorLine = text
        .split('\n')
        .find((l) => l.startsWith('[') && l.includes('01HV0000000000000000000003'));
      expect(anchorLine).toBeDefined();
      expect(anchorLine!.endsWith('*')).toBe(true);
      // 非锚点行末尾不标 *
      const nonAnchorLine = text
        .split('\n')
        .find((l) => l.startsWith('[') && l.includes('01HV0000000000000000000001'));
      expect(nonAnchorLine!.endsWith('*')).toBe(false);
    });

    it('单 message > 8k chars → 截断 + offload 标记', () => {
      const big = 'x'.repeat(8001);
      const m = msg('01HV...BIG', 'user', [{ type: 'text', text: big }]);
      const text = formatContextWindow([m], '01HV...BIG');
      expect(text).toContain('已截断');
      expect(text).toContain('offloaded');
    });

    it('单 message 恰好 8k chars → 不截断', () => {
      const exact = 'x'.repeat(8000);
      const m = msg('01HV...EXACT', 'user', [{ type: 'text', text: exact }]);
      const text = formatContextWindow([m], '01HV...EXACT');
      expect(text).not.toContain('已截断');
    });

    it('image block → [image: omitted]', () => {
      const m = msg('01HV...IMG', 'user', [
        { type: 'text', text: '前文' },
        { type: 'image', source: { kind: 'base64', data: 'ABC' }, mediaType: 'image/png' },
      ]);
      const text = formatContextWindow([m], '01HV...IMG');
      expect(text).toContain('[image: omitted]');
      // image data 不透出
      expect(text).not.toContain('ABC');
    });

    it('tool_result > 25k chars → 截断 + 标记', () => {
      // 用短 prefix text 让 message 总长不超过 8k（避免整体截断吃掉 tool_result 标记）
      const big = 'y'.repeat(25001);
      const m = msg('01HV...TR', 'assistant', [
        { type: 'text', text: 'result:' },
        {
          type: 'tool_result',
          toolCallId: 'TC-1',
          content: [{ type: 'text', text: big }],
          isError: false,
        } as ContentBlock,
      ]);
      const text = formatContextWindow([m], '01HV...TR');
      expect(text).toContain('tool_result 超');
      expect(text).toContain('已截断');
      // 锚点行也应有标记（formatContextWindow 锚点 *
      expect(text).toContain('role=assistant] *');
    });

    it('tool_call block 结构化透出（name + arguments）', () => {
      const m = msg('01HV...TC', 'assistant', [
        {
          type: 'tool_call',
          id: 'TC-1',
          name: 'web_search',
          arguments: { query: 'test' },
        } as ContentBlock,
      ]);
      const text = formatContextWindow([m], '01HV...TC');
      expect(text).toContain('<tool_use name=web_search>');
      expect(text).toContain('"query":"test"');
      expect(text).toContain('</tool_use>');
    });

    it('reasoning / usage block 不透出', () => {
      const m = msg('01HV...RU', 'assistant', [
        { type: 'reasoning', text: '内部思考' } as ContentBlock,
        { type: 'usage', usage: { total_tokens: 100 } } as ContentBlock,
        { type: 'text', text: '正文' },
      ]);
      const text = formatContextWindow([m], '01HV...RU');
      expect(text).not.toContain('内部思考');
      expect(text).not.toContain('total_tokens');
      expect(text).toContain('正文');
    });
  });

  describe('historyToolDeps 缺失', () => {
    it('未注入 → RUNTIME_ERROR', async () => {
      const r = await historyGetContextTool.run(
        { sessionId: 'S-001', messageId: 'M-1' },
        ctxOf({ omitDeps: true }),
      );
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('historyToolDeps not injected');
    });
  });
});
