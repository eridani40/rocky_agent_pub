/**
 * tryCompact 胶水单元测试（v0.0.40 T6a 新建）
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2c.1（tryCompact 固定胶水）
 *       specs/tech/version_logs/v0.0.80.t1/change_plan.md §1.0/§1.1/§1.2/§2.2（sibling 双发）
 *
 * 覆盖：
 *   (a) shouldCompact EP 返 true → doCompact.run 被调
 *   (b) shouldCompact EP 返 false → doCompact.run 不调
 *   (c) scope 未激活 shouldCompact（返空）→ doCompact 不调（测试 tryCompact 的「空谓词兜底」分支；
 *       生产环境防递归不走此分支——forked scope 现显式选 reject_should_compact 恒 false，见 (f)）
 *   (d) pluginManager=null（UT fixture）→ 直接 return
 *   (e) shouldCompact active 但 doCompact scope 未激活（容错）→ 不抛
 *   (f) forked scope 显式 disable shouldCompact/doCompact（防递归不变量）→ 谓词/动作都不调
 *
 * summary sibling 单发（post-compact 已收进 runCompact 内部末尾统一触发）：
 *   - (g) 谓词 true → summary sibling 被调一次；post handler 不由 tryCompact 派发
 *   - (g2) 谓词 true → sharedCtx.pluginCtx 注入（scopeId/pluginManager/store 包装）
 *   - (h) 谓词 true → snapshot 被 deep clone（sibling 收到独立 clone，不污染 caller）
 *   - (i) 谓词 false → 不 clone、不派发 sibling
 *   - (j) summary sibling 异常 → .catch(log) 隔离，tryCompact 不抛
 *
 * 验证 tryCompact 是**非插件**的固定胶水：调 pluginManager.getExtensionImpls 取谓词/动作/handler。
 * 防递归不变量（spec §2c.3）：forked scope 显式选 reject_should_compact（恒 false）→ tryCompact 谓词检查处 return。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../plugin/registry';
import { PluginManager } from '../../plugin/plugin-manager';
import {
  BUILTIN_EXTENSION_POINTS,
  ContextShouldCompactPoint,
  ContextDoCompactPoint,
  ContextPostCompactPoint,
} from '../../plugin/extension-point';
import { LoadedScopeConfigProvider } from '../../plugin/scope-config-provider';
import { tryCompact } from '../try-compact';
import type { CompactCtx } from '../compact-types';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { SessionStore } from '../session-store';
import type { SummaryInfo } from '../session-store-types';
import type { Message } from '../../message/types';
import type {
  DoCompactAction,
  PostCompactHandler,
  ShouldCompactPredicate,
} from '../compact-types';

// ============================================================
// helpers：构造 mock impl + CompactCtx
// ============================================================

// ============================================================
// mock impl 工厂：用闭包跟踪 check/run 调用次数（避开 prototype 问题）
// ============================================================

/** 创建一对 (Class, calls) — Class 实例化后 check 返 calls.returnValue */
function makePredicateClass(calls: { checkCount: number; returnValue: boolean }) {
  return class {
    constructor(_implId: string, _cfg: Record<string, unknown> = {}) {}
    async check(_ctx: CompactCtx): Promise<boolean> {
      calls.checkCount++;
      return calls.returnValue;
    }
  };
}

/** 创建一对 (Class, calls) — Class 实例化后 run 计数到 calls.runCount */
function makeActionClass(calls: { runCount: number; lastCtx?: CompactCtx }) {
  return class {
    constructor(_implId: string, _cfg: Record<string, unknown> = {}) {}
    async run(ctx: CompactCtx): Promise<void> {
      calls.runCount++;
      calls.lastCtx = ctx;
    }
  };
}

/** 手工登记 impl 到 registry（用 register(manifest, ...implClasses) 形态） */
function registerImpl(
  registry: Registry,
  pointId: string,
  implId: string,
  implClass: unknown,
): void {
  registry.register(
    {
      id: 'test_plugin',
      label: 'Test',
      description: 'mock plugin',
      extImpls: [{ implId, point: pointId, impl: './mock.ts', description: 'mock impl' }],
    },
    implClass,
  );
}

function mkCtx(sessionId?: string): CompactCtx {
  const snapshot = {
    contextWindowUsage: { totalTokens: 80000, maxOutputTokens: 8000, tokenLimit: 100000 },
  } as unknown as ContextSnapshot;
  return {
    config: { sessionId: sessionId ?? 's1' } as SessionConfig,
    snapshot,
    store: {} as SessionStore,
    scopeId: 'default',
  };
}

