/**
 * @vitest-environment jsdom
 * section-observability 单测（v0.0.199）— detail 视图态上报 onDetailViewChange。
 * 参考 specs/ui/components/app-dev-config-page/observability-config/_overview.md §3
 *
 * 修复的 bug：tab-panel 不感知 SectionObservability 进入 detail，导致 detail 下滚看到 logs group。
 * 修复方式：SectionObservability 在 detail 态切换时同步调 onDetailViewChange(inDetail)。
 *
 * 校验点：
 *   - list 态初始渲染不触发 onDetailViewChange(true)
 *   - 点列表项进 detail → onDetailViewChange(true) 同步触发
 *   - 点「添加配置」进 detail（新增）→ onDetailViewChange(true)
 *   - detail 内点 breadcrumb 返回 → onDetailViewChange(false)
 *
 * vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// vi.mock 工厂被 hoist 到文件顶部，其依赖的路径 + mock 数据必须同样用 vi.hoisted 提升，
// 否则工厂执行时引用未初始化的顶层变量（ReferenceError: Cannot access before initialization）。
const { observabilityApiPath, mockBaseCfg } = vi.hoisted(() => {
  const path = require('node:path');
  return {
    observabilityApiPath: path.resolve(__dirname, '../../../../lib/observability-api'),
    mockBaseCfg: {
      id: 'obs_1',
      name: 'Production Tracing',
      type: 'langfuse' as const,
      baseUrl: 'https://cloud.langfuse.com',
      publicKey: 'pk-lf-xxx',
      secretKey: 'sk-lf-secret',
      enabled: true,
      desc: 'main',
      logPhysical: false,
    },
  };
});

// mock observability-api：list 返回 1 条配置；PUT 空实现
vi.mock(observabilityApiPath, () => ({
  getObservabilityConfigs: vi.fn().mockResolvedValue([mockBaseCfg]),
  putObservabilityConfigs: vi.fn().mockResolvedValue(undefined),
}));

import { SectionObservability } from '../section-observability';

describe('SectionObservability — detail 视图态上报 onDetailViewChange（v0.0.199）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('list 态初始渲染：不触发 onDetailViewChange(true)', async () => {
    const spy = vi.fn();
    render(<SectionObservability onDetailViewChange={spy} />);
    // 等 list 加载完
    await screen.findByText('Production Tracing');
    // 初始为 list 态，不应上报 true
    expect(spy).not.toHaveBeenCalledWith(true);
  });

  it('点列表项进 detail → onDetailViewChange(true) 同步触发', async () => {
    const spy = vi.fn();
    render(<SectionObservability onDetailViewChange={spy} />);
    // 等 list 加载完
    await screen.findByText('Production Tracing');
    // 点列表项（整卡 onClick，点 name span 冒泡触发）
    fireEvent.click(screen.getByText('Production Tracing'));
    expect(spy).toHaveBeenLastCalledWith(true);
  });

  it('detail 内点 breadcrumb 返回 → onDetailViewChange(false)', async () => {
    const spy = vi.fn();
    render(<SectionObservability onDetailViewChange={spy} />);
    await screen.findByText('Production Tracing');
    // 进 detail
    fireEvent.click(screen.getByText('Production Tracing'));
    expect(spy).toHaveBeenLastCalledWith(true);
    // 点 breadcrumb 返回（observability.breadcrumbRoot = 「可观测性」）
    fireEvent.click(screen.getByRole('button', { name: '可观测性' }));
    expect(spy).toHaveBeenLastCalledWith(false);
  });

  it('点「添加配置」进 detail（新增）→ onDetailViewChange(true)', async () => {
    const spy = vi.fn();
    render(<SectionObservability onDetailViewChange={spy} />);
    await screen.findByText('Production Tracing');
    // 点「添加配置」卡（list 底部的 dashed add-card 按钮，addTitle = 「添加配置」）
    const addBtn = screen.getByRole('button', { name: /添加配置/ });
    fireEvent.click(addBtn);
    await waitFor(() => {
      expect(spy).toHaveBeenLastCalledWith(true);
    });
  });

  it('未传 onDetailViewChange 时：进/出 detail 不报错（向后兼容）', async () => {
    render(<SectionObservability />);
    await screen.findByText('Production Tracing');
    // 不传 callback，点列表项不应抛错
    expect(() => fireEvent.click(screen.getByText('Production Tracing'))).not.toThrow();
  });
});
