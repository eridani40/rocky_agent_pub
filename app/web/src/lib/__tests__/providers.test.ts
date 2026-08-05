// @vitest-environment jsdom
/**
 * lib/providers 实时化单测（v0.0.36 T1 —— 去 module 级永久缓存）
 * 参考: specs/api/overall/02-llm-chat.md §5（GET /provider → {items:ProviderInstance[]}）
 *       states/v0.0.36/task.json T1
 *
 * 覆盖：
 *   - fetchProviders 实时拉取：连续调用各发一次新请求、返回各自最新数据（无永久缓存）
 *   - 并发去重：同一瞬间多处调用合并为一次请求（inFlight），settle 后清空
 *   - 失败抛错（!res.ok）
 *   - useProviders 每次挂载实时拉、重新挂载不串旧数据（核心：去缓存对 ModelPicker/chat 输入区 picker 影响）
 *   - useProviders 错误外显
 *   - formatModelDisplay 四种解析路径
 *   - 测试桩 __setProvidersCacheForTest / __resetProvidersCacheForTest 行为
 *
 * 注：用 React.createElement 而非 JSX。本文件主要测 fetchProviders / formatModelDisplay
 * 等纯逻辑 + useProviders hook（仅需一个轻量探针组件渲染 hook 结果），createElement 足矣，
 * 也避免引入 JSX 运行时依赖，保证在任何 vite dep-cache 状态下都能稳定运行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import {
  fetchProviders,
  useProviders,
  formatModelDisplay,
  __setProvidersCacheForTest,
  __resetProvidersCacheForTest,
  type ProviderItem,
} from '../providers';

const provA: ProviderItem = {
  id: 'pA',
  label: 'Provider A',
  models: [{ modelId: 'a-1', label: 'A-1' }],
};
const provB: ProviderItem = {
  id: 'pB',
  label: 'Provider B',
  models: [{ modelId: 'b-1', label: 'B-1' }],
};

/** 构造一个 GET /provider 的 fetch Response（providers.ts 用 res.json()） */
function providerRes(items: ProviderItem[], ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({ items }),
  } as unknown as Response;
}

beforeEach(() => {
  // 清测试桩 + 在途请求，确保每个用例从「无缓存」起步（走真实 fetch 路径）
  __resetProvidersCacheForTest();
});
afterEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
  vi.restoreAllMocks();
});

// ============================================================
// fetchProviders —— 实时拉取（无永久缓存）
// ============================================================
describe('fetchProviders — 实时拉取，无跨时间永久缓存', () => {
  it('连续两次调用各发一次新请求，第二次拿到最新数据（不复用第一次结果）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerRes([provA]))
      .mockResolvedValueOnce(providerRes([provB]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r1 = await fetchProviders();
    const r2 = await fetchProviders();

    expect(fetchMock).toHaveBeenCalledTimes(2); // 每次都打真实请求
    expect(r1).toEqual([provA]);
    expect(r2).toEqual([provB]); // 第二次拿到最新 B，而非缓存的 A
  });

  it('请求命中 /provider 端点（带 Accept header）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerRes([provA]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await fetchProviders();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/provider');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('items 缺省时返回空数组', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response) as unknown as typeof fetch;
    expect(await fetchProviders()).toEqual([]);
  });

  it('!res.ok 抛错', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(providerRes([], false, 500)) as unknown as typeof fetch;
    await expect(fetchProviders()).rejects.toThrow('GET /provider failed: 500');
  });
});

// ============================================================
// fetchProviders —— 并发去重（inFlight，不跨时间）
// ============================================================
describe('fetchProviders — 同一瞬间并发去重', () => {
  it('同瞬间两次调用合并为一次请求，结果一致', async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerRes([provA]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const [r1, r2] = await Promise.all([fetchProviders(), fetchProviders()]);

    expect(fetchMock).toHaveBeenCalledTimes(1); // 合并为一次
    expect(r1).toEqual([provA]);
    expect(r2).toEqual([provA]);
  });

  it('settle 后 inFlight 清空：之后再调用重新发请求', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerRes([provA]))
      .mockResolvedValueOnce(providerRes([provB]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await Promise.all([fetchProviders(), fetchProviders()]); // 1 次请求
    const r3 = await fetchProviders(); // settle 后再调用 → 第 2 次请求

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r3).toEqual([provB]);
  });
});

