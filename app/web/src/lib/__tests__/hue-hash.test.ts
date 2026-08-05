/**
 * hue-hash 单测 —— 稳定性 + 分布 + 边界
 * 参考: specs/tech/version_logs/v0.0.165/change_plan.md §4/§7（INV-5 单一 hash 单例）
 *       specs/ui/regulation/01-tokens.md §1.7（palette 顺序权威源）
 */
import { describe, it, expect } from 'vitest';
import { HUE_PALETTE, hashHueIndex, hashHueName } from '../hue-hash';

describe('HUE_PALETTE 常量', () => {
  it('长度 = 8，顺序与 regulation 01 §1.7 一致', () => {
    expect(HUE_PALETTE.length).toBe(8);
    expect([...HUE_PALETTE]).toEqual([
      'rose',
      'orange',
      'amber',
      'green',
      'teal',
      'blue',
      'violet',
      'pink',
    ]);
  });
});

describe('hashHueIndex', () => {
  it('返回值恒在 [0, 8) 区间内', () => {
    const ids = ['a', 'z', 'mem-1', 'squad-abc', 'skill:builtin/read_file', '中文', 'ulid-01H'];
    for (const id of ids) {
      const idx = hashHueIndex(id);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
      expect(Number.isInteger(idx)).toBe(true);
    }
  });

  it('稳定性：同 id 每次调用返同一 index（10 次）', () => {
    const ids = ['member-alice', 'squad-alpha', 'plugin:openai', '张三'];
    for (const id of ids) {
      const first = hashHueIndex(id);
      for (let i = 0; i < 10; i++) {
        expect(hashHueIndex(id)).toBe(first);
      }
    }
  });

  it('空串兜底 → 0（rose）', () => {
    expect(hashHueIndex('')).toBe(0);
  });

  it('不同 id 大多数不同（16 个 id 至少覆盖 5+ 桶，防退化）', () => {
    // 16 个业务风格 id（member ulid、squad name、skill 全名等）
    const ids = [
      'member-01HKAA', 'member-01HKBB', 'member-01HKCC', 'member-01HKDD',
      'squad-alpha', 'squad-beta', 'squad-gamma', 'squad-delta',
      'plugin:openai', 'plugin:anthropic', 'plugin:groq', 'plugin:mistral',
      'skill:read_file', 'skill:web_fetch', 'skill:cron', 'skill:memory',
    ];
    const buckets = new Set(ids.map(hashHueIndex));
    // 8 桶 hash 16 id，均匀分布约 8；退化到 <5 桶说明 hash 差
    expect(buckets.size).toBeGreaterThanOrEqual(5);
  });

  it('8 个精心构造 id 全 8 桶覆盖（分布完备性 sanity）', () => {
    // 用尾数一位递增找 8 桶全覆盖的样本（djb2 对末字节敏感），若未来 hash 换算法此测可需调 id 集合
    const seedIds: string[] = [];
    let n = 0;
    const seen = new Set<number>();
    while (seen.size < 8 && n < 1000) {
      const id = `id-${n}`;
      const idx = hashHueIndex(id);
      if (!seen.has(idx)) {
        seen.add(idx);
        seedIds.push(id);
      }
      n++;
    }
    expect(seen.size).toBe(8);
    // 每个桶 id 唯一映射
    for (const id of seedIds) {
      expect(hashHueIndex(id)).toBeGreaterThanOrEqual(0);
      expect(hashHueIndex(id)).toBeLessThan(8);
    }
  });

  it('中文 / emoji / 混合字符 id 也稳定', () => {
    const ids = ['张三', 'Alice小队', '🚀squad', 'a1@b'];
    for (const id of ids) {
      const first = hashHueIndex(id);
      expect(hashHueIndex(id)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(8);
    }
  });
});

describe('hashHueName', () => {
  it('返 palette 中的名字（8 桶之一）', () => {
    const ids = ['a', 'member-1', 'squad-alpha'];
    for (const id of ids) {
      const name = hashHueName(id);
      expect(HUE_PALETTE.includes(name)).toBe(true);
    }
  });

  it('与 hashHueIndex 对齐：hashHueName(id) === HUE_PALETTE[hashHueIndex(id)]', () => {
    const ids = ['x', 'y', 'z', 'member-1'];
    for (const id of ids) {
      expect(hashHueName(id)).toBe(HUE_PALETTE[hashHueIndex(id)]);
    }
  });

  it('空串 → rose（index 0）', () => {
    expect(hashHueName('')).toBe('rose');
  });
});
