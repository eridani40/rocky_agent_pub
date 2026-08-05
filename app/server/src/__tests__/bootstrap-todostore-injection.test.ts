/**
 * bootstrap — TodoStore 注入 rtc.sessionDeps 集成测试（C-1 回归防线）
 * 参考: app/server/src/bootstrap-agent-phase.ts（buildToolCtxFn 闭包 sessionDeps 透传）
 *       app/server/src/agent/tools/todo-tool.ts（todo 工具读 rtc.sessionDeps.todoStore）
 *       specs/tech/agent/tools/[P1]todo_tools.md §4
 *
 * 为何是集成而非单测（C-1 教训）：
 *   todo 工具运行时读的 rtc 由 deliverTo → activate → agentManager.buildToolCtxFn
 *   （bootstrap-agent-phase 闭包）构造，**不走** router.sessionDeps（那是 HTTP handler 侧）。
 *   首版只接了 router-helpers.ts 的 handler 侧 sessionDeps（含 todoStore），漏了 agent-phase 闭包
 *   sessionDeps 字面量 → 生产 LLM 调 todo 工具必返 `runtime error: todoStore not injected`；
 *   UT 手工构造 rtc 注入了 todoStore → 全绿没暴露断线。
 *   故补此集成测试：用真实 bootstrap 链路 spy 捕获 buildToolCtxFn 闭包后 invoke，
 *   断言产出的 rtc.sessionDeps.todoStore 非 undefined —— 锁死「agent-phase→rtc」透传链。
 *
 * 文件系统隔离：mkdtempSync + afterEach rmSync。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { bootstrapBuiltinPlugins } from '../bootstrap';
import { AgentManagerImpl } from '../agent/agent-manager';
import { SESSION_PANEL_TOPIC } from '../agent/session-event-types';
import { ulid } from '../config/ulid';

/** mock provider（buildSessionConfigFromDeps 解析 session 持久 provider/model 用） */
function seedProvider(bs: Awaited<ReturnType<typeof bootstrapBuiltinPlugins>>): {
  providerId: string;
  modelId: string;
} {
  const providerId = 'prov-mock';
  const modelId = 'claude-mock-1';
  bs.appConfig.set('providers', providerId, {
    id: providerId,
    name: 'anthropic_compatible',
    label: 'Mock',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-test' },
    enabled: true,
    models: [
      {
        modelId,
        protocolId: 'anthropic_messages',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        label: 'Mock 1',
        enabled: true,
      },
    ],
  });
  return { providerId, modelId };
}

describe('bootstrap — [v0.0.223] TodoStore 注入 rtc.sessionDeps（C-1 回归）', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-bootstrap-todo-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('BootstrapResult.todoStore 字段存在（bootstrap 无条件装配）', async () => {
    const bs = await bootstrapBuiltinPlugins(dataDir);
    expect(bs.todoStore).toBeDefined();
    // 鸭子类型：TodoStore 契约方法齐全
    expect(typeof bs.todoStore.listBySession).toBe('function');
    expect(typeof bs.todoStore.upsertItem).toBe('function');
    expect(typeof bs.todoStore.cleanupFinished).toBe('function');
    expect(typeof bs.todoStore.nextId).toBe('function');
  });

  it('buildToolCtxFn 闭包产出的 rtc.sessionDeps.todoStore 非 undefined（生产 LLM 工具链）', async () => {
    // 这是 C-1 的核心回归断言：todo 工具运行时读的 rtc 由此闭包产出（不走 router.sessionDeps）。
    // spy 原型方法捕获 bootstrap 注册的闭包（bootstrap 内部创建 AgentManagerImpl 时调用）。
    let capturedFn: ((sessionId: string, runId: string) => Promise<unknown>) | null = null;
    vi.spyOn(AgentManagerImpl.prototype, 'setBuildAgentToolContext')
      .mockImplementation(function (this: { buildToolCtxFn?: unknown }, fn: (sessionId: string, runId: string) => Promise<unknown>) {
        capturedFn = fn;
        this.buildToolCtxFn = fn; // 保留原行为（private 字段运行时赋值）
        return undefined;
      });

    const bs = await bootstrapBuiltinPlugins(dataDir);
    const { providerId, modelId } = seedProvider(bs);
    const sid = ulid();
    await bs.store.createSession({ id: sid, providerId, modelId });

    // 捕获到闭包 → invoke（模拟 agent activate 时构造 rtc）
    expect(capturedFn).not.toBeNull();
    const rtc = (await capturedFn!(sid, 'run-1')) as { sessionDeps?: { todoStore?: unknown } };

    // 生产 rtc.sessionDeps 必须携带 todoStore，且与 bootstrap 单例同实例（闭包透传未丢字段）
    expect(rtc.sessionDeps).toBeDefined();
    expect(rtc.sessionDeps!.todoStore).toBeDefined();
    expect(rtc.sessionDeps!.todoStore).toBe(bs.todoStore);
  });

  it('[v0.0.228] todoStore 注入 raw sessionStatusBus——写后 session_todo_changed 经 hub 可达', async () => {
    // 装配断言（session_event.md §3/§3a.4）：bootstrap 注入的是 wrap 前 raw bus，
    // emit 通路必须连通（session_panel, session_id:<sid>）；断了说明注入丢字段/接错 bus。
    const bs = await bootstrapBuiltinPlugins(dataDir);
    const received: Array<{ type?: string; sessionId?: string; data?: unknown }> = [];
    const sub = bs.hub.sub(SESSION_PANEL_TOPIC, 'session_id:sess-emit', (e) => {
      received.push(e as { type?: string; sessionId?: string; data?: unknown });
    });
    try {
      const now = new Date().toISOString();
      await bs.todoStore.upsertItem('sess-emit', {
        id: 'TI-1', desc: 'x', status: 'not_started', steps: [], createdAt: now, updatedAt: now,
      });
      await new Promise((r) => setTimeout(r, 20)); // hub consume 循环异步投递
      const evt = received.find((e) => e.type === 'session_todo_changed');
      expect(evt).toBeDefined();
      expect(evt!.sessionId).toBe('sess-emit');
      expect(evt!.data).toEqual({}); // 轻量信号不携带 todo 数据
    } finally {
      bs.hub.unsub(sub);
    }
  });
});
