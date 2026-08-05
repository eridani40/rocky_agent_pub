/**
 * SquadStore / MemberStore 单测（白盒）
 * 参考: states/v0.0.33.1/design.md §1（实体）+ §2（存储布局）
 *       specs/tech/squad/[P1]data_model.md §1（SchemaDef）+ §3（存储布局）
 *
 * 覆盖：
 *   - squad CRUD（不分片，落 {root}/squad/{id}.json）
 *   - member CRUD（按 squadId 分片，落 {root}/squads/{squadId}/members/{memberId}.json）
 *   - session schema 增量字段 bizType/squadId/memberId 持久化
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { SquadStore, MemberStore, ensureSquadDirSkeleton, squadRootDir } from '../squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-store-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 断言文件存在于 path */
function assertFileExists(p: string): void {
  expect(fs.existsSync(p)).toBe(true);
}

/** 构造 member record fixture（name 可指定） */
function mkMember(squadId: string, name: string): Parameters<MemberStore['putMember']>[0] {
  return {
    id: ulid(), squadId, sessionId: ulid(),
    name, role: 'mate' as const,
    tools: [], skillConfig: { mode: 'inherit', overrides: {} }, state: 'deployed' as const,
  };
}

describe('SquadStore（不分片）', () => {
  it('putSquad 后 getSquad 命中，落 {root}/squad/{id}.json', async () => {
    const store = new SquadStore({ root: tmpRoot });
    const id = ulid();
    const rec = {
      id, name: 'alpha', description: 'd', modelDefault: 'm1',
      leaderId: ulid(), memberIds: [], squadChatSessionId: ulid(),
      budget: null, enableHeartBeat: false,
    };
    const stored = await store.putSquad(rec);
    expect(stored.id).toBe(id);
    expect(stored.name).toBe('alpha');
    expect(stored.version).toBe(1);
    expect(stored.createdAt).toBeTruthy();

    // 落盘路径校验（不分片，{root}/squad/{id}.json）
    assertFileExists(path.join(tmpRoot, 'squad', `${id}.json`));

    const got = await store.getSquad(id);
    expect(got?.id).toBe(id);
    expect(got?.name).toBe('alpha');
  });

  it('getSquad 不存在返 undefined', async () => {
    const store = new SquadStore({ root: tmpRoot });
    expect(await store.getSquad('01KVCA58G80Y54TTF2S8ZPFR5M')).toBeUndefined();
  });

  it('listSquads 返全部按 createdAt desc', async () => {
    const store = new SquadStore({ root: tmpRoot });
    const mk = (name: string) => store.putSquad({
      id: ulid(), name, description: '', modelDefault: 'm',
      leaderId: ulid(), memberIds: [], squadChatSessionId: ulid(),
      budget: null, enableHeartBeat: false,
    });
    const a = await mk('a');
    const b = await mk('b');
    const list = await store.listSquads();
    expect(list.length).toBe(2);
    // createdAt desc（b 后建 → 排前）
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
  });

  it('deleteSquad 删 record（补偿回滚用）', async () => {
    const store = new SquadStore({ root: tmpRoot });
    const id = ulid();
    await store.putSquad({
      id, name: 'x', description: '', modelDefault: 'm',
      leaderId: ulid(), memberIds: [], squadChatSessionId: ulid(),
      budget: null, enableHeartBeat: false,
    });
    const ok = await store.deleteSquad(id);
    expect(ok).toBe(true);
    expect(await store.getSquad(id)).toBeUndefined();
  });
});

