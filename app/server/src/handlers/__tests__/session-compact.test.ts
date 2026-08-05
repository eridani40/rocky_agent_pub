/**
 * session-compact handler UT — POST /session/:id/compact（v0.0.16 T3，v0.0.54.compaction 简化）
 * 参考: specs/api/overall/04-agent-session.md §7（POST /session/:id/compact 契约）
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2b（手动触发路径）
 *
 * 覆盖：
 *   - 202 + { ok: true }（fire-and-forget；summaryTask=idle 通过校验 → 异步触发 compact）
 *   - 409 + { error: "compact_in_progress" }（summaryTask=running 时拒绝——[v0.0.54.compaction] 唯一 409）
 *   - [v0.0.54.compaction] state=interrupting → 202（放行；任何 session.state 都能 compact）
 *   - 404 session 不存在
 *   - 405 非 POST + Allow: POST
 *
 * 测试策略：
 *   - 直接调 handleSessionCompact（不走 router），注入真实 SessionStore（fs + tmpdir）+ mock
 *     contextEngine（避免真调 LLM；断言 HTTP 响应 + 触发条件 + compact 是否被调）。
 *   - 409 / 404 / 405 → 这些路径在 buildCompactConfig 之前 return，deps 可用空 appConfig/pluginManager。
 *   - 202 → 需通过 buildCompactConfig（resolveProviderModel + buildLlmClient），用 bootstrapBuiltinPlugins
 *     装配真实 pluginManager（注册 builtin anthropic impl）+ 写一个 enabled provider record；
 *     ROCKY_TEST_MOCK_LLM=1 避免 compact 真调网络（fire-and-forget 也会触发 mock client）。
 *   - 不走 router 全路径：bootstrap reconcileOnStartup 会清扫 running/interrupting 预设状态（reconcile
 *     在首次请求时启动），干扰 409 测试；直接调 handler 避开 reconcile，预设状态稳定。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { SessionStore } from '../../agent/session-store';
import { SessionTaskLock } from '../../agent/session-task-lock';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { handleSessionCompact } from '../session-compact';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import type { SessionHandlerDeps } from '../session';
import type { ContextEngine } from '../../agent/context-engine';

let tmpRoot: string;
let store: SessionStore;
// v0.0.55：taskLock 替代 store.stateMachine.markSummary*（subsumes summaryTask CAS）
let taskLock: SessionTaskLock;

// 测试环境变量原值（beforeEach 设置 / afterEach 还原，避免泄漏到其它测试）
let prevMockLlm: string | undefined;

beforeEach(() => {
  // 202 测试异步 compact 会经 buildLlmClient 构造 client，注入 mock fetch 避免真调网络。
  // 用 beforeEach/afterEach 配对设置/还原（参考 handlers-session.test.ts:435-440 写法），
  // 避免模块级 process.env 赋值污染其它测试（vi.stubEnv 亦可，这里用直接赋值 + 还原）。
  prevMockLlm = process.env.ROCKY_TEST_MOCK_LLM;
  process.env.ROCKY_TEST_MOCK_LLM = '1';
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-compact-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  // v0.0.55：每个测试用独立 taskLock（避免跨用例污染）
  taskLock = new SessionTaskLock();
});

afterEach(() => {
  // 还原 ROCKY_TEST_MOCK_LLM 原值（undefined 时 delete 保持原状，不残留 '1'）
  if (prevMockLlm === undefined) {
    delete process.env.ROCKY_TEST_MOCK_LLM;
  } else {
    process.env.ROCKY_TEST_MOCK_LLM = prevMockLlm;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 创建 session（默认 state=idle, summaryTask=idle） */
async function newSession(useStore: SessionStore = store): Promise<string> {
  const sid = ulid();
  await useStore.createSession({ id: sid, title: 'test' });
  return sid;
}

/**
 * mock ContextEngine —— compact 记录被调用（不真跑 LLM；断言 fire-and-forget 触发）。
 * handler fire-and-forget 调 compact().catch()，mock 返 resolved promise 不抛错。
 */
function makeMockContextEngine(): ContextEngine & { compactCalls: string[] } {
  const compactCalls: string[] = [];
  const fake = {
    compact: vi.fn(async (config: { sessionId: string }) => {
      compactCalls.push(config.sessionId);
      return true;
    }),
  };
  return Object.assign(fake as unknown as ContextEngine, { compactCalls });
}

