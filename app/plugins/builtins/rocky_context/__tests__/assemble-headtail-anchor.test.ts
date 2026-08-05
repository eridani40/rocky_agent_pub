/**
 * base_builder [v0.0.185] head/tail 锚定 + tokenCap 算法单测
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §6
 *       reqs/[working] v0.0.185.cache/req.md（prompt 缓存前缀稳定性）
 *
 * 覆盖（owner 拍板语义：同 summary version 下 summary block 逐字节一致）：
 *   - pickHead/pickTail tokenCap 算法：累加超 cap 弃当前条并停止 / 保底 1 条 / 空候选
 *   - head 锚定会话真第一条：recent 窗口滑动（transcript 换血）不影响 head 选取
 *   - tail 锚定 summaryUpTo：summaryUpTo 掉出 recent 窗口（upToIdx=-1）tail 仍稳定（修旧异常路径）
 *   - 核心回归：同 summary version + 增长的 transcript → summaryMsg 文本逐字节一致
 *   - 缺省回退：无 candidates → transcript 派生（旧测试 ctx / forked 兼容）
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../../../../server/src/message/types';
import BaseBuilderReducer from '../assemble/base_builder';
// [v0.0.186] pickHead/pickTail 算法单源迁至 server summary-block（compact 烘焙与组装 fallback 共用）
import { pickHead, pickTail } from '../../../../server/src/agent/summary-block';

/** 造假 config（contextWindow 足够大，assemble budget 不截 recent） */
function fakeConfig(contextWindow = 10_000_000) {
  return {
    sessionId: 'sid',
    systemPrompt: 'SYS',
    client: { contextWindow },
    modelId: 'm',
  } as never;
}

/** 造业务 message（显式 id；内容定长便于 tokenCap 估算） */
function msg(role: Message['role'], text: string, id: string): Message {
  return {
    id,
    sessionId: 'sid',
    role,
    content: [{ type: 'text', text }],
  };
}

/** 取 summary msg 的 text content */
function summaryText(out: Message[]): string {
  const sumMsg = out.find((m) => m.id.startsWith('summary:'));
  if (!sumMsg) throw new Error('no summary msg');
  const b = sumMsg.content[0] as { text?: string } | undefined;
  if (!b || typeof b.text !== 'string') throw new Error('summary content[0] is not text');
  return b.text;
}

/** 数 summary text 中某段（head/tail）的 [msgid|role] 行数（沿用 assemble-reducers.test.ts 口径） */
function countSectionItems(text: string, section: 'head' | 'tail'): number {
  const startMarker = `--- ${section}`;
  const lines = text.split('\n');
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (line.startsWith(startMarker)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (line.startsWith('--- ')) break;
      if (/^\[[^\]]+\|\w+\]/.test(line)) count++;
    }
  }
  return count;
}

