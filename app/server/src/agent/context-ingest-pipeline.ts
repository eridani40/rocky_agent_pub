/**
 * ContextEngine ingest 路径（v0.0.16 从 context-engine.ts 拆出，满足 ≤300 行约束）
 * 参考: specs/tech/agent/context_and_memory/[P0]context_engine.md §3
 *       specs/tech/agent/context/[P0]context_ingest_detail.md §3
 *       specs/tech/agent/context/[P0]system_reminder.md §4
 *       specs/tech/squad/[P1]squad_reminder_providers.md §1（ReminderCtx 扩展）
 *
 * 职责：
 *   - 跑 context_ingest_handler ordered 链（按 effective order 升序，1..n）→ 链尾固定 appendMessages
 *   - 跑 system_reminder provider 链聚合 reminder（injector handler 用）
 * 无 pluginManager 或链空 → 回退 v0.0.8 行为（直接 append / 不注入 reminder）。
 *
 * [v0.0.33.3] 扩展 ReminderCtx：可选注入 squadContext service + transcriptReader，
 * 供 squad_agents_status provider 读 store 动态数据 + 做去重。
 * 由 ContextEngine.ingest 构造期按 config.sessionType/squadId/sessionId 注入（生产路径）；
 * UT fixture 不注入 → provider 降级不产出（向后兼容）。
 *
 * [v0.0.66 §2.7] 删 ctx.buffer 字段 + applyIngestPipeline 删 buffer 参数（store 扩展点取代）。
 *   forked 不再传 buffer 数组——store_sink 统一（store 扩展点按 scope 切实现：default 写持久 /
 *   forked 写内存）。buffer_sink impl 已删（design §2.4），ingest 链尾只剩 store_sink
 *   （default + forked 都走 store_sink 写各自 scope 选中的 store）。
 */
import type { Message, MessageInput } from '../message/types';
import type { SessionConfig } from './context-types';
import type { SessionStore } from './session-store';
import type { StoreCallOpts } from './session-store-types';
import type { PluginManager } from '../plugin/plugin-manager';
import {
  ContextIngestHandlerPoint,
  SystemReminderPoint,
} from '../plugin/extension-point';

/**
 * ingest handler 契约（context_ingest_detail.md §3）。
 * [v0.0.49 D15] 返回放宽为 `Message[] | Promise<Message[]>`（store_sink 需 await async appendMessages）；
 *   ctx 加 store（default scope 的 store 汇，store_sink handler 用）。
 * [v0.0.66 §2.7] ctx 删 buffer 字段（buffer_sink impl 删除，store 扩展点取代）。
 */
interface IngestHandler {
  handle(
    messages: Message[],
    ctx: {
      config: SessionConfig;
      reminderRunner?: (ctx: unknown) => unknown[];
      /** [v0.0.49 D15] default scope 的 store 汇（store_sink handler 用） */
      store?: SessionStore;
      /** [v0.0.83] store 调用 opts（runId 等）；store_sink 透传到 appendMessages */
      opts?: StoreCallOpts;
    },
  ): Message[] | Promise<Message[]>;
}
/** system_reminder provider 契约（system_reminder.md §2 + v0.0.33.3 squad_reminder_providers §1 扩展） */
interface SystemReminderProvider {
  provide(ctx: {
    config: SessionConfig;
    /** [v0.0.33.3] squad 上下文 service（生产注入；UT 不注入） */
    squadContext?: unknown;
    /** [v0.0.33.3] transcript 读取器（生产注入；UT 不注入） */
    transcriptReader?: unknown;
    /** [v0.0.223] TodoStore 句柄（生产注入；UT 不注入 → todo provider 不产出） */
    todoStore?: unknown;
  }): Promise<{ id: string; content: string; tier?: string }[]> | { id: string; content: string; tier?: string }[];
}

/**
 * 跑 system_reminder provider 链聚合 reminder（system_reminder.md §4）。
 * 无 pluginManager 或链空 → 返回空数组（不注入 reminder）。
 * 单 provider 失败降级为「不贡献」，不中断整个链（system_prompt §9.4 同策略）。
 *
 * [v0.0.33.3] 注入 squadContext + transcriptReader（可选，由 caller 提供；缺省 undefined）。
 * 修前 sync 调 p.provide() 对 async provider（squad_agents_status 读 store）会拿到 Promise
 * 而非数组 → for...of 报错；async 化处理（applyIngestPipeline 整体 async）。
 *
 * [v0.0.40 D1=B] scopeId 透传到 getExtensionImpls（forked scope 可 disable reminder provider）。
 */
