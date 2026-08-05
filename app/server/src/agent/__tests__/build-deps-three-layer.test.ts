/**
 * buildRunDeps 三层一致 UT（v0.0.48 Task 2 + v0.0.204 T3 合并）
 * 参考: specs/tech/agent/tools/[P0]tool_policy.md §4.2/§4.3 + §6（RunSpec 字段关系）
 *
 * 核心不变量（B1/B2 防回归）：
 *   - SessionConfig.tools（resolveToolSet 在 session-config 算出）
 *   - RunSpec.toolDefinitions（buildRunDeps 派生自 config.tools）
 *   - RunSpec.allowedTools（buildRunDeps 派生自 config.tools）
 *   三层 name set 必须等价（无独立裁剪逻辑；main 路径）。
 *
 * v0.0.204 T3：buildMainDeps → buildRunDeps（profile 驱动单装配）。
 */
import { defaultTools } from '../../tools/registry';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { ToolExecutionEngine } from '../../tools/engine';
import { InboxStore } from '../inbox';
import { ReplayableEventBus } from '../event-bus';
import { buildRunDeps } from '../build-run-deps';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import { SessionKind } from '@app/shared';
import type { AbortControllerHandle } from '../agent-interface';
import type { SessionConfig } from '../context-types';
import type { ToolDefinition } from '../../tools/types';

let tmpRoot: string;
let bus: ReplayableEventBus;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let tools: ReturnType<typeof defaultTools>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-build-deps-3layer-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  bus = new ReplayableEventBus({ replayable: true });
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  contextEngine = new ContextEngine({ store });
  toolEngine = new ToolExecutionEngine();
  inbox = new InboxStore();
  tools = defaultTools(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** main profile mock（drainMode='eager' / persistsRun=true / touchesStateMachine=true / usagePartition='current'） */
function mockMainPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:main',
    enabled: true,
    toolBound: [],
    toolDefinitionsSource: 'own',
    runShape: {
      drainMode: 'eager',
      backgroundPath: false,
      maxIterDefault: 25,
      touchesStateMachine: true,
      persistsRun: true,
      usagePartition: 'current',
    },
    lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false },
    skillSource: 'global-enabled',
    eosStop: [],
    autoNaming: false,
    preloadContext: 'none',
  };
  return {
    profile: vi.fn(() => profile),
    resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })),
  };
}

const mainKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });

/**
 * 构造 SessionConfig，强制指定 config.tools 子集（模拟 resolveToolSet 在 session-config 已算出）。
 * 用于验证 buildRunDeps 三层一致：无论 config.tools 是什么子集，spec 派生字段都跟随。
 */
function newConfigWithTools(sessionId: string, toolSubsetNames: string[]): SessionConfig {
  const subset = tools.filter((t) => toolSubsetNames.includes(t.definition.name));
  return {
    sessionId,
    systemPrompt: 'sys',
    client: {
      contextWindow: 100000,
      async *stream() { /* empty */
      },
      async call() { return { message: { content: [] }, usage: {}, stopReason: 'stop' as const }; },
    } as unknown as SessionConfig['client'],
    modelId: 'mock-model',
    tools: subset,
    workdir: tmpRoot,
    maxIterations: 25,
    kind: mainKind,
  } as SessionConfig;
}

const controller: AbortControllerHandle = { runId: 'r1', aborted: false };

// ============================================================
// 1. 三层一致：config.tools / spec.toolDefinitions / spec.allowedTools name set 等价
// ============================================================

