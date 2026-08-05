/**
 * SessionMetaBroadcaster — session 层 meta 广播器（v0.0.27 新增）
 *
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta topic 架构 + producer 归属）
 *   - specs/tech/agent/session/[P0]session_event.md §3a（SessionMetaView + 触发时机全集）
 *   - specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md（决策 + 全量 payload 理由）
 *
 * 设计（关注点分离，spec decision.md §5 硬约束）：
 *   - **状态机 + agent-loop 不调 broadcaster**（纯粹性不变量）—— 本 broadcaster 是状态机之上的
 *     session 层组件，订阅 statusBus 信号自治（与 SessionUnreadRuntime 同构）。
 *   - 复用现有 EventHub + (topic, group) 寻址，**只 emit 到共享广播 group `_all`**（spec §10.2，
 *     传输层 ReplayableEventBus group 间完全隔离、无 wildcard，故用共享 group 达成 broadcast）。
 *
 * 触发路径（spec decision.md §4 触发时机全集表）：
 *   - **经 statusBus wrap 捕获**：session_status_update / session_usage_update /
 *     session_read_update / messages_cleared / session_workspace_dir_changed（任何经 statusBus 的
 *     session 事件 → broadcaster.broadcast(sid)，单点捕获、无遗漏）。session_workspace_file_changed
 *     不触发（高频文件变化非 session meta 本身，spec decision.md §4 注）。
 *   - **markUnreadTrue runtime 直调**（产生路径不经 statusBus）：SessionUnreadRuntime 在 CAS 成功
 *     后直接调 broadcaster.broadcast(sid)。
 *
 * [v0.0.78.bug] summary_task_update 已恢复到触发集（v0.0.55 误删导致 CompactBtn spinner 信号丢失）。
 *   SessionTaskLock acquire/markDone/markFailed CAS 成功后经 sessionStatusBus emit summary_task_update，
 *   本 broadcaster 捕获后触发 session_meta 广播（会话列表刷新 updated 时间戳）。
 *
 * 单文件 ≤300 行（spec 任务约束）。
 */
import { ulid } from '../config/ulid';
import type { CrudStore, StoredRecord } from '../persistence/crud-types';
import { SessionSchema } from './schema_defs';
import type { ReplayableEventBus } from './event-bus';
import type { Session } from './session-store-types';
import { toSession } from './session-store-converters';
import type { SessionEvent, SessionMetaUpdateEvent, SessionMetaView } from './session-event-types';
import { SESSION_META_BROADCAST_GROUP } from './session-event-types';

/** SessionMetaBroadcaster 注入接口（最小依赖） */
export interface SessionMetaBroadcasterDeps {
  /** CrudStore（读最新 session record 组装 SessionMetaView） */
  crud: CrudStore;
  /** session_meta topic 的 bus（emit 到 _all 共享广播 group） */
  sessionMetaBus: ReplayableEventBus;
}

/**
 * session 状态机经 statusBus 发出的事件类型全集（spec decision.md §4）。
 * broadcaster 对这些类型都触发 broadcast（按 sessionId）。
 * session_workspace_file_changed（chokidar fs event）**不触发**（高频非 meta 本身）。
 *
 * [v0.0.78.bug] summary_task_update 重新加入触发集（v0.0.55 误删后恢复）。
 */
// 用 Set<string> 而非 Set<SessionEvent['type']>，允许 UT 查任意字符串（如预留类型）。
const META_TRIGGERING_TYPES = new Set<string>([
  'session_status_update',
  'session_usage_update',
  'session_read_update',
  'messages_cleared',
  'session_workspace_dir_changed',
  // [v0.0.78.bug] 恢复：compact 任务状态变更也触发 meta 广播（会话列表 updated 时间戳刷新）
  'summary_task_update',
]);

/**
 * 把 Session 业务视图（toSession 已规范化）转换为 SessionMetaView（对齐 GET /session 返回 shape，
 * 不含 transcript）。
 *
 * [v0.0.78.bug] SessionMetaView.summaryTask optional 字段恢复但不填（方案 A，开放点-1 决策）：
 *   broadcaster 持 crud 不持 SessionTaskLock 实例，无法读最新 (sid,'compact') 状态；
 *   前端通过单独的 summary_task_update SSE 事件订阅 compact 状态，不依赖 meta_view.summaryTask。
 */
