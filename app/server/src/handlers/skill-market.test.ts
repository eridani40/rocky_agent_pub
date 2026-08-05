/**
 * U11 — /skills/market/* HTTP handler 单测（capabilities/search/detail 200 形状 + install 202 + 503 + 400）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §9；change_plan v0.0.166 模块 ⑥
 *
 * 覆盖：
 *   - capabilities GET → 200 { id, label, capabilities }
 *   - search GET ?q= → 200 SkillMarketSearchResult；缺 q → 400
 *   - detail GET ?ref= → 200 SkillMarketDetail；缺 ref → 400
 *   - install POST {ref} 合法 → 202 SkillEntry（真实落盘 app scope）；ref 非法 → 400；缺 ref → 400
 *   - 无 active provider（任意端点）→ 503
 * mock provider + pluginManager + appConfig（不打真网、不读真配置）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { handleSkillMarketRoute } from './skill-market';
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import type {
  FetchedSkillFiles,
  SkillMarketDetail,
  SkillMarketProvider,
  SkillMarketSearchResult,
} from '../tools/skill-market/types';

/** 可编排 stub provider */
function makeStubProvider(overrides: Partial<SkillMarketProvider> = {}): SkillMarketProvider {
  return {
    id: 'skills_sh',
    label: 'skills.sh',
    capabilities: { stats: ['installs'] },
    isAvailable: () => true,
    search: async (query): Promise<SkillMarketSearchResult> => ({
      provider: 'skills_sh',
      query,
      count: 1,
      tookMs: 5,
      items: [{ ref: 'github/awesome/git-commit', name: 'git-commit', stats: { installs: 42 } }],
    }),
    getDetail: async (ref): Promise<SkillMarketDetail> => ({ ref, name: 'git-commit', readme: 'body' }),
    fetchSkillFiles: async (): Promise<FetchedSkillFiles> => ({
      files: [{ path: 'SKILL.md', contents: '---\nname: git-commit\ndescription: commit helper\n---\nbody' }],
    }),
    ...overrides,
  };
}

/** mock pluginManager：注入 provider（或无 active impl） */
function makePluginManager(provider?: SkillMarketProvider): PluginManager {
  return { getExtensionImpls: () => (provider ? [provider] : []) } as unknown as PluginManager;
}

/** mock appConfig：无凭证配置 */
const appConfig = { get: () => undefined } as unknown as AppConfigService;

function urlOf(path: string, qs = ''): URL {
  return new URL(`http://localhost${path}${qs}`);
}

describe('handleSkillMarketRoute — capabilities', () => {
  it('GET /skills/market/capabilities → 200 { id, label, capabilities }', async () => {
    const res = await handleSkillMarketRoute(
      new Request('http://localhost/skills/market/capabilities'),
      'GET', '/skills/market/capabilities', urlOf('/skills/market/capabilities'),
      appConfig, makePluginManager(makeStubProvider()), '/tmp',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; label: string; capabilities: { stats?: string[] } };
    expect(body.id).toBe('skills_sh');
    expect(body.label).toBe('skills.sh');
    expect(body.capabilities.stats).toEqual(['installs']);
  });

  it('无 active provider → 503', async () => {
    const res = await handleSkillMarketRoute(
      new Request('http://localhost/skills/market/capabilities'),
      'GET', '/skills/market/capabilities', urlOf('/skills/market/capabilities'),
      appConfig, makePluginManager(undefined), '/tmp',
    );
    expect(res.status).toBe(503);
  });
});

