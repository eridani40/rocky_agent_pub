/**
 * rocky_context plugin assemble_mapper(2) 单测（v0.0.66 §2.4 删 buffer_reader + system_prompt 后；
 * v0.0.173 删 prev_snapshot mapper 后）
 * 参考: specs/tech/agent/context_and_memory/[P0]context_assemble_detail.md §4
 *       specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.2/§4.3
 *
 * 覆盖：
 *   - transcript_reader：读最近 N 条（limit config 边界）；无 store → 空贡献
 *   - summary_reader：读 summary；无 store → 空贡献；无 summary → null
 *     [v0.0.185] 追加：有 summaryUpTo → 同取 head/tail 锚定候选（takeFromStart/upToId + candidateLimit）
 *
 * [v0.0.66 §2.4] system_prompt impl + buffer_reader impl 已删（UT 已删）。
 * [v0.0.173] prev_snapshot mapper 已删（snapshot 永远 rebuild，不再需要上一版 messages 作增量基础）。
 */
import { describe, it, expect } from 'vitest';
import { ulid } from '../../../../server/src/config/ulid';
import type { Message } from '../../../../server/src/message/types';
import TranscriptReaderMapper from '../assemble/transcript_reader';
import SummaryReaderMapper from '../assemble/summary_reader';

/** 造业务 message */
function msg(role: Message['role'], text: string, id?: string): Message {
  return {
    id: id ?? ulid(),
    sessionId: 'sid',
    role,
    content: [{ type: 'text', text }],
  };
}

/** 造假 SessionStore（只实现 getMessages/getSummary） */
function fakeStore(opts: {
  items?: Message[];
  summary?: { version: number; summaryUpTo: string | null; content: string | null } | null;
}) {
  return {
    getMessages: async () => ({ items: opts.items ?? [], hasMore: false }),
    getSummary: async () => opts.summary ?? null,
  };
}

/** 造假 config */
function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sid',
    systemPrompt: 'FALLBACK-PROMPT',
    client: { contextWindow: 100000 },
    modelId: 'm',
    ...overrides,
  } as never;
}

describe('assemble_mapper — transcript_reader', () => {
  it('读 store.getMessages 贡献 transcript', async () => {
    const items = [msg('user', 'a'), msg('assistant', 'b')];
    const ctx = {
      config: fakeConfig(),
      prevSnapshot: null,
      store: fakeStore({ items }) as never,
    };
    const out = await new TranscriptReaderMapper('transcript_reader', {}).map(ctx);
    expect(out.transcript).toEqual(items);
  });

  it('limit config 传到 getMessages', async () => {
    let capturedLimit = 0;
    const store = {
      getMessages: async (_sid: string, range: { limit: number }) => {
        capturedLimit = range.limit;
        return { items: [], hasMore: false };
      },
      getSummary: async () => null,
    };
    await new TranscriptReaderMapper('transcript_reader', { limit: 50 }).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(capturedLimit).toBe(50);
  });

  it('[v0.0.83] ctx.opts（runId）透传到 getMessages 第 3 参（forked per-run 隔离读桶）', async () => {
    let capturedOpts: unknown = 'not-set';
    const store = {
      getMessages: async (_sid: string, _range: { limit: number }, opts?: unknown) => {
        capturedOpts = opts;
        return { items: [], hasMore: false };
      },
      getSummary: async () => null,
    };
    await new TranscriptReaderMapper('transcript_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
      opts: { runId: 'run-summary-1' },
    } as never);
    expect(capturedOpts).toEqual({ runId: 'run-summary-1' });
  });

  it('缺省 limit=500', async () => {
    let capturedLimit = 0;
    const store = {
      getMessages: async (_sid: string, range: { limit: number }) => {
        capturedLimit = range.limit;
        return { items: [], hasMore: false };
      },
      getSummary: async () => null,
    };
    await new TranscriptReaderMapper('transcript_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(capturedLimit).toBe(500);
  });

  it('无 store → 空贡献', async () => {
    const out = await new TranscriptReaderMapper('transcript_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
    });
    expect(out.transcript).toBeUndefined();
  });
});

