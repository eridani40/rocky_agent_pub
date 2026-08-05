/**
 * v0.0.221 academy-iteration-state mapper UT — 验证扩充字段
 * 参考: states/v0.0.221/verify/test-plan.md §3（UT 清单 #12）
 *       design.md §4.2（iteration_state 扩充内容）
 *
 * 覆盖：
 *   - candidate workspaceDir 绝对路径（原 v0.0.213 已有，回归）
 *   - base workspaceDir 绝对路径（v0.0.221 NEW；修 coach bash ls 摸路）
 *   - 版本谱系（本 task 全部 process 版；含 round/versionId/label/decision/avgScore）
 *   - 已采纳 formal 列表
 *   - resumable 标志（status==='paused' && pausedReason !== 'maxturns'）
 *   - maxTurns 软提示
 *   - pausedReason=maxturns 时显式「不可 resume，需 update_task 调大」提示
 *
 * 注：本文件位于 plugins 目录（mapper 测试归属正确；server tsconfig rootDir 边界）。
 */
import { describe, it, expect } from 'vitest';
import AcademyIterationStateMapper from '../academy-iteration-state';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      kind: { role: 'coach' },
      sessionContext: { classroomId: 'CID', trainingTaskId: 'TID' },
      academyContext: {
        task: {
          id: 'TID',
          status: 'paused',
          pausedReason: 'stopped',
          currentTurn: 2,
          maxTurns: 5,
          temporaryBaselineVersionId: 'V_BASELINE',
          candidateVersionId: 'V_CAND',
          taskSeq: 1,
          coachSessionId: 'COACH_SID',
          baseVersionId: 'V_BASE',
          studentId: 'SID',
        },
        candidateWorkspaceDir: '/abs/candidate/ws',
        baseVersion: {
          id: 'V_BASE',
          label: '1.0',
          workspaceDir: '/abs/base/ws',
        },
        versionLineage: [
          { round: 1, versionId: 'V_P1', label: '1.1.1', decision: 'improve', avgScore: 0.7, workspaceDir: '/abs/p1/ws', type: 'process' },
          { round: 2, versionId: 'V_P2', label: '1.1.2', decision: 'equal', avgScore: 0.7, workspaceDir: '/abs/p2/ws', type: 'process' },
        ],
        adoptedFormalVersions: [
          { versionId: 'V_F1', label: '2.0', adoptedFromProcessVersionId: 'V_P1', adoptedFromProcessLabel: '1.1.1' },
        ],
        turns: [
          { round: 1, decision: 'improve', avgScore: 0.7 },
          { round: 2, decision: 'equal', avgScore: 0.7 },
        ],
      },
      ...overrides,
    },
  } as never;
}

