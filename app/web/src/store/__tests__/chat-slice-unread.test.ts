// @vitest-environment node
/**
 * chat-slice 未读红点单测（v0.0.27）
 * 参考: specs/ui/components/chat-page/_overview.md §5 交互7（产生/消除）/ §4.2（unread prop）
 *       specs/api/overall/04-agent-session.md §2.3.1（POST /read 响应 session.unread=false）
 *       specs/tech/agent/session/[P0]session_event.md §2（session_read_update event）
 *
 * 覆盖 acceptanceCriteria：
 *   - setSessionUnread action 更新单 session unread
 *   - applySessionEvent(session_read_update) → sessions[sid].unread=false（红点实时消失）
 *   - session_read_update 仅更新对应 session，不动其他 session
 */
import { describe, it, expect } from 'vitest';
import { createChatSliceStore } from '../chat-slice';
import type { Session } from '../../components/chat-page/types';

/** 构造 Session（v0.0.27 含 unread 字段） */
function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-a',
    title: 'A',
    status: 'active',
    unread: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('chat-slice setSessionUnread action（v0.0.27）', () => {
  it('setSessionUnread(sid, false) 把对应 session 的 unread 置 false', () => {
    const store = createChatSliceStore();
    store.getState().setSessions([
      mkSession({ id: 'a', unread: true }),
      mkSession({ id: 'b', unread: true }),
    ]);
    store.getState().setSessionUnread('a', false);
    const s = store.getState().sessions;
    expect(s.find((it) => it.id === 'a')!.unread).toBe(false);
    // 其他 session 不动
    expect(s.find((it) => it.id === 'b')!.unread).toBe(true);
  });

  it('setSessionUnread 不存在的 sid → 列表不变（无副作用）', () => {
    const store = createChatSliceStore();
    const before = [mkSession({ id: 'a', unread: true })];
    store.getState().setSessions(before);
    store.getState().setSessionUnread('not-exist', false);
    expect(store.getState().sessions).toHaveLength(1);
    expect(store.getState().sessions[0]!.unread).toBe(true);
  });
});

// [v0.0.39 P2] 原 applySessionEvent(session_read_update) 集成测试已迁至
// use-session-run-state.test.tsx「session_read_update → onSessionRead 回调」——session_read_update 现由
// useSessionRunState 引擎在 session_panel 分流时通过 onSessionRead 回调触发 store.setSessionUnread。
// setSessionUnread action 本身见上 方 describe 覆盖（不变）。