export async function runReminderProviders(
  pluginManager: PluginManager | null,
  config: SessionConfig,
  extras?: { squadContext?: unknown; transcriptReader?: unknown; todoStore?: unknown },
  scopeId: string = 'default',
): Promise<{ id: string; content: string; tier?: string }[]> {
  if (!pluginManager) return [];
  const providers = pluginManager.getExtensionImpls<SystemReminderProvider>(
    SystemReminderPoint,
    scopeId,
  );
  if (providers.length === 0) return [];
  const ctx = {
    config,
    ...(extras?.squadContext !== undefined ? { squadContext: extras.squadContext } : {}),
    ...(extras?.transcriptReader !== undefined ? { transcriptReader: extras.transcriptReader } : {}),
    ...(extras?.todoStore !== undefined ? { todoStore: extras.todoStore } : {}),
  };
  const out: { id: string; content: string; tier?: string }[] = [];
  for (const p of providers) {
    try {
      const rs = await p.provide(ctx);
      for (const r of rs) out.push(r);
    } catch {
      // 降级：跳过此 provider
    }
  }
  return out;
}

/**
 * 经 ingest handler 链处理 messages（[v0.0.13] context_ingest_handler ordered）。
 * 无 pluginManager 或链空 → 返回原 messages（v0.0.8 行为）。
 *
 * [v0.0.33.3] caller 可传 squadContext/transcriptReader（生产由 ContextEngine.ingest 注入）。
 * reminderRunner 闭包返回**预 resolve 的 reminders 数组**（非 Promise）—— handler 端无需再 await runner（v0.0.49 后 handle 契约虽允许 async，runner 保持 sync 仍更简单）。
 *
 * [v0.0.40 D1=B] scopeId 透传到 getExtensionImpls（forked scope 激活 buffer_sink，default 不激活）。
 * [v0.0.66 §2.7] 删 buffer 参数——buffer_sink impl 已删，store 扩展点取代。forked scope 也走 store_sink
 *   写内存 store（store 扩展点按 scope 切实现，ContextEngine 注入 EP-selected store）。
 *
 * [v0.0.49 D15] store 汇 EP 化：default scope 注入 store → chain 尾 store_sink 写 transcript
 *   （替代 ContextEngine 原 `if scopeId !== FORKED` 硬尾）。**降级路径**（无 pluginManager / 空链）
 *   保留 v0.0.8 行为：注入 store 的 scope（default）在此直接 append 落库；无 store（forked）no-op。
 *   注：正常链路（handlers 非空）由 store_sink handler 落库，不走此降级——避免双写。
 *
 * @returns 链处理后 finalMessages（store_sink 写 store：default 持久 / forked 内存）
 */
export async function applyIngestPipeline(
  pluginManager: PluginManager | null,
  config: SessionConfig,
  messages: MessageInput[],
  extras?: { squadContext?: unknown; transcriptReader?: unknown; todoStore?: unknown },
  scopeId: string = 'default',
  store?: SessionStore,
  opts?: StoreCallOpts,
): Promise<Message[]> {
  const finalMessages: Message[] = messages as unknown as Message[];
  // 无 pluginManager 降级（v0.0.8）：注入 store 的 scope 直 append；无 store（forked）不写
  if (!pluginManager) {
    if (store) await store.appendMessages(config.sessionId, finalMessages as MessageInput[], opts);
    return finalMessages;
  }
  // [v0.0.33.3] 预先 await reminders（provider 可能 async）→ 注入 sync runner（保 handle 同步契约）
  const reminders = await runReminderProviders(pluginManager, config, extras, scopeId);
  const reminderRunner = (_ctx: unknown): { id: string; content: string; tier?: string }[] => reminders;
  const handlers = pluginManager.getExtensionImpls<IngestHandler>(
    ContextIngestHandlerPoint,
    scopeId,
  );
  // 空链降级：同无 pluginManager（注入 store 的 scope 直 append，chain 尾 sink 未激活）
  if (handlers.length === 0) {
    if (store) await store.appendMessages(config.sessionId, finalMessages as MessageInput[], opts);
    return finalMessages;
  }
  const ctx: {
    config: SessionConfig;
    reminderRunner: (ctx: unknown) => { id: string; content: string; tier?: string }[];
    store?: SessionStore;
    opts?: StoreCallOpts;
  } = {
    config,
    reminderRunner,
    // store 由 ContextEngine.resolveStore(scopeId) 选 EP impl 注入（default→persistent /
    //   forked→in_memory）；store_sink handler 读它写各自 store（chain 尾生效）。
    ...(store !== undefined ? { store } : {}),
    // [v0.0.83] opts 透传给 store_sink → appendMessages（runId 等）
    ...(opts !== undefined ? { opts } : {}),
  };
  let acc: Message[] = finalMessages;
  for (const h of handlers) {
    // [v0.0.49 D15] await：兼容 async sink（store_sink）与 sync handler（truncate）
    acc = await h.handle(acc, ctx);
  }
  return acc;
}
