/**
 * @vitest-environment jsdom
 * component-token-stats-helpers 单测 —— 单位 M 格式化 + cacheRate % 转换
 * 参考: specs/ui/components/studio-page/component-token-stats.md §口径
 *       specs/prd/version_logs/v0.0.194/prd.md §2.2 单位口径
 *
 * 覆盖 T2 UT 范围（test-plan §新 UT）：
 *   - 单位 M 格式化（4 档边界：<0.01M / <1M / <100M / ≥100M）
 *   - cacheRate % 转换（1 位小数 + 去尾 0 + 分母 ≤0 兜底）
 */
import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  formatCacheRate,
  computeAxisMax,
  kindColor,
  kindLabelCN,
  heatColor,
  formatDateCN,
  formatDateShort,
  formatHour,
  parseModelSelection,
} from '../component-token-stats-helpers';

describe('formatTokens —— token 数值 M 单位格式化', () => {
  it('0 → "0M"', () => {
    expect(formatTokens(0)).toBe('0M');
  });

  it('<0.01M（<10000）→ "<0.01M" 兜底（正数）', () => {
    expect(formatTokens(1)).toBe('<0.01M');
    expect(formatTokens(9999)).toBe('<0.01M');
  });

  it('<1M（<1,000,000）→ 2 位小数（去尾 0）', () => {
    expect(formatTokens(500_000)).toBe('0.5M');
    expect(formatTokens(120_000)).toBe('0.12M');
    expect(formatTokens(10_000)).toBe('0.01M');
  });

  it('<100M（<100,000,000）→ 1 位小数（去尾 0）', () => {
    expect(formatTokens(5_000_000)).toBe('5M');
    expect(formatTokens(5_200_000)).toBe('5.2M');
    expect(formatTokens(99_999_999)).toBe('100M'); // 实际 99.999999M 向上取整到 1 位 = 100M
  });

  it('≥100M → 整数', () => {
    expect(formatTokens(100_000_000)).toBe('100M');
    expect(formatTokens(1_500_000_000)).toBe('1500M');
  });

  it('去尾 0：5.00M → 5M / 0.50M → 0.5M', () => {
    expect(formatTokens(5_000_000)).toBe('5M');
    expect(formatTokens(500_000)).toBe('0.5M');
  });
});

describe('formatCacheRate —— 缓存率 % 格式化', () => {
  it('分母 ≤0 → "0%" 兜底', () => {
    // 分母 = cache + input；同号 ≤0 时无意义
    expect(formatCacheRate(0, 0)).toBe('0%');
    expect(formatCacheRate(-5, -5)).toBe('0%');
  });

  it('cache=0 且 input>0 → "0%"（分母 >0 但分子为 0）', () => {
    expect(formatCacheRate(0, 100)).toBe('0%');
  });

  it('cache / (cache + input) * 100，1 位小数', () => {
    // 50% (cache=100, input=100 → 100/200=50%)
    expect(formatCacheRate(100, 100)).toBe('50%');
    // 33.3% (cache=100, input=200 → 100/300=33.33...%)
    expect(formatCacheRate(100, 200)).toBe('33.3%');
    // 66.7% (cache=200, input=100 → 200/300=66.66...%)
    expect(formatCacheRate(200, 100)).toBe('66.7%');
  });

  it('去尾 0：50.0% → 50%', () => {
    expect(formatCacheRate(100, 100)).toBe('50%');
    expect(formatCacheRate(500, 500)).toBe('50%');
  });

  it('100%（input=0 但 cache>0 → cache/(cache+0)=1.0=100%）', () => {
    expect(formatCacheRate(100, 0)).toBe('100%');
  });
});

