/**
 * training-engine/p-limit — 极简并发限制器（自实现）
 * 参考: specs/tech/academy/[P0]evaluation.md §4.2（fan-out 直调 pLimit(5)）
 *
 * 设计背景（coder 决策）：
 *   仓库未装 npm `p-limit` 包（已确认 node_modules/p-limit 不存在）。
 *   引入新第三方依赖会触发 packaged-app 护栏 BUG-002（必须声明在 workspace package.json
 *   而非根），增加复杂度。pLimit 核心实现 < 30 行，自实现更可控、可测、零依赖。
 *
 *   语义对齐 p-limit npm 包：
 *   - 返回的 limit(fn) 返回 Promise<ReturnType<fn>>（并发 ≤ concurrency）
 *   - 超过并发时进 FIFO 队列等待，前一个 settle 后 dequeue 一个
 *   - 不抛特化错误（fn 内部错误正常抛出，limit 不吞）
 */

/** 创建一个并发限制器。 */
export function createLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`createLimit: concurrency 必须 ≥ 1，实际 ${concurrency}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= concurrency) return;
    const task = queue.shift();
    if (!task) return;
    active++;
    task();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      };
      queue.push(run);
      next();
    });
  };
}
