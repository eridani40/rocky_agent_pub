/**
 * createMemberService derive_academy 单测（白盒）—— squad 员工从教室学生版本派生
 * 参考: specs/tech/academy/[P1]squad_derive.md §2（derive_academy 模式）+ §5（不变量）
 *
 * 覆盖：
 *   - 完整事务：建 mate session + member + AGENTS.md → 个人差异文件 / .rocky/{skills,memory} → 团队层 复制；
 *     version.json 不复制（mate session model 走 squad）
 *   - process 版本派生被拒（DeriveSourceNotFoundError；handler 映射 400 invalid_academy_source）
 *   - 0.0 空版本（无 AGENTS.md）静默跳过、派生成功
 *   - academySource 缺失 / 与 deriveFrom 互斥 → 入参错误
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createSquadService } from '../squad-service';
import {
  createMemberService,
  DeriveSourceNotFoundError,
  type CreateMemberDeps,
} from '../member-service';
import { SquadStore, MemberStore, squadRootDir } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AcademyStore } from '../../academy/academy-store';
import { createInitialFormalVersion, forkVersionWorkspace } from '../../academy/academy-store-ops';
import { ulid } from '../../config/ulid';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadStore: SquadStore;
let memberStore: MemberStore;
let academyStore: AcademyStore;
let deps: CreateMemberDeps;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-service-academy-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  memberStore = new MemberStore({ root: tmpRoot });
  academyStore = new AcademyStore({ root: tmpRoot });
  deps = { sessionStore, squadStore, memberStore, dataDir: tmpRoot, academyStore };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const squadInput = {
  name: 'academy-squad',
  modelDefault: 'claude-sonnet-4',
  leader: { name: 'lead' },
};

/** 建教室 + 学生 + 初始 formal 版本（0.0），返回三 id + 版本 workspace 目录 */
async function seedClassroomWithStudent() {
  const classroomId = ulid();
  await academyStore.putClassroom({
    id: classroomId,
    classroomId,
    name: '高三数学班',
    headTeacherSessionId: ulid(),
  });
  const studentId = ulid();
  await academyStore.putStudent({ id: studentId, classroomId, name: '小明' });
  const { versionId, workspaceDir } = await createInitialFormalVersion(
    academyStore, tmpRoot, classroomId, studentId, { modelId: 'minimax' },
  );
  return { classroomId, studentId, versionId, workspaceDir };
}

describe('createMemberService — derive_academy', () => {
  it('完整事务：建 member + mate session + 版本内容复制到 workspace（不含 version.json）', async () => {
    const squad = await createSquadService(deps, squadInput);
    const squadId = squad.squad.id;
    const { classroomId, studentId, versionId, workspaceDir } = await seedClassroomWithStudent();
    // 给学生版本 workspace 写内容（AGENTS.md + skills + memory）
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# 学生小明 v1.0\n你是数学助教。');
    fs.mkdirSync(path.join(workspaceDir, '.rocky', 'skills', 'math-skill'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.rocky', 'skills', 'math-skill', 'SKILL.md'), '---\nname: math-skill\n---\n解题方法');
    fs.mkdirSync(path.join(workspaceDir, '.rocky', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.rocky', 'memory', 'facts.md'), '学生擅长几何');

    const result = await createMemberService(deps, {
      squadId,
      mode: 'derive_academy',
      name: 'math-mate',
      intro: '从教室派生的数学助教',
      academySource: { classroomId, studentId, versionId },
    });

    // member + session 双向关联（与 fresh/derive 同事务）
    expect(result.member.role).toBe('mate');
    expect(result.member.state).toBe('deployed');
    expect(result.member.name).toBe('math-mate');
    const mateSession = await sessionStore.getSession(result.sessionId);
    expect(mateSession).toBeTruthy();
    expect(mateSession!.memberId).toBe(result.member.id);
    expect(mateSession!.biz).toBe('studio');

    // seed 落点重映射：AGENTS.md → .rocky/agents/{name}-{memberId}.md（个人差异文件）；
    //   .rocky/{skills,memory} → 团队层同名目录
    const squadRoot = squadRootDir(tmpRoot, squadId);
    const agentsFile = path.join(squadRoot, '.rocky', 'agents', `math-mate-${result.member.id}.md`);
    expect(fs.readFileSync(agentsFile, 'utf8')).toContain('数学助教');
    expect(fs.existsSync(path.join(squadRoot, '.rocky', 'skills', 'math-skill', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(squadRoot, '.rocky', 'memory', 'facts.md'), 'utf8')).toBe('学生擅长几何');
    // version.json 不复制（mate session model/providerId 走 squad 配置）；mate session workspaceDir = 团队根
    expect(fs.existsSync(path.join(squadRoot, 'version.json'))).toBe(false);
    expect(mateSession!.workspaceDir).toBe(squadRoot);
  });

  it('process 版本派生被拒（DeriveSourceNotFoundError；不建 member/session）', async () => {
    const squad = await createSquadService(deps, squadInput);
    const squadId = squad.squad.id;
    const { classroomId, studentId, versionId } = await seedClassroomWithStudent();
    // fork 一个 process 版本（type='process'，训练中临时区）
    const forked = await forkVersionWorkspace(
      academyStore, tmpRoot, versionId, classroomId, studentId, 1, 1, ulid(),
    );

    await expect(createMemberService(deps, {
      squadId,
      mode: 'derive_academy',
      name: 'bad-mate',
      academySource: { classroomId, studentId, versionId: forked.versionId },
    })).rejects.toBeInstanceOf(DeriveSourceNotFoundError);

    // 事务未推进：squad 仍只有 leader；无 mate session 残留
    const members = await memberStore.listMembers(squadId);
    expect(members.length).toBe(1);
    expect(members[0]!.role).toBe('leader');
  });

  it('0.0 空版本（无 AGENTS.md）静默跳过，派生成功', async () => {
    const squad = await createSquadService(deps, squadInput);
    const { classroomId, studentId, versionId } = await seedClassroomWithStudent();
    // createInitialFormalVersion 只写 version.json，无 AGENTS.md / .rocky（0.0 空白起点）

    const result = await createMemberService(deps, {
      squadId: squad.squad.id,
      mode: 'derive_academy',
      name: 'blank-mate',
      academySource: { classroomId, studentId, versionId },
    });
    expect(result.member.name).toBe('blank-mate');
    const squadRoot = squadRootDir(tmpRoot, squad.squad.id);
    // 源无 AGENTS.md → 个人差异文件不存在（静默跳过，不报错）；也不留 workspaces 个人工位
    expect(fs.existsSync(path.join(squadRoot, '.rocky', 'agents', `blank-mate-${result.member.id}.md`))).toBe(false);
    expect(fs.existsSync(path.join(squadRoot, 'workspaces', result.member.id))).toBe(false);
  });

  it('academySource 缺失 / 与 deriveFrom 互斥 → 入参错误（handler 转 400）', async () => {
    const squad = await createSquadService(deps, squadInput);
    const squadId = squad.squad.id;
    await expect(createMemberService(deps, {
      squadId,
      mode: 'derive_academy',
      name: 'no-src',
    })).rejects.toThrow(/academySource required/);

    const { classroomId, studentId, versionId } = await seedClassroomWithStudent();
    await expect(createMemberService(deps, {
      squadId,
      mode: 'derive_academy',
      name: 'both-src',
      deriveFrom: 'some-member',
      academySource: { classroomId, studentId, versionId },
    })).rejects.toThrow(/mutually exclusive/);
  });
});
