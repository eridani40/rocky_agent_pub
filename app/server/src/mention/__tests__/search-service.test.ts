/**
 * searchMentions service 单测 —— workspaceDir 解析 + 错误处理（v0.0.45 T2）
 * 参考: specs/tech/mention/search-api.md §2（SearchCtx 构造逻辑）
 *       specs/api/mention/GET-search.md §5（workspaceDir 解析规则）
 *
 * 覆盖：
 *   - case 1: playground/rocky → workspaceDir = session.workspaceDir
 *   - case 2: studio/mate → workspaceDir = session.workspaceDir（member workspace）
 *   - case 3: studio/leader → workspaceDir = session.workspaceDir
 *   - case 4: studio/squad → workspaceDir = session.workspaceDir（team workspace）
 *   - case 5: subagent → workspaceDir = parent session.workspaceDir
 *   - case 6: session 不存在 → SessionNotFoundError
 *   - case 7: provider 未注册 → ProviderNotFoundError
 */
import { describe, it, expect, vi } from 'vitest';
import {
  searchMentions,
  SessionNotFoundError,
  ProviderNotFoundError,
  type SearchMentionsDeps,
} from '../search-service';
import type { SearchResult } from '../types';

/** 构造 mock sessionStore（getSession 可配置返回值） */
function mockSessionStore(sessions: Record<string, any>) {
  return {
    getSession: vi.fn().mockImplementation(async (id: string) => sessions[id] ?? null),
  } as any;
}

/** 构造 mock mentionRegistry（search 返回固定结果） */
function mockRegistry(opts: { registered: string[]; result?: SearchResult }) {
  const result = opts.result ?? { items: [] };
  return {
    get: vi.fn().mockImplementation((name: string) =>
      opts.registered.includes(name) ? { name, label: name } : undefined,
    ),
    search: vi.fn().mockResolvedValue(result),
  } as any;
}

/** 构造最小 session record */
function makeSession(overrides: Record<string, any> = {}) {
  return {
    id: 'sid-1',
    workspaceDir: '/data/workspaces/sid-1',
    // [v0.0.56] 新字段名：code 读 session.biz/role/derivation，非 bizType/type
    biz: 'playground',
    role: 'rocky',
    derivation: 'parent',
    ...overrides,
  };
}

