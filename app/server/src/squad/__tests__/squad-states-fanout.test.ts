/**
 * squad-states-fanout UT — v0.0.361 T4（reminder queue 扇出 helper）。
 * 参考: specs/tech/version_logs/v0.0.361/change_plan.md §1.5（helper 契约 + audience 过滤）
 *       specs/tech/version_logs/v0.0.361/change_plan.md §2（样例 B/C value 渲染原文）
 *
 * 覆盖（task.json T4 AC）：
 *   - fanoutStates：squad 全员 + squadChat 逐 session write；squad 不存在 no-op
 *   - notifyMemberState：member name 解析 + value 渲染 `[squad:agents] {name} → {state}`
 *   - notifyTaskTransition：audience 过滤（leader ∪ owner ∪ 依赖 owner，不含 squadChat/无关 member）
 *     + value 渲染 `[task] {id}「{title}」→ {中文状态}（owner: {name}）`（done 也照写）
 *   - 失败逐 session 隔离（单 session 写失败不影响其余）
 *
 * 白盒：真实 SquadStore/MemberStore/ReminderQueueStore（tmpdir），task 依赖 store 用内存 map mock。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../config/ulid';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { fanoutStates, notifyMemberState, notifyTaskTransition } from '../squad-states-fanout';
import type { ReminderQueueFile } from '../../agent/system-reminder-queue';

let root: string;
let squadStore: SquadStore;
let memberStore: MemberStore;

let squadId: string;
let leaderId: string; let leaderSid: string;
let aliceId: string; let aliceSid: string;
let bobId: string; let bobSid: string;
let chatSid: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fanout-ut-'));
  squadStore = new SquadStore({ root });
  memberStore = new MemberStore({ root });
  squadId = ulid();
  leaderId = ulid(); leaderSid = ulid();
  aliceId = ulid(); aliceSid = ulid();
  bobId = ulid(); bobSid = ulid();
  chatSid = ulid();
  await squadStore.putSquad({
    id: squadId, name: 'S', modelDefault: 'm', leaderId,
    memberIds: [leaderId, aliceId, bobId],
    squadChatSessionId: chatSid, enableHeartBeat: false,
  } as never);
  const mk = (id: string, sid: string, name: string, role: string) =>
    memberStore.putMember({
      id, squadId, sessionId: sid, name, role,
      tools: {}, skillConfig: { mode: 'inherit' }, state: 'deployed',
    } as never);
  await mk(leaderId, leaderSid, 'darvin', 'leader');
  await mk(aliceId, aliceSid, 'alice', 'mate');
  await mk(bobId, bobSid, 'bob', 'mate');
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** 读 session 的 reminder_queue.json */
function readQueue(sid: string): ReminderQueueFile {
  return JSON.parse(readFileSync(join(root, 'sessions', sid, 'reminder_queue.json'), 'utf8')) as ReminderQueueFile;
}

// ============================================================
// fanoutStates — 全员 + squadChat
// ============================================================
describe('fanoutStates', () => {
  it('写 squad 全员 + squadChat 各自 queue（同 key/value）', async () => {
    await fanoutStates(squadId, 'presence:M-1', '[squad:agents] alice presence: x', { fsRoot: root });
    for (const sid of [leaderSid, aliceSid, bobSid, chatSid]) {
      const q = readQueue(sid);
      expect(q.entries).toHaveLength(1);
      expect(q.entries[0]).toMatchObject({ key: 'presence:M-1', value: '[squad:agents] alice presence: x' });
    }
  });

  it('同 key 二次写 = 删旧 + 追队尾（有序队列语义）', async () => {
    await fanoutStates(squadId, 'k', 'v1', { fsRoot: root });
    await fanoutStates(squadId, 'k', 'v2', { fsRoot: root });
    const q = readQueue(leaderSid);
    expect(q.entries).toHaveLength(1);
    expect(q.entries[0]!.value).toBe('v2');
  });

  it('squad 不存在 → no-op（不抛、不写）', async () => {
    await fanoutStates(ulid(), 'k', 'v', { fsRoot: root });
    expect(existsSync(join(root, 'sessions'))).toBe(false);
  });

  it('失败逐 session 隔离：单 session 写失败不影响其余', async () => {
    // 把 alice 的 reminder_queue.json 路径占成目录 → read/write 均失败
    mkdirSync(join(root, 'sessions', aliceSid, 'reminder_queue.json'), { recursive: true });
    await fanoutStates(squadId, 'k', 'v', { fsRoot: root });
    expect(readQueue(leaderSid).entries[0]!.value).toBe('v');
    expect(readQueue(bobSid).entries[0]!.value).toBe('v');
    expect(readQueue(chatSid).entries[0]!.value).toBe('v');
  });
});

