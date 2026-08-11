/**
 * worker pool 工厂 + 进程级单例缓存（v0.0.307 T1）
 * 参考: specs/tech/version_logs/v0.0.307/change_plan.md A 组
 *
 * createToolWorkerPool() 负责解析 workerPath + 构造 ToolWorkerPool。
 * 进程级单例缓存：bootstrap 装配时调一次，后续 engine 复用同一实例。
 */
import { ToolWorkerPool, type ToolWorkerPoolOptions } from './pool';

export { ToolWorkerPool, WorkerCrashedError, resolveWorkerPath } from './pool';
export type { WorkerPoolTask, WorkerPoolResult, ToolWorkerRequest, ToolWorkerResponse } from './types';

/** 进程级单例缓存（同一进程只创建一个池） */
let singleton: ToolWorkerPool | null = null;

/**
 * 创建（或复用）进程级 worker 池单例。
 * 首次调用时构造，后续调用返回同一实例（MUST 单例缓存）。
 *
 * @param opts 可选配置（仅首次调用生效；maxWorkers 等）
 * @returns ToolWorkerPool 单例
 */
export function createToolWorkerPool(opts?: ToolWorkerPoolOptions): ToolWorkerPool {
  if (singleton) return singleton;
  singleton = new ToolWorkerPool(opts);
  return singleton;
}

/**
 * 重置单例（仅供 UT 隔离用——每个 test case 需独立池时调）。
 * 生产代码不应调用此函数。
 */
export function _resetToolWorkerPoolSingleton(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
