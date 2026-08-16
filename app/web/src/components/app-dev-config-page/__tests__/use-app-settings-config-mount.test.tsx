/**
 * @vitest-environment jsdom
 * use-app-settings-config 挂载互斥单测（v0.0.347 T6 修正段决策㉛）
 * 参考: specs/tech/version_logs/v0.0.347/change_plan.md T6 修正段（严格互斥 + 先清后写）
 *
 * 覆盖（task.json acceptanceCriteria playground 严格互斥）：
 *   - 双向清：选方案（handleMountChange 写 planId）→ dmDraft.chat 被清；
 *            选模型（handleDefaultModelsChange 写 chat 值）→ mountDraft 清 null
 *   - saveTab 先清后写（崩溃安全）：
 *     · 转模型向（挂载→模型）：mount 清 PUT（data:{}）先于 default_models 写 PUT
 *     · 转方案向（模型→方案）：default_models 清 PUT（data:{}）先于 mount 写 PUT（data:{playgroundPlanId}）
 *   - 中断落双空合法态：清 PUT 先行 → 任意时点至多一个有值
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAppSettingsConfig } from '../use-app-settings-config';

/** 记录型 fetch 桩：GET 按初始态路由返回；PUT 记录 (url, body) 序列供顺序断言 */
function mockFetch(opts: { initialDm: { chat?: string } | null; initialMountPlanId: string | null }) {
  const puts: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const method = init?.method ?? 'GET';
    const mk = (payload: unknown) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    });
    if (method === 'GET') {
      // 注意顺序：model_routing 精确在前（避免 model_routing_plans 误匹配）
      if (url.includes('group=model_routing&') || url.includes('group=model_routing')) {
        const items = opts.initialMountPlanId
          ? [{ key: 'default', data: { playgroundPlanId: opts.initialMountPlanId } }]
          : [];
        return mk({ items });
      }
      if (url.includes('group=default_models')) return mk({ value: opts.initialDm });
      if (url.includes('group=logs')) return mk({ items: [] });
      return mk({ value: null });
    }
    let body: Record<string, unknown> = {};
    if (init?.body) { try { body = JSON.parse(String(init.body)) as Record<string, unknown>; } catch { /* ignore */ } }
    puts.push({ url, body });
    return mk({ ok: true });
  }) as unknown as typeof fetch;
  return { puts };
}

/** 找某 group 的 PUT 序号（默认 key='default'） */
function putIndexOf(puts: { url: string; body: Record<string, unknown> }[], group: string): number {
  const i = puts.findIndex((c) => c.body.group === group && c.body.key === 'default');
  expect(i).toBeGreaterThanOrEqual(0); // 必须存在
  return i;
}

