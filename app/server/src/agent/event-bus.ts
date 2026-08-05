/**
 * ReplayableEventBus — 通用发布-订阅 transport
 *
 * 参考:
 *   - specs/tech/agent/event/[P0]event_bus.md §2 §4 §5（接口 / replay 行为 / 伪代码）
 *   - specs/tech/version_logs/v0.0.8/change_log.md §7
 *
 * 设计要点：
 *   - group 之间完全隔离（独立 replay buffer + 订阅者集合）
 *   - replayable 是实例级属性（创建时定，不可改）；agent_loop topic 用 true
 *   - publish 是 fire-and-forget，不等待消费者
 *   - 多订阅者 fan-out，各自独立消费
 *   - 不感知任何业务概念（session/agent/...）—— group 只是通用分区 key
 *
 * 注意：本模块是底座，禁止 import message/session/context/tools/agent-loop。
 */

/** 流转在 bus 中的通用事件包装。data 为业务负载（如 AgentEvent），timestamp 为 ISO8601 字符串 */
export interface EventBusEvent<T> {
  data: T;
  timestamp: string;
}

/** EventBus 构造选项 */
export interface EventBusOptions {
  /** 是否启用 replay buffer（订阅时回放历史），默认 false */
  replayable?: boolean;
  /**
   * [v0.0.42] 生命周期标记 predicate（仅 replayable bus 有效，spec §2.1/§4.3）。
   * 返 true = 该 event 是「跨 ingest 边界的 run 生命周期标记」，额外写入独立 sticky slot，
   *   不被 clearReplay 清除；subscribe 时先回放 sticky 再回放 buffer。
   * 返 false = 普通 content 事件，仅走默认 buffer 行为（clearReplay 清）。
   * 不传（undefined）= bus 无 sticky 行为，clearReplay 清整个 buffer（旧行为，向后兼容）。
   *
   * 设计：通用 predicate 函数，bus 内部不感知业务 type 名（不破坏「不感知业务」原则）。
   * 仅 agent_loop topic 的 bus 注入 predicate（识别 run_start/run_end）；其他 topic 不传。
   */
  lifecyclePredicate?: (event: EventBusEvent<unknown>) => boolean;
}

/** per-group 内部状态：replay buffer + 当前订阅者集合 */
interface GroupState {
  buffer: EventBusEvent<unknown>[];
  /**
   * [v0.0.42] sticky slot：生命周期标记镜像（lifecyclePredicate 命中的 event，spec §4.3）。
   * key = event.data.type；value = 最近一次该 type 的事件。按 type 替换，保证每种 type 至多一份。
   * emit run_start 时清旧 run_start/run_end（多 run replace 语义）；clearReplay 不清。
   */
  sticky?: Map<string /* event.data.type */, EventBusEvent<unknown>>;
  /** 订阅者句柄：push 把新事件塞进各自异步队列 */
  subscribers: Set<{ push: (e: EventBusEvent<unknown>) => void }>;
}

/**
 * 可选 replay 的 EventBus 实现。
 * 照 event_bus.md §5 伪代码实现，关键修正：
 *   - async iterator 用 Promise notifier 替代 busy-wait（原伪代码 setTimeout(0) 轮询会空转 CPU）
 *   - 消费者 break 时 finally 从 subscribers 移除（cleanup，防泄漏）
 */
export class ReplayableEventBus {
  private readonly replayable: boolean;
  /** [v0.0.42] 生命周期标记 predicate（仅 replayable bus 用，spec §2.1） */
  private readonly lifecyclePredicate?: (e: EventBusEvent<unknown>) => boolean;
  private readonly groups: Map<string, GroupState> = new Map();

  constructor(options?: EventBusOptions) {
    this.replayable = options?.replayable ?? false;
    // [v0.0.42] 生命周期标记 predicate（实例级，构造时定；undefined = 旧行为零回归）
    this.lifecyclePredicate = options?.lifecyclePredicate;
  }

  /** 是否启用 replay（只读） */
  isReplayable(): boolean {
    return this.replayable;
  }