describe('academy_iteration_state mapper — v0.0.221 扩充字段', () => {
  const mapper = new AcademyIterationStateMapper('academy_iteration_state');

  it('输出含 candidate workspace 路径', () => {
    const fragments = mapper.map(makeCtx());
    expect(fragments).toHaveLength(1);
    const content = fragments[0]!.content;
    expect(content).toContain('/abs/candidate/ws');
    expect(content).toContain('candidate workspace 路径');
  });

  it('输出含 base workspace 路径（修 coach bash ls 摸路）', () => {
    const fragments = mapper.map(makeCtx());
    const content = fragments[0]!.content;
    expect(content).toContain('/abs/base/ws');
    expect(content).toContain('base workspace 路径');
  });

  it('输出含版本谱系（全部 process 版）', () => {
    const fragments = mapper.map(makeCtx());
    const content = fragments[0]!.content;
    expect(content).toContain('版本谱系');
    expect(content).toContain('round 1');
    expect(content).toContain('1.1.1');
    expect(content).toContain('round 2');
    expect(content).toContain('1.1.2');
    expect(content).toContain('V_P1');
    expect(content).toContain('V_P2');
  });

  it('输出含已采纳 formal 列表', () => {
    const fragments = mapper.map(makeCtx());
    const content = fragments[0]!.content;
    expect(content).toContain('已采纳 formal 版本');
    expect(content).toContain('2.0');
    expect(content).toContain('V_F1');
    expect(content).toContain('1.1.1'); // adoptedFromProcessLabel
  });

  it('输出含 resumable 标志（status=paused+reason=stopped → 可续）', () => {
    const fragments = mapper.map(makeCtx());
    const content = fragments[0]!.content;
    expect(content).toContain('可续训（resumable）：是');
  });

  it('输出含 maxTurns 软提示', () => {
    const fragments = mapper.map(makeCtx());
    const content = fragments[0]!.content;
    expect(content).toContain('当前轮次：2 / 5');
  });

  it('pausedReason=maxturns 时显式提示 update_task 调大', () => {
    const ctx = makeCtx({
      academyContext: {
        task: {
          id: 'TID', status: 'paused', pausedReason: 'maxturns',
          currentTurn: 5, maxTurns: 5,
          candidateVersionId: 'V_CAND', temporaryBaselineVersionId: 'V_BASE',
          baseVersionId: 'V_BASE', studentId: 'SID',
        },
        candidateWorkspaceDir: '/abs/ws',
      },
    });
    const fragments = mapper.map(ctx);
    const content = fragments[0]!.content;
    expect(content).toContain('可续训（resumable）：否');
    expect(content).toContain('maxTurns 已到顶');
    expect(content).toContain('update_task');
  });

  it('task 缺 status 时不抛（graceful 降级）', () => {
    const ctx = makeCtx({ academyContext: { task: undefined } });
    expect(mapper.map(ctx)).toEqual([]);
  });
});

// ── ⑪ academy_head_role mapper 注册三步 + 行为 ──────────────────────

describe('academy_head_role mapper — v0.0.221 NEW', () => {
  it('plugin.json extImpls 含 academy_head_role', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const pluginJson = fs.readFileSync(
      path.join(process.cwd(), 'app/plugins/builtins/rocky_context/plugin.json'),
      'utf8',
    );
    expect(pluginJson).toMatch(/"implId":\s*"academy_head_role"/);
    expect(pluginJson).toMatch(/"\.\/prompt\/academy-head-role\.ts"/);
  });

  it('head scope yaml impls 含 academy_head_role', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const scopeYaml = fs.readFileSync(
      path.join(process.cwd(), 'app/plugins/scopes/academy-head_teacher.parent.main.yaml'),
      'utf8',
    );
    expect(scopeYaml).toMatch(/- academy_head_role/);
  });

  it('coach scope yaml 不含 academy_head_role（仅 head scope 激活）', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const coachScope = fs.readFileSync(
      path.join(process.cwd(), 'app/plugins/scopes/academy-coach.parent.main.yaml'),
      'utf8',
    );
    expect(coachScope).not.toMatch(/academy_head_role/);
  });
});

// ── ⑭ academy-task-status mapper 每 task 行含 coachSessionId ─────────

describe('academy-task-status mapper 含 coachSessionId', () => {
  it('每 task 行显 coach=<sessionId>', async () => {
    const { default: AcademyTaskStatusMapper } = await import('../academy-task-status');
    const mapper = new AcademyTaskStatusMapper('academy_task_status');
    const coachSid = '01KYRKTNSESS';
    const fakeCtx = {
      config: {
        kind: { role: 'head_teacher' },
        sessionContext: { classroomId: 'CID' },
        academyContext: {
          tasks: [
            { id: 't1', taskSeq: 1, status: 'running', currentTurn: 1, maxTurns: 3, coachSessionId: coachSid },
          ],
        },
      },
    } as never;
    const fragments = mapper.map(fakeCtx);
    expect(fragments).toHaveLength(1);
    const content = fragments[0]!.content;
    expect(content).toContain(`coach=${coachSid}`);
  });
});
