// @vitest-environment jsdom
/**
 * api-client scope 维度单测（v0.0.67 起仅读路径）。
 * 参考:
 * - reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D4（写端点删，配置只读化）
 * - specs/api/version_logs/v0.0.26/change_log.md §1（scope list）/ §2（EP 激活 list）/ §3.1（inventory scopeId）
 * - specs/tech/config/[P0]ext_impl_scope.md §2（PluginScope）/ §7（PluginInventoryTree 扩展）
 *
 * v0.0.67 重构（用户指示「直接删写端点，无死代码」）：
 * - 写函数（createScope/deleteScope/activateEp/deactivateEp/putPluginOp）已删，相关测试同步删
 * - 保留读路径覆盖：
 *   - listScopes / listActivations（GET 函数签名 + URL + 返回值）
 *   - getPluginInventory(scopeId?)（缺省不传 = default 向后兼容）
 *   - PluginInventoryTree 类型扩展（scope/scopes/points[]/pointActivated）形态
 *   - 字段名约定：tree.scopes[].scopeId（复数 PluginScope 记录）vs tree.scope.id（单数当前元信息）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listScopes,
  listActivations,
  getPluginInventory,
  type PluginInventory,
  type PluginScope,
} from '../api-client';
import * as apiClient from '../api-client';

// mock fetch（api-base.resolveApiBase 在浏览器侧读 import.meta.env.VITE_API_BASE，jsdom 下为空 → 相对路径）
type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
const fetchMock: FetchMock = vi.fn();

function mockFetchOnce(body: unknown, ok = true, status = 200): FetchMock {
  fetchMock.mockImplementationOnce(async () => ({
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// 捕获最近一次 fetch 的 method/url/body
function lastCall(fn: FetchMock) {
  const c = fn.mock.calls[fn.mock.calls.length - 1]!;
  const [url, init] = c as [string, RequestInit | undefined];
  return {
    url,
    method: (init?.method ?? 'GET') as string,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('scope 读函数 — v0.0.67 起仅 GET（写函数已删）', () => {
  it('listScopes: GET /config/plugin/scopes，返 items[]（default 首位）', async () => {
    const items: PluginScope[] = [
      { scopeId: 'default', name: 'Default', description: '默认基线 scope', createdAt: '2026-06-19T00:00:00.000Z' },
      { scopeId: 'release', name: 'Release', description: '发布模式', createdAt: '2026-06-27T10:00:00.000Z' },
    ];
    const fn = mockFetchOnce({ items });
    const r = await listScopes();
    expect(r).toEqual(items);
    expect(r[0]!.scopeId).toBe('default'); // default 首位
    const c = lastCall(fn);
    expect(c.url).toContain('/config/plugin/scopes');
    expect(c.method).toBe('GET');
  });

  it('listScopes: 空 items 兜底返 []', async () => {
    mockFetchOnce({});
    const r = await listScopes();
    expect(r).toEqual([]);
  });
});

describe('EP 激活读函数 — v0.0.67 起仅 GET listActivations（写函数已删）', () => {
  it('listActivations: GET /scopes/:id/activations，返 items[{pointId}]', async () => {
    const fn = mockFetchOnce({ items: [{ pointId: 'llm_provider' }, { pointId: 'context_provider' }] });
    const r = await listActivations('custom');
    expect(r).toHaveLength(2);
    expect(r[0]!.pointId).toBe('llm_provider');
    const c = lastCall(fn);
    expect(c.method).toBe('GET');
    expect(c.url).toContain('/config/plugin/scopes/custom/activations');
  });

  it('listActivations: 空 items 兜底返 []', async () => {
    mockFetchOnce({});
    const r = await listActivations('custom');
    expect(r).toEqual([]);
  });
});

describe('v0.0.67 写函数已删 — 模块上不存在 createScope/deleteScope/activateEp/deactivateEp/putPluginOp（防回归）', () => {
  it('api-client 模块导出不含写函数', () => {
    expect((apiClient as unknown as { createScope?: unknown }).createScope).toBeUndefined();
    expect((apiClient as unknown as { deleteScope?: unknown }).deleteScope).toBeUndefined();
    expect((apiClient as unknown as { activateEp?: unknown }).activateEp).toBeUndefined();
    expect((apiClient as unknown as { deactivateEp?: unknown }).deactivateEp).toBeUndefined();
    expect((apiClient as unknown as { putPluginOp?: unknown }).putPluginOp).toBeUndefined();
  });
});

describe('getPluginInventory(scopeId?) — api change_log §3.1', () => {
  it('缺省不传：URL 不带 scopeId query（= default 向后兼容）', async () => {
    const fn = mockFetchOnce({ tree: { plugins: [], groups: [] } });
    await getPluginInventory();
    const c = lastCall(fn);
    expect(c.url).toMatch(/\/config\/plugin$/); // 末尾无 query
    expect(c.url).not.toContain('scopeId');
  });

  it('传 scopeId：URL 带 ?scopeId=<id>', async () => {
    const fn = mockFetchOnce({ tree: { plugins: [], groups: [] } });
    await getPluginInventory('custom');
    expect(lastCall(fn).url).toContain('/config/plugin?scopeId=custom');
  });

  it('scopeId URL 编码', async () => {
    const fn = mockFetchOnce({ tree: { plugins: [], groups: [] } });
    await getPluginInventory('a b');
    expect(lastCall(fn).url).toContain('scopeId=a%20b');
  });

  it('响应 tree 缺失兜底返空骨架', async () => {
    mockFetchOnce({});
    const r = await getPluginInventory();
    expect(r).toEqual({ plugins: [], groups: [] });
  });
});

describe('PluginInventoryTree 类型扩展 — tech §7', () => {
  it('[v0.0.71 D3] 完整形态：嵌套 groups[].points[].impls[]（破坏性 schema 变更）', () => {
    const inv: PluginInventory = {
      scope: { id: 'custom', name: 'Custom', description: '自定义风格' },
      scopes: [
        { scopeId: 'default', name: 'Default', description: '默认基线 scope', createdAt: '2026-06-19T00:00:00.000Z' },
        { scopeId: 'custom', name: 'Custom', description: '自定义风格', createdAt: '2026-06-27T00:00:00.000Z' },
      ],
      plugins: [{ pluginId: 'p1', label: 'P1', description: '', enabled: true }],
      groups: [
        {
          groupId: 'provider',
          // v0.0.71 D3：嵌套 points[]{ pointId, activated, impls[] }
          points: [
            {
              pointId: 'llm_provider',
              activated: false,
              impls: [
                {
                  pluginId: 'p1', pointId: 'llm_provider', implId: 'i1',
                  pluginEnabled: true, enabled: true, order: 1,
                },
              ],
            },
          ],
        },
      ],
    };
    // 字段名约定断言（task 6 description + change_log §1.1）：
    // tree.scope（单数，当前元信息）用 id；tree.scopes[]（复数，PluginScope 记录）用 scopeId
    expect(inv.scope!.id).toBe('custom');
    expect(inv.scopes![0]!.scopeId).toBe('default');
    expect(inv.scopes![1]!.scopeId).toBe('custom');
    // v0.0.71 D3 嵌套结构：points[].activated（替代旧 extImpls[].pointActivated）
    expect(inv.groups[0]!.points[0]!.pointId).toBe('llm_provider');
    expect(inv.groups[0]!.points[0]!.activated).toBe(false);
    expect(inv.groups[0]!.points[0]!.impls[0]!.implId).toBe('i1');
  });

  it('PluginScope 类型字段：scopeId/name/createdAt 必填，description 可选', () => {
    const s: PluginScope = { scopeId: 'x', name: 'X', createdAt: 't' };
    expect(s.description).toBeUndefined();
    const full: PluginScope = { scopeId: 'y', name: 'Y', description: 'd', createdAt: 't' };
    expect(full.description).toBe('d');
  });
});