  /**
   * 向指定 group 发布事件
   * - replayable：事件写入该 group 的 buffer（若 lifecyclePredicate 命中，同时写 sticky slot），并推送给订阅者
   * - non-replayable：仅推送给当前订阅者
   *
   * [v0.0.42] lifecyclePredicate 命中（且 event 有 type 字段）→ 写 sticky slot（spec §4.3），**不进 content buffer**：
   *   - 按 event.data.type 替换，保证每种 type 至多一份（典型 run_start + run_end 各一份）
   *   - emit run_start 时先清旧 sticky 内的 run_start/run_end（多 run replace 语义：
   *     连续 run 时 sticky 只含最新一组 run_start [run_end?]，无旧 run 噪音）
   *   - sticky-exclusive（不进 buffer）：sticky 已持有该事件供 subscribe replay，
   *     再进 buffer 会让 subscribe（先 sticky 后 buffer）回放两次 → run_start 重复。
   *     非 sticky 事件（content delta）才进 buffer。
   */
  emit<T>(group: string, event: EventBusEvent<T>): void {
    const state = this.getOrCreateGroup(group);
    if (this.replayable) {
      const ev = event as EventBusEvent<unknown>;
      // [v0.0.42] 探测 event.data.type（业务 event 都有 type 字段，但 bus 通用不强制）
      const dataType = (ev.data as { type?: string } | null | undefined)?.type;
      if (this.lifecyclePredicate && dataType && this.lifecyclePredicate(ev)) {
        // sticky-exclusive：predicate 命中 → 只写 sticky slot + 推 live 订阅者，不进 content buffer
        if (!state.sticky) state.sticky = new Map();
        // run_start 特殊：清旧 sticky 内的 run_start/run_end（spec §4.3/§5 多 run replace 语义）
        if (dataType === 'run_start') {
          state.sticky.delete('run_start');
          state.sticky.delete('run_end');
        }
        state.sticky.set(dataType, ev);
      } else {
        // 非 sticky 事件（content delta）进 buffer（clearReplay 清）
        state.buffer.push(ev);
      }
    }
    // fan-out：每个订阅者独立队列，互不干扰
    for (const sub of state.subscribers) {
      sub.push(event as EventBusEvent<unknown>);
    }
  }

  /** （测试/诊断用）返回某 group 当前 replay buffer 事件数 */
  bufferLen(group: string): number {
    return this.groups.get(group)?.buffer.length ?? 0;
  }

