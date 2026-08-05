// @vitest-environment node
/**
 * formatTraffic —— 流量/Token 量级格式化纯函数（K/M/B/T 分级）
 * 参考: specs/prd/version_logs/v0.0.96.ui_fix.md §2.1（usage 面板累积消耗区单位格式化）
 *       specs/ui/components/chat-page/component-usage-panel.md §4.3/§4.7（累积消耗表格展示需求）
 *       specs/tech/version_logs/v0.0.96.ui_fix/change_plan.md Feature 1 行（method 级变更契约）
 *
 * 设计意图：累积消耗区展示 input/output/total 三列时，数字常达 K/M 量级。
 * 旧实现 fmtNum 走 toLocaleString 返「1,234,567」三位逗号长串，在 280px 紧凑面板里折行/撑宽。
 * 本函数按 1000 进位返「1.2M」短串（1 位小数 toFixed 自带 round），列宽稳定防抖动。
 *
 * 量级分级：< 1000 原值；K = 1e3；M = 1e6；B = 1e9；T = 1e12。
 * 边界规则：0 / 负数 / NaN / Infinity 原样 String(n)——防 -1.5K / NaNK 等丑态。
 *
 * 仅用于「累积消耗区 input/output/total」三列（O1 裁决：圆环「已用/总」概览 fmtK 不动，
 * cache 列百分比语义不动）。
 */

/**
 * 把数字按量级格式化为短串：K/M/B/T 1 位小数分级。
 *
 * @param n 任意 number（含 0/负/NaN/Infinity 等边界）
 * @returns < 1000 → 原值字符串；≥ 1000 → 「{值/量级}」1 位小数；边界 → String(n)
 *
 * 纯函数无副作用，不读外部状态。toFixed(1) 自带 round，无手动四舍五入。
 */
export function formatTraffic(n: number): string {
  // 边界兜底：非有限数（NaN/Infinity/±Infinity）或负数或 0 → 原值字符串
  // 防止 -1500 → "-1.5K"、0 → "0.0K"、NaN → "NaNK" 等丑态
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(n);

  // 量级分级（升序判断）：K → M → B → T
  if (n < 1e6) return (n / 1e3).toFixed(1) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(1) + 'M';
  if (n < 1e12) return (n / 1e9).toFixed(1) + 'B';
  return (n / 1e12).toFixed(1) + 'T';
}

export default formatTraffic;
