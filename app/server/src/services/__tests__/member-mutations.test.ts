/**
 * member-mutations service 单测（白盒，bottom-up-layer-verify）
 * 参考: app/server/src/services/member-mutations.ts（被测）
 *       specs/tech/version_logs/v0.0.128/change_plan.md 模块 D（service UT 覆盖）
 *       handlers/member.ts handleDeploy/handleBench/handlePatchMember（业务逻辑源，行为对齐）
 *       specs/api/overall/11a-squad-endpoints.md §2.2-§2.4（HTTP 契约——service 把行为抽共享）
 *
 * 覆盖（change_plan 模块 D）：
 *   - deployMemberService：幂等（已 deployed no-op）+ MemberNotFoundError + benched→deployed（清 benchReason/benchedAt）
 *   - benchMemberService：leader throw LeaderNotBenchableError + reason 空 + deployed→benched 记 benchReason/benchedAt
 *   - patchMemberService：name 唯一冲突 + model validateModelId + intro trim 后空 + read-modify-write merge
 *
 * 用 tmpdir + 真 MemberStore（thin service，bottom-up-layer-verify：service 层用真 store 夯实）。
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createSquadService, type SquadServiceDeps } from '../squad-service';
import { createMemberService, MemberNameConflictError, type CreateMemberInput } from '../member-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';
import {
  deployMemberService,
  benchMemberService,
  patchMemberService,
  MemberNotFoundError,
  LeaderNotBenchableError,
  type MemberMutationDeps,
  type PatchMemberInput,
} from '../member-mutations';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadStore: SquadStore;
let memberStore: MemberStore;
let squadDeps: SquadServiceDeps;
let mutationDeps: MemberMutationDeps;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-mutations-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  memberStore = new MemberStore({ root: tmpRoot });
  squadDeps = { sessionStore, squadStore, memberStore, dataDir: tmpRoot };
  mutationDeps = { memberStore };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const squadInput = {
  name: 'mut-squad',
  modelDefault: 'claude-sonnet-4',
  leader: { name: 'lead' },
};

/** 建队 → { squadId, leader } */
async function setup(): Promise<{ squadId: string; leaderId: string }> {
  const created = await createSquadService(squadDeps, squadInput);
  return { squadId: created.squad.id, leaderId: created.leaderMember.id };
}

/** fresh 建一个 deployed mate，返 memberId */
async function addMate(squadId: string, name = 'explorer', intro = '负责探索'): Promise<string> {
  const input: CreateMemberInput = { squadId, mode: 'fresh', name, intro };
  const r = await createMemberService(squadDeps, input);
  return r.member.id;
}

/** 用 service 本身把 member 先 bench（用于 deploy 测试前置） */
async function benchFirst(squadId: string, memberId: string, reason = 'test'): Promise<void> {
  await benchMemberService(mutationDeps, squadId, memberId, reason);
}

