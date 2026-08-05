/**
 * consolidateSessionMemory 单测（白盒 vitest）—— 双重 skip 判定 + 真实 sessionId sideRun
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §3 §4 §5.2
 *
 * 覆盖：Skip A（session.updatedAt 早于窗口起点，零 LLM 调用）；
 *       Skip B（有新对话但 session memory 全空，零 LLM 调用）；
 *       两者都不命中 → 走 sideRun（真实 sessionId，白名单仅 memory_manage）。
 *
 * buildLlmClient mock 掉（不需要真实 plugin/provider 组装），agentManager.sideRun 用
 * vi.fn 桩替身，断言：skip 分支下桩函数从未被调用（"零 LLM 调用"的可观测证据）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import {
  wsMemoryDir,
} from '../../../memory/memory-dir-store';
import { writeEntry } from '../../../memory/memory-dir-write';
import type { Session } from '../../session-store-types';
import type { ConsolidationTier2Deps } from '../runner';
import type { ResolvedConsolidationModel } from '../model-resolve';

// vi.mock 路径用 __dirname 派生绝对路径（避免 bun+jsdom 全量并发下相对路径静默失效，
// memory test-vitest-mock-absolute-path）；require('path') inline 避开 vi.mock 提升到顶部时
// 与常规 import 的初始化顺序冲突（TDZ）
vi.mock(require('path').resolve(__dirname, '../../../llm-client-factory'), async (importActual) => {
  const actual = await importActual<typeof import('../../../llm-client-factory')>();
  return { ...actual, buildLlmClient: vi.fn(() => ({}) as unknown) };
});

import { consolidateSessionMemory } from '../session-memory';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-t2-session-memory-'));
  appConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    status: 'active',
    state: 'idle',
    running: false,
    currentRunId: null,
    unread: false,
    workspaceDir: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  } as Session;
}

function makeModel(): ResolvedConsolidationModel {
  return { providerId: 'prov-1', modelId: 'model-a' };
}

function makeSideRunMock(answer: string) {
  return vi.fn(async (opts: { sessionId: string; runKind: string }) => ({
    sessionId: opts.sessionId,
    runKind: opts.runKind,
    runId: 'run-1',
    groupKey: 'g',
    state: 'completed' as const,
    promise: Promise.resolve({
      answer,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      stopReason: 'no_tool_call' as const,
      rounds: 1,
    }),
  }));
}

function makeDeps(sideRun: ReturnType<typeof makeSideRunMock>): ConsolidationTier2Deps {
  return {
    appConfig,
    pluginManager: {} as never,
    agentManager: { sideRun } as never,
    sessionStore: { getSummary: vi.fn(async () => null) } as never,
    dataDir: tmpRoot,
  };
}

describe('consolidateSessionMemory — Skip A（无新对话）', () => {
  it('session.updatedAt 早于窗口起点 → skipped_no_activity，sideRun 从未调用', async () => {
    const sideRun = makeSideRunMock('<result>\naction: no_change\ndetail: n/a\n</result>');
    const deps = makeDeps(sideRun);
    const session = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const windowStart = '2026-01-05T00:00:00.000Z'; // 晚于 session.updatedAt
    const result = await consolidateSessionMemory(deps, makeModel(), session, windowStart);
    expect(result).toBe('skipped_no_activity');
    expect(sideRun).not.toHaveBeenCalled();
  });
});

describe('consolidateSessionMemory — Skip B（memory 全空）', () => {
  it('有新对话（updatedAt 达标）但 session memory 目录为空 → skipped_empty_memory，sideRun 从未调用', async () => {
    const sideRun = makeSideRunMock('<result>\naction: no_change\ndetail: n/a\n</result>');
    const deps = makeDeps(sideRun);
    const session = makeSession({ updatedAt: '2026-01-10T00:00:00.000Z' });
    const windowStart = '2026-01-05T00:00:00.000Z'; // 早于 session.updatedAt → 不触发 Skip A
    const result = await consolidateSessionMemory(deps, makeModel(), session, windowStart);
    expect(result).toBe('skipped_empty_memory');
    expect(sideRun).not.toHaveBeenCalled();
  });
});

describe('consolidateSessionMemory — 两个 skip 都不命中', () => {
  it('有活动 + 有 memory entry → 调 sideRun（真实 sessionId），解析 <result> 为 BlockResult', async () => {
    // session workspaceDir='' → tier2 回退 <dataDir>/workspace（与 session-memory.ts 同规则）
    await writeEntry(
      wsMemoryDir(join(tmpRoot, 'workspace')),
      { name: 'note-1', intro: 'a note', type: 'user', body: 'body text' },
      { source: 'agent' },
    );
    const sideRun = makeSideRunMock('<result>\naction: merged\ndetail: merged note-1 with note-2\n</result>');
    const deps = makeDeps(sideRun);
    const session = makeSession({ id: 's1', updatedAt: '2026-01-10T00:00:00.000Z' });
    const windowStart = '2026-01-05T00:00:00.000Z';
    const result = await consolidateSessionMemory(deps, makeModel(), session, windowStart);

    expect(sideRun).toHaveBeenCalledTimes(1);
    const callArgs = sideRun.mock.calls[0]![0] as unknown as {
      sessionId: string; runKind: string; toolWhitelist?: string[]; enableToolWhitelist?: boolean;
    };
    // 真实 sessionId（非虚拟哨兵）——memory_manage scope=session 依赖 ctx.config.sessionId
    expect(callArgs.sessionId).toBe('s1');
    expect(callArgs.runKind).toBe('consolidate'); // v0.0.204 T2-B4: toolWhitelist 由 policy 派生
    expect(callArgs.enableToolWhitelist).toBeUndefined() // v0.0.204 T2-B4: caller-intent 字段不再透传;

    expect(result).toEqual({ action: 'merged', detail: 'merged note-1 with note-2' });
  });
});
