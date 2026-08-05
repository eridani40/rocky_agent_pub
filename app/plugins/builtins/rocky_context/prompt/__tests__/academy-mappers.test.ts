/**
 * v0.0.210 H 节 academy mapper 测试 — graceful degrade + 基本 map 输出
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 mapper）
 *
 * 覆盖：
 *   - graceful degrade：缺 academyContext → 返空 fragment 数组（不抛错）
 *   - role 身份正文输出（academy_classroom_role）按 role 切换文案
 *   - training_directive / iteration_state / classroom_assets / task_status 基本输出
 *
 * 非完整场景测试——只验正常路径 + 降级。完整集成测试在 handler 层 UT 覆盖。
 */
import { describe, it, expect } from 'vitest';
import IdentityMapper from '../identity';
import AcademyClassroomRoleMapper from '../academy-classroom-role';
import AcademyCoachRoleMapper from '../academy-coach-role';
import AcademyTrainingDirectiveMapper from '../academy-training-directive';
import AcademyIterationStateMapper from '../academy-iteration-state';
import AcademyClassroomAssetsMapper from '../academy-classroom-assets';
import AcademyClassroomStudentsMapper from '../academy-classroom-students';
import AcademyTaskStatusMapper from '../academy-task-status';
import type { PromptCtx } from '../../types';

/** 造一个 PromptCtx fixture */
function mkCtx(opts: {
  role?: 'head_teacher' | 'coach' | 'student';
  classroomId?: string;
  trainingTaskId?: string;
  academy?: Record<string, unknown>;
}): PromptCtx {
  const config: Record<string, unknown> = {
    kind: opts.role ? { role: opts.role } : undefined,
    sessionContext: {
      classroomId: opts.classroomId,
      trainingTaskId: opts.trainingTaskId,
    },
    academyContext: opts.academy,
  };
  return { config: config as PromptCtx['config'] };
}

describe('academy mappers — graceful degrade', () => {
  it('缺 academyContext → 所有 academy mapper 返空', () => {
    const ctx = mkCtx({ role: 'coach', classroomId: 'cid-1' });
    expect(new AcademyClassroomRoleMapper('id', {}).map(ctx)).toEqual([]);
    expect(new AcademyCoachRoleMapper('id', {}).map(ctx)).toEqual([]);
    expect(new AcademyTrainingDirectiveMapper('id', {}).map(ctx)).toEqual([]);
    expect(new AcademyIterationStateMapper('id', {}).map(ctx)).toEqual([]);
    expect(new AcademyClassroomAssetsMapper('id', {}).map(ctx)).toEqual([]);
    expect(new AcademyClassroomStudentsMapper('id', {}).map(ctx)).toEqual([]);
    expect(new AcademyTaskStatusMapper('id', {}).map(ctx)).toEqual([]);
  });

  it('缺 role / classroomId → academy_classroom_role 返空', () => {
    const ctx1 = mkCtx({ classroomId: 'cid', academy: { classroom: { name: 'X' } } });
    expect(new AcademyClassroomRoleMapper('id', {}).map(ctx1)).toEqual([]);
    const ctx2 = mkCtx({ role: 'coach', academy: { classroom: { name: 'X' } } });
    expect(new AcademyClassroomRoleMapper('id', {}).map(ctx2)).toEqual([]);
  });

  it('非 academy role → academy_classroom_role 返空', () => {
    const ctx = mkCtx({
      // kind.role 非三 academy 角色之一 → readAcademyRole 返 undefined
      // 用 unknown cast 绕过类型，覆盖运行时行为
    } as Parameters<typeof mkCtx>[0]);
    (ctx.config.kind as { role: string } | undefined) = { role: 'rocky' };
    (ctx.config as { sessionContext: { classroomId: string } }).sessionContext.classroomId = 'cid';
    (ctx.config as { academyContext: unknown }).academyContext = { classroom: { name: 'X' } };
    expect(new AcademyClassroomRoleMapper('id', {}).map(ctx)).toEqual([]);
  });
});

