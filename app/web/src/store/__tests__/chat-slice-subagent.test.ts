/**
 * chat-slice subagent tree reducer 单测（v0.0.28）
 * 参考: specs/ui/components/chat-page/_overview.md §5 交互8（subagent 展开 + session_meta 挂 parent tree）
 *       specs/api/overall/10-multi-agent.md §2.2（subagent 与 parent 混同一列表，前端据 derivation 过滤顶层）+ §3（GET /children）
 *       specs/tech/app/frontend/[P0]sse_channel.md §10.5（session_meta 广播 reducer 整条替换）
 *
 * 覆盖 acceptanceCriteria（reducer 部分）：
 *   - setChildren 写入 childrenByParent（parent → ChildrenView）
 *   - setActiveSubId 设置当前选中 subagent
 *   - applySessionMetaEvent 整条替换：subagent session meta 到达 → sessions[] 含该 session
 *     （顶层过滤由 page-chat topSessions 负责，reducer 不做过滤——仅保证数据入列表）
 *   - subagent 状态变更（running→terminated）：reducer 整条替换后 sessions[] 反映新 state
 *     （parent children 分组刷新由 page-chat refreshChildren 重新 GET /children 触发 setChildren）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createChatSliceStore, type SessionMetaUpdateEvent } from '../chat-slice';
import type { ChildrenView, Session } from '../../components/chat-page/types';

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'parent-1',
    title: '父会话',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function mkChildren(overrides: Partial<ChildrenView> = {}): ChildrenView {
  return {
    parentSessionId: 'parent-1',
    running: [{ sessionId: 'r1', name: 'explorer', state: 'running', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T00:00:00.000Z' }],
    terminated: [],
    ...overrides,
  };
}

function mkMetaEvt(session: Session): SessionMetaUpdateEvent {
  return {
    id: 'evt-' + session.id,
    type: 'session_meta_update',
    sessionId: session.id,
    createdAt: session.updatedAt,
    data: session,
  };
}

let store: ReturnType<typeof createChatSliceStore>;
beforeEach(() => {
  store = createChatSliceStore();
});

describe('chat-slice subagent tree state（v0.0.28）', () => {
  it('setChildren 写入 childrenByParent[parentSid]', () => {
    const children = mkChildren({ parentSessionId: 'p1' });
    store.getState().setChildren('p1', children);
    expect(store.getState().childrenByParent['p1']).toEqual(children);
  });

  it('setChildren 覆盖更新（running→terminated 刷新）', () => {
    store.getState().setChildren('p1', mkChildren({
      parentSessionId: 'p1',
      running: [{ sessionId: 'r1', name: 'explorer', state: 'running', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T01:00:00.000Z' }],
      terminated: [],
    }));
    // 模拟 child r1 完成转 terminated（page-chat refreshChildren 重新 GET /children）
    store.getState().setChildren('p1', {
      parentSessionId: 'p1',
      running: [],
      terminated: [{ sessionId: 'r1', name: 'explorer', state: 'idle', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T02:00:00.000Z' }],
    });
    const view = store.getState().childrenByParent['p1']!;
    expect(view.running).toHaveLength(0);
    expect(view.terminated).toHaveLength(1);
    expect(view.terminated[0]!.state).toBe('idle');
  });

  it('setActiveSubId 设置/清除 active subagent', () => {
    store.getState().setActiveSubId('r1');
    expect(store.getState().activeSubId).toBe('r1');
    store.getState().setActiveSubId(null);
    expect(store.getState().activeSubId).toBeNull();
  });
});

describe('chat-slice applySessionMetaEvent subagent 整条替换', () => {
  it('subagent meta 到达 → sessions[] 含该 subagent（整条替换语义）', () => {
    store.getState().setSessions([mkSession({ id: 'p1' })]);
    const subagent = mkSession({
      id: 'r1',
      title: 'explorer',
      role: 'rocky',
      derivation: 'subagent',
      parentSessionId: 'p1',
      // [v0.0.56 hotfix] scope 字段已删除（derivation='subagent' 已表达同维信息）
      subAgentTemplateType: 'explorer',
    });
    store.getState().applySessionMetaEvent(mkMetaEvt(subagent));
    const sessions = store.getState().sessions;
    // subagent 进入 sessions[]（顶层过滤由 page-chat 负责，reducer 不过滤）
    expect(sessions.some((s) => s.id === 'r1' && s.derivation === 'subagent')).toBe(true);
  });

  it('subagent 状态变更（running→idle）→ 整条替换 sessions[] 反映新 state', () => {
    const subagent = mkSession({
      id: 'r1',
      title: 'explorer',
      role: 'rocky',
      derivation: 'subagent',
      parentSessionId: 'p1',
      state: 'running',
      running: true,
    });
    store.getState().setSessions([mkSession({ id: 'p1' }), subagent]);
    // 后续收到 idle meta（整条替换）
    store.getState().applySessionMetaEvent(
      mkMetaEvt({ ...subagent, state: 'idle', running: false, updatedAt: '2026-06-28T03:00:00.000Z' }),
    );
    const updated = store.getState().sessions.find((s) => s.id === 'r1');
    expect(updated?.state).toBe('idle');
    expect(updated?.running).toBe(false);
  });

  it('parent + subagent 混同一 sessions[]（前端据 derivation 过滤顶层）', () => {
    store.getState().setSessions([
      mkSession({ id: 'p1' }),
      mkSession({ id: 'r1', role: 'rocky', derivation: 'subagent', parentSessionId: 'p1' }),
    ]);
    const all = store.getState().sessions;
    // 顶层视图 = filter derivation !== 'subagent'（page-chat topSessions）
    const topSessions = all.filter((s) => s.derivation !== 'subagent');
    expect(topSessions).toHaveLength(1);
    expect(topSessions[0]!.id).toBe('p1');
    // subagent 仍在 sessions[]（reducer 保留，不删除）
    expect(all.some((s) => s.id === 'r1')).toBe(true);
  });
});
