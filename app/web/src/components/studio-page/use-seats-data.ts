/**
 * use-seats-data —— 坐席面板派生数据 hook（v0.0.165 T5，INV-8 后端零改动）
 * 参考: specs/tech/version_logs/v0.0.165/change_plan.md §8（use-seats-data 契约）
 *       specs/prd/version_logs/v0.0.165.ui_upgrade/change_log.md §6.4（字段可得性 + 降级表）
 *
 * 职责：
 *   1. 挂载后拉 budget usage（fire-and-forget，失败降级 tokenUsed=null）
 *   2. 派生 `{seats, stats, onlineCount, inProgressCount, tokenUsed}` 供 SeatsPanel 消费
 *
 * 派生规则：
 *   - presence 三态（无 idle）：stateMap[m.sessionId] ∈ {running,interrupting,suspended} → 'busy'；
 *     m.state==='benched' → 'offline'；else → 'online'
 *   - statusText fallback：m.currentWork.text 优先；空则 i18n `studio:seats.status.{online|busy|offline}`
 *     由 SeatCard 消费方翻译（本 hook 只吐 kind 让 UI 层查 i18n，避免 hook 依赖 t()）
 *   - isRunning（名字后 spinner 用）：stateMap[m.sessionId] ∈ {running,interrupting} → true。
 *     **区别于 isBusyState**：isBusyState 含 suspended（presence='busy' / inProgressCount 都把 suspended
 *     算「进行中」），isRunning **deliberately 排除 suspended**（INV-2：suspended = loop 已退出等用户回填，
 *     亮「?」非 spinner——与 conv-item / studio sidebar 一致）。
 *   - 统计条：onlineCount=members.filter(deployed).length；inProgressCount=遍历 squadSessionIds 数 busy
 *     tokenUsed=budget.consumed（budget=null 或未拉到→null）；今日消息本版恒 null（降级「—」）
 *
 * 边界：
 *   - INV-1 后端零改动：只调 getBudgetUsage()（v0.0.165 原有的 listSessions() 拉取随
 *     2026-07-18 meta 行（最近活跃）删除一并下线——它是 lastActiveIso 唯一消费者，现无消费方）
 *   - 不新增 SSE 订阅；不调其他 mutation API
 *   - 派生纯函数 derivePresence / deriveInProgressCount 单独 export 供 UT 覆盖
 */
import { useMemo, useState, useEffect } from 'react';
import { getBudgetUsage } from '../../lib/squad-api';
import type { SessionState } from '../chat-page/types';
import type { Member, SquadDetail } from './squad-types';

/** presence 三态（无 idle：架构 PRD §6.4 决策） */
export type SeatPresence = 'online' | 'busy' | 'offline';

/** 坐席视图：active=在岗视图（默认，只显 deployed）；all=全部（含 benched）。
 * panel 持 state / body 透传 / SeatsViewSwitch 受控 / UT 共用。 */
export type SeatsView = 'active' | 'all';

/** 单条坐席行派生数据（SeatCard 消费） */
export interface SeatRow {
  member: Member;
  isLeader: boolean;
  presence: SeatPresence;
  /** session 是否 running（running/interrupting；**排除 suspended**，INV-2）。
   * 名字后挂 SpinnerRing 的判定源——区别于 presence='busy'（含 suspended）。 */
  isRunning: boolean;
  /** 状态行文案 kind：`currentWork` = 有 currentWork.text 用它；`fallback` = 用 i18n 兜底 */
  statusTextSource: { kind: 'currentWork'; text: string } | { kind: 'fallback' };
}

/** 统计条派生数据 */
export interface SeatStatsData {
  onlineCount: number;
  totalCount: number;
  inProgressCount: number;
  /** 今日消息：后端无 per-day 聚合 → 本版恒 null */
  todayMsgCount: number | null;
  /** 已用 token：budget=null / 未拉到 → null */
  tokenUsed: number | null;
}

/** hook 暴露态 */
export interface SeatsData {
  seats: SeatRow[];
  stats: SeatStatsData;
}

// ─── 纯函数（UT 覆盖） ─────────────────────────────────────────────────────────

/** session 是否为「进行中」态（busy 覆盖 offline/online 的三种 SSE 态） */
function isBusyState(s: SessionState | undefined): boolean {
  return s === 'running' || s === 'interrupting' || s === 'suspended';
}

/**
 * session 是否 running（名字后 spinner 判定源）。
 * 语义：state∈{running,interrupting}；**suspended 排除**（INV-2：loop 已退出等用户回填，不亮 spinner）。
 * 与 isBusyState 的区别：isBusyState 含 suspended（presence='busy' / inProgressCount），本函数 deliberately 不含。
 * 对齐 use-studio-unread-meta.ts 同名函数（同样口径）。
 */
