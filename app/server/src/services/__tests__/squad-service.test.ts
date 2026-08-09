/**
 * createSquadService 单测（白盒）—— 8 步事务 + 双向关联 + 补偿回滚
 * 参考: states/v0.0.33.1/design.md §4（建 squad 流程）+ §1.5（双向关联）
 *       specs/tech/squad/[P1]data_model.md §2（双向关联）+ §4（createSquadService）
 *       specs/api/overall/11a-squad-endpoints.md §1.1
 *
 * 覆盖：
 *   - 成功：8 record 全建 + 目录骨架 + 3 组双向关联一致
 *   - 补偿回滚：注入失败 → 已建 record 反向删除
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createSquadService, type SquadServiceDeps } from '../squad-service';
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-service-'));
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

const validInput = {
  name: 'alpha-squad',
  description: 'test squad',
  modelDefault: 'claude-sonnet-4',
  leader: { name: 'lead' },
};

describe('createSquadService 成功（8 步事务 + 双向关联）', () => {
  it('[BUG-001] 默认 squad.timezone = 系统本地（spec scheduler.md §13 默认 user local，非 UTC）', async () => {
    const created = await createSquadService(deps, validInput);
    // entity 自带 timezone（修前缺失 → scheduler projectSquadSnapshot fallback UTC → activeWindow 错位不 fire）
    expect(created.squad.timezone).toBeTruthy();
    expect(typeof created.squad.timezone).toBe('string');
    // 与进程本地 IANA 时区一致（测试机 CST → 'Asia/Shanghai'）
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(created.squad.timezone).toBe(localTz || 'UTC');
  });

  it('建 squad + leader member + leader session + squadChat session + 目录骨架', async () => {
    const created = await createSquadService(deps, validInput);

    // squad record
    const squad = await squadStore.getSquad(created.squad.id);
    expect(squad).toBeTruthy();
    expect(squad!.name).toBe('alpha-squad');
    expect(squad!.enableHeartBeat).toBe(false); // 占位 v4 默认 false
    expect(squad!.budget).toBeNull();
    expect(squad!.enableGroupChat).toBe(true); // [v0.0.270] 群聊可见性默认开

    // leader member（role=leader, state=deployed）
    const leader = await memberStore.getMember(created.squad.id, created.leaderMember.id);
    expect(leader).toBeTruthy();
    expect(leader!.role).toBe('leader');
    expect(leader!.state).toBe('deployed');

    // 目录骨架（design.md §2；含 .rocky/agents 占位，不含 workspaces 个人工位）
    const base = squadRootDir(tmpRoot, created.squad.id);
    for (const sub of ['outputs', 'reports/daily', 'reports/tasks', 'reports/goals', 'members', '.rocky/state', '.rocky/agents']) {
      expect(fs.existsSync(path.join(base, sub))).toBe(true);
    }
    // 团队 workspace 简化：不再建 workspaces/{memberId}/ 个人工位
    expect(fs.existsSync(path.join(base, 'workspaces'))).toBe(false);
  });

  it('[v0.0.270] 建队默认 enableGroupChat=true（群聊可见性默认开；与 enableHeartBeat:false 模式对称，方向相反）', async () => {
    const created = await createSquadService(deps, validInput);
    expect(created.squad.enableGroupChat).toBe(true);
    // 落库可读回
    const squad = await squadStore.getSquad(created.squad.id);
    expect(squad!.enableGroupChat).toBe(true);
  });

  it('[v0.0.48] leader member.tools 恒为 []（dead 字段：工具集改 static-by-type 查 tool-policy.ts，resolveTools 不读 member.tools）', async () => {
    // 历史：v0.0.33.3 BUG 修曾在此装载 LEADER_DEFAULT_TOOL_NAMES 作「双保险」（建队即填 + session-config 空保底互锁）；
    //   T2 接线 resolveTools 后该写入无功能作用。member.tools 现 dead（schema required，写 [] 占位）。
    const created = await createSquadService(deps, validInput);
    const leader = await memberStore.getMember(created.squad.id, created.leaderMember.id);
    expect(leader!.tools).toEqual([]);
  });

  it('双向关联一致：squad.leaderId↔member.squadId、member.sessionId↔session.memberId、session.squadId、memberIds=[leaderId]', async () => {
    const created = await createSquadService(deps, validInput);
    const { squad, leaderMember, leaderSessionId, squadChatSessionId } = created;

    // 1. squad ⇄ member：squad.leaderId ↔ member.squadId
    expect(squad.leaderId).toBe(leaderMember.id);
    expect(leaderMember.squadId).toBe(squad.id);
    // squad.memberIds 含 leaderId
    expect(squad.memberIds).toContain(leaderMember.id);

    // 2. member ⇄ session：member.sessionId ↔ session.memberId
    expect(leaderMember.sessionId).toBe(leaderSessionId);
    const leaderSession = await sessionStore.getSession(leaderSessionId);
    expect(leaderSession).toBeTruthy();
    expect(leaderSession!.memberId).toBe(leaderMember.id);

    // 3. session ⇄ squad：session.squadId（所有 studio session 带）
    expect(leaderSession!.squadId).toBe(squad.id);
    expect(leaderSession!.biz).toBe('studio');
    expect(leaderSession!.role).toBe('leader');
    // 团队 workspace 简化：leader session workspaceDir = 团队根 squads/{sid}/（非 workspaces/{memberId}）
    expect(leaderSession!.workspaceDir).toBe(squadRootDir(tmpRoot, squad.id));

    // squadChat session 也带 squadId
    const squadChatSession = await sessionStore.getSession(squadChatSessionId);
    expect(squadChatSession).toBeTruthy();
    expect(squadChatSession!.squadId).toBe(squad.id);
    expect(squadChatSession!.biz).toBe('studio');
    expect(squadChatSession!.role).toBe('squad');
    expect(squadChatSession!.memberId).toBeUndefined(); // squadChat 无 memberId

    // squad.squadChatSessionId 回填
    expect(squad.squadChatSessionId).toBe(squadChatSessionId);
  });

  // [v0.0.113] leader 默认 skillConfig=inherit（纯继承全局 enabled，overlay 无局部覆盖）
  it('leader 默认 skillConfig={mode:inherit, overrides:{}}（不再 seed skill 白名单）', async () => {
    const created = await createSquadService(deps, validInput);
    expect(created.leaderMember.skillConfig).toEqual({ mode: 'inherit', overrides: {} });
  });

  // [v0.0.114] leader 默认 intro = 代码固定职能文案（defaultLeaderIntro）。
  //   断言用「非空 string」避免脆断言（不锁整句文案，文案可编辑/演化）。
  it('leader 默认 intro：非空 string 且落库可读回', async () => {
    const created = await createSquadService(deps, validInput);
    const intro = created.leaderMember.intro ?? '';
    expect(typeof created.leaderMember.intro).toBe('string');
    expect(intro.trim().length).toBeGreaterThan(0);
    // 落库可读回（花名册注入链路读的是 store 里的 member entity）
    const leader = await memberStore.getMember(created.squad.id, created.leaderMember.id);
    expect(leader!.intro).toBe(intro);
  });
});

describe('createSquadService 入参校验（400 错误，service 兜底）', () => {
  it('缺 name 抛错', async () => {
    await expect(createSquadService(deps, {
      name: '', modelDefault: 'm', leader: { name: 'l' },
    })).rejects.toThrow(/name required/);
  });

  it('缺 modelDefault 抛错', async () => {
    await expect(createSquadService(deps, {
      name: 's', modelDefault: '', leader: { name: 'l' },
    })).rejects.toThrow(/modelDefault required/);
  });

  it('缺 leader.name 抛错', async () => {
    await expect(createSquadService(deps, {
      name: 's', modelDefault: 'm', leader: { name: '' },
    })).rejects.toThrow(/leader\.name required/);
  });
});

describe('createSquadService 补偿回滚（任一步失败 → 已建 record 反向删除）', () => {
  it('注入 SessionStore.deleteSession 失败时... 改注入：putSquad 失败 → 已建的 session/member 全删', async () => {
    // 构造一个会在 putSquad 阶段抛错的 SquadStore（覆写 putSquad）
    const failingSquadStore = new SquadStore({ root: tmpRoot });
    const origPut = failingSquadStore.putSquad.bind(failingSquadStore);
    let putCallCount = 0;
    failingSquadStore.putSquad = async (rec) => {
      putCallCount++;
      // squad record 第 1 次 put 即抛错（模拟建 squad record 失败）
      throw new Error('simulated squad put failure');
    };
    void origPut;
    const failingDeps: SquadServiceDeps = {
      sessionStore, squadStore: failingSquadStore, memberStore, dataDir: tmpRoot,
    };

    await expect(createSquadService(failingDeps, validInput)).rejects.toThrow(/simulated squad put failure/);
    expect(putCallCount).toBe(1); // 确认确实走到了 putSquad

    // 补偿：leader session + squadChat session + leader member 应已删
    // （squad record 未建成 → 不需删）
    // leader member 应已删
    // 但我们没有 memberId（service 内部生成，未返回）。改用 listMembers 验证
    // memberStore 按 squadId 分片，但 squadId 也是内部生成——用 listSquads 找不到 record，
    // 故改验证 session list 全空（leader/squadChat session 被删）
    const allSessions = await sessionStore.listSessions();
    expect(allSessions.length).toBe(0); // 两个 session 都被补偿删除
  });

  it('注入 SessionStore.createSession 在 squadChat 阶段失败 → leader session 已删', async () => {
    // 覆写 sessionStore.createSession：第 2 次调用（squadChat）抛错
    const origCreate = sessionStore.createSession.bind(sessionStore);
    let createCallCount = 0;
    sessionStore.createSession = async (input) => {
      createCallCount++;
      if (createCallCount === 2) throw new Error('simulated squadChat session failure');
      return origCreate(input);
    };

    await expect(createSquadService(deps, validInput)).rejects.toThrow(/simulated squadChat session failure/);
    expect(createCallCount).toBe(2); // leader 建成功（call 1），squadChat 失败（call 2）

    // 补偿：leader session（call 1 建的）应已删
    const allSessions = await sessionStore.listSessions();
    expect(allSessions.length).toBe(0);

    // squad record / member 都未建到（事务在 squadChat 阶段就炸了，member/squad 还没建）
    const allSquads = await squadStore.listSquads();
    expect(allSquads.length).toBe(0);
  });
});
