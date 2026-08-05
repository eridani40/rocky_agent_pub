/**
 * @vitest-environment jsdom
 * component-market-item 单测（U7 市场卡部分）：三态渲染 + 能力门控安装量。
 * 参考: specs/ui/components/skill-page/component-market-item.md；PRD §4。
 *
 * 覆盖：installable→安装按钮 / installing→disabled 安装中 / installed→已安装 badge；
 * showInstalls 门控安装量渲染；点卡 onOpenDetail、点安装 stopPropagation onInstall。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentMarketItem } from '../component-market-item';
import type { MarketItem } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => { await initI18n('zh-CN'); });
afterEach(() => cleanup());

const REF = 'anthropics/skills/pdf';
function mkItem(over: Partial<MarketItem> = {}): MarketItem {
  return { ref: REF, name: 'pdf', stats: { installs: 1200 }, ...over };
}

function renderItem(props: Partial<React.ComponentProps<typeof ComponentMarketItem>> = {}) {
  const onOpenDetail = vi.fn();
  const onInstall = vi.fn();
  render(
    <ComponentMarketItem
      item={mkItem()}
      status="installable"
      showInstalls
      onOpenDetail={onOpenDetail}
      onInstall={onInstall}
      {...props}
    />,
  );
  return { onOpenDetail, onInstall };
}

describe('ComponentMarketItem — 状态区三态', () => {
  it('installable → 渲染安装按钮（非 disabled），无已安装 badge', () => {
    renderItem({ status: 'installable' });
    const btn = screen.getByRole('button', { name: '安装' });
    expect(btn).toBeTruthy();
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('已安装')).toBeNull();
  });

  it('installing → 安装按钮 disabled', () => {
    renderItem({ status: 'installing' });
    const btn = screen.getByRole('button', { name: '安装中…' });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('installed → 渲染已安装 badge，无安装按钮', () => {
    renderItem({ status: 'installed' });
    expect(screen.getByText('已安装')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull();
  });
});

describe('ComponentMarketItem — 能力门控 + 交互', () => {
  it('showInstalls=true 且 stats.installs 存在 → 渲染安装量', () => {
    renderItem({ showInstalls: true });
    expect(screen.getByText(/次安装/)).toBeTruthy();
  });

  it('showInstalls=false → 不渲染安装量（能力门控）', () => {
    renderItem({ showInstalls: false });
    expect(screen.queryByText(/次安装/)).toBeNull();
  });

  it('showInstalls=true 但 stats.installs 缺失 → 不渲染安装量', () => {
    renderItem({ showInstalls: true, item: mkItem({ stats: undefined }) });
    expect(screen.queryByText(/次安装/)).toBeNull();
  });

  it('点卡片 → onOpenDetail(ref)；点安装按钮 → onInstall(ref) 且不触发 onOpenDetail', () => {
    const { onOpenDetail, onInstall } = renderItem({ status: 'installable' });
    // 点名称区域（卡片可点部分）
    fireEvent.click(screen.getByText('pdf'));
    expect(onOpenDetail).toHaveBeenCalledWith(REF);
    onOpenDetail.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith(REF);
    expect(onOpenDetail).not.toHaveBeenCalled();
  });
});
