/**
 * rocky_context plugin ingest handler 单测（v0.0.66 §2.4 删 buffer_sink 后剩 4 impl 中测 3 + store_sink）
 * 参考: specs/tech/agent/context_and_memory/[P0]context_ingest_detail.md §3/§4
 *       specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.1/§4.1/§4.2
 *
 * 覆盖：
 *   - query_truncate：阈值边界（< 阈值不动 / > 阈值截断 + rawRef）/ 非用户角色消息不动 / cfg 覆盖默认值
 *   - tool_result_truncate：阈值边界 / 非工具角色消息不动 / 多个 tool_result 块
 *   - system_reminder_injector：空链不动 / 末尾用户消息追加 reminder 块 / 末尾非用户消息不动 / runner 缺失不动
 *   - [v0.0.49 D15] store_sink：写 ctx.store / 无 store 时 no-op / 原样返回 messages
 *
 * [v0.0.66 §2.4] buffer_sink 已删（store 扩展点取代）；相关 UT 已删。
 */
import { describe, it, expect, vi } from 'vitest';
import QueryTruncateHandler from '../ingest/query_truncate';
import ToolResultTruncateHandler from '../ingest/tool_result_truncate';
import SystemReminderInjectorHandler, {
  formatReminders,
} from '../ingest/system_reminder_injector';
import StoreSinkHandler from '../ingest/store_sink';
import type { Message } from '../../../../server/src/message/types';
import type { IngestCtx } from '../types';

/** 造一条 message */
function mkMsg(
  id: string,
  role: 'user' | 'assistant' | 'tool' | 'system',
  text: string,
): Message {
  return {
    id,
    sessionId: 's1',
    role,
    content: [{ type: 'text', text }],
  };
}

/** [v0.0.33.3] 造一条 a2a message（role=user + sender.source='agent'）测触发扩展 */
function mkA2AMsg(id: string, text: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content: [{ type: 'text', text }],
    sender: { source: 'agent', agent: { ref: { type: 'mate', sessionId: 'mate-1', name: 'bob' }, needReply: false } },
  } as unknown as Message;
}

/** 造一条带 tool_result 的 tool 消息 */
function mkToolMsg(id: string, toolCallId: string, text: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolCallId,
        isError: false,
        content: [{ type: 'text', text }],
      },
    ],
  };
}

describe('query_truncate', () => {
  it('短 query（< 阈值）不动', () => {
    const h = new QueryTruncateHandler('query_truncate', {
      queryTruncateChars: 8000,
    });
    const short = mkMsg('m1', 'user', 'hello');
    const out = h.handle([short], { config: {} as never });
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out[0]!.metadata).toBeUndefined();
  });

  it('长 user query（> 阈值）截断 + 记 rawRef', () => {
    const h = new QueryTruncateHandler('query_truncate', {
      queryTruncateChars: 10,
    });
    const long = mkMsg('m1', 'user', 'a'.repeat(50));
    const out = h.handle([long], { config: {} as never });
    const text = (out[0]!.content[0] as { text: string }).text;
    // 截断版含阈值（10）开头 + 尾标；开头部分应为 10 个 a
    expect(text.startsWith('a'.repeat(10))).toBe(true);
    expect(text).toContain('[query truncated');
    // 截断版不含原始消息第 11 个 a 之后的内容（除尾标外）
    expect(text).not.toContain('a'.repeat(11));
    expect(out[0]!.metadata?.rawRef).toBe('raw:m1');
  });

  it('长 assistant 消息（非 user role）不动', () => {
    const h = new QueryTruncateHandler('query_truncate', {
      queryTruncateChars: 5,
    });
    const a = mkMsg('m1', 'assistant', 'a'.repeat(100));
    const out = h.handle([a], { config: {} as never });
    expect((out[0]!.content[0] as { text: string }).text).toBe('a'.repeat(100));
  });

  it('cfg 缺省 = 8000', () => {
    const h = new QueryTruncateHandler('query_truncate', {});
    // 用 reflect 检私有字段
    const cfg = (h as unknown as { queryTruncateChars: number }).queryTruncateChars;
    expect(cfg).toBe(8000);
  });
});

