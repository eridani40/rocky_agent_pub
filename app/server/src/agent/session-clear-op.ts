/**
 * session-clear-op — clearSession store op 实现（v0.0.16 新增，从 session-store.ts 拆出）
 * 参考: specs/tech/agent/session/[P0]session_clear.md §2 §3 §5（权威）
 *
 * 职责：单事务清空 session 全部内容（transcript/summary/runs/usage/state），
 * 保留 session 实体（id/title/status/config/createdAt/parentSessionId），返回重置后的 Session。
 * 内部 emit 三事件（session_status_update / session_usage_update / messages_cleared）。
 *
 * 设计：
 *   - 纯函数 + 注入 CrudStore + 可选 statusBus，避免 session-store.ts 超 500 行（拆分）
 *   - 强制重置 state=idle（不走 CAS；caller 在 handler 已预清理）
 *   - 保留 tokenLimit + maxOutputTokens（来自 modelConfig 非累加值，UI 首屏展示用）
 *
 * v0.0.55：summaryTask 字段已删除（被 SessionTaskLock 取代，内存 only 不落盘）。
 *   caller（session-clear handler）需自行调 lock.release(sid, 'compact') 清内存锁。
 *
 * 清理范围表对齐 session_clear.md §3。
 */
import { ulid } from '../config/ulid';
import type { CompositeStore } from '../persistence/composite';
import { SessionSchema, MessageSchema, SummarySchema, RunSchema } from './schema_defs';
import type { SessionRecord, SummaryRecord } from './schema_defs';
import type { ContextWindowUsage } from '../message/types';
import type { Session } from './session-store-types';
import { SessionNotFoundError, toSession } from './session-store-converters';
import type { ReplayableEventBus } from './event-bus';
import type {
  SessionUsageUpdateEvent,
  SessionStatusUpdateEvent,
  MessagesClearedEvent,
} from './session-event-types';
import {
  deriveUsageView, emptyMeta, normalizeContextWindowUsage,
  DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_TOKEN_LIMIT,
} from './session-usage-helper';

/**
 * CrudStore.put 禁 record 自带信封字段（createdAt/updatedAt/version）—— 此函数剥除。
 * 与 session-state-machine.ts / session-store.ts 同语义（模块隔离，各自私有）。
 */
function stripEnvelope<T extends Record<string, unknown>>(rec: T): T {
  const { createdAt, updatedAt, version, ...rest } = rec as unknown as {
    createdAt?: unknown; updatedAt?: unknown; version?: unknown;
  };
  void createdAt; void updatedAt; void version;
  return rest as T;
}

/**
 * 从 session record 移除 currentRunId 字段（语义 = null）。
 * CrudStore.put 写 json 时 undefined 字段不落盘；InferRecord 类型不接受 null。
 * 与 session-state-machine.ts 同语义（模块隔离，各自私有）。
 */
function unsetRunId(rec: SessionRecord): SessionRecord {
  const { currentRunId: _drop, ...rest } = rec;
  return rest as SessionRecord;
}

/**
 * 清空 session 内容（保留实体），返回重置后的 Session。同步原子（spec session_clear.md §2）。
 *
 * 清理范围（§3 表）：
 *   - transcript：DELETE WHERE sessionId=sid（含 raw/tool_result 级联）
 *   - summary：覆盖空 summary（content='', summaryUpTo=null；version 由 store 信封自增）
 *   - runs：DELETE WHERE sessionId=sid
 *   - usage 三分区：全字段置 0（emptyMeta）
 *   - ratio：samples=[], current=1.0（冷启动）
 *   - contextWindowUsage：system/message/tool/total=0；maxOutputTokens + tokenLimit **保留**
 *   - summaryTask：v0.0.55 已删除（被 SessionTaskLock 取代，内存 only 不落盘；caller 调 lock.release）
 *   - state：强制重置 idle（不走 CAS；caller 已预 abort active run）
 *
 * emit 三事件（spec §5 step4）：session_status_update / session_usage_update / messages_cleared。
 *
 * @param crud 已 mount 4 schema 的 CrudStore
 * @param statusBus session_panel topic 的 bus（推送 SessionEvent；undefined 时推送降级为 no-op）
 * @param sessionId 目标 session
 * @returns 重置后的 Session（state=idle + 零 usage + 保留实体字段）
 */
