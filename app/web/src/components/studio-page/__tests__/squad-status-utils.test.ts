/**
 * squad-status-utils 单测 —— v0.0.268 Squad 成员状态入口派生纯函数 + ChatNode helper
 * 参考: specs/tech/version_logs/v0.0.268/change_plan.md（决策① DRY + 决策③ badge 口径）
 *       specs/ui/components/studio-page/component-squad-status-entry.md
 *
 * 覆盖：
 *   - deriveRunningCount：running/interrupting 计 / suspended 不计 / benched 不计 / 含 leader / 无成员 0
 *   - derivePanelRows：running/idle 分区 / benched 过滤 / statusTextSource currentWork 优先 / presence 派生
 *   - buildMemberChatNode：leader tag / mate tag / 不存在 null / 与 SeatsPanel 组装逐字节一致
 */
import { describe, it, expect, vi } from 'vitest';
import { mkMember, mkDetail } from './_fixtures';
import type { SessionState } from '../../chat-page/types';
import {
  buildMemberChatNode,
  derivePanelRows,
  deriveRunningCount,
} from '../squad-status-utils';

/** i18n t mock（tag 派生用；断言只验证调用键 + 插值参数） */
const tMock = vi.fn((key: string, opts?: { name?: string }) => {
  if (key === 'studio:squadTree.tagLeader') return `tagLeader:${opts?.name}`;
  if (key === 'studio:squadTree.tagSingle') return `tagSingle:${opts?.name}`;
  return key;
});

describe('deriveRunningCount — running badge 计数（决策③ 口径）', () => {
  it('无成员 → 0', () => {
    const detail = mkDetail({ members: [] });
    expect(deriveRunningCount(detail, {})).toBe(0);
  });

  it('running/interrupting 计（含 leader）', () => {
    const detail = mkDetail({
      members: [
        mkMember({ id: 'leader1', role: 'leader', sessionId: 'sess-l', state: 'deployed' }),
        mkMember({ id: 'm1', sessionId: 'sess-1', state: 'deployed' }),
        mkMember({ id: 'm2', sessionId: 'sess-2', state: 'deployed' }),
      ],
    });
    const stateMap: Record<string, SessionState> = {
      'sess-l': 'running',
      'sess-1': 'interrupting',
      'sess-2': 'idle',
    };
    expect(deriveRunningCount(detail, stateMap)).toBe(2);
  });

  it('suspended 不计（INV-2：loop 已退出等用户回填）', () => {
    const detail = mkDetail({
      members: [mkMember({ id: 'm1', sessionId: 'sess-1', state: 'deployed' })],
    });
    expect(deriveRunningCount(detail, { 'sess-1': 'suspended' as SessionState })).toBe(0);
  });

  it('benched 不计（active 视图口径）', () => {
    const detail = mkDetail({
      members: [
        mkMember({ id: 'm1', sessionId: 'sess-1', state: 'deployed' }),
        mkMember({ id: 'm2', sessionId: 'sess-2', state: 'benched' }),
      ],
    });
    const stateMap: Record<string, SessionState> = { 'sess-1': 'running', 'sess-2': 'running' };
    expect(deriveRunningCount(detail, stateMap)).toBe(1);
  });

  it('stateMap 无该 sid（undefined）→ 不计', () => {
    const detail = mkDetail({
      members: [mkMember({ id: 'm1', sessionId: 'sess-1', state: 'deployed' })],
    });
    expect(deriveRunningCount(detail, {})).toBe(0);
  });
});

