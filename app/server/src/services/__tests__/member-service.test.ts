/**
 * createMemberService 单测（白盒）—— hire fresh/derive 事务 + 双向关联 + name 唯一 + 补偿回滚
 * 参考: states/v0.0.33.1/design.md §1.5（双向关联）+ data_model.md §5（hire 流程）
 *       specs/api/overall/11a-squad-endpoints.md §2.1（hire 行为 + 错误码）
 *
 * 覆盖：
 *   - fresh 成功：mate member + mate session + 双向关联 + squad.memberIds append
 *   - derive 成功：复制父配置 + overrides + deriveFrom 记录
 *   - name 冲突 → MemberNameConflictError（handler 转 409）
 *   - 补偿回滚：注入失败 → member/session 反向删除
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createSquadService, type SquadServiceDeps } from '../squad-service';
import {
  createMemberService,
  MemberNameConflictError,
  DeriveSourceNotFoundError,
  type CreateMemberInput,
} from '../member-service';
import { SquadStore, MemberStore, squadRootDir } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadStore: SquadStore;
let memberStore: MemberStore;
let deps: SquadServiceDeps;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-service-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  memberStore = new MemberStore({ root: tmpRoot });
  deps = { sessionStore, squadStore, memberStore, dataDir: tmpRoot };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const squadInput = {
  name: 'alpha-squad',
  modelDefault: 'claude-sonnet-4',
  // [v0.0.33.3 step3] leader.systemPrompt 移除（身份正文迁 squad_role mapper）
  leader: { name: 'lead' },
};

describe('createMemberService — hire fresh', () => {
  it('建 mate member + mate session + 双向关联 + squad.memberIds append', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    const leaderId = created.leaderMember.id;

    const input: CreateMemberInput = {
      squadId,
      mode: 'fresh',
      name: 'explorer',
      intro: '负责探索与调研', // [v0.0.114] fresh 必填
      tools: ['read', 'web_search'], // [v0.0.48] accept-and-ignore（dead），落盘恒为 []
      // [v0.0.155] model 字段已移除（A4）；hire 不再落盘 member.model（model 跟 session/squad）
    };
    const result = await createMemberService(deps, input);

    // member role=mate state=deployed
    expect(result.member.role).toBe('mate');
    expect(result.member.state).toBe('deployed');
    expect(result.member.squadId).toBe(squadId);
    expect(result.member.sessionId).toBe(result.sessionId);
    expect(result.member.name).toBe('explorer');
    // [v0.0.114] intro 落盘
    expect(result.member.intro).toBe('负责探索与调研');
    // [v0.0.48] tools dead：input.tools 被忽略（static-by-type 查 tool-policy.ts），落盘 []
    expect(result.member.tools).toEqual([]);

    // 双向关联：member.sessionId ↔ session.memberId
    const mateSession = await sessionStore.getSession(result.sessionId);
    expect(mateSession).toBeTruthy();
    expect(mateSession!.memberId).toBe(result.member.id);
    expect(mateSession!.squadId).toBe(squadId);
    expect(mateSession!.biz).toBe('studio');
    expect(mateSession!.role).toBe('mate');

    // squad.memberIds 含 leaderId + 新 mateId
    const squad = await squadStore.getSquad(squadId);
    expect(squad!.memberIds).toContain(leaderId);
    expect(squad!.memberIds).toContain(result.member.id);
    expect((squad!.memberIds as string[]).length).toBe(2);

    // 团队 workspace 简化：mate session workspaceDir = 团队根 squads/{sid}/；不再建 workspaces/{memberId}/ 个人工位
    expect(mateSession!.workspaceDir).toBe(squadRootDir(tmpRoot, squadId));
    expect(fs.existsSync(path.join(squadRootDir(tmpRoot, squadId), 'workspaces', result.member.id))).toBe(false);
  });

  it('fresh hire 后 member 无 model 字段（A4：member.model 已硬删）', async () => {
    const created = await createSquadService(deps, squadInput);
    const result = await createMemberService(deps, {
      squadId: created.squad.id,
      mode: 'fresh',
      name: 'm1',
      intro: '一句话介绍',
    });
    // [v0.0.155] member.model 已硬删（A4）；record 不再有 model 字段（运行时走 session/squad）
    expect((result.member as unknown as { model?: string }).model).toBeUndefined();
  });

  // [v0.0.114] fresh 建 mate 时 intro 必填 + trim
  it('fresh 缺 intro / 空白 intro → throws "intro required"；有 intro → trim 落盘', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    // 缺 intro → throws
    await expect(createMemberService(deps, {
      squadId, mode: 'fresh', name: 'no-intro',
    })).rejects.toThrow(/intro required/);
    // 纯空白 intro → throws
    await expect(createMemberService(deps, {
      squadId, mode: 'fresh', name: 'blank-intro', intro: '   ',
    })).rejects.toThrow(/intro required/);
    // 有 intro（含首尾空白）→ trim 落盘
    const r = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'with-intro', intro: '  负责后端接口  ',
    });
    expect(r.member.intro).toBe('负责后端接口');
  });

  // [v0.0.113] fresh 缺省 skillConfig → {mode:'inherit', overrides:{}}（纯跟全局）；显式 custom 按入参
  it('fresh 缺省 skillConfig → inherit；显式 custom 按入参', async () => {
    const created = await createSquadService(deps, squadInput);
    // 缺省 → 默认 inherit（无局部覆盖，纯继承全局 enabled）
    const r1 = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'fresh', name: 'mate-default', intro: 'i',
    });
    expect(r1.member.skillConfig).toEqual({ mode: 'inherit', overrides: {} });
    // 显式 custom → 按入参（overlay 快照，不校验命中 catalog）
    const r2 = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'fresh', name: 'mate-custom', intro: 'i',
      skillConfig: { mode: 'custom', overrides: { 'okf-skill': false } },
    });
    expect(r2.member.skillConfig).toEqual({ mode: 'custom', overrides: { 'okf-skill': false } });
  });

  // [v0.0.48] member.tools dead（accept-and-ignore）：leader/mate 工具集改 static-by-type 查
  //   tool-policy.ts，member-service 不再写 caller 传的 tools（也不再装载 MATE_DEFAULT_TOOL_NAMES 默认集）。
  //   无论 caller 传什么（含缺省 / 显式值 / []），member.tools 落盘恒为 []。
  it('fresh tools 恒为 []（v0.0.48 dead）：缺省 / 显式传值 / [] 均落盘 []', async () => {
    const created = await createSquadService(deps, squadInput);
    // 缺省（不传 tools）→ []
    const r1 = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'fresh', name: 'mate-tools-default', intro: 'i',
    });
    expect(r1.member.tools).toEqual([]);
    // 显式传值 → 被忽略 → []（accept-and-ignore）
    const r2 = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'fresh', name: 'mate-tools-explicit', intro: 'i',
      tools: ['read', 'team', 'send_message'],
    });
    expect(r2.member.tools).toEqual([]);
    // 显式 [] → []
    const r3 = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'fresh', name: 'mate-tools-empty', intro: 'i', tools: [],
    });
    expect(r3.member.tools).toEqual([]);
  });
});

// [v0.0.114] intro 可编辑落库：PATCH member 走 memberStore read-modify-write 更新 intro。
//   member-service 无独立 updateMember（handler 直接 putMember），此处验证 store 层 intro 读改写落库。
describe('member intro 更新落库（PATCH read-modify-write via putMember）', () => {
  it('更新 intro → 落库可读回；不传 intro 不影响其余字段', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    const m = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'intro-edit', intro: '原始介绍',
      skillConfig: { mode: 'custom', overrides: { coding: true } },
    });

    // 模拟 PATCH：剥信封 read-modify-write，改 intro
    const existing = await memberStore.getMember(squadId, m.member.id);
    const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = existing as unknown as Record<string, unknown>;
    void _ca; void _ua; void _v;
    const updated = await memberStore.putMember({ ...(rest as object), intro: '更新后的介绍' } as Parameters<typeof memberStore.putMember>[0]);
    expect(updated.intro).toBe('更新后的介绍');
    // 落库可读回
    const reread = await memberStore.getMember(squadId, m.member.id);
    expect(reread!.intro).toBe('更新后的介绍');
    // 其余字段保留
    expect(reread!.name).toBe('intro-edit');
    expect(reread!.skillConfig).toEqual({ mode: 'custom', overrides: { coding: true } });
  });
});

describe('createMemberService — hire derive', () => {
  it('derive：复制父配置 + overrides 覆盖 + deriveFrom 记录', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;

    // 先 hire 一个 fresh mate 作父（tools 传值 v0.0.48 被忽略，父 tools 落盘 []）
    //   [v0.0.155] model 字段已移除（A4）；hire 不再带 model
    const parent = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'parent-mate', intro: '父角色介绍',
      tools: ['read'],
    });

    // derive：复制父 + overrides 部分覆盖（v0.0.33.3 step3：配置继承，无 prompt 继承）
    //   [v0.0.48] overrides.tools 被忽略（dead）；tools 落盘恒为 []
    const derived = await createMemberService(deps, {
      squadId, mode: 'derive',
      deriveFrom: parent.member.id,
      overrides: { name: 'child-mate', tools: ['write'] },
    });
    // [v0.0.114] derive 未 override intro → 继承父 intro
    expect(derived.member.intro).toBe('父角色介绍');

    // 新 member id != 父
    expect(derived.member.id).not.toBe(parent.member.id);
    // overrides 覆盖
    expect(derived.member.name).toBe('child-mate');
    // [v0.0.48] tools dead：overrides.tools 被忽略，落盘 []
    expect(derived.member.tools).toEqual([]);
    // [v0.0.113] skillConfig 不复制父快照——derive 默认 inherit（overlay 下父/子独立快照）
    expect(derived.member.skillConfig).toEqual({ mode: 'inherit', overrides: {} });
    // [v0.0.155] model 字段已硬删（A4）；derived member 也无 model（不复制父 model）
    // deriveFrom 记录
    expect(derived.member.deriveFrom).toBe(parent.member.id);
    // role 仍是 mate（不可改）
    expect(derived.member.role).toBe('mate');
  });

  it('deriveFrom 不存在 → DeriveSourceNotFoundError', async () => {
    const created = await createSquadService(deps, squadInput);
    await expect(createMemberService(deps, {
      squadId: created.squad.id, mode: 'derive',
      deriveFrom: 'nonexistent-mid',
    })).rejects.toBeInstanceOf(DeriveSourceNotFoundError);
  });

  // [v0.0.113] derive skillConfig：不复制父成员快照，默认 inherit；overrides.skillConfig 按 caller
  it('derive skillConfig 默认 inherit（不复制父）；overrides.skillConfig 按 caller', async () => {
    const created = await createSquadService(deps, squadInput);
    const leaderId = created.leaderMember.id;
    // derive 自 leader：默认 inherit（不复制父 skillConfig）
    const derived = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'derive',
      deriveFrom: leaderId,
      overrides: { name: 'derived-from-leader' },
    });
    expect(derived.member.skillConfig).toEqual({ mode: 'inherit', overrides: {} });
    expect(derived.member.role).toBe('mate'); // 强制降 mate

    // 显式 overrides.skillConfig 时按 caller 意图
    const derived2 = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'derive',
      deriveFrom: leaderId,
      overrides: { name: 'derived-explicit', skillConfig: { mode: 'custom', overrides: { foo: true } } },
    });
    expect(derived2.member.skillConfig).toEqual({ mode: 'custom', overrides: { foo: true } });
  });
});

// [v0.0.250] derive step7.5：复制父成员个人 AGENTS.md → 子名下（data_model §5 step7.5）
//   - 父有个人 AGENTS.md → 子得到一份内容相同的副本（按子 name-memberId 重命名）
//   - 父无个人 AGENTS.md → no-op（子继续用团队级 AGENTS.md 兜底；事务仍成功）
describe('createMemberService — derive step7.5 复制父个人 AGENTS.md [v0.0.250]', () => {
  it('父有个人 AGENTS.md → 子名下生成内容相同的副本', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    const parent = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'parent-mate', intro: '父介绍',
    });
    // 预置父个人 AGENTS.md（hire fresh 不自动建，手动写）
    const agentsDir = path.join(squadRootDir(tmpRoot, squadId), '.rocky', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const parentAg = path.join(agentsDir, `${parent.member.name}-${parent.member.id}.md`);
    const content = '# parent 个人差异\n身份段：父专属';
    fs.writeFileSync(parentAg, content, 'utf8');

    // derive：子名 'child-mate'，未 override name → resolvedName 继承 parent.name='parent-mate'
    //   但为隔离断言，此处 override name='child-mate' 让目标路径可清晰辨识
    const derived = await createMemberService(deps, {
      squadId, mode: 'derive', deriveFrom: parent.member.id,
      overrides: { name: 'child-mate' },
    });
    const childAg = path.join(agentsDir, `${derived.member.name}-${derived.member.id}.md`);
    expect(fs.existsSync(childAg)).toBe(true);
    expect(fs.readFileSync(childAg, 'utf8')).toBe(content);
    // 父文件仍在（复制非移动）
    expect(fs.existsSync(parentAg)).toBe(true);
  });

  it('父无个人 AGENTS.md → no-op（事务仍 201 成功；子无个人 AGENTS.md 文件）', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    const parent = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'bare-parent', intro: '父介绍',
    });
    // 不预置任何父个人 AGENTS.md
    const derived = await createMemberService(deps, {
      squadId, mode: 'derive', deriveFrom: parent.member.id,
      overrides: { name: 'child' },
    });
    // 子事务成功（无 throw），个人 AGENTS.md 不存在（子继续用团队级 AGENTS.md 兜底）
    expect(derived.member.role).toBe('mate');
    const agentsDir = path.join(squadRootDir(tmpRoot, squadId), '.rocky', 'agents');
    expect(fs.existsSync(path.join(agentsDir, `${derived.member.name}-${derived.member.id}.md`))).toBe(false);
  });
});

// [v0.0.169] hire 扩 workStyle（11a §2.1）：fresh 直传（trim 回写/空串=空串/不传=缺省无）；
//   derive 默认复制父 workStyle + overrides.workStyle 覆盖（空串=清空）。全部落库断言（getMember 读回）。
describe('createMemberService — workStyle（[v0.0.169] hire 扩展）', () => {
  it('fresh 传 workStyle → trim 落盘；空串 → 落盘空串（无 400）；不传 → 无 workStyle 字段', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    // 传值（含首尾空白）→ trim 落盘
    const r1 = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'ws-fresh', intro: 'i', workStyle: '  小步快跑，先测后改  ',
    });
    expect(r1.member.workStyle).toBe('小步快跑，先测后改');
    const reread1 = await memberStore.getMember(squadId, r1.member.id);
    expect(reread1!.workStyle).toBe('小步快跑，先测后改');
    // 空串 → 落盘空串（可空无校验，区别 intro）
    const r2 = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'ws-empty', intro: 'i', workStyle: '   ',
    });
    expect(r2.member.workStyle).toBe('');
    const reread2 = await memberStore.getMember(squadId, r2.member.id);
    expect(reread2!.workStyle).toBe('');
    // 不传 → 无 workStyle 字段（缺省不写盘）
    const r3 = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'ws-absent', intro: 'i',
    });
    expect(r3.member.workStyle).toBeUndefined();
  });

  it('derive 默认复制父 workStyle；overrides.workStyle 覆盖；空串覆盖 → 清空落盘空串', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    // 父：带 workStyle 的 fresh mate
    const parent = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'ws-parent', intro: '父介绍', workStyle: '先问清需求再动手',
    });
    // derive 无 override → 复制父 workStyle
    const d1 = await createMemberService(deps, {
      squadId, mode: 'derive', deriveFrom: parent.member.id,
      overrides: { name: 'ws-child-inherit' },
    });
    expect(d1.member.workStyle).toBe('先问清需求再动手');
    const reread1 = await memberStore.getMember(squadId, d1.member.id);
    expect(reread1!.workStyle).toBe('先问清需求再动手');
    // derive overrides.workStyle 覆盖 → trim 落盘
    const d2 = await createMemberService(deps, {
      squadId, mode: 'derive', deriveFrom: parent.member.id,
      overrides: { name: 'ws-child-override', workStyle: ' 直接给方案 ' },
    });
    expect(d2.member.workStyle).toBe('直接给方案');
    // derive overrides.workStyle 空串 → 清空（落盘空串，不继承父）
    const d3 = await createMemberService(deps, {
      squadId, mode: 'derive', deriveFrom: parent.member.id,
      overrides: { name: 'ws-child-clear', workStyle: '' },
    });
    expect(d3.member.workStyle).toBe('');
    const reread3 = await memberStore.getMember(squadId, d3.member.id);
    expect(reread3!.workStyle).toBe('');
    // 父无 workStyle + 未 override → 子不写盘
    const bare = await createMemberService(deps, {
      squadId, mode: 'fresh', name: 'ws-bare-parent', intro: 'i',
    });
    const d4 = await createMemberService(deps, {
      squadId, mode: 'derive', deriveFrom: bare.member.id,
      overrides: { name: 'ws-child-none' },
    });
    expect(d4.member.workStyle).toBeUndefined();
  });
});

describe('createMemberService — name 唯一校验（409 member_name_conflict）', () => {
  it('fresh name 与已存在 member 重复 → MemberNameConflictError', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;
    // leader.name='lead' 已存在 → hire mate name='lead' 应冲突
    await expect(createMemberService(deps, {
      squadId, mode: 'fresh', name: 'lead', intro: 'i',
    })).rejects.toBeInstanceOf(MemberNameConflictError);
  });

  it('不同 squad 同名 member 不冲突（squad 内唯一即可）', async () => {
    const s1 = await createSquadService(deps, squadInput);
    const s2 = await createSquadService(deps, { ...squadInput, name: 'beta-squad' });
    // 两 squad 各 hire name='shared-name'，互不冲突
    const m1 = await createMemberService(deps, { squadId: s1.squad.id, mode: 'fresh', name: 'shared-name', intro: 'i' });
    const m2 = await createMemberService(deps, { squadId: s2.squad.id, mode: 'fresh', name: 'shared-name', intro: 'i' });
    expect(m1.member.name).toBe('shared-name');
    expect(m2.member.name).toBe('shared-name');
    expect(m1.member.squadId).not.toBe(m2.member.squadId);
  });
});

describe('createMemberService — 补偿回滚', () => {
  it('注入 putMember 失败 → mate session 反向删除', async () => {
    const created = await createSquadService(deps, squadInput);
    const squadId = created.squad.id;

    // 覆写 memberStore.putMember：第 1 次调用抛错（member record 建失败）
    const origPut = memberStore.putMember.bind(memberStore);
    let putCallCount = 0;
    memberStore.putMember = async (rec) => {
      putCallCount++;
      throw new Error('simulated putMember failure');
    };
    void origPut;

    await expect(createMemberService(deps, {
      squadId, mode: 'fresh', name: 'fail-mate', intro: 'i',
    })).rejects.toThrow(/simulated putMember failure/);
    expect(putCallCount).toBe(1);

    // 补偿：mate session 应已删（listSessions 全空——除建队的 leader/squadChat session 外）
    // 注意：建队已建 leader + squadChat 两个 session，hire 的 mate session 应被补偿删除
    const allSessions = await sessionStore.listSessions();
    const mateSessions = allSessions.filter((s) => s.role === 'mate');
    expect(mateSessions.length).toBe(0); // mate session 被补偿删
  });
});
