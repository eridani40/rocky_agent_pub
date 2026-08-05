/**
 * AgentManager children 追踪 + deliverTo wrapper + abort 级联 + running 并发上限（v0.0.28 task-2）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md
 *   - §4 spawn 执行流程（manager.children.get(parent).add(child)）
 *   - §4.1 deliverTo 统一投递入口（inbox.append + activate，只需 sessionId，不碰 config）
 *   - §3.1 running 并发上限（全局 sub / 单 parent sub，activate 前 check，超限拒）
 *   - §6 abort 单向级联（parent abort finalize 时遍历 in-flight child 级联；child 挂不连坐 parent）
 *
 * 设计：本模块是 AgentManagerImpl 的 helper（拆分 ≤300 行约束）。
 *   - children map 是运行态追踪（非持久，崩溃靠 state reconcile）
 *   - deliverTo 是 wrapper：内部调 enqueue + activate 旧签名（spec 标重构方向 TBD，本版只收敛调用）
 *   - abort 级联是 finalize 钩子（manager.abort(parent) 完成后遍历 children）
 *
 * 单文件 ≤300 行（helper + 纯函数）。
 */
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { Message } from '../message/types';
import type { AgentRun, AbortResult } from './agent-interface';
import { enrichForInbox, type EnrichSessionLookup } from './inbox-enrich';

/**
 * running 并发上限默认值（derivation §3.1，O5 三限）。
 * 三限制相互独立：全局主 / 全局 sub / 单 parent sub。
 * 缺省值（spec TBD，本版定 8/8/4 留余量，可后续按负载调）。
 */
export const LIMIT_GLOBAL_MAIN = 8;
export const LIMIT_GLOBAL_SUB = 8;
export const LIMIT_PER_PARENT_SUB = 4;

/**
 * 并发超限错误（activate 前 check 命中时 throw；spawn/send_message 路径捕获转 tool error）。
 * 对齐 derivation §3.1：已定 A=caller/LLM 重试（拒，不排队）。
 */
export class ConcurrencyLimitError extends Error {
  constructor(
    public readonly which: 'global_main' | 'global_sub' | 'per_parent_sub',
    message: string,
  ) {
    super(message);
    this.name = 'ConcurrencyLimitError';
  }
}

/**
 * AgentManager 的 children 运行追踪容器（运行态 + 刚结束待清理；非持久）。
 * parentSid → Set<childSid>（spawn 时 add，run settle 时 delete）。
 *
 * abort 级联用：manager.abort(parent) finalize 时遍历 set 中 state='running' 的 child。
 */
export class ChildrenTracker {
  private readonly map = new Map<string, Set<string>>();

  /** 注册 child（spawn 调用） */
  track(parentSid: string, childSid: string): void {
    let bucket = this.map.get(parentSid);
    if (!bucket) {
      bucket = new Set();
      this.map.set(parentSid, bucket);
    }
    bucket.add(childSid);
  }

  /** 注销 child（run settle 调用；idempotent） */
  untrack(parentSid: string, childSid: string): void {
    const bucket = this.map.get(parentSid);
    if (!bucket) return;
    bucket.delete(childSid);
    if (bucket.size === 0) this.map.delete(parentSid);
  }

  /** 列出某 parent 下所有已追踪的 child sessionId（级联 abort 用） */
  trackedOf(parentSid: string): string[] {
    const bucket = this.map.get(parentSid);
    return bucket ? [...bucket] : [];
  }

  /** 单 parent sub 计数（running limit check 用） */
  perParentCount(parentSid: string): number {
    return this.map.get(parentSid)?.size ?? 0;
  }

  /** 全部 tracked child 数（全局 sub limit check 用） */
  globalSubCount(): number {
    let total = 0;
    for (const bucket of this.map.values()) total += bucket.size;
    return total;
  }
}

/**
 * deliverTo wrapper 依赖的最小接口（注入 enqueue + activate 新签名 + enrichForInbox）。
 *
 * [v0.0.31 去 config 重构] ops 不再持 resolveConfig（manager 内部封装 resolveConfigBySid）；
 *   enqueue/activate 改新签名 `(sessionId, ...)` / `(sessionId)`。
 *   caller（spawn / send_message）调 deliverTo 不碰 config。
 *
 * 注：enrichForInbox 由 deliverTo 内部调（source='agent' 反查补全 sender.agent.ref）。
 *     Task2 落地 enrichForInbox；Task4 本模块先持可选 enrich hook，缺省 identity passthrough。
 */
