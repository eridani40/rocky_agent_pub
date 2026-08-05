/**
 * Retry Backoff UT（getRetryDelay + counter seed jitter + 默认值）
 * 参考: test-plan §3 retry_and_timeout 行 + spec §1
 *
 * 校验点：
 *   - retry-after 优先且双层 cap（min(retryAfter, backoff_cap_s)）
 *   - 指数退避：min(base * 2^(attempt-1), cap)
 *   - 半 jitter：含 counter seed 非纯 random（exp + floor(seed*0.25*base)）
 *   - jitter=false 时无抖动（纯指数）
 *   - counter seed 递增（多次调用不撞，§1.2）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRetryDelay,
  getCounterSeedJitter,
  __resetRetryCounterForTest,
  DEFAULT_RETRY_CONFIG,
} from '../retry_backoff';

const CFG = { max_attempts: 3, backoff_base_s: 2, backoff_cap_s: 30, jitter: false };

describe('getRetryDelay', () => {
  beforeEach(() => {
    __resetRetryCounterForTest();
  });

  describe('retry-after 优先（§5.2）', () => {
    it('有 retryAfter 时优先用，等于 retryAfter*1000', () => {
      expect(getRetryDelay(1, 5, CFG)).toBe(5000);
    });

    it('retryAfter 被 backoff_cap_s cap（双层 cap，防病态 6h）', () => {
      expect(getRetryDelay(1, 3600, CFG)).toBe(30000); // cap=30s
    });

    it('retryAfter 小于 cap 时不受影响', () => {
      expect(getRetryDelay(2, 10, CFG)).toBe(10000);
    });
  });

  describe('指数退避（§1.1 公式 2）', () => {
    it('attempt=1 无 jitter：base*2^0 = base', () => {
      expect(getRetryDelay(1, undefined, CFG)).toBe(2000);
    });

    it('attempt=2 无 jitter：base*2^1 = 2*base', () => {
      expect(getRetryDelay(2, undefined, CFG)).toBe(4000);
    });

    it('attempt=3 无 jitter：base*2^2 = 4*base', () => {
      expect(getRetryDelay(3, undefined, CFG)).toBe(8000);
    });

    it('attempt=5 被 cap 限制：base*2^4=32s > cap 30s → 30s', () => {
      expect(getRetryDelay(5, undefined, CFG)).toBe(30000);
    });
  });

  describe('半 jitter（§1.1 公式 3 + §5.1）', () => {
    const JITTER_CFG = { ...CFG, jitter: true };

    it('jitter=true 时延迟 >= 指数下限（保下限，非全 jitter）', () => {
      // exp=2000 + jitter ∈ [0, 0.25*2000=500)
      const delay = getRetryDelay(1, undefined, JITTER_CFG);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThan(2500);
    });

    it('jitter=true 时延迟 < exp + 0.25*base（散列上界）', () => {
      const delay = getRetryDelay(2, undefined, JITTER_CFG);
      // exp=4000, 0.25*base=500
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThan(4500);
    });

    it('jitter=true 且 exp 被 cap：delay 仍 = cap + jitter（cap 不被 jitter 进一步推高，因 jitter 仍加在 exp=cap 上）', () => {
      // attempt=5: exp=min(32s, 30s cap)=30s; delay=30s + jitter
      const delay = getRetryDelay(5, undefined, JITTER_CFG);
      expect(delay).toBeGreaterThanOrEqual(30000);
      expect(delay).toBeLessThan(30500);
    });
  });

  describe('counter seed jitter（§1.2）', () => {
    it('getCounterSeedJitter 返回 [0,1) 区间', () => {
      const seed = getCounterSeedJitter();
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(1);
    });

    it('counter seed 非纯 random：连续调用不全部相同（散列）', () => {
      // 多次取值应有变化（counter + Date.now + random 三路混合）
      const seeds = Array.from({ length: 10 }, () => getCounterSeedJitter());
      const unique = new Set(seeds);
      expect(unique.size).toBeGreaterThan(1);
    });

    it('counter seed 含 counter 递增：重置后从 0 开始循环 % 1000', () => {
      __resetRetryCounterForTest();
      // 调 1001 次，counter 应循环（不爆栈、不 NaN）
      for (let i = 0; i < 1001; i++) {
        const seed = getCounterSeedJitter();
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(1);
      }
    });
  });

  describe('默认值（§1.3）', () => {
    it('DEFAULT_RETRY_CONFIG 锁定 reqs.md §6 值', () => {
      expect(DEFAULT_RETRY_CONFIG.max_attempts).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.backoff_base_s).toBe(2);
      expect(DEFAULT_RETRY_CONFIG.backoff_cap_s).toBe(30);
      expect(DEFAULT_RETRY_CONFIG.jitter).toBe(true);
    });

    it('默认配置下 attempt=1 失败 → delay=2s + jitter（§1.3 示例）', () => {
      const delay = getRetryDelay(1, undefined, DEFAULT_RETRY_CONFIG);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThan(2500);
    });

    it('默认配置下 attempt=2 失败 → delay=4s + jitter（§1.3 示例）', () => {
      const delay = getRetryDelay(2, undefined, DEFAULT_RETRY_CONFIG);
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThan(4500);
    });
  });
});
