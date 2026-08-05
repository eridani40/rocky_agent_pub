/**
 * EventHub — 全局 singleton 事件路由表
 *
 * 参考:
 *   - specs/tech/agent/event/[P0]event_hub.md §2 §3 §4（接口 / 内部 Map / 创建管理）
 *   - specs/tech/agent/event/[P0]event_bus.md（replay 语义权威——每 sub 独立 replay + 实时）
 *   - specs/tech/version_logs/v0.0.207/change_plan.md（去两层去重恢复 per-sub 独立语义）
 *
 * 设计要点：
 *   - 系统唯一一个实例（EventHub.singleton()）
 *   - Map<topic, EventBus>：每 topic 一个 bus 实例（per-topic），bus 内按 group 分区
 *   - 订阅方只要 (topic, group) 就能收事件，不需要持有 bus 实例（hub 去耦）
 *   - hub 不感知业务，只认 topic / group 字符串
 *
 * 与 spec §2 对齐（spec 为概念权威）：
 *   - registerTopic 重复注册**幂等覆盖**（spec §2/§3 原文 "重复注册覆盖"，
 *     `this.buses.set(topic, bus)` 无条件覆盖）。幂等语义对 bootstrap 期重装配 + 热重载更稳，
 *     不会因 owner 二次注册而抛错中断启动。
 *   - hub 不做 listener 级去重：每次 `sub()` 都独立 `bus.subscribe()` + 起独立 consume 循环，
 *     保证每个订阅者各自拿到完整 replay + 实时帧。group 级 0↔1 钩子归 channel 层
 *     （用 groupSubs Set.size 判断），hub 只管 bus 订阅级生命周期。
 *
 * 注意：本模块是底座，禁止 import message/session/context/tools/agent-loop。
 */

import { ReplayableEventBus, type EventBusEvent } from './event-bus';

/** 订阅句柄：取消订阅用 */
export interface Subscription {
  topic: string;
  group: string;
  cancel(): void;
}

/** EventBus 最小依赖接口（hub 只用 emit/subscribe/wakePendingSubscribers，不依赖 replay 选项） */
export interface EventBusLike {
  emit<T>(group: string, event: EventBusEvent<T>): void;
  subscribe<T>(group: string): AsyncIterable<EventBusEvent<T>>;
  /**
   * 唤醒 group 的所有 pending 消费者（v0.0.10）：cancel 时不经 emit 唤醒阻塞消费者，
   * 避免污染 replay buffer。见 ReplayableEventBus.wakePendingSubscribers。
   */
  wakePendingSubscribers(group: string): void;
}

/** 活跃订阅内部记录。每条 `sub()` 调用 = 一个 record，对应独立的 bus 订阅 + consume 循环。 */
interface ActiveSub {
  sub: Subscription;
  /** 该 record 是否已取消（cancel 幂等） */
  canceled: boolean;
  /** 停止本 record 的 consume 循环（每 record 独立 stopSignal，cancel 时停止自己的） */
  stop: () => void;
}

export class EventHub {
  private static instance: EventHub | null = null;

  /** topic → bus 路由表 */
  private readonly buses: Map<string, EventBusLike> = new Map();
  /** `${topic}:${group}` → 活跃订阅 record 数组（每条 sub 调用一个 record，诊断 + group 级清理用） */
  private readonly activeSubs: Map<string, ActiveSub[]> = new Map();

  /** 全局唯一实例入口 */
  static singleton(): EventHub {
    if (!EventHub.instance) {
      EventHub.instance = new EventHub();
    }
    return EventHub.instance;
  }

  /** （仅测试用）重置单例 + 全部注册/订阅状态 */
  static resetForTest(): void {
    if (EventHub.instance) {
      // cancel 会 splice 数组，迭代期间改数组会跳元素 → 先 flat 快照
      const all = [...EventHub.instance.activeSubs.values()].flat();
      for (const a of all) {
        a.sub.cancel();
      }
    }
    EventHub.instance = null;
  }

  /**
   * 注册 topic 及其专属 EventBus 实例（每 topic 一个）。
   * 重复注册幂等覆盖（spec §2/§3："重复注册覆盖"）。对 bootstrap 重装配 + 热重载友好。
   */
  registerTopic(topic: string, bus: EventBusLike): void {
    this.buses.set(topic, bus);
  }

