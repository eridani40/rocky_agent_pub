/**
 * 进程内 async mutex — 按「文件路径 key」FIFO 串行化写操作。
 * 参考: specs/tech/persistence/[P1]file_write_lock.md §3（锁原语设计）+ §3.4 伪码
 *
 * 解决问题（spec §1-§2）：
 *   squad 多角色 = 单 Node 进程内 async agent，跨 await 点会让出事件循环，
 *   同 path 的 read-modify-write 序列可能被另一写操作插队 → 丢更新 / tmp 覆盖 / 计数器竞态。
 *   atomicWriteSync 只保崩溃原子，不保并发原子；本锁补「并发原子」。
 *
 * 设计要点（spec §3.1-§3.4）：
 *   1. 同 path（path.resolve 规范化后）FIFO 串行；不同 path 并行。
 *   2. withFileLock = 同步等待模式：返回 fn 结果，fn 错误冒泡给调用方。
 *   3. enqueueFileWrite = fire-and-forget：立即返回 void，错误被吞（log 不抛）。
 *   4. 错误隔离：某项 reject 不影响后续排队项（tail 链永不 reject）。
 *   5. 非重入（spec §3.3）：不做 depth/AsyncLocalStorage；callsite 禁止同 path 嵌套（本工程无此 callsite）。
 *   6. entry GC：所有项 settle 后从 Map 删除（防内存泄漏）。
 *
 * 无第三方依赖；无 setTimeout / 超时（YAGNI）。
 */
import * as path from 'node:path';

/**
 * 锁链表：key=规范化绝对路径，value=该 path 当前最后一项的 tail Promise。
 * tail 永不 reject（错误被吞在 tail 链里），保证后续 then 不被短路。
 */
const locks = new Map<string, Promise<unknown>>();

/**
 * 同步等待模式（spec §3.1 模式 1）：await 返回 fn 结果；fn 抛错则冒泡给调用方。
 *
 * 语义：
 *   - 同 filePath（path.resolve 规范化后）的调用按 FIFO 串行；不同 filePath 并行。
 *   - 持锁范围 = 整个 fn（含 fn 内 sync 落盘）；下一个排队项在 fn settle 后 then 接管。
 *   - 错误隔离：前一项 reject 不影响后续项的执行（prev reject 时照常执行本项）。
 *   - 调用方拿到的 Promise 会随 fn resolve/reject（错误冒泡）。
 *
 * @param filePath 用于 key 规范化的路径（绝对/相对均可，内部 path.resolve）
 * @param fn 持锁期间执行的异步函数（read-modify-write 序列）
 * @returns fn 的 resolve 值；fn 抛错则 Promise reject
 */
export function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath);
  // prev 已是 tail（永不 reject）；若 key 首次出现则用 resolved Promise 兜底
  const prev = locks.get(key) ?? Promise.resolve();
  // run = 等 prev 完成后执行 fn；prev 任何状态都执行本项（错误隔离）
  // 注：prev.then 的两个回调都在 prev settle 后微任务里执行，保证 FIFO
  const run = prev.then(
    () => fn(),
    () => fn(),
  );
  // tail = run 的镜像但永不 reject（吞掉本项错误），用作下一项的 prev
  // 若把 run 直接 set 进 Map，后续项会因 run reject 而走 onRejected 分支（仍执行，但语义混乱）
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  // 本项是最后一个且已 settle → 清 entry（防内存泄漏）
  // 若期间有新 withFileLock 进来，会 set 一个新 tail，此时 locks.get(key) !== tail，本 finally 不误删
  tail.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  // 返回 run（非 tail）：调用方拿到的 Promise 仍会随 fn reject（错误冒泡）
  return run;
}

/**
 * fire-and-forget 模式（spec §3.1 模式 2）：入队后立即返回 void；fn 错误 log 不抛。
 *
 * 语义：
 *   - 内部 = `void withFileLock(...).catch(e => console.error(...))`，立即返回。
 *   - 写仍串行落盘（与 withFileLock 共享同一队列）。
 *   - 错误被吞，不抛 unhandledRejection。
 *   - 适用：best-effort 副作用写（如 unread UI 标记），调用方不依赖结果。
 *
 * @param filePath 用于 key 规范化的路径
 * @param fn 持锁期间执行的异步函数
 */
export function enqueueFileWrite(
  filePath: string,
  fn: () => Promise<unknown>,
): void {
  void withFileLock(filePath, fn).catch((e: unknown) => {
    // 错误隔离：吞掉，仅 log；不影响后续排队项也不抛 unhandled
    console.error('[file-lock]', e);
  });
}

/**
 * 测试专用：返回当前锁 Map 的 entry 数。
 * 用于 UT 验证「全部完成后 entry GC 不残留」（spec §3.4 末）。
 *
 * 生产代码请勿调用。
 */
export function getLockSize(): number {
  return locks.size;
}
