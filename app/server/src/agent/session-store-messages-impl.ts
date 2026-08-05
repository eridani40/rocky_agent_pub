/**
 * session-store-messages-impl — SessionStore 的 message/run 维度方法实现
 *
 * 纯 move 自 session-store.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，
 * 签名 + 内部逻辑不变。class 内方法改为单行委托到本文件 standalone 函数。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.4-4.5 + INV-S-1/INV-S-3
 *
 * 方法组（grep 已核实）：
 *   - createRun / getRun / updateRun / getRuns（run CRUD）
 *   - appendMessages / getMessages / getMessagesByRun（transcript 维度）
 *
 * INV-S-1：分页语义（ULID 字典序=时间序）、append-only upsert、run lifecycle 串行化全部保留
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；crud/store 作入参。
 */
import type { SessionStore } from './session-store';
import { RunSchema, MessageSchema } from './schema_defs';
import type { RunRecord, MessageRecord } from './schema_defs';
import type { Message, MessageInput } from '../message/types';
import { toRun, toMessage, RunNotFoundError, findInsertIdx } from './session-store-converters';
import type {
  Run, MessageRange, MessagePage, CreateRunInput, StoreCallOpts,
} from './session-store-types';

// ── run 维度 CRUD ──

/** 创建 run（status 默认 running） */
export async function sessionStoreCreateRun(
  store: SessionStore,
  input: CreateRunInput,
): Promise<Run> {
  const rec: RunRecord = {
    id: input.id,
    sessionId: input.sessionId,
    status: input.status ?? 'running',
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    // 透传 RunErrorInfo（仅 stopReason="error" 时 caller 传入）
    ...(input.error !== undefined ? { error: input.error as unknown } : {}),
  };
  // shardKey 由 FsCrudStore 从 record.sessionId 提取（put 第 3 参是 PutOptions 非 shardKey）
  // putAsync 串行化（spec §6.1 [wait]）：run lifecycle 须 await；同 session 多 run 并发
  return toRun(await store.crud.putAsync(RunSchema, rec));
}

/** 读单个 run；不存在返 null */
export async function sessionStoreGetRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
): Promise<Run | null> {
  const got = store.crud.get(RunSchema, runId, sessionId);
  return got ? toRun(got) : null;
}

/** 更新 run（status/stopReason/error/contextWindowUsage/endedAt） */
export async function sessionStoreUpdateRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
  patch: Partial<Pick<Run, 'status' | 'stopReason' | 'error' | 'contextWindowUsage' | 'endedAt'>>,
): Promise<void> {
  const e = store.crud.get(RunSchema, runId, sessionId);
  if (!e) throw new RunNotFoundError(runId);
  const cw = patch.contextWindowUsage ?? e.contextWindowUsage;
  const endedAt = patch.endedAt !== undefined ? patch.endedAt : e.endedAt;
  // error 字段：undefined=未传（保留 existing）；null=显式清空（下方 !== null 过滤掉）；值=覆盖。
  const errorVal = patch.error !== undefined ? patch.error : e.error;
  const rec: RunRecord = {
    id: e.id,
    sessionId: e.sessionId,
    status: patch.status !== undefined ? patch.status : e.status,
    stopReason: patch.stopReason !== undefined ? patch.stopReason : e.stopReason,
    ...(errorVal !== undefined && errorVal !== null ? { error: errorVal as unknown } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(cw !== undefined ? { contextWindowUsage: cw as unknown } : {}),
  };
  // putAsync 串行化（spec §6.1 [wait]）：run lifecycle 须 await
  await store.crud.putAsync(RunSchema, rec);
}

/** 列出某 session 全部 run（按 createdAt desc） */
export async function sessionStoreGetRuns(
  store: SessionStore,
  sessionId: string,
): Promise<Run[]> {
  return store.crud
    .query(RunSchema, { shardKey: sessionId, order: 'createdAtDesc' })
    .map(toRun);
}

// ── transcript（message）维度 ──

/**
 * 追加 messages 到 transcript（append-only 语义；同 id 重复写视为 upsert 更新）。
 * opts.runId：持久 store 忽略（按 sid 落盘）；仅 in_memory EP impl 用 runId 作桶 key。
 */
export async function sessionStoreAppendMessages(
  store: SessionStore,
  sessionId: string,
  messages: MessageInput[],
  _opts?: StoreCallOpts,
): Promise<void> {
  for (const m of messages) {
    const rec: MessageRecord = {
      id: m.id,
      sessionId,
      role: m.role,
      content: m.content as unknown,
      ...(m.runId !== undefined ? { runId: m.runId } : {}),
      ...(m.sender !== undefined ? { sender: m.sender as unknown } : {}),
      ...(m.metadata !== undefined ? { metadata: m.metadata as unknown } : {}),
    };
    // putAsync 串行化（spec §6.1 [wait]）：同 session 多工具并发 emit 须串行落盘
    await store.crud.putAsync(MessageSchema, rec);
  }
}

/**
 * 按 range 读 transcript 分页。
 * - 无 beforeId：取末尾 limit 条（按 id 升序的最新 limit 条），hasMore = 总数 > limit；
 *   [v0.0.185] range.takeFromStart=true 时改取头部 limit 条（锚定会话真第一条，head 候选用）
 * - 有 beforeId：取该 id ULID 字典序之前的 limit 条，hasMore = 是否还有更早
 * - fromId/upToId：范围过滤（含两端）
 * 返回 items 按 id 升序（旧→新）。
 */
export async function sessionStoreGetMessages(
  store: SessionStore,
  sessionId: string,
  range?: MessageRange,
  _opts?: StoreCallOpts,
): Promise<MessagePage> {
  const limit = range?.limit ?? 50;
  const all = store.crud.query(MessageSchema, {
    shardKey: sessionId,
    order: 'createdAtAsc',
  });
  // ULID 字典序 = 时间序（升序 = 旧→新）
  let sorted = all.slice().sort((a, b) => (a.id as string).localeCompare(b.id as string));

  if (range?.fromId) {
    const idx = sorted.findIndex((m) => m.id === range.fromId);
    if (idx >= 0) sorted = sorted.slice(idx);
  }
  if (range?.upToId) {
    const idx = sorted.findIndex((m) => m.id === range.upToId);
    if (idx >= 0) sorted = sorted.slice(0, idx + 1);
  }

  if (range?.beforeId) {
    const beforeIdx = sorted.findIndex((m) => m.id === range.beforeId);
    const cutIdx = beforeIdx >= 0 ? beforeIdx : findInsertIdx(sorted, range.beforeId);
    const window = sorted.slice(0, cutIdx);
    return {
      items: window.slice(-limit).map(toMessage),
      hasMore: window.length > limit,
    };
  }

  return {
    // [v0.0.185] takeFromStart：取范围头部 limit 条（缺省取尾部）
    items: (range?.takeFromStart ? sorted.slice(0, limit) : sorted.slice(-limit)).map(toMessage),
    hasMore: sorted.length > limit,
  };
}

/** 取某 run 关联的全部 messages（按 id 升序） */
export async function sessionStoreGetMessagesByRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
): Promise<Message[]> {
  return store.crud.query(MessageSchema, {
    shardKey: sessionId,
    order: 'createdAtAsc',
  })
    .filter((m) => m.runId === runId)
    .sort((a, b) => (a.id as string).localeCompare(b.id as string))
    .map(toMessage);
}
