/**
 * SessionPendingOps — HITL 悬挂 tool call 队列字段操作（v0.0.101 新增，拆出 ≤300 行约束）
 * 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §4（PendingToolCall 字段集）
 *       specs/tech/agent/session/[P0]session_store.md §4（pendingToolCalls 落盘 INV-3）
 *
 * 设计：
 *   - session.pendingToolCalls 是 json 透传字段（PendingToolCall[]），HITL 悬挂队列
 *   - peek 只读快照（不改盘）/ set 覆盖写整个数组 / resolve 按 toolCallId 移除一条
 *   - 落盘走 crud.putAsync 串行化（spec §6.1 [wait]）：与状态机 CAS / message 写串行
 *
 * 从 session-store.ts 拆出（session-store.ts 已超 300 行，沿用 unread-ops 拆分先例）。
 * 本模块只负责 pendingToolCalls 字段；状态机 suspended CAS 在 session-state-machine.ts。
 */
import type { CompositeStore } from '../persistence/composite';
import { SessionSchema } from './schema_defs';
import type { SessionRecord } from './schema_defs';
import type { PendingToolCall } from '../tools/types';
import { SessionNotFoundError } from './session-store-converters';

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
 * 规范化 pendingToolCalls 字段（json 透传 → PendingToolCall[]）。
 * 兼容历史 session（无字段）或缺省 → []；非数组（损坏）→ []。
 */
function normalizePendingToolCalls(raw: unknown): PendingToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw as PendingToolCall[];
}

/**
 * peek 队首悬挂 tool call（只读快照，不改盘）。
 * 返首个 status='pending' 的项（队首串行展示，INV-4）；无悬挂项返 null。
 *
 * 用途：GET /session/:id/pending-tool-call + 前端切走切回/重启 recover（d 路径）。
 *
 * @param crud      CompositeStore（已 mount session schema）
 * @param sessionId 目标 session
 * @returns 队首 PendingToolCall 深拷贝快照（防外层误改落盘数据）；无/session 不存在返 null
 */
export function peekPendingToolCall(
  crud: CompositeStore,
  sessionId: string,
): PendingToolCall | null {
  const rec = crud.get(SessionSchema, sessionId) as SessionRecord | null;
  if (!rec) return null;
  const arr = normalizePendingToolCalls(rec.pendingToolCalls);
  const head = arr.find((p) => p.status === 'pending');
  return head ? { ...head } : null;
}

/**
 * 落盘整个 pendingToolCalls 数组（覆盖写）。
 * 用途：runReActLoop ③ 段 tool_pending 退出时一次性写入悬挂队列。
 *
 * @param crud      CompositeStore
 * @param sessionId 目标 session
 * @param items     悬挂队列（覆盖现有）
 * @throws SessionNotFoundError session 不存在
 */
export async function setPendingToolCalls(
  crud: CompositeStore,
  sessionId: string,
  items: PendingToolCall[],
): Promise<void> {
  const rec = crud.get(SessionSchema, sessionId) as SessionRecord | null;
  if (!rec) throw new SessionNotFoundError(sessionId);
  // putAsync 串行化（spec §6.1 [wait]）：pending 写与状态机 CAS 串行
  await crud.putAsync(SessionSchema, stripEnvelope({
    ...rec,
    pendingToolCalls: items as unknown,
  }));
}

/**
 * 按 toolCallId 标 resolved + 删一条（回填后）。
 * 实现语义：从落盘数组中移除匹配项后覆盖写（"标 resolved + 删一条"——resolved 是概念标记，
 *   队列只保 pending 项，resolved 即移除）。
 *
 * 用途：pre-process handleToolReply 回填成功后删队首（或指定 toolCallId）。
 *
 * @param crud        CompositeStore
 * @param sessionId   目标 session
 * @param toolCallId  配对 key（PendingToolCall.toolCallId）
 * @returns true=找到并删除；false=未匹配/session 不存在
 */
export async function resolvePendingToolCall(
  crud: CompositeStore,
  sessionId: string,
  toolCallId: string,
): Promise<boolean> {
  const rec = crud.get(SessionSchema, sessionId) as SessionRecord | null;
  if (!rec) return false;
  const arr = normalizePendingToolCalls(rec.pendingToolCalls);
  const idx = arr.findIndex((p) => p.toolCallId === toolCallId);
  if (idx < 0) return false;
  // 删一条（队列只保 pending；resolved 即移除）
  arr.splice(idx, 1);
  // putAsync 串行化（spec §6.1 [wait]）
  await crud.putAsync(SessionSchema, stripEnvelope({
    ...rec,
    pendingToolCalls: arr as unknown,
  }));
  return true;
}