describe('[v0.0.347 T6] use-app-settings-config 挂载严格互斥 + saveTab 先清后写', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('双向清·转方案向：handleMountChange(planId) → mountDraft=planId 且 dmDraft.chat 被清', async () => {
    mockFetch({ initialDm: { chat: 'glm-5.2' }, initialMountPlanId: null });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.defaultModelsDraft.chat).toBe('glm-5.2'));
    expect(result.current.mountDraft).toBe(null);
    act(() => result.current.handleMountChange('plan-a'));
    expect(result.current.mountDraft).toBe('plan-a');
    expect('chat' in result.current.defaultModelsDraft).toBe(false); // chat 已清
  });

  it('双向清·转模型向：handleDefaultModelsChange(chat,值) → dmDraft.chat=值 且 mountDraft 清 null', async () => {
    mockFetch({ initialDm: null, initialMountPlanId: 'plan-a' });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.mountDraft).toBe('plan-a'));
    act(() => result.current.handleDefaultModelsChange('chat', 'glm-5.2'));
    expect(result.current.defaultModelsDraft.chat).toBe('glm-5.2');
    expect(result.current.mountDraft).toBe(null); // 挂载已清
  });

  it('x 清除（chat→undefined）不清挂载：handleDefaultModelsChange(chat,undefined) 仅删 chat', async () => {
    mockFetch({ initialDm: { chat: 'glm-5.2' }, initialMountPlanId: null });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.defaultModelsDraft.chat).toBe('glm-5.2'));
    act(() => result.current.handleDefaultModelsChange('chat', undefined));
    expect('chat' in result.current.defaultModelsDraft).toBe(false);
  });

  it('先清后写·转模型向：saveTab 顺序 = mount 清 PUT(data:{}) 先于 default_models 写 PUT', async () => {
    const { puts } = mockFetch({ initialDm: null, initialMountPlanId: 'plan-a' });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.mountDraft).toBe('plan-a'));
    act(() => result.current.handleDefaultModelsChange('chat', 'glm-5.2'));
    await act(async () => { await result.current.saveTab('session'); });
    const mountIdx = putIndexOf(puts, 'model_routing');
    const dmIdx = putIndexOf(puts, 'default_models');
    expect(mountIdx).toBeLessThan(dmIdx); // 先清挂载再写 chat
    const mountPut = puts[mountIdx]!;
    const dmPut = puts[dmIdx]!;
    expect(mountPut.body.data).toEqual({}); // 清 = data:{}
    expect(dmPut.body.data).toEqual({ chat: 'glm-5.2' });
  });

  it('先清后写·转方案向：saveTab 顺序 = default_models 清 PUT(data:{}) 先于 mount 写 PUT(data:{playgroundPlanId})', async () => {
    const { puts } = mockFetch({ initialDm: { chat: 'glm-5.2' }, initialMountPlanId: null });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.defaultModelsDraft.chat).toBe('glm-5.2'));
    act(() => result.current.handleMountChange('plan-a'));
    await act(async () => { await result.current.saveTab('session'); });
    const dmIdx = putIndexOf(puts, 'default_models');
    const mountIdx = putIndexOf(puts, 'model_routing');
    expect(dmIdx).toBeLessThan(mountIdx); // 先清 chat 再写挂载
    const dmPut = puts[dmIdx]!;
    const mountPut = puts[mountIdx]!;
    expect(dmPut.body.data).toEqual({}); // 清 = data:{}
    expect(mountPut.body.data).toEqual({ playgroundPlanId: 'plan-a' });
  });

  it('saveTab 后 snapshot 对齐：dirtyOfTab(session)=false 且 mountDraft 保持', async () => {
    mockFetch({ initialDm: { chat: 'glm-5.2' }, initialMountPlanId: null });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.defaultModelsDraft.chat).toBe('glm-5.2'));
    expect(result.current.dirtyOfTab('session')).toBe(false);
    act(() => result.current.handleMountChange('plan-a'));
    expect(result.current.dirtyOfTab('session')).toBe(true);
    await act(async () => { await result.current.saveTab('session'); });
    expect(result.current.dirtyOfTab('session')).toBe(false);
    expect(result.current.mountDraft).toBe('plan-a');
  });
});

// ===== [v0.0.349 BUG-003] 转方案向首存 dirty 残留复现（门控 PUT 分段 flush render）=====

/**
 * 门控 fetch 桩：PUT 各等一个 gate 释放（模拟真实网络逐往返 flush render）。
 * 既有 UT 的 mock 即时 resolve → saveTab 全部 setState 合并单次 render →
 * useCallback deps 在 final render 已变化、闭包新鲜，掩盖了真机时序下的闭包过时。
 */
