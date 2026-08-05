/**
 * U2 — resolveSkillMarketProvider 单测（exclusive EP resolve + cfg 按 id 取凭证）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §5；change_plan v0.0.166 模块 ⑥
 *
 * 覆盖：无 active impl→undefined；有 active→取 getExtensionImpls[0]；
 *   cfg 按 provider.id 从 app_config.skill_market.credentials 取；无凭证→{}。
 */
import { describe, it, expect } from 'vitest';
import { resolveSkillMarketProvider } from '../resolve';
import type { ToolCtx } from '../../types';
import type { SkillMarketProvider } from '../types';

/** 造一个最小 provider stub（只需 id/label 供 resolve 用） */
function stubProvider(id: string): SkillMarketProvider {
  return {
    id,
    label: id,
    capabilities: { stats: ['installs'] },
    isAvailable: () => true,
    search: async () => ({ provider: id, query: '', count: 0, tookMs: 0, items: [] }),
    getDetail: async (ref) => ({ ref, name: ref }),
    fetchSkillFiles: async () => ({ files: [] }),
  };
}

/** 造 ctx：pluginManager.getExtensionImpls 返 impls；appConfig.get 返 configData */
function makeCtx(impls: SkillMarketProvider[], configData?: unknown): ToolCtx {
  return {
    config: {
      tools: [],
      pluginManager: { getExtensionImpls: () => impls },
      appConfig: { get: () => configData },
    },
    workdir: '/tmp',
  } as unknown as ToolCtx;
}

describe('resolveSkillMarketProvider', () => {
  it('无 active impl → provider undefined，cfg={}', () => {
    const r = resolveSkillMarketProvider(makeCtx([]));
    expect(r.provider).toBeUndefined();
    expect(r.cfg).toEqual({});
  });

  it('无 pluginManager → provider undefined，cfg={}', () => {
    const ctx = { config: { tools: [] }, workdir: '/tmp' } as unknown as ToolCtx;
    const r = resolveSkillMarketProvider(ctx);
    expect(r.provider).toBeUndefined();
    expect(r.cfg).toEqual({});
  });

  it('有 active → 取 getExtensionImpls[0]（exclusive）', () => {
    const p = stubProvider('skills_sh');
    const r = resolveSkillMarketProvider(makeCtx([p]));
    expect(r.provider).toBe(p);
  });

  it('多 impl（异常态）→ 仍只取第一个', () => {
    const first = stubProvider('skills_sh');
    const second = stubProvider('other');
    const r = resolveSkillMarketProvider(makeCtx([first, second]));
    expect(r.provider).toBe(first);
  });

  it('cfg 按 provider.id 从 skill_market.credentials 取', () => {
    const p = stubProvider('skills_sh');
    const r = resolveSkillMarketProvider(makeCtx([p], {
      credentials: { skills_sh: { token: 'abc' }, other: { token: 'zzz' } },
    }));
    expect(r.cfg).toEqual({ token: 'abc' });
  });

  it('无该 id 凭证 / 无 credentials → cfg={}', () => {
    const p = stubProvider('skills_sh');
    expect(resolveSkillMarketProvider(makeCtx([p], { credentials: {} })).cfg).toEqual({});
    expect(resolveSkillMarketProvider(makeCtx([p], {})).cfg).toEqual({});
    expect(resolveSkillMarketProvider(makeCtx([p], undefined)).cfg).toEqual({});
  });
});
