/**
 * builtin rocky_context plugin — session_store: in_memory_session_store（v0.0.66 新增；v0.0.83 per-run 隔离）
 * 参考: reqs/[working] v0.0.66/design.md §1.1/§2.1
 *       reqs/[working] v0.0.83.forked_per_run_isolation/req.md（per-run 隔离第一性原则）
 *       specs/tech/agent/context/[P0]context_engine.md §3.6（源/汇可注入）
 *
 * 职责（forked scope 选中）：per-run 内存数组存储实现，替代 forked 的 per-run buffer。
 *   - 只实现 appendMessages + getMessages（forked 增量汇 + assemble 读源）
 *   - getSummary 恒返 null（forked 无 compact summary；design §1.2 summary 驱动 rebuild 时
 *     null → version 永远不变 → 永远 append 复用 prevSnapshot，纯数据驱动无 isForked 判断）
 *   - getRatio 返 1.0（冷启动默认；forked 不学 ratio）
 *   - updateUsage no-op（forked 不持久化 usage、零推送，旁路无污染）
 *   - releaseSlot 删 buffer 桶（forked run 结束 caller 调）；其他 Contract 方法（如有 caller 调）throw
 *
 * [v0.0.83.forked_per_run_isolation] per-run 隔离（第一性原则）：
 *   每个 forked run（summary / memory_extract sibling）是独立运行节点，必须有独立资源区域。
 *   buffer 桶 key = runId（caller 经 opts.runId 传入）。summary + memory_extract 同 sid 不同 runId
 *   → 不同桶 → 零消息交叉（修前 v0.0.66 按 sid 分桶 → sibling 共享 → buffer 混合发 3 套矛盾指令）。
 *
 *   **slot 是本 impl 的内部概念**（Map 桶 key = runId）——session(sid) 与 run(runId) 是通用领域 id，
 *   caller 传二者（sid 在第 1 参，runId 在 opts）；用哪个作桶 key 是本 impl 内部决策（slotKeyOf）。
 *   slot 字眼不出现在 ContextEngine / handler / EP 契约层。
 *
 * 状态持有：模块级 Map<runId, Message[]> —— forked 每个 run 一个桶，多次 ingest/assemble 读同一桶
 *   （plugin_manager 每次 getExtensionImpls 重新 instantiate 本类，但共享模块级 Map 保证 per-run 累积）。
 *   run 结束 RunLoopHandle.start() finally 经 ContextEngine.clearScopeSession 调本类 releaseSlot 清桶。
 *
 * EP: session_store（exclusive）。forked-scope-bootstrap setExclusive 选中本 impl。
 */
import type {
  Message,
  MessageInput,
} from '../../../server/src/message/types';
import type {
  SummaryInfo,
  MessageRange,
  MessagePage,
  StoreCallOpts,
  UpdateUsageOpts,
} from '../../../server/src/agent/session-store-types';
import { ContextImplBase } from '../types';
import type { SessionStoreContract } from './types';

/**
 * per-run 内存存储：runId → Message[]（按 id 升序累积）。
 * runId 来自 caller 的 opts.runId（forked run 唯一）；缺省 fallback sessionId（防御性，不应到达）。
 */
const SESSION_STORES = new Map<string, Message[]>();

/**
 * [v0.0.83] 算 buffer 桶 key（**slot——本 impl 内部概念，仅本文件出现**）。
 * forked 路径 caller 传 opts.runId → 按 runId 隔离（per-run）；缺省 fallback sessionId。
 */
function slotKeyOf(sessionId: string, opts?: StoreCallOpts): string {
  return opts?.runId ?? sessionId;
}

/**
 * 清理某 run 的内存 buffer 桶（仅本模块 releaseSlot 调；外部经 EP impl 的 releaseSlot）。
 * 幂等：不存在 no-op。
 */
function releaseInMemorySlot(slotKey: string): void {
  SESSION_STORES.delete(slotKey);
}

