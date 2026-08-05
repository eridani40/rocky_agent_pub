/**
 * U3/U4/U5 — skill 市场 tool action 单测（search 序列化 / install 落盘 / serialize 缺字段不造假）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §5/§6/§7；change_plan v0.0.166 模块 ④
 *
 * 覆盖：
 *   U3 executeMarketSearch：stub provider→序列化 markdown（ref/name/installs）；无 active→errorResult 不回退
 *   U4 executeMarketInstall：ref 合法→fetchSkillFiles(mock)→stageAndInstallFiles 落 app scope SkillEntry；
 *      ref 非法（非 owner/repo/slug）→INVALID_INPUT
 *   U5 serializeMarketResult：缺 description/stats 不造假、不报错
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  executeMarketSearch, executeMarketInstall, serializeMarketResult,
} from '../actions';
import type { ToolCtx } from '../../types';
import type {
  FetchedSkillFiles, SkillMarketProvider, SkillMarketSearchResult,
} from '../types';

/** 可编排 stub provider：search/fetchSkillFiles 行为由入参注入 */
function makeStubProvider(overrides: Partial<SkillMarketProvider> = {}): SkillMarketProvider {
  return {
    id: 'skills_sh',
    label: 'skills.sh',
    capabilities: { stats: ['installs'] },
    isAvailable: () => true,
    search: async (query): Promise<SkillMarketSearchResult> => ({
      provider: 'skills_sh', query, count: 1, tookMs: 5,
      items: [{ ref: 'github/awesome/git-commit', name: 'git-commit', stats: { installs: 42 } }],
    }),
    getDetail: async (ref) => ({ ref, name: ref }),
    fetchSkillFiles: async (): Promise<FetchedSkillFiles> => ({
      files: [{ path: 'SKILL.md', contents: '---\nname: git-commit\ndescription: commit helper\n---\nbody' }],
    }),
    ...overrides,
  };
}

/** ctx：注入 provider（或无 provider） */
function makeCtx(provider?: SkillMarketProvider): ToolCtx {
  return {
    config: {
      tools: [],
      pluginManager: { getExtensionImpls: () => (provider ? [provider] : []) },
      appConfig: { get: () => undefined },
    },
    workdir: '/tmp',
  } as unknown as ToolCtx;
}

describe('executeMarketSearch (U3)', () => {
  it('query 缺失 → INVALID_INPUT', async () => {
    const r = await executeMarketSearch({}, makeCtx(makeStubProvider()));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('query is required');
  });

  it('无 active provider → errorResult 不回退', async () => {
    const r = await executeMarketSearch({ query: 'git' }, makeCtx(undefined));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('no skill market provider');
  });

  it('provider 不可用 → errorResult', async () => {
    const r = await executeMarketSearch({ query: 'git' }, makeCtx(makeStubProvider({ isAvailable: () => false })));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('unavailable');
  });

  it('stub provider → 序列化 markdown（ref/name/installs）', async () => {
    const r = await executeMarketSearch({ query: 'git' }, makeCtx(makeStubProvider()));
    expect(r.isError).toBe(false);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('git-commit');
    expect(text).toContain('github/awesome/git-commit');
    expect(text).toContain('installs: 42');
  });

  it('provider.search 抛错 → errorResult', async () => {
    const p = makeStubProvider({ search: async () => { throw new Error('boom'); } });
    const r = await executeMarketSearch({ query: 'git' }, makeCtx(p));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('search failed');
  });
});

