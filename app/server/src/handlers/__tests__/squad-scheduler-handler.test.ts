/**
 * squad-scheduler-handler 单测（白盒）—— GET /squad/:id/scheduler/history
 * 参考: specs/api/version_logs/v0.0.33.4/change_log.md §5（SchedulerHistoryEntry schema + ?limit/?roleId）
 *       specs/tech/squad/[P1]scheduler.md §8（history ring buffer + getHistory 倒序）
 *
 * 覆盖：
 *   - GET → 200 + items[] 全字段（id/squadId/roleId/roleName/at/reason/result）
 *   - ?limit=1 → items.length<=1
 *   - ?roleId 过滤（leader 全匹配 / bogus 空）
 *   - ?limit=201 → 400
 *   - 404 squad 不存在
 *   - scheduler 未启动（getScheduler 返 undefined）→ 空 items
 *   - 405 非 GET
 *   - roleName 解析（memberId → member.name；未知 roleId 兜底 roleId）
 *
 * squadRuntime.getScheduler.getHistory 用 mock 注入（真 ring buffer 由 T1 UT 覆盖）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleSchedulerHistoryRoute } from '../squad-scheduler-handler';
import type { SquadHandlerDeps, SquadRuntimePort } from '../squad';
import type { HistoryEntry } from '../../squad/scheduler/scheduler-history';
import { createSquadService } from '../../services/squad-service';
import { createMemberService } from '../../services/member-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadId: string;
let leaderId: string;
let mateId: string;
let getHistoryMock: ReturnType<typeof vi.fn>;
let getSchedulerMock: ReturnType<typeof vi.fn>;
let deps: SquadHandlerDeps;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-hist-handler-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore().mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  const created = await createSquadService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { name: 's1', modelDefault: 'm', leader: { name: 'Captain' } },
  );
  squadId = created.squad.id;
  leaderId = created.leaderMember.id;
  const mate = await createMemberService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { squadId, mode: 'fresh', name: 'Worker', intro: 'test worker' },
  );
  mateId = mate.member.id;
  getHistoryMock = vi.fn();
  getSchedulerMock = vi.fn(() => ({ reloadRole: vi.fn(), getHistory: getHistoryMock }));
  const runtime = { reloadSquad: vi.fn(), getScheduler: getSchedulerMock } as unknown as SquadRuntimePort;
  deps = { sessionStore, dataDir: tmpRoot, squadRuntime: runtime };
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<any> { return JSON.parse(await r.text()); }

function fakeEntries(): HistoryEntry[] {
  return [
    { roleId: leaderId, at: '2026-06-29T10:00:00.000Z', reason: 'heartbeat', result: 'fired' },
    { roleId: mateId, at: '2026-06-29T10:01:00.000Z', reason: 'heartbeat', result: 'fired' },
    { roleId: leaderId, at: '2026-06-29T10:02:00.000Z', reason: 'heartbeat', result: 'skipped_busy' },
  ];
}

describe('SchedulerHistoryHandler — GET /scheduler/history（api §5）', () => {
  it('200 + items[] 全字段（id/squadId/roleId/roleName/at/reason/result）', async () => {
    getHistoryMock.mockReturnValue(fakeEntries());
    const r = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.items).toHaveLength(3);
    const it0 = b.items[0];
    for (const k of ['id', 'squadId', 'roleId', 'roleName', 'at', 'reason', 'result']) {
      expect(it0).toHaveProperty(k);
    }
    expect(it0.squadId).toBe(squadId);
    // roleName 解析（leaderId → 'Captain'）
    const leaderItem = b.items.find((x: any) => x.roleId === leaderId);
    expect(leaderItem.roleName).toBe('Captain');
  });

  it('roleName 解析：mate → "Worker"', async () => {
    getHistoryMock.mockReturnValue(fakeEntries());
    const r = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    const b = await jsonBody(r);
    const mateItem = b.items.find((x: any) => x.roleId === mateId);
    expect(mateItem.roleName).toBe('Worker');
  });

  it('?limit=1 → items.length<=1 + getHistory 传 limit', async () => {
    getHistoryMock.mockReturnValue(fakeEntries().slice(0, 1));
    const r = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history?limit=1`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    const b = await jsonBody(r);
    expect(b.items.length).toBeLessThanOrEqual(1);
    expect(getHistoryMock.mock.calls[0]![0]).toBe(1);
  });

  it('?roleId 过滤传到 getHistory', async () => {
    getHistoryMock.mockReturnValue(fakeEntries().filter(e => e.roleId === leaderId));
    const r = await handleSchedulerHistoryRoute(
      new Request(`http://t/squad/${squadId}/scheduler/history?roleId=${leaderId}`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    const b = await jsonBody(r);
    for (const it of b.items) expect(it.roleId).toBe(leaderId);
    // getHistory 收到 roleId 参数
    expect(getHistoryMock.mock.calls[0]![1]).toBe(leaderId);
  });

  it('?limit=201 → 400', async () => {
    const r = await handleSchedulerHistoryRoute(
      new Request(`http://t/squad/${squadId}/scheduler/history?limit=201`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    expect(r.status).toBe(400);
    expect(getHistoryMock).not.toHaveBeenCalled();
  });

  it('404 squad 不存在', async () => {
    const r = await handleSchedulerHistoryRoute(new Request('http://t/squad/bogus/scheduler/history'),
      'GET', '/squad/bogus/scheduler/history', deps);
    expect(r.status).toBe(404);
    expect(getHistoryMock).not.toHaveBeenCalled();
  });

  it('scheduler 未启动（getScheduler 返 undefined）→ 空 items', async () => {
    getSchedulerMock.mockReturnValue(undefined);
    const r = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.items).toEqual([]);
  });

  it('squadRuntime 未注入 → 空 items（不抛错）', async () => {
    const noRt: SquadHandlerDeps = { sessionStore, dataDir: tmpRoot };
    const r = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history`),
      'GET', `/squad/${squadId}/scheduler/history`, noRt);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.items).toEqual([]);
  });

  it('405 非 GET', async () => {
    const r = await handleSchedulerHistoryRoute(
      new Request(`http://t/squad/${squadId}/scheduler/history`, { method: 'DELETE' }),
      'DELETE', `/squad/${squadId}/scheduler/history`, deps);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });

  it('未知 roleId → roleName 兜底用 roleId 本身', async () => {
    getHistoryMock.mockReturnValue([
      { roleId: 'ghost-id', at: '2026-06-29T10:00:00.000Z', reason: 'heartbeat', result: 'fired' },
    ]);
    const r = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    const b = await jsonBody(r);
    expect(b.items[0].roleName).toBe('ghost-id');
    expect(b.items[0].id).toBeTruthy();
  });

  it('[BUG-003] id 不含冒号/点/横线（testid 安全）+ 跨请求确定性（同 entry 同 id）', async () => {
    getHistoryMock.mockReturnValue(fakeEntries());
    const r1 = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    const r2 = await handleSchedulerHistoryRoute(new Request(`http://t/squad/${squadId}/scheduler/history`),
      'GET', `/squad/${squadId}/scheduler/history`, deps);
    const b1 = await jsonBody(r1);
    const b2 = await jsonBody(r2);
    // id 仅含 [A-Za-z0-9_]（testid / querySelector attribute 安全，无冒号/点/横线）
    for (const it of b1.items) {
      expect(it.id).toMatch(/^[A-Za-z0-9_]+$/);
    }
    // 同 entry（同 at+roleId+idx）跨两次 GET 返相同 id（ET step3 GET 拿 id ↔ step4 DOM 查找一致）
    expect(b1.items.map((x: any) => x.id)).toEqual(b2.items.map((x: any) => x.id));
  });
});
