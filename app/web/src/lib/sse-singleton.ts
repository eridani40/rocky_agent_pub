/**
 * sse-singleton —— SSE 客户端模块级 lazy 单例（v0.0.88）
 * 参考: specs/tech/app/frontend/[P0]sse_client_singleton.md §4 + §7.2（设计权威）
 *
 * 为什么不用 React Context：
 *   - React Context 在 StrictMode 双 mount 下会双建实例（违背 spec §1 S1 全局唯一原则）
 *   - 模块级 lazy 单例天然幂等：首次 getSseClient() 创建 + void connect()，后续返回同实例
 *
 * 生命周期：
 *   - 首次 getSseClient() → new SseClient() + void connect(defaultErrorLogger)（fire-and-forget）
 *   - app 卸载（Electron 渲染进程销毁）→ 模块级单例随之 GC；显式 destroy() 仅在 HMR / 测试隔离调
 *   - 测试隔离：调 _resetSseSingletonForTest() 销毁当前实例并置 null（仅测试代码 import）
 *
 * [v0.0.92] visibilitychange 自愈（spec §7.2）：
 *   - 首次 getSseClient() 时注册一次 document.visibilitychange listener（模块级 flag 防 StrictMode 双触发）
 *   - hidden→visible 时：若 !isConnected() → void connect(defaultErrorLogger) 兜底自愈；
 *     若已 connected → singleton.notifyResume() 触发 caller 注册的 onResumed 回调做 GET 校正
 */
import { SseClient } from './sse-client';

let singleton: SseClient | null = null;
/** 模块级 flag：visibilitychange listener 仅注册一次（防 StrictMode 双 mount 重复注册） */
let visibilityListenerRegistered = false;

/**
 * 默认 onError logger：瞬时错误时 console.warn（重连链路由 SseClient 内部自动驱动）。
 * caller 必须传 onError，否则瞬时错误不进重连链路（catch 仅 throw 不调 scheduleReconnect）。
 */
const defaultErrorLogger = (e: unknown): void => {
  // eslint-disable-next-line no-console
  console.warn('[sse] connection error, scheduling reconnect:', e);
};

/**
 * 获取全局 SseClient 单例。
 * 首次调用：创建实例 + void connect(defaultErrorLogger)（fire-and-forget，传 onError 激活重连链）。
 * 后续调用：返回同一实例（StrictMode 双 mount 不双建）。
 */
export function getSseClient(): SseClient {
  if (!singleton) {
    singleton = new SseClient();
    // 传 onError 激活重连链路（否则瞬时错误仅 throw 不重连）
    void singleton.connect(defaultErrorLogger);
    // 注册一次 visibilitychange listener（模块级 flag 防 StrictMode 双触发）
    if (!visibilityListenerRegistered && typeof document !== 'undefined') {
      visibilityListenerRegistered = true;
      document.addEventListener('visibilitychange', () => {
        if (!singleton) return;
        if (document.visibilityState !== 'visible') return;
        // 返前台：未连 → 兜底自愈；已连 → 触发 onResumed 让 caller 做 GET 校正
        if (!singleton.isConnected()) {
          void singleton.connect(defaultErrorLogger);
        } else {
          singleton.notifyResume();
        }
      });
    }
  }
  return singleton;
}

/**
 * 测试隔离：销毁当前单例并置 null。
 *
 * 仅 NODE_ENV=test 下测试代码调用；命名前缀 `_` 标测试专用，禁止生产代码 import。
 * 行为：singleton?.destroy()（断连接 + 清 handlers + 清 visibility 标志）+ singleton = null（下次 getSseClient 重建）。
 * 注意：visibilityListenerRegistered 不重置（listener 仅注册一次全局足够；document 本身在测试间不重建）。
 *       测试需重置 visibility 行为时直接 mock document 或用独立测试文件。
 */
export function _resetSseSingletonForTest(): void {
  if (singleton) {
    singleton.destroy();
    singleton = null;
  }
}