export function isRunningState(s: SessionState | undefined): boolean {
  return s === 'running' || s === 'interrupting';
}

/** presence 派生：优先 session state（busy 覆盖 offline/online），其次 member.state */
export function derivePresence(member: Member, sessionState: SessionState | undefined): SeatPresence {
  if (isBusyState(sessionState)) return 'busy';
  if (member.state === 'benched') return 'offline';
  return 'online';
}

/** 遍历 squad 全 session ids 数 busy（running/interrupting/suspended） */
export function deriveInProgressCount(
  members: Member[],
  squadChatSessionId: string,
  stateMap: Record<string, SessionState>,
): number {
  let count = 0;
  const sids: string[] = [squadChatSessionId, ...members.map((m) => m.sessionId)];
  for (const sid of sids) {
    if (isBusyState(stateMap[sid])) count++;
  }
  return count;
}

/** 状态行文案来源：currentWork 优先，其次 i18n fallback（本 hook 只吐 kind） */
export function deriveStatusTextSource(member: Member): SeatRow['statusTextSource'] {
  const text = member.currentWork?.text?.trim();
  if (text) return { kind: 'currentWork', text };
  return { kind: 'fallback' };
}

/**
 * 视图过滤派生（纯函数）：active → 只留 deployed 行；all → 全量。
 * 判据 = 严格 `member.state === 'deployed'`（web 侧 Member.state 类型必填、enum 闭合，
 * 与 plugin duck-typed 侧的 `state !== 'benched'` 判据在生产数据上等价）。
 * 过滤单点 = SeatsPanel（mateRows 派生处）；SeatsBody/SeatsViewSwitch 不过滤。
 * 返回新数组，不改输入。
 */
export function deriveViewRows(rows: SeatRow[], view: SeatsView): SeatRow[] {
  if (view === 'all') return [...rows];
  return rows.filter((r) => r.member.state === 'deployed');
}

// ─── hook ────────────────────────────────────────────────────────────────────

/**
 * 派生坐席面板数据。
 * @param squadId 当前选中 squad id（deps；变化时 reload）
 * @param detail  当前 squad 详情（含 members / squadChatSessionId）
 * @param stateMap studio session state map（来自 useStudioUnreadMeta）
 */
export function useSeatsData(
  squadId: string,
  detail: SquadDetail | null,
  stateMap: Record<string, SessionState>,
): SeatsData {
  // budget：独立 useState + effect（不进 lifecycle——一次性 GET，squadId 变即重拉）
  const [tokenUsed, setTokenUsed] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!squadId) {
      setTokenUsed(null);
      return;
    }
    // fire-and-forget：失败降级 null（未配 budget 后端返 limit=-1，perSession=[]，consumed=0 也可用）
    void getBudgetUsage(squadId)
      .then((usage) => {
        if (cancelled) return;
        // limit=-1 表示未配 budget；此时 consumed=0 语义上「无预算」→ null 降级更诚实
        setTokenUsed(usage.limit === -1 ? null : usage.consumed);
      })
      .catch(() => {
        if (cancelled) return;
        setTokenUsed(null);
      });
    return () => {
      cancelled = true;
    };
  }, [squadId]);

  // 派生 seats + stats
  return useMemo<SeatsData>(() => {
    if (!detail) {
      return {
        seats: [],
        stats: {
          onlineCount: 0,
          totalCount: 0,
          inProgressCount: 0,
          todayMsgCount: null,
          tokenUsed,
        },
      };
    }
    // seats 排序：leader 优先 + 保持 detail.members 顺序（后端已给稳定排序）
    const seatsRaw = detail.members.map<SeatRow>((m) => {
      const sessionState = stateMap[m.sessionId];
      const presence = derivePresence(m, sessionState);
      return {
        member: m,
        isLeader: m.role === 'leader',
        presence,
        isRunning: isRunningState(sessionState),
        statusTextSource: deriveStatusTextSource(m),
      };
    });
    // leader 置顶（若后端未按此序）；seatsRaw 是新数组，原地 sort 安全
    const seats = seatsRaw.sort((a, b) => {
      if (a.isLeader === b.isLeader) return 0;
      return a.isLeader ? -1 : 1;
    });
    const onlineCount = detail.members.filter((m) => m.state === 'deployed').length;
    const inProgressCount = deriveInProgressCount(detail.members, detail.squadChatSessionId, stateMap);
    return {
      seats,
      stats: {
        onlineCount,
        totalCount: detail.members.length,
        inProgressCount,
        todayMsgCount: null, // PRD §6.4 决策：后端无 per-day 聚合，本版恒 null 降级「—」
        tokenUsed,
      },
    };
  }, [detail, stateMap, tokenUsed]);
}
