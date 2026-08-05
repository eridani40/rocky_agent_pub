/**
 * TodoStore UT — listBySession/upsertItem/removeItem/cleanupFinished/removeAll + 原子写 + 路径。
 * 参考: specs/tech/agent/tools/[P1]todo_tools.md §2/§4（数据模型 + 存储路线 B 权威）
 *       states/v0.0.223/verify/test-plan.md §3（UT 范围）
 *
 * 覆盖：
 *   - listBySession 无文件 → 空（首启）
 *   - upsertItem 新增 + 替换（read-modify-write + 原子写）
 *   - removeItem filter out + 原子写；空 → 删文件
 *   - cleanup_finished（status ∈ {done, skipped} 清理，步骤随主 item）
 *   - removeAll（session 销毁）
 *   - 5 态 free-form enum（store 不校验跃迁，原样存）
 *   - 路径 {fsRoot}/sessions/{sid}/todos.json（packaged cwd=/ 护栏：fsRoot 须绝对路径）
 *   - schema {version:1, sessionId, items[]}
 *   - 原子写（tmp+fsync+rename；.tmp 残留清理）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoStore, isTodoStatus, type TodoItem } from '../todo-store';
import type { ReplayableEventBus } from '../../event-bus';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'todo-store-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

function mkStore(): TodoStore {
  return new TodoStore({ fsRoot: tmpRoot });
}

function todosJsonPath(sessionId: string): string {
  return join(tmpRoot, 'sessions', sessionId, 'todos.json');
}

/** 构造 TodoItem（默认 not_started，无步骤） */
function mkItem(over: Partial<TodoItem> & { id: string }): TodoItem {
  const now = new Date().toISOString();
  return {
    desc: `item-${over.id}`,
    status: 'not_started',
    steps: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

// ── 用例 ─────────────────────────────────────────────────────────────

describe('TodoStore — listBySession', () => {
  it('无文件 → 空（首启）', async () => {
    const store = mkStore();
    const items = await store.listBySession('sess-a');
    expect(items).toEqual([]);
  });

  it('schema 异常降级空（items 非 array）', async () => {
    const store = mkStore();
    // 写一份畸形文件（items 不是数组）
    const { atomicWriteSync } = await import('../../../persistence/fs-io');
    atomicWriteSync(todosJsonPath('sess-x'), JSON.stringify({ version: 1, sessionId: 'sess-x', items: 'not-array' }));
    const items = await store.listBySession('sess-x');
    expect(items).toEqual([]);
  });
});

describe('TodoStore — upsertItem', () => {
  it('新增 item（read-modify-write + 原子写）', async () => {
    const store = mkStore();
    const item = mkItem({ id: 'TI-1', desc: '写文档' });
    await store.upsertItem('sess-a', item);
    const items = await store.listBySession('sess-a');
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('TI-1');
    expect(items[0]!.desc).toBe('写文档');
  });

  it('替换 item（id 已存在 → 覆盖字段 + updatedAt 刷新）', async () => {
    const store = mkStore();
    const item = mkItem({ id: 'TI-1', status: 'not_started' });
    await store.upsertItem('sess-a', item);
    // 覆盖更新（status 变更）；upsertItem 内部刷新 updatedAt = new Date().toISOString()
    await store.upsertItem('sess-a', { ...item, status: 'in_progress' });
    const after = (await store.listBySession('sess-a'))[0]!;
    expect(after.status).toBe('in_progress');
    // updatedAt 是刷新后的 ISO 时间戳（同 ms 可能相等，只验合法 ISO 格式）
    expect(typeof after.updatedAt).toBe('string');
    expect(after.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(await store.listBySession('sess-a')).toHaveLength(1);
  });

  it('多 item 共存（不同 id 不互相覆盖）', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    await store.upsertItem('sess-a', mkItem({ id: 'TI-2' }));
    const items = await store.listBySession('sess-a');
    expect(items).toHaveLength(2);
  });

  it('session 隔离（不同 sid 互不干扰）', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    await store.upsertItem('sess-b', mkItem({ id: 'TI-2' }));
    expect(await store.listBySession('sess-a')).toHaveLength(1);
    expect(await store.listBySession('sess-b')).toHaveLength(1);
    expect((await store.listBySession('sess-a'))[0]!.id).toBe('TI-1');
  });
});

describe('TodoStore — removeItem', () => {
  it('filter out + 原子写', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    await store.upsertItem('sess-a', mkItem({ id: 'TI-2' }));
    const removed = await store.removeItem('sess-a', 'TI-1');
    expect(removed).toBe(true);
    const items = await store.listBySession('sess-a');
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('TI-2');
  });

  it('删最后一个 → 整文件删（不留空 schema 文件）', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    await store.removeItem('sess-a', 'TI-1');
    expect(existsSync(todosJsonPath('sess-a'))).toBe(false);
    expect(await store.listBySession('sess-a')).toEqual([]);
  });

  it('删不存在的 item → false（无变化不刷盘）', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    const removed = await store.removeItem('sess-a', 'TI-GHOST');
    expect(removed).toBe(false);
    expect(await store.listBySession('sess-a')).toHaveLength(1);
  });

  it('文件不存在 → false（不抛）', async () => {
    const store = mkStore();
    const removed = await store.removeItem('sess-a', 'TI-1');
    expect(removed).toBe(false);
  });
});

