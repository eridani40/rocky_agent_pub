/**
 * rocky_context plugin post-compact EP 单测（v0.0.51 新增）
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2d.2/§2d.3/§2d.4
 *       specs/tech/agent/memory/[P0]consolidation_tier1.md §3/§4/§5
 *
 * 覆盖：
 *   1. context_post_compact EP 注册（manifest 含 2 impl：memory_skill_consolidation + noop_post_compact）
 *   2. memory_skill_consolidation handler 启动 fork-2（双快照契约：snapshot=prevSnapshot 压缩前完整对话，
 *      runKind='consolidate'）
 *   3. 旁路 scope 跳过 post-compact（noop_post_compact 空操作，防递归）
 *   4. fire-and-forget（fork-2 reject 不抛回 handle）
 *   5. 缺依赖（UT fixture）容错跳过
 *   6. tryCompact 集成：post-compact 不再由胶水派发（收进 runCompact 末尾统一触发）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PostCompactCtx } from '../types';
import MemorySkillConsolidationHandler from '../compact/post-compact-consolidation';
import NoopPostCompactHandler from '../compact/noop-post-compact';
import { tryCompact } from '../../../../server/src/agent/try-compact';
import type { PluginManager } from '../../../../server/src/plugin/plugin-manager';
import { ContextPostCompactPoint } from '../../../../server/src/plugin/extension-point';
import type { PostCompactHandler } from '../../../../server/src/agent/compact-types';
import type { ContextSnapshot } from '../../../../server/src/agent/context-types';

/** 造假 ContextSnapshot（post handler 双快照 ctx 的 prev/post 共用素材） */
function fakeSnapshot(): ContextSnapshot {
  return {
    system: { id: 's', sessionId: 'sid-c', role: 'system', content: [] } as never,
    messages: [
      { id: 'm1', sessionId: 'sid-c', role: 'user', content: [{ type: 'text', text: '记住我喜欢简洁' }] } as never,
      { id: 'm2', sessionId: 'sid-c', role: 'assistant', content: [{ type: 'text', text: '好的' }] } as never,
    ],
    inputCharCount: 100,
    contextWindowUsage: {
      systemTokens: 10, messageTokens: 50, toolTokens: 0,
      totalTokens: 60, maxOutputTokens: 20, tokenLimit: 100, remainingTokens: 20,
    },
    summary: null,
  } as never;
}

/** 造假 PostCompactCtx（prevSnapshot 压缩前 + postSnapshot 压缩后双快照，运行时依赖可选） */
function fakeCtx(overrides: Partial<PostCompactCtx> = {}): PostCompactCtx {
  return {
    config: { sessionId: 'sid-c' } as never,
    prevSnapshot: fakeSnapshot(),
    postSnapshot: fakeSnapshot(),
    store: { accumulateUsage: vi.fn(async () => ['sid-c']) } as never,
    scopeId: 'default',
    ...overrides,
  };
}

/** 造假 toolDefinitions（非空，触发 handler 路径） */
function fakeToolDefinitions() {
  return [
    { name: 'skill_manage', description: 'skill manage', inputSchema: { type: 'object', properties: {} } } as never,
    { name: 'memory_manage', description: 'memory manage', inputSchema: { type: 'object', properties: {} } } as never,
  ];
}

// ============================================================
// EP 注册：manifest 含 2 impl（memory_skill_consolidation + noop_post_compact）
// ============================================================

describe('context_post_compact EP 注册（plugin.json manifest）', () => {
  it('manifest 含 context_post_compact EP 的 2 个 impl', () => {
    const manifestPath = resolve(__dirname, '../plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const postCompactImpls = manifest.extImpls.filter(
      (i: { point: string }) => i.point === 'context_post_compact',
    );
    expect(postCompactImpls).toHaveLength(2);
    const ids = postCompactImpls.map((i: { implId: string }) => i.implId).sort();
    expect(ids).toEqual(['memory_skill_consolidation', 'noop_post_compact']);
  });

  it('ContextPostCompactPoint 定义为 ordered（v0.0.71 D1：group 字段已删，归属迁到 groups.json）', () => {
    expect(ContextPostCompactPoint.id).toBe('context_post_compact');
    expect(ContextPostCompactPoint.cardinality).toBe('ordered');
  });
});

