/**
 * [v0.0.186] summary 烘焙 — 组装期零计算单测（base_builder 烘焙优先 + fallback + summary_reader 跳取）
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §6
 *       reqs/[working] v0.0.186.summary_bake/req.md
 *
 * 覆盖（owner 验收口径）：
 *   - 有烘焙 block → msg[0] 逐字节 = block；**transcript 增长 + ratio 变化都不影响**（核心回归）
 *   - 烘焙路径不消费 head/tail 候选（零计算；无候选也不回退）
 *   - 烘焙 + recent：recent 仍每轮按剩余 budget 放置（recent 逻辑不变）
 *   - fallback：无烘焙（block=null/缺）→ 行为同 v0.0.185 即时构建（锚定候选 + tokenCap）
 *   - summary_reader：summary 带 block → 不取 head/tail 候选（省 2 次 getMessages）
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../../../../server/src/message/types';
import BaseBuilderReducer from '../assemble/base_builder';
import SummaryReaderMapper from '../assemble/summary_reader';

/** 造假 config（contextWindow 足够大，assemble budget 不截 recent） */
function fakeConfig(contextWindow = 10_000_000) {
  return {
    sessionId: 'sid',
    systemPrompt: 'SYS',
    client: { contextWindow },
    modelId: 'm',
  } as never;
}

/** 造业务 message（显式 id；内容定长便于 budget 估算） */
function msg(role: Message['role'], text: string, id: string): Message {
  return { id, sessionId: 'sid', role, content: [{ type: 'text', text }] };
}

/** 取 summary msg 的 text content */
function summaryText(out: Message[]): string {
  const sumMsg = out.find((m) => m.id.startsWith('summary:'));
  if (!sumMsg) throw new Error('no summary msg');
  const b = sumMsg.content[0] as { text?: string } | undefined;
  if (!b || typeof b.text !== 'string') throw new Error('summary content[0] is not text');
  return b.text;
}

/** 烘焙文本样例（假装是 compact 时 bakeSummaryBlock 的产物） */
const BAKED = [
  '以下是之前对话的摘要，以及为保持上下文连续保留的原文片段（head=早期，tail=近期）：',
  '',
  'SUMMARY-CONTENT',
  '',
  '--- head（早期保留原文）---',
  '[c0|user] head-line',
  '',
  '--- tail（近期保留原文）---',
  '[c9|assistant] tail-line',
].join('\n');

function bakedSummary(version = 3, summaryUpTo: string | null = 'c9') {
  return {
    version,
    summaryUpTo,
    content: 'SUMMARY-CONTENT',
    block: BAKED,
    createdAt: 't',
    updatedAt: 't',
  } as never;
}