/** 写一个 enabled provider record（buildLlmClient 解析用） */
function writeProvider(dataDir: string): void {
  const providersDir = nodePath.join(dataDir, 'app_config', 'providers', 'app_config');
  nodeFs.mkdirSync(providersDir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(providersDir, 'p1.json'),
    JSON.stringify({
      id: 'p1',
      group: 'providers',
      key: 'p1',
      data: {
        id: 'p1',
        name: 'anthropic_compatible',
        kind: 'mock',
        enabled: true,
        credentials: { key: 'sk-test' },
        models: [{ modelId: 'm1', contextWindow: 100000 }],
      },
    }),
  );
  // [v0.0.89 工作块 ③] resolveModel 不静默兜底首个 enabled provider（PRD §5.1）。
  //   compact 走 summary 链（PRD §2.1 第 2 行）：default_models.summary → session.modelId → default_models.chat。
  //   测试聚焦 compact 202 路径（不验 model 解析），配 default_models 让 summary 链命中 m1。
  const dmDir = nodePath.join(dataDir, 'app_config', 'default_models', 'app_config');
  nodeFs.mkdirSync(dmDir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dmDir, 'default.json'),
    JSON.stringify({
      id: 'default',
      group: 'default_models',
      key: 'default',
      data: { chat: 'm1', summary: 'm1' },
    }),
  );
  nodeFs.mkdirSync(nodePath.join(dataDir, 'dev_config'), { recursive: true });
}

/**
 * 构造 deps：mock contextEngine + 真实/空 appConfig/pluginManager/devConfig。
 * withLlmConfig=true → 202 路径需真实 pluginManager + 真实 agentManager
 *   （v0.0.158：session-compact 通过 agentManager.resolveConfigBySid(sid) 拿 config，
 *   agentManager 的 resolveConfigFn 由 bootstrap setResolveConfig 注入，故必须用 bs.agentManager）。
 *
 * 注意：bootstrap 在 tmpRoot 内建 store/taskLock 自己的实例；返回 bs.store/bs.taskLock
 *   让调用方创建 session 时直接落 bs.store（resolveConfigBySid 才能读到）。
 */
async function makeDeps(
  mockContextEngine: ContextEngine,
  opts: { withLlmConfig?: boolean } = {},
): Promise<SessionHandlerDeps> {
  if (opts.withLlmConfig) {
    // bootstrap 在 tmpRoot 内装配 pluginManager + appConfig + agentManager（含 resolveConfigFn 注入）
    writeProvider(tmpRoot);
    const bs = await bootstrapBuiltinPlugins(tmpRoot);
    return {
      store: bs.store,
      agentManager: bs.agentManager,
      appConfig: bs.appConfig,
      pluginManager: bs.pluginManager,
      contextEngine: mockContextEngine,
      // v0.0.55：taskLock 用 bs.taskLock（202 路径经 agentManager 内部同一实例）
      taskLock: bs.taskLock,
      dataDir: tmpRoot,
    };
  }
  return {
    store,
    agentManager: {} as never, // 409/404/405 路径不进 buildCompactConfig
    appConfig: {} as never,
    pluginManager: {} as never,
    contextEngine: mockContextEngine,
    // v0.0.55：注入 taskLock（409 判定 + compact CAS）
    taskLock,
    dataDir: tmpRoot,
  };
}

/** 解析 Response body 为 JSON */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// 202 + { ok: true } — fire-and-forget 触发
// ============================================================

