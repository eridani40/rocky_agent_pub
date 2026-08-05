/**
 * AbortSignal 合并工具（共享 helper）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3.4 §6.6
 *
 * 用途（spec §3.4 race runner）：
 *   raceSignal = mergeSignal([外部 ctx.signal, AbortSignal.timeout(总超时), raceController.signal])
 *   → 每个构造注入的 signal，任一 abort 即触发。
 *
 * Bun 兼容（spec §6.6 BUG-005）：超时一律用 AbortSignal.timeout，
 * 不依赖 undici dispatcher 的 headersTimeout/bodyTimeout（Bun undici 忽略）。
 */

/**
 * 合并多个 AbortSignal：任一 abort 即触发结果 signal 的 abort。
 * @param signals 待合并的 signal 列表（undefined / 已 abort 自动处理）
 * @returns 合并后的 signal；若任一输入已 aborted 则返回该 aborted signal
 */
export function mergeSignal(
  signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => Boolean(s));
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  // 任一已 abort → 立即返回该 aborted signal（避免新建 controller 漏掉已 abort 状态）
  const alreadyAborted = valid.find((s) => s.aborted);
  if (alreadyAborted) return alreadyAborted;
  const ctrl = new AbortController();
  for (const s of valid) {
    s.addEventListener(
      'abort',
      () => ctrl.abort((s as AbortSignal & { reason?: unknown }).reason),
      { once: true },
    );
  }
  return ctrl.signal;
}
