/**
 * v0.0.350 四渠道额度解析器 UT — live-verify 实测响应原文作 fixture
 * 参考: specs/research/v0.0.350-live-verify.md §1-4（fixture 原文来源）
 *       specs/tech/version_logs/v0.0.350/change_plan.md 决策③⑨（解析规则 + 推导表）
 * 覆盖：kimi 字符串+used 直读+换算兜底；glm unit 分桶+number 变体+TIME_LIMIT 忽略+禁排序+success=false；
 *       minimax general 过滤+100−反转+status 门控；deepseek 字符串金额；deriveQuotaBaseUrl 推导表。
 */
import { describe, it, expect } from 'vitest';
import { parseKimiQuota } from '../provider-kimi';
import { parseGlmQuota } from '../provider-glm';
import { parseMinimaxQuota } from '../provider-minimax';
import { parseDeepseekBalance } from '../provider-deepseek';
import { deriveQuotaBaseUrl, parseNum, parseResetTime } from '../quota-shared';
import { QuotaBusinessError } from '../quota-shared';

const META = { providerId: 'p1', providerLabel: 'label-1' };

describe('parseKimiQuota — live-verify §1 实测原文', () => {
  const FIXTURE = {
    user: { userId: 'co01***', region: 'REGION_CN', membership: { level: 'LEVEL_ADVANCED' } },
    usage: { limit: '100', used: '83', remaining: '17', resetTime: '2026-08-15T04:26:12Z' },
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-08-14T16:26:12Z' } }],
    parallel: { limit: '30' },
  };
  it('实测原文：5h 桶换算 0% + 周桶 used 直读 83% + membership 透出', () => {
    const snap = parseKimiQuota(FIXTURE, META);
    expect(snap.kind).toBe('quota');
    expect(snap.membership).toBe('LEVEL_ADVANCED');
    expect(snap.tiers).toEqual([
      { window: 'five_hour', usedPercent: 0, resetsAt: '2026-08-14T16:26:12Z' },
      { window: 'weekly', usedPercent: 83, resetsAt: '2026-08-15T04:26:12Z' },
    ]);
  });
  it('used 缺失 → limit-remaining 换算兜底（100-17=83）', () => {
    const snap = parseKimiQuota({ usage: { limit: '100', remaining: '17' } }, META);
    expect(snap.tiers).toEqual([{ window: 'weekly', usedPercent: 83, resetsAt: undefined }]);
  });
  it('5h 满额形态：detail 无 remaining 只有 used 直读 → five_hour tier 不丢（BUG 修复回归）', () => {
    // 2026-08-15 kimi-2 实测：打满后上游省略 remaining，只剩 limit/used/resetTime
    // 参考: outputs/bugs/kimi2-five-hour-tier-missing.md §1
    const snap = parseKimiQuota({
      usage: { limit: '600', used: '366', resetTime: '2026-08-17T04:26:12Z' },
      limits: [{ detail: { limit: '100', used: '100', resetTime: '2026-08-15T12:24:56Z' } }],
    }, META);
    expect(snap.tiers).toEqual([
      { window: 'five_hour', usedPercent: 100, resetsAt: '2026-08-15T12:24:56Z' },
      { window: 'weekly', usedPercent: 61, resetsAt: '2026-08-17T04:26:12Z' },
    ]);
  });
  it('5h 桶 used 与 remaining 并存 → used 直读优先（同周桶口径）', () => {
    const snap = parseKimiQuota({ limits: [{ detail: { limit: '100', used: '34', remaining: '66', resetTime: '2026-08-14T16:26:12Z' } }] }, META);
    expect(snap.tiers).toEqual([{ window: 'five_hour', usedPercent: 34, resetsAt: '2026-08-14T16:26:12Z' }]);
  });
  it('usage/limits 全缺 → tiers undefined（impl 层判 business 错误）', () => {
    expect(parseKimiQuota({}, META).tiers).toBeUndefined();
  });
});

describe('parseGlmQuota — live-verify §2 实测原文', () => {
  const FIXTURE = {
    code: 200, msg: '操作成功', success: true,
    data: { level: 'max', limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 36, nextResetTime: 1786725307528 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 25, nextResetTime: 1787031490998 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 88, remaining: 3912, percentage: 2, nextResetTime: 1788500290998 },
    ] },
  };
  it('实测原文：unit:3→5h 36% + unit:6→周 25%（number 不锚定）+ TIME_LIMIT 忽略 + membership', () => {
    const snap = parseGlmQuota(FIXTURE, META);
    expect(snap.membership).toBe('max');
    expect(snap.tiers).toHaveLength(2); // TIME_LIMIT 不产生 tier
    expect(snap.tiers![0]).toEqual({ window: 'five_hour', usedPercent: 36, resetsAt: new Date(1786725307528).toISOString() });
    expect(snap.tiers![1]).toEqual({ window: 'weekly', usedPercent: 25, resetsAt: new Date(1787031490998).toISOString() });
  });
  it('禁按重置时间排序：unit:6 在前 → 输出保持响应原序 [weekly, five_hour]', () => {
    const snap = parseGlmQuota({ data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 6, number: 7, percentage: 10, nextResetTime: 2 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 1, percentage: 20, nextResetTime: 1 },
    ] } }, META);
    expect(snap.tiers!.map((t) => t.window)).toEqual(['weekly', 'five_hour']);
  });
  it('CREDIT_LIMIT 大小写不敏感也分桶', () => {
    const snap = parseGlmQuota({ data: { limits: [
      { type: 'credit_limit', unit: 3, percentage: 50, nextResetTime: 1786725307528 },
    ] } }, META);
    expect(snap.tiers).toHaveLength(1);
    expect(snap.tiers![0]!.window).toBe('five_hour');
  });
  it('success=false → QuotaBusinessError 透 msg', () => {
    expect(() => parseGlmQuota({ success: false, msg: '未登录' }, META)).toThrow(QuotaBusinessError);
    expect(() => parseGlmQuota({ success: false, msg: '未登录' }, META)).toThrow('未登录');
  });
});

