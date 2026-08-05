// @vitest-environment node
/**
 * chat-slice 统一排序比较器单测（v0.0.231）
 * 参考:
 *   - specs/ui/components/chat-page/_overview.md §4.1（列表统一排序契约：置顶组在前、同组内 updatedAt desc）
 *   - specs/tech/version_logs/v0.0.231/change_plan.md（compareSessionsForList 收敛 setSessions/applySessionMetaEvent）
 *   - specs/prd/version_logs/v0.0.231.md §3（P-A 新建在顶 / P-B 对话浮上 / P-C 置顶分组）
 *
 * 覆盖 acceptanceCriteria 第 1 条：
 *   - compareSessionsForList：pinned 降序优先、同组内 updatedAt desc、同 updatedAt 稳定序
 *   - setSessions 乱序入 → 归位（不 mutate 入参）
 *   - applySessionMetaEvent 已存在会话 updatedAt 更新 → 浮到组内顶（原位替换 → 重排）
 *   - 新会话（无 pinned）插入 → 非置顶组顶（有置顶时不抢置顶组）
 *   - 置顶会话 meta 更新 → 不跌出置顶组
 */
import { describe, it, expect } from 'vitest';
import {
  createChatSliceStore,
  compareSessionsForList,
  type SessionMetaUpdateEvent,
} from '../chat-slice';
import type { Session } from '../../components/chat-page/types';

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-a',
    title: 'A',
    status: 'active',
    state: 'idle',
    running: false,
    currentRunId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

/** 构造 session_meta_update 事件（data=全量 SessionMetaView） */
function mkMetaEvt(sid: string, data: Partial<Session>): SessionMetaUpdateEvent {
  return {
    id: 'evt-' + sid,
    type: 'session_meta_update',
    sessionId: sid,
    createdAt: '2026-08-01T10:00:00.000Z',
    data: mkSession({ id: sid, ...data }),
  };
}

const T = (m: number) => `2026-08-01T00:${String(m).padStart(2, '0')}:00.000Z`;

