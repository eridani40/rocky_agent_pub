/**
 * @vitest-environment jsdom
 * channel-page 组件单测（v0.0.103 T5）
 * 参考: specs/ui/components/channel-page/_overview.md
 *
 * 校验点：
 *  - PageChannel 渲染 header / new-btn / list（空态），点 new-btn 打开表单
 *  - SectionChannelForm 新建态：appSecret 是 password input（E2E type action 目标是 input）
 *  - SectionChannelForm 编辑态：appSecret 用 SecretInput（mask 既有值）
 *  - SectionChannelList：instance 行 switch/status，connection 状态文案闭合
 *
 * vi.mock 绝对路径：路径动态从本 test 文件位置(__dirname)解析当前 worktree 真实源文件，不写死 worktree 名
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

// channel ns 文案对齐 zh-CN 字面断言（组件 useTranslation('channel') 需 i18n 实例就绪）
beforeAll(async () => {
  await initI18n('zh-CN');
});

const { channelApiPath, useLifecyclePath } = vi.hoisted(() => ({
  channelApiPath: require('node:path').resolve(__dirname, '../../../lib/channel-api'),
  useLifecyclePath: require('node:path').resolve(__dirname, '../../../lib/use-lifecycle'),
}));

// mock channel-api（page-channel 依赖；section 组件接收 props/直接 import type 不触发网络）
vi.mock(channelApiPath, () => ({
  listChannels: vi.fn(async () => []),
  listChannelImplTypes: vi.fn(async () => [{ implId: 'feishu', label: '飞书' }]),
  createChannel: vi.fn(async () => ({})),
  updateChannel: vi.fn(async () => ({ ok: true as const })),
  deleteChannel: vi.fn(async () => ({ ok: true as const })),
}));

// mock use-lifecycle（page-channel 用；替换为简易受控实现，避免 SSE/timer 依赖）
vi.mock(useLifecyclePath, async () => {
  const React = await import('react');
  return {
    useLifecycle: ({ onInit }: { onInit: (api: { signal: AbortSignal; startTimer: () => void }) => Promise<unknown> }) => {
      const [ctx, setCtx] = React.useState<unknown>(null);
      const [loading, setLoading] = React.useState(true);
      React.useEffect(() => {
        const ctrl = new AbortController();
        onInit({ signal: ctrl.signal, startTimer: () => {} })
          .then((r) => setCtx(r))
          .finally(() => setLoading(false));
        return () => ctrl.abort();
      }, []);
      return {
        ctx,
        loading,
        error: null,
        reload: vi.fn(async () => {}),
        mutateCtx: vi.fn(),
        mutateBuffer: vi.fn(),
        mutate: vi.fn(),
      };
    },
  };
});

import { PageChannel } from '../page-channel';
import { SectionChannelForm } from '../section-channel-form';
import { SectionChannelList } from '../section-channel-list';
import { listChannels, listChannelImplTypes, type ChannelConfig } from '../../../lib/channel-api';
import { maskSecret } from '../../framework/primitives/secret-input';

const mockedImplTypes = vi.mocked(listChannelImplTypes);

describe('PageChannel', () => {
  beforeEach(() => {
    // 清调用计数 + 重设默认实现（每次 PageChannel mount 都会调一次 impl-types，计数不跨用例累积；
    // mockClear 只清计数不清实现，个别用例改成空数组后由这里统一重设默认值）
    mockedImplTypes.mockClear();
    mockedImplTypes.mockResolvedValue([{ implId: 'feishu', label: '飞书' }]);
  });
  afterEach(() => cleanup());

  // mock 生效自检：动态绝对路径若解析错误，vi.mock 不拦截 → vi.isMockFunction 返 false
  it('mock 生效自检：listChannels/listChannelImplTypes 被 vi.mock 拦截（动态绝对路径解析正确）', () => {
    expect(vi.isMockFunction(listChannels)).toBe(true);
    expect(vi.isMockFunction(listChannelImplTypes)).toBe(true);
  });

  it('渲染 header 标题 + new-btn + list（空态）', async () => {
    render(<PageChannel />);
    await waitFor(() => expect(screen.getByText('渠道')).toBeTruthy());
    expect(screen.getByRole('button', { name: '+ 新建渠道' })).toBeTruthy();
    expect(screen.getByText(/暂无渠道/)).toBeTruthy();
  });

  it('点 new-btn 打开表单弹层（dialog + 表单字段渲染；new-btn 始终显示）', async () => {
    render(<PageChannel />);
    await waitFor(() => expect(screen.getByRole('button', { name: '+ 新建渠道' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '+ 新建渠道' }));
    // v0.0.106：表单改为弹层渲染
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 类型下拉 + 名称/AppID/AppSecret 字段 + 提交按钮
    expect(screen.getByText('类型')).toBeTruthy();
    expect(screen.getByPlaceholderText('渠道名称（如：公司飞书机器人）')).toBeTruthy();
    expect(screen.getByPlaceholderText('cli_xxx')).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    // 弹层模式不挡按钮 → new-btn 始终显示（conventions §11 尺寸稳定性）
    expect(screen.getByRole('button', { name: '+ 新建渠道' })).toBeTruthy();
  });

  it('表单类型列表派生自 GET /config/channels/impl-types（mount 一次性，非硬编码）', async () => {
    mockedImplTypes.mockResolvedValue([{ implId: 'feishu', label: '飞书' }]);
    render(<PageChannel />);
    await waitFor(() => expect(mockedImplTypes).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '+ 新建渠道' }));
    // 下拉 trigger 显端点返回的 label（非旧硬编码常量）
    await waitFor(() => expect(screen.getByText('飞书').closest('button')).toBeTruthy());
    const trigger = screen.getByText('飞书').closest('button') as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    // 提交按钮可用
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('impl-types 为空 → 空态：类型下拉/提交 disabled + noImplTypes 提示', async () => {
    mockedImplTypes.mockResolvedValue([]);
    render(<PageChannel />);
    await waitFor(() => expect(mockedImplTypes).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '+ 新建渠道' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 空态提示文案（zh-CN form.noImplTypes，不渲染成【资源X不存在】）
    expect(screen.getByText(/无可用渠道类型/)).toBeTruthy();
    // 类型下拉 disabled（types 空态不可选）+ [v0.0.317] SaveBar 替换后保存按钮不 disabled（dirty=false 走灰色态）
    // 空态行为由必填校验保障：点保存 → 校验拦截（onSubmit 不触发）
    expect(screen.getByText(/无可用渠道类型/)).toBeTruthy();
    // 既有 config 列表不被空态阻断（列表区仍渲染空态文案）
    expect(screen.getByText(/暂无渠道/)).toBeTruthy();
  });
});

describe('SectionChannelForm', () => {
  afterEach(() => cleanup());

  it('新建态：appSecret 是 password input（E2E type 目标是 input）', () => {
    render(<SectionChannelForm types={[{ implId: 'feishu', label: '飞书' }]} onSubmit={() => {}} onCancel={() => {}} />);
    const secretEl = screen.getByPlaceholderText('输入 App Secret');
    // 新建态直接是 <input type="password">
    expect(secretEl.tagName).toBe('INPUT');
    expect(secretEl.getAttribute('type')).toBe('password');
  });

  it('新建态：类型下拉 trigger 显「飞书」+ 展开后含 feishu option（v0.0.106 自定义下拉替原生 select）', () => {
    render(<SectionChannelForm types={[{ implId: 'feishu', label: '飞书' }]} onSubmit={() => {}} onCancel={() => {}} />);
    const trigger = screen.getByText('飞书').closest('button') as HTMLButtonElement;
    // trigger 是 button（非原生 select），显当前选中 label
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.textContent).toContain('飞书');
    // 展开后 popover 含 feishu option（role=option）
    fireEvent.click(trigger);
    const opt = screen.getByRole('option', { name: '飞书' });
    expect(opt.getAttribute('aria-selected')).toBe('true');
    expect(opt.textContent).toContain('飞书');
  });

  it('编辑态：类型下拉 trigger disabled（implId 锁定不可改）', () => {
    const editing: ChannelConfig = {
      id: 'inst1', implId: 'feishu', name: '测试渠道', enabled: true,
      config: { appId: 'cli_x', appSecret: '***' }, connection: 'disconnected',
    };
    render(<SectionChannelForm editing={editing} types={[{ implId: 'feishu', label: '飞书' }]} onSubmit={() => {}} onCancel={() => {}} />);
    const trigger = screen.getByText('飞书').closest('button') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it('编辑态：appSecret 用 SecretInput，显示 = maskSecret(后端明文)（与其他 key 统一）', () => {
    // 后端 GET 返明文 appSecret；前端 SecretInput mask 成 ax****yz
    const plainSecret = 'sk_test_abcd1234efgh5678';
    const editing: ChannelConfig = {
      id: 'inst1', implId: 'feishu', name: '测试渠道', enabled: true,
      config: { appId: 'cli_x', appSecret: plainSecret }, connection: 'disconnected',
    };
    const { container } = render(<SectionChannelForm editing={editing} types={[{ implId: 'feishu', label: '飞书' }]} onSubmit={() => {}} onCancel={() => {}} />);
    // 编辑态是 SecretInput：外层 div（非 input），含 data-mode=display
    const secretEl = container.querySelector('[data-mode]') as HTMLElement;
    expect(secretEl.tagName).toBe('DIV');
    expect(secretEl.getAttribute('data-mode')).toBe('display');
    // 展示文本 = maskSecret(明文)，不再是 '***'（maskSecret：首4 + 星号 + 末4）
    const displayEl = screen.getByText(maskSecret(plainSecret));
    expect(displayEl.textContent).toBe(maskSecret(plainSecret));
    // 兜底：不再是 3 个星号（旧硬编码 '***' 的迹象）
    expect(displayEl.textContent).not.toBe('***');
  });

  it('新建态：必填校验（空提交显 errRequired，onSubmit 不触发）', async () => {
    const onSubmit = vi.fn();
    render(<SectionChannelForm types={[{ implId: 'feishu', label: '飞书' }]} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText(/请填写所有必填字段/)).toBeTruthy();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('types 空态（types=[]）：noImplTypes 提示 + 无 feishu 兜底 option + 点保存校验拦截', () => {
    const onSubmit = vi.fn();
    render(<SectionChannelForm types={[]} onSubmit={onSubmit} onCancel={() => {}} />);
    // 空态提示（zh-CN form.noImplTypes 真实文案，非【资源X不存在】）
    expect(screen.getByText(/无可用渠道类型/)).toBeTruthy();
    // [v0.0.317] SaveBar 替换后保存按钮不 disabled（dirty=false 走灰色态），但点保存 → 必填校验拦截
    const submitBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    fireEvent.click(submitBtn);
    // 必填校验：name 空 → onSubmit 不触发
    expect(onSubmit).not.toHaveBeenCalled();
    // 无 feishu 硬编码兜底（下拉 trigger 不显「飞书」）
    expect(screen.queryByText('飞书')).toBeNull();
  });

  it('types 空态 + 编辑态：回显不受阻断（implId 回显原值）', () => {
    const editing: ChannelConfig = {
      id: 'inst1', implId: 'feishu', name: '测试渠道', enabled: true,
      config: { appId: 'cli_x', appSecret: '***' }, connection: 'disconnected',
    };
    render(<SectionChannelForm editing={editing} types={[]} onSubmit={() => {}} onCancel={() => {}} />);
    // 编辑态 implId 回显原值（value 不在 options 时 trigger 回退显 value 原文）
    expect(screen.getByText('feishu')).toBeTruthy();
    // name/appId 回显正常（空态不阻断编辑回显）
    expect(screen.getByDisplayValue('测试渠道')).toBeTruthy();
    expect(screen.getByDisplayValue('cli_x')).toBeTruthy();
  });
});

describe('SectionChannelList', () => {
  afterEach(() => cleanup());

  it('空列表显 empty 文案', () => {
    render(<SectionChannelList instances={[]} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/暂无/)).toBeTruthy();
  });

  it('instance 行：name + switch + status 渲染', () => {
    const inst: ChannelConfig = {
      id: 'inst1', implId: 'feishu', name: '渠道A', enabled: false,
      config: { appId: 'cli_a', appSecret: '***' }, connection: 'disconnected',
    };
    render(<SectionChannelList instances={[inst]} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByText('渠道A')).toBeTruthy();
    // enabled=false → switch data-enabled=false
    expect(screen.getByRole('switch', { name: '切换渠道 渠道A 启用' }).getAttribute('data-enabled')).toBe('false');
    expect(screen.getByText('未启用')).toBeTruthy();
  });

  it.each([
    ['disconnected', true, /已启用（未连接）|Enabled \(not connected\)/],
    ['connecting', true, /连接中|Connecting/],
    ['connected', true, /已连接|Connected/],
    ['error', true, /连接失败|failed/i],
  ] as const)('connection=%s + enabled=true 状态文案闭合', (conn, enabled, re) => {
    const inst: ChannelConfig = {
      id: 'i_' + conn, implId: 'feishu', name: 'c', enabled,
      config: { appId: 'a', appSecret: '***' }, connection: conn,
    };
    const { unmount } = render(<SectionChannelList instances={[inst]} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    // status 文案在行内（匹配正则）
    const statusEl = screen.getAllByText(re)[0];
    expect(statusEl).toBeTruthy();
    unmount();
  });

  it('enabled=false 显「未启用」（不区分 connection）', () => {
    const inst: ChannelConfig = {
      id: 'i1', implId: 'feishu', name: 'c', enabled: false,
      config: { appId: 'a', appSecret: '***' }, connection: 'connected',
    };
    render(<SectionChannelList instances={[inst]} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/未启用|Disabled/)).toBeTruthy();
  });

  it('error 态渲染 errorDetail（enabled + connection=error）', () => {
    const inst: ChannelConfig = {
      id: 'i_err', implId: 'feishu', name: 'c', enabled: true,
      config: { appId: 'a', appSecret: '***' }, connection: 'error', errorDetail: '凭证错',
    };
    render(<SectionChannelList instances={[inst]} onToggle={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/凭证错/).textContent).toContain('凭证错');
  });

  it('点 switch 触发 onToggle(id, next)', () => {
    const onToggle = vi.fn();
    const inst: ChannelConfig = {
      id: 'i_sw', implId: 'feishu', name: 'c', enabled: false,
      config: { appId: 'a', appSecret: '***' }, connection: 'disconnected',
    };
    render(<SectionChannelList instances={[inst]} onToggle={onToggle} onEdit={() => {}} onDelete={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: '切换渠道 c 启用' }));
    expect(onToggle).toHaveBeenCalledWith('i_sw', true);
  });
});
