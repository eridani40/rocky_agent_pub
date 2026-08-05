/**
 * session-usage-helper 单元测试 — ratio 滑动窗口 + clamp + view 派生纯函数
 * 参考: specs/tech/agent/session/[P0]session_usage.md §7（ratio 学习）§8（view）
 *
 * 覆盖：
 *   - computeRatioSample：clamp 0.2-5.0 + 非法输入返 null
 *   - pushRatioSample：sliding 3 + 冷启动 1.0 + 中位数
 *   - accumulatePartition：字段 Σ + llmCallCount++
 *   - sumPartitions：三分区 Σ
 *   - deriveUsageView：view 派生 + contextWindowUsage 透传
 */
import { describe, it, expect } from 'vitest';
import {
  emptyMeta,
  emptyPartition,
  normalizeMeta,
  accumulatePartition,
  computeRatioSample,
  pushRatioSample,
  sumPartitions,
  deriveUsageView,
  computeCacheRate,
  normalizeContextWindowUsage,
  sumUsage,
} from '../session-usage-helper';
import type { Usage } from '../../message/types';

describe('computeRatioSample — clamp + 非法输入', () => {
  it('正常 sample = input_total_tokens / inputCharCount', () => {
    expect(computeRatioSample({ input_total_tokens: 500, inputCharCount: 1000 } as Usage)).toBe(0.5);
    expect(computeRatioSample({ input_total_tokens: 2000, inputCharCount: 1000 } as Usage)).toBe(2.0);
  });
  it('clamp 下界 0.2', () => {
    expect(computeRatioSample({ input_total_tokens: 100, inputCharCount: 1000 } as Usage)).toBe(0.2);
  });
  it('clamp 上界 5.0', () => {
    expect(computeRatioSample({ input_total_tokens: 10000, inputCharCount: 1000 } as Usage)).toBe(5.0);
  });
  it('inputCharCount 缺失/0/负 → null（不学）', () => {
    expect(computeRatioSample({ input_total_tokens: 100 } as Usage)).toBeNull();
    expect(computeRatioSample({ input_total_tokens: 100, inputCharCount: 0 } as Usage)).toBeNull();
    expect(computeRatioSample({ input_total_tokens: 100, inputCharCount: -5 } as Usage)).toBeNull();
  });
  it('input_total_tokens 缺失 → null', () => {
    expect(computeRatioSample({ inputCharCount: 1000 } as Usage)).toBeNull();
  });
});

describe('pushRatioSample — sliding 3 + 冷启动 + 中位数', () => {
  it('窗口未满 → current 保持 1.0（冷启动）', () => {
    const w1 = pushRatioSample({ samples: [], current: 1.0 }, 0.5);
    expect(w1.current).toBe(1.0);
    expect(w1.samples).toEqual([0.5]);
    const w2 = pushRatioSample(w1, 1.0);
    expect(w2.current).toBe(1.0);
    expect(w2.samples).toEqual([0.5, 1.0]);
  });
  it('窗口满 3 → 取中位数', () => {
    let w = { samples: [] as number[], current: 1.0 };
    w = pushRatioSample(w, 0.5);
    w = pushRatioSample(w, 1.0);
    w = pushRatioSample(w, 2.0);
    // [0.5, 1.0, 2.0].sort → mid = 1.0
    expect(w.current).toBe(1.0);
  });
  it('窗口滑出旧 sample（保留最近 3）', () => {
    let w = { samples: [] as number[], current: 1.0 };
    w = pushRatioSample(w, 0.5);
    w = pushRatioSample(w, 1.0);
    w = pushRatioSample(w, 2.0);
    w = pushRatioSample(w, 3.0);
    // 窗口=[1.0, 2.0, 3.0] → 中位数 2.0
    expect(w.samples).toEqual([1.0, 2.0, 3.0]);
    expect(w.current).toBe(2.0);
  });
});

