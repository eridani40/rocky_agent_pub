/**
 * v0.0.221 academy-head-role mapper UT — 行为指引正文断言
 * 参考: states/v0.0.221/verify/test-plan.md §3（UT 清单 #11）
 *       design.md §4.3（head 信息供给 + send_message coach 指引 + update_task 用途）
 */
import { describe, it, expect } from 'vitest';
import AcademyHeadRoleMapper from '../academy-head-role';

describe('academy_head_role mapper — v0.0.221 NEW 行为指引', () => {
  it('role=head_teacher → 注入稳定正文（含 task 内部 send_message coach + update_task 指引）', () => {
    const impl = new AcademyHeadRoleMapper('academy_head_role');
    const fakeCtx = {
      config: { kind: { role: 'head_teacher' } },
    } as never;
    const fragments = impl.map(fakeCtx);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.id).toBe('academy_head_role');
    expect(fragments[0]!.tier).toBe('stable');
    expect(fragments[0]!.priority).toBe(975);
    const content = fragments[0]!.content;
    // 含 task 内部 send_message coach 指引
    expect(content).toContain('task 内部');
    expect(content).toContain('send_message');
    expect(content).toContain('coach');
    // 含 update_task 用途（调大 maxTurns 续训）
    expect(content).toContain('update_task');
    expect(content).toContain('maxTurns');
    // 含教室层管理职责（学生 CRUD / 任务监督）
    expect(content).toContain('manage-classroom');
  });

  it('role=coach → 返空（仅 head scope 激活）', () => {
    const impl = new AcademyHeadRoleMapper('academy_head_role');
    const fakeCtx = {
      config: { kind: { role: 'coach' } },
    } as never;
    expect(impl.map(fakeCtx)).toHaveLength(0);
  });

  it('role=student → 返空', () => {
    const impl = new AcademyHeadRoleMapper('academy_head_role');
    const fakeCtx = {
      config: { kind: { role: 'student' } },
    } as never;
    expect(impl.map(fakeCtx)).toHaveLength(0);
  });
});