export interface DeliverToDeps {
  /** 新签名 enqueue（入 inbox + 分配 enqueueId + emit message_enqueued） */
  enqueue(sessionId: string, messages: Message[]): Promise<string[]>;
  /** 新签名 activate（三情况 dispatch，返 AgentRun） */
  activate(sessionId: string): Promise<AgentRun>;
}

/**
 * deliverTo —— 统一投递入口（derivation §4.1）。
 * 只需 sessionId + message：enqueue(sessionId, [msg]) + activate(sessionId) → AgentRun。
 * 不碰 config（target session 自己组建 system prompt，manager 内部 resolveConfigBySid）。
 *
 * [v0.0.31 task-2 enrich] 注入 enrichLookup 时，enqueue 前先调 enrichForInbox(message, lookup)
 *   对 source='agent' 的 message normalize（反查补全 sender.agent.ref type/name + needReply 必填）。
 *   详见 [P0]agent_inbox_enqueue.md §2.5 / §3。enrichLookup 缺省（undefined）时不 enrich
 *   （纯 helper 调用 / 测试场景）；manager.deliverTo 走 managerDeliverTo 总是注入 lookup。
 *
 * @param deps        enqueue/activate 新签名注入
 * @param sessionId   target session
 * @param message     要投递的消息（spawn 首任务 / a2a send_message）
 * @param enrichLookup 可选——反查发送方 session record 用（注入则 enrich，缺省 passthrough）
 * @returns AgentRun（caller 可 await run.promise 拿 RunResult，或忽略 fire-and-forget）
 */
export async function deliverTo(
  deps: DeliverToDeps,
  sessionId: string,
  message: Message,
  enrichLookup?: EnrichSessionLookup,
): Promise<AgentRun & { enqueueId: string }> {
  // enrich 在 enqueue 前：所有进 inbox 的 a2a message 必经（[P0]agent_inbox_enqueue.md §3）
  const enriched = enrichLookup
    ? await enrichForInbox(message, enrichLookup)
    : message;
  // [v0.0.97] 捕获 enqueueId 透传给 caller（POST /messages 返 enqueueId，前端可乐观渲染排队项 + cancel 用）
  const enqueueIds = await deps.enqueue(sessionId, [enriched]);
  const run = await deps.activate(sessionId);
  return { ...run, enqueueId: enqueueIds[0] ?? '' };
}

/**
 * abort 级联钩子依赖（abort(parent) finalize 后调本函数遍历 in-flight child）。
 * child 用独立 controller（D6 单向——child 挂不连坐 parent）。
 */
export interface CascadeAbortDeps {
  /** 中断指定 child（manager.abort(childSid, childRunId, 'current')） */
  abortChild(childSid: string): Promise<AbortResult>;
  /** 读 child 当前 state（判定是否 in-flight = running/interrupting） */
  getChildState(childSid: string): Promise<'idle' | 'running' | 'interrupting' | 'interrupted' | 'error' | null>;
}

/**
 * abort 级联：parent 被 abort 时遍历 in-flight child 级联中断（derivation §6）。
 * 传递性：manager.abort(child) 完成后本函数递归（级联到 grandchild）。
 * child 自身 abort/error 不级联 parent（单向，调用方约束——本函数仅从 parent 向下）。
 *
 * @param tracker  children 追踪容器
 * @param deps     abortChild / getChildState 注入
 * @param parentSid 被中断的 parent
 */
export async function cascadeAbortChildren(
  tracker: ChildrenTracker,
  deps: CascadeAbortDeps,
  parentSid: string,
): Promise<void> {
  const childSids = tracker.trackedOf(parentSid);
  if (childSids.length === 0) return;
  // 并发级联各 child（child 间独立，互不阻塞）
  await Promise.all(
    childSids.map(async (childSid) => {
      const st = await deps.getChildState(childSid);
      // 仅 in-flight（running/interrupting）级联；已 terminated 不动
      if (st !== 'running' && st !== 'interrupting') return;
      try {
        await deps.abortChild(childSid);
        // 传递性：abortChild 内部 finalize 会再触发 cascadeAbortChildren(childSid)
        // → 级联到 grandchild…直到无 in-flight 后代（全树收尾）
      } catch {
        // 单 child 级联失败不阻断其他 child（best-effort；tracker 在 run settle 时清）
      }
    }),
  );
}

