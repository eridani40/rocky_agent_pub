/**
 * SessionStore 内部辅助：record ↔ 业务视图转换 + 错误类型 + ULID 字典序二分
 * 参考: specs/tech/agent/session/[P0]session_store.md §2（Session/Run）
 *       specs/tech/version_logs/v0.0.8/change_log.md §6
 *
 * 从 session-store.ts 拆出（≤300 行约束）。
 */
import type { StoredRecord } from '../persistence/crud-types';
import type {
  SessionSchema,
  MessageSchema,
  RunSchema,
} from './schema_defs';
import type {
  Session,
  Run,
  SummaryInfo,
} from './session-store-types';
import type {
  Message,
  MessageRole,
  ContentBlock,
  MessageSender,
} from '../message/types';
// [v0.0.101] PendingToolCall（toSession 序列化 pendingToolCalls 用）
import type { PendingToolCall } from '../tools/types';
// [v0.0.16] ContextWindowUsage 反序列化兜底（兼容旧 3 字段 record）
import { normalizeContextWindowUsage } from './session-usage-helper';

/** session 不存在错误 */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/** run 不存在错误 */
export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

/** SessionRecord → Session 业务视图 */
export function toSession(r: StoredRecord<typeof SessionSchema>): Session {
  // v0.0.12：兼容历史 session（无 state 字段）→ 缺省 idle
  const state = (r.state ?? 'idle') as Session['state'];
  // v0.0.55：summaryTask 字段已从 schema 删除（被 SessionTaskLock 取代，内存 only 不落盘）。
  //   旧 record 中残留的 summaryTask 字段读时忽略（schema 不声明 → r.summaryTask 不存在）。
  // [v0.0.56] 新字段（biz/role/derivation）从 record 直接读；迁移后的数据必有这些字段。
  const biz = r.biz;
  const role = r.role;
  const derivation = r.derivation;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    ...(r.contextWindowUsage !== undefined
      // [v0.0.16] normalize 兜底：旧 record（v0.0.8-0.0.15 的 3 字段）反序列化补全 7 字段
      ? { contextWindowUsage: normalizeContextWindowUsage(r.contextWindowUsage) }
      : {}),
    // v0.0.9：手动选 model 持久字段（可选）
    ...(r.providerId !== undefined ? { providerId: r.providerId } : {}),
    ...(r.modelId !== undefined ? { modelId: r.modelId } : {}),
    // v0.0.12：运行态字段（running/currentRunId 缺省回退，state idle 即 running=false）
    // [v0.0.101] suspended 排除 running（INV-2）：bool 派生只含 running/interrupting，
    //   suspended→running=false（列表据此亮「?」非 spinner）
    state,
    running: r.running ?? (state === 'running' || state === 'interrupting'),
    currentRunId: r.currentRunId ?? null,
    // [v0.0.101] HITL 悬挂队列（落盘 INV-3；兼容历史 session 无字段 → 缺省 []）
    pendingToolCalls: normalizePendingForView(r.pendingToolCalls),
    // [v0.0.27] unread（explicit-bool 模型；兼容历史 session 无字段 → 缺省 false，spec session_state.md §6.1）
    unread: r.unread === true,
    // [v0.0.47] titled（AI 起名 CAS gate；兼容历史 session 无字段 → 缺省 false，spec session_store.md §2）
    //   lazy 默认 false（不跑 migration）：stored record 无 titled 字段时 `r.titled === true` → false。
    //   Session 业务视图始终是 boolean（与 unread 同构）；SessionMetaView 序列化也走同一表达式。
    titled: r.titled === true,
    // [v0.0.231] pinned（会话置顶；lazy 默认 false 不跑 migration，对齐 unread/titled 先例）
    //   历史 record 无 pinned 字段 → `r.pinned === true` → false（spec session_store.md §2）
    pinned: r.pinned === true,
    // v0.0.14：子 agent parent session id（递归 sub 上报；顶层无）
    // [v0.0.28] 同时是 subagent 派生者关联权威（顶层 Session 字段；SessionUsageMeta.parentSessionId 降级 cache）
    ...(r.parentSessionId !== undefined ? { parentSessionId: r.parentSessionId } : {}),
    // [v0.0.56] 新字段（权威源）——迁移后的数据必有这些字段
    biz,
    role,
    derivation,
    // [v0.0.28] session 身份字段已迁移到 SessionKind（biz/role/derivation），旧 type/scope 已删除。
    // [v0.0.28] 其他字段直读
    ...(r.subAgentTemplateType !== undefined ? { subAgentTemplateType: r.subAgentTemplateType } : {}),
    ...(r.origin !== undefined ? { origin: r.origin as Session['origin'] } : {}),
    // [v0.0.28] subagent 派生配置（eff 持久化；buildSessionConfigFromDeps 覆盖默认）
    ...(r.subAgentConfig !== undefined ? { subAgentConfig: r.subAgentConfig as Session['subAgentConfig'] } : {}),
    // [v0.0.33.1] bizType 已删除——统一用 biz 字段。
    ...(r.squadId !== undefined ? { squadId: r.squadId } : {}),
    ...(r.memberId !== undefined ? { memberId: r.memberId } : {}),
    // [v0.0.210] academy 4 实例字段投影（SessionRecord.academyXxx → Session；schema optional，
    //   兼容历史 session 无字段 → 缺省不投影；resolveConfig/rtc 据此组 SessionContext）
    ...(r.academyClassroomId !== undefined ? { academyClassroomId: r.academyClassroomId as string } : {}),
    ...(r.academyStudentId !== undefined ? { academyStudentId: r.academyStudentId as string } : {}),
    ...(r.academyVersionId !== undefined ? { academyVersionId: r.academyVersionId as string } : {}),
    ...(r.academyTrainingTaskId !== undefined ? { academyTrainingTaskId: r.academyTrainingTaskId as string } : {}),
    // [v0.0.58] session.timezone（IANA optional；cron 工具取 tz 用，缺失走 fallback 链）
    ...(r.timezone !== undefined ? { timezone: r.timezone } : {}),
    // [v0.0.148] effort/approvalMode/alwaysApprovedKeys（lazy 默认，兼容历史 session）
    //   effort 缺省 'default'（=厂商默认行为，encode 不注入 output_config）
    //   approvalMode 缺省 'normal'（默认审批流程）
    //   alwaysApprovedKeys 缺省 []（Set 语义，ApprovalManager 内部写）
    effort: (r.effort ?? 'default') as Session['effort'],
    approvalMode: (r.approvalMode ?? 'normal') as Session['approvalMode'],
    alwaysApprovedKeys: normalizeKeyArray(r.alwaysApprovedKeys),
    // [v0.0.17] workspaceDir 兼容历史 session（无字段）→ 缺省 ''，由调用方 lazy 修复
    workspaceDir: r.workspaceDir ?? '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  };
}

