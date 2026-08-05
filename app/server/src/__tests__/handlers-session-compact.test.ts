/**
 * handlers-session-compact 单测 — POST /session/:id/compact 端点契约（v0.0.54.compaction）
 * 参考:
 *   - specs/api/overall/04-agent-session.md §7（POST /compact 契约 + 双保险语义 + subagent 允许）
 *   - specs/tech/agent/context/[P0]context_compact_detail.md §2b（手动触发路径 + 触发条件表）
 *
 * 覆盖（v0.0.54.compaction 简化后——唯一 409 = compact_in_progress）：
 *   - subagent 放行：subagent session POST /compact → 202（不再 403）
 *   - state='running' → 202（[v0.0.54.compaction] 修订：放行，subagent 防爆炸关键）
 *   - state='interrupting' → 202（[v0.0.54.compaction] 修订：放行）
 *   - summaryTask.status='running' → 409 { error:'compact_in_progress', message }（唯一 409）
 *   - idle 正常 → 202 + contextEngine.compact 被调（fire-and-forget）
 *
 * 策略：真实 SessionStore（tmpdir + statusBus），handler 直接调，断言 Response。
 *       contextEngine.compact 用 mock（避免真跑 forked agent）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { SessionStore } from '../agent/session-store';
import { ReplayableEventBus } from '../agent/event-bus';
import { ulid } from '../config/ulid';
import { AppConfigService } from '../config/app-config-service';
import { bootstrapBuiltinPlugins } from '../bootstrap';
import { type SessionHandlerDeps } from '../handlers/session';
import { handleSessionCompact } from '../handlers/session-compact';
import { SessionTaskLock } from '../agent/session-task-lock';
// v0.0.158：session-compact handler 改走 agentManager.resolveConfigBySid（唯一入口）。
//   UT 通过手工 mock resolveConfigBySid → 内部调 buildSessionConfigFromDeps，等效于旧 handler 内联链路
//   （旧 handler 直接调 buildSessionConfigFromDeps）——覆盖仍是 200/400/500 状态码矩阵。
import { buildSessionConfigFromDeps } from '../handlers/session-config';
import { buildRealSessionTypePolicy } from '../agent/__helpers__/session-type-policy-test-helper';
import { SessionKind } from '@app/shared';

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let deps: SessionHandlerDeps;
let compactSpy: ReturnType<typeof vi.fn>;
// v0.0.55：taskLock 替代 store.stateMachine.markSummary*（subsumes summaryTask CAS）
let taskLock: SessionTaskLock;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-session-compact-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const statusBus = new ReplayableEventBus({ replayable: true });
  store = new SessionStore({ crud, fsRoot: tmpRoot, statusBus });
  appConfig = new AppConfigService({ root: tmpRoot });
  const devConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(mkdtempSync(join(tmpdir(), 'rocky-compact-bs-')));
  // mock contextEngine.compact 避免 fire-and-forget 真跑 forked agent；
  // 保留其他方法引用真对象（compact handler 仅调 compact()）。
  compactSpy = vi.fn().mockResolvedValue(undefined);
  taskLock = new SessionTaskLock();
  // v0.0.158：session-compact handler 走 agentManager.resolveConfigBySid（唯一入口）。
  //   UT 用 buildSessionConfigFromDeps 手工实现——语义等同旧内联链路（provider/model resolve + 抛
  //   ModelNotConfiguredError → handler catch 转 400）。
  const resolveConfigBySid = vi.fn(async (sid: string) => {
    const session = await store.getSession(sid);
    if (!session) throw new Error(`session not found: ${sid}`);
    const kind = new SessionKind({
      biz: session.biz ?? 'playground',
      role: session.role ?? 'rocky',
      derivation: session.derivation ?? 'parent',
    });
    return buildSessionConfigFromDeps(
      { store, agentManager: undefined as never, appConfig, pluginManager: bs.pluginManager,
        contextEngine: { compact: compactSpy } as never, taskLock, dataDir: tmpRoot,
        sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot) },
      sid,
      { providerId: session.providerId, modelId: session.modelId, effort: session.effort,
        approvalMode: session.approvalMode },
      kind,
      session.workspaceDir,
      session.derivation === 'subagent' ? 'subagent' : 'session',
      session.subAgentConfig,
    );
  });
  deps = {
    store,
    agentManager: { subscribe: (() => {}) as never, resolveConfigBySid } as never,
    appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: { compact: compactSpy } as never,
    // v0.0.55：注入 taskLock（409 判定 + compact CAS）
    taskLock,
    dataDir: tmpRoot,
    sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot),
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写一个 mock provider（buildSessionConfigFromDeps 解析 session 持久 provider/model 用） */
function seedProvider() {
  appConfig.set('providers', 'prov-mock', {
    id: 'prov-mock',
    name: 'anthropic_compatible',
    label: 'Mock',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-test' },
    enabled: true,
    models: [
      {
        modelId: 'claude-mock-1',
        protocolId: 'anthropic_messages',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        label: 'Mock 1',
        enabled: true,
      },
    ],
  });
}

