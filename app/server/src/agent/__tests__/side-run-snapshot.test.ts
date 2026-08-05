/**
 * 旁路 run snapshot 契约 UT（v0.0.204 收尾：snapshot 必填 + 零重建直接复用）
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §3（toolDefinitionsSource: host-snapshot）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §2/§4
 *
 * 钉死两条关键不变量（原 buildSideRunSnapshot 双路径 UT 的防线继承——rebuild 死兜底删除后
 * 只剩「直接复用」单路径）：
 *   1. spec.toolDefinitions 引用相等 snapshot.tools（host-snapshot cache 契约——prompt cache 前缀不破）
 *   2. wireInitState 直接复用 opts.snapshot 作 state.snapshot/parentSnapshot（引用相等，零重建零拷贝；
 *      contextEngine.assemble 不被调——snapshot 必填后无重建分支）
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRunDeps } from '../build-run-deps';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import type { ContextEngine } from '../context-engine';
import type { SessionStore } from '../session-store';
import type { ToolExecutionEngine } from '../../tools/engine';
import type { ReplayableEventBus } from '../event-bus';
import type { AbortControllerHandle } from '../agent-interface';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { ToolDefinition } from '../../tools/types';
import type { Message } from '../../message/types';
import { SessionKind } from '@app/shared';

const parentKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });
const summaryKind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'summary' });

/** summary profile mock（旁路 run：drainMode none / persistsRun false / host-snapshot） */
function mockSummaryPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'playground-rocky:parent:summary',
    enabled: true,
    toolBound: [],
    toolDefinitionsSource: 'host-snapshot',
    runShape: { drainMode: 'none', backgroundPath: true, maxIterDefault: 1, touchesStateMachine: false, persistsRun: false, usagePartition: 'summary' },
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

function makeSnapshot(sid: string, tools: ToolDefinition[]): ContextSnapshot {
  return {
    system: { id: 'sys', sessionId: sid, role: 'system', content: [{ type: 'text', text: 'parent-system' }] },
    messages: [],
    inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0,
      maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 80000,
    },
    summary: null,
    tools,
  };
}

/** 构造旁路 run buildRunDeps（mock contextEngine 监听 ingest/assemble） */
function makeSideRun(sid: string, snapshot: ContextSnapshot) {
  const ce = {
    ingest: vi.fn(async () => {}),
    assemble: vi.fn(),
    getPluginManager: () => null,
    getStateMachine: () => undefined,
    getTaskLock: () => undefined,
  } as unknown as ContextEngine;
  const config = {
    sessionId: sid,
    systemPrompt: '',
    client: { contextWindow: 100000 },
    modelId: 'mock-model',
    kind: parentKind,
  } as unknown as SessionConfig;
  const userMessage: Message = {
    id: 'u1', sessionId: sid, role: 'user', content: [{ type: 'text', text: 'summary directive' }],
  };
  const { spec } = buildRunDeps({
    config,
    bus: {} as ReplayableEventBus,
    store: {} as SessionStore,
    contextEngine: ce,
    toolEngine: {} as ToolExecutionEngine,
    controller: { runId: 'r1', aborted: false } as AbortControllerHandle,
    sessionTypePolicy: mockSummaryPolicy(),
    kind: summaryKind,
    snapshot,
    userMessage,
  });
  return { spec, ce, userMessage };
}

describe('buildRunDeps 旁路 run — snapshot 必填契约（host-snapshot cache 防线）', () => {
  it('spec.toolDefinitions 引用相等 snapshot.tools（cache 前缀关键不变量）', () => {
    const toolDefs: ToolDefinition[] = [
      { name: 'read', description: 'd', inputSchema: {} },
      { name: 'bash', description: 'd', inputSchema: {} },
    ];
    const snapshot = makeSnapshot('sid-1', toolDefs);
    const { spec } = makeSideRun('sid-1', snapshot);
    expect(spec.toolDefinitions).toBe(toolDefs); // 严格引用相等——零拷贝零重组
  });

  it('wireInitState 直接复用 opts.snapshot 作 state.snapshot/parentSnapshot（零重建）', async () => {
    const snapshot = makeSnapshot('sid-2', []);
    const { spec, ce } = makeSideRun('sid-2', snapshot);
    const state = await spec.wireInitState!();
    expect(state.snapshot).toBe(snapshot); // 引用相等——直接复用，无 assemble 重建
    expect(state.parentSnapshot).toBe(snapshot);
    expect((ce as unknown as { assemble: ReturnType<typeof vi.fn> }).assemble).not.toHaveBeenCalled();
  });

  it('wireInitState ingest [reminder, userMessage] 到旁路 scope（in_memory store）', async () => {
    const snapshot = makeSnapshot('sid-3', []);
    const { spec, ce, userMessage } = makeSideRun('sid-3', snapshot);
    await spec.wireInitState!();
    const ingestSpy = (ce as unknown as { ingest: ReturnType<typeof vi.fn> }).ingest;
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const [messages, scopeId] = ingestSpy.mock.calls[0]!.slice(1) as [Message[], string];
    expect(messages).toHaveLength(2); // reminder + userMessage
    expect(messages[1]).toBe(userMessage);
    expect(scopeId).toBe('playground-rocky:parent:summary'); // scopeId = canonical id 拼接
  });
});