// ============================================================
// noop_post_compact（dummy handler；forked scope 防递归 defense-in-depth）
// ============================================================

describe('noop_post_compact handler（dummy）', () => {
  it('handle 正常 resolve 不抛错（即便 ctx 缺所有运行时依赖）', async () => {
    const h = new NoopPostCompactHandler('noop_post_compact');
    await expect(h.handle(fakeCtx())).resolves.toBeUndefined();
  });

  it('handle 多次调用均空操作（无副作用）', async () => {
    const h = new NoopPostCompactHandler('noop_post_compact');
    const ctx = fakeCtx();
    for (let i = 0; i < 3; i++) {
      await expect(h.handle(ctx)).resolves.toBeUndefined();
    }
  });
});

// ============================================================
// memory_skill_consolidation handler（启动 fork-2 整理 agent）
// ============================================================

describe('memory_skill_consolidation handler', () => {
  it('缺 consolidateRunner → 跳过（不抛错；UT fixture 容错）', async () => {
    const h = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const ctx = fakeCtx({ toolDefinitions: fakeToolDefinitions() });
    await expect(h.handle(ctx)).resolves.toBeUndefined();
  });

  it('缺 toolDefinitions → 跳过（不抛错）', async () => {
    const h = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockResolvedValue({ answer: 'ok', usage: {} });
    const ctx = fakeCtx({ consolidateRunner: runner });
    await expect(h.handle(ctx)).resolves.toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it('toolDefinitions=[] → 跳过（避免无工具可用启动 fork-2）', async () => {
    const h = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockResolvedValue({ answer: 'ok', usage: {} });
    const ctx = fakeCtx({ consolidateRunner: runner, toolDefinitions: [] });
    await expect(h.handle(ctx)).resolves.toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it('装配后启动 fork-2：透传 runKind=consolidate / snapshot=prevSnapshot（压缩前完整对话）', async () => {
    const h = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockResolvedValue({ answer: '整理完成', usage: { input_tokens: 10 } });
    const toolDefs = fakeToolDefinitions();
    const prevSnapshot = fakeSnapshot();
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: toolDefs,
      prevSnapshot,
    });
    await h.handle(ctx);
    // fire-and-forget：handle 同步返回后 fork-2 还在跑，等 microtask flush
    await new Promise((r) => setImmediate(r));
    expect(runner).toHaveBeenCalledOnce();
    const call = runner.mock.calls[0]![0];
    expect(call.sessionId).toBe('sid-c');
    expect(call.runKind).toBe('consolidate');
    // 双快照契约：整理用 prevSnapshot（压缩前完整对话，原始信息最全），不用 postSnapshot
    expect(call.snapshot).toBe(prevSnapshot);
    expect(call.snapshot).not.toBe(ctx.postSnapshot);
    // task message = 纯 directive（旁路不变量）：snapshot 经 buffer 唯一承载对话历史，
    //   task text 不复述（复述 = 历史发两遍，与 fork-1 summary 同契约）
    expect(call.userMessage.role).toBe('user');
    expect(call.userMessage.content[0].text).not.toContain('记住我喜欢简洁');
    expect(call.userMessage.content[0].text.length).toBeGreaterThan(100); // directive 指令文本非空
  });

  it('fire-and-forget：runner reject → handle 不抛错（fork-2 失败不影响 compact）', async () => {
    const h = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockRejectedValue(new Error('fork-2 LLM 失败'));
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
    });
    // handle 同步返回不抛（fire-and-forget）；fork-2 reject 在背景被 .catch 吞掉
    await expect(h.handle(ctx)).resolves.toBeUndefined();
    // 等 microtask flush 让 promise 链走完（避免 unhandled rejection）
    await new Promise((r) => setImmediate(r));
    expect(runner).toHaveBeenCalledOnce();
  });
});

