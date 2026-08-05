/**
 * consolidateGlobalSkills / consolidateGlobalMemory 单测（白盒 vitest）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §4 §5.1-§5.3
 *
 * 覆盖：只统计/展示 source='agent' 条目（user 来源被排除）；虚拟哨兵 sessionId；
 *       白名单严格限定单一工具（skill_manage / memory_manage 二选一）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';

vi.mock(require('path').resolve(__dirname, '../../../llm-client-factory'), async (importActual) => {
  const actual = await importActual<typeof import('../../../llm-client-factory')>();
  return { ...actual, buildLlmClient: vi.fn(() => ({}) as unknown) };
});

import { consolidateGlobalSkills } from '../global-skill';
import { consolidateGlobalMemory } from '../global-memory';
import type { ConsolidationTier2Deps } from '../runner';
import type { ResolvedConsolidationModel } from '../model-resolve';
import {
  globalMemoryDir,
} from '../../../memory/memory-dir-store';
import { writeEntry } from '../../../memory/memory-dir-write';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-t2-global-'));
  appConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const MODEL: ResolvedConsolidationModel = { providerId: 'prov-1', modelId: 'model-a' };

function makeSideRunMock() {
  return vi.fn(async (opts: { sessionId: string; toolWhitelist: string[] }) => ({
    sessionId: opts.sessionId, runKind: 'x', runId: 'r', groupKey: 'g', state: 'completed' as const,
    promise: Promise.resolve({
      answer: '<result>\naction: no_change\ndetail: nothing to do\n</result>',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      stopReason: 'no_tool_call' as const, rounds: 1,
    }),
  }));
}

function makeDeps(sideRun: ReturnType<typeof makeSideRunMock>): ConsolidationTier2Deps {
  return {
    appConfig,
    pluginManager: {} as never,
    agentManager: { sideRun } as never,
    sessionStore: {} as never,
    dataDir: tmpRoot,
  };
}

function writeSkillFixture(name: string, source: 'agent' | 'user', evolvable: boolean) {
  const dir = join(tmpRoot, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a test skill\nsource: ${source}\nevolvable: ${evolvable}\nupdated: 2026-01-01T00:00:00.000Z\n---\nbody`,
  );
}

describe('consolidateGlobalSkills', () => {
  it('虚拟哨兵 sessionId + 白名单仅 skill_manage', async () => {
    writeSkillFixture('agent-skill-1', 'agent', true);
    writeSkillFixture('user-skill-1', 'user', false);
    const sideRun = makeSideRunMock();
    const deps = makeDeps(sideRun);

    const result = await consolidateGlobalSkills(deps, MODEL);

    expect(sideRun).toHaveBeenCalledTimes(1);
    const callArgs = sideRun.mock.calls[0]![0] as unknown as {
      sessionId: string; runKind: string; toolWhitelist?: string[]; enableToolWhitelist?: boolean;
    };
    expect(callArgs.sessionId).toBe('consolidation:global');
    expect(callArgs.runKind).toBe('consolidate'); // v0.0.204 T2-B4: toolWhitelist 不再透传，由 policy 派生
    expect(callArgs.enableToolWhitelist).toBeUndefined(); // v0.0.204 T2-B4: caller-intent 字段不再透传
    expect(result).toEqual({ action: 'no_change', detail: 'nothing to do' });
  });

  it('无 source=agent 条目也不报错（entries_list 走占位文案，仍照常发起 sideRun）', async () => {
    writeSkillFixture('user-only', 'user', false);
    const sideRun = makeSideRunMock();
    const result = await consolidateGlobalSkills(makeDeps(sideRun), MODEL);
    expect(sideRun).toHaveBeenCalledTimes(1);
    expect(result.action).toBe('no_change');
  });
});

describe('consolidateGlobalMemory', () => {
  it('虚拟哨兵 sessionId + 白名单仅 memory_manage', async () => {
    await writeEntry(globalMemoryDir(tmpRoot),
      { name: 'agent-mem-1', intro: 'i', type: 'user', body: 'b' },
      { source: 'agent' },
    );
    await writeEntry(globalMemoryDir(tmpRoot),
      { name: 'user-mem-1', intro: 'i', type: 'user', body: 'b' },
      { source: 'user' },
    );
    const sideRun = makeSideRunMock();
    const deps = makeDeps(sideRun);

    const result = await consolidateGlobalMemory(deps, MODEL);

    expect(sideRun).toHaveBeenCalledTimes(1);
    const callArgs = sideRun.mock.calls[0]![0] as unknown as {
      sessionId: string; runKind: string; toolWhitelist?: string[]; enableToolWhitelist?: boolean;
    };
    expect(callArgs.sessionId).toBe('consolidation:global');
    expect(callArgs.runKind).toBe('consolidate'); // v0.0.204 T2-B4: toolWhitelist 不再透传，由 policy 派生
    expect(callArgs.enableToolWhitelist).toBeUndefined(); // v0.0.204 T2-B4: caller-intent 字段不再透传
    expect(result).toEqual({ action: 'no_change', detail: 'nothing to do' });
  });
});
