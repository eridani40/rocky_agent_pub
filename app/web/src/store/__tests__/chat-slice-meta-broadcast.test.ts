// @vitest-environment node
/**
 * chat-slice session_meta 广播 reducer 单测（v0.0.27）
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_channel.md §10.5（列表订阅契约：subscribe (session_meta, _all) 一次）
 *   - specs/tech/agent/session/[P0]session_event.md §3a.3（SessionMetaView 字段 + 整条替换语义）
 *   - specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md §3（全量 payload，reducer 无 merge）
 *
 * 覆盖 acceptanceCriteria 第 5 条：
 *   - applySessionMetaEvent(session_meta_update) → 按 data.id 整条替换 sessions[]
 *   - 不存在则插入（spec §3a.3 整条替换语义）
 *   - 任意字段变更（unread / running / title / state）都整条替换（无需 merge 中间态）
 *   - 不影响其他 session
 */
import { describe, it, expect } from 'vitest';
import { createChatSliceStore, type SessionMetaUpdateEvent } from '../chat-slice';
import type { Session } from '../../components/chat-page/types';

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-a',
    title: 'A',
    status: 'active',
    state: 'idle',
    running: false,
    currentRunId: null,
    workspaceDir: '/tmp/ws',
    unread: false,
    summaryTask: { status: 'idle', runId: null, startedAt: null, error: null },
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
    createdAt: '2026-06-27T10:00:00.000Z',
    data: mkSession({ id: sid, ...data }),
  };
}

describe('chat-slice applySessionMetaEvent — session_meta 广播 reducer（v0.0.27）', () => {
  it('按 data.id 整条替换 sessions[]（spec §3a.3 整条替换语义）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'a', unread: false, running: false, title: 'A-old' }),
      mkSession({ id: 'b', unread: false }),
    ]);

    // 收到 a 的 meta 广播：unread=true + title 变了 + running 变了（全量 payload）
    store.getState().applySessionMetaEvent(
      mkMetaEvt('a', { unread: true, running: true, title: 'A-new', state: 'running' }),
    );

    const s = store.getState().sessions;
    expect(s).toHaveLength(2);
    const a = s.find((it) => it.id === 'a')!;
    expect(a.unread).toBe(true);
    expect(a.running).toBe(true);
    expect(a.title).toBe('A-new');
    expect(a.state).toBe('running');
    // b 不变
    expect(s.find((it) => it.id === 'b')!.title).toBe('A');
  });

  it('session 不存在则插入到列表头（spec §3a.3 整条替换，不存在 → 新建）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'existing' })]);

    store.getState().applySessionMetaEvent(
      mkMetaEvt('new-sid', { title: 'New session' }),
    );

    const s = store.getState().sessions;
    expect(s).toHaveLength(2);
    // 新 session 插到列表头
    expect(s[0]!.id).toBe('new-sid');
    expect(s[0]!.title).toBe('New session');
  });

  it('unread 变更（产生未读）触发整条替换：红点实时出现', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'a', unread: false })]);

    store.getState().applySessionMetaEvent(mkMetaEvt('a', { unread: true }));

    expect(store.getState().sessions[0]!.unread).toBe(true);
  });

  it('running 变更触发整条替换：运行态实时刷新', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'a', running: false, state: 'idle' })]);

    store.getState().applySessionMetaEvent(
      mkMetaEvt('a', { running: true, state: 'running', currentRunId: 'run-1' }),
    );

    const a = store.getState().sessions[0]!;
    expect(a.running).toBe(true);
    expect(a.state).toBe('running');
    expect(a.currentRunId).toBe('run-1');
  });

  it('多个 session 的 meta 广播都正确替换（broadcast 模型，所有 session 共享 _all 流）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'a', unread: false }),
      mkSession({ id: 'b', unread: false }),
      mkSession({ id: 'c', unread: false }),
    ]);

    store.getState().applySessionMetaEvent(mkMetaEvt('a', { unread: true }));
    store.getState().applySessionMetaEvent(mkMetaEvt('c', { unread: true }));

    const s = store.getState().sessions;
    expect(s.find((it) => it.id === 'a')!.unread).toBe(true);
    expect(s.find((it) => it.id === 'b')!.unread).toBe(false); // 未变化
    expect(s.find((it) => it.id === 'c')!.unread).toBe(true);
  });

  it('summaryTask 变更（compact 进度）触发整条替换', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'a' })]);

    store.getState().applySessionMetaEvent(
      mkMetaEvt('a', { summaryTask: { status: 'running', runId: 'r1', startedAt: '2026-06-27T00:00:00.000Z', error: null } }),
    );

    const a = store.getState().sessions[0]!;
    expect(a.summaryTask).toBeDefined();
    expect(a.summaryTask!.status).toBe('running');
    expect(a.summaryTask!.runId).toBe('r1');
  });
});

/**
 * [v0.0.39 P1] playground 列表隔离守卫：applySessionMetaEvent 拒纳 biz:'studio' 的广播。
 * 根因：session_meta 是 `_all` 共享广播，studio session 一 running 就广播带 biz:'studio' 的 meta，
 * 旧 reducer 无条件 upsert → 泄漏进 playground 列表（useChatStore 是 playground 专属 store）。
 * 修复：reducer 顶部守卫 incoming.biz==='studio' 直接 return（缺省/undefined/playground 正常纳入）。
 * [v0.0.56] 字段名 bizType→biz。
 * 参考: specs/tech/agent/session/[P0]session_biztype.md（biz 二分 + 隔离规则）。
 */