// ============================================================
// tryCompact 集成：post-compact 不再由 tryCompact 派发（收进 runCompact 末尾统一触发）
// ============================================================

/** 造假 CompactCtx（tryCompact 入参；含 snapshot，区别于 post handler 的双快照 ctx） */
function fakeTryCtx(scopeId = 'default') {
  return {
    config: { sessionId: 'sid-c' },
    snapshot: fakeSnapshot(),
    store: { accumulateUsage: vi.fn(async () => ['sid-c']) },
    scopeId,
  } as never;
}

/** 造假 PluginManager（只实现 getExtensionImpls，覆盖 3 个 EP） */
function fakePluginManager(opts: {
  shouldCompact?: boolean;
  doCompactRunner?: ReturnType<typeof vi.fn>;
  postCompactHandlers?: PostCompactHandler[];
  scopeId?: string;
}): { pm: PluginManager; doCompactRunCount: () => number } {
  const doCompactRunCount = () => (opts.doCompactRunner?.mock.calls.length ?? 0);
  const pm = {
    getExtensionImpls: (point: { id: string }, _scopeId: string) => {
      // 谓词：default scope 返 threshold（按 opts 返 true/false）；旁路 scope 返空（防递归）
      if (point.id === 'context_should_compact') {
        if ((opts.scopeId ?? 'default') !== 'default') return []; // 旁路 scope reject 等价
        return [{ check: async () => opts.shouldCompact ?? true }];
      }
      if (point.id === 'context_do_compact') {
        if ((opts.scopeId ?? 'default') !== 'default') return [];
        return [{ run: opts.doCompactRunner ?? vi.fn() }];
      }
      if (point.id === 'context_post_compact') {
        return opts.postCompactHandlers ?? [];
      }
      return [];
    },
  } as unknown as PluginManager;
  return { pm, doCompactRunCount };
}

describe('tryCompact：post-compact 收进 runCompact（不再由胶水派发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('谓词返 false → 不触发 doCompact 也不触发 post-compact', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const { pm } = fakePluginManager({
      shouldCompact: false,
      postCompactHandlers: [{ handle: handler } as unknown as PostCompactHandler],
    });
    await tryCompact(pm, fakeTryCtx());
    expect(handler).not.toHaveBeenCalled();
  });

  it('谓词 true → doCompact.run 被调一次；post handler 不由 tryCompact 派发（收进 runCompact）', async () => {
    const handlerA = { handle: vi.fn().mockResolvedValue(undefined) } as unknown as PostCompactHandler;
    const handlerB = { handle: vi.fn().mockResolvedValue(undefined) } as unknown as PostCompactHandler;
    const doRunner = vi.fn().mockResolvedValue(undefined);
    const { pm } = fakePluginManager({
      shouldCompact: true,
      doCompactRunner: doRunner,
      postCompactHandlers: [handlerA, handlerB],
    });
    await tryCompact(pm, fakeTryCtx());
    // 等 microtask flush（fire-and-forget sibling）
    await new Promise((r) => setImmediate(r));
    expect(doRunner).toHaveBeenCalledOnce();
    // post-compact 由 runCompact 成功后末尾统一派发，tryCompact 不再直接调任何 handler
    expect(handlerA.handle).not.toHaveBeenCalled();
    expect(handlerB.handle).not.toHaveBeenCalled();
  });

  it('旁路 scope（reject_should_compact）：谓词返空 → summary 不触发（防递归）', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const doRunner = vi.fn().mockResolvedValue(undefined);
    const { pm } = fakePluginManager({
      scopeId: 'summary',
      doCompactRunner: doRunner,
      postCompactHandlers: [{ handle: handler } as unknown as PostCompactHandler],
    });
    await tryCompact(pm, fakeTryCtx('summary'));
    expect(doRunner).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