describe('parseMinimaxQuota — live-verify §3 实测原文', () => {
  const FIXTURE = {
    model_remains: [
      { model_name: 'general', end_time: 1786723200000, weekly_end_time: 1786896000000,
        current_interval_remaining_percent: 99, current_weekly_status: 3, current_weekly_remaining_percent: 100 },
      { model_name: 'video', end_time: 1786723200000, current_interval_remaining_percent: 10 },
    ],
  };
  it('实测原文：general 过滤 + 5h 反转 1%（100−99）+ status=3 无周桶', () => {
    const snap = parseMinimaxQuota(FIXTURE, META);
    expect(snap.tiers).toEqual([{ window: 'five_hour', usedPercent: 1, resetsAt: new Date(1786723200000).toISOString() }]);
  });
  it('current_weekly_status==1 → 周桶出现（反转）', () => {
    const snap = parseMinimaxQuota({ model_remains: [
      { model_name: 'general', current_interval_remaining_percent: 80, current_weekly_status: 1, current_weekly_remaining_percent: 40 },
    ] }, META);
    expect(snap.tiers).toEqual([
      { window: 'five_hour', usedPercent: 20, resetsAt: undefined },
      { window: 'weekly', usedPercent: 60, resetsAt: undefined },
    ]);
  });
  it('base_resp.status_code!=0 → QuotaBusinessError 透 status_msg', () => {
    expect(() => parseMinimaxQuota({ base_resp: { status_code: 1001, status_msg: '鉴权失败' } }, META))
      .toThrow('鉴权失败');
  });
});

describe('parseDeepseekBalance — live-verify §4 实测原文', () => {
  const FIXTURE = {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '9122.69', granted_balance: '0.00', topped_up_balance: '9122.69' }],
  };
  it('实测原文：字符串金额解析 + isAvailable', () => {
    const r = parseDeepseekBalance(FIXTURE);
    expect(r.isAvailable).toBe(true);
    expect(r.balances).toEqual([{ currency: 'CNY', total: 9122.69, granted: 0, toppedUp: 9122.69 }]);
  });
  it('balance_infos 空 → 空数组（impl 层判 business 错误）', () => {
    expect(parseDeepseekBalance({ is_available: false }).balances).toEqual([]);
  });
});

describe('deriveQuotaBaseUrl — 决策③推导表', () => {
  it('kimi：baseUrl 原样（保留 /coding 前缀）+ 尾斜杠清理', () => {
    expect(deriveQuotaBaseUrl('kimi_coding_plan', 'https://api.kimi.com/coding')).toBe('https://api.kimi.com/coding');
    expect(deriveQuotaBaseUrl('kimi_coding_plan', 'https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding');
  });
  it('glm：bigmodel.cn → open.bigmodel.cn；否则 z.ai', () => {
    expect(deriveQuotaBaseUrl('glm_coding_plan', 'https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn');
    expect(deriveQuotaBaseUrl('glm_coding_plan', 'https://api.z.ai/api/anthropic')).toBe('https://api.z.ai');
  });
  it('minimax：minimax.io → 国际域；否则 minimaxi.com', () => {
    expect(deriveQuotaBaseUrl('minimax_coding_plan', 'https://api.minimax.io/anthropic')).toBe('https://api.minimax.io');
    expect(deriveQuotaBaseUrl('minimax_coding_plan', 'https://api.minimaxi.com/anthropic')).toBe('https://api.minimaxi.com');
  });
  it('deepseek：取 origin（自定义代理只换 host）', () => {
    expect(deriveQuotaBaseUrl('deepseek_api', 'https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com');
    expect(deriveQuotaBaseUrl('deepseek_api', 'http://localhost:8080/ds')).toBe('http://localhost:8080');
  });
});

describe('parseNum / parseResetTime — 共享 helper 边界', () => {
  it('parseNum：number/字符串/非法', () => {
    expect(parseNum(36)).toBe(36);
    expect(parseNum('83')).toBe(83);
    expect(parseNum('abc')).toBeUndefined();
    expect(parseNum(undefined)).toBeUndefined();
  });
  it('parseResetTime：ISO 原样 / 秒(<1e12) / 毫秒 / 非法 undefined', () => {
    expect(parseResetTime('2026-08-15T04:26:12Z')).toBe('2026-08-15T04:26:12Z');
    expect(parseResetTime(1786725307)).toBe(new Date(1786725307 * 1000).toISOString());
    expect(parseResetTime(1786725307528)).toBe(new Date(1786725307528).toISOString());
    expect(parseResetTime('not-a-date')).toBeUndefined();
  });
});
