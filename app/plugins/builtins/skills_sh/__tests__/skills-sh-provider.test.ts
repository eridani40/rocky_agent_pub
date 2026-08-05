/**
 * SkillsShProvider（skills.sh 市场源 impl）单测（白盒）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §8
 *       specs/tech/version_logs/v0.0.166.skill_market/change_plan.md 模块 ⑧（U8/U9/U10）
 *
 * 覆盖：
 *   U8 search / mapSkillsShItems：mock /api/search → 映射 SkillMarketItem
 *      （id→ref、name→name、installs→stats.installs、description undefined）；owner/limit 处理；tookMs
 *   U9 fetchSkillFiles / getDetail：mock /api/download → 透传 {files,hash}；
 *      getDetail 从 SKILL.md frontmatter 取 name/description、正文作 readme
 *   U10 capabilities/isAvailable：capabilities 只含 stats:['installs']；isAvailable 恒 true 且不触发 fetch（禁 I/O）
 *   + parseRef 形状校验/防注入
 *
 * mock proxyFetch（vi.hoisted 内 require('path') 派生绝对路径，
 * 避免 Bun+jsdom 并发下相对路径 mock 静默失效；memory: test-vitest-mock-absolute-path）。
 * 不打真实 skills.sh 网络。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { PROXY_ABS } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  return {
    PROXY_ABS: path.resolve(__dirname, '../../../../server/src/tools/web-fetch/proxy'),
  };
});

vi.mock(PROXY_ABS, () => ({
  proxyFetch: vi.fn(),
}));

import { proxyFetch as mockProxyFetch } from '../../../../server/src/tools/web-fetch/proxy';
import SkillsShProvider, {
  mapSkillsShItems,
  parseRef,
  parseSkillFrontmatter,
} from '../skills-sh-provider';

const mockFetch = mockProxyFetch as unknown as ReturnType<typeof vi.fn>;

/** 真实形状的 /api/search 响应 fixture */
function searchFixture() {
  return {
    query: 'git',
    searchType: 'keyword',
    skills: [
      { id: 'github/awesome-copilot/git-commit', skillId: 'git-commit', name: 'Git Commit', installs: 1234, source: 'github/awesome-copilot' },
      { id: 'github/foo/bar', skillId: 'bar', name: 'Bar', installs: 7, source: 'github/foo' },
    ],
    count: 2,
    duration_ms: 42,
  };
}

/** 真实形状的 /api/download 响应 fixture */
function downloadFixture() {
  return {
    files: [
      { path: 'SKILL.md', contents: '---\nname: Git Commit\ndescription: "生成规范的 git commit message"\n---\n# Git Commit\n\n正文说明。' },
      { path: 'scripts/run.sh', contents: '#!/bin/bash\necho hi' },
    ],
    hash: 'abc123',
  };
}

describe('U10 capabilities / isAvailable（无 I/O）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('capabilities 只含 stats:[installs]，不声明 categories/collections/sorts', () => {
    const p = new SkillsShProvider('skills_sh');
    expect(p.capabilities).toEqual({ stats: ['installs'] });
    expect(p.capabilities.categories).toBeUndefined();
    expect(p.capabilities.collections).toBeUndefined();
    expect(p.capabilities.sorts).toBeUndefined();
  });

  it('isAvailable 恒 true（无 token 也可用）且不触发 fetch', () => {
    const p = new SkillsShProvider('skills_sh');
    expect(p.isAvailable()).toBe(true);
    expect(p.isAvailable({})).toBe(true);
    expect(p.isAvailable({ token: 'anything' })).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('id = implId；label = skills.sh', () => {
    const p = new SkillsShProvider('skills_sh');
    expect(p.id).toBe('skills_sh');
    expect(p.label).toBe('skills.sh');
  });
});

describe('U8 mapSkillsShItems: 映射规则', () => {
  it('id→ref、name→name、installs→stats.installs、description undefined', () => {
    const items = mapSkillsShItems(searchFixture().skills);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      ref: 'github/awesome-copilot/git-commit',
      name: 'Git Commit',
      stats: { installs: 1234 },
    });
    expect(items[0].description).toBeUndefined();
    expect(items[1].stats).toEqual({ installs: 7 });
  });

  it('缺 id（ref）→ 跳过；缺 name → 回退 ref；installs 非数字 → 不填 stats', () => {
    const items = mapSkillsShItems([
      { skillId: 'x', name: 'NoId', installs: 1 }, // 无 id → 跳过
      { id: 'a/b/c', installs: 'oops' }, // 无 name → 回退 ref；installs 非数字 → 无 stats
    ] as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ ref: 'a/b/c', name: 'a/b/c' });
    expect(items[0].stats).toBeUndefined();
  });

  it('空数组 → 空数组', () => {
    expect(mapSkillsShItems([])).toEqual([]);
  });
});