// ============================================================
// tests
// ============================================================

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'try-compact-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('tryCompact 胶水（v0.0.40 T6a）', () => {
  it('(a) shouldCompact 返 true → doCompact.run 被调', async () => {
    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
    const predCalls = { checkCount: 0, returnValue: true };
    const actCalls = { runCount: 0 };
    registerImpl(registry, ContextShouldCompactPoint.id, 'mock_should', makePredicateClass(predCalls));
    registerImpl(registry, ContextDoCompactPoint.id, 'mock_do', makeActionClass(actCalls));
    // v0.0.179：default scope 激活 mock_should + mock_do（impl 列表模型，membership = active）
    const provider = new LoadedScopeConfigProvider([
      {
        scopeId: 'default', name: 'Default',
        activatedPoints: [ContextShouldCompactPoint.id, ContextDoCompactPoint.id],
        impls: {
          mock_should: { order: 1 },
          mock_do: { order: 1 },
        },
      },
    ]);
    const pm = new PluginManager({ registry, scopeConfigs: provider });

    await tryCompact(pm, mkCtx());

    expect(predCalls.checkCount).toBe(1);
    expect(actCalls.runCount).toBe(1);
  });

  it('(b) shouldCompact 返 false → doCompact.run 不调', async () => {
    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
    const predCalls = { checkCount: 0, returnValue: false };
    const actCalls = { runCount: 0 };
    registerImpl(registry, ContextShouldCompactPoint.id, 'mock_should', makePredicateClass(predCalls));
    registerImpl(registry, ContextDoCompactPoint.id, 'mock_do', makeActionClass(actCalls));
    const provider = new LoadedScopeConfigProvider([
      {
        scopeId: 'default', name: 'Default',
        activatedPoints: [ContextShouldCompactPoint.id, ContextDoCompactPoint.id],
        impls: {
          mock_should: { order: 1 },
          mock_do: { order: 1 },
        },
      },
    ]);
    const pm = new PluginManager({ registry, scopeConfigs: provider });

    await tryCompact(pm, mkCtx());

    expect(predCalls.checkCount).toBe(1);
    expect(actCalls.runCount).toBe(0);
  });

  it('(c) forked scope 关 shouldCompact/doCompact（防递归不变量）→ 谓词/动作都不调', async () => {
    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
    const predCalls = { checkCount: 0, returnValue: true };
    const actCalls = { runCount: 0 };
    registerImpl(registry, ContextShouldCompactPoint.id, 'mock_should', makePredicateClass(predCalls));
    registerImpl(registry, ContextDoCompactPoint.id, 'mock_do', makeActionClass(actCalls));
    // v0.0.179：forked scope 不列 mock_should + mock_do（不在 = inactive，membership 模型）
    // 对应生产 forked.yaml：context_should_compact → reject_should_compact（恒 false）
    const provider = new LoadedScopeConfigProvider([
      {
        scopeId: 'default', name: 'Default',
        activatedPoints: [ContextShouldCompactPoint.id, ContextDoCompactPoint.id],
        impls: {
          mock_should: { order: 1 },
          mock_do: { order: 1 },
        },
      },
      {
        scopeId: 'forked', name: 'forked',
        activatedPoints: [ContextShouldCompactPoint.id, ContextDoCompactPoint.id],
        // forked 不列 mock_should/mock_do（membership = inactive，等价旧 enabled:false）
        impls: {},
      },
    ]);
    const pm = new PluginManager({ registry, scopeConfigs: provider });

    // ctx 用 forked scopeId → getExtensionImpls(ContextShouldCompactPoint, 'forked') 返空（impls 不在）
    const ctx = mkCtx();
    ctx.scopeId = 'forked';
    await tryCompact(pm, ctx);

    // 谓词 check 不被调（active 过滤掉非 membership impl → 谓词空 → 谓词检查处 return）
    expect(predCalls.checkCount).toBe(0);
    expect(actCalls.runCount).toBe(0);
  });

  it('(d) pluginManager=null（UT fixture）→ 直接 return，不抛', async () => {
    const ctx = mkCtx();
    await expect(tryCompact(null, ctx)).resolves.toBeUndefined();
  });

  it('(e) shouldCompact active 但 doCompact scope 未激活（容错）→ 不抛', async () => {
    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
    const predCalls = { checkCount: 0, returnValue: true };
    // 故意只登记谓词，不登记动作 → getExtensionImpls(ContextDoCompactPoint, 'default') 返空
    registerImpl(registry, ContextShouldCompactPoint.id, 'mock_should', makePredicateClass(predCalls));
    const provider = new LoadedScopeConfigProvider([
      {
        scopeId: 'default', name: 'Default',
        // v0.0.179：只激活 shouldCompact；doCompact 不激活 → 回退 default（default 也不激活 → 返空）
        activatedPoints: [ContextShouldCompactPoint.id],
        impls: { mock_should: { order: 1 } },
      },
    ]);
    const pm = new PluginManager({ registry, scopeConfigs: provider });

    // 谓词返 true 但动作缺失 → tryCompact 容错跳过（不抛）
    await expect(tryCompact(pm, mkCtx())).resolves.toBeUndefined();
    expect(predCalls.checkCount).toBe(1);
  });
});

// ============================================================
// summary sibling 单发 + pluginCtx 注入测试（post-compact 已收进 runCompact 内部）
// ============================================================