describe('TodoStore — cleanupFinished', () => {
  it('清理 status ∈ {done, skipped} 的主 item', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1', status: 'in_progress' }));
    await store.upsertItem('sess-a', mkItem({ id: 'TI-2', status: 'done' }));
    await store.upsertItem('sess-a', mkItem({ id: 'TI-3', status: 'skipped' }));
    await store.upsertItem('sess-a', mkItem({ id: 'TI-4', status: 'not_started' }));
    const removed = await store.cleanupFinished('sess-a');
    expect(removed).toBe(2);
    const items = await store.listBySession('sess-a');
    const ids = items.map((it) => it.id).sort();
    expect(ids).toEqual(['TI-1', 'TI-4']);
  });

  it('无已结束 item → removed=0 不刷盘', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1', status: 'in_progress' }));
    const removed = await store.cleanupFinished('sess-a');
    expect(removed).toBe(0);
    expect(await store.listBySession('sess-a')).toHaveLength(1);
  });

  it('全清理后删文件', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1', status: 'done' }));
    await store.cleanupFinished('sess-a');
    expect(existsSync(todosJsonPath('sess-a'))).toBe(false);
  });

  it('步骤随主 item 一起清理（不独立）', async () => {
    const store = mkStore();
    const item = mkItem({
      id: 'TI-1', status: 'done',
      steps: [{ id: 'S-1', desc: 'step', status: 'not_started' }],
    });
    await store.upsertItem('sess-a', item);
    await store.cleanupFinished('sess-a');
    expect(await store.listBySession('sess-a')).toEqual([]);
  });
});

describe('TodoStore — removeAll', () => {
  it('删 session 全部 todo（文件直接删）', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    await store.upsertItem('sess-a', mkItem({ id: 'TI-2' }));
    await store.removeAll('sess-a');
    expect(await store.listBySession('sess-a')).toEqual([]);
    expect(existsSync(todosJsonPath('sess-a'))).toBe(false);
  });

  it('文件不存在静默 no-op', async () => {
    const store = mkStore();
    await expect(store.removeAll('sess-a')).resolves.toBeUndefined();
  });
});

// ── session_todo_changed emit（session_event.md §2/§3 三不原则）─────────

/** mock statusBus（精简 API：仅 emit；对齐 ReplayableEventBus.emit 签名） */
function mkBus() {
  const emit = vi.fn();
  const bus = { emit } as unknown as ReplayableEventBus;
  return { emit, bus };
}

function mkStoreWithBus() {
  const { emit, bus } = mkBus();
  return { emit, store: new TodoStore({ fsRoot: tmpRoot, statusBus: bus }) };
}

/** 取第 idx 次 emit 的 (group, event) */
function emitCall(emit: ReturnType<typeof vi.fn>, idx: number) {
  const call = emit.mock.calls[idx]!;
  return { group: call[0] as string, wrapped: call[1] as { data: Record<string, unknown>; timestamp: string } };
}