describe('U8 search: GET /api/search + 映射 SkillMarketSearchResult', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('调 /api/search?q= → items 映射 + provider/query/count/tookMs', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => searchFixture() });
    const p = new SkillsShProvider('skills_sh');
    const res = await p.search('git', {}, {});

    expect(res.provider).toBe('skills_sh');
    expect(res.query).toBe('git');
    expect(res.count).toBe(2);
    expect(res.tookMs).toBe(42); // duration_ms
    expect(res.items[0].ref).toBe('github/awesome-copilot/git-commit');
    expect(res.nextCursor).toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://skills.sh/api/search?q=git');
    expect((call[1] as { method: string }).method).toBe('GET');
  });

  it('opts.owner → &owner= 追加到 URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => searchFixture() });
    const p = new SkillsShProvider('skills_sh');
    await p.search('git', { owner: 'awesome-copilot' }, {});
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://skills.sh/api/search?q=git&owner=awesome-copilot',
    );
  });

  it('opts.limit → 客户端截断 items', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => searchFixture() });
    const p = new SkillsShProvider('skills_sh');
    const res = await p.search('git', { limit: 1 }, {});
    expect(res.items).toHaveLength(1);
    expect(res.count).toBe(1);
  });

  it('cfg.token 非空 → Authorization: Bearer 头（可选增强）', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => searchFixture() });
    const p = new SkillsShProvider('skills_sh');
    await p.search('git', {}, { token: 'tkn' });
    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer tkn');
  });

  it('无 token → 无 Authorization 头', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => searchFixture() });
    const p = new SkillsShProvider('skills_sh');
    await p.search('git', {}, {});
    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('HTTP 非 2xx → 抛错含 status', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const p = new SkillsShProvider('skills_sh');
    await expect(p.search('git', {}, {})).rejects.toThrow(/500/);
  });
});

describe('U9 fetchSkillFiles: GET /api/download + 透传 files/hash', () => {
  beforeEach(() => vi.clearAllMocks());

  it('拆 ref → /api/download/{owner}/{repo}/{slug} → FetchedSkillFiles', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => downloadFixture() });
    const p = new SkillsShProvider('skills_sh');
    const out = await p.fetchSkillFiles('github/awesome-copilot/git-commit', {});

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://skills.sh/api/download/github/awesome-copilot/git-commit',
    );
    expect(out.hash).toBe('abc123');
    expect(out.files).toHaveLength(2);
    expect(out.files[0]).toEqual({
      path: 'SKILL.md',
      contents: downloadFixture().files[0].contents,
    });
  });

  it('files 缺省 → 空数组；hash 非 string → undefined', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    const p = new SkillsShProvider('skills_sh');
    const out = await p.fetchSkillFiles('a/b/c', {});
    expect(out.files).toEqual([]);
    expect(out.hash).toBeUndefined();
  });

  it('非法 ref（段数不对/含遍历字符）→ 抛错，不发 fetch', async () => {
    const p = new SkillsShProvider('skills_sh');
    await expect(p.fetchSkillFiles('only/two', {})).rejects.toThrow(/无效 skill ref/);
    await expect(p.fetchSkillFiles('a/../b/c', {})).rejects.toThrow(/无效 skill ref/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('U9 getDetail: 复用 fetchSkillFiles + SKILL.md frontmatter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('从 SKILL.md frontmatter 取 name/description，正文作 readme', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => downloadFixture() });
    const p = new SkillsShProvider('skills_sh');
    const detail = await p.getDetail('github/awesome-copilot/git-commit', {});

    expect(detail.ref).toBe('github/awesome-copilot/git-commit');
    expect(detail.name).toBe('Git Commit');
    expect(detail.description).toBe('生成规范的 git commit message');
    expect(detail.readme).toContain('# Git Commit');
    expect(detail.repository).toEqual({
      url: 'https://skills.sh/github/awesome-copilot/git-commit',
    });
  });

  it('无 SKILL.md → name 回退 slug、description undefined', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ path: 'README.txt', contents: 'x' }] }),
    });
    const p = new SkillsShProvider('skills_sh');
    const detail = await p.getDetail('github/foo/my-slug', {});
    expect(detail.name).toBe('my-slug');
    expect(detail.description).toBeUndefined();
  });
});

describe('U4 getDetail: hash + files 复用已 fetch 结果（v0.0.167，零额外请求）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detail.hash / detail.files 来自 download 响应，且只发一次 fetch（无额外请求）', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => downloadFixture() });
    const p = new SkillsShProvider('skills_sh');
    const detail = await p.getDetail('github/awesome-copilot/git-commit', {});

    // hash 直接透传 download.hash（可更新惰性比对锚点）
    expect(detail.hash).toBe('abc123');
    // files 仅路径（不含 contents，省 payload）
    expect(detail.files).toEqual([{ path: 'SKILL.md' }, { path: 'scripts/run.sh' }]);
    // getDetail 内部只调一次 /api/download（复用 fetchSkillFiles，无第二次请求）
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('download 无 hash → detail.hash undefined（能力门控），files 仍在', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ path: 'SKILL.md', contents: '---\nname: X\n---\nb' }] }),
    });
    const p = new SkillsShProvider('skills_sh');
    const detail = await p.getDetail('a/b/c', {});
    expect(detail.hash).toBeUndefined();
    expect(detail.files).toEqual([{ path: 'SKILL.md' }]);
  });
});

describe('parseRef / parseSkillFrontmatter 单元', () => {
  it('parseRef 合法 3 段 → owner/repo/slug', () => {
    expect(parseRef('github/awesome-copilot/git-commit')).toEqual({
      owner: 'github',
      repo: 'awesome-copilot',
      slug: 'git-commit',
    });
  });

  it('parseRef 非法（段数/字符）→ 抛错', () => {
    expect(() => parseRef('a/b')).toThrow(/无效 skill ref/);
    expect(() => parseRef('a/b/c/d')).toThrow(/无效 skill ref/);
    expect(() => parseRef('a/b/..')).toThrow(/无效 skill ref/);
    expect(() => parseRef('a//c')).toThrow(/无效 skill ref/);
  });

  it('parseSkillFrontmatter 提取 name/description + body', () => {
    const md = '---\nname: X\ndescription: hello\n---\nBODY';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'X', description: 'hello', body: 'BODY' });
  });

  it('parseSkillFrontmatter 无 frontmatter → body=原文', () => {
    expect(parseSkillFrontmatter('no fm here')).toEqual({ body: 'no fm here' });
  });
});