describe('derivePanelRows — 面板 running/idle 分区（决策④ 口径）', () => {
  it('running 上 / idle 下分区；suspended 归 idle', () => {
    const detail = mkDetail({
      members: [
        mkMember({ id: 'leader1', role: 'leader', sessionId: 'sess-l', state: 'deployed' }),
        mkMember({ id: 'm1', sessionId: 'sess-1', state: 'deployed' }),
        mkMember({ id: 'm2', sessionId: 'sess-2', state: 'deployed' }),
      ],
    });
    const stateMap: Record<string, SessionState> = {
      'sess-l': 'running',
      'sess-1': 'suspended',
      'sess-2': 'idle',
    };
    const rows = derivePanelRows(detail, stateMap);
    expect(rows.running.map((r) => r.member.id)).toEqual(['leader1']);
    expect(rows.idle.map((r) => r.member.id)).toEqual(['m1', 'm2']);
  });

  it('benched 归第三分区（不再过滤；running/idle 不含）', () => {
    const detail = mkDetail({
      members: [
        mkMember({ id: 'm1', sessionId: 'sess-1', state: 'deployed' }),
        mkMember({ id: 'm2', sessionId: 'sess-2', state: 'benched' }),
      ],
    });
    const rows = derivePanelRows(detail, { 'sess-1': 'running' as SessionState, 'sess-2': 'running' as SessionState });
    expect(rows.running.map((r) => r.member.id)).toEqual(['m1']);
    expect(rows.idle).toEqual([]);
    expect(rows.benched.map((r) => r.member.id)).toEqual(['m2']);
  });

  it('无成员 → 三区全空', () => {
    const detail = mkDetail({ members: [] });
    const rows = derivePanelRows(detail, {});
    expect(rows.running).toEqual([]);
    expect(rows.idle).toEqual([]);
    expect(rows.benched).toEqual([]);
  });

  it('行含 isLeader + presence + statusTextSource（currentWork 优先 / 空 fallback）', () => {
    const detail = mkDetail({
      members: [
        mkMember({ id: 'leader1', role: 'leader', sessionId: 'sess-l', state: 'deployed', currentWork: { text: '写 PRD', updatedAt: '' } }),
        mkMember({ id: 'm1', sessionId: 'sess-1', state: 'deployed', currentWork: null }),
      ],
    });
    const rows = derivePanelRows(detail, { 'sess-l': 'running' as SessionState });
    const leader = rows.running[0]!;
    expect(leader.isLeader).toBe(true);
    expect(leader.presence).toBe('busy'); // running → busy
    expect(leader.statusTextSource).toEqual({ kind: 'currentWork', text: '写 PRD' });
    const idleMate = rows.idle[0]!;
    expect(idleMate.isLeader).toBe(false);
    expect(idleMate.presence).toBe('online'); // 无 session state + deployed → online
    expect(idleMate.statusTextSource).toEqual({ kind: 'fallback' });
  });

  it('纯函数：不改输入（detail.members 原数组引用不变）', () => {
    const detail = mkDetail();
    const membersBefore = detail.members;
    derivePanelRows(detail, {});
    expect(detail.members).toBe(membersBefore);
  });
});

describe('buildMemberChatNode — ChatNode 公共组装（与 SeatsPanel 同源）', () => {
  it('leader → tagLeader（插 squad 名）', () => {
    const detail = mkDetail();
    const node = buildMemberChatNode(detail, 'leader1', tMock as never);
    expect(node).toEqual({
      sessionId: 'sess-leader',
      title: 'Rocky',
      tag: 'tagLeader:Alpha 小队',
      squadId: 's1',
    });
  });

  it('mate → tagSingle', () => {
    const detail = mkDetail();
    const node = buildMemberChatNode(detail, 'm2', tMock as never);
    expect(node).toEqual({
      sessionId: 'sess-m2',
      title: '张三',
      tag: 'tagSingle:Alpha 小队',
      squadId: 's1',
    });
  });

  it('member 不存在 → null', () => {
    const detail = mkDetail();
    expect(buildMemberChatNode(detail, 'ghost', tMock as never)).toBeNull();
  });

  it('与 SeatsPanel 旧组装行为一致（leader 用 tagLeader / mate 用 tagSingle / squadId 同 detail.id）', () => {
    // 回归：SeatsPanel 旧实现 L87-99 的逐字节等价（tag 键 + 插值 + sessionId/title/squadId）
    const detail = mkDetail();
    const leader = buildMemberChatNode(detail, 'leader1', tMock as never)!;
    expect(tMock).toHaveBeenCalledWith('studio:squadTree.tagLeader', { name: 'Alpha 小队' });
    expect(leader.sessionId).toBe('sess-leader');
    expect(leader.squadId).toBe('s1');
    const mate = buildMemberChatNode(detail, 'm2', tMock as never)!;
    expect(tMock).toHaveBeenCalledWith('studio:squadTree.tagSingle', { name: 'Alpha 小队' });
    expect(mate.sessionId).toBe('sess-m2');
  });
});