describe('accumulatePartition — 字段 Σ + llmCallCount++', () => {
  it('首次累加：写入字段 + llmCallCount=1', () => {
    const p = accumulatePartition(emptyPartition(), {
      total_tokens: 100, input_total_tokens: 80, cost: 0.01,
    } as Usage);
    expect(p.fields.total_tokens).toBe(100);
    expect(p.fields.input_total_tokens).toBe(80);
    expect(p.fields.cost).toBeCloseTo(0.01, 6);
    expect(p.llmCallCount).toBe(1);
  });
  it('多次累加：字段 Σ + llmCallCount++', () => {
    let p = emptyPartition();
    p = accumulatePartition(p, { total_tokens: 100, cost: 0.01 } as Usage);
    p = accumulatePartition(p, { total_tokens: 50, cost: 0.005 } as Usage);
    p = accumulatePartition(p, { total_tokens: 25, cost: 0.0025 } as Usage);
    expect(p.fields.total_tokens).toBe(175);
    expect(p.fields.cost).toBeCloseTo(0.0175, 6);
    expect(p.llmCallCount).toBe(3);
  });
  it('跳过非法（非数字）字段不污染累计', () => {
    const p = accumulatePartition(emptyPartition(), {
      total_tokens: NaN, cost: 'bad' as unknown as number,
    } as Usage);
    expect(p.fields.total_tokens).toBeUndefined();
    expect(p.fields.cost).toBeUndefined();
    expect(p.llmCallCount).toBe(1); // 调用次数仍计
  });
});

describe('sumUsage — 两 Usage Σ（v0.0.235 RunResult.usage 聚合）', () => {
  it('两非空 Σ 各数值字段', () => {
    const a = { total_tokens: 100, cost: 0.01, input_total_tokens: 80 } as Usage;
    const b = { total_tokens: 50, cost: 0.005, input_total_tokens: 40, output_total_tokens: 30 } as Usage;
    const out = sumUsage(a, b);
    expect(out.total_tokens).toBe(150);
    expect(out.cost).toBeCloseTo(0.015, 6);
    expect(out.input_total_tokens).toBe(120);
    expect(out.output_total_tokens).toBe(30); // a 缺该字段，取 b
  });

  it('一入参空对象 → 等价另一入参', () => {
    const a = {} as Usage;
    const b = { total_tokens: 50, cost: 0.005 } as Usage;
    const out = sumUsage(a, b);
    expect(out.total_tokens).toBe(50);
    expect(out.cost).toBeCloseTo(0.005, 6);
  });

  it('b=null → 直接返回 a（callLLMForSpec 返 null 兜底）', () => {
    const a = { total_tokens: 100, cost: 0.01 } as Usage;
    const out = sumUsage(a, null);
    expect(out).toBe(a); // 引用相同
    expect(out.total_tokens).toBe(100);
  });

  it('currency 缺则取 b.currency（保留计费币种）', () => {
    const a = { total_tokens: 100 } as Usage;
    const b = { total_tokens: 50, currency: 'CNY' as never } as Usage;
    const out = sumUsage(a, b);
    expect(out.currency).toBe('CNY');
    // a 已有 currency 时保留 a（不覆盖）
    const a2 = { total_tokens: 100, currency: 'USD' as never } as Usage;
    const out2 = sumUsage(a2, b);
    expect(out2.currency).toBe('USD');
  });

  it('非 number 字段跳过（不污染）', () => {
    const a = { total_tokens: 100 } as Usage;
    const b = { total_tokens: NaN, cost: 'bad' as unknown as number } as Usage;
    const out = sumUsage(a, b);
    expect(out.total_tokens).toBe(100); // NaN 跳过，保留 a 值
    expect(out.cost).toBeUndefined(); // 非法 cost 跳过
  });
});

describe('sumPartitions — 三分区 Σ', () => {
  it('空分区和 = 空', () => {
    const s = sumPartitions([emptyPartition(), emptyPartition(), emptyPartition()]);
    expect(s.fields).toEqual({});
    expect(s.llmCallCount).toBe(0);
  });
  it('三分区 Σ 各字段 + llmCallCount', () => {
    const a = accumulatePartition(emptyPartition(), { total_tokens: 100 } as Usage);
    const b = accumulatePartition(emptyPartition(), { total_tokens: 50, cost: 0.01 } as Usage);
    const c = accumulatePartition(emptyPartition(), { total_tokens: 25, cost: 0.005 } as Usage);
    const s = sumPartitions([a, b, c]);
    expect(s.fields.total_tokens).toBe(175);
    expect(s.fields.cost).toBeCloseTo(0.015, 6);
    expect(s.llmCallCount).toBe(3);
  });
});