// ============================================================
// useProviders —— 每次挂载实时拉、重新挂载不串旧数据
// ============================================================
/** 探针组件：把 useProviders 结果渲染到两个 span 便于断言（createElement，无 JSX） */
function Probe() {
  const { providers, error } = useProviders();
  return createElement(
    'div',
    null,
    createElement('span', null, providers.map((p) => p.id).join(',')),
    createElement('span', null, error ?? ''),
  );
}

/** 取探针 span：[0]=provider ids，[1]=error 信息 */
function probeSpans(container: HTMLElement): [HTMLSpanElement, HTMLSpanElement] {
  const spans = container.querySelectorAll('span');
  return [spans[0]!, spans[1]!];
}

describe('useProviders — 每次挂载实时拉，无永久缓存', () => {
  it('挂载后拉到 providers 并渲染', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(providerRes([provA])) as unknown as typeof fetch;
    const { container } = render(createElement(Probe));
    await waitFor(() => expect(probeSpans(container)[0].textContent).toBe('pA'));
  });

  it('重新挂载发起新请求，拿到最新数据（不串上次挂载的旧数据）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerRes([provA]))
      .mockResolvedValueOnce(providerRes([provB]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { unmount, container } = render(createElement(Probe));
    await waitFor(() => expect(probeSpans(container)[0].textContent).toBe('pA'));
    unmount();

    // 关键：不调用 reset —— 验证「无永久缓存」，第二次挂载仍发新请求拿到 B
    const { container: c2 } = render(createElement(Probe));
    await waitFor(() => expect(probeSpans(c2)[0].textContent).toBe('pB'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('拉取失败时 error 外显', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(providerRes([], false, 503)) as unknown as typeof fetch;
    const { container } = render(createElement(Probe));
    await waitFor(() => expect(probeSpans(container)[1].textContent).toContain('503'));
  });
});

// ============================================================
// 测试桩 —— __setProvidersCacheForTest / __resetProvidersCacheForTest
// ============================================================
describe('测试桩注入辅助', () => {
  it('__setProvidersCacheForTest 注入后 fetchProviders 返回桩数据、不打真实请求', async () => {
    __setProvidersCacheForTest([provA]);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await fetchProviders()).toEqual([provA]);
    expect(fetchMock).not.toHaveBeenCalled(); // 桩生效，绕过 fetch
  });

  it('__resetProvidersCacheForTest 清桩后回到真实 fetch 路径', async () => {
    __setProvidersCacheForTest([provA]);
    __resetProvidersCacheForTest();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(providerRes([provB])) as unknown as typeof fetch;

    expect(await fetchProviders()).toEqual([provB]); // 桩已清，走真实 fetch 拿 B
  });
});

// ============================================================
// formatModelDisplay —— 四种解析路径
// ============================================================
describe('formatModelDisplay', () => {
  const providers = [provA];

  it('命中 provider + model.label → 「Provider A / A-1」', () => {
    expect(formatModelDisplay({ providerId: 'pA', modelId: 'a-1' }, providers)).toBe(
      'Provider A / A-1',
    );
  });

  it('命中 provider 但无 model.label → 回退 modelId', () => {
    expect(formatModelDisplay({ providerId: 'pA', modelId: 'a-x' }, providers)).toBe(
      'Provider A / a-x',
    );
  });

  it('providerId 未命中且 modelId 也不在 → 显示"模型不可用: {modelId}"失效标记（v0.0.43 P0-3）', () => {
    // v0.0.43 P0-3：provider 找不到时不再静默回退到裸 modelId（那样 UI 看起来像"正常选中"），
    //   改为明确失效标记，让 topbar chat-model-tag 与 ModelPicker 按钮体现"已失效"。
    expect(formatModelDisplay({ providerId: 'unknown', modelId: 'm9' }, providers)).toBe('模型不可用: m9');
  });

  it('providerId 空但 modelId 命中某 provider → 回找 provider 显示（编辑回显 value 只给 modelId）', () => {
    // 编辑界面 value = { providerId: '', modelId: 'a-1' }（squad/member 只存 modelId）
    expect(formatModelDisplay({ providerId: '', modelId: 'a-1' }, providers)).toBe('Provider A / A-1');
  });

  it('sel=null → 未配置模型', () => {
    expect(formatModelDisplay(null, providers)).toBe('未配置模型');
  });
});