function sessionToMetaView(s: Session): SessionMetaView {
  return {
    id: s.id,
    title: s.title ?? '',
    status: s.status ?? 'active',
    // [v0.0.101] suspended 透传确认：state 直读 s.state（含 suspended），
    //   running 直读 s.running（toSession 派生排除 suspended → false）。
    //   列表 reducer 据此对 suspended 态亮「?」标记（非 spinner）。SessionMetaView.state
    //   enum 已含 'suspended'（T1）。pendingToolCalls 不进 meta view（列表只看 state；
    //   卡片详情走 GET /pending-tool-call peek）。
    state: s.state,
    running: s.running,
    currentRunId: s.currentRunId ?? null,
    workspaceDir: s.workspaceDir ?? '',
    unread: s.unread === true,
    // [v0.0.47] titled 序列化（对齐 GET /session；lazy 默认 false，spec session_store.md §2）
    //   Session.titled 已是 boolean（toSession 规范化），此处 `=== true` 二次防御（极端兜底）。
    titled: s.titled === true,
    // [v0.0.231] pinned 投影（会话置顶；lazy 默认 false，`=== true` 二次防御对齐 titled）
    pinned: s.pinned === true,
    providerId: s.providerId,
    modelId: s.modelId,
    // [v0.0.28] multi_agent 字段（对齐 GET /session，spec §2.3）：subagent session 创建/状态变更
    // 时广播含 parentSessionId，前端会话列表 reducer 据此把 subagent 挂到对应 parent tree。
    ...(s.parentSessionId !== undefined ? { parentSessionId: s.parentSessionId } : {}),
    ...(s.subAgentTemplateType !== undefined ? { subAgentTemplateType: s.subAgentTemplateType } : {}),
    ...(s.origin !== undefined ? { origin: s.origin } : {}),
    // [v0.0.56] session 身份字段（权威源——替代旧 type/scope/bizType）
    ...(s.biz !== undefined ? { biz: s.biz } : {}),
    ...(s.role !== undefined ? { role: s.role } : {}),
    ...(s.derivation !== undefined ? { derivation: s.derivation } : {}),
    ...(s.squadId !== undefined ? { squadId: s.squadId } : {}),
    ...(s.memberId !== undefined ? { memberId: s.memberId } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * SessionMetaBroadcaster — session 层 meta 广播器。
 *
 * 职责：收到 statusBus 上的 session 事件 OR runtime markUnreadTrue 直调时，
 * 读最新 session record → 组装 SessionMetaView → emit session_meta_update 到 (session_meta, _all)。
 *
 * 设计：
 *   - 每次都**读最新态**（crud.get）—— event 只携带变更增量，但 broadcast payload 是全量最新态
 *     （spec decision.md §3：全量 payload 让 reducer 整条替换，无需 merge）。
 *   - session 不存在（crud.get null）→ no-op（可能并发删除，静默跳过）。
 *   - broadcast 异常吞掉不影响主路径（statusBus.emit 已成功，前端不受影响）。
 */
export class SessionMetaBroadcaster {
  private readonly crud: CrudStore;
  private readonly sessionMetaBus: ReplayableEventBus;

  constructor(deps: SessionMetaBroadcasterDeps) {
    this.crud = deps.crud;
    this.sessionMetaBus = deps.sessionMetaBus;
  }

  /**
   * 读最新 session record → 组装 SessionMetaView → emit session_meta_update 到 (session_meta, _all)。
   *
   * 由 wrap（statusBus 捕获）和 runtime（markUnreadTrue CAS 成功后直调）调用。
   * 全量 payload（非 diff），让 reducer 整条替换列表条目（spec decision.md §3）。
   *
   * @param sessionId 变更的 session id
   */
  broadcast(sessionId: string): void {
    try {
      // crud.get 返回 StoredRecord（含信封 + 业务字段），toSession 规范化为 Session 业务视图
      const rec = this.crud.get(SessionSchema, sessionId) as StoredRecord<typeof SessionSchema> | null;
      if (!rec) return; // session 不存在（可能并发删除）→ no-op
      const data = sessionToMetaView(toSession(rec));
      const event: SessionMetaUpdateEvent = {
        id: ulid(),
        type: 'session_meta_update',
        sessionId,
        createdAt: new Date().toISOString(),
        data,
      };
      // emit 到共享广播 group `_all`（spec §10.2，传输层 group 分区约束）
      this.sessionMetaBus.emit(SESSION_META_BROADCAST_GROUP, {
        data: event,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // broadcast 异常不影响主路径（statusBus.emit 已成功，前端正常订阅收其他事件）
    }
  }

  /**
   * 处理 statusBus 上收到的 SessionEvent：若属触发类型 → broadcast(event.sessionId)。
   *
   * 由 wrapStatusBusForMeta（泛化版 wrap）在 statusBus.emit 入口 fan-out 调用。
   * 仅 META_TRIGGERING_TYPES 触发（session_workspace_file_changed 等高频非 meta 不触发）。
   */
  handleSessionEvent(event: SessionEvent): void {
    if (!META_TRIGGERING_TYPES.has(event.type)) return;
    this.broadcast(event.sessionId);
  }
}

/** @internal 导出触发类型集合，UT 用 */
export const _META_TRIGGERING_TYPES = META_TRIGGERING_TYPES;