/** 造假 PluginManager（覆盖 3 EP：should/do/post_compact）*/
function fakePMForSibling(opts: {
  shouldCompact?: boolean;
  doAction?: DoCompactAction;
  postHandler?: PostCompactHandler;
}): PluginManager {
  return {
    getExtensionImpls: (point: { id: string }, _scopeId: string) => {
      if (point.id === 'context_should_compact') {
        const pred: ShouldCompactPredicate = {
          check: async () => opts.shouldCompact ?? true,
        };
        return [pred];
      }
      if (point.id === 'context_do_compact') {
        return opts.doAction ? [opts.doAction] : [];
      }
      if (point.id === 'context_post_compact') {
        return opts.postHandler ? [opts.postHandler] : [];
      }
      return [];
    },
  } as unknown as PluginManager;
}

describe('tryCompact summary sibling 单发（post-compact 收进 runCompact 末尾）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(g) 谓词 true → summary sibling 被调一次；post handler 不由 tryCompact 派发（收进 runCompact）', async () => {
    const doAction = { run: vi.fn().mockResolvedValue(undefined) } as unknown as DoCompactAction;
    const postHandler = { handle: vi.fn().mockResolvedValue(undefined) } as unknown as PostCompactHandler;
    const pm = fakePMForSibling({ shouldCompact: true, doAction, postHandler });
    await tryCompact(pm, mkCtx());
    // 等 microtask flush（sibling fire-and-forget）
    await new Promise((r) => setImmediate(r));
    expect(doAction.run).toHaveBeenCalledOnce();
    // post-compact 不再由 tryCompact 并发派发（改为 runCompact 成功后末尾统一触发）
    expect(postHandler.handle).not.toHaveBeenCalled();
  });

  it('(g2) 谓词 true → sharedCtx.pluginCtx 注入（scopeId/pluginManager/store/taskLock 包装）', async () => {
    let receivedCtx: CompactCtx | null = null;
    const doAction = {
      run: vi.fn().mockImplementation(async (ctx: CompactCtx) => { receivedCtx = ctx; }),
    } as unknown as DoCompactAction;
    const pm = fakePMForSibling({ shouldCompact: true, doAction });
    const ctx = mkCtx();
    await tryCompact(pm, ctx);
    await new Promise((r) => setImmediate(r));

    expect(receivedCtx).not.toBeNull();
    const pluginCtx = receivedCtx!.pluginCtx;
    expect(pluginCtx).toBeDefined();
    expect(pluginCtx!.scopeId).toBe(ctx.scopeId);
    expect(pluginCtx!.pluginManager).toBe(pm);
    expect(pluginCtx!.store).toBe(ctx.store);
  });

  it('(h) 谓词 true → snapshot 被 deep clone（sibling 收到独立 clone，不被 mutate 污染 caller）', async () => {
    let receivedSnapshot: ContextSnapshot | null = null;
    const doAction = {
      run: vi.fn().mockImplementation(async (ctx: CompactCtx) => {
        receivedSnapshot = ctx.snapshot;
        // 在 sibling 内 mutate 自己的 snapshot，验证 caller 的 ctx.snapshot 不受影响
        (ctx.snapshot as unknown as { __mutated: boolean }).__mutated = true;
      }),
    } as unknown as DoCompactAction;
    const pm = fakePMForSibling({ shouldCompact: true, doAction });
    const ctx = mkCtx();
    const callerSnapshotBefore = ctx.snapshot;
    await tryCompact(pm, ctx);
    await new Promise((r) => setImmediate(r));

    // sibling 收到的 snapshot 与 caller ctx.snapshot 是不同对象（deep clone）
    expect(receivedSnapshot).not.toBeNull();
    expect(receivedSnapshot).not.toBe(callerSnapshotBefore);
    // caller snapshot 不被 mutate 污染（sibling 内修改 __mutated 不传播）
    expect((callerSnapshotBefore as unknown as { __mutated?: boolean }).__mutated).toBeUndefined();
  });

  it('(i) 谓词 false → 不 clone、不派发 sibling', async () => {
    const doAction = { run: vi.fn() } as unknown as DoCompactAction;
    const postHandler = { handle: vi.fn() } as unknown as PostCompactHandler;
    const pm = fakePMForSibling({ shouldCompact: false, doAction, postHandler });
    const ctx = mkCtx();
    await tryCompact(pm, ctx);
    await new Promise((r) => setImmediate(r));
    expect(doAction.run).not.toHaveBeenCalled();
    expect(postHandler.handle).not.toHaveBeenCalled();
  });

  it('(j) summary sibling 异常 → .catch(log) 隔离，tryCompact 不抛', async () => {
    const doAction = {
      run: vi.fn().mockRejectedValue(new Error('summary LLM 失败')),
    } as unknown as DoCompactAction;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pm = fakePMForSibling({ shouldCompact: true, doAction });
    // tryCompact 自身不抛（sibling 异常 .catch(log)）
    await expect(tryCompact(pm, mkCtx())).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(doAction.run).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

// 抑制未使用导入告警（保留以备后续扩展用）
void ({} as SummaryInfo);
void ({} as Message);