describe('executeMarketInstall (U4)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-market-install-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('ref 缺失 → INVALID_INPUT', async () => {
    const r = await executeMarketInstall({}, makeCtx(makeStubProvider()), dataDir, undefined);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('ref is required');
  });

  it('ref 非法（非 owner/repo/slug）→ INVALID_INPUT', async () => {
    const r = await executeMarketInstall({ ref: 'bad-ref' }, makeCtx(makeStubProvider()), dataDir, undefined);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('invalid skill ref');
  });

  it('无 active provider → errorResult', async () => {
    const r = await executeMarketInstall({ ref: 'github/awesome/git-commit' }, makeCtx(undefined), dataDir, undefined);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('no skill market provider');
  });

  it('ref 合法 → fetchSkillFiles→stageAndInstallFiles 落 app scope SkillEntry（evolvable=false/download）', async () => {
    const r = await executeMarketInstall(
      { ref: 'github/awesome/git-commit' }, makeCtx(makeStubProvider()), dataDir, undefined,
    );
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text) as {
      ok: boolean; ref: string; skill: { name: string; scope: string; evolvable?: boolean; productionMethod?: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.skill.name).toBe('git-commit');
    expect(payload.skill.scope).toBe('app'); // 市场安装落 app scope
    expect(payload.skill.evolvable).toBe(false); // 下载资产不给 agent 自改
    expect(payload.skill.productionMethod).toBe('download');
    // 真实落盘：<dataDir>/skills/git-commit/SKILL.md 存在且 frontmatter 已写治理字段
    const skillMd = join(dataDir, 'skills', 'git-commit', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);
    const raw = readFileSync(skillMd, 'utf8');
    expect(raw).toContain('evolvable: false');
    expect(raw).toContain('production_method: download');
  });

  it('provider.fetchSkillFiles 抛错 → errorResult', async () => {
    const p = makeStubProvider({ fetchSkillFiles: async () => { throw new Error('404'); } });
    const r = await executeMarketInstall({ ref: 'github/awesome/git-commit' }, makeCtx(p), dataDir, undefined);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('fetch skill files failed');
  });

  /** provider：fetchSkillFiles 返回可配置 hash（v0.0.167 来源元数据校验用） */
  function providerWithHash(hash: string): SkillMarketProvider {
    return makeStubProvider({
      fetchSkillFiles: async (): Promise<FetchedSkillFiles> => ({
        files: [{ path: 'SKILL.md', contents: '---\nname: git-commit\ndescription: commit helper\n---\nbody' }],
        hash,
      }),
    });
  }

  it('agent 路径写来源三元数据到 frontmatter（market_ref/market_source/installed_hash）', async () => {
    const r = await executeMarketInstall(
      { ref: 'github/awesome/git-commit' }, makeCtx(providerWithHash('agenthash')), dataDir, undefined,
    );
    expect(r.isError).toBe(false);
    const raw = readFileSync(join(dataDir, 'skills', 'git-commit', 'SKILL.md'), 'utf8');
    expect(raw).toContain('market_ref: github/awesome/git-commit');
    expect(raw).toContain('market_source: skills_sh');
    expect(raw).toContain('installed_hash: agenthash');
  });

  it('agent 路径不开 overwrite：同名重装（即便同源）→ errorResult 冲突（不静默覆盖）', async () => {
    const ok = await executeMarketInstall(
      { ref: 'github/awesome/git-commit' }, makeCtx(providerWithHash('h1')), dataDir, undefined,
    );
    expect(ok.isError).toBe(false);
    // 二次安装同 ref（agent 路径不透传 overwrite=true）→ finalizeStagedSkill 冲突守卫仍 409
    const dup = await executeMarketInstall(
      { ref: 'github/awesome/git-commit' }, makeCtx(providerWithHash('h2')), dataDir, undefined,
    );
    expect(dup.isError).toBe(true);
    expect((dup.content[0] as { text: string }).text).toContain('install skill failed');
  });
});

describe('serializeMarketResult (U5)', () => {
  it('空结果 → 无结果占位', () => {
    const md = serializeMarketResult({ provider: 'skills_sh', query: 'x', count: 0, tookMs: 1, items: [] });
    expect(md).toContain('（无结果）');
  });

  it('缺 description/stats → 不造假、不报错（只渲染 ref/name）', () => {
    const md = serializeMarketResult({
      provider: 'skills_sh', query: 'x', count: 1, tookMs: 1,
      items: [{ ref: 'a/b/c', name: 'skill-a' }],
    });
    expect(md).toContain('skill-a');
    expect(md).toContain('a/b/c');
    expect(md).not.toContain('installs:');
  });

  it('有 description/installs → 渲染', () => {
    const md = serializeMarketResult({
      provider: 'skills_sh', query: 'x', count: 1, tookMs: 1,
      items: [{ ref: 'a/b/c', name: 'skill-a', description: 'does things', stats: { installs: 7 } }],
    });
    expect(md).toContain('does things');
    expect(md).toContain('installs: 7');
  });
});
