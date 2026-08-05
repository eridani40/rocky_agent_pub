// @vitest-environment node
/**
 * overlay-root SSR 安全测试（v0.0.135）
 * 参考: specs/ui/components/chat-page/_layering.md §3 Invariant A
 *
 * 在 node 环境（无 document）下验证 getOverlayRoot 返回 null，不抛错。
 * 这条路径在 jsdom 下测不到（jsdom 必有 document），独立 node-env 文件覆盖。
 */
import { describe, it, expect } from 'vitest';

describe('getOverlayRoot SSR 安全（node env，无 document）', () => {
  it('typeof document === undefined → 返回 null，不抛错', async () => {
    // node env 下 globalThis.document 不存在
    expect(typeof document).toBe('undefined');
    const { getOverlayRoot } = await import('../overlay-root');
    expect(getOverlayRoot()).toBeNull();
  });
});