describe('deriveUsageView — 派生 + contextWindowUsage 透传', () => {
  it('空 meta → 空 view + ratio 1.0', () => {
    const v = deriveUsageView(emptyMeta());
    expect(v.current).toEqual({ llmCallCount: 0 });
    expect(v.total).toEqual({ llmCallCount: 0 });
    expect(v.ratio).toBe(1.0);
  });
  it('current + forked 累计 → total Σ', () => {
    let meta = emptyMeta();
    meta.current = accumulatePartition(meta.current, { total_tokens: 100 } as Usage);
    meta.forked = accumulatePartition(meta.forked, { total_tokens: 50 } as Usage);
    const v = deriveUsageView(meta);
    expect(v.current.total_tokens).toBe(100);
    expect(v.forked.total_tokens).toBe(50);
    expect(v.sub.total_tokens).toBeUndefined();
    expect(v.total.total_tokens).toBe(150);
    expect(v.total.llmCallCount).toBe(2);
  });
  it('contextWindowUsage 透传到 view', () => {
    // [v0.0.16] 7 字段 ContextWindowUsage
    const cw = {
      systemTokens: 100,
      messageTokens: 700,
      toolTokens: 200,
      totalTokens: 1000,
      maxOutputTokens: 20000,
      tokenLimit: 8000,
      remainingTokens: 8000 - 1000 - 20000,
    };
    const v = deriveUsageView(emptyMeta(), cw);
    expect(v.contextWindowUsage).toEqual(cw);
  });
});

// ============================================================
// [v0.0.16] computeCacheRate + deriveUsageView cacheRate 派生
// spec session_usage.md §8「cacheRate（4 个派生字段）」
// ============================================================

describe('computeCacheRate — cache_read / input_total（v0.0.16）', () => {
  it('分母 0 → 返 0（无 input_total_tokens）', () => {
    expect(computeCacheRate(emptyPartition())).toBe(0);
  });
  it('正常比率 = input_cache_read / input_total_tokens', () => {
    const p = accumulatePartition(emptyPartition(), {
      input_cache_read: 80,
      input_total_tokens: 200,
    } as Usage);
    expect(computeCacheRate(p)).toBeCloseTo(0.4, 6);
  });
  it('全部 cache hit → 1.0', () => {
    const p = accumulatePartition(emptyPartition(), {
      input_cache_read: 100,
      input_total_tokens: 100,
    } as Usage);
    expect(computeCacheRate(p)).toBe(1);
  });
  it('无 cache read → 0', () => {
    const p = accumulatePartition(emptyPartition(), {
      input_total_tokens: 100,
    } as Usage);
    expect(computeCacheRate(p)).toBe(0);
  });
  it('多次累加 → 按累计字段算比率', () => {
    let p = emptyPartition();
    p = accumulatePartition(p, {
      input_cache_read: 60,
      input_total_tokens: 100,
    } as Usage);
    p = accumulatePartition(p, {
      input_cache_read: 40,
      input_total_tokens: 200,
    } as Usage);
    // 累计 cache_read=100，input_total=300 → 1/3
    expect(computeCacheRate(p)).toBeCloseTo(100 / 300, 6);
  });
});

describe('deriveUsageView — cacheRate 4 派生字段（v0.0.16）', () => {
  it('空 meta → 4 cacheRate 均为 0', () => {
    const v = deriveUsageView(emptyMeta());
    expect(v.currentCacheRate).toBe(0);
    expect(v.subCacheRate).toBe(0);
    expect(v.forkedCacheRate).toBe(0);
    expect(v.totalCacheRate).toBe(0);
  });
  it('三分区各自 cacheRate + total 按 Σ 算', () => {
    let meta = emptyMeta();
    meta.current = accumulatePartition(meta.current, {
      input_cache_read: 80,
      input_total_tokens: 100,
    } as Usage);
    meta.sub = accumulatePartition(meta.sub, {
      input_cache_read: 0,
      input_total_tokens: 200,
    } as Usage);
    meta.forked = accumulatePartition(meta.forked, {
      input_cache_read: 50,
      input_total_tokens: 50,
    } as Usage);
    const v = deriveUsageView(meta);
    expect(v.currentCacheRate).toBeCloseTo(0.8, 6);
    expect(v.subCacheRate).toBe(0);
    expect(v.forkedCacheRate).toBe(1);
    // total Σ：cache_read=130, input_total=350 → 13/35
    expect(v.totalCacheRate).toBeCloseTo(130 / 350, 6);
  });
});

describe('normalizeMeta — 兼容历史 / 脏数据', () => {
  it('undefined → emptyMeta（ratio.current=1.0）', () => {
    const m = normalizeMeta(undefined);
    expect(m.ratio.current).toBe(1.0);
    expect(m.current.llmCallCount).toBe(0);
  });
  it('部分字段缺失 → 缺省回退', () => {
    const m = normalizeMeta({ current: { fields: { total_tokens: 100 } } });
    expect(m.current.fields.total_tokens).toBe(100);
    expect(m.current.llmCallCount).toBe(0); // 缺省
    expect(m.sub.llmCallCount).toBe(0);
    expect(m.ratio.current).toBe(1.0);
  });
});