/**
 * running 并发上限 check（derivation §3.1 三限）。
 * 激活 sub-agent 前调本函数：同时满足「全局 sub 未满」+「该 parent sub 未满」。
 * 激活主 session 调 checkMainLimit：「全局主未满」。
 * 超限 throw ConcurrencyLimitError（caller 转 tool error / HTTP 429）。
 *
 * @param tracker    children 追踪容器
 * @param childType  child session.type（'subagent'=计数 sub 限；其他=计数 main 限）
 * @param parentSid  parent sessionId（per-parent sub 计数用）
 */
export function checkRunningLimit(
  tracker: ChildrenTracker,
  childType: 'subagent' | 'main',
  parentSid: string,
): void {
  if (childType === 'subagent') {
    if (tracker.globalSubCount() >= LIMIT_GLOBAL_SUB) {
      throw new ConcurrencyLimitError(
        'global_sub',
        `running sub-agent limit reached (${LIMIT_GLOBAL_SUB})`,
      );
    }
    if (tracker.perParentCount(parentSid) >= LIMIT_PER_PARENT_SUB) {
      throw new ConcurrencyLimitError(
        'per_parent_sub',
        `per-parent sub-agent limit reached (${LIMIT_PER_PARENT_SUB})`,
      );
    }
  }
  // childType='main' 时全局主限由 caller 单独 check（main 不进 children tracker，
  // 计数从 store.listSessions running 数派生；本版 spawn 只产 subagent，main check 留口）
}

/**
 * deliverTo + cascadeAbort 的 manager 依赖最小接口（注入 abort + enqueue/activate 新签名）。
 * manager.deliverTo / abort 调本模块函数时构造本接口传入，避免 manager.ts 膨胀超 300 行。
 *
 * [v0.0.31 去 config 重构] ops 不再持 resolveConfig（manager 内部 resolveConfigBySid 封装）；
 *   enqueue/activate 改新签名 `(sessionId, ...)` / `(sessionId)`。
 */
export interface ManagerChildrenOps {
  /** enqueue 新签名 */
  enqueue(sessionId: string, messages: Message[]): Promise<string[]>;
  /** activate 新签名 */
  activate(sessionId: string): Promise<AgentRun>;
  /** manager.abort（cascadeAbortChildren abortChild 用） */
  abort(sessionId: string, runId: string, runKind: RunKind): Promise<AbortResult>;
  /** store.getSession（abortCascade 读 child state + child currentRunId 用） */
  getSession(sessionId: string): Promise<{ state: string; currentRunId: string | null } | null>;
  /**
   * [v0.0.31 task-2] 读完整 Session record（enrichForInbox 反查发送方 type/name 用）。
   * 与 getSession 区别：getSession 返简版（abort cascade 只需 state/runId）；
   *   getFullSession 返完整 Session（enrich 需 type/title/subAgentTemplateType）。
   *   生产环境指向同一 SessionStore.getSession。
   */
  getFullSession(sessionId: string): Promise<import('./session-store-types').Session | null>;
}

/**
 * manager.deliverTo 实现（封装在 helper 里，manager.ts 调本函数减少行数）。
 * v0.0.31：去 config 后内部直接调 ops.enqueue(sessionId) + ops.activate(sessionId)，
 *   不再 resolveConfig（manager 内部封装）。
 */
export async function managerDeliverTo(
  ops: ManagerChildrenOps,
  sessionId: string,
  message: Message,
): Promise<AgentRun & { enqueueId: string }> {
  // [v0.0.31 task-2] deliverTo 内部 enqueue 前调 enrichForInbox（source='agent' 反查补全 sender.agent.ref）。
  //   lookup 用 ops.getFullSession（生产指向 SessionStore.getSession）。
  return deliverTo(
    {
      enqueue: ops.enqueue,
      activate: ops.activate,
    },
    sessionId,
    message,
    { getSession: ops.getFullSession },
  );
}

/**
 * manager.abort 级联后处理（封装在 helper 里，manager.abort 成功后调本函数减少行数）。
 * 仅主对话（runKind='current'）+ accepted 时调：遍历 in-flight child 级联中断。
 */
export async function managerAbortCascade(
  ops: ManagerChildrenOps,
  tracker: ChildrenTracker,
  parentSid: string,
): Promise<void> {
  await cascadeAbortChildren(tracker, {
    abortChild: async (childSid) => {
      const child = await ops.getSession(childSid);
      if (!child || !child.currentRunId) {
        return { accepted: false, reason: 'no_active_controller' as const };
      }
      return ops.abort(childSid, child.currentRunId, 'main');
    },
    getChildState: async (childSid) => {
      const s = await ops.getSession(childSid);
      return (s?.state ?? null) as 'idle' | 'running' | 'interrupting' | 'interrupted' | 'error' | null;
    },
  }, parentSid);
}
