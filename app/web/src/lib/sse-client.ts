/**
 * sse-client —— SSE 客户端（v0.0.88 重构：subId 路由 + SubscribeHandle 句柄）
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_client_singleton.md §3-§4 + §7（设计权威）
 *   - specs/api/version_logs/v0.0.88/change_log.md（POST /sse/subscribe / DELETE /sse/subscriber/:subId）
 *
 * 核心模型（方案 B）：
 *   - handlers: Map<subId, handler>——一帧一调零过滤（subId 唯一路由 key，spec §3 不变量 #1）
 *   - subscribe 内部生成 ULID subId，handler 先注册再 POST（POST 期间后端推帧 handlers 已有该 id 帧能路由）
 *   - 帧无 subId → drop（单例只认 subId 帧，spec §3.2）
 *
 * [v0.0.92] 自动重连（spec §7.2）：connect() 是 stream loop 永不 resolve，重连走 catch/finally
 *   （禁 await connect().then()——memory `sseclient-connect-never-resolves`）。catch 区分 AbortError
 *   （=destroy 触发，终态不重连）vs 瞬时错误（保 handlers + scheduleReconnect 指数回退 1s×2^k
 *   cap 30s + ±20% jitter）。重连成功（reconnectAttempts>0 时）→ 归零 + onResumed 回调通知 caller
 *   做 GET 校正。destroyed 守卫防僵尸重连。
 */
import { resolveApiBase } from './api-base';
import { ulid } from './ulid';
// [CHAT-DEBUG] 临时观测（定位 tool_call 回放渲染缺失；排查完连同 chat-debug-log 整体删除）
import { trackChatNetFrame } from './chat-debug-log';

/** 单帧 payload（对齐 api §4.1 + v0.0.88 subId 必填） */
export interface SseFrame {
  topic: string;
  group: string;
  data: unknown;
  timestamp: string;
  /** 订阅唯一 id（后端 listener 闭包注入）；缺省帧 drop（单例只认 subId 帧） */
  subId: string;
}

/** [v0.0.88] 订阅句柄：unsubscribe 用，不依赖 handler 引用相等；句柄自带 unsubscribe 方法（spec §3 SubscribeHandle） */
export interface SubscribeHandle {
  /** 内部生成 ULID，唯一标识本订阅 */
  subId: string;
  topic: string;
  group: string;
  /** 内部绑定 subId，cleanup 直接调 handle.unsubscribe() */
  unsubscribe: () => Promise<void>;
}

/** SSE 帧解析（split by `\n\n`，每帧取首条 `data:` 行 JSON）—— 纯函数便于单测 */
export function parseSseFrames(chunk: string, carry = ''): { frames: SseFrame[]; rest: string } {
  const buf = carry + chunk;
  const frames: SseFrame[] = [];
  let cursor = 0;
  let sep = buf.indexOf('\n\n', cursor);
  while (sep !== -1) {
    const frameText = buf.slice(cursor, sep);
    cursor = sep + 2;
    const dataLine = frameText
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (dataLine) {
      const json = dataLine.slice('data:'.length).trim();
      try {
        const parsed = JSON.parse(json) as SseFrame;
        if (parsed && typeof parsed.topic === 'string' && typeof parsed.group === 'string') {
          frames.push(parsed);
        }
      } catch {
        // 忽略坏帧
      }
    }
    sep = buf.indexOf('\n\n', cursor);
  }
  return { frames, rest: buf.slice(cursor) };
}

/**
 * SSE 通道客户端（v0.0.88 重构）：
 *   - 单条 GET /sse fetch-stream 连接
 *   - handlers 按 subId 路由（一帧一调零过滤）
 *   - subscribe 返回 SubscribeHandle；句柄 unsubscribe 不依赖 handler 引用相等
 *
 * 协议：1) GET /sse 建立流；2) POST /sse/subscribe { topic, group, subId } 登记后端 listener；
 * 3) DELETE /sse/subscriber/:subId 取消订阅；4) 帧格式 data: {topic,group,data,timestamp,subId}\n\n
 */
