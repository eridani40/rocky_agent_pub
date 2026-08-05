// @vitest-environment node
/**
 * sse-singleton 模块级 lazy 单例单测（v0.0.88）
 * 参考: specs/tech/app/frontend/[P0]sse_client_singleton.md §4（单例位置）+ §1 S1/S2（全局唯一）
 *
 * 覆盖：
 *   - 重复 getSseClient() 返回同一实例只 connect 一次
 *   - StrictMode 双 mount 不双建（连续 getSseClient 幂等）
 *   - _resetSseSingletonForTest 重置后下次 getSseClient 创建新实例 + 调 destroy
 *
 * mock 策略（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）：vi.hoisted + 绝对路径 mock
 *   拦截 SseClient 构造 + connect/destroy，断言实例数与调用次数
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ctor, instances } = vi.hoisted(() => {
  const instances: Array<{
    connect: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  const ctor = vi.fn().mockImplementation(() => {
    const inst = {
      connect: vi.fn(async () => undefined),
      destroy: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    instances.push(inst);
    return inst;
  });
  return { ctor, instances };
});

const sseClientPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../sse-client'),
);

vi.mock(sseClientPath, () => ({ SseClient: ctor }));

import { getSseClient, _resetSseSingletonForTest } from '../sse-singleton';

beforeEach(() => {
  instances.length = 0;
  ctor.mockClear();
  _resetSseSingletonForTest();
});

describe('sse-singleton 模块级 lazy 单例 (v0.0.88)', () => {
  it('重复 getSseClient() 返回同一实例只 connect 一次', () => {
    const a = getSseClient();
    const b = getSseClient();
    const c = getSseClient();
    expect(a).toBe(b);
    expect(b).toBe(c);
    // 模块级 lazy：只构造一次 + 只 connect 一次（spec §1 S1/S2）
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.connect).toHaveBeenCalledTimes(1);
  });

  it('StrictMode 双 mount 不双建（连续 getSseClient 幂等）', () => {
    // 模拟 React StrictMode 双 mount：组件 mount effect 连续调 getSseClient
    const a = getSseClient();
    const b = getSseClient();
    expect(a).toBe(b);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(instances[0]!.connect).toHaveBeenCalledTimes(1);
  });

  it('_resetSseSingletonForTest 重置后下次 getSseClient 创建新实例', () => {
    const a = getSseClient();
    expect(ctor).toHaveBeenCalledTimes(1);
    _resetSseSingletonForTest();
    const b = getSseClient();
    expect(b).not.toBe(a);
    expect(ctor).toHaveBeenCalledTimes(2);
  });

  it('_resetSseSingletonForTest 调 destroy 断开旧实例', () => {
    const a = getSseClient();
    expect(a.destroy).not.toHaveBeenCalled();
    _resetSseSingletonForTest();
    expect(a.destroy).toHaveBeenCalledTimes(1);
  });

  it('句柄 unsubscribe 走单例 client（不依赖 React Context）', async () => {
    // 验证模块级单例不需要 Context provider 也能取到同一实例
    const a = getSseClient();
    const b = getSseClient();
    // a 与 b 是同一实例，unsubscribe 路径在 a.unsubscribe 上调用即可
    expect(typeof a.unsubscribe).toBe('function');
    expect(a.unsubscribe).toBe(b.unsubscribe);
  });
});