describe('academy mappers — 正常输出', () => {
  it('academy_classroom_role：三 role 文案切换', () => {
    // head_teacher
    const classroom = { name: '猫咪学院' };
    const headCtx = mkCtx({
      role: 'head_teacher',
      classroomId: 'cid',
      academy: { classroom },
    });
    const headOut = new AcademyClassroomRoleMapper('id', {}).map(headCtx);
    expect(headOut).toHaveLength(1);
    expect(headOut[0]!.content).toContain('班主任');
    expect(headOut[0]!.content).toContain('猫咪学院');
    expect(headOut[0]!.tier).toBe('stable');
    // coach
    const coachCtx = mkCtx({
      role: 'coach',
      classroomId: 'cid',
      academy: { classroom },
    });
    const coachOut = new AcademyClassroomRoleMapper('id', {}).map(coachCtx);
    expect(coachOut[0]!.content).toContain('教练');
    // student
    const studentCtx = mkCtx({
      role: 'student',
      classroomId: 'cid',
      academy: { classroom },
    });
    const studentOut = new AcademyClassroomRoleMapper('id', {}).map(studentCtx);
    expect(studentOut[0]!.content).toContain('学生');
  });
});

describe('academy_coach_role — coach 专属稳定正文（v0.0.213 新增）', () => {
  it('仅 coach scope 激活：head_teacher/student role → 返空', () => {
    // 给齐 academyContext + classroomId —— 只差 role 不是 coach
    const headCtx = mkCtx({
      role: 'head_teacher',
      classroomId: 'cid',
      academy: { classroom: { name: 'X' } },
    });
    expect(new AcademyCoachRoleMapper('id', {}).map(headCtx)).toEqual([]);
    const studentCtx = mkCtx({
      role: 'student',
      classroomId: 'cid',
      academy: { classroom: { name: 'X' } },
    });
    expect(new AcademyCoachRoleMapper('id', {}).map(studentCtx)).toEqual([]);
  });

  it('缺 academyContext → coach role 也返空（graceful 降级）', () => {
    const ctx = mkCtx({ role: 'coach', classroomId: 'cid' });
    expect(new AcademyCoachRoleMapper('id', {}).map(ctx)).toEqual([]);
  });

  it('coach role + academyContext → 注入稳定正文（身份+工作流+action+skill 指针）', () => {
    const ctx = mkCtx({
      role: 'coach',
      classroomId: 'cid',
      academy: { classroom: { name: 'X' } },
    });
    const out = new AcademyCoachRoleMapper('id', {}).map(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe('stable');
    expect(out[0]!.priority).toBe(970);
    const content = out[0]!.content;
    // 教练身份（v0.0.221：绝对主权 + advisory）
    expect(content).toContain('训练教练');
    expect(content).toContain('绝对主权');
    // 训练工作流方法论（evaluate→反思→edit→revise→循环→adopt）
    expect(content).toContain('evaluate');
    expect(content).toContain('revise');
    expect(content).toContain('edit candidate');
    expect(content).toContain('adopt');
    // v0.0.221：propose 已删除；manage-task 取代 train-student
    expect(content).not.toContain('propose');
    expect(content).not.toContain('train-student');
    expect(content).toContain('manage-task');
    expect(content).toContain('fork');
    // candidate workspace 路径提示（用 prompt 中绝对路径，不靠 cwd）
    expect(content).toContain('iteration_state');
    expect(content).toContain('绝对路径');
    // academy-train-skill/learn-skill 可加载指针（call skill tool）
    expect(content).toContain('academy-train-skill');
    expect(content).toContain('academy-learn-skill');
  });
});

describe('academy mappers — 训练状态/资产', () => {
  it('academy_training_directive：directive 透传', () => {
    const ctx = mkCtx({
      role: 'coach',
      trainingTaskId: 'tid',
      academy: { task: { directive: '强化对开头段落的优化能力' } },
    });
    const out = new AcademyTrainingDirectiveMapper('id', {}).map(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('强化对开头段落的优化能力');
    expect(out[0]!.tier).toBe('context');
  });

  it('academy_iteration_state：轮次 + 历史摘要', () => {
    const ctx = mkCtx({
      role: 'coach',
      trainingTaskId: 'tid',
      academy: {
        task: { status: 'running', currentTurn: 2, maxTurns: 5 },
        turns: [
          { round: 1, decision: 'continue', avgScore: 0.6 },
          { round: 2, decision: 'continue', avgScore: 0.65 },
        ],
      },
    });
    const out = new AcademyIterationStateMapper('id', {}).map(ctx);
    expect(out[0]!.content).toContain('任务 ID：tid'); // run_turn 必填 taskId，coach 须从 prompt 可得
    expect(out[0]!.content).toContain('running');
    expect(out[0]!.content).toContain('2 / 5');
    expect(out[0]!.content).toContain('round 1');
  });

  it('academy_iteration_state：注入 candidate versionId + workspaceDir 绝对路径（v0.0.213）', () => {
    const wsPath = '/data/academy/cid/students/sid/versions/.work/0.1/1/ws';
    const ctx = mkCtx({
      role: 'coach',
      trainingTaskId: 'tid',
      academy: {
        task: { status: 'running', currentTurn: 1, candidateVersionId: 'cand-v1' },
        candidateWorkspaceDir: wsPath,
      },
    });
    const out = new AcademyIterationStateMapper('id', {}).map(ctx);
    expect(out[0]!.content).toContain('当前候选版本：cand-v1');
    // coach edit 定位用——绝对路径每轮现拉（修原 cwd 错位）
    expect(out[0]!.content).toContain(`candidate workspace 路径：${wsPath}`);
  });

  it('academy_iteration_state：无 candidate → graceful 不注入 candidate 字段（其余照常）', () => {
    // task 无 candidateVersionId + academy 无 candidateWorkspaceDir → 两字段都不出现，不 throw
    const ctx = mkCtx({
      role: 'coach',
      trainingTaskId: 'tid',
      academy: { task: { status: 'pending', currentTurn: 0 } },
    });
    const out = new AcademyIterationStateMapper('id', {}).map(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).not.toContain('当前候选版本');
    expect(out[0]!.content).not.toContain('candidate workspace 路径');
    expect(out[0]!.content).toContain('任务 ID：tid');
  });

  it('academy_classroom_assets：数据集 + 评估器 + skill 概览', () => {
    const ctx = mkCtx({
      role: 'head_teacher',
      classroomId: 'cid',
      academy: {
        classroom: { name: '猫咪学院', skillIds: ['academy-learn-skill'] },
        datasets: [{ id: 'd1', name: '基础问答' }],
        graders: [{ id: 'g1', name: 'em', type: 'em' }],
      },
    });
    const out = new AcademyClassroomAssetsMapper('id', {}).map(ctx);
    expect(out[0]!.content).toContain('基础问答');
    expect(out[0]!.content).toContain('em');
    expect(out[0]!.content).toContain('academy-learn-skill');
  });

  it('academy_task_status：任务看板', () => {
    const ctx = mkCtx({
      role: 'head_teacher',
      classroomId: 'cid',
      academy: {
        classroom: { name: '猫咪学院' },
        tasks: [
          { taskSeq: 1, status: 'running', currentTurn: 2, maxTurns: 5, directive: '学习' },
        ],
      },
    });
    const out = new AcademyTaskStatusMapper('id', {}).map(ctx);
    expect(out[0]!.content).toContain('#1');
    expect(out[0]!.content).toContain('running');
    expect(out[0]!.content).toContain('2/5');
    expect(out[0]!.content).toContain('学习');
  });
});

describe('academy_classroom_students — 学生名单（v0.0.215 新增）', () => {
  it('缺 classroomId / classroom / students 任一 → 返 []', () => {
    // 缺 classroomId
    const c1 = mkCtx({ role: 'head_teacher', academy: { classroom: { name: 'X' }, students: [] } });
    expect(new AcademyClassroomStudentsMapper('id', {}).map(c1)).toEqual([]);
    // 缺 classroom
    const c2 = mkCtx({ role: 'head_teacher', classroomId: 'cid', academy: { students: [] } });
    expect(new AcademyClassroomStudentsMapper('id', {}).map(c2)).toEqual([]);
    // students undefined（装配层查询失败降级）
    const c3 = mkCtx({ role: 'head_teacher', classroomId: 'cid', academy: { classroom: { name: 'X' } } });
    expect(new AcademyClassroomStudentsMapper('id', {}).map(c3)).toEqual([]);
  });

  it('名单注入：名字/id/正式版 label+versionId/版本数/在跑任务交叉', () => {
    const ctx = mkCtx({
      role: 'head_teacher',
      classroomId: 'cid',
      academy: {
        classroom: { name: '猫咪学院' },
        students: [
          { id: 's1', name: '记录员1', currentFormalVersionId: 'v1', versionIds: ['v1'] },
          { id: 's2', name: '记录员2', currentFormalVersionId: 'v2', versionIds: ['v2', 'v3'] },
        ],
        tasks: [
          { id: 't1', studentId: 's1', taskSeq: 1, status: 'running', currentTurn: 2, maxTurns: 5 },
          { id: 't2', studentId: 's1', taskSeq: 2, status: 'done', currentTurn: 5, maxTurns: 5 },
        ],
        formalVersionLabels: { v1: '0.0', v2: '1.0' },
      },
    });
    const out = new AcademyClassroomStudentsMapper('id', {}).map(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe('context');
    expect(out[0]!.priority).toBe(855);
    const c = out[0]!.content;
    expect(c).toContain('## 学生名单');
    expect(c).toContain('记录员1（id: s1）');
    // 正式版 label + versionId
    expect(c).toContain('当前正式版：0.0（versionId: v1）');
    expect(c).toContain('当前正式版：1.0（versionId: v2）');
    // 版本数
    expect(c).toContain('版本数：1');
    expect(c).toContain('版本数：2');
    // 在跑任务交叉：s1 仅 running 任务（done 不计）；s2 无
    expect(c).toContain('在跑任务：#1 running 2/5');
    expect(c).not.toContain('#2 done');
    expect(c).toContain('在跑任务：无');
  });

  it('空名单 → 渲染「无学生 + create_student 指针」', () => {
    const ctx = mkCtx({
      role: 'head_teacher',
      classroomId: 'cid',
      academy: { classroom: { name: 'X' }, students: [] },
    });
    const out = new AcademyClassroomStudentsMapper('id', {}).map(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('暂无学生');
    expect(out[0]!.content).toContain('create_student');
  });
});

describe('academy_classroom_role — head 职责 + 训练五元组语义（v0.0.215 扩）', () => {
  it('head 多行正文：manage-classroom 职责 + 五元组 + 分工（coach 管 task 内部，head 走 send_message）', () => {
    const ctx = mkCtx({
      role: 'head_teacher',
      classroomId: 'cid',
      academy: { classroom: { name: '猫咪学院' } },
    });
    const out = new AcademyClassroomRoleMapper('id', {}).map(ctx);
    expect(out).toHaveLength(1);
    const c = out[0]!.content;
    expect(c).toContain('你是「猫咪学院」教室的班主任。');
    expect(c).toContain('manage-classroom');
    expect(c).toContain('start_task');
    // 训练产出 = 五元组语义
    expect(c).toContain('五元组');
    expect(c).toContain('AGENTS.md');
    expect(c).toContain('model');
    expect(c).toContain('memory');
    expect(c).toContain('skills');
    expect(c).toContain('tools');
    // 分工：head 管教室层+监督，coach 对 task 内部绝对主权
    expect(c).toContain('send_message');
    expect(c).toContain('绝对主权');
  });

  it('coach / student 输出不变（单行身份正文，无职责段）', () => {
    const academy = { classroom: { name: '猫咪学院' } };
    const coachOut = new AcademyClassroomRoleMapper('id', {}).map(
      mkCtx({ role: 'coach', classroomId: 'cid', academy }),
    );
    expect(coachOut[0]!.content).toBe('你是「猫咪学院」教室的教练。');
    const studentOut = new AcademyClassroomRoleMapper('id', {}).map(
      mkCtx({ role: 'student', classroomId: 'cid', academy }),
    );
    expect(studentOut[0]!.content).toBe('你是「猫咪学院」教室的学生。');
  });
});

describe('academy mappers — identity mapper 兼容行为', () => {
  it('identity mapper 在 academy role 下返空（身份由 academy_classroom_role 接管）', () => {
    // IdentityMapper Option A 分流：sessionType=head_teacher/coach/student 非空 → 走 "else" 分支返空。
    // academy session 的身份正文由 academy_classroom_role mapper 提供（与 studio session 由
    // squad_role mapper 提供、identity 返空是同一模式）。
    const ctx = mkCtx({ role: 'head_teacher', classroomId: 'cid' });
    const out = new IdentityMapper('identity', {}).map(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('');
  });
});
