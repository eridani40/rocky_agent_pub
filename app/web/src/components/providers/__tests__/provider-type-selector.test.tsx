/**
 * @vitest-environment jsdom
 * [v0.0.350] provider 类型 preset + 选择器联动 — 单测（决策④⑤）
 * 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策④⑤ + PRD §2.1
 *       specs/ui/components/providers/component-provider-fields.md（spec）
 *
 * 校验点：
 *   - preset 表：5 类型（1 通用 + 4 native）+ isNativeCodingPlan 判定
 *   - fields：类型 KeyChoiceCards 渲染友好名（labels）+ onChange 上抛 {name}；
 *     native → protocol 锁定只读框（禁点）；通用 → KeyChoiceCards 原形态
 *   - detail 联动（决策④ + 老板 08-15 反馈）：新建选 kimi → baseUrl 填 preset + protocol 锁定 + 空模型预填
 *     （kimi-for-coding 262144）；切回通用不回填；切 native 类型 baseUrl 无条件替换 preset
 *     （旧渠道地址/自定义值不保留；切完后用户仍可手动改）
 *   - api-client name 透传（决策⑤）：POST body 含 name；PUT name 变才传
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentProviderFields } from '../component-provider-fields';
import { ComponentProviderDetail } from '../component-provider-detail';
import { PROVIDER_TYPE_PRESETS, isNativeCodingPlan } from '../provider-type-presets';
import type { ProtocolMeta, ProviderInstance, ProviderName } from '../../../lib/api-client';
import { saveProviderWithModels } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const protocols: ProtocolMeta[] = [
  { id: 'anthropic_messages', label: 'Anthropic Messages 风格', path: '/v1/messages' },
];

describe('[v0.0.350] provider-type-presets — preset 表 + 判定', () => {
  it('5 类型（1 通用 + 4 native），顺序 = 选择器展示顺序', () => {
    expect(PROVIDER_TYPE_PRESETS.map((p) => p.id)).toEqual([
      'anthropic_compatible', 'kimi_coding_plan', 'glm_coding_plan', 'minimax_coding_plan', 'deepseek_api',
    ]);
  });

  it('kimi preset：默认 baseUrl/默认模型 + contextWindow 262144；glm/minimax/deepseek 默认值齐备', () => {
    const kimi = PROVIDER_TYPE_PRESETS.find((p) => p.id === 'kimi_coding_plan')!;
    expect(kimi.defaultBaseUrl).toBe('https://api.kimi.com/coding/');
    expect(kimi.defaultModel).toBe('kimi-for-coding');
    expect(kimi.contextWindow).toBe(262144);
    for (const id of ['glm_coding_plan', 'minimax_coding_plan', 'deepseek_api']) {
      const p = PROVIDER_TYPE_PRESETS.find((x) => x.id === id)!;
      expect(p.defaultBaseUrl).toBeTruthy();
      expect(p.defaultModel).toBeTruthy();
    }
  });

  it('isNativeCodingPlan：通用/空 = false；4 native = true', () => {
    expect(isNativeCodingPlan('anthropic_compatible')).toBe(false);
    expect(isNativeCodingPlan(undefined)).toBe(false);
    expect(isNativeCodingPlan('kimi_coding_plan')).toBe(true);
    expect(isNativeCodingPlan('deepseek_api')).toBe(true);
  });
});

describe('[v0.0.350] fields — 类型选择器 + protocol 锁定', () => {
  afterEach(() => cleanup());

  it('类型 KeyChoiceCards 渲染 5 项友好名（labels），点击上抛 {name}', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ComponentProviderFields
        draft={{ label: '', baseUrl: '', apiKey: '', enabled: true, protocolId: 'anthropic_messages' }}
        onChange={onChange}
        protocolOptions={protocols}
      />,
    );
    // 5 张类型卡 + 友好名（zh-CN labels）
    const glmCard = container.querySelector('[data-testid="provider-field-type-glm_coding_plan"]')!;
    expect(glmCard.textContent).toContain('智谱 GLM Coding Plan');
    expect(container.querySelectorAll('[data-testid^="provider-field-type-"]').length).toBe(5);
    fireEvent.click(glmCard);
    expect(onChange).toHaveBeenCalledWith({ name: 'glm_coding_plan' });
  });

  it('native 类型 → protocol 只读锁定框（无卡片可点，MUST 禁点）', () => {
    const { container } = render(
      <ComponentProviderFields
        draft={{ label: '', baseUrl: '', apiKey: '', enabled: true, name: 'kimi_coding_plan', protocolId: 'anthropic_messages' }}
        onChange={() => {}}
        protocolOptions={protocols}
      />,
    );
    expect(container.querySelector('[data-testid="provider-field-protocol-locked"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="provider-field-protocol-locked"]')!.textContent).toContain('anthropic_messages');
    // 无 protocol 卡片（无可点元素）
    expect(container.querySelector('[data-testid="provider-field-protocol"]')).toBeNull();
  });

  it('通用类型 → protocol 保持 KeyChoiceCards 原形态（可点）', () => {
    const { container } = render(
      <ComponentProviderFields
        draft={{ label: '', baseUrl: '', apiKey: '', enabled: true, protocolId: 'anthropic_messages' }}
        onChange={() => {}}
        protocolOptions={protocols}
      />,
    );
    expect(container.querySelector('[data-testid="provider-field-protocol"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="provider-field-protocol-locked"]')).toBeNull();
  });
});

describe('[v0.0.350] detail — 类型变更联动（决策④）', () => {
  afterEach(() => cleanup());

  const renderDetail = (provider: ProviderInstance | null) =>
    render(
      <ComponentProviderDetail provider={provider} protocolOptions={protocols} onBack={() => {}} onSaved={() => {}} />,
    );

  it('新建选 kimi → baseUrl 填 preset + protocol 锁定 + 空模型预填（kimi-for-coding 262144）', () => {
    const { container } = renderDetail(null);
    fireEvent.click(container.querySelector('[data-testid="provider-field-type-kimi_coding_plan"]')!);
    // baseUrl 自动填 preset 默认值
    expect((screen.getByPlaceholderText('https://api.anthropic.com') as HTMLInputElement).value).toBe('https://api.kimi.com/coding/');
    // protocol 锁定只读
    expect(container.querySelector('[data-testid="provider-field-protocol-locked"]')).toBeTruthy();
    // 模型预填一条（modelId 出现在卡标题回退 + 副标 mono；ctx 展示 262144）
    expect(screen.getAllByText('kimi-for-coding').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('262144 ctx · 0 out')).toBeTruthy();
  });

  it('切回通用不回填：baseUrl 保持已填值 + protocol 恢复可点卡片', () => {
    const { container } = renderDetail(null);
    fireEvent.click(container.querySelector('[data-testid="provider-field-type-kimi_coding_plan"]')!);
    fireEvent.click(container.querySelector('[data-testid="provider-field-type-anthropic_compatible"]')!);
    // 不清空/不重置 baseUrl（已填 kimi URL 保留，用户可自行修改）
    expect((screen.getByPlaceholderText('https://api.anthropic.com') as HTMLInputElement).value).toBe('https://api.kimi.com/coding/');
    expect(container.querySelector('[data-testid="provider-field-protocol"]')).toBeTruthy();
  });

  it('已存 provider 改类型：自定义 baseUrl 无条件替换为 preset 推荐地址（老板 08-15 拍板：切类型=换渠道）', () => {
    const saved: ProviderInstance = {
      id: 'p-1', name: 'anthropic_compatible', protocolId: 'anthropic_messages',
      label: '自建', baseUrl: 'https://custom.example.com', credentials: { key: '***' },
      enabled: true, models: [],
    };
    const { container } = renderDetail(saved);
    fireEvent.click(container.querySelector('[data-testid="provider-field-type-deepseek_api"]')!);
    // 旧自定义地址不保留 → 无条件替换为 deepseek preset 推荐地址
    expect((screen.getByPlaceholderText('https://api.anthropic.com') as HTMLInputElement).value).toBe('https://api.deepseek.com/anthropic');
    // 已存 provider（非新建）不预填默认模型
    expect(screen.queryByText('deepseek-v4-pro')).toBeNull();
  });

  it('native 间切换：旧渠道地址也被替换为新类型 preset（kimi → glm）', () => {
    const saved: ProviderInstance = {
      id: 'p-2', name: 'kimi_coding_plan', protocolId: 'anthropic_messages',
      label: 'K', baseUrl: 'https://api.kimi.com/coding/', credentials: { key: '***' },
      enabled: true, models: [],
    };
    const { container } = renderDetail(saved);
    fireEvent.click(container.querySelector('[data-testid="provider-field-type-glm_coding_plan"]')!);
    expect((screen.getByPlaceholderText('https://api.anthropic.com') as HTMLInputElement).value).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('切完后用户仍可手动改 baseUrl（输入框不锁死，改值生效）', () => {
    const { container } = renderDetail(null);
    fireEvent.click(container.querySelector('[data-testid="provider-field-type-kimi_coding_plan"]')!);
    const input = screen.getByPlaceholderText('https://api.anthropic.com') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'https://my-proxy.example.com' } });
    expect(input.value).toBe('https://my-proxy.example.com');
  });
});

describe('[v0.0.350] api-client — name 透传（决策⑤）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  const makeProvider = (name: ProviderName): ProviderInstance => ({
    id: 'p-9', name, protocolId: 'anthropic_messages',
    label: 'Kimi', baseUrl: 'https://api.kimi.com/coding/', credentials: { key: '***' },
    enabled: true, models: [],
  });

  const stubFetch = () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/model') && method === 'POST') return json({ model: { modelId: 'kimi-for-coding', contextWindow: 262144, maxOutputTokens: 0, label: '', enabled: true } });
      if (url.endsWith('/provider') && method === 'POST') return json({ provider: makeProvider('kimi_coding_plan') });
      if (url.includes('/provider/') && method === 'PUT') return json({ provider: makeProvider('kimi_coding_plan') });
      return json({ items: [makeProvider('kimi_coding_plan')], protocols: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  };

  it('新建（snapshot=null）→ POST /provider body 含 name=kimi_coding_plan（缺省通用兼容）', async () => {
    const calls = stubFetch();
    await saveProviderWithModels(null, {
      label: 'Kimi', baseUrl: 'https://api.kimi.com/coding/', apiKey: 'sk-x', enabled: true,
      protocolId: 'anthropic_messages', name: 'kimi_coding_plan',
      models: [{ modelId: 'kimi-for-coding', contextWindow: 262144, maxOutputTokens: 0, label: '', enabled: true }],
    });
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/provider'))!;
    expect(JSON.parse(post.body!).name).toBe('kimi_coding_plan');
  });

  it('已存改类型（name 变）→ PUT body 含 name；未变（缺省）→ PUT 不带 name 键', async () => {
    const calls = stubFetch();
    const snapshot = makeProvider('anthropic_compatible');
    snapshot.baseUrl = 'https://old.example.com';
    // name 变 → PUT 透传
    await saveProviderWithModels(snapshot, {
      id: 'p-9', label: 'Kimi', baseUrl: 'https://old.example.com', apiKey: '***', enabled: true,
      protocolId: 'anthropic_messages', name: 'glm_coding_plan', models: [],
    });
    const put1 = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put1.body!).name).toBe('glm_coding_plan');
    // name 未变（draft 不传 name）→ PUT body 无 name 键
    calls.length = 0;
    const snapshot2 = makeProvider('anthropic_compatible');
    await saveProviderWithModels(snapshot2, {
      id: 'p-9', label: '改名', baseUrl: snapshot2.baseUrl, apiKey: '***', enabled: true,
      protocolId: 'anthropic_messages', models: [],
    });
    const put2 = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put2.body!)).not.toHaveProperty('name');
  });
});