describe('chat-slice applySessionMetaEvent — biz 隔离守卫（v0.0.39 P1）', () => {
  it('收到 biz:studio 的新 session → sessions 不变（不插入，泄漏隔离）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'pg-1' })]);

    // studio session running → 广播带 biz:'studio'
    store.getState().applySessionMetaEvent(
      mkMetaEvt('studio-sess', { biz: 'studio', running: true, state: 'running' }),
    );

    const s = store.getState().sessions;
    // 列表保持原样：studio 会话被守卫拒纳，未插入
    expect(s).toHaveLength(1);
    expect(s[0]!.id).toBe('pg-1');
    expect(s.some((it) => it.id === 'studio-sess')).toBe(false);
  });

  it('收到 biz:studio 的已存在 session meta → 不更新（即便误入也不被 studio meta 篡改）', () => {
    const store = createChatSliceStore();
    // 预置一条 id 与 studio 广播相同的 playground 会话（极端兜底场景）
    store.getState().setSessions([mkSession({ id: 'x', title: 'PG-title', running: false })]);

    store.getState().applySessionMetaEvent(
      mkMetaEvt('x', { biz: 'studio', title: 'STUDIO-title', running: true }),
    );

    const x = store.getState().sessions.find((it) => it.id === 'x')!;
    // 守卫拦截：studio 广播不改 playground 列表里的同 id 项
    expect(x.title).toBe('PG-title');
    expect(x.running).toBe(false);
  });

  it('收到 playground 会话（无 biz）→ 正常插入', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'pg-1' })]);

    // 缺省不带 biz（视为 playground）
    store.getState().applySessionMetaEvent(mkMetaEvt('pg-2', { title: 'New PG' }));

    const s = store.getState().sessions;
    expect(s).toHaveLength(2);
    expect(s[0]!.id).toBe('pg-2'); // 插入列表头
    expect(s[0]!.biz).toBeUndefined();
  });

  it('收到 biz:playground 的会话 → 正常插入（显式 playground 不被守卫拦）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'pg-1' })]);

    store.getState().applySessionMetaEvent(
      mkMetaEvt('pg-2', { biz: 'playground', title: 'Explicit PG' }),
    );

    const s = store.getState().sessions;
    expect(s).toHaveLength(2);
    expect(s.find((it) => it.id === 'pg-2')!.biz).toBe('playground');
  });

  it('已存在的 playground 会话 meta 更新 → 整条替换仍生效（守卫不误伤 playground 更新）', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([mkSession({ id: 'pg-1', title: 'old', running: false })]);

    store.getState().applySessionMetaEvent(
      mkMetaEvt('pg-1', { biz: 'playground', title: 'new', running: true, state: 'running' }),
    );

    const a = store.getState().sessions[0]!;
    expect(a.title).toBe('new');
    expect(a.running).toBe(true);
    expect(a.state).toBe('running');
  });
});

/**
 * [v0.0.231] pinned 广播触发归位重排（统一排序契约 _overview.md §4.1）：
 * meta 广播 pinned false→true → 该会话进置顶组（列表位置变化，其余相对顺序不动）。
 */
describe('chat-slice applySessionMetaEvent — pinned 广播归位（v0.0.231）', () => {
  it('pinned false→true → 进置顶组顶部；其余非置顶项相对顺序不动', () => {
    const store = createChatSliceStore();
    const T = (m: number) => `2026-08-01T00:${String(m).padStart(2, '0')}:00.000Z`;
    store.getState().setSessions([
      mkSession({ id: 'a', updatedAt: T(50) }),
      mkSession({ id: 'b', updatedAt: T(30) }),
      mkSession({ id: 'c', updatedAt: T(10) }),
    ]);

    // c 被置顶（pinned-only 更新不刷 updatedAt，用户裁决 2026-08-01）
    store.getState().applySessionMetaEvent(
      mkMetaEvt('c', { pinned: true, updatedAt: T(10) }),
    );

    const s = store.getState().sessions;
    expect(s.map((it) => it.id)).toEqual(['c', 'a', 'b']);
    expect(s[0]!.pinned).toBe(true);
  });

  it('pinned true→false → 回非置顶组按原 updatedAt 归位（可能不在顶部）', () => {
    const store = createChatSliceStore();
    const T = (m: number) => `2026-08-01T00:${String(m).padStart(2, '0')}:00.000Z`;
    store.getState().setSessions([
      mkSession({ id: 'pin-x', pinned: true, updatedAt: T(40) }),
      mkSession({ id: 'a', updatedAt: T(50) }),
      mkSession({ id: 'b', updatedAt: T(30) }),
    ]);

    // 取消置顶：pinned-only 更新不刷 updatedAt → 按原 T(40) 落非置顶组 a/b 之间
    store.getState().applySessionMetaEvent(
      mkMetaEvt('pin-x', { pinned: false, updatedAt: T(40) }),
    );

    const s = store.getState().sessions;
    expect(s.map((it) => it.id)).toEqual(['a', 'pin-x', 'b']);
    expect(s[1]!.pinned).toBe(false);
  });
});
