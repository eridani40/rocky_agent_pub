/**
 * format-time —— 消息时间显示格式化纯函数（chat 消息 bubble 后方极小 mono 时间戳）
 * 参考: specs/prd/version_logs/v0.0.165.ui_upgrade/change_log.md §4.1
 *       specs/ui/regulation/02-components.md §6（消息时间）
 *       specs/ui/components/chat-page/component-msg-time.md
 *
 * 设计意图：chat 消息 bubble 后跟一行极小 mono 时间戳，规则：
 *   - 同一日历日 → `HH:mm`（如 `14:07`）
 *   - 跨日 → `MM-dd HH:mm`（如 `07-15 09:32`）
 *   - 无效 iso（空串 / NaN Date）→ 兜底返空串（组件层再决定是否渲染）
 *
 * now 可注入用于 UT 时间稳定性（Date.now 会引入时序 flaky，禁）。
 *
 * 纯函数无副作用、无外部依赖（不引 date-fns，减包体积）。
 */

/** 两位十进制补零（内部工具，不 export） */
function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 把 ISO 字符串格式化为 chat 消息时间显示串。
 *
 * @param iso 消息 createdAt（ISO 字符串；空串或非法值兜底返 ''）
 * @param now 参考「当前时刻」（缺省 `new Date()`）；UT 注入以避 Date.now 时序 flaky
 * @returns 同日 `HH:mm`；跨日 `MM-dd HH:mm`；无效 iso → `''`
 *
 * 「同日」判定：本地时区下 year/month/date 三字段全相等；跨时区/夏令时按本地 date 判。
 * 纯函数无副作用。
 */
export function formatMsgTime(iso: string, now?: Date): string {
  // 边界：空字符串 / 非字符串直接兜底
  if (!iso || typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const ref = now ?? new Date();
  // 本地日历日比较（year/month/date 三字段全等 = 同日）
  const sameDay =
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate();

  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  if (sameDay) return `${hh}:${mm}`;

  // 跨日：MM-dd HH:mm（month 是 0-based，加 1 后补零）
  const mon = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${mon}-${day} ${hh}:${mm}`;
}

/**
 * 相对时间 kind：SeatCard 「N 分钟前活跃」派生（v0.0.165 T5）——纯函数返 kind，
 * i18n 文案由 UI 层查 `studio:timeAgo.{kind}`（避免本文件依赖 t()）。
 */
export type RelativeTimeKind =
  | { kind: 'justNow' }
  | { kind: 'minutesAgo'; n: number }
  | { kind: 'hoursAgo'; n: number }
  | { kind: 'daysAgo'; n: number };

/**
 * 把 ISO 字符串派生为相对时间 kind。
 * - <1 分钟 → justNow
 * - <60 分钟 → minutesAgo(n)
 * - <24 小时 → hoursAgo(n)
 * - 其他 → daysAgo(n)
 *
 * @param iso 目标时刻 ISO（无效则返 null，调用方降级处理）
 * @param now 参考「当前时刻」（缺省 `new Date()`）；UT 注入避时序 flaky
 * @returns kind 对象；无效 iso 返 null
 */
export function deriveRelativeTimeKind(iso: string, now?: Date): RelativeTimeKind | null {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ref = now ?? new Date();
  const diffMs = ref.getTime() - d.getTime();
  if (diffMs < 60_000) return { kind: 'justNow' };
  if (diffMs < 3_600_000) return { kind: 'minutesAgo', n: Math.floor(diffMs / 60_000) };
  if (diffMs < 86_400_000) return { kind: 'hoursAgo', n: Math.floor(diffMs / 3_600_000) };
  return { kind: 'daysAgo', n: Math.floor(diffMs / 86_400_000) };
}

export default formatMsgTime;