describe('POST /session/:id/compact — 202 触发', () => {
  it('summaryTask=idle + state=idle → 202 {ok:true} + compact 被异步触发', async () => {
    const ce = makeMockContextEngine();
    const deps = await makeDeps(ce, { withLlmConfig: true });
    // v0.0.158：session 落到 deps.store（bs.store），resolveConfigBySid 才能读到
    const sid = await newSession(deps.store);

    const res = await handleSessionCompact(
      new Request(`http://x/session/${sid}/compact`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(202);
    const b = await body(res);
    expect(b.ok).toBe(true);
    // fire-and-forget：compact 被调（promise 不 await，但调用已发出）
    await new Promise((r) => setTimeout(r, 20));
    expect(ce.compactCalls).toContain(sid);
  });

  it('lock=done → 202（done ∈ {idle,done,failed} 通过校验）', async () => {
    const ce = makeMockContextEngine();
    const deps = await makeDeps(ce, { withLlmConfig: true });
    const sid = await newSession(deps.store);
    // v0.0.55：lock CAS（subsumes 旧 markSummary*）—— 用 deps.taskLock（bs 实例）
    deps.taskLock!.acquire(sid, 'compact', 'compact:prev');
    deps.taskLock!.markDone(sid, 'compact');

    const res = await handleSessionCompact(
      new Request(`http://x/session/${sid}/compact`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(202);
  });

  it('lock=failed → 202（failed ∈ {idle,done,failed} 通过校验，允许重试）', async () => {
    const ce = makeMockContextEngine();
    const deps = await makeDeps(ce, { withLlmConfig: true });
    const sid = await newSession(deps.store);
    // v0.0.55：lock CAS（subsumes 旧 markSummary*）—— 用 deps.taskLock（bs 实例）
    deps.taskLock!.acquire(sid, 'compact', 'compact:prev');
    deps.taskLock!.markFailed(sid, 'compact', 'timeout');

    const res = await handleSessionCompact(
      new Request(`http://x/session/${sid}/compact`, { method: 'POST' }),
      'POST',
      sid,
      deps,
    );
    expect(res.status).toBe(202);
  });
});

// ============================================================
// 409 冲突（[v0.0.54.compaction] 唯一 409 = compact_in_progress）
// ============================================================

describe('POST /session/:id/compact — 409 / 202 冲突判定（v0.0.54.compaction）', () => {
  it('lock=running → 409 { error: "compact_in_progress" } + compact 不被调（唯一 409）', async () => {
    const sid = await newSession();
    // v0.0.55：lock CAS（subsumes 旧 markSummary*）
    taskLock.acquire(sid, 'compact', 'compact:ongoing');
    const ce = makeMockContextEngine();

    const res = await handleSessionCompact(
      new Request(`http://x/session/${sid}/compact`, { method: 'POST' }),
      'POST',
      sid,
      await makeDeps(ce),
    );
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error).toBe('compact_in_progress');
    // 触发条件拒绝 → compact 不被调
    await new Promise((r) => setTimeout(r, 10));
    expect(ce.compactCalls).toHaveLength(0);
  });

  // [v0.0.54.compaction] state=interrupting → 202 放行（任何 session.state 都能 compact）
  it('state=interrupting（summaryTask=idle）→ 202 放行（v0.0.54.compaction 简化：state 不再拦截）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    const ce = makeMockContextEngine();

    const res = await handleSessionCompact(
      new Request(`http://x/session/${sid}/compact`, { method: 'POST' }),
      'POST',
      sid,
      await makeDeps(ce, { withLlmConfig: true }),
    );
    expect(res.status).toBe(202);
    const b = await body(res);
    expect(b.ok).toBe(true);
    // fire-and-forget：interrupting 也启 compact（不拦截）
    await new Promise((r) => setTimeout(r, 20));
    expect(ce.compactCalls).toContain(sid);
  });

  // [v0.0.55] state=interrupting + lock=running → 409 compact_in_progress
  // （lock 是唯一 409 来源；session.state 不再参与判定）
  it('state=interrupting + lock=running → 409 compact_in_progress（lock 是唯一 409 来源）', async () => {
    const sid = await newSession();
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    // v0.0.55：同时预置 lock=running（验证 lock 优先——它是唯一 409 来源）
    taskLock.acquire(sid, 'compact', 'compact:1');
    const ce = makeMockContextEngine();

    const res = await handleSessionCompact(
      new Request(`http://x/session/${sid}/compact`, { method: 'POST' }),
      'POST',
      sid,
      await makeDeps(ce),
    );
    expect(res.status).toBe(409);
    const b = await body(res);
    // compact_in_progress 是唯一 409（session.state 不再拦截）
    expect(b.error).toBe('compact_in_progress');
    await new Promise((r) => setTimeout(r, 10));
    expect(ce.compactCalls).toHaveLength(0);
  });
});

// ============================================================
// 404 / 405
// ============================================================

describe('POST /session/:id/compact — 404 / 405', () => {
  it('404 session 不存在', async () => {
    const ce = makeMockContextEngine();
    const res = await handleSessionCompact(
      new Request(`http://x/session/${ulid()}/compact`, { method: 'POST' }),
      'POST',
      ulid(),
      await makeDeps(ce),
    );
    expect(res.status).toBe(404);
    const b = await body(res);
    expect(b.error).toMatch(/not found/);
  });

  it('405 非 POST（GET）+ Allow: POST', async () => {
    const sid = await newSession();
    const ce = makeMockContextEngine();
    const res = await handleSessionCompact(
      new Request(`http://x/session/${sid}/compact`, { method: 'GET' }),
      'GET',
      sid,
      await makeDeps(ce),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
