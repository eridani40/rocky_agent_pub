/**
 * squad-aggregate-service — squad 聚合视图计算服务（v0.0.305 新增）
 * 参考: specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/architecture.md D1/D2
 *       specs/api/overall/11a-squad-endpoints.md §1.2（SquadSummary 增量字段）
 *
 * 设计（D1 双入口共享核心纯函数 + D2 口径统一）：
 *   - aggregateFromViews 纯函数：只认 squadChatSessionId + members[].sessionId 这个 session 集合
 *     （seats 口径），**不**用 squadId 全匹配——subagent 派生会话也带 squadId，会多算
 *     inProgressCount / lastActiveAt，与 seats 面板（只数 squadChat + members 直连 session）不一致。
 *   - 批量入口（GET /squad）：一次 sessionStore.listSessions({biz:'studio'}) 全量拉，内存按
 *     squadId 分组 → 单次遍历完成全部 squad 聚合（避免 N+1）。
 *   - 单点入口（SSE）：同一次 listSessions 全量 → 内存过滤目标 squadId（session 量小，单次扫可接受；
 *     与批量共用同一实现避免两套口径）。
 *
 * 单文件 ≤300 行（spec 任务约束）。
 */
import type { SessionStore } from '../agent/session-store';
import type { SquadStore, MemberStore, SquadEntity, MemberEntity } from '../stores/squad-store';
import type { Session } from '../agent/session-store-types';
import type { SquadAggregate } from './squad-event-types';

/** 聚合服务最小依赖接口（只依赖三个 store，不依赖 handler/bus） */
export interface SquadAggregateDeps {
  sessionStore: SessionStore;
  squadStore: SquadStore;
  memberStore: MemberStore;
}

/** busy 状态集合（inProgressCount 口径，含 suspended——对齐 deriveInProgressCount） */
const BUSY_STATES = new Set(['running', 'interrupting', 'suspended']);

/**
 * 纯函数：从 squad + members + session 视图计算 SquadAggregate（无 IO，UT 直测）。
 *
 * 口径（architecture D2，与 seats 面板完全一致）：
 *   - onlineCount = members.filter(m => m.state === 'deployed').length
 *   - inProgressCount = 遍历 [squadChatSessionId, ...members[].sessionId] 数
 *     state∈{running,interrupting,suspended}
 *   - lastActiveAt = 上述 session 集合 updatedAt 最大值；集合空 → squad.updatedAt
 *
 * @param squad squad entity（squadChatSessionId + updatedAt 权威）
 * @param members squad 全部 member（state/sessionId 权威）
 * @param sessionMap squad 关联 session 的 id→Session 映射（caller 预过滤，本函数只认直连集合）
 */
export function aggregateFromViews(
  squad: SquadEntity,
  members: MemberEntity[],
  sessionMap: ReadonlyMap<string, Session>,
): SquadAggregate {
  const onlineCount = members.filter((m) => m.state === 'deployed').length;

  // 直连 session 集合：squadChat + members[].sessionId（seats 口径，不混入 subagent 子会话）
  const directSessionIds = new Set<string>([squad.squadChatSessionId]);
  for (const m of members) {
    if (m.sessionId) directSessionIds.add(m.sessionId);
  }

  let inProgressCount = 0;
  let lastActiveAt: string | null = null;
  for (const sid of directSessionIds) {
    const s = sessionMap.get(sid);
    if (!s) continue;
    if (BUSY_STATES.has(s.state)) inProgressCount += 1;
    if (lastActiveAt === null || s.updatedAt > lastActiveAt) lastActiveAt = s.updatedAt;
  }

  return {
    squadId: squad.id,
    onlineCount,
    inProgressCount,
    // 集合空 → squad.updatedAt（恒有值可排序，PRD §4.1）
    lastActiveAt: lastActiveAt ?? squad.updatedAt,
  };
}

/**
 * 单点聚合（SSE broadcaster 用）：读最新 squad + members + sessions → aggregateFromViews。
 * 一次 listSessions({biz:'studio'}) 拉全量后内存过滤目标 squadId（不 N+1）。
 * squad 不存在（并发删除）返 null → caller no-op。
 */
export async function computeSquadAggregate(
  deps: SquadAggregateDeps,
  squadId: string,
): Promise<SquadAggregate | null> {
  const squad = await deps.squadStore.getSquad(squadId);
  if (!squad) return null;
  const members = await deps.memberStore.listMembers(squadId);
  const sessions = await deps.sessionStore.listSessions({ biz: 'studio' });
  const sessionMap = new Map<string, Session>(
    sessions.filter((s) => s.squadId === squadId).map((s) => [s.id, s]),
  );
  return aggregateFromViews(squad, members, sessionMap);
}

/**
 * 批量聚合（GET /squad 列表用）：一次 listSessions({biz:'studio'}) 全量 → 内存按 squadId
 * 分组 + listMembers 逐 squad → 批量聚合（避免 N+1：不逐 squad 调 computeSquadAggregate）。
 * 单个 squad 聚合失败不影响其他（caller 可降级跳过）。
 */
export async function computeSquadAggregates(
  deps: SquadAggregateDeps,
  squadIds: string[],
): Promise<Map<string, SquadAggregate>> {
  const result = new Map<string, SquadAggregate>();
  if (squadIds.length === 0) return result;

  // 一次全量拉 studio session，内存按 squadId 分组
  const sessions = await deps.sessionStore.listSessions({ biz: 'studio' });
  const sessionsBySquad = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.squadId) continue; // playground session 无 squadId，跳过
    const list = sessionsBySquad.get(s.squadId);
    if (list) list.push(s);
    else sessionsBySquad.set(s.squadId, [s]);
  }

  for (const squadId of squadIds) {
    try {
      const squad = await deps.squadStore.getSquad(squadId);
      if (!squad) continue; // 并发删除 → 跳过
      const members = await deps.memberStore.listMembers(squadId);
      const sessionMap = new Map(
        (sessionsBySquad.get(squadId) ?? []).map((s) => [s.id, s]),
      );
      result.set(squadId, aggregateFromViews(squad, members, sessionMap));
    } catch {
      // 单个 squad 聚合失败降级跳过（不 500）
    }
  }
  return result;
}