describe('[v0.0.185] pickHead/pickTail — tokenCap 算法', () => {
  it('累加超 cap → 弃当前条并停止（后续更小条也不取）', () => {
    // 每条 100 char，ratio=1.0，cap=250：100→200→(+100=300>250 停)
    const ms = Array.from({ length: 5 }, (_, i) => msg('user', 'x'.repeat(100), `m${i}`));
    const head = pickHead(ms, 250, 1.0);
    expect(head.map((m) => m.id)).toEqual(['m0', 'm1']);
    // tail 从末尾往前：m4→m3→(+m2 超 cap 停)，结果按原序
    const tail = pickTail(ms, 250, 1.0);
    expect(tail.map((m) => m.id)).toEqual(['m3', 'm4']);
  });

  it('停止语义：当前条超 cap 即停，不跳过后面试更小条', () => {
    // m0=100, m1=300(超), m2=1（若跳过 m1 继续会被取到——但语义是停）
    const m0 = msg('user', 'x'.repeat(100), 'm0');
    const m1 = msg('user', 'y'.repeat(300), 'm1');
    const m2 = msg('user', 'z', 'm2');
    const head = pickHead([m0, m1, m2], 250, 1.0);
    expect(head.map((m) => m.id)).toEqual(['m0']);
  });

  it('保底 1 条：首条即超 cap 仍取 1 条', () => {
    const big = msg('user', 'x'.repeat(5000), 'big');
    const head = pickHead([big, msg('user', 'a', 'm1')], 100, 1.0);
    expect(head).toHaveLength(1);
    expect(head[0]!.id).toBe('big');
    const tail = pickTail([msg('user', 'a', 'm0'), big], 100, 1.0);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.id).toBe('big');
  });

  it('空候选 → 空', () => {
    expect(pickHead([], 100, 1.0)).toEqual([]);
    expect(pickTail([], 100, 1.0)).toEqual([]);
  });

  it('ratio 参与累加：ratio 小 → 同 cap 取得更多', () => {
    const ms = Array.from({ length: 5 }, (_, i) => msg('user', 'x'.repeat(100), `m${i}`));
    // cap=500：ratio=1.0 → 500(5条内 100×5=500 → 取5? 逐条: 100,200,300,400,500 → 第6条不存在) → 5
    // ratio=0.4 → 每条40 → 5条=200 ≤ 500 → 全取 5
    expect(pickHead(ms, 500, 1.0)).toHaveLength(5);
    expect(pickHead(ms, 200, 1.0)).toHaveLength(2);
    expect(pickHead(ms, 200, 0.4)).toHaveLength(5);
  });
});

describe('[v0.0.185] head 锚定会话真第一条（recent 窗口滑动不影响）', () => {
  // 会话真前 3 条 c0-c2（各 50 char）；summaryUpTo=c2；recent 窗口只含 c2 之后
  const c0 = msg('user', 'c'.repeat(50), 'c0');
  const c1 = msg('assistant', 'c'.repeat(50), 'c1');
  const c2 = msg('user', 'c'.repeat(50), 'c2');
  const summary = { version: 1, summaryUpTo: 'c2', content: 'SUM' } as never;
  const headCandidates = [c0, c1, c2];
  const tailCandidates = [c0, c1, c2];

  it('transcript 滑动（c0/c1 掉出窗口）→ head 段逐字节不变', () => {
    // 轮 1：窗口含全部 c0-c2 + recent r1
    const r1 = msg('user', 'r1', 'r1');
    const out1 = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        transcript: [c0, c1, c2, r1],
        summary,
        headCandidates,
        tailCandidates,
      } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    // 轮 2：窗口滑动——c0/c1 掉出（只含 c2 + r1 + r2）
    const r2 = msg('assistant', 'r2', 'r2');
    const out2 = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        transcript: [c2, r1, r2],
        summary,
        headCandidates,
        tailCandidates,
      } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    // 核心断言：summaryMsg 文本逐字节一致（head 段不从 transcript[0] 派生）
    expect(summaryText(out2)).toBe(summaryText(out1));
    // head 段仍含会话真第一条 c0
    expect(summaryText(out2)).toContain('[c0|user]');
  });

  it('无 candidates（缺省回退）→ 从 transcript 派生（旧行为兼容）', () => {
    const r1 = msg('user', 'r1', 'r1');
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      { transcript: [c0, c1, c2, r1], summary } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    // 回退候选 = transcript 至 summaryUpTo（含）→ head 含 c0
    expect(summaryText(out)).toContain('[c0|user]');
  });
});

