/**
 * RunErrorInfo 持久化 + ErrorEvent errorCategory 单测（v0.0.25 rev2 T15）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1（RunErrorInfo）
 *       specs/api/version_logs/v0.0.25/change_log.md §1.2（SSE error 事件）+ §1.5（Run error 字段）
 *       specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §3（收尾机制）
 *
 * 覆盖：
 *   1. createRun 写 error → getRun 读回 RunErrorInfo 三件套齐全
 *   2. updateRun 写 error → getRun 读回
 *   3. updateRun 不传 error → 不覆盖（spread existing 保留）
 *   4. Run 无 error 时（stopReason != 'error'）→ getRun 读回 error=undefined
 *   5. ErrorEvent errorCategory：emitError 带 errorInfo → 事件携带 errorCategory/displayReason/errorDetail
 *
 * 真实落盘：fs engine + 临时 DATA_DIR（os.tmpdir + mkdtempSync）+ afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import type { RunErrorInfo } from '../session-store-types';
import { LlmErrorCategory } from '../../llm/caller/error_types';
// ErrorEvent + emitError
import { emitError, type EmitContext } from '../agent-loop-emitters';
import type { AgentEvent, ErrorEvent } from '../agent-event-types';
// bus stub
import type { ReplayableEventBus } from '../event-bus';

// ── bus stub（捕获 publish 的事件；对齐 side-run-loop.test.ts 的 mockBus 风格） ──
function makeCapturingBus(): { bus: ReplayableEventBus; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const bus = {
    emit(_group: string, e: { data: AgentEvent; timestamp: string }) {
      events.push(e.data);
    },
    subscribe: vi.fn(),
    clearReplay: vi.fn(),
  };
  return { bus: bus as unknown as ReplayableEventBus, events };
}

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-run-error-'));
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

const sampleError: RunErrorInfo = {
  errorCategory: LlmErrorCategory.AUTH_INVALID,
  displayReason: '认证失败，请检查 API Key',
  errorDetail: 'invalid api key',
};

// ============================================================
// 1. createRun 写 error → getRun 读回
// ============================================================
describe('createRun — error 字段 round-trip', () => {
  it('createRun 传 error → getRun 读回 RunErrorInfo 三件套', async () => {
    const sid = ulid();
    const runId = ulid();
    await store.createSession({ id: sid });
    await store.createRun({
      id: runId, sessionId: sid,
      status: 'failed', stopReason: 'error', error: sampleError,
    });
    const run = await store.getRun(sid, runId);
    expect(run).not.toBeNull();
    expect(run!.error).toEqual(sampleError);
    expect(run!.error!.errorCategory).toBe(LlmErrorCategory.AUTH_INVALID);
    expect(run!.error!.displayReason).toBe('认证失败，请检查 API Key');
    expect(run!.error!.errorDetail).toBe('invalid api key');
  });
});

// ============================================================
// 2. updateRun 写 error → getRun 读回
// ============================================================
describe('updateRun — error 字段 round-trip', () => {
  it('createRun(无 error) → updateRun 写 error → getRun 读回', async () => {
    const sid = ulid();
    const runId = ulid();
    await store.createSession({ id: sid });
    await store.createRun({ id: runId, sessionId: sid, status: 'running' });
    await store.updateRun(sid, runId, {
      status: 'failed', stopReason: 'error', error: sampleError,
      endedAt: new Date().toISOString(),
    });
    const run = await store.getRun(sid, runId);
    expect(run!.error).toEqual(sampleError);
  });
});

// ============================================================
// 3. updateRun 不传 error → 不覆盖（spread existing 保留历史 error）
// ============================================================
describe('updateRun — 不传 error 不覆盖', () => {
  it('createRun 写 error → updateRun（不传 error）→ getRun 仍读回原 error', async () => {
    const sid = ulid();
    const runId = ulid();
    await store.createSession({ id: sid });
    await store.createRun({
      id: runId, sessionId: sid,
      status: 'failed', stopReason: 'error', error: sampleError,
    });
    // 后续 updateRun 只改 endedAt（不传 error）→ error 保留
    await store.updateRun(sid, runId, { endedAt: new Date().toISOString() });
    const run = await store.getRun(sid, runId);
    expect(run!.error).toEqual(sampleError);
  });
});

// ============================================================
// 4. Run 无 error（stopReason != 'error'）→ error=undefined
// ============================================================
describe('Run 无 error 字段', () => {
  it('正常完成 run（stopReason=no_tool_call）→ error=undefined', async () => {
    const sid = ulid();
    const runId = ulid();
    await store.createSession({ id: sid });
    await store.createRun({ id: runId, sessionId: sid, status: 'running' });
    await store.updateRun(sid, runId, {
      status: 'completed', stopReason: 'no_tool_call',
      endedAt: new Date().toISOString(),
    });
    const run = await store.getRun(sid, runId);
    expect(run!.error).toBeUndefined();
  });
});

// ============================================================
// 5. ErrorEvent errorCategory：emitError 带 errorInfo
// ============================================================
describe('ErrorEvent — errorCategory + displayReason + errorDetail', () => {
  it('emitError 带 errorInfo → 事件携带三件套', () => {
    const { bus, events } = makeCapturingBus();
    const ctx: EmitContext = {
      sessionId: 'sess-1', runId: 'run-1', runKind: 'main',
      bus, now: () => '2026-01-01T00:00:00.000Z',
    };
    emitError(ctx, 'auth failed', 'AUTH_INVALID', {
      errorCategory: LlmErrorCategory.AUTH_INVALID,
      displayReason: '认证失败，请检查 API Key',
      errorDetail: 'invalid api key',
    });
    const errEvt = events.find((e) => e.type === 'error') as ErrorEvent | undefined;
    expect(errEvt).toBeDefined();
    expect(errEvt!.type).toBe('error');
    expect(errEvt!.message).toBe('auth failed');
    expect(errEvt!.code).toBe('AUTH_INVALID');
    expect(errEvt!.errorCategory).toBe(LlmErrorCategory.AUTH_INVALID);
    expect(errEvt!.displayReason).toBe('认证失败，请检查 API Key');
    expect(errEvt!.errorDetail).toBe('invalid api key');
  });

  it('emitError 不传 errorInfo → 仅 message/code（向后兼容）', () => {
    const { bus, events } = makeCapturingBus();
    const ctx: EmitContext = {
      sessionId: 'sess-1', runId: 'run-1', runKind: 'main',
      bus, now: () => '2026-01-01T00:00:00.000Z',
    };
    emitError(ctx, 'some error', 'TOOL_EXECUTION_FAILED');
    const errEvt = events.find((e) => e.type === 'error') as ErrorEvent | undefined;
    expect(errEvt).toBeDefined();
    expect(errEvt!.message).toBe('some error');
    expect(errEvt!.code).toBe('TOOL_EXECUTION_FAILED');
    expect(errEvt!.errorCategory).toBeUndefined();
    expect(errEvt!.displayReason).toBeUndefined();
    expect(errEvt!.errorDetail).toBeUndefined();
  });

  it('LlmAttemptEvent 在 AgentEvent union 中可构造（type=narrowing）', () => {
    const evt: AgentEvent = {
      id: ulid(),
      type: 'llm_attempt',
      sessionId: 'sess-1',
      runId: 'run-1',
      runKind: 'main',
      createdAt: new Date().toISOString(),
      category: LlmErrorCategory.RATE_LIMITED,
      providerId: 'p1',
      modelId: 'm1',
      keyRef: 'default',
      attempt: 2,
      maxAttempts: 3,
      action: 'FALLBACK',
      message: '服务商过载，请稍后重试',
    };
    if (evt.type === 'llm_attempt') {
      expect(evt.category).toBe(LlmErrorCategory.RATE_LIMITED);
      expect(evt.action).toBe('FALLBACK');
      expect(evt.attempt).toBe(2);
      expect(evt.maxAttempts).toBe(3);
      expect(evt.message).toBe('服务商过载，请稍后重试');
    } else {
      throw new Error('type narrowing failed');
    }
  });
});
