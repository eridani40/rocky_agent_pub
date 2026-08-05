/**
 * 内置扩展点元数据断言（v0.0.72 新增）
 * 参考: specs/tech/agent/tools/[P1]web_search_tool.md §3（cardinality=list 修订）
 *
 * 覆盖：WebSearchProviderPoint.cardinality === 'list'（v0.0.72 由 exclusive 改 list）。
 * 防止后续误改回 exclusive 或其他 cardinality 静默回归。
 * 注：v0.0.71 D1 起 group 字段迁到 groups.json 元数据源，EP 自身不再含 group 字段。
 */
import { describe, it, expect } from 'vitest';
import { WebSearchProviderPoint, BUILTIN_EXTENSION_POINTS } from '../extension-point';

describe('WebSearchProviderPoint 元数据', () => {
  it('id === "web_search_provider"', () => {
    expect(WebSearchProviderPoint.id).toBe('web_search_provider');
  });

  it('cardinality === "list"（v0.0.72 由 exclusive 改 list）', () => {
    expect(WebSearchProviderPoint.cardinality).toBe('list');
  });

  it('在 BUILTIN_EXTENSION_POINTS 注册表中存在', () => {
    expect(BUILTIN_EXTENSION_POINTS).toContain(WebSearchProviderPoint);
  });
});
