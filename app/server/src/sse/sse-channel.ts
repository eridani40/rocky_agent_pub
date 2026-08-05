/**
 * SseChannel — 前端(web)与后端 event-hub 之间的 SSE 桥（后端对象）。
 * 参考: specs/tech/app/frontend/[P0]sse_channel.md §2-§5 + [P0]sse_channel_multipub.md §2-§7
 *
 * 设计：
 *   - 每 subId 独立 `hub.sub()`：listener 闭包注入 subId 调 writeFrame 广播；
 *   - hub 层每 listener 独立被调，每 subId 各自拿完整 replay + 实时帧；
 *   - groupSubs Set 维护 group 级 refcount：0↔1 触发 onSubscribe/onUnsubscribe。
 */

import type { EventHub } from '../agent/event-hub';
// 帧 codec（v0.0.88 sse-frame.ts：含 subId 字段；本模块再导出一道维持公开 API）
import { SSE_HEADERS, parseSseFrame, type SseFrame } from './sse-frame';
// subId 缺省时后端生成 ULID 兜底（dev1 旧 2-arg subscribe 兼容）
import { ulid } from '../config/ulid';
import type { LogWriter } from '../dev-logs/log-writer';

export { SSE_HEADERS, parseSseFrame };
export type { SseFrame };

/** SSE 连接 sink：listener push 帧 → ReadableStream start 异步消费 */
interface SseSink {
  push: (frame: string) => void;
  /** 连接已关闭（消费者断开 / destroy）→ 不再 push */
  closed: boolean;
  /** 唤醒阻塞在 await 的消费循环（destroy / cancel 调用） */
  wake: () => void;
}

/** 单个订阅者代理对象（方案 B：不持 sink 引用）。每 subId 持独立 hub Subscription；listener 闭包注入 subId 写广播帧。 */
interface SubscriberProxy {
  subId: string;
  topic: string;
  group: string;
  listener: (data: unknown) => void;
  /** 拆自己的 hub 订阅（每 subId 各自） */
  cancel: () => void;
}

/** [v0.0.27] Session 前台判定探针。唯一前台原语：查 session 是否被前端订阅（用户正在看）。 */
export interface SessionPresenceProbe {
  /** @returns true=有活跃订阅（前台完成 → 不产生未读）；false=未订阅（后台 → 产生未读） */
  isSessionActive(sessionId: string): boolean;
}

/**
 * [v0.0.17] 订阅计数变化钩子（SessionWorkspaceManager lazy watcher 用）。
 * - onSubscribe(topic, group)：某 (topic, group) 从「无订阅 → 有订阅」时触发。
 * - onUnsubscribe(topic, group)：某 (topic, group) 从「有订阅 → 无订阅」时触发。
 *
 * channel 侧 group 级 refcount 由 groupSubs Set.size 维护（Set 空 → 触发 onUnsubscribe）。
 *
 * [v0.0.85.ui_opt F2] 返回类型 `void | Promise<void>`（向后兼容旧 sync 实现）；
 * subscribe/unsubscribe 内部 `await hooks.onSubscribe?.(...)` —— caller（如 bootstrap 的
 * onUnsubscribe→recycleSession 兜底回收链）可串联 await，消除 fire-and-forget 时序竞争。hook
 * 异常 try/catch 不影响订阅本身（与旧 sync 行为一致）。
 */
export interface SubscribeHooks {
  onSubscribe?: (topic: string, group: string) => void | Promise<void>;
  onUnsubscribe?: (topic: string, group: string) => void | Promise<void>;
}

/** SseChannel — 全局 SSE 桥后端对象。生命周期由 bootstrap / electron app 管理。 */
export class SseChannel implements SessionPresenceProbe {
  private readonly hub: EventHub;
  /** subId → SubscriberProxy（全部活跃订阅者；每 subId 各持 hub Subscription） */
  private readonly subscribers: Map<string, SubscriberProxy> = new Map();
  /** `${topic}:${group}` → Set<subId>（group 级 refcount：Set.size=0 才触发 onUnsubscribe） */
  private readonly groupSubs: Map<string, Set<string>> = new Map();
  /** 当前活跃的 SSE 连接 sink 集合（多连接 fan-out） */
  private readonly sinks: Set<SseSink> = new Set();
  private readonly encoder = new TextEncoder();
  private destroyed = false;
  /** [v0.0.17] 订阅计数变化钩子（lazy watcher 启停） */
  private subscribeHooks: SubscribeHooks = {};
  /** [REPLAY-DEBUG] 可选 logWriter：注入后在 SSE 实际发送点（enqueue）记录每一条帧全文到 event.log */
  private readonly logWriter?: LogWriter;

  constructor(hub: EventHub, logWriter?: LogWriter) {
    this.hub = hub;
    this.logWriter = logWriter;
  }

