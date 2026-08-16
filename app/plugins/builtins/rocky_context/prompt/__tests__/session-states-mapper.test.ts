/**
 * session_states mapper UT（[v0.0.361] 静态半迁移）
 * 参考: specs/tech/version_logs/v0.0.361/change_plan.md §1.1/§1.6/§1.7 + §2 样例 D
 *       specs/tech/agent/context_and_memory/[P0]system_prompt.md（mapper 契约）
 *
 * 覆盖（输出等价断言——与退役前 reminder provider 行文逐字对照）：
 *   1. env 小节：`Environment: app=..., platform=..., model=...`（平移自 reminder/env.ts）
 *   2. workspace 小节：有 workdir → `Working directory: ...` + 绝对路径引导；无 → 跳过
 *   3. squad_workspace 小节：leader/mate → `Team workspace: {dataDir}/squads/{squadId}`；
 *      standalone/subagent/squad → 跳过（原 provider 同 filter）
 *   4. 片段形状：id=session_states / tier=stable / priority=810 / `## Session States` 标题
 *   5. 全缺 → 空贡献
 *   6. 不拼装动态项（无 task/todo/成员状态行内容）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import SessionStatesMapper from '../session_states';
import type { PromptCtx } from '../../types';

/** 构造 PromptCtx（config.kind 决定 readSessionType；workdir/dataDir/squadId/modelId 可控） */
function mkCtx(over: {
  sessionType?: string;
  modelId?: string;
  workdir?: string;
  dataDir?: string;
  squadId?: string;
}): PromptCtx {
  const st = over.sessionType;
  const config: Record<string, unknown> = {
    modelId: over.modelId ?? 'm',
    kind: st
      ? { role: st === 'subagent' ? 'rocky' : st, isSubagent: st === 'subagent', isStudio: ['leader', 'mate', 'squad'].includes(st) }
      : undefined,
  };
  if (over.workdir !== undefined) config.workdir = over.workdir;
  if (over.dataDir !== undefined) config.dataDir = over.dataDir;
  if (over.squadId !== undefined) config.squadId = over.squadId;
  return { config } as unknown as PromptCtx;
}

function mk(): SessionStatesMapper {
  return new SessionStatesMapper('session_states', {});
}

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'prod');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('session_states mapper — 静态三小节输出等价（平移自退役 reminder provider）', () => {
  it('env 小节：`Environment: app=..., platform=..., model=...`（行文等价 reminder/env.ts）', () => {
    const out = mk().map(mkCtx({ modelId: 'test-model' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('session_states');
    expect(out[0]!.tier).toBe('stable');
    expect(out[0]!.priority).toBe(810);
    // 行文与原 env reminder content 逐字一致（bullet 前缀）
    expect(out[0]!.content).toContain(`- Environment: app=prod, platform=${os.platform()}, model=test-model.`);
  });

  it('workspace 小节：有 workdir → Working directory + 绝对路径引导（行文等价 reminder/workspace.ts）', () => {
    const out = mk().map(mkCtx({ workdir: '/tmp/test-wd' }));
    const content = out[0]!.content;
    expect(content).toContain(
      '- Working directory: /tmp/test-wd, file/bash tools require absolute paths based on this working directory.',
    );
  });

  it('workspace 小节：相对 workdir → path.resolve 绝对化（原 provider 同逻辑）', () => {
    const out = mk().map(mkCtx({ workdir: 'rel/wd' }));
    expect(out[0]!.content).toContain(`- Working directory: ${path.resolve('rel/wd')}`);
  });

  it('workspace 小节：无 workdir → 跳过该行（不空贡献——env 行仍在）', () => {
    const out = mk().map(mkCtx({}));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).not.toContain('Working directory');
    expect(out[0]!.content).toContain('Environment');
  });

  it('squad_workspace 小节：leader/mate → Team workspace 团队根（行文等价 reminder/squad_workspace.ts）', () => {
    const out = mk().map(mkCtx({
      sessionType: 'mate',
      dataDir: '/data',
      squadId: 'SQ-1',
    }));
    expect(out[0]!.content).toContain('- Team workspace: /data/squads/SQ-1');
  });

  it('squad_workspace 小节：standalone / subagent / squad → 跳过（原 provider 同角色 filter）', () => {
    for (const st of [undefined, 'subagent', 'squad']) {
      const out = mk().map(mkCtx({ sessionType: st, dataDir: '/data', squadId: 'SQ-1' }));
      expect(out[0]!.content).not.toContain('Team workspace');
    }
  });

  it('squad_workspace 小节：缺 dataDir / 缺 squadId → 跳过', () => {
    const noData = mk().map(mkCtx({ sessionType: 'leader', squadId: 'SQ-1' }));
    expect(noData[0]!.content).not.toContain('Team workspace');
    const noSquad = mk().map(mkCtx({ sessionType: 'leader', dataDir: '/data' }));
    expect(noSquad[0]!.content).not.toContain('Team workspace');
  });

  it('三小节齐备：`## Session States` 标题 + 3 bullet 行序（env → workspace → team）', () => {
    const out = mk().map(mkCtx({
      sessionType: 'leader',
      workdir: '/ws',
      dataDir: '/data',
      squadId: 'SQ-1',
    }));
    const content = out[0]!.content;
    expect(content.startsWith('## Session States\n')).toBe(true);
    const envIdx = content.indexOf('Environment');
    const wsIdx = content.indexOf('Working directory');
    const teamIdx = content.indexOf('Team workspace');
    expect(envIdx).toBeGreaterThan(-1);
    expect(wsIdx).toBeGreaterThan(envIdx);
    expect(teamIdx).toBeGreaterThan(wsIdx);
  });

  it('不拼装动态项：无 task/todo/成员状态行（task/todo/状态走 reminder 体系）', () => {
    const out = mk().map(mkCtx({
      sessionType: 'leader',
      workdir: '/ws',
      dataDir: '/data',
      squadId: 'SQ-1',
    }));
    const content = out[0]!.content;
    expect(content).not.toContain('[squad:tasks]');
    expect(content).not.toContain('[todo]');
    expect(content).not.toContain('[squad:agents]');
    expect(content).not.toContain('running');
    expect(content).not.toContain('presence');
  });

  it('全缺（无 workdir + 无 squad 上下文）→ env 行仍产出（永不空——env 恒有）', () => {
    // env 小节无条件产出（原 env provider 同：process.env.APP_ENV 兜底 'dev'）
    const out = mk().map(mkCtx({}));
    expect(out).toHaveLength(1);
    expect(out[0]!.content.split('\n')).toHaveLength(3); // 标题 + 空行 + env bullet
  });
});