describe('assemble_mapper — summary_reader', () => {
  it('读 store.getSummary 贡献 summary', async () => {
    const summary = { version: 3, summaryUpTo: 'm5', content: 'SUMMARY-TEXT' };
    const ctx = {
      config: fakeConfig(),
      prevSnapshot: null,
      store: fakeStore({ summary }) as never,
    };
    const out = await new SummaryReaderMapper('summary_reader', {}).map(ctx);
    expect(out.summary).toEqual(summary);
  });

  it('无 summary → summary=null', async () => {
    const ctx = {
      config: fakeConfig(),
      prevSnapshot: null,
      store: fakeStore({ summary: null }) as never,
    };
    const out = await new SummaryReaderMapper('summary_reader', {}).map(ctx);
    expect(out.summary).toBeNull();
  });

  it('无 store → 空贡献', async () => {
    const out = await new SummaryReaderMapper('summary_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
    });
    expect(out.summary).toBeUndefined();
  });

  // —— [v0.0.185] head/tail 锚定候选（单次 getSummary 读 → 候选与 summary 版本一致）——
  it('[v0.0.185] 有 summaryUpTo → 贡献 head/tail 候选（head=takeFromStart 锚定真第一条 / tail=upToId 锚定）', async () => {
    const ranges: Record<string, unknown>[] = [];
    const head = [msg('user', 'h0', 'h0'), msg('assistant', 'h1', 'h1')];
    const tail = [msg('user', 't0', 't0')];
    const store = {
      getMessages: async (_sid: string, range: Record<string, unknown>) => {
        ranges.push(range);
        // 第一次调用 = head 候选（takeFromStart），第二次 = tail 候选
        return { items: ranges.length === 1 ? head : tail, hasMore: false };
      },
      getSummary: async () => ({ version: 2, summaryUpTo: 'm9', content: 'S' }),
    };
    const out = await new SummaryReaderMapper('summary_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(out.headCandidates).toEqual(head);
    expect(out.tailCandidates).toEqual(tail);
    // head 候选：takeFromStart=true + upToId=summaryUpTo + limit=默认 500
    expect(ranges[0]).toEqual({ upToId: 'm9', limit: 500, takeFromStart: true });
    // tail 候选：upToId=summaryUpTo + limit（无 takeFromStart → 取末尾）
    expect(ranges[1]).toEqual({ upToId: 'm9', limit: 500 });
  });

  it('[v0.0.185] candidateLimit config 透传到候选 getMessages', async () => {
    const limits: number[] = [];
    const store = {
      getMessages: async (_sid: string, range: { limit: number }) => {
        limits.push(range.limit);
        return { items: [], hasMore: false };
      },
      getSummary: async () => ({ version: 1, summaryUpTo: 'm1', content: 'S' }),
    };
    await new SummaryReaderMapper('summary_reader', { candidateLimit: 42 }).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(limits).toEqual([42, 42]);
  });

  it('[v0.0.185] summaryUpTo=null → 不取候选（getMessages 不调）', async () => {
    let calls = 0;
    const store = {
      getMessages: async () => {
        calls++;
        return { items: [], hasMore: false };
      },
      getSummary: async () => ({ version: 1, summaryUpTo: null, content: 'S' }),
    };
    const out = await new SummaryReaderMapper('summary_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(calls).toBe(0);
    expect(out.headCandidates).toBeUndefined();
    expect(out.tailCandidates).toBeUndefined();
  });

  it('[v0.0.185] 无 summary（forked in_memory 恒 null）→ 不取候选', async () => {
    let calls = 0;
    const store = {
      getMessages: async () => {
        calls++;
        return { items: [], hasMore: false };
      },
      getSummary: async () => null,
    };
    const out = await new SummaryReaderMapper('summary_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(calls).toBe(0);
    expect(out.summary).toBeNull();
    expect(out.headCandidates).toBeUndefined();
  });
});

// [v0.0.66 §2.4] system_prompt + buffer_reader impl 已删（UT 已删，design §2.4）
// [v0.0.173] prev_snapshot mapper 已删（UT 整块移除，snapshot 永远 rebuild）
