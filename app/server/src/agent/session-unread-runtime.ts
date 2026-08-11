/**
 * SessionUnreadRuntime — session 层未读自治运行时（v0.0.27 修订核心）
 *
 * 参考:
 *   - specs/tech/agent/session/[P0]session_state.md §4.4 / §6.2 / §6.3（归属层=session 层 + 不变量）
 *   - specs/tech/version_logs/v0.0.27/unread-model-decision.md §6（归属层决策 + event-driven + reconcile 豁免）
 *   - specs/tech/agent/session/[P0]session_event.md §2/§3（session_status_update 触发时机）
 *   - specs/tech/app/frontend/[P0]sse_channel.md §10.4 / decision.md §5（session_meta broadcaster 注入）
 *
 * 设计（关注点分离，spec unread-model-decision.md §6 不变量）：
 *   - **agent-loop = 干活的**：只调 markIdle/markError（不碰 unread/SSE/前台，已还原）
 *   - **状态机 = 纯 CAS**：只做状态转换 + emit session_status_update completion 信号（零改动）
 *   - **session 层（本运行时）= 自治**：订阅 completion 信号（state∈{idle,error}）→ 查
 *     SseChannel.isSessionActive(sid) → 非前台 → markUnreadTrue（产生未读）
 *
 * 触发机制（event-driven，spec unread-model-decision.md §6.1 选项 b）：
 *   复用既有 session_status_update 事件（状态机每次 CAS 成功已 emit），零额外协议、零状态机接口改动。
 *   本运行时是普通订阅者——通过 EventBusLike 包装层 fan-out 拿到所有 group 的 session_status_update。
 *
 * [v0.0.27] session_meta 广播：本运行时在 markUnreadTrue CAS 成功后**直接调** broadcaster.broadcast(sid)
 * （产生路径不经 statusBus，runtime 自治触发 meta 广播，spec decision.md §5）。
 *
 * 三种 no-op 情形（spec session_state.md §4.4）：
 *   - 前台完成（isSessionActive=true）→ 不置 unread
 *   - 非完成 state（running/interrupting/interrupted）→ 忽略（仅 idle/error 算完成）
 *   - 崩溃恢复 reconcile——靠注册时机豁免（见 bootstrap：reconcile 后才注册本运行时）
 */
import type { CompositeStore } from '../persistence/composite';
import type { SessionPresenceProbe } from '../sse/sse-channel';
import type { SessionStatusUpdateEvent, SessionEvent } from './session-event-types';
import { markUnreadTrue } from './session-unread-ops';
import type { SessionMetaBroadcaster } from './session-meta-broadcaster';
// [v0.0.305] squad 层聚合 meta 广播器（wrap fan-out 触发类型集合内 → broadcast）
import type { SquadMetaBroadcaster } from '../squad/squad-meta-broadcaster';

/**
 * 完成信号监听器：session 层收到 session_status_update(state∈{idle,error}) 时回调。
 * 抽出接口便于：①测试注入 stub；②解耦运行时不依赖完整 Event 类型。
 */
export interface CompletionListener {
  /** 收到 completion 事件（仅 state∈{idle,error}） */
  onSessionComplete(event: SessionStatusUpdateEvent): void;
}

/** SessionUnreadRuntime 构造参数 */
export interface SessionUnreadRuntimeOptions {
  // [v0.0.38 T4] crud 类型由 CrudStore 收紧为 CompositeStore（透传给 markUnreadTrue）
  crud: CompositeStore;
  presenceProbe: SessionPresenceProbe;
  /**
   * [v0.0.27] session meta 广播器（可选注入）。
   * markUnreadTrue CAS 成功后直调 broadcaster.broadcast(sid)（产生路径不经 statusBus）。
   * 缺省 undefined → 不广播（测试 / 旧路径兼容）。
   */
  metaBroadcaster?: SessionMetaBroadcaster;
}

/**
 * SessionUnreadRuntime — 未读自治运行时（session 层）。
 *
 * 生命周期：
 *   - bootstrap 创建时构造本运行时（enabled=false），wrapStatusBusForUnread 注入到 store
 *   - reconcileOnStartup() 在 enabled=false 期间执行 → reconcile 的 session_status_update
 *     被 fan-out 到运行时但被 enabled 标志挡住 → 不产生未读（reconcile 豁免，spec 不变量 4）
 *   - reconcile 完成后 bootstrap 调 start() 置 enabled=true → 后续 completion 信号正常处理
 */
export class SessionUnreadRuntime {
  // [v0.0.38 T4] crud 类型由 CrudStore 收紧为 CompositeStore（透传给 markUnreadTrue）
  private readonly crud: CompositeStore;
  private readonly presenceProbe: SessionPresenceProbe;
  /** [v0.0.27] meta 广播器（产生路径不经 statusBus，runtime 直调） */
  private readonly metaBroadcaster?: SessionMetaBroadcaster;
  /** 是否已启用（reconcile 期间 false → 豁免；reconcile 后 true → 正常响应） */
  private enabled = false;

  constructor(opts: SessionUnreadRuntimeOptions) {
    this.crud = opts.crud;
    this.presenceProbe = opts.presenceProbe;
    this.metaBroadcaster = opts.metaBroadcaster;
  }

  /**
   * 启用运行时（reconcile 完成后 bootstrap 调用）。
   * 启用前的 completion 事件被忽略（实现 reconcile 豁免，spec 不变量 4）。
   */
  start(): void {
    this.enabled = true;
  }