// ============================================================
// [v0.0.16] normalizeContextWindowUsage — 旧 3 字段 record 兜底补全
// spec context_snapshot_interface.md §2「历史数据 normalize 兜底」
// ============================================================

describe('normalizeContextWindowUsage — 旧 3 字段 record 兜底（v0.0.16）', () => {
  it('undefined / null → 零占用（tokenLimit + maxOutputTokens 默认）', () => {
    const cw = normalizeContextWindowUsage(undefined);
    expect(cw.systemTokens).toBe(0);
    expect(cw.messageTokens).toBe(0);
    expect(cw.toolTokens).toBe(0);
    expect(cw.totalTokens).toBe(0);
    expect(cw.maxOutputTokens).toBe(20000);
    expect(cw.tokenLimit).toBe(200000);
    expect(cw.remainingTokens).toBe(200000 - 0 - 20000);
    // null 同
    expect(normalizeContextWindowUsage(null)).toEqual(cw);
  });

  it('旧 3 字段 record（tokenLimit/usedTokens/remainingTokens）→ usedTokens 全归 messageTokens，system/tool 置 0', () => {
    // 这是 v0.0.8-0.0.15 落盘形态：usedTokens 是合并值，无法精确拆分
    const cw = normalizeContextWindowUsage({
      tokenLimit: 100000,
      usedTokens: 5000,
      remainingTokens: 95000,
    });
    expect(cw.systemTokens).toBe(0);
    expect(cw.messageTokens).toBe(5000); // 旧 usedTokens 全归 message
    expect(cw.toolTokens).toBe(0);
    expect(cw.totalTokens).toBe(5000); // = 旧 usedTokens
    expect(cw.maxOutputTokens).toBe(20000); // 缺省
    expect(cw.tokenLimit).toBe(100000);
    // remainingTokens 用 record 原值（合法 number 时不重算，避免误覆盖落盘值）
    expect(cw.remainingTokens).toBe(95000);
  });

  it('旧 record 缺 remainingTokens → 按新公式重算（tokenLimit − total − maxOutput）', () => {
    const cw = normalizeContextWindowUsage({
      tokenLimit: 100000,
      usedTokens: 5000,
    });
    expect(cw.totalTokens).toBe(5000);
    expect(cw.maxOutputTokens).toBe(20000);
    expect(cw.remainingTokens).toBe(100000 - 5000 - 20000);
  });

  it('完整 7 字段 record → 透传不丢', () => {
    const full = {
      systemTokens: 100,
      messageTokens: 200,
      toolTokens: 50,
      totalTokens: 350,
      maxOutputTokens: 8000,
      tokenLimit: 60000,
      remainingTokens: 60000 - 350 - 8000,
    };
    expect(normalizeContextWindowUsage(full)).toEqual(full);
  });

  it('部分新字段缺失（仅有 systemTokens 等）→ 缺字段回退默认', () => {
    const cw = normalizeContextWindowUsage({
      systemTokens: 100,
      messageTokens: 200,
      // 缺 toolTokens / totalTokens / maxOutputTokens / tokenLimit
    });
    expect(cw.systemTokens).toBe(100);
    expect(cw.messageTokens).toBe(200);
    expect(cw.toolTokens).toBe(0);
    expect(cw.totalTokens).toBe(300); // = 三分项和
    expect(cw.maxOutputTokens).toBe(20000);
    expect(cw.tokenLimit).toBe(200000);
    expect(cw.remainingTokens).toBe(200000 - 300 - 20000);
  });

  it('脏数据（非对象 / 字段非数字）→ 全回退默认', () => {
    const cw = normalizeContextWindowUsage('bad' as unknown);
    expect(cw.totalTokens).toBe(0);
    expect(cw.maxOutputTokens).toBe(20000);
    expect(cw.tokenLimit).toBe(200000);

    const cw2 = normalizeContextWindowUsage({
      systemTokens: 'x',
      messageTokens: null,
      tokenLimit: true,
    });
    expect(cw2.systemTokens).toBe(0);
    expect(cw2.messageTokens).toBe(0);
    expect(cw2.tokenLimit).toBe(200000);
  });
});