describe('handleSkillMarketRoute — search', () => {
  it('GET ?q= → 200 SkillMarketSearchResult', async () => {
    const res = await handleSkillMarketRoute(
      new Request('http://localhost/skills/market/search?q=git'),
      'GET', '/skills/market/search', urlOf('/skills/market/search', '?q=git&owner=awesome&limit=5'),
      appConfig, makePluginManager(makeStubProvider()), '/tmp',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SkillMarketSearchResult;
    expect(body.provider).toBe('skills_sh');
    expect(body.count).toBe(1);
    expect(body.items[0]!.ref).toBe('github/awesome/git-commit');
  });

  it('缺 q → 400', async () => {
    const res = await handleSkillMarketRoute(
      new Request('http://localhost/skills/market/search'),
      'GET', '/skills/market/search', urlOf('/skills/market/search'),
      appConfig, makePluginManager(makeStubProvider()), '/tmp',
    );
    expect(res.status).toBe(400);
  });
});

describe('handleSkillMarketRoute — detail', () => {
  it('GET ?ref= → 200 SkillMarketDetail', async () => {
    const res = await handleSkillMarketRoute(
      new Request('http://localhost/skills/market/detail'),
      'GET', '/skills/market/detail', urlOf('/skills/market/detail', '?ref=github/awesome/git-commit'),
      appConfig, makePluginManager(makeStubProvider()), '/tmp',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SkillMarketDetail;
    expect(body.ref).toBe('github/awesome/git-commit');
    expect(body.readme).toBe('body');
  });

  it('缺 ref → 400', async () => {
    const res = await handleSkillMarketRoute(
      new Request('http://localhost/skills/market/detail'),
      'GET', '/skills/market/detail', urlOf('/skills/market/detail'),
      appConfig, makePluginManager(makeStubProvider()), '/tmp',
    );
    expect(res.status).toBe(400);
  });
});

describe('handleSkillMarketRoute — install', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-market-http-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  function postReq(body: unknown): Request {
    return new Request('http://localhost/skills/market/install', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('合法 ref → 202 SkillEntry（真实落盘 app scope，evolvable=false/download）', async () => {
    const res = await handleSkillMarketRoute(
      postReq({ ref: 'github/awesome/git-commit' }),
      'POST', '/skills/market/install', urlOf('/skills/market/install'),
      appConfig, makePluginManager(makeStubProvider()), dataDir,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      skill: { name: string; scope: string; evolvable?: boolean; productionMethod?: string };
    };
    expect(body.skill.name).toBe('git-commit');
    expect(body.skill.scope).toBe('app');
    expect(body.skill.evolvable).toBe(false);
    expect(body.skill.productionMethod).toBe('download');
    expect(existsSync(join(dataDir, 'skills', 'git-commit', 'SKILL.md'))).toBe(true);
  });

  it('ref 非法（非 owner/repo/slug）→ 400', async () => {
    const res = await handleSkillMarketRoute(
      postReq({ ref: 'bad-ref' }),
      'POST', '/skills/market/install', urlOf('/skills/market/install'),
      appConfig, makePluginManager(makeStubProvider()), dataDir,
    );
    expect(res.status).toBe(400);
  });

  it('缺 ref → 400', async () => {
    const res = await handleSkillMarketRoute(
      postReq({}),
      'POST', '/skills/market/install', urlOf('/skills/market/install'),
      appConfig, makePluginManager(makeStubProvider()), dataDir,
    );
    expect(res.status).toBe(400);
  });

  it('无 active provider → 503', async () => {
    const res = await handleSkillMarketRoute(
      postReq({ ref: 'github/awesome/git-commit' }),
      'POST', '/skills/market/install', urlOf('/skills/market/install'),
      appConfig, makePluginManager(undefined), dataDir,
    );
    expect(res.status).toBe(503);
  });
});

describe('handleSkillMarketRoute — install 来源元数据 + overwrite (U5, v0.0.167)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-market-meta-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  function postReq(body: unknown): Request {
    return new Request('http://localhost/skills/market/install', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  /** provider：fetchSkillFiles 返回可配置 hash（覆盖默认 stub 的无 hash） */
  function providerWithHash(hash: string): SkillMarketProvider {
    return makeStubProvider({
      fetchSkillFiles: async (): Promise<FetchedSkillFiles> => ({
        files: [{ path: 'SKILL.md', contents: '---\nname: git-commit\ndescription: commit helper\n---\nbody' }],
        hash,
      }),
    });
  }

  async function install(provider: SkillMarketProvider, body: unknown): Promise<Response> {
    return handleSkillMarketRoute(
      postReq(body), 'POST', '/skills/market/install', urlOf('/skills/market/install'),
      appConfig, makePluginManager(provider), dataDir,
    );
  }

  const ref = 'github/awesome/git-commit';
  const skillMd = () => join(dataDir, 'skills', 'git-commit', 'SKILL.md');

  it('全新安装 → 202 且 frontmatter 写入 market_ref/market_source/installed_hash', async () => {
    const res = await install(providerWithHash('h1'), { ref });
    expect(res.status).toBe(202);
    const raw = readFileSync(skillMd(), 'utf8');
    expect(raw).toContain(`market_ref: ${ref}`);
    expect(raw).toContain('market_source: skills_sh');
    expect(raw).toContain('installed_hash: h1');
  });

  it('同名重装不带 overwrite → 409 conflict（保持现有语义）', async () => {
    expect((await install(providerWithHash('h1'), { ref })).status).toBe(202);
    const res = await install(providerWithHash('h2'), { ref });
    expect(res.status).toBe(409);
  });

  it('同源 overwrite=true → 202 且 installed_hash 刷新', async () => {
    expect((await install(providerWithHash('h1'), { ref })).status).toBe(202);
    const res = await install(providerWithHash('h2'), { ref, overwrite: true });
    expect(res.status).toBe(202);
    const raw = readFileSync(skillMd(), 'utf8');
    expect(raw).toContain('installed_hash: h2'); // 覆盖后刷新为新 hash
    expect(raw).toContain(`market_ref: ${ref}`);
  });
});
