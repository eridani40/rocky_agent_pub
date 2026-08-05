/**
 * runConsolidationTier2 单测（白盒 vitest）—— 编排层：模型反查 skip、三段串行、失败隔离
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §3 §5
 *       specs/tech/scheduling/[P1]consolidation_job.md §4 §7
 *
 * buildLlmClient mock 掉（不需要真实 plugin/provider 组装）；agentManager.sideRun 用
 * vi.fn 桩替身，通过「并发计数」断言三段严格串行（不 Promise.all）；session 遍历里
 * 单个失败 try/catch 吞掉不阻断其余 session。
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

// vi.mock 路径用 __dirname 派生绝对路径（避免 bun+jsdom 全量并发下相对路径静默失效，
// memory test-vitest-mock-absolute-path）；require('path') inline 避开顶部常规 import 的 TDZ
vi.mock(require('path').resolve(__dirname, '../../../llm-client-factory'), async (importActual) => {
  const actual = await importActual<typeof import('../../../llm-client-factory')>();
  return { ...actual, buildLlmClient: vi.fn(() => ({}) as unknown) };
});

import { runConsolidationTier2, type ConsolidationTier2Deps } from '../runner';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-t2-runner-'));
  appConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedModel(modelId = 'model-a') {
  appConfig.set('providers', 'prov-1', {
    id: 'prov-1',
    name: 'anthropic_compatible',
    label: 'Test',
    baseUrl: 'https://api.example.com',
    credentials: { key: 'sk-test' },
    enabled: true,
    models: [{
      modelId, protocolId: 'anthropic_messages', contextWindow: 200000,
      maxOutputTokens: 4096, label: 'Model A', enabled: true,
    }],
  });
  appConfig.set('consolidation', 'default', { enabled: true, dailyTime: '04:00', modelId });
}

function makeSession(id: string, updatedAt: string): Session {
  return {
    id, status: 'active', state: 'idle', running: false, currentRunId: null,
    unread: false, workspaceDir: '', createdAt: updatedAt, updatedAt, version: 1,
  } as Session;
}

/** sideRun 桩：记录并发峰值 + 调用顺序（callIdx/sessionId），人工延迟制造可被并发撞见的窗口。
 *  v0.0.204 T2-B4：tier-2 三段统一 runKind='consolidate'，子类区分靠 callIdx（0=skill / 1=memory / 2+=session）。 */
function makeSerialTrackingSideRun(opts: { failFor?: (callIdx: number, sessionId: string) => boolean } = {}) {
  let concurrent = 0;
  let maxConcurrent = 0;
  const order: string[] = [];
  let callIdx = 0;
  const fn = vi.fn(async (callOpts: { sessionId: string; runKind: string }) => {
    const idx = callIdx++;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push(`#${idx}:${callOpts.sessionId}`);
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
    if (opts.failFor?.(idx, callOpts.sessionId)) {
      throw new Error(`boom:#${idx}:${callOpts.sessionId}`);
    }
    return {
      sessionId: callOpts.sessionId, runKind: callOpts.runKind, runId: 'r', groupKey: 'g',
      state: 'completed' as const,
      promise: Promise.resolve({
        answer: '<result>\naction: no_change\ndetail: nothing to do\n</result>',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        stopReason: 'no_tool_call' as const, rounds: 1,
      }),
    };
  });
  return { fn, getMaxConcurrent: () => maxConcurrent, getOrder: () => order };
}

function makeDeps(
  sideRun: ReturnType<typeof makeSerialTrackingSideRun>['fn'],
  sessions: Session[],
): ConsolidationTier2Deps {
  return {
    appConfig,
    pluginManager: {} as never,
    agentManager: { sideRun } as never,
    sessionStore: {
      listSessions: vi.fn(async () => sessions),
      getSummary: vi.fn(async () => null),
    } as never,
    dataDir: tmpRoot,
    windowStart: '2026-01-01T00:00:00.000Z',
  };
}

/** session workspaceDir 缺省回退目录（makeSession workspaceDir='' → tier2 回退 <dataDir>/workspace） */
const fallbackWs = () => join(tmpRoot, 'workspace');

