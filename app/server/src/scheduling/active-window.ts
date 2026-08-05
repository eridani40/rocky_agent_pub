/**
 * 活跃时段判定纯函数（从 squad/scheduler/gate-chain.ts 迁出，公共化）。
 * 参考: specs/tech/scheduling/[P0]engine.md §4（isDue interval 首次排法调 withinActiveWindow）
 *       specs/tech/squad/[P1]scheduler.md §4（cross-midnight 算法不变量）
 *
 * 设计：
 *   - 纯函数（now/tz 注入，确定性 UT seam）
 *   - cross-midnight 语义：start>end 视为夜班窗口（22:00-06:00）
 *   - 用 Intl.DateTimeFormat 转用户时区本地 HH:mm（无额外 tz 库依赖）
 *
 * 迁移背景：v0.0.58 把 SquadScheduler 提升为公共 SchedulerEngine，
 * withinActiveWindow 是 interval isDue 首次排法的依赖（不仅是 squad heartbeat 用），
 * 故迁到 scheduling/。原 squad/scheduler/gate-chain.ts 将在 T2 改为 re-export。
 */

/**
 * UTC 瞬时 → 指定时区的本地 "HH:mm"（24h padded）。
 * hourCycle:'h23' 保证午夜为 "00" 而非 "24"（hour12:false 在部分 locale 仍可能输出 24）。
 *
 * @param now 进程瞬时（UTC epoch）
 * @param tz  IANA 时区（如 'Asia/Shanghai' / 'UTC'）
 * @returns "HH:mm"（24h padded）
 */
export function toTimeZoneHHmm(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  }).formatToParts(now);
  const h = parts.find(p => p.type === 'hour')?.value ?? '00';
  const m = parts.find(p => p.type === 'minute')?.value ?? '00';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/**
 * 判定 now 是否在 activeWindow 内（纯函数）。
 *   - 同日窗口（start<=end）：start <= localHHmm < end
 *   - 跨午夜窗口（start>end，如 22:00-06:00）：localHHmm >= start || localHHmm < end
 *
 * 边界：start 含、end 不含；start==end 视为空窗口（恒 false）。
 *
 * @param activeWindow {start, end}（HH:mm 24h padded）
 * @param now          进程瞬时（UTC epoch）
 * @param tz           IANA 时区
 */
export function withinActiveWindow(
  activeWindow: { start: string; end: string },
  now: Date,
  tz: string,
): boolean {
  const localHHmm = toTimeZoneHHmm(now, tz);
  if (activeWindow.start <= activeWindow.end) {
    // 同日窗口（含等长=空窗口，恒 false）
    return localHHmm >= activeWindow.start && localHHmm < activeWindow.end;
  }
  // 跨午夜窗口
  return localHHmm >= activeWindow.start || localHHmm < activeWindow.end;
}