describe('[v0.0.186] base_builder 烘焙优先 — msg[0] 逐字节 = block', () => {
  it('msg[0] 文本 = block（id=summary:{version}，role=user），零计算', () => {
    const rs = Array.from({ length: 3 }, (_, i) => msg('user', `r${i}`, `r${i}`));
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      { transcript: rs, summary: bakedSummary() } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    expect(out[0]!.id).toBe('summary:3');
    expect(out[0]!.role).toBe('user');
    expect(summaryText(out)).toBe(BAKED);
  });

  it('核心回归：transcript 增长 + ratio 变化 + 无候选 → msg[0] 逐字节不变', () => {
    // 轮 1：窗口含摘要区尾部 + 少量 recent，ratio=1.0，无候选（烘焙路径不消费候选）
    const c9 = msg('assistant', 'x', 'c9');
    const r1 = msg('user', 'r1', 'r1');
    const out1 = new BaseBuilderReducer('base_builder', {}).reduce(
      { transcript: [c9, r1], summary: bakedSummary() } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    // 轮 2：transcript 增长（窗口滑动换血）+ ratio 漂移（v0.0.186 前会把 head 窗口撑缩）
    const r2 = msg('assistant', 'r2', 'r2');
    const r3 = msg('user', 'r3', 'r3');
    const out2 = new BaseBuilderReducer('base_builder', {}).reduce(
      { transcript: [r1, r2, r3], summary: bakedSummary() } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 0.37 },
    );
    // msg[0] 逐字节一致（ratio 漂移不再影响；v0.0.185 残留的第二机制已根治）
    expect(summaryText(out2)).toBe(summaryText(out1));
    expect(summaryText(out2)).toBe(BAKED);
    // recent 仍每轮最新（轮 2 窗口全是 recent——c9 掉出窗口）
    expect(out2.slice(1).map((m) => m.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('烘焙 + recent budget：block 占用计入预算，recent 按剩余 budget 截断', () => {
    // window=1200，无 appConfig → estimatedOutput=20000?? 不行——用 appConfig=1 控预算：
    // budgetTokens = 0.95*1200 - 1 = 1139；block 长 ~250 char → recent 可用 ~889 char。
    // recent 3 条各 400 char → 只能装 2 条（保新弃旧）。
    const rs = Array.from({ length: 3 }, (_, i) => msg('user', 'r'.repeat(400), `r${i}`));
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      { transcript: rs, summary: bakedSummary() } as never,
      null,
      {
        config: {
          ...fakeConfig(1200),
          appConfig: { get: () => 1 },
        } as never,
        prevSnapshot: null,
        ratio: 1.0,
      },
    );
    expect(out[0]!.id).toBe('summary:3');
    const recentIds = out.slice(1).map((m) => m.id);
    expect(recentIds).toContain('r2'); // 最新保留
    expect(recentIds).not.toContain('r0'); // 最旧丢弃
  });
});

describe('[v0.0.186] fallback — 无烘焙 block 行为同 v0.0.185 即时构建', () => {
  it('block=null → 走锚定候选即时构建（含 head/tail 段）', () => {
    const c0 = msg('user', 'c'.repeat(50), 'c0');
    const c1 = msg('assistant', 'c'.repeat(50), 'c1');
    const c2 = msg('user', 'c'.repeat(50), 'c2');
    const summary = {
      version: 1, summaryUpTo: 'c2', content: 'SUM', block: null,
    } as never;
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        transcript: [c0, c1, c2],
        summary,
        headCandidates: [c0, c1, c2],
        tailCandidates: [c0, c1, c2],
      } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    const text = summaryText(out);
    // 即时构建产物：preamble + head/tail 段（与烘焙文本结构同构，但内容来自本轮选取）
    expect(text).toContain('SUM');
    expect(text).toContain('[c0|user]');
    expect(text).toContain('--- head');
    expect(text).toContain('--- tail');
    // 不是烘焙文本（无烘焙可走）
    expect(text).not.toBe(BAKED);
  });
});

describe('[v0.0.186] summary_reader — 带 block 不取候选', () => {
  it('summary 带 block → getMessages 不调，candidates 不贡献（省 2 次 store 读）', async () => {
    let calls = 0;
    const store = {
      getMessages: async () => {
        calls++;
        return { items: [], hasMore: false };
      },
      getSummary: async () => ({
        version: 2, summaryUpTo: 'm9', content: 'S', block: 'BAKED-TEXT',
      }),
    };
    const out = await new SummaryReaderMapper('summary_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(calls).toBe(0);
    expect((out.summary as { block: string }).block).toBe('BAKED-TEXT');
    expect(out.headCandidates).toBeUndefined();
    expect(out.tailCandidates).toBeUndefined();
  });

  it('summary 无 block（旧记录）→ 仍取候选（fallback 即时构建用）', async () => {
    let calls = 0;
    const store = {
      getMessages: async () => {
        calls++;
        return { items: [], hasMore: false };
      },
      getSummary: async () => ({ version: 2, summaryUpTo: 'm9', content: 'S', block: null }),
    };
    await new SummaryReaderMapper('summary_reader', {}).map({
      config: fakeConfig(),
      prevSnapshot: null,
      store: store as never,
    });
    expect(calls).toBe(2); // head + tail 候选各一次
  });
});