describe('tool_result_truncate', () => {
  it('短 tool_result（< 阈值）不动', () => {
    const h = new ToolResultTruncateHandler('tool_result_truncate', {
      toolResultTruncateChars: 25000,
    });
    const m = mkToolMsg('t1', 'call-1', 'short result');
    const out = h.handle([m], { config: {} as never });
    expect(out).toHaveLength(1);
    const tr = out[0]!.content[0] as { type: string; content: unknown[] };
    expect(tr.content).toEqual([{ type: 'text', text: 'short result' }]);
  });

  it('长 tool_result（> 阈值）截断 + 记 toolResultRef', () => {
    const h = new ToolResultTruncateHandler('tool_result_truncate', {
      toolResultTruncateChars: 10,
    });
    const m = mkToolMsg('t1', 'call-1', 'x'.repeat(500));
    const out = h.handle([m], { config: {} as never });
    const tr = out[0]!.content[0] as {
      type: string;
      content: { type: string; text: string }[];
    };
    expect(tr.content[0]!.text.length).toBeLessThan(500);
    expect(tr.content[0]!.text).toContain('[tool_result truncated');
    expect(out[0]!.metadata?.toolResultRef).toBe('tool_result:call-1');
  });

  it('非 tool 角色消息不动', () => {
    const h = new ToolResultTruncateHandler('tool_result_truncate', {
      toolResultTruncateChars: 5,
    });
    const u = mkMsg('u1', 'user', 'a'.repeat(100));
    const out = h.handle([u], { config: {} as never });
    expect(out[0]!.content[0]).toEqual({ type: 'text', text: 'a'.repeat(100) });
  });

  it('cfg 缺省 = 25000', () => {
    const h = new ToolResultTruncateHandler('tool_result_truncate', {});
    const cfg = (h as unknown as { toolResultTruncateChars: number })
      .toolResultTruncateChars;
    expect(cfg).toBe(25000);
  });
});

describe('system_reminder_injector', () => {
  it('空 reminder → 不动 messages', () => {
    const h = new SystemReminderInjectorHandler('system_reminder_injector', {});
    const m = mkMsg('u1', 'user', 'hi');
    const out = h.handle([m], {
      config: {} as never,
      reminderRunner: () => [],
    });
    expect(out[0]!.content).toHaveLength(1);
  });

  it('末尾 user message + 有 reminder → 追加 reminder block（块级 isSystemReminder 唯一权威）', () => {
    const h = new SystemReminderInjectorHandler('system_reminder_injector', {});
    const m = mkMsg('u1', 'user', 'hi');
    const out = h.handle([m], {
      config: {} as never,
      reminderRunner: () => [{ id: 'env', content: 'app=dev', tier: 'info' }],
    });
    expect(out[0]!.content).toHaveLength(2);
    expect((out[0]!.content[1] as { text: string }).text).toContain('app=dev');
    // [v0.0.50] 块级 TextBlock.isSystemReminder 唯一权威
    expect((out[0]!.content[1] as { isSystemReminder?: boolean }).isSystemReminder).toBe(true);
    // [v0.0.50] 消息级 metadata.isSystemReminder 已废止（不应出现）
    expect(out[0]!.metadata?.isSystemReminder).toBeUndefined();
  });

  it('末尾非 user message → 不动', () => {
    const h = new SystemReminderInjectorHandler('system_reminder_injector', {});
    const a = mkMsg('a1', 'assistant', 'hi');
    const out = h.handle([a], {
      config: {} as never,
      reminderRunner: () => [{ id: 'env', content: 'app=dev' }],
    });
    expect(out[0]!.content).toHaveLength(1);
  });

  it('无 reminderRunner（ctx 缺失）→ 不动', () => {
    const h = new SystemReminderInjectorHandler('system_reminder_injector', {});
    const m = mkMsg('u1', 'user', 'hi');
    const out = h.handle([m], { config: {} as never });
    expect(out[0]!.content).toHaveLength(1);
  });

  it('formatReminders：warn tier 加 [warn] 标记', () => {
    const text = formatReminders([
      { id: 'env', content: 'app=dev', tier: 'info' },
      { id: 'err', content: 'oops', tier: 'warn' },
    ]);
    expect(text).toContain('[system_reminder]');
    expect(text).toContain('- app=dev');
    expect(text).toContain('- [warn] oops');
  });

  it('空 messages 数组 → 不动（无 throw）', () => {
    const h = new SystemReminderInjectorHandler('system_reminder_injector', {});
    const out = h.handle([], {
      config: {} as never,
      reminderRunner: () => [{ id: 'env', content: 'x' }],
    });
    expect(out).toEqual([]);
  });

  it('[v0.0.33.3] 末尾 a2a message（sender.source=agent）→ 触发 reminder（squad 协作场景）', () => {
    const h = new SystemReminderInjectorHandler('system_reminder_injector', {});
    const m = mkA2AMsg('a2a-1', 'from mate');
    const out = h.handle([m], {
      config: {} as never,
      reminderRunner: () => [{ id: 'squad_charter', content: '[squad:charter] ...' }],
    });
    expect(out[0]!.content).toHaveLength(2);
    expect((out[0]!.content[1] as { text: string }).text).toContain('[squad:charter]');
    // [v0.0.50] 块级 TextBlock.isSystemReminder 唯一权威；消息级 metadata 已废止
    expect((out[0]!.content[1] as { isSystemReminder?: boolean }).isSystemReminder).toBe(true);
    expect(out[0]!.metadata?.isSystemReminder).toBeUndefined();
  });
});