describe('computeAxisMax —— Y 轴最大值漂亮步长', () => {
  const M = 1_000_000;

  it('maxTotal ≤0 → 默认 1M', () => {
    expect(computeAxisMax(0)).toBe(M);
    expect(computeAxisMax(-100)).toBe(M);
  });

  it('m ≤0.5 → step 0.25M', () => {
    expect(computeAxisMax(0.1 * M)).toBe(0.25 * M);
    expect(computeAxisMax(0.5 * M)).toBe(0.5 * M);
  });

  it('m ≤2 → step 0.5M', () => {
    expect(computeAxisMax(1 * M)).toBe(1 * M);
    expect(computeAxisMax(1.3 * M)).toBe(1.5 * M);
  });

  it('m ≤5 → step 1M', () => {
    expect(computeAxisMax(3 * M)).toBe(3 * M);
  });

  it('m >20 → step 10M', () => {
    expect(computeAxisMax(25 * M)).toBe(30 * M);
  });
});

describe('kindColor / kindLabelCN —— 颜色 + 中文 label', () => {
  it('kindColor hue palette 映射', () => {
    expect(kindColor('input')).toBe('var(--hue-blue)');
    expect(kindColor('output')).toBe('var(--hue-violet)');
    expect(kindColor('cache')).toBe('var(--hue-green)');
    expect(kindColor('cacheRate')).toBe('var(--hue-amber)');
  });

  it('kindLabelCN 中文 label', () => {
    expect(kindLabelCN('total')).toBe('总览');
    expect(kindLabelCN('input')).toBe('输入');
    expect(kindLabelCN('output')).toBe('输出');
    expect(kindLabelCN('cache')).toBe('缓存');
    expect(kindLabelCN('cacheRate')).toBe('缓存率');
  });
});

describe('heatColor —— 日历热力色阶', () => {
  it('value ≤0 或 max ≤0 → transparent', () => {
    expect(heatColor(0, 100)).toBe('transparent');
    expect(heatColor(100, 0)).toBe('transparent');
    expect(heatColor(-5, 100)).toBe('transparent');
  });

  it('ratio <0.25 → alpha 0.15', () => {
    expect(heatColor(10, 100)).toBe('rgba(59, 130, 246, 0.15)');
  });

  it('ratio ≥0.75 → alpha 0.8', () => {
    expect(heatColor(80, 100)).toBe('rgba(59, 130, 246, 0.8)');
  });

  it('自定义 baseRgb', () => {
    expect(heatColor(80, 100, '245, 158, 11')).toBe('rgba(245, 158, 11, 0.8)');
  });
});

describe('formatDateCN / formatDateShort / formatHour', () => {
  it('YYYY-MM-DD → M月D日', () => {
    expect(formatDateCN('2026-07-05')).toBe('7月5日');
  });

  it('YYYY-MM-DD → M/D', () => {
    expect(formatDateShort('2026-07-05')).toBe('7/5');
  });

  it('YYYY-MM-DD HH → HH', () => {
    expect(formatHour('2026-07-05 14')).toBe('14');
  });
});

describe('parseModelSelection —— model 筛选下拉 value 解码（按首斜杠切）', () => {
  it('modelId 含 `/`（OpenRouter deepseek/deepseek-chat）：整体保留不截断（核心回归用例）', () => {
    expect(parseModelSelection('01KVWXYZ012345678901234567/deepseek/deepseek-chat')).toEqual({
      providerId: '01KVWXYZ012345678901234567',
      modelId: 'deepseek/deepseek-chat',
    });
  });

  it('普通无 `/` modelId（MiniMax-M3）：正常切', () => {
    expect(parseModelSelection('01KVWXYZ012345678901234567/MiniMax-M3')).toEqual({
      providerId: '01KVWXYZ012345678901234567',
      modelId: 'MiniMax-M3',
    });
  });

  it('__unknown__ provider：正常切（providerId 不限定 ULID 形态）', () => {
    expect(parseModelSelection('__unknown__/some-model')).toEqual({
      providerId: '__unknown__',
      modelId: 'some-model',
    });
  });

  it('"__all__" → undefined（不带 model 筛选）', () => {
    expect(parseModelSelection('__all__')).toBeUndefined();
  });

  it('无 `/` 的非法串 → undefined', () => {
    expect(parseModelSelection('garbage')).toBeUndefined();
  });
});