describe('buildRunDeps 三层一致（v0.0.48 B1/B2 防回归；T3 main 路径）', () => {
  const cases: Array<{ name: string; subset: string[] }> = [
    { name: 'playground-rocky 12 工具', subset: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'web_search', 'web_fetch', 'browser', 'agent', 'send_message'] },
    { name: 'studio-squad 仅 send_message', subset: ['send_message'] },
    { name: 'studio-leader 15 工具（无 agent）', subset: ['send_message', 'team', 'goal', 'requirement', 'task', 'read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'web_search', 'web_fetch', 'browser'] },
    { name: 'studio-mate 15 工具（无 goal）', subset: ['send_message', 'team', 'requirement', 'task', 'read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'agent', 'web_search', 'web_fetch', 'browser'] },
    { name: 'subagent 11 工具（无 agent + 4 工作项）', subset: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'web_search', 'web_fetch', 'browser', 'send_message'] },
    { name: '空集（边界）', subset: [] },
  ];

  for (const { name, subset } of cases) {
    it(`${name}：spec.toolDefinitions / spec.allowedTools = config.tools name set`, () => {
      const config = newConfigWithTools('s1', subset);
      const { spec } = buildRunDeps({
        config, bus, store, inbox, contextEngine, toolEngine,
        controller,
        kind: mainKind,
        sessionTypePolicy: mockMainPolicy(),
      });
      const configNames = new Set((config.tools as Array<{ definition: { name: string } }>)
        .map((t) => t.definition.name));
      const specDefNames = new Set((spec.toolDefinitions as ToolDefinition[]).map((d) => d.name));
      const allowedNames = new Set(spec.allowedTools);
      // 三层 name set 等价
      expect(specDefNames).toEqual(configNames);
      expect(allowedNames).toEqual(configNames);
    });
  }
});

// ============================================================
// 2. main RunSpec 关键字段（profile 字段派生）
// ============================================================

describe('buildRunDeps main 路径 profile 字段派生（T3）', () => {
  it('main profile：spec.drainMode=eager / backgroundPath=false / wireStore 设 / drainMode 触发 wireInbox 设', () => {
    const config = newConfigWithTools('s1', ['read']);
    const { spec } = buildRunDeps({
      config, bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind: mainKind,
      sessionTypePolicy: mockMainPolicy(),
    });
    expect(spec.drainMode).toBe('eager');
    expect(spec.backgroundPath).toBe(false);
    expect(spec.runKind).toBe('main');
    // main: wireStore/wireInbox/wireStateMachine 设（persistsRun + touchesStateMachine 触发）
    expect(spec.wireStore).toBeDefined();
    expect(spec.wireInbox).toBeDefined();
    expect(spec.wireStateMachine).toBeDefined();
    // wireTaskLock: 取决于 ContextEngine 是否注入 taskLock（mock ContextEngine 可返 undefined，不强断言）
    // main wireInitState 不设（走默认 initState(store)）
    expect(spec.wireInitState).toBeUndefined();
  });
});

// ============================================================
// 3. subagent config.tools 子集 → spec 同步（B1 playground squad 泄漏修复）
// ============================================================

describe('subagent config.tools 子集同步（B1 防回归）', () => {
  it('config.tools=[read,send_message]（subagent resolveTools 产出）→ spec 三层同 set', () => {
    const config = newConfigWithTools('sub-1', ['read']);
    const { spec } = buildRunDeps({
      config, bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind: mainKind,
      sessionTypePolicy: mockMainPolicy(),
    });
    expect(spec.toolDefinitions.map((d: ToolDefinition) => d.name)).toEqual(['read']);
    expect(spec.allowedTools).toEqual(['read']);
    // B1 防回归：spec.allowedTools 不含 send_message（除非 config.tools 含）
    expect(spec.allowedTools).not.toContain('send_message');
    expect(spec.allowedTools).not.toContain('agent');
    expect(spec.allowedTools).not.toContain('goal');
  });
});

// ============================================================
// v0.0.207 T2：buildRunDeps 装 revocable handle（main + forked 都包）
// ============================================================

describe('[v0.0.207 T2] buildRunDeps 装 revocable handle（authority transfer 装配）', () => {
  it('main：wireEmitCtx.bus 是 proxy；loop.revokeSideEffects 后 emit 变 no-op', () => {
    const config = newConfigWithTools('s1', ['read']);
    const { spec, loop } = buildRunDeps({
      config, bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind: mainKind,
      sessionTypePolicy: mockMainPolicy(),
    });
    // revoke 前：bus.emit 正常
    const emitSpy = vi.spyOn(bus, 'emit');
    spec.wireEmitCtx!.bus.emit('g1', { data: { type: 'x' }, timestamp: 't' });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    // revoke
    loop.revokeSideEffects();
    // revoke 后：bus.emit 变 no-op
    spec.wireEmitCtx!.bus.emit('g2', { data: { type: 'y' }, timestamp: 't' });
    expect(emitSpy).toHaveBeenCalledTimes(1); // 未新增
    // 原 bus 引用不受影响（abort api 直发 bus 仍生效）
    bus.emit('g3', { data: { type: 'z' }, timestamp: 't' });
    expect(emitSpy).toHaveBeenCalledTimes(2);
  });

  it('main：wireContextEngine 是 proxy；loop.revokeSideEffects 后 ingest 变 async no-op', async () => {
    const config = newConfigWithTools('s1', ['read']);
    const { spec, loop } = buildRunDeps({
      config, bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind: mainKind,
      sessionTypePolicy: mockMainPolicy(),
    });
    const ingestSpy = vi.spyOn(contextEngine, 'ingest');
    // revoke 前：ingest 正常
    await spec.wireContextEngine.ingest(config, [], 'default', false, { runId: 'r1' });
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    // revoke
    loop.revokeSideEffects();
    // revoke 后：ingest 返 Promise.resolve() 不触原方法
    const ret = await spec.wireContextEngine.ingest(config, [], 'default', false, { runId: 'r1' });
    expect(ret).toBeUndefined();
    expect(ingestSpy).toHaveBeenCalledTimes(1); // 未新增
  });

  it('forked（summary）：也包 revocable（不被调 revoke 时等同透传）', async () => {
    // summary profile mock
    const summaryProfile: ResolvedSessionProfile = {
      id: 'playground-rocky:parent:summary',
      enabled: true, toolBound: [], toolDefinitionsSource: 'host-snapshot',
      runShape: { drainMode: 'none', backgroundPath: true, maxIterDefault: 1, touchesStateMachine: false, persistsRun: false, usagePartition: 'summary' },
      lifecycleHooks: { abortFinalize: 'none', cascadeChildren: false },
      eventChannel: { emitDefault: true },
      modelHints: { readsSquadDefault: false }, skillSource: 'none', eosStop: [],
      autoNaming: false, preloadContext: 'none',
    };
    const summaryPolicy: SessionTypePolicy = {
      profile: vi.fn(() => summaryProfile),
      resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })),
    };
    const summaryKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'summary' });
    const config = newConfigWithTools('s1', ['read']);
    const snapshot = {
      messages: [],
      systemPrompt: '',
      tools: [],
      usage: { totalTokens: 0 },
    } as never;
    const userMsg = { id: 'm1', sessionId: 's1', role: 'user', content: [] } as never;
    const { spec, loop } = buildRunDeps({
      config, bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind: summaryKind,
      sessionTypePolicy: summaryPolicy,
      snapshot,
      userMessage: userMsg,
    });
    // forked 不调 revoke：proxy 等同透传，wireEmitCtx.bus.emit 正常
    const emitSpy = vi.spyOn(bus, 'emit');
    spec.wireEmitCtx!.bus.emit('g', { data: {}, timestamp: 't' });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    // forked 也支持 revokeSideEffects（机制统一，但 abortRun 不调它）
    expect(typeof loop.revokeSideEffects).toBe('function');
  });

  it('main：loop.revokeSideEffects 同时吊销 emit + ce（组合 revoke）', async () => {
    const config = newConfigWithTools('s1', ['read']);
    const { spec, loop } = buildRunDeps({
      config, bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind: mainKind,
      sessionTypePolicy: mockMainPolicy(),
    });
    const emitSpy = vi.spyOn(bus, 'emit');
    const ingestSpy = vi.spyOn(contextEngine, 'ingest');
    loop.revokeSideEffects();
    spec.wireEmitCtx!.bus.emit('g', { data: {}, timestamp: 't' });
    await spec.wireContextEngine.ingest(config, [], 'default', false, {});
    expect(emitSpy).not.toHaveBeenCalled();
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// v0.0.217：旁路 allowedTools = resolveToolSet 单源（装配接线断言）
// ============================================================

describe('旁路 allowedTools = resolveToolSet 单源（v0.0.217）', () => {
  /** 旁路 profile mock 工厂（summary/consolidate 共用骨架，id/usagePartition 按 runKind 定制） */
  function sideProfile(runKind: 'summary' | 'consolidate', toolBound: string[]): ResolvedSessionProfile {
    return {
      id: `playground-rocky:parent:${runKind}`,
      enabled: true, toolBound, toolDefinitionsSource: 'host-snapshot',
      runShape: { drainMode: 'none', backgroundPath: true, maxIterDefault: 1, touchesStateMachine: false, persistsRun: false, usagePartition: runKind },
      lifecycleHooks: { abortFinalize: 'none', cascadeChildren: false },
      eventChannel: { emitDefault: true },
      modelHints: { readsSquadDefault: false }, skillSource: 'none', eosStop: [],
      autoNaming: false, preloadContext: 'none',
    };
  }

  const userMsg = { id: 'm1', sessionId: 's1', role: 'user', content: [] } as never;

  /** 构造带真实 snapshot.tools（registry 子集 definitions）的旁路装配入参 */
  function buildSideDeps(runKind: 'summary' | 'consolidate', snapshotToolNames: string[], resolvedAllowed: string[]) {
    const profile = sideProfile(runKind, resolvedAllowed);
    const resolveToolSet = vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: resolvedAllowed }));
    const policy: SessionTypePolicy = { profile: vi.fn(() => profile), resolveToolSet };
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind });
    const snapshotTools = tools
      .filter((t) => snapshotToolNames.includes(t.definition.name))
      .map((t) => t.definition);
    const snapshot = { messages: [], systemPrompt: '', tools: snapshotTools, usage: { totalTokens: 0 } } as never;
    const { spec } = buildRunDeps({
      config: newConfigWithTools('s1', ['read']), bus, store, inbox, contextEngine, toolEngine,
      controller,
      kind,
      sessionTypePolicy: policy,
      snapshot,
      userMessage: userMsg,
    });
    return { spec, resolveToolSet, kind, snapshotTools };
  }

  it('consolidate：resolveToolSet 被调且入参 =（旁路 kind, {tools: snapshot 名表}）', () => {
    const names = ['read', 'write', 'bash'];
    const { resolveToolSet, kind } = buildSideDeps('consolidate', names, []);
    expect(resolveToolSet).toHaveBeenCalledTimes(1);
    const [calledKind, override] = resolveToolSet.mock.calls[0] as unknown as [SessionKind, { tools: string[] }];
    expect(calledKind).toBe(kind);
    expect(override).toEqual({ tools: names });
  });

  it('consolidate：spec.allowedTools 采用 resolveToolSet 返回值；toolDefinitions 仍 = snapshot.tools 原样（cache 契约）', () => {
    const resolved = ['skill', 'read']; // 模拟 consolidate 交集产出（mock 值，只验透传）
    const { spec, snapshotTools } = buildSideDeps('consolidate', ['read', 'write', 'skill'], resolved);
    expect(spec.allowedTools).toEqual(resolved);
    // cache 契约：toolDefinitions === snapshot.tools 同引用原样，不被 resolveToolSet 产出污染
    expect(spec.toolDefinitions).toBe(snapshotTools);
    expect(spec.toolDefinitions.map((d: ToolDefinition) => d.name)).toEqual(['read', 'write', 'skill']);
  });

  it('summary：resolveToolSet 返 [] → spec.allowedTools=[] 全拦，toolDefinitions 仍全集', () => {
    const { spec, snapshotTools } = buildSideDeps('summary', ['read', 'write'], []);
    expect(spec.allowedTools).toEqual([]);
    expect(spec.toolDefinitions).toBe(snapshotTools);
  });
});