describe('[v0.0.49 D15 UT-EXT] store_sink — default scope 专属汇（v0.0.66 forked 复用）', () => {
  /** 造 mock SessionStore（仅 spy appendMessages，验证 store_sink 写库语义） */
  function mockStore(): { store: { appendMessages: ReturnType<typeof vi.fn> }; appendMessages: ReturnType<typeof vi.fn> } {
    const appendMessages = vi.fn(async () => {
      /* noop */
    });
    return { store: { appendMessages } as unknown as IngestCtx['store'], appendMessages };
  }

  it('有 ctx.store → 调 store.appendMessages(sessionId, messages, opts) 写库 + 原样返回 messages', async () => {
    const h = new StoreSinkHandler('store_sink', {});
    const { store, appendMessages } = mockStore();
    const cfg = { sessionId: 'sess-default' } as never;
    const m1 = mkMsg('m1', 'user', 'hi');
    const m2 = mkMsg('m2', 'assistant', 'hello');
    const out = await h.handle([m1, m2], { config: cfg, store });
    // 原样返回（不修改 messages）
    expect(out).toEqual([m1, m2]);
    // store_sink 写库：appendMessages 被调一次，参 1 = sessionId，参 2 = 原 messages，参 3 = ctx.opts（缺省 undefined）
    expect(appendMessages).toHaveBeenCalledTimes(1);
    expect(appendMessages).toHaveBeenCalledWith('sess-default', [m1, m2], undefined);
  });

  it('[v0.0.83] ctx.opts 透传：runId 作为 appendMessages 第 3 参（forked per-run 隔离）', async () => {
    const h = new StoreSinkHandler('store_sink', {});
    const { store, appendMessages } = mockStore();
    const cfg = { sessionId: 'sess-forked' } as never;
    const m1 = mkMsg('m1', 'user', 'hi');
    await h.handle([m1], { config: cfg, store, opts: { runId: 'run-summary-1' } });
    // store_sink 透传 ctx.opts → appendMessages 第 3 参 = { runId }
    expect(appendMessages).toHaveBeenCalledWith('sess-forked', [m1], { runId: 'run-summary-1' });
  });

  it('无 ctx.store（forked scope 不注入 / UT 未注入）→ 不动 messages（no-op 防御性 fallback）', async () => {
    const h = new StoreSinkHandler('store_sink', {});
    const m1 = mkMsg('m1', 'user', 'hi');
    // ctx 不含 store 字段（forked ingest 不注入；forked chain 也已 disable store_sink，双重保证）
    const out = await h.handle([m1], { config: {} as never });
    expect(out).toEqual([m1]);
  });

  it('空 messages 数组 → 仍透传调 appendMessages([])（不拦空批）', async () => {
    const h = new StoreSinkHandler('store_sink', {});
    const { store, appendMessages } = mockStore();
    const out = await h.handle([], { config: {} as never, store });
    expect(out).toEqual([]);
    // 空数组 → 仍调 appendMessages（语义：store.appendMessages([]) 是 no-op，store_sink 透传不拦）
    expect(appendMessages).toHaveBeenCalledTimes(1);
    expect(appendMessages).toHaveBeenCalledWith(undefined, [], undefined);
  });
});
