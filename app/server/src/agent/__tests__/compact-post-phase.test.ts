/**
 * compact 后置阶段单测（postSnapshot 合成 + usage 立即更新 + post-compact EP 派发）
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2c.1/§2d
 *
 * 覆盖不变量（post handler 收进 runCompact 内部 + 手动/自动统一）：
 *   1. prevSnapshot = runCompact 入口传入的压缩前完整对话（含中间消息，引用相等）
 *   2. postSnapshot = 压缩后视图（msg[0]=summaryMsg 含烘焙 block；recent=summaryUpTo 之后）
 *   3. usage 立即更新（updateContextWindowUsage 末次调用 = postSnapshot 重算值，消时滞）
 *   4. EP 可插拔：getExtensionImpls(ContextPostCompactPoint, pluginCtx.scopeId) 按 scope 读配置；
 *      handlers 空 → 静默跳过不影响 compact
 *   5. 失败隔离：handler 同步 throw / 异步 reject → runCompact 仍返 true + summary 已写 + markDone 已调
 *   6. 手动路径（ContextEngine.compact）也触发 post handler（修「手动 compact 不触发 consolidate」）
 *   7. 自动路径（tryCompact → summary sibling → runCompact）触发 post handler；
 *      prevSnapshot 深等于触发 ctx.snapshot（structuredClone）但非同一引用
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { runCompact } from '../context-compact-runner';
import { tryCompact } from '../try-compact';
import { Registry } from '../../plugin/registry';
import { PluginManager } from '../../plugin/plugin-manager';
import {
  BUILTIN_EXTENSION_POINTS,
  ContextShouldCompactPoint,
  ContextDoCompactPoint,
  ContextPostCompactPoint,
} from '../../plugin/extension-point';
import { LoadedScopeConfigProvider } from '../../plugin/scope-config-provider';
import { SessionKind } from '@app/shared';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type {
  CompactCtx,
  CompactPluginContext,
  PostCompactCtx,
  PostCompactHandler,
} from '../compact-types';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'compact-post-phase-'));
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

function newConfig(sessionId: string): SessionConfig {
  return {
    sessionId,
    systemPrompt: 'You are a helpful assistant.',
    client: { contextWindow: 100000 },
    modelId: 'test-model',
  } as unknown as SessionConfig;
}

/** 种 n 条对话消息（user/assistant 交替，文本含序号便于断言中间对话） */
async function seed(sid: string, n = 5): Promise<void> {
  await store.createSession({ id: sid });
  for (let i = 0; i < n; i++) {
    await store.appendMessages(sid, [
      {
        id: ulid(),
        sessionId: sid,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `msg-${i + 1} 中间对话内容` }],
      },
    ]);
  }
}

/** assemble 产 snapshot（无 plugin fallback 路径：全 transcript） */
async function makeSnapshot(config: SessionConfig): Promise<ContextSnapshot> {
  return new ContextEngine({ store }).assemble(config);
}

function fakeSideRunner(answer = '<summary>FINAL_SUMMARY</summary>') {
  return vi.fn(async () => ({ answer, usage: {} }));
}

/** 捕获 handle 入参的 post handler */
function captureHandler(captured: { ctx?: PostCompactCtx }): PostCompactHandler {
  return { handle: vi.fn(async (ctx: PostCompactCtx) => { captured.ctx = ctx; }) };
}

/** 假 PluginManager：只有 context_post_compact 返 handlers，其余 EP 返空 */
function fakePm(handlers: PostCompactHandler[]) {
  const getExtensionImpls = vi.fn((point: { id: string }, _scopeId: string): unknown[] =>
    point.id === ContextPostCompactPoint.id ? handlers : [],
  );
  return {
    pm: { getExtensionImpls } as unknown as PluginManager,
    getExtensionImpls,
  };
}

function fakePluginCtx(pm: PluginManager, scopeId = 'default'): CompactPluginContext {
  return { scopeId, pluginManager: pm, consolidateRunner: null, store };
}

