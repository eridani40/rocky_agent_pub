/**
 * dailyTimeToCron —— consolidation job 的 "HH:mm" → cron expr 固定公式转换。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §5
 *       specs/ui/components/chat-page/component-cron-freq-picker.md（"每天 HH:mm" 同款公式先例）
 *
 * 设计：只做这一种固定形态（每天 HH:mm）的字符串拼接，不引入通用 cron 构造器（YAGNI）。
 * 复用既有 computeNextCronRunMs（cron-next.ts）计算下次到点，本函数不改动该逻辑。
 */

/**
 * "HH:mm" → 5 字段 cron expr "M H * * *"（分钟 时 * * *）。
 * 例：dailyTimeToCron("04:00") === "0 4 * * *"；dailyTimeToCron("18:30") === "30 18 * * *"。
 *
 * @param dailyTime app_config.consolidation.dailyTime（"HH:mm" 24h 格式；由 schema 保证合法）
 */
export function dailyTimeToCron(dailyTime: string): string {
  const [hh, mm] = dailyTime.split(':');
  const hour = parseInt(hh ?? '0', 10);
  const minute = parseInt(mm ?? '0', 10);
  return `${minute} ${hour} * * *`;
}
