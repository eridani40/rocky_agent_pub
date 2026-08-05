// @vitest-environment jsdom
/**
 * component-feishu-setup-doc 单测（v0.0.145；v0.0.145 修订：可折叠默认收起）
 * 参考: specs/ui/components/channel-page/component-feishu-setup-doc.md
 *
 * 校验点：
 *  - **默认收起**（初始 open=false）：正文区不挂载 DOM
 *  - 点击 toggle 行展开：正文区出现（含 PrimitiveMarkdownView 产出的 h1/ol/blockquote/a）
 *  - 再点击 toggle 收起：正文区再次消失
 *  - md 内容中文在上（h1 = 「在飞书开放平台创建机器人」），英文在下
 *  - 链接 target=_blank rel=noreferrer 可点击
 *  - i18n key（setupDoc.title / setupDoc.desc）渲染（不渲染成【资源X不存在】）
 *  - 展开后正文区 max-h + overflow-y-auto 类（固定高度独立滚动）
 *  - toggle 行带 aria-expanded 状态切换（可访问性）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ComponentFeishuSetupDoc } from '../component-feishu-setup-doc';

afterEach(() => cleanup());

describe('ComponentFeishuSetupDoc（v0.0.145 可折叠修订）', () => {
  beforeAll(async () => {
    await initI18n('zh-CN');
  });

  /** toggle 行：role=button + aria-expanded，含「接入说明」文案 */
  function getToggle() {
    return screen.getByText('接入说明').closest('[role="button"]') as HTMLElement;
  }

  it('渲染 toggle 触发器（role=button）', () => {
    render(<ComponentFeishuSetupDoc />);
    expect(getToggle()).toBeTruthy();
  });

  it('默认收起：正文区 body 不在 DOM 中', () => {
    render(<ComponentFeishuSetupDoc />);
    expect(screen.queryByText('在飞书开放平台创建机器人')).toBeNull();
  });

  it('默认收起：toggle 行 aria-expanded=false', () => {
    render(<ComponentFeishuSetupDoc />);
    expect(getToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('i18n 标题/desc 在 toggle 行渲染（zh-CN：title="接入说明"）', () => {
    render(<ComponentFeishuSetupDoc />);
    expect(screen.getByText('接入说明')).toBeTruthy();
    expect(screen.getByText(/如何在飞书开放平台创建并配置机器人/)).toBeTruthy();
  });

  it('点击 toggle 展开：正文区 body 出现，aria-expanded=true', () => {
    render(<ComponentFeishuSetupDoc />);
    const toggle = getToggle();
    // 收起态断言
    expect(screen.queryByText('在飞书开放平台创建机器人')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 点击展开
    fireEvent.click(toggle);
    expect(screen.getByText('在飞书开放平台创建机器人')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('再点击 toggle 收起：正文区 body 消失，aria-expanded=false', () => {
    render(<ComponentFeishuSetupDoc />);
    const toggle = getToggle();
    // 展开
    fireEvent.click(toggle);
    expect(screen.getByText('在飞书开放平台创建机器人')).toBeTruthy();
    // 收起
    fireEvent.click(toggle);
    expect(screen.queryByText('在飞书开放平台创建机器人')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('键盘 Enter/Space 也能切换展开（可访问性）', () => {
    render(<ComponentFeishuSetupDoc />);
    const toggle = getToggle();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(screen.getByText('在飞书开放平台创建机器人')).toBeTruthy();
    fireEvent.keyDown(toggle, { key: ' ' });
    expect(screen.queryByText('在飞书开放平台创建机器人')).toBeNull();
  });

  it('展开后 md 内容渲染：中文 h1 在最前（"在飞书开放平台创建机器人"）', () => {
    const { container } = render(<ComponentFeishuSetupDoc />);
    fireEvent.click(getToggle());
    const h1s = Array.from(container.querySelectorAll('h1'));
    expect(h1s.length).toBeGreaterThanOrEqual(2); // 中文 + 英文
    expect(h1s[0]?.textContent).toBe('在飞书开放平台创建机器人');
    // 英文标题在中文之后
    expect(h1s.some((h) => h.textContent === 'Create a Bot on the Feishu Open Platform')).toBe(true);
  });

  it('展开后 md 内含有序列表与引用块', () => {
    const { container } = render(<ComponentFeishuSetupDoc />);
    fireEvent.click(getToggle());
    // 多个 <ol>（中文步骤 + 英文 steps，至少 2 个）
    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBeGreaterThanOrEqual(2);
    // 引用块（中英文各有）
    const bqs = container.querySelectorAll('blockquote');
    expect(bqs.length).toBeGreaterThanOrEqual(2);
  });

  it('展开后链接 target=_blank rel=noreferrer，href 指向 open.feishu.cn', () => {
    const { container } = render(<ComponentFeishuSetupDoc />);
    fireEvent.click(getToggle());
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noreferrer');
      expect(a.getAttribute('href')).toBe('https://open.feishu.cn/');
    }
  });

  it('展开后正文区有 max-h + overflow-y-auto 类（固定高度独立滚动）', () => {
    const { container } = render(<ComponentFeishuSetupDoc />);
    fireEvent.click(getToggle());
    // 正文区 = 含 h1 的 max-h 容器
    const body = container.querySelector('.max-h-\\[') ??
      Array.from(container.querySelectorAll('div')).find((d) => d.className.includes('max-h-[') && d.className.includes('overflow-y-auto'));
    expect(body).toBeTruthy();
    expect(body!.className).toContain('overflow-y-auto');
  });
});
