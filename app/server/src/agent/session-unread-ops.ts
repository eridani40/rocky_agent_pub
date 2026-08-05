/**
 * SessionUnreadOps — unread 字段 CAS 操作（v0.0.27 新增，拆出 ≤300 行约束）
 * 参考: specs/tech/agent/session/[P0]session_state.md §3.1（产生/消除 CAS SQL）+ §4.4（两 timing）+ §6.3（不变量）
 *       specs/tech/agent/session/[P0]session_store.md §4（markRead API）
 *       specs/tech/agent/session/[P0]session_event.md §2（session_read_update 事件）
 *
 * 设计：
 *   - 全 CAS 原子条件写（WHERE 子句防并发交错）—— 返 boolean，false = CAS 失败（已是目标值）
 *   - 产生未读（unread=false→true）：CAS 成功不发事件（无订阅方，spec §4.4 注释）
 *   - 消除未读（unread=true→false）：CAS 成功 emit session_read_update（topic=session_panel）
 *   - 幂等：CAS 0 行（已是目标值）不重复写、不发事件（spec §6.3 不变量 5）
 *
 * 从 session-state-machine.ts 拆出（避免 stateMachine 超 300 行）。本模块与 stateMachine 共享
 * CrudStore + statusBus，但只负责 unread 字段；stateMachine 继续管五态机。
 */
import { ulid } from '../config/ulid';
import type { CompositeStore } from '../persistence/composite';
import { SessionSchema } from './schema_defs';
import type { SessionRecord } from './schema_defs';
import type { ReplayableEventBus } from './event-bus';
import type { SessionReadUpdateEvent } from './session-event-types';

/** CrudStore.get 返回含信封字段，put 禁自带信封——剥除后 get→改→put 往返 */
function stripEnvelope<T extends Record<string, unknown>>(rec: T): T {
  const { createdAt, updatedAt, version, ...rest } = rec as unknown as {
    createdAt?: unknown;
    updatedAt?: unknown;
    version?: unknown;
  };
  void createdAt; void updatedAt; void version;
  return rest as T;
}

/**
 * 产生未读 CAS（spec session_state.md §3.1 + §4.4 timing「产生」）。
 * CAS `unread: false → true`（WHERE unread=false），幂等保护（已 true 不重复写）。
 *
 * 由 session 层 SessionUnreadRuntime.handleSessionEvent 调（订阅 session_status_update
 * completion 信号 → isSessionActive=false 时调本方法）。
 * - 前台判定 isSessionActive 在调用方（SessionUnreadRuntime）做，本方法纯 CAS 不查 SSE（解耦）。
 * - CAS 成功不发事件（产生未读时用户未订阅该 session → 无订阅方收事件，spec §4.4 注释）。
 *
 * 落盘时序：本方法必须 await putAsync 后才返回——
 * 调用方 SessionUnreadRuntime.handleSessionEvent 在 `.then(changed => broadcaster.broadcast(sid))`
 * 里立即触发 SessionMetaBroadcaster.broadcast(sid) 同步 crud.get 重读组 SessionMetaView，
 * 未落盘就 return 会导致 broadcast 读到旧 unread=false 广播出错值——覆盖不了本次产生的未读。
 * put 落盘阻塞的是同一文件锁下的下一个写，用户无感知（~ms 级）。
 *
 * @returns true=CAS 成功（false→true 真实改写）；false=已是 true（幂等 no-op）或 session 不存在
 */
export async function markUnreadTrue(
  crud: CompositeStore,
  sessionId: string,
): Promise<boolean> {
  const rec = crud.get(SessionSchema, sessionId) as SessionRecord | null;
  if (!rec) return false;
  // CAS：仅 unread=false 时改写 true（spec §3.1 SQL `WHERE unread=false`）
  if (rec.unread === true) return false;
  // 落盘后再返回：调用方紧接 broadcast(sid) 会同步 crud.get 重读，未落盘会广播旧值
  await crud.putAsync(SessionSchema, stripEnvelope({ ...rec, unread: true }));
  // 产生未读不发事件（无订阅方；spec §4.4 timing「产生」表格中无事件列）
  return true;
}

/**
 * 消除未读 CAS（spec session_state.md §3.1 + §4.4 timing「消除」+ session_store.md §4）。
 * CAS `unread: true → false`（WHERE unread=true）+ emit session_read_update；幂等保护。
 *
 * markRead 是**唯一消除未读入口**（spec §6.3 不变量 2）。POST /session/:id/read → handler 调本方法。
 * - CAS 成功（true→false）：emit session_read_update（topic=session_panel，group=session_id:<sid>）。
 * - CAS 0 行（已是 false）：幂等 no-op，不发事件（避免重复 emit 抖动，spec §6.3 不变量 5）。
 *
 * 落盘时序：emit 前必须 await put 落盘。
 * SessionMetaBroadcaster 收到 session_read_update 会同步 fan-out 调 broadcast(sid) 重读 crud
 * 组 SessionMetaView 广播给会话列表；未落盘会读到旧 unread=true 广播出错值——前端看到红点
 * 被清除后又立即被 meta 广播的旧值重置回来（race）。
 * put 落盘阻塞的是 POST /read 响应，从 fNF-return 变成 write-return，多等 fs 写 ~ms 级，用户无感知。
 *
 * @returns true=CAS 成功（true→false 真实改写 + emit 事件）；false=已是 false（幂等 no-op）或 session 不存在
 */
export async function markReadAndEmit(
  crud: CompositeStore,
  statusBus: ReplayableEventBus | undefined,
  sessionId: string,
): Promise<boolean> {
  const rec = crud.get(SessionSchema, sessionId) as SessionRecord | null;
  if (!rec) return false;
  // CAS：仅 unread=true 时改写 false（spec §3.1 SQL `WHERE unread=true`）
  if (rec.unread !== true) return false;
  // 落盘后再 emit：emit 会同步触发 SessionMetaBroadcaster.broadcast(sid) 重读 crud，未落盘会广播旧值
  await crud.putAsync(SessionSchema, stripEnvelope({ ...rec, unread: false }));
  // emit session_read_update（spec §4.4 timing「消除」+ session_event.md §2）
  if (statusBus) {
    const e: SessionReadUpdateEvent = {
      id: ulid(),
      type: 'session_read_update',
      sessionId,
      createdAt: new Date().toISOString(),
      data: { unread: false },
    };
    statusBus.emit(`session_id:${sessionId}`, {
      data: e,
      timestamp: new Date().toISOString(),
    });
  }
  return true;
}