  /**
   * 处理 statusBus 上收到的任意 SessionEvent（仅 session_status_update + state∈{idle,error}
   * 触发未读产生逻辑；其他类型/状态 no-op）。
   *
   * 触发链路（spec unread-model-decision.md §6）：
   *   agent-loop.markIdle/markError → 状态机 CAS + emit session_status_update
   *   → statusBus → wrapStatusBusForUnread fan-out → 本方法
   *   → isSessionActive(sid)=false → markUnreadTrue(sid)（CAS unread: false→true）
   *   → [v0.0.27] CAS 成功后直调 metaBroadcaster.broadcast(sid)（产生路径触发 meta 广播）
   *
   * enabled=false 时（reconcile 期间）直接 no-op——豁免崩溃恢复路径（spec §4.4 no-op 情形 3）。
   */
  handleSessionEvent(event: SessionEvent): void {
    if (!this.enabled) return; // reconcile 豁免（spec §6.3 不变量 4）
    // 仅响应 completion 信号（idle/error 算完成，spec §4.4 no-op 情形 2：其他 state 忽略）
    if (event.type !== 'session_status_update') return;
    const status = event.data;
    if (status.state !== 'idle' && status.state !== 'error') return;

    const sid = event.sessionId;
    // 前台判定（spec §6.2）：前台完成 no-op（spec §4.4 no-op 情形 1）
    if (this.presenceProbe.isSessionActive(sid)) return;

    // 非前台 → 产生未读 CAS（spec §4.4 timing「产生」+ §6.3 不变量 3）
    // markUnreadTrue 内部幂等保护（CAS WHERE unread=false），异常吞掉不影响主流程
    void markUnreadTrue(this.crud, sid)
      .then((changed) => {
        // [v0.0.27] CAS 成功（false→true 真实改写）后直调 broadcaster.broadcast(sid)
        // 产生路径不经 statusBus，由 runtime 自治触发 meta 广播（spec decision.md §5）
        if (changed && this.metaBroadcaster) {
          this.metaBroadcaster.broadcast(sid);
        }
      })
      .catch(() => {
        // CAS 失败（session 不存在 / 已是 true / store 异常）：no-op，下次 completion 再试
      });
  }
}

/** statusBus 最小依赖接口（emit 入口被 wrap 拦截 fan-out） */
interface StatusBusLike {
  emit: (group: string, event: { data: unknown; timestamp: string }) => void;
}

/** wrapStatusBusForUnread 选项（metaBroadcaster 可选） */
export interface WrapStatusBusOptions {
  /** [v0.0.27] session meta 广播器（statusBus 任意 session 事件触发 broadcast） */
  metaBroadcaster?: SessionMetaBroadcaster;
  /** [v0.0.305] squad 聚合 meta 广播器（触发类型集合内 → 路由 squadId → broadcast） */
  squadMetaBroadcaster?: SquadMetaBroadcaster;
}

/**
 * 包装 statusBus 的 emit：委托给原 bus（hub/前端正常订阅），同时 fan-out 给 session 层消费者。
 *
 * [v0.0.27] 泛化：原本仅 fan-out 给 SessionUnreadRuntime（未读产生），现同时 fan-out 给
 * SessionMetaBroadcaster（meta 广播）。spec decision.md §5：单点捕获 statusBus，对任何经过
 * statusBus 的 session 事件（状态 CAS / summary / usage / read / clear / dir）触发 meta 广播。
 *
 * 为什么需要包装：ReplayableEventBus 是 per-group 分区的，订阅方需指定 group；
 * 但未读运行时 + meta 广播器需订阅所有 session 的信号（不预先知道 sid 列表）。
 * 包装层在 emit 入口全局 fan-out，让它们作为隐式订阅者拿到所有 session 事件。
 *
 * 返回值实现 EventBusLike，可传给 SessionStore（替换 statusBus 注入位）；
 * hub.registerTopic 仍注册原 bus（hub 端订阅/转发逻辑不变）。
 */
export function wrapStatusBusForUnread<Bus extends StatusBusLike>(
  realBus: Bus,
  runtime: SessionUnreadRuntime,
  opts: WrapStatusBusOptions = {},
): Bus {
  const realEmit = realBus.emit.bind(realBus);
  const metaBroadcaster = opts.metaBroadcaster;
  const squadMetaBroadcaster = opts.squadMetaBroadcaster;
  const wrappedBus = Object.create(realBus) as Bus;
  wrappedBus.emit = (group: string, event: { data: unknown; timestamp: string }): void => {
    // 1. 委托给原 bus：hub/前端订阅、replay buffer、其他订阅者全部照旧
    realEmit(group, event);
    // 2. fan-out 给 session 层消费者（异常吞掉不影响 emit 主路径）
    try {
      const data = event.data as SessionEvent;
      if (data && typeof data === 'object' && 'type' in data) {
        // 2a. 未读运行时（仅 session_status_update + completion state 有意义，runtime 内再过滤）
        runtime.handleSessionEvent(data);
        // 2b. [v0.0.27] meta 广播器（触发类型集合内 → broadcast，broadcaster 内再过滤）
        if (metaBroadcaster) {
          metaBroadcaster.handleSessionEvent(data);
        }
        // 2c. [v0.0.305] squad 聚合 meta 广播器（触发类型集合内 → 路由 squadId → broadcast）
        if (squadMetaBroadcaster) {
          squadMetaBroadcaster.handleSessionEvent(data);
        }
      }
    } catch {
      // fan-out 异常不影响 emit 主路径（realEmit 已成功，前端不受影响）
    }
  };
  return wrappedBus;
}
