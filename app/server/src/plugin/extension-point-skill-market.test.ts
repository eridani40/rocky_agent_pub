/**
 * skill_market_provider 扩展点注册 UT（U1，白盒）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §4
 *
 * 覆盖：
 *   - BUILTIN_EXTENSION_POINTS 含 id==='skill_market_provider' 的 EP
 *   - 该 EP cardinality==='exclusive'（抄 SessionStorePoint，非 web_search 的 list）
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_EXTENSION_POINTS,
  SkillMarketProviderPoint,
} from './extension-point';

describe('skill_market_provider 扩展点注册', () => {
  it('已注册进 BUILTIN_EXTENSION_POINTS', () => {
    const ep = BUILTIN_EXTENSION_POINTS.find((p) => p.id === 'skill_market_provider');
    expect(ep).toBeDefined();
    expect(ep).toBe(SkillMarketProviderPoint);
  });

  it('cardinality 必须为 exclusive（整源替换，≤1 active）', () => {
    const ep = BUILTIN_EXTENSION_POINTS.find((p) => p.id === 'skill_market_provider');
    expect(ep?.cardinality).toBe('exclusive');
  });

  it('SkillMarketProviderPoint 常量字段完整', () => {
    expect(SkillMarketProviderPoint.id).toBe('skill_market_provider');
    expect(SkillMarketProviderPoint.cardinality).toBe('exclusive');
    expect(SkillMarketProviderPoint.description).toBe(
      '__MSG_extpoint.skill_market_provider.description__',
    );
  });
});