// v0.0.55：normalizeSummaryTask 已删除（被 SessionTaskLock 取代，schema 字段同步删除）。

/** RunRecord → Run 业务视图（startedAt 复用信封 createdAt） */
export function toRun(r: StoredRecord<typeof RunSchema>): Run {
  return {
    id: r.id,
    sessionId: r.sessionId,
    status: r.status,
    stopReason: r.stopReason,
    // [v0.0.25 rev2] 透传 RunErrorInfo（仅 stopReason="error" 时存在；json 字段直传）
    ...(r.error !== undefined ? { error: r.error as Run['error'] } : {}),
    ...(r.contextWindowUsage !== undefined
      // [v0.0.16] normalize 兜底（同 toSession）
      ? { contextWindowUsage: normalizeContextWindowUsage(r.contextWindowUsage) }
      : {}),
    startedAt: r.createdAt,
    endedAt: r.endedAt,
    version: r.version,
  };
}

/** MessageRecord → Message 业务视图 */
export function toMessage(r: StoredRecord<typeof MessageSchema>): Message {
  return {
    id: r.id,
    sessionId: r.sessionId,
    role: r.role as MessageRole,
    content: r.content as ContentBlock[],
    ...(r.runId !== undefined ? { runId: r.runId } : {}),
    ...(r.sender !== undefined ? { sender: r.sender as MessageSender } : {}),
    ...(r.metadata !== undefined
      ? { metadata: r.metadata as Record<string, unknown> }
      : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  };
}

/** SummaryRecord（含信封）→ SummaryInfo 业务视图 */
export function toSummary(
  r: StoredRecord<typeof MessageSchema> & {
    summaryUpTo?: string;
    content?: string;
    block?: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  },
): SummaryInfo {
  return {
    version: r.version ?? 1,
    summaryUpTo: r.summaryUpTo ?? null,
    content: r.content ?? null,
    // [v0.0.186] 烘焙 block 文本（旧记录无字段 → null → 组装走即时构建 fallback）
    block: r.block ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * 在升序数组中找 value 应插入的位置（字典序）。
 * 用于 getMessages beforeId 不在列表时定位「该 id 之前」的边界。
 */
export function findInsertIdx(
  sorted: { id: string }[],
  value: string,
): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.id < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * [v0.0.101] 规范化 pendingToolCalls 字段（json 透传 → PendingToolCall[]）。
 * 兼容历史 session（无字段）或缺省 → []；非数组（损坏）→ []。
 * toSession 派生：GET /session + sessionToMetaView 均经此规范化。
 */
function normalizePendingForView(raw: unknown): PendingToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw as PendingToolCall[];
}

/**
 * [v0.0.148] 规范化 alwaysApprovedKeys 字段（json 透传 → string[]）。
 * 兼容历史 session（无字段）或缺省 → []；非数组（损坏）→ []；非 string 元素过滤掉。
 * toSession 派生：GET /session 经此规范化为 string[]。
 */
export function normalizeKeyArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === 'string');
}