describe('runCompact 后置阶段（postSnapshot + usage 更新 + post-compact EP）', () => {
  it('不变量1+2：handler 收 prevSnapshot（压缩前完整对话，入口引用）+ postSnapshot（压缩后视图）', async () => {
    const sid = ulid();
    const config = newConfig(sid);
    await seed(sid, 5);
    const snapshot = await makeSnapshot(config);
    expect(snapshot.messages).toHaveLength(5);

    const captured: { ctx?: PostCompactCtx } = {};
    const { pm } = fakePm([captureHandler(captured)]);
    const ok = await runCompact(
      store, undefined, config, snapshot, fakeSideRunner(),
      'trigger-msg-1', undefined, undefined, fakePluginCtx(pm),
    );
    expect(ok).toBe(true);
    expect(captured.ctx).toBeDefined();

    // prevSnapshot = 入口传入对象（引用相等），含全部中间对话
    expect(captured.ctx!.prevSnapshot).toBe(snapshot);
    expect(captured.ctx!.prevSnapshot.messages).toHaveLength(5);
    expect(captured.ctx!.prevSnapshot.messages[2]!.content[0]).toMatchObject({
      type: 'text', text: 'msg-3 中间对话内容',
    });
    // trigger meta 透传
    expect(captured.ctx!.triggerMessageId).toBe('trigger-msg-1');

    // postSnapshot = 压缩后视图：msg[0] = summaryMsg（id=summary:version，文本=烘焙 block 含 summary 正文）
    const post = captured.ctx!.postSnapshot;
    const written = await store.getSummary(sid);
    expect(post.messages[0]!.id).toBe(`summary:${written!.version}`);
    expect(post.messages[0]!.role).toBe('user');
    const postText = (post.messages[0]!.content[0] as { text: string }).text;
    expect(postText).toContain('FINAL_SUMMARY');
    expect(postText).toBe(written!.block);
    // recent = summaryUpTo（入口快照末条）之后的消息 → 空；整视图只剩 summaryMsg
    expect(post.messages).toHaveLength(1);
    expect(post.messages.length).toBeLessThan(captured.ctx!.prevSnapshot.messages.length);
    expect(post.summary?.content).toBe('FINAL_SUMMARY');
  });

  it('不变量3：usage 立即更新——末次 updateContextWindowUsage = postSnapshot 重算值', async () => {
    const sid = ulid();
    const config = newConfig(sid);
    await seed(sid, 5);
    const snapshot = await makeSnapshot(config);
    const cwSpy = vi.spyOn(store, 'updateContextWindowUsage');

    const captured: { ctx?: PostCompactCtx } = {};
    const { pm } = fakePm([captureHandler(captured)]);
    await runCompact(store, undefined, config, snapshot, fakeSideRunner(), undefined, undefined, undefined, fakePluginCtx(pm));

    // 末次调用 = compact 后置写回（assemble 那次在前面）
    const lastCall = cwSpy.mock.calls[cwSpy.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe(sid);
    const cw = lastCall[1];
    // messageTokens = summaryMsg 文本 char × ratio（压缩后视图口径，非压缩前 5 条全量）
    const block = (await store.getSummary(sid))!.block!;
    const ratio = await store.getRatio(sid);
    expect(cw.messageTokens).toBe(Math.round(block.length * ratio));
    // 与 handler 收到的 postSnapshot.contextWindowUsage 同源
    expect(captured.ctx!.postSnapshot.contextWindowUsage).toEqual(cw);
    cwSpy.mockRestore();
  });

  it('不变量4：EP 按 pluginCtx.scopeId 读配置；scope 无 handler → 静默跳过且 compact 成功', async () => {
    const sid = ulid();
    const config = newConfig(sid);
    await seed(sid, 3);
    const snapshot = await makeSnapshot(config);

    const { pm, getExtensionImpls } = fakePm([]); // scope 无 post_compact handler
    const pluginCtx = fakePluginCtx(pm, 'playground-rocky:parent:main');
    const ok = await runCompact(
      store, undefined, config, snapshot, fakeSideRunner(), undefined, undefined, undefined, pluginCtx,
    );
    expect(ok).toBe(true);
    // 按 pluginCtx.scopeId 读配置（EP 可插拔，不硬编码 default）
    expect(getExtensionImpls).toHaveBeenCalledWith(ContextPostCompactPoint, 'playground-rocky:parent:main');
  });

  it('不变量5：失败隔离——handler 同步 throw / 异步 reject 都不影响已完成的 compact', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['sync-throw', 'async-reject'] as const) {
      const sid = ulid();
      const config = newConfig(sid);
      await seed(sid, 3);
      const snapshot = await makeSnapshot(config);
      const taskLock = { acquire: vi.fn(() => true), markDone: vi.fn(), markFailed: vi.fn() };
      const handler: PostCompactHandler = {
        handle: mode === 'sync-throw'
          ? vi.fn(() => { throw new Error('boom'); }) as never
          : vi.fn(async () => { throw new Error('boom'); }),
      };
      const { pm } = fakePm([handler]);
      const ok = await runCompact(
        store, taskLock as never, config, snapshot, fakeSideRunner(),
        undefined, undefined, undefined, fakePluginCtx(pm),
      );
      expect(ok).toBe(true); // compact 不受 handler 异常影响
      expect(taskLock.markDone).toHaveBeenCalledWith(sid, 'compact');
      expect(taskLock.markFailed).not.toHaveBeenCalled();
      expect((await store.getSummary(sid))!.content).toBe('FINAL_SUMMARY');
      await new Promise((r) => setImmediate(r)); // flush async-reject 的 .catch
    }
    warnSpy.mockRestore();
  });

  it('不变量6（手动路径）：ContextEngine.compact 也触发 post handler（含 consolidateRunner 透传）', async () => {
    const sid = ulid();
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });
    const config = { ...newConfig(sid), kind } as SessionConfig;
    await seed(sid, 4);
    const snapshot = await makeSnapshot(config);

    const captured: { ctx?: PostCompactCtx } = {};
    const { pm } = fakePm([captureHandler(captured)]);
    const consolidateRunner = vi.fn();
    const engine = new ContextEngine({ store, pluginManager: pm });
    engine.setSideRunner(fakeSideRunner() as never);
    engine.setConsolidateRunner(consolidateRunner as never);
    // 绕开「pluginManager 非空 + assemble 链空 → hard fail」：patch assemble 直返预产 snapshot
    engine.assemble = vi.fn().mockResolvedValue(snapshot);

    const ok = await engine.compact(config);
    expect(ok).toBe(true);
    expect(captured.ctx).toBeDefined();
    // prevSnapshot = 手动入口 assemble 产出的压缩前快照
    expect(captured.ctx!.prevSnapshot).toBe(snapshot);
    // pluginCtx 从 engine 内部依赖构造：scopeId=canonicalId + consolidateRunner 透传
    expect(captured.ctx!.scopeId).toBe('playground-rocky:parent:main');
    expect(captured.ctx!.consolidateRunner).toBe(consolidateRunner);
    expect(captured.ctx!.store).toBe(store);
  });
});

