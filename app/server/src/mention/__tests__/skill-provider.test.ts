/**
 * SkillProvider 单测 —— mock SkillResolver 验证搜索逻辑 + MentionItem 结构
 * 参考: specs/tech/mention/provider-interface.md §6
 *
 * 用 mock resolve 函数替代真实 SkillResolver，验证：
 *   - 搜索结果结构正确（MentionItem 各字段）
 *   - query 过滤生效（包含匹配 + 大小写不敏感）
 *   - disabled skill 被排除
 *   - 空结果场景
 */
import { describe, it, expect, vi } from 'vitest';
import { SkillProvider } from '../providers/skill-provider';
import type { SkillProviderDeps } from '../providers/skill-provider';
import type { SkillCatalog, SkillEntry } from '../../skills/types';
import type { SearchCtx } from '../types';

/** 快捷构造 SkillEntry */
function makeEntry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: 'test-skill',
    description: 'Test skill description',
    scope: 'app',
    skillDir: '/skills/test-skill',
    enabled: true,
    ...overrides,
  };
}

/** 构造 mock SkillProviderDeps（resolve 函数 + dataDir + enabledStore） */
function makeDeps(catalog: SkillCatalog): SkillProviderDeps {
  return {
    resolve: vi.fn().mockReturnValue(catalog),
    dataDir: '/tmp/data',
    enabledStore: null,
  };
}

/** 构造最小 SearchCtx */
function makeCtx(query = ''): SearchCtx {
  return {
    query,
    limit: 20,
    bizType: 'playground',
    biz: 'playground',
    role: 'rocky',
    derivation: 'parent',
    sessionId: 'test-session',
    workspaceDir: '/tmp/ws',
  };
}

describe('SkillProvider', () => {
  it('provider 元信息: name=skill, label=Skills', () => {
    const provider = new SkillProvider(makeDeps({ entries: [] }));
    expect(provider.name).toBe('skill');
    expect(provider.label).toBe('Skills');
  });

  it('search 返回 enabled skill 的 MentionItem 列表', async () => {
    const catalog: SkillCatalog = {
      entries: [
        makeEntry({ name: 'drama-script-writer', description: 'Writes drama scripts', skillDir: '/skills/drama-script-writer' }),
        makeEntry({ name: 'code-reviewer', description: 'Reviews code quality' }),
      ],
    };
    const deps = makeDeps(catalog);
    const provider = new SkillProvider(deps);

    const result = await provider.search(makeCtx(''));
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.type).toBe('skill');
    expect(result.items[0]!.path).toBe('/skills/drama-script-writer');
    expect(result.items[0]!.listView.title).toBe('drama-script-writer');
    expect(result.items[0]!.listView.icon).toBe('skill');
  });

  it('query 过滤生效（name 包含匹配，大小写不敏感）', async () => {
    const catalog: SkillCatalog = {
      entries: [
        makeEntry({ name: 'drama-script-writer', skillDir: '/skills/drama-script-writer' }),
        makeEntry({ name: 'code-reviewer' }),
      ],
    };
    const provider = new SkillProvider(makeDeps(catalog));

    const result = await provider.search(makeCtx('drama'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.path).toBe('/skills/drama-script-writer');
  });

  it('大小写不敏感匹配', async () => {
    const catalog: SkillCatalog = {
      entries: [makeEntry({ name: 'drama-script-writer' })],
    };
    const provider = new SkillProvider(makeDeps(catalog));

    const result = await provider.search(makeCtx('DRAMA'));
    expect(result.items).toHaveLength(1);
  });

  it('disabled skill 被排除', async () => {
    const catalog: SkillCatalog = {
      entries: [
        makeEntry({ name: 'enabled-skill', enabled: true, skillDir: '/skills/enabled-skill' }),
        makeEntry({ name: 'disabled-skill', enabled: false }),
      ],
    };
    const provider = new SkillProvider(makeDeps(catalog));

    const result = await provider.search(makeCtx(''));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.path).toBe('/skills/enabled-skill');
  });

  it('空 catalog 返回空列表', async () => {
    const provider = new SkillProvider(makeDeps({ entries: [] }));
    const result = await provider.search(makeCtx('anything'));
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('description 截断超过 60 字符加 "...""', async () => {
    const longDesc = 'A'.repeat(100);
    const catalog: SkillCatalog = {
      entries: [makeEntry({ name: 'long-desc', description: longDesc })],
    };
    const provider = new SkillProvider(makeDeps(catalog));

    const result = await provider.search(makeCtx(''));
    expect(result.items[0]!.listView.subtitle).toBe(`${'A'.repeat(60)}...`);
  });

  it('短 description 不截断', async () => {
    const catalog: SkillCatalog = {
      entries: [makeEntry({ name: 'short-desc', description: 'Short' })],
    };
    const provider = new SkillProvider(makeDeps(catalog));

    const result = await provider.search(makeCtx(''));
    expect(result.items[0]!.listView.subtitle).toBe('Short');
  });

  it('path = skillDir 绝对路径', async () => {
    const catalog: SkillCatalog = {
      entries: [makeEntry({ name: 'my-skill', skillDir: '/skills/my-skill' })],
    };
    const provider = new SkillProvider(makeDeps(catalog));

    const result = await provider.search(makeCtx(''));
    expect(result.items[0]!.path).toBe('/skills/my-skill');
  });

  it('resolve 函数被正确调用（传 dataDir + workspaceDir + enabledStore）', async () => {
    const deps = makeDeps({ entries: [] });
    const provider = new SkillProvider(deps);

    await provider.search(makeCtx(''));
    expect(deps.resolve).toHaveBeenCalledWith(
      '/tmp/data',
      '/tmp/ws',
      null,
      undefined, // builtinDir 未设置
    );
  });
});