describe('compareSessionsForList — 统一排序比较器（v0.0.231 §4.1）', () => {
  it('置顶组在前、非置顶组在后（pinned 降序优先）', () => {
    const pinned = mkSession({ id: 'p', pinned: true, updatedAt: T(10) });
    const plain = mkSession({ id: 'n', updatedAt: T(59) });
    // 即便非置顶 updatedAt 更新，也排在置顶之后
    expect(compareSessionsForList(pinned, plain)).toBeLessThan(0);
    expect(compareSessionsForList(plain, pinned)).toBeGreaterThan(0);
  });

  it('同组内按 updatedAt 倒序（最新在上）', () => {
    const newer = mkSession({ id: 'a', updatedAt: T(30) });
    const older = mkSession({ id: 'b', updatedAt: T(10) });
    expect(compareSessionsForList(newer, older)).toBeLessThan(0);
    expect(compareSessionsForList(older, newer)).toBeGreaterThan(0);
  });

  it('pinned 用 === true 判（undefined / false 都归非置顶组）', () => {
    const pinned = mkSession({ id: 'p', pinned: true, updatedAt: T(10) });
    const undef = mkSession({ id: 'u', updatedAt: T(59) });
    const falsy = mkSession({ id: 'f', pinned: false, updatedAt: T(58) });
    expect(compareSessionsForList(pinned, undef)).toBeLessThan(0);
    expect(compareSessionsForList(pinned, falsy)).toBeLessThan(0);
    // undefined 与 false 同组 → 组内按 updatedAt desc
    expect(compareSessionsForList(undef, falsy)).toBeLessThan(0);
  });

  it('同 pinned 同 updatedAt → 稳定排序保插入序（Array.sort stable）', () => {
    const a = mkSession({ id: 'a', updatedAt: T(10) });
    const b = mkSession({ id: 'b', updatedAt: T(10) });
    const c = mkSession({ id: 'c', updatedAt: T(10) });
    const sorted = [c, a, b].sort(compareSessionsForList);
    expect(sorted.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('chat-slice setSessions — 写入前统一重排（v0.0.231）', () => {
  it('乱序入 → 归位：置顶组在前 + 组内 updatedAt desc（P-A 排序不变量）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'old', updatedAt: T(5) }),
      mkSession({ id: 'pin-b', pinned: true, updatedAt: T(20) }),
      mkSession({ id: 'new', updatedAt: T(50) }),
      mkSession({ id: 'pin-a', pinned: true, updatedAt: T(40) }),
    ]);
    // 置顶组：pin-a(40) > pin-b(20)；非置顶组：new(50) > old(5)
    expect(store.getState().sessions.map((s) => s.id)).toEqual([
      'pin-a', 'pin-b', 'new', 'old',
    ]);
  });

  it('不 mutate 入参数组（spread 后 sort）', () => {
    const store = createChatSliceStore();
    const input = [
      mkSession({ id: 'old', updatedAt: T(5) }),
      mkSession({ id: 'new', updatedAt: T(50) }),
    ];
    store.getState().setSessions(input);
    // 入参顺序不被改写
    expect(input.map((s) => s.id)).toEqual(['old', 'new']);
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['new', 'old']);
  });
});

describe('chat-slice applySessionMetaEvent — upsert 后归位重排（v0.0.231）', () => {
  it('已存在会话 updatedAt 推进 → 浮到组内顶（P-B 对话浮上）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'a', updatedAt: T(50) }),
      mkSession({ id: 'b', updatedAt: T(30) }),
      mkSession({ id: 'c', updatedAt: T(10) }),
    ]);
    // c 对话后 updatedAt 推到最新 → meta 广播整条替换 → 重排浮顶
    store.getState().applySessionMetaEvent(mkMetaEvt('c', { updatedAt: T(59) }));
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('meta 更新但 updatedAt 不变（如 title 改名）→ 位置不动', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'a', updatedAt: T(50) }),
      mkSession({ id: 'b', updatedAt: T(30) }),
    ]);
    store.getState().applySessionMetaEvent(
      mkMetaEvt('b', { title: 'B-renamed', updatedAt: T(30) }),
    );
    const s = store.getState().sessions;
    expect(s.map((it) => it.id)).toEqual(['a', 'b']);
    expect(s[1]!.title).toBe('B-renamed');
  });

  it('新会话（无 pinned，updatedAt 最新）插入 → 非置顶组顶、不抢置顶组（P-A 新建在顶）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'pin-1', pinned: true, updatedAt: T(10) }),
      mkSession({ id: 'old', updatedAt: T(20) }),
    ]);
    store.getState().applySessionMetaEvent(
      mkMetaEvt('fresh', { title: 'New', updatedAt: T(59) }),
    );
    expect(store.getState().sessions.map((s) => s.id)).toEqual([
      'pin-1', 'fresh', 'old',
    ]);
  });

  it('置顶会话 meta 更新（updatedAt 推进）→ 置顶组内浮顶，不跌出置顶组（UC-231-5）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'pin-a', pinned: true, updatedAt: T(40) }),
      mkSession({ id: 'pin-b', pinned: true, updatedAt: T(20) }),
      mkSession({ id: 'plain', updatedAt: T(50) }),
    ]);
    store.getState().applySessionMetaEvent(
      mkMetaEvt('pin-b', { pinned: true, updatedAt: T(59) }),
    );
    expect(store.getState().sessions.map((s) => s.id)).toEqual([
      'pin-b', 'pin-a', 'plain',
    ]);
  });

  it('biz 守卫不回归：studio/academy 拒纳，列表保持原序', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'a', updatedAt: T(50) }),
      mkSession({ id: 'b', updatedAt: T(30) }),
    ]);
    store.getState().applySessionMetaEvent(
      mkMetaEvt('studio-sess', { biz: 'studio', updatedAt: T(59) }),
    );
    store.getState().applySessionMetaEvent(
      mkMetaEvt('academy-sess', { biz: 'academy', updatedAt: T(58) }),
    );
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