  /**
   * [v0.0.17] 设置订阅计数变化钩子（bootstrap 注入 SessionWorkspaceManager 启停回调）。
   * 必须在首次 subscribe 前调；运行时改不会重放既有订阅状态。
   */
  setSubscribeHooks(hooks: SubscribeHooks): void {
    this.subscribeHooks = hooks;
  }

  /**
   * 建立一条新 SSE 连接（GET /sse）。返回标准 Response 的 { body, headers }。
   * 多次调用返回独立 ReadableStream（多连接 fan-out）。
   */
  openConnection(): { body: ReadableStream<Uint8Array>; headers: Readonly<Record<string, string>> } {
    if (this.destroyed) {
      throw new Error('SseChannel: already destroyed');
    }

    // 本连接 sink：listener push 帧 → 队列 → ReadableStream start 异步消费
    const queue: string[] = [];
    let notifier: (() => void) | null = null;
    const sink: SseSink = {
      closed: false,
      push: (frame: string) => {
        if (sink.closed) return;
        queue.push(frame);
        if (notifier) {
          const resolve = notifier;
          notifier = null;
          resolve();
        }
      },
      wake: () => {
        if (notifier) {
          const resolve = notifier;
          notifier = null;
          resolve();
        }
      },
    };
    this.sinks.add(sink);
    // Bun 的 ReadableStream 在首字节 enqueue 前不刷 HTTP 响应头；
    // 立即推一个 SSE 注释帧触发 Bun 刷头，让 urlopen/curl 能立刻收到 200 响应。
    // SSE 注释帧（以 : 开头）对 EventSource 和前端零影响。
    sink.push(': keepalive\n\n');

    const self = this;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // 消费循环：队列空时 await notifier 等下一帧
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (sink.closed && queue.length === 0) break;
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                notifier = resolve;
              });
              continue;
            }
            const frame = queue.shift()!;
            // [REPLAY-DEBUG] SSE 实际发送点：每一条真正写进 HTTP 流的帧全文记录到 event.log
            //   —— 实时帧 + 回放帧都经此 enqueue 发出，「到底发没发、发的是不是完整前段」的铁证
            try {
              self.logWriter?.write('event', { topic: 'sse_send', group: '_send', event: { type: 'sse_frame', frame } });
            } catch {
              // logging failure must never affect sse send main flow
            }
            controller.enqueue(self.encoder.encode(frame));
          }
        } catch {
          // 消费异常静默退出（客户端断开等）
        } finally {
          self.sinks.delete(sink);
          sink.closed = true;
          try {
            controller.close();
          } catch {
            // 已关闭则忽略
          }
        }
      },
      cancel() {
        // 客户端主动断开（fetch reader cancel / 浏览器关闭）
        sink.closed = true;
        sink.wake();
        self.sinks.delete(sink);
      },
    });

    return { body, headers: SSE_HEADERS };
  }

  /**
   * 订阅 (topic, group, subId?)：
   *   - 每 subId 独立 `hub.sub()`，listener 闭包注入 subId 写广播帧，各自拿完整 replay + 实时帧。
   *   - group 级 0↔1 触发 onSubscribe/onUnsubscribe（groupSubs Set.size 维护）。
   *   - subId 缺省时后端生成 ULID 兜底（向后兼容旧 2-arg 调用方）。
   *   - async + await onSubscribe（消除 fire-and-forget 时序竞争）。
   */
  async subscribe(topic: string, group: string, subId?: string): Promise<void> {
    if (this.destroyed) return;
    const key = `${topic}:${group}`;
    const finalSubId = subId ?? ulid();
    if (this.subscribers.has(finalSubId)) return; // 幂等：同 subId 重复订阅 no-op

    const listener = (data: unknown) => {
      this.writeFrame({ topic, group, data, timestamp: new Date().toISOString(), subId: finalSubId });
    };

    const set = this.groupSubs.get(key) ?? new Set();
    const wasEmpty = set.size === 0;
    set.add(finalSubId);
    this.groupSubs.set(key, set);

    // 每 subId 各自 hub.sub()：hub 层 per-listener 调用，无需 channel 层 fan-out。
    const sub = this.hub.sub<unknown>(topic, group, listener);

    // SubscriberProxy 入 subscribers（不持 sink 引用——方案 B 关键）
    this.subscribers.set(finalSubId, {
      subId: finalSubId,
      topic,
      group,
      listener,
      cancel: () => sub.cancel(),
    });

    if (wasEmpty) {
      // group 级 0→1：触发 onSubscribe（hook 可 async；await 消除 fire-and-forget 时序竞争）
      try {
        await this.subscribeHooks.onSubscribe?.(topic, group);
      } catch {
        // 钩子异常不影响订阅本身
      }
    }
  }

  /**
   * 取消订阅（幂等）。两种调用形式：
   *   - 单 subId：`unsubscribe(subId)` 精准取消一个订阅者（group refcount -1）。
   *   - 旧 (topic, group) 形式：`unsubscribe(topic, group)` 取消该 key 下所有订阅者
   *     （兼容 v0.0.85 F2 test / 旧 dev1 调用方）。
   *
   * group 级 refcount（groupSubs Set.size）归零才触发 onUnsubscribe。
   *
   * [v0.0.85.ui_opt F2] async + await onUnsubscribe（与 subscribe 对称）。
   */
  unsubscribe(subId: string): Promise<void>;
  unsubscribe(topic: string, group: string): Promise<void>;
  async unsubscribe(target: string, group?: string): Promise<void> {
    if (this.destroyed) return;

    // 旧签名 (topic, group)：批量取消该 key 下所有订阅者
    if (group !== undefined) {
      const key = `${target}:${group}`;
      const ids = [...(this.groupSubs.get(key) ?? [])];
      for (const id of ids) {
        await this.unsubscribeOne(id);
      }
      return;
    }

    // 单 subId 签名：精准取消一个订阅
    await this.unsubscribeOne(target);
  }

  /** 单个订阅者的取消逻辑（拆 hub 订阅 + group refcount -1，归零才触发 onUnsubscribe） */
  private async unsubscribeOne(subId: string): Promise<void> {
    const proxy = this.subscribers.get(subId);
    if (!proxy) return;
    const key = `${proxy.topic}:${proxy.group}`;
    this.subscribers.delete(subId);

    // 拆自己的 hub 订阅（每 subId 各自）
    proxy.cancel();

    const set = this.groupSubs.get(key);
    if (set) {
      set.delete(subId);
      if (set.size === 0) {
        // group refcount=0：清 groupSubs + 触发 onUnsubscribe
        this.groupSubs.delete(key);
        // 1→0：末取消订阅触发兜底回收（SessionWorkspaceManager.recycleSession，懒监听两层回收之一）
        try {
          await this.subscribeHooks.onUnsubscribe?.(proxy.topic, proxy.group);
        } catch {
          // 钩子异常不影响取消订阅本身
        }
      }
    }
  }

  /**
   * 销毁：取消所有订阅 + 关闭所有活跃 SSE 连接。由 bootstrap shutdown / electron app close 调用。
   *
   * 注：unsubscribe 现为 async（await onUnsubscribe hook）；destroy 同步清理 maps + sinks，
   * hook 链 fire-and-forget（teardown 时不需 await lazy watcher 回收，进程即将退出）。
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // 先取消全部 subscribers（snapshot 避免 unsubscribe 改 Map 影响迭代）
    const ids = [...this.subscribers.keys()];
    for (const id of ids) void this.unsubscribeOne(id);
    // 兜底：清空可能残留（如 groupSubs 与 subscribers 不一致的孤儿）
    this.groupSubs.clear();
    this.subscribers.clear();

    // 再关闭所有 SSE 连接（停止输出）：置 closed + 唤醒可能阻塞在 await 的消费循环
    for (const sink of this.sinks) {
      sink.closed = true;
      sink.wake();
    }
    this.sinks.clear();
  }

  /** 当前活跃 SSE 连接数（诊断/测试用） */
  activeConnectionCount(): number {
    return this.sinks.size;
  }

  /** 当前活跃 (topic,group) 数（诊断/测试用；语义=groupSubs 维度，与 subId 数无关） */
  activeSubscriptionCount(): number {
    return this.groupSubs.size;
  }

  /**
   * [v0.0.27] session 前台判定（spec sse_channel.md §5/§7 + session_state.md §6.2）。
   * 仍查 `groupSubs.has('session_panel:session_id:'+sid)`（语义不变）。
   * 调用方仍是 session 层 SessionUnreadRuntime；零心跳、零新协议。
   */
  isSessionActive(sessionId: string): boolean {
    const set = this.groupSubs.get(`session_panel:session_id:${sessionId}`);
    return set !== undefined && set.size > 0;
  }

  /**
   * 把单帧 SseFrame 序列化为 SSE wire 字符串并广播到所有活跃连接。
   * 帧格式（对齐 sse_channel.md §4 + api §4.1）：
   *   `data: {"topic":...,"group":...,"data":<AgentEvent>,"timestamp":...,"subId":...}\n\n`
   */
  private writeFrame(frame: SseFrame): void {
    const wire = `data: ${JSON.stringify(frame)}\n\n`;
    this.pushWireToSinks(wire);
  }

  /**
   * 把已序列化的 wire 字符串广播到所有活跃 SSE 连接（sink）。
   */
  private pushWireToSinks(wire: string): void {
    for (const sink of this.sinks) {
      sink.push(wire);
    }
  }
}
