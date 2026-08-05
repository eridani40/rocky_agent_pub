/**
 * base_builder v0.0.81.compaction_bug 单测（D：summary 1-block-3-sections + assemble budget）
 * 参考: specs/tech/version_logs/v0.0.81.compaction_bug/change_plan.md §2（变更 D）
 *
 * 覆盖：
 *   - summary block 是 **1 个 text content block**（非多 block）
 *   - 文本 3 段（preamble + head + tail）；head/tail 含 msgid+role+content
 *   - head∩tail 去重（head 优先）
 *   - recent 新→旧放置 + budget cap（超 budget 丢最旧）
 *   - estimatedOutput 计入 budget（budget_tokens = 0.95×window − estimatedOutput）
 *   - appConfig context.maxOutputTokens 覆盖默认 20000（[v0.0.186] 源 devConfig→appConfig 修正）
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import BaseBuilderReducer from '../assemble/base_builder';

function fakeConfig(contextWindow = 100000, appConfig?: unknown) {
  return {
    sessionId: 'sid',
    systemPrompt: 'SYS',
    client: { contextWindow },
    modelId: 'm',
    appConfig,
  } as never;
}

function msg(role: Message['role'], content: ContentBlock[] | string, id?: string): Message {
  return {
    id: id ?? `auto-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sid',
    role,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  };
}

// [v0.0.173] AssembleData.prevMessages 字段已删（snapshot 永远 rebuild）
const emptyData = { transcript: [], summary: null } as never;

/** 取 summary msg 的 text content */
function summaryText(out: Message[]): string {
  const sumMsg = out.find((m) => m.id.startsWith('summary:'));
  if (!sumMsg) throw new Error('no summary msg');
  const b = sumMsg.content[0] as { text?: string } | undefined;
  if (!b || typeof b.text !== 'string') throw new Error('summary content[0] is not text');
  return b.text;
}

describe('[v0.0.81.D] summary block = 1 个 text content block', () => {
  it('summary msg content 只有 1 个 block（type=text）', () => {
    const m1 = msg('user', 'h1', 'm1');
    const m2 = msg('assistant', 'h2', 'm2');
    const m3 = msg('user', 'r1', 'm3');
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        ...emptyData,
        transcript: [m1, m2, m3],
        summary: { version: 1, summaryUpTo: 'm2', content: 'SUM' } as never,
      },
      null,
      { config: fakeConfig(), prevSnapshot: null },
    );
    const sumMsg = out[0]!;
    expect(sumMsg.id).toBe('summary:1');
    expect(sumMsg.role).toBe('user');
    expect(sumMsg.content).toHaveLength(1);
    expect(sumMsg.content[0]!.type).toBe('text');
  });
});

describe('[v0.0.81.D] summary text 3 段（preamble + head + tail），含 msgid', () => {
  it('head/tail 行含 [msgid|role] 前缀（不只是 role）', () => {
    const m1 = msg('user', 'hello', 'mid-aaa');
    const m2 = msg('assistant', 'hi', 'mid-bbb');
    // [v0.0.185] 默认 tokenCap=10000：小消息全取（head 全取后 tail 去重为空，段头仍在）
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        ...emptyData,
        transcript: [m1, m2],
        summary: { version: 1, summaryUpTo: 'mid-bbb', content: 'SUMMARY_BODY' } as never,
      },
      null,
      { config: fakeConfig(10_000_000), prevSnapshot: null },
    );
    const text = summaryText(out);
    // preamble + summary body
    expect(text).toContain('SUMMARY_BODY');
    expect(text).toContain('保留的原文片段');
    // head/tail 含 msgid
    expect(text).toContain('[mid-aaa|user]');
    expect(text).toContain('[mid-bbb|assistant]');
    expect(text).toContain('hello');
    expect(text).toContain('hi');
    // 3 段分隔标记
    expect(text).toMatch(/--- head/);
    expect(text).toMatch(/--- tail/);
  });
});

describe('[v0.0.81.D] head∩tail 去重（head 优先）', () => {
  it('summary 区间短，head/tail 重叠时 tail 去掉 head 已有的 id', () => {
    // 3 条各 1 char，tokenCap=2（ratio=1.0）→ head=[m1,m2]（+m3=3>2 停）；tail=[m2,m3]
    // m2 在 head 已有 → tail 去重后只剩 m3
    const m1 = msg('user', 'a', 'm1');
    const m2 = msg('assistant', 'b', 'm2');
    const m3 = msg('user', 'c', 'm3');
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 2 }).reduce(
      {
        ...emptyData,
        transcript: [m1, m2, m3],
        summary: { version: 1, summaryUpTo: 'm3', content: 'S' } as never,
      },
      null,
      { config: fakeConfig(10_000_000), prevSnapshot: null },
    );
    const text = summaryText(out);
    // head 段含 m1, m2
    expect(text).toContain('[m1|user]');
    expect(text).toContain('[m2|assistant]');
    // tail 段不含 m2（去重）—— 可能含 m3
    const tailIdx = text.indexOf('--- tail');
    const tailSection = text.slice(tailIdx);
    expect(tailSection).not.toContain('[m2|assistant]');
  });
});