/**
 * in_memory_session_store：forked scope 专属 session store 实现。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class InMemorySessionStore
  extends ContextImplBase
  implements SessionStoreContract
{
  async appendMessages(sessionId: string, messages: MessageInput[], opts?: StoreCallOpts): Promise<void> {
    const slotKey = slotKeyOf(sessionId, opts);
    let arr = SESSION_STORES.get(slotKey);
    if (!arr) {
      arr = [];
      SESSION_STORES.set(slotKey, arr);
    }
    // append-only + 同 id 视为 upsert（对齐持久 store 语义；design §1.1 message ID 相同不重复追加）
    for (const m of messages) {
      const msg = m as unknown as Message;
      const idx = arr.findIndex((x) => x.id === msg.id);
      if (idx >= 0) {
        arr[idx] = msg; // upsert
      } else {
        arr.push(msg);
      }
    }
    // 维持 id 升序（ULID 字典序=时间序，对齐持久 store getMessages 返回顺序）
    arr.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getMessages(sessionId: string, range?: MessageRange, opts?: StoreCallOpts): Promise<MessagePage> {
    const slotKey = slotKeyOf(sessionId, opts);
    const arr = SESSION_STORES.get(slotKey) ?? [];
    const limit = range?.limit ?? 50;
    // 简化分页：forked 增量场景通常取全量（limit 大），完整 range 语义按需补
    // sorted 后续按 fromId/upToId 切片重新赋值，故用 let（reviewer minor 误改 const 致 assign 报错）
    let sorted = arr.slice().sort((a, b) => a.id.localeCompare(b.id));
    if (range?.fromId) {
      const idx = sorted.findIndex((m) => m.id === range.fromId);
      if (idx >= 0) sorted = sorted.slice(idx);
    }
    if (range?.upToId) {
      const idx = sorted.findIndex((m) => m.id === range.upToId);
      if (idx >= 0) sorted = sorted.slice(0, idx + 1);
    }
    if (range?.beforeId) {
      const idx = sorted.findIndex((m) => m.id === range.beforeId);
      const cut = idx >= 0 ? idx : sorted.length;
      const window = sorted.slice(0, cut);
      return {
        items: window.slice(-limit),
        hasMore: window.length > limit,
      };
    }
    return {
      // [v0.0.185] takeFromStart：取范围头部 limit 条（缺省取尾部），对齐持久 store
      items: range?.takeFromStart ? sorted.slice(0, limit) : sorted.slice(-limit),
      hasMore: sorted.length > limit,
    };
  }

  /**
   * getSummary 恒返 null（design §1.2）。
   * forked 无 compact summary → summary.version 永远 null → 永远 append 复用 prevSnapshot，
   * 不触发 rebuild。纯数据驱动，无 isForked 判断。
   */
  async getSummary(_sessionId: string): Promise<SummaryInfo | null> {
    return null;
  }

  /** forked 不学 ratio（旁路无 session 级别 usage 累计），返 1.0 冷启动默认 */
  async getRatio(_sessionId: string): Promise<number> {
    return 1.0;
  }

  /** forked 不持久化 usage 也不推送（旁路无污染主对话 meta、零推送），no-op */
  async updateUsage(
    _sessionId: string,
    _opts: UpdateUsageOpts,
  ): Promise<void> {
    // 故意 no-op
  }

  /**
   * [v0.0.83] 释放 forked run 的内存 buffer 桶（RunLoopHandle.start() finally 经 clearScopeSession 调）。
   * 按 opts.runId 释放（per-run 隔离）。释放内存 + 防 sibling 混桶。幂等。
   * 注：与 SessionStore.clearSession（删整 session 返 Session）语义不同——本方法仅释放 forked 内存桶。
   */
  async releaseSlot(sessionId: string, opts?: StoreCallOpts): Promise<void> {
    releaseInMemorySlot(slotKeyOf(sessionId, opts));
  }
}
