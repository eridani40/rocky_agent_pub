/**
 * rocky_context plugin — session_store EP 契约类型（v0.0.66 从 types.ts 拆出，≤300 行约束）
 * 参考: reqs/[working] v0.0.66/design.md §1.1/§2.1
 *
 * session_store 扩展点契约：assemble/ingest 路径消费的 SessionStore 方法子集。
 * 设计：default/forked 用同一套 assemble/ingest 主干逻辑，差异靠 store 实现切换：
 *   - persistent_session_store：委托现有持久 SessionStore（全方法），default scope 选中
 *   - in_memory_session_store：只实现 appendMessages + getMessages + getSummary（返 null）；
 *     getRatio 返 1.0；updateUsage + releaseSlot no-op，forked scope 选中
 *
 * releaseSlot 命名说明（v0.0.66 §2.6 / Major 2 修复）：
 *   与 SessionStore.clearSession（删整 session 返 Session，HTTP handler 用）语义不同——
 *   releaseSlot 仅释放 forked 内存槽（default scope 永不调），命名分离避免误删真实 session。
 */
import type { MessageInput, Message } from '../../../../server/src/message/types';
import type {
  SummaryInfo,
  MessageRange,
  MessagePage,
  StoreCallOpts,
  UpdateUsageOpts,
} from '../../../../server/src/agent/session-store-types';

/**
 * session_store 扩展点契约（design §1.1/§2.1）。
 * EP impl 仅实现本接口子集；SessionStore 全方法（createSession/listChildren/...）
 * 不经此 EP，仍由原 SessionStore 实例直供（bootstrap / HTTP handler 等不变）。
 */
export interface SessionStoreContract {
  /**
   * 追加 messages（append-only；同 id 重复写视为 upsert）。
   * [v0.0.83] opts.runId：消息缓冲按 run 隔离——in_memory 用 runId 作桶 key，persistent 忽略。
   */
  appendMessages(sessionId: string, messages: MessageInput[], opts?: StoreCallOpts): Promise<void>;
  /**
   * 按 range 读 transcript 分页（ULID 字典序=时间序）。
   * [v0.0.83] opts.runId：in_memory 按 runId 读桶，persistent 忽略。
   */
  getMessages(sessionId: string, range?: MessageRange, opts?: StoreCallOpts): Promise<MessagePage>;
  /** 读 summary；不存在返 null（forked 内存 store 恒返 null → version 不变 → 永远 append） */
  getSummary(sessionId: string): Promise<SummaryInfo | null>;
  /** 读 char/token ratio（forked 内存 store 返 1.0 冷启动默认） */
  getRatio(sessionId: string): Promise<number>;
  /**
   * 统一更新 usage 并推送（写 + 推一体，caller 只 set 不推）。
   *   - persistent：委托 SessionStore.updateUsage（写 session meta + emit session_usage_update 全量）
   *   - in_memory：no-op（forked 不持久化 cw、零推送，旁路无污染）
   */
  updateUsage(sessionId: string, opts: UpdateUsageOpts): Promise<void>;
  /**
   * [v0.0.66 §2.6] 释放某 run 在本 store 的 buffer 桶（forked run 结束 caller 调）。
   *   - in_memory_session_store：delete Map<runId, Message[]>（释放内存 + per-run 隔离防 sibling 混）
   *   - persistent_session_store：no-op（持久 session 不经此 EP 删；default scope 不调本方法）
   * [v0.0.83] opts.runId：in_memory 按 runId 释放桶（per-run 隔离）。幂等：不存在 no-op。
   */
  releaseSlot(sessionId: string, opts?: StoreCallOpts): Promise<void>;
}

// re-export 业务类型便于 impl 模块一站式 import
export type { Message, MessageInput, SummaryInfo };