describe('[v0.0.185] tail 锚定 summaryUpTo（掉出 recent 窗口仍稳定）', () => {
  it('summaryUpTo 不在 transcript（upToIdx=-1）→ tail 段仍 populated（修旧异常路径）', () => {
    // 摘要区间 6 条（t0..t5，各 50 char）；summaryUpTo=t5 已掉出 recent 窗口
    const region = Array.from({ length: 6 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', 't'.repeat(50), `t${i}`),
    );
    const headCandidates = region.slice(0, 3); // 真第一条起
    const tailCandidates = region.slice(3); // summaryUpTo（t5）结尾
    // recent 窗口只有 r 系列新消息（t5 不在窗口 → upToIdx=-1）
    const rs = Array.from({ length: 3 }, (_, i) => msg('user', `r${i}`, `r${i}`));
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        transcript: rs,
        summary: { version: 1, summaryUpTo: 't5', content: 'SUM' } as never,
        headCandidates,
        tailCandidates,
      } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    const text = summaryText(out);
    // tail 段仍含 summaryUpTo 锚点 t5（锚定候选，不依赖 upToIdx）；旧路径 head/tail 候选会为空
    expect(text).toContain('[t5|assistant]');
    expect(countSectionItems(text, 'tail')).toBe(3);
    expect(countSectionItems(text, 'head')).toBe(3);
    // recent = 整个窗口（全比 summaryUpTo 新）
    expect(out.slice(1).map((m) => m.id)).toEqual(['r0', 'r1', 'r2']);
  });
});

describe('[v0.0.185] 核心回归：同 summary version + 增长 transcript → summaryMsg 逐字节一致', () => {
  it('多轮 append 后 summary block byte-identical（head+tail 两段均参与）', () => {
    // 会话 20 条（c00..c19，各 ~40 char），summaryUpTo=c09；锚定候选 = 摘要区间
    const all = Array.from({ length: 20 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `content-${i}-` + 'x'.repeat(30), `c${String(i).padStart(2, '0')}`),
    );
    const summary = { version: 3, summaryUpTo: 'c09', content: 'SUMMARY-V3' } as never;
    const headCandidates = all.slice(0, 10); // 真第一条起
    const tailCandidates = all.slice(0, 10); // summaryUpTo（c09）结尾
    // tokenCap=100 → head=[c00,c01]、tail=[c08,c09]（不重叠，两段都有内容）

    const texts: string[] = [];
    // 模拟 recent 窗口滑动：窗口从 [c00..c19] 逐步滑到 [c15..c19]（summaryUpTo 掉出）
    const windows = [all, all.slice(5), all.slice(10), all.slice(15)];
    for (const w of windows) {
      const out = new BaseBuilderReducer('base_builder', { tokenCap: 100 }).reduce(
        { transcript: w, summary, headCandidates, tailCandidates } as never,
        null,
        { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
      );
      texts.push(summaryText(out));
    }
    // 四个窗口的 summaryMsg 全部逐字节一致
    for (const t of texts) expect(t).toBe(texts[0]);
    // head/tail 段都有内容（断言覆盖两段而非仅 head）
    expect(countSectionItems(texts[0]!, 'head')).toBe(2);
    expect(countSectionItems(texts[0]!, 'tail')).toBe(2);
  });
});

describe('[v0.0.185] tokenCap 边界（base_builder 集成）', () => {
  it('加入某条会超 cap → 弃该条；head/tail 各保底 1 条', () => {
    // 4 条各 100 char；cap=250 → head=[m0,m1]、tail=[m2,m3]（无重叠）
    const ms = Array.from({ length: 4 }, (_, i) => msg('user', 'x'.repeat(100), `m${i}`));
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 250 }).reduce(
      {
        transcript: ms,
        summary: { version: 1, summaryUpTo: 'm3', content: 'S' } as never,
      } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    const text = summaryText(out);
    expect(countSectionItems(text, 'head')).toBe(2);
    expect(countSectionItems(text, 'tail')).toBe(2);
  });

  it('保底 1 条：首条即超 cap → head 仍 1 条', () => {
    const big = msg('user', 'x'.repeat(5000), 'big');
    const rest = Array.from({ length: 3 }, (_, i) => msg('user', 'x'.repeat(100), `m${i}`));
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 10 }).reduce(
      {
        transcript: [big, ...rest],
        summary: { version: 1, summaryUpTo: 'm2', content: 'S' } as never,
      } as never,
      null,
      { config: fakeConfig(), prevSnapshot: null, ratio: 1.0 },
    );
    const text = summaryText(out);
    expect(countSectionItems(text, 'head')).toBe(1);
    expect(text).toContain('[big|user]');
  });
});