function req(method: string, path: string): Request {
  return new Request(`http://127.0.0.1:3700${path}`, { method });
}

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

describe('POST /session/:id/compact — 端点契约（v0.0.54）', () => {
  it('405 非 POST', async () => {
    const sid = ulid();
    const r = await handleSessionCompact(req('GET', `/session/${sid}/compact`), 'GET', sid, deps);
    expect(r.status).toBe(405);
  });

  it('404 session 不存在', async () => {
    const r = await handleSessionCompact(req('POST', `/session/no-such/compact`), 'POST', 'no-such', deps);
    expect(r.status).toBe(404);
  });

  // ── [v0.0.54] subagent 放行（不再 403）──
  it('subagent session → 202（v0.0.54 不再 403，必须 support compact）', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, derivation: 'subagent', parentSessionId: ulid(), providerId: 'prov-mock', modelId: 'claude-mock-1' });
    const r = await handleSessionCompact(req('POST', `/session/${sid}/compact`), 'POST', sid, deps);
    expect(r.status).toBe(202);
    const body = await jsonBody(r);
    expect(body.ok).toBe(true);
    // contextEngine.compact 被 fire-and-forget 调用（不 await）
    await Promise.resolve();
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });

  // ── [v0.0.54.compaction] 触发条件：唯一 409 = compact_in_progress ──
  // session.state（running/interrupting/idle/interrupted/error）一律放行 → 202（subagent 防爆炸关键）
  it("state='interrupting' → 202（[v0.0.54.compaction] 放行；任何 session.state 都能 compact）", async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'prov-mock', modelId: 'claude-mock-1' });
    // 经状态机 CAS 进 running → interrupting（合法路径，runId 需合法 ULID）
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    const r = await handleSessionCompact(req('POST', `/session/${sid}/compact`), 'POST', sid, deps);
    expect(r.status).toBe(202);
    const body = await jsonBody(r);
    expect(body.ok).toBe(true);
    // fire-and-forget：interrupting 也启 compact（不拦截）
    await Promise.resolve();
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });

  it("state='running' → 202（[v0.0.54.compaction] 放行；subagent 防爆炸关键）", async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'prov-mock', modelId: 'claude-mock-1' });
    await store.stateMachine.markRunning(sid, ulid());
    const r = await handleSessionCompact(req('POST', `/session/${sid}/compact`), 'POST', sid, deps);
    expect(r.status).toBe(202);
    const body = await jsonBody(r);
    expect(body.ok).toBe(true);
    // fire-and-forget：running 也启 compact（不拦截；compact 互斥由 summaryTask CAS 兜底）
    await Promise.resolve();
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });

  it("lock.status='running' → 409 compact_in_progress + 友好 message（唯一 409）", async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'prov-mock', modelId: 'claude-mock-1' });
    // v0.0.55：lock CAS（subsumes 旧 markSummary*）
    taskLock.acquire(sid, 'compact', ulid());
    const r = await handleSessionCompact(req('POST', `/session/${sid}/compact`), 'POST', sid, deps);
    expect(r.status).toBe(409);
    const body = await jsonBody(r);
    expect(body.error).toBe('compact_in_progress');
    expect(body.message).toBe('正在压缩中，请等待');
    expect(compactSpy).not.toHaveBeenCalled();
  });

  // ── compact_in_progress 优先于 session.state（无论 session 在什么状态，compact 在跑就拒绝）──
  it('lock running + session interrupting 并存 → 409 compact_in_progress（唯一 409 优先）', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'prov-mock', modelId: 'claude-mock-1' });
    const runId = ulid();
    await store.stateMachine.markRunning(sid, runId);
    await store.stateMachine.markInterrupting(sid, runId);
    // v0.0.55：lock CAS（subsumes 旧 markSummary*）
    taskLock.acquire(sid, 'compact', ulid());
    const r = await handleSessionCompact(req('POST', `/session/${sid}/compact`), 'POST', sid, deps);
    expect(r.status).toBe(409);
    const body = await jsonBody(r);
    // compact_in_progress 是唯一 409（session.state 不再拦截）
    expect(body.error).toBe('compact_in_progress');
    expect(compactSpy).not.toHaveBeenCalled();
  });

  // ── idle 正常 → 202 fire-and-forget ──
  it('idle 正常 → 202 + contextEngine.compact 被 fire-and-forget 调用', async () => {
    seedProvider();
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'prov-mock', modelId: 'claude-mock-1' });
    const r = await handleSessionCompact(req('POST', `/session/${sid}/compact`), 'POST', sid, deps);
    expect(r.status).toBe(202);
    const body = await jsonBody(r);
    expect(body.ok).toBe(true);
    await Promise.resolve();
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });

  // ── 配置缺失（无 enabled provider）→ 400 ──
  it('无 enabled provider → 400（buildSessionConfigFromDeps 解析失败）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionCompact(req('POST', `/session/${sid}/compact`), 'POST', sid, deps);
    expect(r.status).toBe(400);
  });
});