describe('MemberStore（按 squadId 分片）', () => {
  it('putMember 后 getMember 命中，落 {root}/squads/{squadId}/members/{id}.json', async () => {
    const store = new MemberStore({ root: tmpRoot });
    const squadId = ulid();
    const memberId = ulid();
    const rec = {
      id: memberId, squadId, sessionId: ulid(),
      name: 'leader1', role: 'leader' as const,
      tools: [], skillConfig: { mode: 'inherit', overrides: {} }, state: 'deployed' as const,
    };
    await store.putMember(rec);
    // 分片落盘路径校验
    assertFileExists(path.join(tmpRoot, 'squads', squadId, 'members', `${memberId}.json`));

    const got = await store.getMember(squadId, memberId);
    expect(got?.name).toBe('leader1');
    expect(got?.role).toBe('leader');
  });

  it('listMembers 仅返该 squad 的 member（分片隔离）', async () => {
    const store = new MemberStore({ root: tmpRoot });
    const squadA = ulid();
    const squadB = ulid();
    const mk = (squadId: string, name: string) => store.putMember({
      id: ulid(), squadId, sessionId: ulid(),
      name, role: 'mate' as const,
      tools: [], skillConfig: { mode: 'inherit', overrides: {} }, state: 'deployed' as const,
    });
    await mk(squadA, 'a1');
    await mk(squadA, 'a2');
    await mk(squadB, 'b1');

    const listA = await store.listMembers(squadA);
    const listB = await store.listMembers(squadB);
    expect(listA.length).toBe(2);
    expect(listB.length).toBe(1);
    expect(listA.map((m) => m.name).sort()).toEqual(['a1', 'a2']);
  });

  it('getMember 不存在返 undefined', async () => {
    const store = new MemberStore({ root: tmpRoot });
    expect(await store.getMember(ulid(), ulid())).toBeUndefined();
  });

  it('deleteMember 删 record', async () => {
    const store = new MemberStore({ root: tmpRoot });
    const squadId = ulid();
    const memberId = ulid();
    await store.putMember({
      id: memberId, squadId, sessionId: ulid(),
      name: 'm', role: 'mate' as const,
      tools: [], skillConfig: { mode: 'inherit', overrides: {} }, state: 'deployed' as const,
    });
    const ok = await store.deleteMember(squadId, memberId);
    expect(ok).toBe(true);
    expect(await store.getMember(squadId, memberId)).toBeUndefined();
  });

  // [v0.0.38 T4] 并发回归：putMember 走 putAsync（withFileLock 串行）后，
  // 同 squad 并发 N 个不同 member 的 put 不丢记录（spec file_write_lock §6.1 [wait] + §7 C1/C2）
  it('并发 putMember 同 squad N=10 不同 memberId → 全部落盘无丢失', async () => {
    const store = new MemberStore({ root: tmpRoot });
    const squadId = ulid();
    const recs = Array.from({ length: 10 }, (_, i) => mkMember(squadId, `m${i}`));
    await Promise.all(recs.map((r) => store.putMember(r)));
    const list = await store.listMembers(squadId);
    expect(list.length).toBe(10);
    const got = new Set(list.map((m) => m.id));
    for (const r of recs) expect(got.has(r.id)).toBe(true);
  });

  // [v0.0.38 T4] 并发回归：同 memberId 两并发 put → 串行不撕裂，最终 = 后一次（spec §7 C1：version=2）
  it('并发 putMember 同 memberId 两次 → 串行落盘，最终 = 后一次', async () => {
    const store = new MemberStore({ root: tmpRoot });
    const squadId = ulid();
    const memberId = ulid();
    const a = { ...mkMember(squadId, 'first'), id: memberId };
    const b = { ...mkMember(squadId, 'second'), id: memberId };
    await Promise.all([store.putMember(a), store.putMember(b)]);
    const got = await store.getMember(squadId, memberId);
    expect(got).toBeDefined();
    expect(['first', 'second']).toContain(got?.name);
    expect(got?.version).toBe(2); // 两信封自增
  });
});

describe('ensureSquadDirSkeleton（建目录骨架，design.md §2）', () => {
  it('建齐子目录 + .rocky/agents 占位；不再建 workspaces 个人工位', () => {
    const squadId = ulid();
    ensureSquadDirSkeleton(tmpRoot, squadId);
    const base = squadRootDir(tmpRoot, squadId);
    for (const sub of ['outputs', 'reports/daily', 'reports/tasks', 'reports/goals', 'members', '.rocky/state', '.rocky/agents']) {
      assertFileExists(path.join(base, sub));
    }
    // 团队 workspace 简化：骨架不含 workspaces/{memberId}/ 个人工位（session.workspaceDir 全指向团队根）
    expect(fs.existsSync(path.join(base, 'workspaces'))).toBe(false);
  });

  it('幂等：重复建不报错', () => {
    const squadId = ulid();
    ensureSquadDirSkeleton(tmpRoot, squadId);
    expect(() => ensureSquadDirSkeleton(tmpRoot, squadId)).not.toThrow();
  });
});

describe('session schema 增量字段（bizType/squadId/memberId）持久化', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    const fs = new FsCrudStore({ root: tmpRoot });
    const crud = new CompositeStore()
      .mount('session', fs)
      .mount('transcript', fs)
      .mount('summary', fs)
      .mount('runs', fs);
    sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  });

  it('createSession 带 bizType=studio/squadId/memberId → getSession 读回三字段', async () => {
    const sid = ulid();
    await sessionStore.createSession({
      id: sid, role: 'leader', biz: 'studio',
      squadId: ulid(), memberId: ulid(),
      workspaceDir: '/tmp/ws',
    });
    const got = await sessionStore.getSession(sid);
    expect(got?.biz).toBe('studio');
    expect(got?.role).toBe('leader');
    expect(got?.squadId).toBeTruthy();
    expect(got?.memberId).toBeTruthy();
  });

  it('createSession 默认 biz → getSession 读回 biz="playground"（v0.0.56 biz 必填 lazyless）', async () => {
    const sid = ulid();
    await sessionStore.createSession({ id: sid, workspaceDir: '/tmp/ws' });
    const got = await sessionStore.getSession(sid);
    // [v0.0.56] biz 默认 'playground'（createSession 自动落 biz，不再 undefined lazyless）
    expect(got?.biz).toBe('playground');
  });

  it('listSessions biz=studio 过滤：仅返 studio session', async () => {
    const playgroundSid = ulid();
    const studioSid = ulid();
    await sessionStore.createSession({ id: playgroundSid, workspaceDir: '/tmp/ws' }); // 无 bizType → playground
    await sessionStore.createSession({
      id: studioSid, role: 'squad', biz: 'studio',
      squadId: ulid(), workspaceDir: '/tmp/ws',
    });
    const studio = await sessionStore.listSessions({ biz: 'studio' });
    const playground = await sessionStore.listSessions({ biz: 'playground' });
    const all = await sessionStore.listSessions();
    expect(studio.find((s) => s.id === studioSid)).toBeTruthy();
    expect(studio.find((s) => s.id === playgroundSid)).toBeUndefined();
    expect(playground.find((s) => s.id === playgroundSid)).toBeTruthy(); // 无 bizType 视为 playground
    expect(playground.find((s) => s.id === studioSid)).toBeUndefined();
    expect(all.length).toBe(2);
  });
});
