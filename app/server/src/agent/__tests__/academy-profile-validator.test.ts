/**
 * v0.0.210 H 节 academy profile/scope 矩阵 validator 启动期闭合验证
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §3.4（summary/consolidate 矩阵完整性）
 *
 * 覆盖：
 *   - profile 加载：3 个 academy main profile + 6 个 summary/consolidate 矩阵文件全部可解析
 *   - SessionTypeProfileValidator.validateAll：toolBound 幽灵名硬失败（train-student/manage-classroom 已注册）
 *     + validateMainMatrix 矩阵完整性闭合（3 个 main 都有对应 summary + consolidate）
 *   - SessionTypePolicy.profile(kind) 对 academy 三 role 正确解析
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRealSessionTypePolicy } from '../__helpers__/session-type-policy-test-helper';
import { SessionKind } from '@app/shared';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'academy-h-validator-'));
}

describe('v0.0.210 H 节 academy profile validator 闭合', () => {
  it('validateAll 全过（3 academy main + 6 summary/consolidate 矩阵文件 + toolBound 无幽灵名）', () => {
    const root = tmpRoot();
    // 会抛错即失败（validateAll 内部含 validateOne toolBound 校验 + validateMainMatrix）
    expect(() => buildRealSessionTypePolicy(root)).not.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('academy 三 role main profile 解析正确', () => {
    const root = tmpRoot();
    const policy = buildRealSessionTypePolicy(root);
    // head_teacher（v0.0.221：train-student/manage-student 移除；只留 manage-classroom 扩 20 action）
    const headKind = new SessionKind({ biz: 'academy', role: 'head_teacher', derivation: 'parent' });
    const headProfile = policy.profile(headKind);
    expect(headProfile.id).toBe('academy-head_teacher:parent:main');
    expect(headProfile.autoNaming).toBe(false);
    expect(headProfile.toolBound).not.toContain('train-student'); // v0.0.221 改名 manage-task
    expect(headProfile.toolBound).not.toContain('manage-student'); // v0.0.221 并入 manage-classroom
    expect(headProfile.toolBound).toContain('manage-classroom');
    // coach（v0.0.221：train-student → manage-task 重命名）
    const coachKind = new SessionKind({ biz: 'academy', role: 'coach', derivation: 'parent' });
    const coachProfile = policy.profile(coachKind);
    expect(coachProfile.id).toBe('academy-coach:parent:main');
    expect(coachProfile.toolBound).not.toContain('train-student');
    expect(coachProfile.toolBound).toContain('manage-task');
    expect(coachProfile.toolBound).not.toContain('manage-classroom');
    // student
    const studentKind = new SessionKind({ biz: 'academy', role: 'student', derivation: 'parent' });
    const studentProfile = policy.profile(studentKind);
    expect(studentProfile.id).toBe('academy-student:parent:main');
    expect(studentProfile.toolBound).toHaveLength(12); // v0.0.215: +write +edit；v0.0.223: +todo（用户裁决默认给基础读写，除非特意收窄）
    expect(studentProfile.toolBound).not.toContain('manage-task');
    expect(studentProfile.toolBound).not.toContain('manage-classroom');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('summary/consolidate 矩阵闭合（3 个 main 都有对应 runKind 旁路）', () => {
    const root = tmpRoot();
    const policy = buildRealSessionTypePolicy(root);
    for (const role of ['head_teacher', 'coach', 'student'] as const) {
      for (const runKind of ['summary', 'consolidate'] as const) {
        const kind = new SessionKind({
          biz: 'academy',
          role,
          derivation: 'parent',
          runKind,
        });
        const profile = policy.profile(kind);
        expect(profile.id).toBe(`academy-${role}:parent:${runKind}`);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
