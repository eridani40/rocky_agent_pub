/**
 * SessionStore.listSessions — biz + role 过滤（T4 模块 6）
 * 参考: app/server/src/agent/session-store.ts:223-243（listSessions 签名）
 *       specs/tech/channel/[P0]channel_manager.md §3（listStudioLeaders = listSessions({biz:'studio',role:'leader'})）
 *
 * 覆盖：
 *   - 无 opts → 返全部（向后兼容）
 *   - biz 过滤：无 biz 字段历史 session 视为 'playground'
 *   - role 过滤：无 role 字段历史 session 视为 'rocky'
 *   - biz+role 联合过滤：listSessions({biz:'studio',role:'leader'})
 *   - 兼容旧调用 listSessions({biz:'playground'})（无 role 字段，role 兜底）
 *
 * 注：biz='studio' main session 需要 squadId（validateSessionKindInput 规则 3）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-list-role-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * studio main session 需要 squadId（规则 3）+ leader/mate 还要 memberId（规则 4）。
 * 用计数器让每个 session 拿到不同的 memberId/squadId 避免任何唯一约束冲突。
 */
let idCounter = 0;
async function mkStudio(role: 'leader' | 'mate' | 'squad') {
  idCounter += 1;
  const input: { id: string; biz: 'studio'; role: typeof role; squadId: string; memberId?: string } = {
    id: ulid(),
    biz: 'studio',
    role,
    squadId: ulid(), // SessionSchema 要求 squadId 为 ULID 格式
  };
  if (role === 'leader' || role === 'mate') {
    input.memberId = ulid();
  }
  return store.createSession(input);
}

describe('SessionStore.listSessions — biz + role 过滤', () => {
  it('无 opts → 返全部（向后兼容）', async () => {
    await store.createSession({ id: ulid(), biz: 'playground', role: 'rocky' });
    await mkStudio('leader');
    await mkStudio('mate');
    const all = await store.listSessions();
    expect(all).toHaveLength(3);
  });

  it('biz 过滤：仅返该分区 session', async () => {
    await store.createSession({ id: ulid(), biz: 'playground', role: 'rocky' });
    await mkStudio('leader');
    const pg = await store.listSessions({ biz: 'playground' });
    expect(pg).toHaveLength(1);
    expect(pg[0]!.biz).toBe('playground');
    const st = await store.listSessions({ biz: 'studio' });
    expect(st).toHaveLength(1);
    expect(st[0]!.biz).toBe('studio');
  });

  it('role 过滤：仅返该角色 session', async () => {
    await store.createSession({ id: ulid(), biz: 'playground', role: 'rocky' });
    await mkStudio('leader');
    await mkStudio('mate');
    const leaders = await store.listSessions({ biz: 'studio', role: 'leader' });
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.role).toBe('leader');
  });

  it('biz+role 联合过滤：listStudioLeaders 场景', async () => {
    await mkStudio('leader');
    await mkStudio('mate');
    await mkStudio('squad');
    await store.createSession({ id: ulid(), biz: 'playground', role: 'rocky' });
    const leaders = await store.listSessions({ biz: 'studio', role: 'leader' });
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.role).toBe('leader');
    expect(leaders[0]!.biz).toBe('studio');
  });

  it('role 缺省（仅 biz）→ 返该 biz 全部角色（向后兼容旧调用）', async () => {
    await mkStudio('leader');
    await mkStudio('mate');
    const studioAll = await store.listSessions({ biz: 'studio' });
    expect(studioAll).toHaveLength(2);
  });

  it('无 role 字段历史 session 视为 rocky（兜底）', async () => {
    // createSession 不传 role → 缺省 'rocky'；这里测 listSessions role=rocky 能否捞到
    await store.createSession({ id: ulid(), biz: 'playground' });
    const rockys = await store.listSessions({ biz: 'playground', role: 'rocky' });
    expect(rockys).toHaveLength(1);
    // 显式查 leader（无匹配）→ 0
    const leaders = await store.listSessions({ biz: 'playground', role: 'leader' });
    expect(leaders).toHaveLength(0);
  });

  it('无匹配 role → 返空数组', async () => {
    await mkStudio('leader');
    const mates = await store.listSessions({ biz: 'studio', role: 'mate' });
    expect(mates).toHaveLength(0);
  });

  it('无匹配 biz → 返空数组（role 过滤不生效）', async () => {
    await store.createSession({ id: ulid(), biz: 'playground', role: 'rocky' });
    // biz 不匹配先短路返空，role 过滤无数据可滤
    const result = await store.listSessions({ biz: 'studio', role: 'leader' });
    expect(result).toHaveLength(0);
  });

  it('listPlaygroundSessions = listSessions({biz:"playground"})（/listp 用）', async () => {
    await store.createSession({ id: ulid(), biz: 'playground', role: 'rocky' });
    await mkStudio('leader');
    const pgSessions = await store.listSessions({ biz: 'playground' });
    expect(pgSessions).toHaveLength(1);
    expect(pgSessions.every((s) => s.biz === 'playground')).toBe(true);
  });
});