describe('runConsolidationTier2 — 模型未配置', () => {
  it('consolidation.modelId 未设置 → fast finish，skippedReason=model_not_configured，零 sideRun 调用', async () => {
    const { fn } = makeSerialTrackingSideRun();
    const deps = makeDeps(fn, []);
    const result = await runConsolidationTier2(deps);
    expect(result.skippedReason).toBe('model_not_configured');
    expect(result.globalSkill).toBeNull();
    expect(result.globalMemory).toBeNull();
    expect(result.sessions).toEqual([]);
    expect(result.summary).toContain('模型未配置');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('runConsolidationTier2 — 三段严格串行', () => {
  it('全局 skill → 全局 memory → 各 session 逐个：任意时刻并发数不超过 1', async () => {
    seedModel();
    await writeEntry(wsMemoryDir(fallbackWs()), { name: 'n1', intro: 'i', type: 'user', body: 'b' }, { source: 'agent' });
    await writeEntry(wsMemoryDir(fallbackWs()), { name: 'n2', intro: 'i', type: 'user', body: 'b' }, { source: 'agent' });
    const { fn, getMaxConcurrent, getOrder } = makeSerialTrackingSideRun();
    const sessions = [makeSession('s1', '2026-01-10T00:00:00.000Z'), makeSession('s2', '2026-01-10T00:00:00.000Z')];
    const deps = makeDeps(fn, sessions);

    const result = await runConsolidationTier2(deps);

    expect(getMaxConcurrent()).toBe(1); // 从未同时有 2 个 sideRun 在跑（MUST NOT Promise.all）
    const order = getOrder();
    // v0.0.204 T2-B4：tier-2 三段统一 runKind='consolidate'，子类区分靠 callIdx
    expect(order[0]).toBe('#0:consolidation:global'); // skill 块（callIdx=0）
    expect(order[1]).toBe('#1:consolidation:global'); // memory 块（callIdx=1）
    expect(order[2]).toBe('#2:s1'); // session s1（callIdx=2）
    expect(order[3]).toBe('#3:s2'); // session s2（callIdx=3）
    expect(result.skippedReason).toBeNull();
    expect(result.sessions).toHaveLength(2);
  });
});

describe('runConsolidationTier2 — 单个 session 失败不阻断其余（best-effort）', () => {
  it('s1 的 sideRun 抛异常 → 结果标 action=error 且继续处理 s2', async () => {
    seedModel();
    await writeEntry(wsMemoryDir(fallbackWs()), { name: 'n1', intro: 'i', type: 'user', body: 'b' }, { source: 'agent' });
    await writeEntry(wsMemoryDir(fallbackWs()), { name: 'n2', intro: 'i', type: 'user', body: 'b' }, { source: 'agent' });
    const { fn } = makeSerialTrackingSideRun({
      failFor: (idx, sessionId) => idx === 2 && sessionId === 's1', // v0.0.204 T2-B4: 第 3 个调用 (s1 session-memory)
    });
    const sessions = [makeSession('s1', '2026-01-10T00:00:00.000Z'), makeSession('s2', '2026-01-10T00:00:00.000Z')];
    const deps = makeDeps(fn, sessions);

    const result = await runConsolidationTier2(deps);

    expect(result.sessions).toHaveLength(2);
    const s1Result = result.sessions.find((s) => s.sessionId === 's1')!;
    const s2Result = result.sessions.find((s) => s.sessionId === 's2')!;
    expect(s1Result.result).toMatchObject({ action: 'error' });
    // s2 未受影响，正常拿到 no_change 结果
    expect(s2Result.result).toMatchObject({ action: 'no_change' });
  });
});

describe('runConsolidationTier2 — 全局块防御式包裹', () => {
  it('全局 skill 块抛异常 → 转 {action:error}，不阻断全局 memory / session 遍历', async () => {
    seedModel();
    const { fn } = makeSerialTrackingSideRun({
      failFor: (idx) => idx === 0, // v0.0.204 T2-B4: 第 1 个调用 (global skill)
    });
    const deps = makeDeps(fn, []);

    const result = await runConsolidationTier2(deps);

    expect(result.globalSkill).toMatchObject({ action: 'error' });
    expect(result.globalMemory).toMatchObject({ action: 'no_change' });
    expect(result.skippedReason).toBeNull();
  });
});

describe('runConsolidationTier2 — sessionStore.listSessions() 灾难性失败不被静默吞掉', () => {
  it('listSessions 抛异常 → sessions=[]，但已完成的两个全局块结果保留 + summary 含错误提示（非静默吞没）', async () => {
    seedModel();
    const { fn } = makeSerialTrackingSideRun();
    const deps: ConsolidationTier2Deps = {
      appConfig,
      pluginManager: {} as never,
      agentManager: { sideRun: fn } as never,
      sessionStore: {
        listSessions: vi.fn(async () => {
          throw new Error('session store unavailable');
        }),
        getSummary: vi.fn(async () => null),
      } as never,
      dataDir: tmpRoot,
      windowStart: '2026-01-01T00:00:00.000Z',
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runConsolidationTier2(deps);

    expect(result.sessions).toEqual([]);
    expect(result.globalSkill).toMatchObject({ action: 'no_change' });
    expect(result.globalMemory).toMatchObject({ action: 'no_change' });
    expect(result.summary).toContain('session 列表读取失败');
    expect(result.summary).toContain('session store unavailable');
    expect(warnSpy).toHaveBeenCalled(); // 不静默吞没：留痕供运维观察
    warnSpy.mockRestore();
  });
});
