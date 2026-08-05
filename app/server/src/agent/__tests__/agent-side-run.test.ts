/**
 * executeSideRun — config.kind 缺失兜底 UT（tier2 consolidation 回归防线）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §2（sideRun 入口）
 *
 * 背景：tier2 三 caller（consolidation-tier2/session-memory|global-memory|global-skill）构造的
 * SessionConfig 无 kind（旁路整理 run 不属任何业务会话类型）。executeSideRun 对 kind 缺失兜底
 * playground-rocky:parent（effectiveKind = 兜底 kind + runKind 派生）。
 * 本文件用真 AgentManagerImpl.sideRun（非 mock sideRun）跑完整 loop，钉死：
 *   1. 无 kind config 的 consolidate run 不崩（原 `opts.config.kind!.biz` TypeError）且正常完成
 *   2. effectiveKind scopeId = 'playground-rocky:parent:consolidate'（兜底 kind + runKind 拼接）
 *   3. config 自带 kind 时不走兜底（scopeId 用 caller kind 派生）
 */
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
import { AgentManagerImpl } from '../agent-manager';
import { ulid } from '../../config/ulid';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import { SessionKind } from '@app/shared';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { Message } from '../../message/types';
import type { LlmClient } from '../../llm/client';
import type { CanonicalRequest, StreamEvent } from '../../llm/protocol';

/** consolidate profile mock（toolBound=[skill_manage,memory_manage]，对齐 consolidate 基座） */
function mockConsolidatePolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:consolidate',
    enabled: true,
    toolBound: ['skill_manage', 'memory_manage'],
    toolDefinitionsSource: 'host-snapshot',
    runShape: { drainMode: 'none', backgroundPath: true, maxIterDefault: 10, touchesStateMachine: false, persistsRun: false, usagePartition: 'consolidate' },
    lifecycleHooks: { abortFinalize: 'none', cascadeChildren: false },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false },
    skillSource: 'none',
    eosStop: [],
    autoNaming: false,
    preloadContext: 'none',
  };
  return {
    profile: vi.fn(() => profile),
    resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })),
  };
}

let tmpRoot: string;
let store: SessionStore;
let contextEngine: ContextEngine;
let toolEngine: ToolExecutionEngine;
let inbox: InboxStore;
let bus: ReplayableEventBus;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-side-run-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  contextEngine = new ContextEngine({ store });
  toolEngine = new ToolExecutionEngine();
  inbox = new InboxStore();
  bus = new ReplayableEventBus({ replayable: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** mock LlmClient.stream：产一条 text_delta + finish（assistant message 纯文本） */
function mockStreamClient(answer: string): LlmClient {
  const streamFn = vi.fn((req: CanonicalRequest): AsyncIterable<StreamEvent> => {
    void req;
    return (async function* () {
      yield { type: 'message_start', messageId: 'm1', role: 'assistant' } as unknown as StreamEvent;
      yield { type: 'text_delta', messageId: 'm1', text: answer } as unknown as StreamEvent;
      yield { type: 'usage', usage: {} } as unknown as StreamEvent;
      yield { type: 'finish', stopReason: 'stop' } as unknown as StreamEvent;
    })();
  });
  return { stream: streamFn, call: vi.fn(), contextWindow: 100000 } as unknown as LlmClient;
}

/** tier2 形态 config：无 kind（consolidation-tier2 三 caller 现状） */
function newKindlessConfig(sid: string, client: LlmClient): SessionConfig {
  return {
    sessionId: sid,
    systemPrompt: '',
    client,
    modelId: 'mock-model',
  } as SessionConfig;
}

function newSnapshot(sid: string): ContextSnapshot {
  return {
    system: { id: 'sys', sessionId: sid, role: 'system', content: [{ type: 'text', text: 'tier2 system' }] },
    messages: [],
    inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0,
      maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 80000,
    },
    summary: null,
    tools: [],
  };
}

describe('executeSideRun — config.kind 缺失兜底（tier2 consolidation 回归防线）', () => {
  it('无 kind config 的 consolidate run 不崩且正常完成（原 TypeError 必崩点）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockConsolidatePolicy(),
    });
    const userMessage: Message = {
      id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: '整理指令' }],
    };
    const run = await manager.sideRun({
      sessionId: sid,
      config: newKindlessConfig(sid, mockStreamClient('consolidate-answer')),
      runKind: 'consolidate',
      snapshot: newSnapshot(sid),
      userMessage,
    });
    const result = await run.promise;
    expect(result.answer).toBe('consolidate-answer');
  });

  it('无 kind config → effectiveKind scopeId = playground-rocky:parent:consolidate（兜底派生）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const ingestSpy = vi.spyOn(contextEngine, 'ingest');
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockConsolidatePolicy(),
    });
    const userMessage: Message = {
      id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: '整理指令' }],
    };
    const run = await manager.sideRun({
      sessionId: sid,
      config: newKindlessConfig(sid, mockStreamClient('x')),
      runKind: 'consolidate',
      snapshot: newSnapshot(sid),
      userMessage,
    });
    await run.promise;
    // wireInitState ingest [reminder, userMessage] 的 scopeId 由 effectiveKind 派生
    const scopeIds = ingestSpy.mock.calls.map((c) => c[2]);
    expect(scopeIds).toContain('playground-rocky:parent:consolidate');
  });

  it('config 自带 kind → 不走兜底（scopeId 用 caller kind 派生）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const ingestSpy = vi.spyOn(contextEngine, 'ingest');
    const manager = new AgentManagerImpl({
      bus, store, inbox, contextEngine, toolEngine, sessionTypePolicy: mockConsolidatePolicy(),
    });
    const config = {
      ...newKindlessConfig(sid, mockStreamClient('x')),
      kind: new SessionKind({ biz: 'studio', role: 'leader', derivation: 'parent' }),
    } as SessionConfig;
    const userMessage: Message = {
      id: ulid(), sessionId: sid, role: 'user', content: [{ type: 'text', text: '整理指令' }],
    };
    const run = await manager.sideRun({
      sessionId: sid,
      config,
      runKind: 'consolidate',
      snapshot: newSnapshot(sid),
      userMessage,
    });
    await run.promise;
    const scopeIds = ingestSpy.mock.calls.map((c) => c[2]);
    expect(scopeIds).toContain('studio-leader:parent:consolidate');
    expect(scopeIds).not.toContain('playground-rocky:parent:consolidate');
  });
});