describe('deployMemberService', () => {
  it('member 不存在 → MemberNotFoundError', async () => {
    const { squadId } = await setup();
    await expect(deployMemberService(mutationDeps, squadId, '01NONEXISTENTMEMBER0001'))
      .rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it('已 deployed → 幂等 no-op（state/字段不变）', async () => {
    const { squadId } = await setup();
    const mateId = await addMate(squadId);
    const before = await memberStore.getMember(squadId, mateId);
    const result = await deployMemberService(mutationDeps, squadId, mateId);
    expect(result.state).toBe('deployed');
    expect(result.id).toBe(mateId);
    expect(result.name).toBe(before!.name);
    expect(result.benchReason).toBeUndefined();
    expect(result.benchedAt).toBeUndefined();
  });

  it('benched → deployed（清 benchReason/benchedAt）', async () => {
    const { squadId } = await setup();
    const mateId = await addMate(squadId);
    await benchFirst(squadId, mateId, '休整');
    const benched = await memberStore.getMember(squadId, mateId);
    expect(benched!.state).toBe('benched');
    expect(benched!.benchReason).toBe('休整');

    const result = await deployMemberService(mutationDeps, squadId, mateId);
    expect(result.state).toBe('deployed');
    expect(result.benchReason).toBeUndefined();
    expect(result.benchedAt).toBeUndefined();
  });

  it('lastWriteMessageId 提供（benched→deployed 路径）→ 写入 member.lastWriteMessageId', async () => {
    const { squadId } = await setup();
    const mateId = await addMate(squadId);
    await benchFirst(squadId, mateId);
    // 已 deployed 幂等路径走 no-op 不写；benched→deployed 路径才触发 putMember + 写 messageId
    const result = await deployMemberService(
      mutationDeps, squadId, mateId, '01TEST00000000000000000000',
    );
    expect(result.lastWriteMessageId).toBe('01TEST00000000000000000000');
  });

  it('lastWriteMessageId 不传 → 字段 undefined（HTTP 向后兼容）', async () => {
    const { squadId } = await setup();
    const mateId = await addMate(squadId);
    await benchFirst(squadId, mateId);
    const result = await deployMemberService(mutationDeps, squadId, mateId);
    expect(result.lastWriteMessageId).toBeUndefined();
  });
});

describe('benchMemberService', () => {
  it('member 不存在 → MemberNotFoundError', async () => {
    const { squadId } = await setup();
    await expect(benchMemberService(mutationDeps, squadId, '01NONEXISTENTMEMBER0001', 'r'))
      .rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it('leader → LeaderNotBenchableError（leader state 不变）', async () => {
    const { squadId, leaderId } = await setup();
    await expect(benchMemberService(mutationDeps, squadId, leaderId, 'r'))
      .rejects.toBeInstanceOf(LeaderNotBenchableError);
    const after = await memberStore.getMember(squadId, leaderId);
    expect(after!.state).toBe('deployed');
  });

  it('reason 空 → throw "reason required"', async () => {
    const { squadId } = await setup();
    const mateId = await addMate(squadId);
    await expect(benchMemberService(mutationDeps, squadId, mateId, ''))
      .rejects.toThrow(/reason required/);
  });

  it('deployed mate → benched + benchReason + benchedAt（ISO 8601）', async () => {
    const { squadId } = await setup();
    const mateId = await addMate(squadId);
    const result = await benchMemberService(mutationDeps, squadId, mateId, '休整一下');
    expect(result.state).toBe('benched');
    expect(result.benchReason).toBe('休整一下');
    expect(typeof result.benchedAt).toBe('string');
    // ISO 8601 格式可解析
    expect(() => new Date(result.benchedAt!).toISOString()).not.toThrow();
  });

  it('不发 send_message（仅写 state；其他 member 不受影响）', async () => {
    const { squadId } = await setup();
    const m1 = await addMate(squadId, 'm1', 'r1');
    const m2 = await addMate(squadId, 'm2', 'r2');
    await benchMemberService(mutationDeps, squadId, m1, '休整');
    const m2After = await memberStore.getMember(squadId, m2);
    expect(m2After!.state).toBe('deployed'); // m2 不受影响
  });
});

describe('patchMemberService', () => {
  it('member 不存在 → MemberNotFoundError', async () => {
    const { squadId } = await setup();
    await expect(patchMemberService(mutationDeps, squadId, '01NONEXISTENTMEMBER0001', { intro: 'x' }))
      .rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it('name 改名 squad 内唯一：撞别人 → MemberNameConflictError', async () => {
    const { squadId } = await setup();
    await addMate(squadId, 'alice', '角色1');
    const bob = await addMate(squadId, 'bob', '角色2');
    await expect(patchMemberService(mutationDeps, squadId, bob, { name: 'alice' }))
      .rejects.toBeInstanceOf(MemberNameConflictError);
  });

  it('name 改成自己原名 → no-op 不冲突（成功）', async () => {
    const { squadId } = await setup();
    const alice = await addMate(squadId, 'alice', '角色1');
    const r = await patchMemberService(mutationDeps, squadId, alice, { name: 'alice' });
    expect(r.name).toBe('alice');
  });

  it('name 改成新名 → 成功', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId, 'alice', '角色');
    const r = await patchMemberService(mutationDeps, squadId, m, { name: 'alice2' });
    expect(r.name).toBe('alice2');
  });

  it('intro 提供 trim 后空 → throw "intro required"', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    await expect(patchMemberService(mutationDeps, squadId, m, { intro: '   ' }))
      .rejects.toThrow(/intro required/);
  });

  it('intro trim 后落库（去前后空格）', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    const r = await patchMemberService(mutationDeps, squadId, m, { intro: '  新介绍  ' });
    expect(r.intro).toBe('新介绍');
  });

  it('[v0.0.155] patch.model 显式传 → accept-and-ignore + warn（A4 硬删；落盘 member.model 不存在）', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    // patch.model 是 dead 字段（PatchMemberInput 类型已不含；caller 强传时 cast）
    //   真实场景：runtime object 含 model key（TS 类型剔除但运行时存在）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patchWithModel = { intro: '改个介绍', model: 'gpt-4' } as unknown as PatchMemberInput;
    const r = await patchMemberService(mutationDeps, squadId, m, patchWithModel);
    // warn 兜底被触发
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PatchMemberInput.model is dead'));
    // patch.model 没落盘（record.model 字段已硬删）
    expect((r as unknown as { model?: string }).model).toBeUndefined();
    // 其他字段正常改
    expect(r.intro).toBe('改个介绍');
    warnSpy.mockRestore();
  });

  it('字段 merge：只改 intro → name/skillConfig/state 不变（无 model 字段）', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId, 'explorer', '原介绍');
    const before = await memberStore.getMember(squadId, m);
    const r = await patchMemberService(mutationDeps, squadId, m, { intro: '新介绍' });
    expect(r.intro).toBe('新介绍');
    expect(r.name).toBe(before!.name);
    expect(r.skillConfig).toEqual(before!.skillConfig);
    expect(r.state).toBe(before!.state);
  });

  it('dead tools/heartbeat 强传 → accept-and-ignore + warn（落盘 tools 恒 [] / heartbeat 不写）', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 类型断言绕过，模拟旧 client 强传 dead 字段（PatchMemberInput 类型已去 dead）
    const badPatch = { tools: ['x'], heartbeat: { x: 1 } } as unknown as PatchMemberInput;
    const r = await patchMemberService(mutationDeps, squadId, m, badPatch);
    // warn 被调 2 次（tools + heartbeat）
    expect(warnSpy).toHaveBeenCalledTimes(2);
    // tools 落盘恒 []（dead，static-by-type）；heartbeat 不写盘
    expect(r.tools).toEqual([]);
    expect((r as unknown as { heartbeat?: unknown }).heartbeat).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('lastWriteMessageId 提供 → 写入 member.lastWriteMessageId', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    const r = await patchMemberService(
      mutationDeps, squadId, m, { intro: 'x' }, '01TEST00000000000000000000',
    );
    expect(r.lastWriteMessageId).toBe('01TEST00000000000000000000');
  });

  // ============================================================
  // [v0.0.142] workStyle：可空 + 允许清空（不 throw，区别 intro）
  // ============================================================

  it('workStyle 提供 → trim 后落库', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    const r = await patchMemberService(mutationDeps, squadId, m, { workStyle: '  喜欢先写测试  ' });
    expect(r.workStyle).toBe('喜欢先写测试');
  });

  it('workStyle 清空（空串）→ 落库空串，不 throw（区别 intro required）', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    await patchMemberService(mutationDeps, squadId, m, { workStyle: '先写点东西' });
    const r = await patchMemberService(mutationDeps, squadId, m, { workStyle: '' });
    expect(r.workStyle).toBe('');
  });

  it('改 intro 时 workStyle 保留不丢', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    await patchMemberService(mutationDeps, squadId, m, { workStyle: '保留我' });
    const r = await patchMemberService(mutationDeps, squadId, m, { intro: '新介绍' });
    expect(r.workStyle).toBe('保留我');
    expect(r.intro).toBe('新介绍');
  });

  it('workStyle 缺省（patch 不含该键）→ member 无该字段写入', async () => {
    const { squadId } = await setup();
    const m = await addMate(squadId);
    const r = await patchMemberService(mutationDeps, squadId, m, { intro: '仅改介绍' });
    expect((r as unknown as { workStyle?: unknown }).workStyle).toBeUndefined();
  });
});
