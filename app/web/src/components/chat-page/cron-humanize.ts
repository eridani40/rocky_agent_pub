/**
 * cron-humanize —— cron expr → 中文人话
 * 参考: specs/ui/components/chat-page/component-cron-panel.md §1/§6
 *       specs/prd/version_logs/v0.0.58/change_log.md §5.1（展示态翻译规则）
 *       specs/api/overall/16-cron.md §6（UI 不暴露 raw expr 校验细节，cronstrue 翻译不出 fallback raw）
 *
 * 职责：包装 cronstrue（zh_CN），库翻译不出时 fallback raw expr。
 * 仅 UI 层用（展示态 + 频率选择器实时预览）；工具层 / 后端不感知「人话」。
 */
import cronstrue from 'cronstrue';
// zh_CN locale 注册（cronstrue 2.x：side-effect import 把 locale 装载进 cronstrue）
import 'cronstrue/locales/zh_CN';

/**
 * cron expr → 中文人话。
 * 库翻译成功 → 返翻译；翻译抛错或结果为英文占位 → fallback raw expr。
 *
 * @param cron 5 字段 cron expr（如 星号-斜杠-30 空格 星号 空格 星号 空格 星号 空格 星号，即每 30 分钟）
 * @returns 人话字符串（如「每 30 分钟」）；翻译不出返原 expr
 */
export function cronHumanize(cron: string): string {
  if (!cron || typeof cron !== 'string') return cron ?? '';
  const trimmed = cron.trim();
  try {
    const out = cronstrue.toString(trimmed, { locale: 'zh_CN' });
    // cronstrue 翻译失败时部分版本会返英文「An error occured」 etc.，做兜底
    if (!out || /error|occured|occurr/i.test(out)) return trimmed;
    return out;
  } catch {
    return trimmed;
  }
}

/** 频率预设类型（与 component-cron-freq-picker 内 state 对齐） */
export type CronPreset = 'minutes' | 'hours' | 'daily' | 'weekly' | 'advanced';

/** 周几 → 数字（1=周一…6=周六，0/7=周日；UI 上「周日」用 0） */
export const WEEKDAY_LABELS: Record<number, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  0: '周日',
  7: '周日',
};

/**
 * 频率选择器输入 → cron expr（程序生成，不调 cronstrue parse）。
 * 4 预设映射对齐 PRD §5.2：
 *   - minutes: 分钟字段写 星号-斜杠-N，其余 4 字段全是 星号
 *   - hours:   分钟=0，小时=星号-斜杠-N，其余 3 字段 星号
 *   - daily:   分 时 两个数字字段，剩余 dom/month/dow 全是 星号
 *   - weekly:  分 时 数字 + dom/month 星号 + dow 一个数字（1-7，1=周一…7=周日）
 *
 * advanced 由调用方直接传 raw expr，不走本函数。
 *
 * @param preset 预设类型
 * @param input 输入参数（按 preset 用不同字段）
 * @returns 5 字段 cron expr
 */
export function buildCronExpr(
  preset: Exclude<CronPreset, 'advanced'>,
  input: { intervalMin?: number; intervalHour?: number; timeHHmm?: string; weekday?: number },
): string {
  if (preset === 'minutes') {
    const n = Math.max(1, Math.floor(input.intervalMin ?? 30));
    return `*/${n} * * * *`;
  }
  if (preset === 'hours') {
    const n = Math.max(1, Math.floor(input.intervalHour ?? 4));
    return `0 */${n} * * *`;
  }
  // daily / weekly 都需要 HH:mm；不 pad（标准 cron 接受单/双位）
  // 注意：parseInt('00')=0 是合法值，不能用 || 9 兜底（会覆盖 0 → 9）
  const [hStr, mStr] = (input.timeHHmm ?? '09:00').split(':');
  const hParsed = parseInt(hStr ?? '', 10);
  const mParsed = parseInt(mStr ?? '', 10);
  const h = Math.min(23, Math.max(0, isNaN(hParsed) ? 9 : hParsed));
  const m = Math.min(59, Math.max(0, isNaN(mParsed) ? 0 : mParsed));
  if (preset === 'daily') {
    return `${m} ${h} * * *`;
  }
  // weekly: 1-7（1=周一…7=周日）；0 → 7（cron 标准 7=周日）
  const wdRaw = input.weekday ?? 1;
  const wd = wdRaw === 0 ? 7 : Math.min(7, Math.max(1, wdRaw));
  return `${m} ${h} * * ${wd}`;
}
