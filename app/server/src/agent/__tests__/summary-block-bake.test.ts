/**
 * [v0.0.186] summary 烘焙（compact 时构建 block 并持久化）单测
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §6
 *       reqs/[working] v0.0.186.summary_bake/req.md
 *
 * 覆盖：
 *   - bakeSummaryBlock：锚定候选（head=会话真第一条 takeFromStart / tail=summaryUpTo 结尾）
 *     + tokenCap 选取 + 当时 ratio + budget tailDropped 降级 → 完整 block 文本
 *   - runCompact 集成：compact 产出 summary 记录含 block（schema 落盘 + getSummary 读回）
 *   - runCompact 缺省 bakeConfig（手动 compact 入口）也烘焙（默认参数）
 *   - 烘焙文本逐字节 = 同参数下 buildSummaryBlock 算法输出（与组装 fallback 同源）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { runCompact } from '../context-compact-runner';
import {
  bakeSummaryBlock,
  buildSummaryBlock,
  pickHead,
  pickTail,
} from '../summary-block';
import type { SessionConfig } from '../context-types';
import type { Message } from '../../message/types';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-summary-bake-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造业务 message（显式 id；内容定长便于 tokenCap 估算） */
function msg(role: Message['role'], text: string, id: string): Message {
  return { id, sessionId: 'sid', role, content: [{ type: 'text', text }] };
}

/** 造假 config（contextWindow 足够大，budget 不截 tail） */
function fakeConfig(contextWindow = 10_000_000): SessionConfig {
  return {
    sessionId: 'sid',
    systemPrompt: 'SYS',
    client: { contextWindow },
    modelId: 'm',
  } as never;
}

/**
 * 造假 store：基于固定消息列表响应 getMessages（upToId 截断 + takeFromStart/limit），
 * getRatio 返固定值。bakeSummaryBlock 单测用（真实 store 集成走 runCompact 组）。
 */
function fakeStore(messages: Message[], ratio: number) {
  const ranges: Record<string, unknown>[] = [];
  return {
    ranges,
    store: {
      getRatio: async () => ratio,
      getMessages: async (_sid: string, range: { upToId?: string; limit?: number; takeFromStart?: boolean } = {}) => {
        ranges.push(range as Record<string, unknown>);
        const upToIdx = range.upToId ? messages.findIndex((m) => m.id === range.upToId) : messages.length - 1;
        const window = messages.slice(0, upToIdx + 1);
        const limit = range.limit ?? 500;
        const items = range.takeFromStart ? window.slice(0, limit) : window.slice(-limit);
        return { items, hasMore: false };
      },
    } as never,
  };
}