  /** 查询 topic 是否已注册 */
  hasTopic(topic: string): boolean {
    return this.buses.has(topic);
  }

  /**
   * 订阅 (topic, group)：
   *   1. 找 topic 的 bus；未注册 → 返回空订阅（spec §3 行为）
   *   2. 每次 sub 都独立 `bus.subscribe()` 拿独立 AsyncIterable + 起独立 consume 循环喂
   *      listener；保证每个订阅者各自拿完整 replay（sticky + buffer）+ 实时帧
   *   3. cancel 幂等；按引用 splice；数组空才 delete(key)
   *
   * 私有 stopNotifier：cancel 时只唤醒本 record 的 consume 循环（Promise.race），**不调**
   *   `bus.wakePendingSubscribers`——它会唤醒同 group 所有 subscribers（含其他 record），
   *   误伤其他订阅者。
   */
  sub<T>(topic: string, group: string, listener: (msg: T) => void): Subscription {
    const bus = this.buses.get(topic);
    if (!bus) {
      // 没人注册该 topic：返回空订阅（spec §3 明确行为）
      return { topic, group, cancel: () => {} };
    }

    const key = `${topic}:${group}`;

    // 每 sub 独立 bus.subscribe → 独立 replay + 独立实时帧
    const iter = bus.subscribe<T>(group)[Symbol.asyncIterator]();
    const stopSignal = { stopped: false };
    // 本 record 私有唤醒句柄：cancel 时只唤醒自己的 consume 循环
    let stopNotifier: (() => void) | null = null;

    const consume = async (): Promise<void> => {
      try {
        while (true) {
          if (stopSignal.stopped) break;
          // race iter.next() 与私有 stopNotifier：cancel 时只唤醒本 consume，不影响其他 record
          const nextPromise = iter
            .next()
            .then((r) => ({ done: r.done, value: r.value, stopped: false as const }));
          const stopPromise = new Promise<{ stopped: true; done?: undefined; value?: undefined }>(
            (resolve) => {
              stopNotifier = () => resolve({ stopped: true });
            },
          );
          const result = await Promise.race([nextPromise, stopPromise]);
          if (result.stopped || result.done) break;
          if (stopSignal.stopped) break;
          listener(result.value!.data); // unwrap：EventBusEvent={data,timestamp}，透传 data
        }
      } catch {
        // 消费循环异常静默退出（listener 内部异常由调用方自行处理）
      } finally {
        // 触发 bus 的 return → 从 subscribers 移除（防泄漏）
        try {
          await iter.return?.();
        } catch {
          // iterator 已关闭则忽略
        }
      }
    };
    void consume();

    const record: ActiveSub = {
      sub: { topic, group, cancel: () => {} },
      canceled: false,
      stop: () => {
        stopSignal.stopped = true;
        // 只唤醒本 record 的 consume 循环（私有 stopNotifier）
        // 不调 bus.wakePendingSubscribers（会误伤同 group 其他 record）
        stopNotifier?.();
      },
    };

    // cancel 幂等：拆自己的 stopSignal + 从 activeSubs 数组 splice 本 record
    record.sub.cancel = () => {
      if (record.canceled) return;
      record.canceled = true;
      record.stop();
      const arr = this.activeSubs.get(key);
      if (arr) {
        const i = arr.indexOf(record);
        if (i >= 0) arr.splice(i, 1);
        if (arr.length === 0) {
          this.activeSubs.delete(key);
        }
      }
    };

    const existing = this.activeSubs.get(key);
    if (existing) {
      existing.push(record);
    } else {
      this.activeSubs.set(key, [record]);
    }
    return record.sub;
  }

  /** 取消订阅（幂等） */
  unsub(sub: Subscription): void {
    sub.cancel();
  }

  /** 返回当前已注册 topic 列表（诊断/测试用） */
  topics(): string[] {
    return Array.from(this.buses.keys());
  }

  /** （诊断/测试用）返回某 (topic, group) 活跃 hub 级订阅数 */
  activeSubscriptionCount(topic: string, group: string): number {
    return this.activeSubs.get(`${topic}:${group}`)?.length ?? 0;
  }
}

export { ReplayableEventBus };