// ============================================================
// notifyMemberState — name 解析 + value 渲染（§2 样例 C）
// ============================================================
describe('notifyMemberState', () => {
  it('渲染 `[squad:agents] {name} → {state}` 写全员 + squadChat，key=member_state:{sessionId}', async () => {
    await notifyMemberState({ fsRoot: root, squadId, sessionId: aliceSid, state: 'running' });
    for (const sid of [leaderSid, aliceSid, bobSid, chatSid]) {
      const q = readQueue(sid);
      expect(q.entries).toHaveLength(1);
      expect(q.entries[0]).toMatchObject({
        key: `member_state:${aliceSid}`,
        value: '[squad:agents] alice → running',
      });
    }
  });

  it('member 不在 squad 内 → name 回退 sessionId（仍写全员）', async () => {
    const outsider = ulid();
    await notifyMemberState({ fsRoot: root, squadId, sessionId: outsider, state: 'idle' });
    const q = readQueue(leaderSid);
    expect(q.entries[0]!.value).toBe(`[squad:agents] ${outsider} → idle`);
  });
});

// ============================================================
// notifyTaskTransition — audience 过滤 + value 渲染（§2 样例 B）
// ============================================================
describe('notifyTaskTransition', () => {
  /** 内存 task map（TaskDepResolver 鸭子类型） */
  const taskMap = new Map<string, Record<string, unknown>>();
  const depResolver = { getInstance: (_e: string, id: string) => taskMap.get(id) };

  it('audience = leader ∪ owner ∪ 依赖 task 的 owner；squadChat/无关 member 不写', async () => {
    // t2 依赖 t1（t1.owner=bob）→ t2 transition：写 leader + t2.owner(alice) + bob
    taskMap.set('t1', { id: 't1', title: '依赖任务', owner: bobId, status: 'done' });
    await notifyTaskTransition(
      { fsRoot: root, squadId, store: depResolver },
      { id: 't2', title: '实现 T1 成功 target registry', owner: aliceId, dependencies: 't1', status: 'in_progress' },
      'in_progress',
    );
    const leaderQ = readQueue(leaderSid);
    expect(leaderQ.entries).toHaveLength(1);
    expect(leaderQ.entries[0]).toMatchObject({
      key: 'task:t2',
      value: '[task] t2「实现 T1 成功 target registry」→ 进行中（owner: alice）',
    });
    expect(readQueue(aliceSid).entries).toHaveLength(1);
    expect(readQueue(bobSid).entries).toHaveLength(1);
    expect(existsSync(join(root, 'sessions', chatSid, 'reminder_queue.json'))).toBe(false);
  });

  it('done 也照写（terminal 状态是变化）+ owner 缺省渲染 —', async () => {
    await notifyTaskTransition(
      { fsRoot: root, squadId, store: depResolver },
      { id: 't3', title: 'X', status: 'done' },
      'done',
    );
    const q = readQueue(leaderSid);
    expect(q.entries[0]!.value).toBe('[task] t3「X」→ 已结束（owner: —）');
  });

  it('owner 是 member id 时渲染 member name（软解析）', async () => {
    await notifyTaskTransition(
      { fsRoot: root, squadId, store: depResolver },
      { id: 't4', title: 'Y', owner: leaderId, status: 'todo' },
      'todo',
    );
    const q = readQueue(leaderSid);
    expect(q.entries[0]!.value).toBe('[task] t4「Y」→ 未开始（owner: darvin）');
  });
});
