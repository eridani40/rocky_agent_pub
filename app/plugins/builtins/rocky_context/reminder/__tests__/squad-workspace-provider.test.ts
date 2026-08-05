/**
 * rocky_context plugin v0.0.111 squad_workspace reminder provider 单测
 * 参考: specs/tech/version_logs/v0.0.111/change_plan.md 块④
 *       states/v0.0.111.workitem_visibility/design-plan.md §块④
 *
 * 覆盖：
 *   1. leader/mate → 产出 `Team workspace: <dataDir>/squads/<squadId>`
 *   2. standalone/subagent（角色 filter 不匹配）→ 空
 *   3. 缺 dataDir → 空；缺 squadId → 空
 *   4. tier=info、id=squad_workspace、路径拼接正确（path.join）
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import SquadWorkspaceReminderProvider from '../squad_workspace';

/** 构造 ReminderCtx（config.kind 决定 readSessionType；dataDir/squadId 可控） */
function mkCtx(over: {
  sessionType?: string;
  dataDir?: string | undefined;
  squadId?: string | undefined;
}): { config: Record<string, unknown> } {
  const st = over.sessionType ?? 'leader';
  const isSubagent = st === 'subagent';
  const isStudio = ['leader', 'mate', 'squad'].includes(st);
  const kind: Record<string, unknown> = {
    role: isSubagent ? 'rocky' : st,
    isSubagent,
    isStudio,
  };
  const config: Record<string, unknown> = { modelId: 'm', kind };
  if (over.dataDir !== undefined) config.dataDir = over.dataDir;
  if (over.squadId !== undefined) config.squadId = over.squadId;
  return { config };
}

function mk(): SquadWorkspaceReminderProvider {
  return new SquadWorkspaceReminderProvider('squad_workspace', {});
}

describe('squad_workspace provider', () => {
  it('leader → 产出团队盘根路径 reminder', () => {
    const out = mk().provide(mkCtx({ sessionType: 'leader', dataDir: '/data', squadId: 'SQ-1' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('squad_workspace');
    expect(out[0]!.tier).toBe('info');
    expect(out[0]!.content).toBe(`Team workspace: ${path.join('/data', 'squads', 'SQ-1')}`);
  });

  it('mate → 同样产出（leader/mate 并集）', () => {
    const out = mk().provide(mkCtx({ sessionType: 'mate', dataDir: '/data', squadId: 'SQ-9' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('/data/squads/SQ-9');
  });

  it('standalone（role=rocky，非 leader/mate）→ 空', () => {
    const out = mk().provide(mkCtx({ sessionType: 'rocky', dataDir: '/data', squadId: 'SQ-1' }));
    expect(out).toEqual([]);
  });

  it('subagent → 空（readSessionType=subagent）', () => {
    const out = mk().provide(mkCtx({ sessionType: 'subagent', dataDir: '/data', squadId: 'SQ-1' }));
    expect(out).toEqual([]);
  });

  it('leader 但缺 squadId（standalone 场景无 squadId）→ 空', () => {
    const out = mk().provide(mkCtx({ sessionType: 'leader', dataDir: '/data', squadId: undefined }));
    expect(out).toEqual([]);
  });

  it('缺 dataDir → 空', () => {
    const out = mk().provide(mkCtx({ sessionType: 'leader', dataDir: undefined, squadId: 'SQ-1' }));
    expect(out).toEqual([]);
  });

  it('dataDir/squadId 为空串 → 空', () => {
    expect(mk().provide(mkCtx({ sessionType: 'leader', dataDir: '', squadId: 'SQ-1' }))).toEqual([]);
    expect(mk().provide(mkCtx({ sessionType: 'leader', dataDir: '/data', squadId: '' }))).toEqual([]);
  });
});