  /**
   * 订阅指定 group，返回 AsyncIterable。
   * - replayable：先回放该 group 的 buffer，再收新事件
   * - non-replayable：只收订阅之后的新事件
   * 消费者 for-await 循环 break/return 时自动从 subscribers 移除（防泄漏）。
   *
   * 唤醒语义：
   *   - 正常事件走 emit → push 进队列 + resolve notifier；
   *   - 外部「唤醒但不发事件」（cancel 哨兵场景）走 wakePendingSubscribers：
   *     只 resolve notifier、不 push、不写 replay buffer。
   *     消费者被唤醒后见 queue 仍空 + wokenClosed 即返回 done（见 next() 实现）。
   */
  subscribe<T>(group: string): AsyncIterable<EventBusEvent<T>> {
    const state = this.getOrCreateGroup(group);

    // 订阅者的本地队列 + notifier：emit 推入队列 → resolve notifier 唤醒消费者
    const queue: EventBusEvent<T>[] = [];
    let notifier: (() => void) | null = null;
    // 订阅者级「已唤醒关闭」标志：wakePendingSubscribers 置位后，next() 返回 done
    let wokenClosed = false;

    // replayable 时先把 sticky + buffer 历史事件灌入队列（先回放再收新）
    if (this.replayable) {
      // [v0.0.42] 先回放 sticky slot（生命周期标记），再回放 content buffer（spec §2.2/§4.3）：
      //   保证 reducer 先翻 runActive、再处理 content delta（message_start / text_delta / ...）
      //   Map 迭代为插入序：run_start → run_end（emit 时序决定），无需额外排序
      if (state.sticky) {
        for (const e of state.sticky.values()) {
          queue.push(e as EventBusEvent<T>);
        }
      }
      for (const e of state.buffer) {
        queue.push(e as EventBusEvent<T>);
      }
    }

    const subscriber = {
      push: (e: EventBusEvent<unknown>) => {
        queue.push(e as EventBusEvent<T>);
        if (notifier) {
          const resolve = notifier;
          notifier = null;
          resolve();
        }
      },
      /** 唤醒（不发事件）：置 wokenClosed + resolve notifier。不写 buffer、不入队列。 */
      wake(): void {
        wokenClosed = true;
        if (notifier) {
          const resolve = notifier;
          notifier = null;
          resolve();
        }
      },
    };
    state.subscribers.add(subscriber);

    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<EventBusEvent<T>>> {
            while (queue.length === 0) {
              if (wokenClosed) {
                // 被外部唤醒且无 pending 事件 → 优雅结束（不污染 buffer）
                return { value: undefined as unknown as EventBusEvent<T>, done: true };
              }
              // 队列空：等下一个 emit 唤醒，避免忙等
              await new Promise<void>((resolve) => {
                notifier = resolve;
              });
            }
            return { value: queue.shift()!, done: false };
          },
          async return(): Promise<IteratorResult<EventBusEvent<T>>> {
            // 消费者提前 break：清理订阅者句柄，防泄漏
            self.cleanup(state, subscriber);
            return { value: undefined as unknown as EventBusEvent<T>, done: true };
          },
        };
      },
    };
  }

  /**
   * 唤醒指定 group 所有订阅者的 pending next()（不发事件、不写 replay buffer）。
   * 用途：EventHub.cancel 需要让阻塞在 iter.next() 的消费者退出，但不能污染 replay buffer
   *（旧实现用 emit({data:undefined}) 哨兵，会把 undefined 写进 buffer，导致紧随的新 sub
   * 回放出 data:undefined 伪事件——直连 hub.sub 的消费者如 SseChannel 无兜底会收坏帧）。
   *
   * 语义保证（v0.0.10）：
   *   ① 被唤醒的消费者 next() 返回 done（见 subscribe 内 wokenClosed 分支）；
   *   ② replay buffer 不变（不 push、不清空）；
   *   ③ 多订阅者 fan-out：遍历当前 subscribers 全部唤醒。
   */
  wakePendingSubscribers(group: string): void {
    const state = this.groups.get(group);
    if (!state) return;
    for (const sub of state.subscribers) {
      // subscriber 句柄窄接口只在 subscribe 内部扩展了 wake；此处运行时探测调用
      const s = sub as { push: (e: EventBusEvent<unknown>) => void; wake?: () => void };
      if (typeof s.wake === 'function') {
        s.wake();
      }
    }
  }

  /**
   * 清空指定 group 的 replay buffer（仅 replayable 有效）
   * - 不产生事件、不影响已订阅者
   * - 之后新订阅的消费者从此刻开始回放
   */
  clearReplay(group: string): void {
    if (!this.replayable) return;
    const state = this.groups.get(group);
    if (state) {
      state.buffer = [];
      // [v0.0.42] 不清 sticky slot（spec §2.2/§4.3）：lifecyclePredicate 命中的生命周期标记
      //   跨 ingest 边界存活，切走切回重订阅时可恢复 runActive。sticky 由 emit 时的 replace
      //   语义维护（新 run_start 替换旧 run_start+run_end）。无 lifecyclePredicate 时本就无 sticky。
    }
  }

  /** （测试/诊断用）返回某 group 当前订阅者数量 */
  subscriberCount(group: string): number {
    return this.groups.get(group)?.subscribers.size ?? 0;
  }

  private getOrCreateGroup(group: string): GroupState {
    let state = this.groups.get(group);
    if (!state) {
      state = { buffer: [], subscribers: new Set() };
      this.groups.set(group, state);
    }
    return state;
  }

  private cleanup(state: GroupState, subscriber: { push: (e: EventBusEvent<unknown>) => void }): void {
    state.subscribers.delete(subscriber);
  }
}