describe('[v0.0.81.D] recent 新→旧放置 + budget cap', () => {
  it('recent 全部装入：summary 小 + recent 少 → 全部 recent 保留', () => {
    const m1 = msg('user', 'old1', 'm1');
    const m2 = msg('user', 'recent1', 'm2');
    const m3 = msg('user', 'recent2', 'm3');
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        ...emptyData,
        transcript: [m1, m2, m3],
        summary: { version: 1, summaryUpTo: 'm1', content: 'S' } as never,
      },
      null,
      { config: fakeConfig(10_000_000), prevSnapshot: null },
    );
    // [summary, m2, m3]（m1 在 summary 内作 head/tail；m2 m3 是 recent，全保留）
    expect(out).toHaveLength(3);
    expect(out[0]!.id).toBe('summary:1');
    expect(out[1]!.id).toBe('m2');
    expect(out[2]!.id).toBe('m3');
  });

  it('recent 超 budget → 丢最旧 recent（保最新）', () => {
    // 5 条 recent 每条 200 字符；contextWindow=1000，ratio=1.0，estimatedOutput=1（appConfig override）
    // budget_tokens = 0.95*1000 - 1 = 949；budget_chars = 949
    // summary ~150 char → remaining ~799 char
    // 5 × 200 = 1000 char > 799 → 最旧的被丢
    const head = msg('user', 'head1', 'h1');
    const rs = Array.from({ length: 5 }, (_, i) => msg('user', 'r'.repeat(200), `r${i}`));
    // [v0.0.185] tokenCap=1 → head/tail 各保底 1 条（h1），tail 去重为空 → summary 短
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 1 }).reduce(
      {
        ...emptyData,
        transcript: [head, ...rs],
        summary: { version: 1, summaryUpTo: 'h1', content: 'S' } as never,
      },
      null,
      {
        // estimatedOutput = 1（appConfig override，正数才生效）；contextWindow=1000
        config: fakeConfig(1000, { get: () => 1 }),
        prevSnapshot: null,
        ratio: 1.0,
      },
    );
    // 第一个是 summary；剩余应为 recent 子集
    expect(out[0]!.id).toBe('summary:1');
    const recentIds = out.slice(1).map((m) => m.id);
    // 最新（r4）一定在
    expect(recentIds).toContain('r4');
    // 最旧（r0）应该被丢
    expect(recentIds).not.toContain('r0');
    // 保序（升序）
    for (let i = 1; i < recentIds.length; i++) {
      const a = parseInt(recentIds[i - 1]!.slice(1));
      const b = parseInt(recentIds[i]!.slice(1));
      expect(a).toBeLessThan(b);
    }
  });
});

describe('[v0.0.81.D] estimatedOutput 计入 budget', () => {
  it('appConfig context.maxOutputTokens=1（最小正数）+ 大 window → 全部 recent 装下', () => {
    // estimatedOutput=1 + 大 window → 全部 recent 装下
    const head = msg('user', 'h', 'h1');
    const rs = Array.from({ length: 3 }, (_, i) => msg('user', `r${i}`, `r${i}`));
    // [v0.0.185] tokenCap=1 → head/tail 各保底 1 条
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 1 }).reduce(
      {
        ...emptyData,
        transcript: [head, ...rs],
        summary: { version: 1, summaryUpTo: 'h1', content: 'S' } as never,
      },
      null,
      {
        config: fakeConfig(100_000, { get: () => 1 }),
        prevSnapshot: null,
        ratio: 1.0,
      },
    );
    expect(out).toHaveLength(4); // summary + 3 recent
  });

  it('appConfig context.maxOutputTokens=95000 + window=100000 → budget≈0，recent 全丢', () => {
    // budget_tokens = 0.95*100000 - 95000 = 0
    const head = msg('user', 'h', 'h1');
    const r1 = msg('user', 'recent', 'r1');
    // [v0.0.185] tokenCap=1 → head/tail 各保底 1 条
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 1 }).reduce(
      {
        ...emptyData,
        transcript: [head, r1],
        summary: { version: 1, summaryUpTo: 'h1', content: 'S' } as never,
      },
      null,
      {
        config: fakeConfig(100_000, { get: (_g: string, k: string) => (k === 'maxOutputTokens' ? 95000 : undefined) }),
        prevSnapshot: null,
        ratio: 1.0,
      },
    );
    // summary 始终在；recent 全丢（budget_chars≈0）
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('summary:1');
  });

  it('无 appConfig → estimatedOutput 默认 20000', () => {
    // 隐式验证：window=30000, no appConfig → budget_tokens = 0.95*30000 - 20000 = 8500
    // summary ~250 char + recent（每条 200 char）最多装 ~42 条 → 5 条全装下
    const head = msg('user', 'h', 'h1');
    const rs = Array.from({ length: 5 }, (_, i) => msg('user', 'x'.repeat(200), `r${i}`));
    // [v0.0.185] tokenCap=1 → head/tail 各保底 1 条
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 1 }).reduce(
      {
        ...emptyData,
        transcript: [head, ...rs],
        summary: { version: 1, summaryUpTo: 'h1', content: 'S' } as never,
      },
      null,
      { config: fakeConfig(30_000), prevSnapshot: null, ratio: 1.0 },
    );
    // 5 条 recent 都能装下（8500 budget − summary 250 ≈ 8250 char 可用）
    expect(out.length).toBe(6); // summary + 5 recent
  });
});