export class SseClient {
  /** subId → handler（一帧一调零过滤；spec §3 不变量 #1） */
  private handlers = new Map<string, (frame: SseFrame) => void>();
  private controller: AbortController | null = null;
  private carry = '';
  private active = false;

  /** [v0.0.92] 重连相关私有状态（spec §7.2） */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly reconnectBaseMs = 1000;
  private readonly reconnectMaxMs = 30_000;
  private readonly reconnectJitterRatio = 0.2;
  private destroyed = false;
  /** onResumed 回调集合（重连成功 / visibility 返前台时触发） */
  private resumedSubscribers = new Set<() => void>();

  constructor(private readonly base: string = resolveApiBase()) {}

  /** 当前是否已连接（重连中返 false 但可恢复；destroyed 后永远 false，spec §7.2 invariants） */
  isConnected(): boolean {
    return this.active && !this.destroyed;
  }

  /**
   * 建立 GET /sse 连接，消费帧并按 subId 路由。幂等（重复调用不建第二条连接）。
   * 帧无 subId → drop（spec §3.2）。[v0.0.92] 重连：stream loop 永不 resolve，重连走 catch/finally。
   */
  async connect(onError?: (e: unknown) => void): Promise<void> {
    if (this.destroyed) return; // 终态守卫：destroy 后不再建连
    if (this.active) return; // 幂等：连接中（含重连中）直接返回
    this.active = true;
    this.controller = new AbortController(); // 每次尝试前重置（旧 controller 已 abort 或失效）
    let isAbortError = false;
    let isTransientError = false;
    try {
      const res = await fetch(`${this.base}/sse`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: this.controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`GET /sse failed: ${res.status}`);
      }
      // stream 成功建立：若之前有重连 → 归零 + 触发 onResumed
      if (this.reconnectAttempts > 0) {
        this.reconnectAttempts = 0;
        this.notifyResume();
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.carry += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(this.carry);
        this.carry = rest;
        for (const f of frames) {
          const fn = this.handlers.get(f.subId); // spec §3.2：按 subId 路由
          trackChatNetFrame(f.topic, f.data, f.subId, !!fn); // [CHAT-DEBUG] 网络到达+路由命中观测
          fn?.(f);
        }
      }
      // stream 自然结束（server 主动关闭）→ 视为瞬时错误进重连
      isTransientError = true;
      onError?.(new Error('SSE stream ended'));
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        isAbortError = true; // destroy 触发：终态不重连
      } else {
        isTransientError = true; // 瞬时错误（网络抖动/HMR/唤醒）→ 进重连链路
        onError?.(e);
      }
    } finally {
      this.active = false;
      // destroyed/AbortError → 终态不重连；瞬时错误 → 保 handlers + 调度重连
      if (!this.destroyed && !isAbortError && isTransientError) {
        this.scheduleReconnect(onError);
      }
    }
  }

  /**
   * [v0.0.92] 调度重连（指数回退 + jitter，spec §7.2）。
   * fire-and-forget：setTimeout 不阻塞 caller；destroyed 守卫防僵尸重连。
   */
  private scheduleReconnect(onError?: (e: unknown) => void): void {
    // 入口守卫：destroy 后不再调度（防僵尸）
    if (this.destroyed) return;
    // 清旧 timer（避免多次错误叠加产生多个 timer）
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // delay = min(base * 2^attempts, max) × (1 ± jitter)，jitter 防「羊群效应」
    const exp = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempts, this.reconnectMaxMs);
    const jitter = exp * this.reconnectJitterRatio * (Math.random() * 2 - 1);
    const delay = Math.max(0, exp + jitter);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 二次守卫：setTimeout 触发时可能已 destroy
      if (this.destroyed) return;
      void this.connect(onError);
    }, delay);
  }

  /**
   * [v0.0.92] 注册「重连成功 / visibility 返前台」回调（spec §7.2 onResumed）。
   * 典型 caller：useSessionSseSubscribe 注册回调调 GET /session/:id + GET /messages 校正态。
   * 返回 unsubscribe 函数（典型在组件 unmount cleanup 调）。
   */
  onResumed(cb: () => void): () => void {
    this.resumedSubscribers.add(cb);
    return () => {
      this.resumedSubscribers.delete(cb);
    };
  }

  /**
   * [v0.0.92] 触发所有 onResumed 回调（spec §7.2）。
   * 触发源：① 内部 connect 重连成功（reconnectAttempts>0 时）；② 外部 singleton 检测
   * visibility hidden→visible 且已 connected（spec §7.2 visibilitychange listener）。
   * best-effort：单个 cb 抛异常不阻塞其他 cb。
   */
  notifyResume(): void {
    // 复制一份防「迭代中 cb 注册新 cb 改 Set」（虽然 Set 迭代中 add/delete 在 JS spec 中是
    // 已定义行为，复制更稳）
    const subs = Array.from(this.resumedSubscribers);
    for (const cb of subs) {
      try {
        cb();
      } catch {
        // best-effort：单个回调失败不阻塞其他回调
      }
    }
  }

  /**
   * 订阅 (topic, group)：内部生成 subId + handler 先注册再 POST 上行 + 返回 SubscribeHandle。
   * handler 是闭包，天然绑定组件 instance（spec §3.1 注：捕获组件作用域的 setState/reducer/props）。
   *
   * 时序保证（spec §3.1 MANDATORY）：
   *   1. subId = ulid() 前端生成（不暴露给 caller 作输入参数）
   *   2. handlers.set 先注册——POST 期间若后端推帧 handlers 已有该 id 帧能路由
   *   3. POST /sse/subscribe { topic, group, subId }
   *   4. POST 失败 → handlers.delete + throw（caller catch 不阻塞 UI）
   */
  async subscribe(
    topic: string,
    group: string,
    handler: (frame: SseFrame) => void,
  ): Promise<SubscribeHandle> {
    const subId = ulid();
    // 先注册本地 handler（POST 期间后端推帧能路由）
    this.handlers.set(subId, handler);

    try {
      const res = await fetch(`${this.base}/sse/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic, group, subId }),
      });
      if (!res.ok) {
        throw new Error(`POST /sse/subscribe failed: ${res.status}`);
      }
    } catch (e) {
      // POST 失败：回滚 handler 入口，避免脏注册（后续帧路由到已废 handler）
      this.handlers.delete(subId);
      throw e;
    }

    // 句柄 unsubscribe 内部绑定 subId——不依赖 handler 引用相等（spec §1 S5）
    const self = this;
    return {
      subId,
      topic,
      group,
      unsubscribe: () => self.unsubscribe(subId),
    };
  }

  /**
   * 按 subId 取消订阅（幂等：subId 不存在 → no-op；spec §3.3 MANDATORY）。
   * 调用形式：unsubscribe(handle: SubscribeHandle) 或 unsubscribe(subId: string)。
   * DELETE /sse/subscriber/:subId best-effort（失败 catch 不阻塞 cleanup）。
   */
  async unsubscribe(handle: SubscribeHandle | string): Promise<void> {
    const subId = typeof handle === 'string' ? handle : handle.subId;
    if (!this.handlers.has(subId)) return; // 幂等
    this.handlers.delete(subId);
    try {
      await fetch(`${this.base}/sse/subscriber/${encodeURIComponent(subId)}`, {
        method: 'DELETE',
      });
    } catch {
      // best-effort：网络失败不阻塞 caller cleanup
    }
  }

  /**
   * 断开连接 + 清空所有 handler（app 卸载调；spec §3.4：不循环 DELETE，靠 TCP RST 兜底）。
   * [v0.0.92] 加 destroyed=true（防僵尸重连）+ clearTimeout(reconnectTimer) + 清 resumedSubscribers。
   */
  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
    this.handlers.clear();
    this.resumedSubscribers.clear();
    this.carry = '';
    this.active = false;
    this.reconnectAttempts = 0;
  }
}
