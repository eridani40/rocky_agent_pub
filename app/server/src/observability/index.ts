/**
 * Observability 模块入口 — 类型 + Adapter + Manager 工厂。
 * 参考: specs/tech/agent/observability/[P0]overall.md §7（注入）+ §8（backend 表）
 *       specs/tech/agent/observability/[P0]observability_manager.md §6（factory）+ §7（生命周期）
 *       specs/tech/config/[P0]app_config.md §3.X（ObservabilityConfigItem 列表 schema；v0.0.89 自 dev_config.runtime 迁入 app_config.runtime）
 *
 * [v0.0.11 破坏性变更 — single → list + Manager + 移除 ENV 兜底]
 *   - v0.0.10：`createObservabilityAdapter(cfg?: ObservabilityConfig)`（单对象）+ ENV LANGFUSE_* 兜底
 *   - v0.0.11：`createObservabilityManager(items: ObservabilityConfigItem[])`（列表）→ 返回 ObservabilityManager
 *     * 凭证**只来自 config 列表**（移除 ENV 兜底：不再读 LANGFUSE_*；
 *       v0.0.89 起列表源从 dev_config.runtime.observability 改读 app_config.runtime.observability，
 *       group/key 名零变更直迁）
 *     * 列表空 / 全 disabled → manager 持 0 child，等价 Noop（loop 无感知）
 *   - `shutdownObservability()` 仍 flush singleton（v0.0.10 双触发沿用，now → manager.shutdown）
 *   - `_resetSingletonForTest()` 重置 manager singleton（沿用 v0.0.10 测试钩子模式）
 */
import {
  ObservabilityManager,
  type ObservabilityConfigItem,
} from './observability-manager';

// re-export 子模块符号（统一对外 import 路径；本文件仅 ObservabilityManager 在 factory 用到）
export type { ObservabilityAdapter } from './adapter';
export { NoopAdapter, noopAdapter } from './noop-adapter';
export { LangfuseAdapter } from './langfuse-adapter';
export type { LangfuseAdapterOptions } from './langfuse-adapter';
// [v0.0.61] mapUsageDetails 从 langfuse-metadata re-export（纯数据映射，无 SDK 依赖）
export { mapUsageDetails } from './langfuse-metadata';
export type * from './types';
// [v0.0.11] ObservabilityManager + ObservabilityConfigItem 统一对外导出路径
// （bootstrap / handler / 测试均从此 import；observability-manager.ts 是定义点）
export { ObservabilityManager } from './observability-manager';
export type { ObservabilityConfigItem } from './observability-manager';
// 事件循环卡顿监控（server/electron 主进程共用；Bun 下 monitorEventLoopDelay
// 不可用时模块内静默降级，见 event-loop-monitor.ts 模块头）
export { startEventLoopMonitor } from './event-loop-monitor';
export type { EventLoopMonitorOptions, EventLoopMonitorHandle } from './event-loop-monitor';

/** 全局 singleton ObservabilityManager（bootstrap 构造后跨 session 复用） */
let singletonManager: ObservabilityManager | null = null;

/**
 * 据 app_config.runtime.observability 列表构造 ObservabilityManager（composite adapter）。
 *
 * - 接收完整列表（含 disabled 项）；manager 桩内部仅做保存，t2 真实现内部过滤 enabled 项构造 child。
 * - 空 / 全 disabled → 返回 0-child manager（行为等价 Noop，loop 无感知）。
 * - 单例：跨 session 复用同一实例（与 v0.0.10 singleton adapter 同思路）。
 * - **不热更新**：用户改列表 → 重启进程 / 下个 session 才生效
 *   （observability_manager.md §7，manager 持 Langfuse client run 中途替换会丢 batch）。
 *
 * 历史：v0.0.89 dev_config 废弃前凭证源为 dev_config.runtime.observability；
 * 迁移后 group/key 名零变更直迁 app_config.runtime.observability（items 形态不变）。
 *
 * @param items app_config.runtime.observability 的 data（ObservabilityConfigItem[]）；缺省视为空列表
 */
export function createObservabilityManager(
  items?: ObservabilityConfigItem[],
): ObservabilityManager {
  // singleton：bootstrap 起来构造一次，全程注入 AgentManager
  if (singletonManager) return singletonManager;

  const list = Array.isArray(items) ? items : [];
  singletonManager = new ObservabilityManager(list);
  return singletonManager;
}

/**
 * electron / node 关闭前 flush（langfuse SDK 异步 batch，不 flush 末尾 trace 会丢）。
 * - singleton manager 存在 → manager.shutdown()（t2 真实现：fan-out child flush）
 * - 无 singleton → noop
 * 调用方 await（唯一允许 await observability 的时机）。
 */
export async function shutdownObservability(): Promise<void> {
  if (singletonManager) {
    await singletonManager.shutdown();
    singletonManager = null;
  }
}

/** 仅供测试用：重置 singleton（避免用例间串扰） */
export function _resetSingletonForTest(): void {
  singletonManager = null;
}
