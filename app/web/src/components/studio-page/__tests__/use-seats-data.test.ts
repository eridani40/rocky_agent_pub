/**
 * @vitest-environment jsdom
 * use-seats-data 单测 —— T5 坐席派生数据 hook（v0.0.165）
 * 参考: specs/tech/version_logs/v0.0.165/change_plan.md §8
 *       specs/prd/version_logs/v0.0.165.ui_upgrade/change_log.md §6.4
 *
 * 覆盖：
 *   - derivePresence 派生矩阵（stateMap busy 覆盖 / member benched / else online / 无 idle）
 *   - deriveViewRows 视图过滤（v0.0.244：active 只留 deployed / all 全量 / 纯函数不改输入）
 *   - deriveInProgressCount 统计（squad chat + members，含 running/interrupting/suspended）
 *   - deriveStatusTextSource（currentWork 优先 / 空 trim / 空对象走 fallback）
 *   - useSeatsData 集成派生 seats/stats + leader 置顶 + null 降级
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { mkMember, mkDetail } from './_fixtures';
import type { SessionState } from '../../chat-page/types';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）——bun+jsdom 全量并发下相对路径静默失效
// 与本仓库其他 hook 测试（如 use-chat-chrome / use-usage）同惯例。
const { squadApiPath, getBudgetUsageMock } = vi.hoisted(() => ({
  squadApiPath: require('node:path').resolve(__dirname, '../../../lib/squad-api.ts'),
  getBudgetUsageMock: vi.fn(),
}));

vi.mock(squadApiPath, () => ({
  getBudgetUsage: (...args: Parameters<typeof getBudgetUsageMock>) => getBudgetUsageMock(...args),
}));

// mock 生效后再 import 被测 hook（vi.mock 会 hoist 到 import 之前，此顺序仅示意）
import {
  derivePresence,
  deriveInProgressCount,
  deriveStatusTextSource,
  deriveViewRows,
  isRunningState,
  useSeatsData,
  type SeatRow,
} from '../use-seats-data';
import type { Member } from '../squad-types';

beforeEach(() => {
  // 每 case 重置为默认返回值（budget 有值）；单测想覆盖用 mockResolvedValueOnce/mockRejectedValueOnce
  getBudgetUsageMock.mockReset();
  getBudgetUsageMock.mockResolvedValue({
    squadId: 's1',
    limit: 100000,
    window: 'daily',
    consumed: 23400,
    remaining: 76600,
    windowStart: '',
    windowEnd: '',
    perSession: [],
    timezone: 'UTC',
  });
});
afterEach(() => vi.restoreAllMocks());

describe('derivePresence — 三态派生（无 idle）', () => {
  const member = mkMember({ sessionId: 'sess-1', state: 'deployed' });

  it('sessionState running → busy（覆盖 deployed）', () => {
    expect(derivePresence(member, 'running' as SessionState)).toBe('busy');
  });
  it('sessionState interrupting → busy', () => {
    expect(derivePresence(member, 'interrupting' as SessionState)).toBe('busy');
  });
  it('sessionState suspended → busy（loop 已退出等用户，UI 仍标忙）', () => {
    expect(derivePresence(member, 'suspended' as SessionState)).toBe('busy');
  });
  it('sessionState idle + member deployed → online', () => {
    expect(derivePresence(member, 'idle' as SessionState)).toBe('online');
  });
  it('sessionState undefined + member deployed → online（缺省态）', () => {
    expect(derivePresence(member, undefined)).toBe('online');
  });
  it('member benched → offline（无 session state）', () => {
    const benched = mkMember({ state: 'benched' });
    expect(derivePresence(benched, undefined)).toBe('offline');
  });
  it('member benched + sessionState running → busy（session state 优先，因为可能是 pending kill 中）', () => {
    // 边界：benched 期间理论无 running，但 stateMap 陈旧时 busy 优先反映最近可见状态
    const benched = mkMember({ state: 'benched' });
    expect(derivePresence(benched, 'running' as SessionState)).toBe('busy');
  });
  it('member interrupted state（非 running 系）→ 走 member.state 分支', () => {
    expect(derivePresence(member, 'interrupted' as SessionState)).toBe('online');
    expect(derivePresence(member, 'error' as SessionState)).toBe('online');
  });
});

describe('deriveViewRows — 视图过滤（v0.0.244：active=在岗 / all=全部）', () => {
  /** 构造最小 SeatRow（本 describe 只关心 member.state，其余字段占位） */
  const mkRow = (m: Member): SeatRow => ({
    member: m,
    isLeader: m.role === 'leader',
    presence: 'online',
    isRunning: false,
    statusTextSource: { kind: 'fallback' },
  });
  const deployedRow = mkRow(mkMember({ id: 'm1', state: 'deployed' }));
  const benchedRow = mkRow(mkMember({ id: 'm2', state: 'benched' }));
  const deployedRow2 = mkRow(mkMember({ id: 'm3', state: 'deployed' }));
  const rows = [deployedRow, benchedRow, deployedRow2];

  it('active → 只留 deployed 行（benched 过滤，顺序保持）', () => {
    const out = deriveViewRows(rows, 'active');
    expect(out.map((r) => r.member.id)).toEqual(['m1', 'm3']);
  });

  it('all → 全量返回（含 benched）', () => {
    const out = deriveViewRows(rows, 'all');
    expect(out.map((r) => r.member.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('纯函数：不改输入；all 也返回新数组（非同一引用）', () => {
    const before = rows.map((r) => r.member.id);
    const outAll = deriveViewRows(rows, 'all');
    const outActive = deriveViewRows(rows, 'active');
    expect(rows.map((r) => r.member.id)).toEqual(before); // 输入未变
    expect(outAll).not.toBe(rows); // all 分支也返新数组
    expect(outActive).not.toBe(rows);
  });

  it('active 下全 deployed → 不过滤任何行（与现状一致）', () => {
    const allDeployed = [deployedRow, deployedRow2];
    expect(deriveViewRows(allDeployed, 'active')).toHaveLength(2);
  });
});

describe('deriveInProgressCount — 遍历 squad sessions 数 busy', () => {
  const m1 = mkMember({ id: 'm1', sessionId: 'sess-m1' });
  const m2 = mkMember({ id: 'm2', sessionId: 'sess-m2' });
  const members = [m1, m2];
  const groupSid = 'sess-group';

  it('空 stateMap → 0', () => {
    expect(deriveInProgressCount(members, groupSid, {})).toBe(0);
  });
  it('两个 running + 一个 group interrupting → 3', () => {
    expect(
      deriveInProgressCount(members, groupSid, {
        'sess-m1': 'running' as SessionState,
        'sess-m2': 'running' as SessionState,
        'sess-group': 'interrupting' as SessionState,
      }),
    ).toBe(3);
  });
  it('idle/error 不计数', () => {
    expect(
      deriveInProgressCount(members, groupSid, {
        'sess-m1': 'idle' as SessionState,
        'sess-m2': 'error' as SessionState,
        'sess-group': 'interrupted' as SessionState,
      }),
    ).toBe(0);
  });
  it('suspended 计数（PRD §6.4「进行中」= running 系含 suspended）', () => {
    expect(
      deriveInProgressCount(members, groupSid, {
        'sess-m1': 'suspended' as SessionState,
      }),
    ).toBe(1);
  });
});

describe('deriveStatusTextSource — currentWork 优先 / 空走 fallback', () => {
  it('有 currentWork.text → kind=currentWork', () => {
    const m = mkMember({ currentWork: { text: '推进 KR', updatedAt: '' } });
    expect(deriveStatusTextSource(m)).toEqual({ kind: 'currentWork', text: '推进 KR' });
  });
  it('trim 后空 → fallback', () => {
    const m = mkMember({ currentWork: { text: '   ', updatedAt: '' } });
    expect(deriveStatusTextSource(m)).toEqual({ kind: 'fallback' });
  });
  it('currentWork undefined → fallback', () => {
    const m = mkMember({ currentWork: undefined });
    expect(deriveStatusTextSource(m)).toEqual({ kind: 'fallback' });
  });
  it('currentWork null → fallback', () => {
    const m = mkMember({ currentWork: null });
    expect(deriveStatusTextSource(m)).toEqual({ kind: 'fallback' });
  });
});

describe('isRunningState — running 派生（排除 suspended，INV-2）', () => {
  it('running → true', () => {
    expect(isRunningState('running' as SessionState)).toBe(true);
  });
  it('interrupting → true（用户中断请求中 loop 仍在跑）', () => {
    expect(isRunningState('interrupting' as SessionState)).toBe(true);
  });
  it('suspended → false（loop 已退出等用户回填，INV-2）', () => {
    // 区别于 isBusyState（含 suspended）：isRunning deliberately 排除 suspended
    expect(isRunningState('suspended' as SessionState)).toBe(false);
  });
  it('idle → false', () => {
    expect(isRunningState('idle' as SessionState)).toBe(false);
  });
  it('interrupted → false（已停止，非运行中）', () => {
    expect(isRunningState('interrupted' as SessionState)).toBe(false);
  });
  it('error → false', () => {
    expect(isRunningState('error' as SessionState)).toBe(false);
  });
  it('undefined → false（缺省态）', () => {
    expect(isRunningState(undefined)).toBe(false);
  });
});

describe('useSeatsData — 集成派生 seats/stats（leader 置顶 + token）', () => {
  it('seats 同步派生：leader 置顶 + onlineCount 正确', async () => {
    const leader = mkMember({ id: 'leader1', role: 'leader', sessionId: 'sess-leader', state: 'deployed' });
    const mate = mkMember({ id: 'm2', role: 'mate', sessionId: 'sess-m2', state: 'deployed' });
    const detail = mkDetail({ members: [mate, leader], squadChatSessionId: 'sess-group' });
    const stateMap: Record<string, SessionState> = { 'sess-m2': 'running' as SessionState };

    const { result } = renderHook(() => useSeatsData('s1', detail, stateMap));

    // leader 应在第一位（即使传入序是 [mate, leader]）
    expect(result.current.seats[0]?.member.role).toBe('leader');
    expect(result.current.seats[0]?.isLeader).toBe(true);
    expect(result.current.seats[1]?.member.role).toBe('mate');

    // mate presence = busy（stateMap running）
    expect(result.current.seats[1]?.presence).toBe('busy');
    // leader presence = online（stateMap 无该 sid，deployed）
    expect(result.current.seats[0]?.presence).toBe('online');

    // isRunning 派生：mate running → true；leader 无 stateMap 项 → false
    expect(result.current.seats[1]?.isRunning).toBe(true);
    expect(result.current.seats[0]?.isRunning).toBe(false);

    // stats
    expect(result.current.stats.onlineCount).toBe(2);
    expect(result.current.stats.totalCount).toBe(2);
    expect(result.current.stats.inProgressCount).toBe(1); // sess-m2 running
    expect(result.current.stats.todayMsgCount).toBeNull(); // PRD §6.4 恒 null
  });

  it('isRunning 排除 suspended（区别于 isBusyState）：suspended 时 presence=busy 但 isRunning=false', async () => {
    const m = mkMember({ id: 'm-sus', role: 'mate', sessionId: 'sess-sus', state: 'deployed' });
    const detail = mkDetail({ members: [m], squadChatSessionId: 'sess-group' });
    const stateMap: Record<string, SessionState> = { 'sess-sus': 'suspended' as SessionState };
    const { result } = renderHook(() => useSeatsData('s1', detail, stateMap));
    // presence = busy（isBusyState 含 suspended）；但 isRunning = false（INV-2）
    expect(result.current.seats[0]?.presence).toBe('busy');
    expect(result.current.seats[0]?.isRunning).toBe(false);
    // inProgressCount 仍算 suspended（isBusyState）
    expect(result.current.stats.inProgressCount).toBe(1);
  });

  it('budget usage 返回后 tokenUsed 反映 consumed', async () => {
    const detail = mkDetail();
    const { result } = renderHook(() => useSeatsData('s1', detail, {}));
    await waitFor(() => expect(result.current.stats.tokenUsed).toBe(23400), { timeout: 3000 });
  });

  it('detail=null → seats 空 + stats 全零/null', () => {
    const { result } = renderHook(() => useSeatsData('s1', null, {}));
    expect(result.current.seats).toEqual([]);
    expect(result.current.stats.onlineCount).toBe(0);
    expect(result.current.stats.totalCount).toBe(0);
    expect(result.current.stats.inProgressCount).toBe(0);
    expect(result.current.stats.todayMsgCount).toBeNull();
  });
});

describe('useSeatsData — budget null 降级', () => {
  it('getBudgetUsage limit=-1（未配 budget）→ tokenUsed=null', async () => {
    getBudgetUsageMock.mockResolvedValueOnce({
      squadId: 's1',
      limit: -1,
      window: 'daily',
      consumed: 0,
      remaining: -1,
      windowStart: '',
      windowEnd: '',
      perSession: [],
      timezone: 'UTC',
    });
    const detail = mkDetail();
    const { result } = renderHook(() => useSeatsData('s1', detail, {}));
    // 等 sessions 到位后确认 tokenUsed 仍 null（limit=-1 分支）
    await waitFor(() => expect(result.current.seats.length).toBe(2));
    // budget 也应已 resolve；tokenUsed 应为 null（未配 budget 语义）
    await waitFor(() => expect(result.current.stats.tokenUsed).toBeNull());
  });

  it('getBudgetUsage 抛错 → tokenUsed=null（catch 兜底）', async () => {
    getBudgetUsageMock.mockRejectedValueOnce(new Error('network'));
    const detail = mkDetail();
    const { result } = renderHook(() => useSeatsData('s1', detail, {}));
    await waitFor(() => expect(result.current.seats.length).toBe(2));
    // tokenUsed 保持 null（初值 + reject 分支 setTokenUsed null）
    expect(result.current.stats.tokenUsed).toBeNull();
  });
});