describe('searchMentions', () => {
  it('case 1: playground/rocky → workspaceDir = session.workspaceDir', async () => {
    const session = makeSession();
    const registry = mockRegistry({ registered: ['file'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({ 'sid-1': session }),
      mentionRegistry: registry,
    };

    const result = await searchMentions(deps, {
      provider: 'file',
      query: 'test',
      sessionId: 'sid-1',
      limit: 20,
    });

    expect(result).toEqual({ items: [] });
    // 验证传给 registry.search 的 ctx.workspaceDir
    const ctx = registry.search.mock.calls[0]![1];
    expect(ctx.workspaceDir).toBe('/data/workspaces/sid-1');
    expect(ctx.bizType).toBe('playground');
    expect(ctx.sessionType).toBeUndefined(); // [v0.0.56 hotfix] sessionType 字段已删除
    expect(ctx.role).toBe('rocky');
    expect(ctx.derivation).toBe('parent');
    expect(ctx.biz).toBe('playground');
  });

  it('case 2: studio/mate → workspaceDir = session.workspaceDir（member workspace）', async () => {
    const session = makeSession({
      // [v0.0.56] biz/role 替代 bizType/type
      biz: 'studio',
      role: 'mate',
      squadId: 'sq-1',
      memberId: 'mem-1',
      workspaceDir: '/data/squads/sq-1/workspaces/mem-1',
    });
    const registry = mockRegistry({ registered: ['file'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({ 'sid-2': session }),
      mentionRegistry: registry,
    };

    await searchMentions(deps, {
      provider: 'file',
      query: '',
      sessionId: 'sid-2',
      limit: 20,
    });

    const ctx = registry.search.mock.calls[0]![1];
    expect(ctx.workspaceDir).toBe('/data/squads/sq-1/workspaces/mem-1');
    expect(ctx.bizType).toBe('studio');
    expect(ctx.sessionType).toBeUndefined(); // [v0.0.56 hotfix] sessionType 字段已删除
    expect(ctx.role).toBe('mate');
    expect(ctx.derivation).toBe('parent');
    expect(ctx.biz).toBe('studio');
    expect(ctx.memberId).toBe('mem-1');
    expect(ctx.squadId).toBe('sq-1');
  });

  it('case 3: studio/leader → workspaceDir = session.workspaceDir', async () => {
    const session = makeSession({
      // [v0.0.56] biz/role 替代 bizType/type
      biz: 'studio',
      role: 'leader',
      squadId: 'sq-1',
      memberId: 'mem-leader',
      workspaceDir: '/data/squads/sq-1/workspaces/mem-leader',
    });
    const registry = mockRegistry({ registered: ['skill'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({ 'sid-3': session }),
      mentionRegistry: registry,
    };

    await searchMentions(deps, {
      provider: 'skill',
      query: 'dra',
      sessionId: 'sid-3',
      limit: 20,
    });

    const ctx = registry.search.mock.calls[0]![1];
    expect(ctx.workspaceDir).toBe('/data/squads/sq-1/workspaces/mem-leader');
    expect(ctx.sessionType).toBeUndefined(); // [v0.0.56 hotfix] sessionType 字段已删除
    expect(ctx.role).toBe('leader');
    expect(ctx.derivation).toBe('parent');
    expect(ctx.biz).toBe('studio');
  });

  it('case 4: studio/squad → workspaceDir = session.workspaceDir（team workspace）', async () => {
    const session = makeSession({
      // [v0.0.56] biz/role 替代 bizType/type
      biz: 'studio',
      role: 'squad',
      squadId: 'sq-1',
      workspaceDir: '/data/squads/sq-1',
    });
    const registry = mockRegistry({ registered: ['file'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({ 'sid-4': session }),
      mentionRegistry: registry,
    };

    await searchMentions(deps, {
      provider: 'file',
      query: '',
      sessionId: 'sid-4',
      limit: 20,
    });

    const ctx = registry.search.mock.calls[0]![1];
    expect(ctx.workspaceDir).toBe('/data/squads/sq-1');
    expect(ctx.sessionType).toBeUndefined(); // [v0.0.56 hotfix] sessionType 字段已删除
    expect(ctx.role).toBe('squad');
    expect(ctx.derivation).toBe('parent');
    expect(ctx.biz).toBe('studio');
  });

  it('case 5: subagent → workspaceDir = parent session.workspaceDir', async () => {
    const parentSession = makeSession({
      id: 'parent-sid',
      workspaceDir: '/data/workspaces/parent',
    });
    const childSession = makeSession({
      id: 'child-sid',
      // [v0.0.56] derivation 替代 type 做 subagent 判定
      role: 'rocky',
      derivation: 'subagent',
      parentSessionId: 'parent-sid',
      workspaceDir: '',
    });
    const registry = mockRegistry({ registered: ['file'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({
        'child-sid': childSession,
        'parent-sid': parentSession,
      }),
      mentionRegistry: registry,
    };

    await searchMentions(deps, {
      provider: 'file',
      query: '',
      sessionId: 'child-sid',
      limit: 20,
    });

    const ctx = registry.search.mock.calls[0]![1];
    expect(ctx.workspaceDir).toBe('/data/workspaces/parent');
    // [v0.0.56 hotfix] subagent: role='rocky'（bloodline）, derivation='subagent', biz='playground'
    expect(ctx.sessionType).toBeUndefined();
    expect(ctx.role).toBe('rocky');
    expect(ctx.derivation).toBe('subagent');
    expect(ctx.biz).toBe('playground');
    expect(ctx.parentSessionId).toBe('parent-sid');
  });

  it('case 6: session 不存在 → 抛出 SessionNotFoundError', async () => {
    const registry = mockRegistry({ registered: ['file'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({}),
      mentionRegistry: registry,
    };

    await expect(
      searchMentions(deps, {
        provider: 'file',
        query: '',
        sessionId: 'nonexistent',
        limit: 20,
      }),
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('case 7: provider 未注册 → 抛出 ProviderNotFoundError', async () => {
    const session = makeSession();
    const registry = mockRegistry({ registered: ['file'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({ 'sid-1': session }),
      mentionRegistry: registry,
    };

    await expect(
      searchMentions(deps, {
        provider: 'unknown-provider',
        query: '',
        sessionId: 'sid-1',
        limit: 20,
      }),
    ).rejects.toThrow(ProviderNotFoundError);
  });

  it('limit + cursor 透传到 SearchCtx', async () => {
    const session = makeSession();
    const registry = mockRegistry({
      registered: ['file'],
      result: { items: [], nextCursor: 'cursor-2' },
    });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({ 'sid-1': session }),
      mentionRegistry: registry,
    };

    const result = await searchMentions(deps, {
      provider: 'file',
      query: 'md',
      sessionId: 'sid-1',
      limit: 5,
      cursor: 'cursor-1',
    });

    const ctx = registry.search.mock.calls[0]![1];
    expect(ctx.limit).toBe(5);
    expect(ctx.cursor).toBe('cursor-1');
    expect(ctx.query).toBe('md');
    expect(result.nextCursor).toBe('cursor-2');
  });

  it('bizType/sessionType 缺省回退 playground/rocky', async () => {
    // 历史 session 无 bizType/type 字段 → 缺省回退
    const session = { id: 'old-sid', workspaceDir: '/ws' };
    const registry = mockRegistry({ registered: ['file'] });
    const deps: SearchMentionsDeps = {
      sessionStore: mockSessionStore({ 'old-sid': session }),
      mentionRegistry: registry,
    };

    await searchMentions(deps, {
      provider: 'file',
      query: '',
      sessionId: 'old-sid',
      limit: 20,
    });

    const ctx = registry.search.mock.calls[0]![1];
    expect(ctx.bizType).toBe('playground');
    expect(ctx.sessionType).toBeUndefined(); // [v0.0.56 hotfix] sessionType 字段已删除
    expect(ctx.role).toBe('rocky');
    expect(ctx.derivation).toBe('parent');
    expect(ctx.biz).toBe('playground');
  });
});
