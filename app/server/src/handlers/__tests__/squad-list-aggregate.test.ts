/**
 * GET /squad 列表聚合测试（v0.0.305 T1）
 * 参考: specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/architecture.md D1/D2
 *       specs/api/overall/11a-squad-endpoints.md §1.2（SquadSummary 增量字段）
 *
 * 覆盖：
 *   - GET /squad 列表合并 3 个聚合字段（onlineCount/inProgressCount/lastActiveAt）
 *   - sessionStore.listSessions 聚合异常 → 降级返回无 3 字段（旧行为，不 500）
 *   - 无 session 时 lastActiveAt fallback squad.updatedAt
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSquadRoute } from '../squad';
import type { SquadHandlerDeps } from '../squad';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import type { SquadRecord, MemberRecord } from '../../agent/schema_defs/squad';
import { ulid } from '../../config/ulid';

let tmpRoot: string;
let squadStore: SquadStore;
let memberStore: MemberStore;
let listSessionsMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-list-agg-'));
  squadStore = new SquadStore({ root: tmpRoot });
  memberStore = new MemberStore({ root: tmpRoot });
  listSessionsMock = vi.fn().mockResolvedValue([]);
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<any> { return JSON.parse(await r.text()); }

function getReq(): Request { return new Request('http://t/squad', { method: 'GET' }); }

function makeDeps(): SquadHandlerDeps {
  return {
    sessionStore: { listSessions: listSessionsMock } as never,
    dataDir: tmpRoot,
    memberStore,
  };
}

async function putSquad(id: string, chatSid: string): Promise<void> {
  await squadStore.putSquad({
    id, name: 's-' + id, modelDefault: 'm', leaderId: ulid(), memberIds: [],
    squadChatSessionId: chatSid, enableHeartBeat: false,
  } as SquadRecord);
}

async function putMember(squadId: string, id: string, sessionId: string, state: 'deployed' | 'benched'): Promise<void> {
  await memberStore.putMember({
    id, squadId, sessionId, name: 'm-' + id, role: 'mate', tools: [],
    skillConfig: { mode: 'inherit', overrides: {} }, state,
  } as MemberRecord);
}

/** 造 studio session 视图（computeSquadAggregates 只消费 id/squadId/state/updatedAt） */
function mkStudioSession(id: string, squadId: string | undefined, state: string, updatedAt: string): Record<string, unknown> {
  return { id, squadId, state, updatedAt, running: state === 'running' };
}

describe('GET /squad — 列表合并聚合 3 字段（v0.0.305）', () => {
  it('正常聚合：onlineCount=deployed 数 + inProgressCount=busy session 数 + lastActiveAt=max', async () => {
    const sqId = ulid();
    const chatSid = ulid();
    const memberSid = ulid(); // deployed member 的直连 session（running → 计入 inProgressCount）
    await putSquad(sqId, chatSid);
    await putMember(sqId, ulid(), memberSid, 'deployed');
    await putMember(sqId, ulid(), ulid(), 'benched');
    listSessionsMock.mockResolvedValue([
      mkStudioSession(chatSid, sqId, 'idle', '2026-08-01T01:00:00.000Z'),
      mkStudioSession(memberSid, sqId, 'running', '2026-08-01T09:00:00.000Z'),
    ]);

    const r = await handleSquadRoute(getReq(), 'GET', '/squad', makeDeps());
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.items).toHaveLength(1);
    const item = b.items[0]!;
    expect(item.onlineCount).toBe(1);
    expect(item.inProgressCount).toBe(1);
    expect(item.lastActiveAt).toBe('2026-08-01T09:00:00.000Z');
  });

  it('无任何 session → lastActiveAt fallback squad.updatedAt（恒有值可排序）', async () => {
    const sqId = ulid();
    await putSquad(sqId, ulid());

    const r = await handleSquadRoute(getReq(), 'GET', '/squad', makeDeps());
    const b = await jsonBody(r);
    const item = b.items[0]!;
    expect(item.onlineCount).toBe(0);
    expect(item.inProgressCount).toBe(0);
    expect(typeof item.lastActiveAt).toBe('string');
  });

  it('listSessions 异常 → 降级返回无 3 字段（旧行为），不 500', async () => {
    const sqId = ulid();
    await putSquad(sqId, ulid());
    listSessionsMock.mockRejectedValue(new Error('session boom'));

    const r = await handleSquadRoute(getReq(), 'GET', '/squad', makeDeps());
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).not.toHaveProperty('onlineCount');
    expect(b.items[0]).not.toHaveProperty('inProgressCount');
    expect(b.items[0]).not.toHaveProperty('lastActiveAt');
  });

  it('playground session（无 squadId）不参与任何 squad 聚合', async () => {
    const sqId = ulid();
    const chatSid = ulid();
    await putSquad(sqId, chatSid);
    listSessionsMock.mockResolvedValue([
      mkStudioSession(chatSid, sqId, 'idle', '2026-08-01T01:00:00.000Z'),
      mkStudioSession(ulid(), undefined, 'running', '2026-08-01T09:00:00.000Z'), // playground
    ]);

    const r = await handleSquadRoute(getReq(), 'GET', '/squad', makeDeps());
    const b = await jsonBody(r);
    expect(b.items[0]!.inProgressCount).toBe(0);
  });
});