describe('不变量7（自动路径）：tryCompact → summary sibling → runCompact → post handler', () => {
  /** 仿 summary_do_compact 的 mock action：薄壳委托 runCompact + 透传 pluginCtx */
  class RunCompactAction {
    constructor(_implId: string, _cfg: Record<string, unknown> = {}) {}
    async run(ctx: CompactCtx): Promise<void> {
      await runCompact(
        ctx.store!, ctx.taskLock, ctx.config, ctx.snapshot, ctx.sideRunner!,
        ctx.triggerMessageId, ctx.triggerUsage, undefined, ctx.pluginCtx,
      );
    }
  }

  function registerImpl(registry: Registry, pointId: string, implId: string, implClass: unknown): void {
    registry.register(
      {
        id: 'test_plugin', label: 'Test', description: 'mock plugin',
        extImpls: [{ implId, point: pointId, impl: './mock.ts', description: 'mock impl' }],
      },
      implClass,
    );
  }

  it('谓词 true → summary 完成后 post handler 被调；prevSnapshot 深等于触发快照（clone 非引用）', async () => {
    const sid = ulid();
    const config = newConfig(sid);
    await seed(sid, 5);
    const snapshot = await makeSnapshot(config);

    const captured: { ctx?: PostCompactCtx } = {};
    class CapturePostHandler {
      constructor(_implId: string, _cfg: Record<string, unknown> = {}) {}
      async handle(ctx: PostCompactCtx): Promise<void> { captured.ctx = ctx; }
    }
    class TruePredicate {
      constructor(_implId: string, _cfg: Record<string, unknown> = {}) {}
      async check(): Promise<boolean> { return true; }
    }

    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
    registerImpl(registry, ContextShouldCompactPoint.id, 'mock_should', TruePredicate);
    registerImpl(registry, ContextDoCompactPoint.id, 'mock_do', RunCompactAction);
    registerImpl(registry, ContextPostCompactPoint.id, 'mock_post', CapturePostHandler);
    const provider = new LoadedScopeConfigProvider([
      {
        scopeId: 'default', name: 'Default',
        activatedPoints: [
          ContextShouldCompactPoint.id, ContextDoCompactPoint.id, ContextPostCompactPoint.id,
        ],
        impls: {
          mock_should: { order: 1 }, mock_do: { order: 1 }, mock_post: { order: 1 },
        },
      },
    ]);
    const pm = new PluginManager({ registry, scopeConfigs: provider });

    const ctx: CompactCtx = {
      config, snapshot, store, scopeId: 'default',
      sideRunner: fakeSideRunner() as never,
    };
    await tryCompact(pm, ctx);
    // summary sibling fire-and-forget → 轮询等 post handler 被调
    await vi.waitFor(() => expect(captured.ctx).toBeDefined(), { timeout: 3000, interval: 20 });

    // prevSnapshot = 触发快照的 structuredClone：内容深等（含中间对话）但非同一引用
    expect(captured.ctx!.prevSnapshot).not.toBe(snapshot);
    expect(captured.ctx!.prevSnapshot.messages).toHaveLength(5);
    expect(captured.ctx!.prevSnapshot.messages[2]!.content[0]).toMatchObject({
      type: 'text', text: 'msg-3 中间对话内容',
    });
    // postSnapshot = 压缩后视图
    expect(captured.ctx!.postSnapshot.messages[0]!.id).toMatch(/^summary:/);
    // summary 已落库
    expect((await store.getSummary(sid))!.content).toBe('FINAL_SUMMARY');
  });
});