describe('[v0.0.186] bakeSummaryBlock — 锚定候选 + tokenCap + ratio', () => {
  it('head 锚定会话真第一条 / tail 锚定 summaryUpTo；候选取法与 summary_reader 一致', async () => {
    const ms = Array.from({ length: 6 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', 'x'.repeat(50), `m${i}`),
    );
    const { store: st, ranges } = fakeStore(ms, 1.0);
    const block = await bakeSummaryBlock(st, fakeConfig(), {
      content: 'SUM',
      summaryUpTo: 'm5',
    });
    // 候选取法：head takeFromStart / tail 末尾（与 summary_reader v0.0.185 同口径）
    expect(ranges[0]).toEqual({ upToId: 'm5', limit: 500, takeFromStart: true });
    expect(ranges[1]).toEqual({ upToId: 'm5', limit: 500 });
    // 文本 = preamble + summary + head 段（含真第一条 m0）+ tail 段（含锚点 m5）
    expect(block).toContain('SUM');
    expect(block).toContain('[m0|user]');
    expect(block).toContain('[m5|assistant]');
    // 与同参数下算法直出逐字节一致（与组装 fallback 同源证明）
    const head = pickHead(ms, 10000, 1.0);
    const tail = pickTail(ms, 10000, 1.0).filter((t) => !head.some((h) => h.id === t.id));
    expect(block).toBe(buildSummaryBlock({ content: 'SUM' }, head, tail).text);
  });

  it('tokenCap 生效：cap 小 → head/tail 各保底 1 条（首条/锚点）', async () => {
    const ms = Array.from({ length: 5 }, (_, i) => msg('user', 'x'.repeat(100), `m${i}`));
    const { store: st } = fakeStore(ms, 1.0);
    const block = await bakeSummaryBlock(st, fakeConfig(), {
      content: 'S',
      summaryUpTo: 'm4',
      tokenCap: 10, // 首条即超 cap → 保底 1 条
    });
    expect(block).toContain('[m0|user]'); // head 保底真第一条
    expect(block).not.toContain('[m1|user]');
    // tail 保底 = 锚点 m4（与 head 不重叠时）
    expect(block).toContain('[m4|user]');
  });

  it('当时的 ratio 定格：ratio 小 → 同 cap 取得更多（烘焙用 store.getRatio 那一刻的值）', async () => {
    const ms = Array.from({ length: 5 }, (_, i) => msg('user', 'x'.repeat(100), `m${i}`));
    const small = await bakeSummaryBlock(fakeStore(ms, 0.4).store, fakeConfig(), {
      content: 'S',
      summaryUpTo: 'm4',
      tokenCap: 200,
    });
    const large = await bakeSummaryBlock(fakeStore(ms, 1.0).store, fakeConfig(), {
      content: 'S',
      summaryUpTo: 'm4',
      tokenCap: 200,
    });
    // ratio=0.4 → 每条 40 token → 5 条=200 ≤ cap 全取；ratio=1.0 → 只取 2 条
    expect(small).toContain('[m4|user]');
    expect(countLines(small, 'head')).toBe(5);
    expect(countLines(large, 'head')).toBe(2);
  });

  it('summaryUpTo=null → 无候选（head/tail 段空），仅 preamble', async () => {
    const { store: st, ranges } = fakeStore([msg('user', 'a', 'm0')], 1.0);
    const block = await bakeSummaryBlock(st, fakeConfig(), { content: 'ONLY', summaryUpTo: null });
    expect(ranges).toHaveLength(0); // 不取候选
    expect(block).toContain('ONLY');
    expect(countLines(block, 'head')).toBe(0);
    expect(countLines(block, 'tail')).toBe(0);
  });

  it('budget tailDropped 降级：contextWindow 极小 → tail 段截断说明（保 preamble+head）', async () => {
    // 3 条各 2000 char；tokenCap=2000 → head=[m0]、tail=[m2]（不重叠）；
    // window=100 → budgetTokens=max(0, 95-20000)=0 → budgetChars=0
    // → summaryText(>0) > 0 且 tail 非空 → tailDropped
    const ms = [
      msg('user', 'h'.repeat(2000), 'm0'),
      msg('user', 'x'.repeat(2000), 'm1'),
      msg('user', 't'.repeat(2000), 'm2'),
    ];
    const { store: st } = fakeStore(ms, 1.0);
    const block = await bakeSummaryBlock(st, fakeConfig(100), {
      content: 'S',
      summaryUpTo: 'm2',
      tokenCap: 2000,
    });
    expect(block).toContain('已因 budget 限制截断');
    expect(block).toContain('[m0|user]'); // head 保留
    expect(block).not.toContain('[m2|user]'); // tail 被丢
  });
});

describe('[v0.0.186] runCompact 集成 — summary 记录落 block 字段', () => {
  function captureForked(answer: string) {
    return async () => ({ answer, usage: {} });
  }

  async function seedSession(sid: string, count: number): Promise<void> {
    await store.createSession({ id: sid });
    await store.appendMessages(
      sid,
      Array.from({ length: count }, (_, i) => ({
        id: ulid(),
        sessionId: sid,
        role: (i % 2 ? 'assistant' : 'user') as Message['role'],
        content: [{ type: 'text' as const, text: `msg-${i}-` + 'x'.repeat(30) }],
      })),
    );
  }

  it('compact 产出 summary 含 block；block = preamble+content+head/tail 段（锚定真第一条+summaryUpTo）', async () => {
    const sid = ulid();
    await seedSession(sid, 6);
    const config = { ...fakeConfig(), sessionId: sid } as SessionConfig;
    const snapshot = await new ContextEngine({ store }).assemble(config);

    const ok = await runCompact(store, undefined, config, snapshot, captureForked('<summary>BAKED</summary>'));
    expect(ok).toBe(true);

    const written = await store.getSummary(sid);
    expect(written).not.toBeNull();
    expect(written!.content).toBe('BAKED');
    // [v0.0.186] block 已烘焙落库
    expect(typeof written!.block).toBe('string');
    expect(written!.block!.length).toBeGreaterThan(0);
    expect(written!.block).toContain('BAKED');
    // head 锚定会话真第一条 / tail 锚定 summaryUpTo（snapshot 末条）
    const page = await store.getMessages(sid);
    const first = page.items[0]!;
    expect(written!.block).toContain(`[${first.id}|user]`);
    expect(written!.block).toContain(`[${written!.summaryUpTo}|assistant]`);
  });

  it('缺省 bakeConfig（手动 compact 入口 contextEngine.compact 同链）→ 用默认参数烘焙', async () => {
    const sid = ulid();
    await seedSession(sid, 3);
    const config = { ...fakeConfig(), sessionId: sid } as SessionConfig;
    const snapshot = await new ContextEngine({ store }).assemble(config);
    // 不传第 8 参（与 contextEngine.compact 手动入口同形态）
    await runCompact(store, undefined, config, snapshot, captureForked('<summary>D</summary>'));
    const written = await store.getSummary(sid);
    expect(written!.block).toContain('D');
  });

  it('bakeConfig 透传：tokenCap 极小 → 烘焙 head/tail 各保底 1 条', async () => {
    const sid = ulid();
    await seedSession(sid, 6);
    const config = { ...fakeConfig(), sessionId: sid } as SessionConfig;
    const snapshot = await new ContextEngine({ store }).assemble(config);
    await runCompact(
      store, undefined, config, snapshot, captureForked('<summary>T</summary>'),
      undefined, undefined,
      { tokenCap: 1, candidateLimit: 500 },
    );
    const written = await store.getSummary(sid);
    const page = await store.getMessages(sid);
    const first = page.items[0]!;
    const second = page.items[1]!;
    // head 保底真第一条；第二条不进 head
    expect(written!.block).toContain(`[${first.id}|user]`);
    expect(written!.block).not.toContain(`[${second.id}|`);
  });

  it('schema 兼容：旧路径 setSummary 不带 block → getSummary.block === null（组装走 fallback）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.setSummary(sid, { content: 'OLD', summaryUpTo: null });
    const written = await store.getSummary(sid);
    expect(written!.content).toBe('OLD');
    expect(written!.block).toBeNull();
  });
});

/** 数 block 文本中某段（head/tail）的 [msgid|role] 行数 */
function countLines(text: string, section: 'head' | 'tail'): number {
  const lines = text.split('\n');
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (line.startsWith(`--- ${section}`)) {
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