describe('TodoStore — session_todo_changed emit', () => {
  it('upsertItem 写成功 → emit 一次且 shape 对齐契约（data 空对象轻量信号）', async () => {
    const { emit, store } = mkStoreWithBus();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    expect(emit).toHaveBeenCalledTimes(1);
    const { group, wrapped } = emitCall(emit, 0);
    expect(group).toBe('session_id:sess-a');
    const e = wrapped.data;
    expect(e.type).toBe('session_todo_changed');
    expect(e.sessionId).toBe('sess-a');
    expect(e.data).toEqual({}); // 轻量信号不携带 todo 数据
    expect(typeof e.id).toBe('string');
    expect((e.id as string).length).toBe(26); // ULID
    expect(typeof e.createdAt).toBe('string');
    expect(wrapped.timestamp).toBe(e.createdAt);
  });

  it('幂等键 = event.id（ulid）：同毫秒连写两次 emit 的 id 必唯一不撞键', async () => {
    const { emit, store } = mkStoreWithBus();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1', status: 'in_progress' }));
    expect(emit).toHaveBeenCalledTimes(2);
    const id0 = emitCall(emit, 0).wrapped.data.id;
    const id1 = emitCall(emit, 1).wrapped.data.id;
    expect(id0).not.toBe(id1);
  });

  it('removeItem 真删（return true）→ emit 一次', async () => {
    const { emit, store } = mkStoreWithBus();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    emit.mockClear();
    const removed = await store.removeItem('sess-a', 'TI-1');
    expect(removed).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('removeItem 删最后一个（删文件路径）→ 也 emit', async () => {
    const { emit, store } = mkStoreWithBus();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    emit.mockClear();
    await store.removeItem('sess-a', 'TI-1');
    expect(existsSync(todosJsonPath('sess-a'))).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('removeItem 无变化（return false）→ 不 emit（三不原则：无实际变更）', async () => {
    const { emit, store } = mkStoreWithBus();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    emit.mockClear();
    const removed = await store.removeItem('sess-a', 'TI-GHOST');
    expect(removed).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('cleanupFinished removed>0 → emit 一次；removed=0 → 不 emit', async () => {
    const { emit, store } = mkStoreWithBus();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1', status: 'in_progress' }));
    emit.mockClear();
    expect(await store.cleanupFinished('sess-a')).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-2', status: 'done' }));
    emit.mockClear();
    expect(await store.cleanupFinished('sess-a')).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('removeAll（session 销毁 hook）→ 不 emit（销毁时订阅方已退订）', async () => {
    const { emit, store } = mkStoreWithBus();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    emit.mockClear();
    await store.removeAll('sess-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('未注入 statusBus → 写成功不炸（optional dep no-op）', async () => {
    const store = mkStore(); // 无 bus
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    expect(await store.listBySession('sess-a')).toHaveLength(1);
  });

  it('emit 抛异常 → 吞错 console.warn，写路径语义不受影响', async () => {
    const { emit, store } = mkStoreWithBus();
    emit.mockImplementation(() => { throw new Error('bus boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    expect(await store.listBySession('sess-a')).toHaveLength(1); // 写仍成功
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('TodoStore — 5 态 free-form enum', () => {
  it('store 原样存 5 态（不校验跃迁路径）', async () => {
    const store = mkStore();
    const statuses: TodoItem['status'][] = ['not_started', 'in_progress', 'done', 'skipped', 'error'];
    for (let i = 0; i < statuses.length; i++) {
      await store.upsertItem('sess-a', mkItem({ id: `TI-${i}`, status: statuses[i]! }));
    }
    const items = await store.listBySession('sess-a');
    expect(items.map((it) => it.status).sort()).toEqual([...statuses].sort());
  });

  it('任意跃迁不报 illegal_transition（done → not_started 直接覆盖）', async () => {
    const store = mkStore();
    const item = mkItem({ id: 'TI-1', status: 'done' });
    await store.upsertItem('sess-a', item);
    // done → not_started（任意跃迁，store 不拦）
    await store.upsertItem('sess-a', { ...item, status: 'not_started' });
    const after = (await store.listBySession('sess-a'))[0]!;
    expect(after.status).toBe('not_started');
  });
});

describe('TodoStore — 路径 + 原子写 + schema', () => {
  it('路径 = {fsRoot}/sessions/{sid}/todos.json（packaged cwd=/ 护栏）', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    expect(existsSync(todosJsonPath('sess-a'))).toBe(true);
    // tmpRoot 是绝对路径（mkdtempSync 在 tmpdir 下），无字面 `~`
    expect(tmpRoot.startsWith('/')).toBe(true);
    expect(tmpRoot).not.toContain('~');
  });

  it('schema = {version:1, sessionId, items[]}（不漏字段）', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    const raw = JSON.parse(readFileSync(todosJsonPath('sess-a'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.sessionId).toBe('sess-a');
    expect(Array.isArray(raw.items)).toBe(true);
    expect(raw.items).toHaveLength(1);
  });

  it('原子写：写后无 .tmp 残留', async () => {
    const store = mkStore();
    await store.upsertItem('sess-a', mkItem({ id: 'TI-1' }));
    expect(existsSync(`${todosJsonPath('sess-a')}.tmp`)).toBe(false);
  });

  it('isTodoStatus enum 校验', () => {
    expect(isTodoStatus('not_started')).toBe(true);
    expect(isTodoStatus('in_progress')).toBe(true);
    expect(isTodoStatus('done')).toBe(true);
    expect(isTodoStatus('skipped')).toBe(true);
    expect(isTodoStatus('error')).toBe(true);
    expect(isTodoStatus('finished')).toBe(false);
    expect(isTodoStatus('')).toBe(false);
  });

  it('nextId 返 ULID（26 字符）', () => {
    const store = mkStore();
    const id = store.nextId();
    expect(typeof id).toBe('string');
    expect(id.length).toBe(26);
  });
});