function gatedFetch(opts: { initialDm: { chat?: string } | null; initialMountPlanId: string | null }) {
  const puts: { url: string; body: Record<string, unknown> }[] = [];
  const gates: Array<() => void> = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const method = init?.method ?? 'GET';
    const mk = (payload: unknown) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    });
    if (method === 'GET') {
      if (url.includes('group=model_routing')) {
        const items = opts.initialMountPlanId
          ? [{ key: 'default', data: { playgroundPlanId: opts.initialMountPlanId } }]
          : [];
        return Promise.resolve(mk({ items }));
      }
      if (url.includes('group=default_models')) return Promise.resolve(mk({ value: opts.initialDm }));
      if (url.includes('group=logs')) return Promise.resolve(mk({ items: [] }));
      return Promise.resolve(mk({ value: null }));
    }
    let body: Record<string, unknown> = {};
    if (init?.body) { try { body = JSON.parse(String(init.body)) as Record<string, unknown>; } catch { /* ignore */ } }
    puts.push({ url, body });
    return new Promise((resolve) => {
      gates.push(() => resolve(mk({ ok: true })));
    });
  }) as unknown as typeof fetch;
  return { puts, gates };
}

/** 释放一个 PUT gate 并 flush render（每 gate = 一次真实网络往返边界 → 一次独立 render） */
async function releaseGate(gates: Array<() => void>) {
  await act(async () => {
    while (gates.length === 0) await new Promise((r) => setTimeout(r, 0));
    gates.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('[v0.0.349 BUG-003] 转方案向首存 dirty 残留（真机时序：逐 PUT 分段 flush）', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('首存（4 PUT 逐段放行）后 dirtyOfTab(session) 立即收敛 false（无需二次保存）', async () => {
    const { puts, gates } = gatedFetch({ initialDm: { chat: 'glm-5.2' }, initialMountPlanId: null });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.defaultModelsDraft.chat).toBe('glm-5.2'));
    act(() => result.current.handleMountChange('plan-a'));
    expect(result.current.dirtyOfTab('session')).toBe(true); // 编辑后 dirty ✓
    let saveP!: Promise<void>;
    act(() => { saveP = result.current.saveTab('session'); });
    // 4 个 PUT 逐个放行：session / default_models / llm_request（loop 内）+ model_routing 写（收尾）
    for (let i = 0; i < 4; i++) await releaseGate(gates);
    expect(puts.length).toBe(4);
    expect(puts.filter((p) => p.body.group === 'model_routing').length).toBe(1); // mount 写 PUT 仅一次
    await act(async () => { await saveP; });
    // 根因（修复前红）：dirtyOfTab deps 缺 mountDraft/mountSnapshot → 收尾 setMountSnapshot 后
    // deps 无变化，保留 llm_request flush 时刻的旧闭包 → mountDraft('plan-a') !== mountSnapshot(null) 残留 true
    expect(result.current.dirtyOfTab('session')).toBe(false);
    expect(result.current.mountDraft).toBe('plan-a');
  });
});

// ===== [v0.0.349 BUG-004] 删已挂载方案 → 本地挂载态同步清（服务端 detached 通知）=====

describe('[v0.0.349 BUG-004] clearPlaygroundMountState — 删方案后本地挂载态清理', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('匹配 planId → draft+snapshot 同步 null，不产 dirty（服务端已清，本地对齐真值）', async () => {
    mockFetch({ initialDm: null, initialMountPlanId: 'plan-a' });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.mountDraft).toBe('plan-a'));
    expect(result.current.dirtyOfTab('session')).toBe(false);
    act(() => result.current.clearPlaygroundMountState('plan-a'));
    expect(result.current.mountDraft).toBe(null);
    // 双 snapshot 同清 → dirty 不亮（对齐服务端真值，非用户编辑）
    expect(result.current.dirtyOfTab('session')).toBe(false);
  });

  it('planId 不匹配 → no-op（不动用户编辑中的其他挂载）', async () => {
    mockFetch({ initialDm: null, initialMountPlanId: 'plan-a' });
    const { result } = renderHook(() => useAppSettingsConfig());
    await waitFor(() => expect(result.current.mountDraft).toBe('plan-a'));
    act(() => result.current.clearPlaygroundMountState('plan-other'));
    expect(result.current.mountDraft).toBe('plan-a');
  });
});
