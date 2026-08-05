/**
 * MentionProviderRegistry 单测 —— register/get/search/listProviders/重复 id 抛错
 * 参考: specs/tech/mention/provider-interface.md §4
 */
import { describe, it, expect, vi } from 'vitest';
import { MentionProviderRegistry } from '../registry';
import type { MentionProvider, SearchCtx, SearchResult } from '../types';

/** 构造 mock provider（name 可指定） */
function createMockProvider(name: string, items: SearchResult['items'] = []): MentionProvider {
  return {
    name,
    label: `Mock ${name}`,
    search: vi.fn().mockResolvedValue({ items } as SearchResult),
  };
}

/** 构造最小 SearchCtx（测试用） */
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

describe('MentionProviderRegistry', () => {
  it('register + get: 注册后可按 name 取出 provider', () => {
    const registry = new MentionProviderRegistry();
    const provider = createMockProvider('test');
    registry.register(provider);
    expect(registry.get('test')).toBe(provider);
  });

  it('get 未注册 name 返回 undefined', () => {
    const registry = new MentionProviderRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('重复 name 注册抛错', () => {
    const registry = new MentionProviderRegistry();
    registry.register(createMockProvider('dup'));
    expect(() => registry.register(createMockProvider('dup'))).toThrow(/dup/);
  });

  it('listProviders 返回所有已注册 provider 的 name + label', () => {
    const registry = new MentionProviderRegistry();
    registry.register(createMockProvider('file'));
    registry.register(createMockProvider('skill'));
    const list = registry.listProviders();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.name).sort()).toEqual(['file', 'skill']);
    expect(list[0]!.label).toBeTruthy();
  });

  it('search 路由到对应 provider 并返回结果', async () => {
    const registry = new MentionProviderRegistry();
    const items = [{ type: 'file', path: 'a.md', display: { icon: 'file', label: 'a.md' }, listView: { title: 'a.md' } }];
    const provider = createMockProvider('file', items);
    registry.register(provider);

    const result = await registry.search('file', makeCtx('a'));
    expect(result.items).toHaveLength(1);
    expect(provider.search).toHaveBeenCalledOnce();
  });

  it('search 未注册 provider 抛错', async () => {
    const registry = new MentionProviderRegistry();
    await expect(registry.search('unknown', makeCtx())).rejects.toThrow(/unknown/);
  });

  it('register 多个独立 provider 互不影响', () => {
    const registry = new MentionProviderRegistry();
    registry.register(createMockProvider('a'));
    registry.register(createMockProvider('b'));
    registry.register(createMockProvider('c'));
    expect(registry.listProviders()).toHaveLength(3);
    expect(registry.get('a')).toBeDefined();
    expect(registry.get('b')).toBeDefined();
    expect(registry.get('c')).toBeDefined();
  });
});