export async function clearSessionStoreOp(
  // [v0.0.38 T4] crud 类型由 CrudStore 收紧为 CompositeStore（spec §6.1：cascade 走 putAsync/deleteAsync）
  crud: CompositeStore,
  statusBus: ReplayableEventBus | undefined,
  sessionId: string,
): Promise<Session> {
  // ── step1: 删 transcript + runs（按 sessionId 扫 + 逐条删）──
  // [v0.0.38 T4] deleteAsync 串行化（spec §6.1 [wait]）：cascade 是 read-modify-write 索引
  const msgs = crud.query(MessageSchema, { shardKey: sessionId });
  for (const m of msgs) await crud.deleteAsync(MessageSchema, m.id as string, sessionId);
  const runs = crud.query(RunSchema, { shardKey: sessionId });
  for (const r of runs) await crud.deleteAsync(RunSchema, r.id as string, sessionId);

  // ── step2: summary 覆盖为「空 summary」（content='' + summaryUpTo=null；version 信封自增）──
  const summaryRec: SummaryRecord = {
    id: sessionId,
    sessionId,
    summaryUpTo: undefined,
    content: '',
  };
  // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）
  await crud.putAsync(SummarySchema, summaryRec);

  // ── step3: 强制重置 session record（state/usage 全清；保留实体 + cw 的 limit）──
  // v0.0.55：summaryTask 字段已删除（不写 record；caller 调 lock.release 清内存锁）
  const rec = crud.get(SessionSchema, sessionId) as SessionRecord | null;
  if (!rec) throw new SessionNotFoundError(sessionId);
  // 保留 tokenLimit + maxOutputTokens（来自 modelConfig，非累加值，UI 首屏展示用）
  const oldCw = rec.contextWindowUsage !== undefined
    ? normalizeContextWindowUsage(rec.contextWindowUsage)
    : undefined;
  const tokenLimit = oldCw?.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const maxOutputTokens = oldCw?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const clearedCw: ContextWindowUsage = {
    systemTokens: 0,
    messageTokens: 0,
    toolTokens: 0,
    totalTokens: 0,
    maxOutputTokens,
    tokenLimit,
    remainingTokens: tokenLimit - 0 - maxOutputTokens,
  };
  const clearedMeta = emptyMeta(); // 三分区全 0 + ratio 冷启动
  // 先用 spread 写（保留实体字段 title/status/providerId/modelId/parentSessionId），
  // 再用 unsetRunId 剥 currentRunId 字段（语义 = null）
  // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）：HTTP clear 须确认完成
  await crud.putAsync(SessionSchema, stripEnvelope(unsetRunId({
    ...rec,
    state: 'idle',            // 强制重置（不走 CAS；caller 已预 abort）
    running: false,
    usage: clearedMeta as unknown,
    contextWindowUsage: clearedCw as unknown,
  })));

  // ── step4: emit 三事件（spec §5 step4）──
  if (statusBus) {
    const now = new Date().toISOString();
    // 4a. session_status_update(state=idle)
    const statusEvt: SessionStatusUpdateEvent = {
      id: ulid(), type: 'session_status_update', sessionId, createdAt: now,
      data: { state: 'idle', running: false, currentRunId: null },
    };
    statusBus.emit(`session_id:${sessionId}`, { data: statusEvt, timestamp: now });
    // 4b. session_usage_update（零 view + 保留 cw）
    const usageEvt: SessionUsageUpdateEvent = {
      id: ulid(), type: 'session_usage_update', sessionId,
      createdAt: new Date().toISOString(),
      data: deriveUsageView(clearedMeta, clearedCw),
    };
    statusBus.emit(`session_id:${sessionId}`, {
      data: usageEvt, timestamp: new Date().toISOString(),
    });
    // 4c. messages_cleared（前端清对话区）
    const clearedEvt: MessagesClearedEvent = {
      id: ulid(), type: 'messages_cleared', sessionId,
      createdAt: new Date().toISOString(),
      data: {},
    };
    statusBus.emit(`session_id:${sessionId}`, {
      data: clearedEvt, timestamp: new Date().toISOString(),
    });
  }

  // 返回重置后的 Session（toSession 转换；state 已重置）
  const finalRec = crud.get(SessionSchema, sessionId)!;
  return toSession(finalRec);
}
