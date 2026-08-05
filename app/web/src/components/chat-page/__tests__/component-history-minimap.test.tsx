/**
 * @vitest-environment jsdom
 * component-history-minimap 交互单测（v0.0.172.ui_fix）
 * 参考: specs/ui/components/chat-page/component-history-minimap.md §4（点击跳转 footprint 任意位置命中）
 *
 * 覆盖：
 *   - bars 空 → 不渲染（null）
 *   - 区域内点击（hoverIndex 非 null）→ 跳转当前 hover bar 的 messageId（id 锚点 msg-{id}）
 *   - 未 hover（hoverIndex == null）时点击 → 不跳转（no-op）
 *   - 切换 hover 目标 → 点击命中切换后的 bar
 *   - onMouseLeave 清空 hoverIndex → 后续点击不再跳转
 *   - 悬停预览气泡渲染 query/answer
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentHistoryMinimap } from '../component-history-minimap';
import type { MinimapBar } from '../minimap-bars';
import { initI18n } from '../../../i18n';

// 启动 i18next：noReply 占位文案 chat:minimap.noReply
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom 未实现 scrollIntoView，mock 之
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

/** 构造 N 条 bar 列表（messageId=u1..uN） */
function makeBars(n: number): MinimapBar[] {
  const bars: MinimapBar[] = [];
  for (let i = 1; i <= n; i++) {
    bars.push({ messageId: `u${i}`, query: `问题${i}`, preview: `回答${i}` });
  }
  return bars;
}

/** mock getElementById 捕获跳转目标 id（验证 jumpTo 按 `msg-${messageId}` 约定定位）。
 *  返回一个含 scrollIntoView mock 的 fake element，使生产代码 `el?.scrollIntoView(...)` 触发 mock。
 */
function setupGetElementByIdSpy() {
  const queried: string[] = [];
  const fakeEl = document.createElement('div'); // 真实 DOM 元素，已继承 scrollIntoView mock
  const spy = vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
    queried.push(id);
    return fakeEl;
  });
  return { queried, spy };
}

describe('ComponentHistoryMinimap — bars 空不渲染', () => {
  it('bars=[] → 返回 null（无 minimap 节点）', () => {
    const { container } = render(
      <ComponentHistoryMinimap bars={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('ComponentHistoryMinimap — footprint 任意位置点击命中（v0.0.172.ui_fix 核心）', () => {
  it('hover 某 bar 后点击 footprint 内非 bar 元素 → 跳转到 hover 的 bar（非点击位置 bar）', () => {
    const bars = makeBars(5);
    const { queried } = setupGetElementByIdSpy();
    const { container } = render(
      <ComponentHistoryMinimap bars={bars} />,
    );
    const footprint = container.firstChild as HTMLElement;

    // hover bar index=2（u3）；bar 以 aria-label=query 语义定位
    fireEvent.mouseEnter(screen.getByRole('button', { name: '问题3' }));
    // 点击 footprint 根容器（非 bar 本身——证明命中区扩大到整个 footprint）
    fireEvent.click(footprint);

    // 跳转目标 = msg-u3（当前 hoverIndex 指向的 bar），不是点击位置 bar
    expect(queried).toContain('msg-u3');
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('未 hover 任何 bar（hoverIndex=null）→ 点击 footprint 不跳转（no-op）', () => {
    const bars = makeBars(3);
    const { queried } = setupGetElementByIdSpy();
    const { container } = render(
      <ComponentHistoryMinimap bars={bars} />,
    );
    const footprint = container.firstChild as HTMLElement;

    // 未 hover 直接点击 footprint
    fireEvent.click(footprint);

    // 无跳转查询（hoverIndex=null → handleFootprintClick early return）
    expect(queried).toEqual([]);
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('切换 hover 目标 → 点击命中切换后的 bar', () => {
    const bars = makeBars(4);
    const { queried } = setupGetElementByIdSpy();
    const { container } = render(
      <ComponentHistoryMinimap bars={bars} />,
    );
    const footprint = container.firstChild as HTMLElement;

    // 先 hover u1，再切到 u4，再点击 footprint → 命中 u4
    fireEvent.mouseEnter(screen.getByRole('button', { name: '问题1' }));
    fireEvent.mouseEnter(screen.getByRole('button', { name: '问题4' }));
    fireEvent.click(footprint);

    expect(queried).toContain('msg-u4');
    expect(queried).not.toContain('msg-u1');
  });

  it('onMouseLeave 清空 hoverIndex → 离开后点击不跳转', () => {
    const bars = makeBars(3);
    const { queried } = setupGetElementByIdSpy();
    const { container } = render(
      <ComponentHistoryMinimap bars={bars} />,
    );
    const footprint = container.firstChild as HTMLElement;

    // hover → mouseLeave → 点击 → 无跳转
    fireEvent.mouseEnter(screen.getByRole('button', { name: '问题2' }));
    fireEvent.mouseLeave(footprint);
    fireEvent.click(footprint);

    expect(queried).toEqual([]);
  });

  it('hover bar 渲染预览气泡 + query/answer 文本', () => {
    const bars = makeBars(2);
    render(
      <ComponentHistoryMinimap bars={bars} />,
    );

    // 未 hover：无预览气泡文本
    expect(screen.queryByText('问题1')).toBeNull();

    // hover u1 → preview 出现（query + answer 文本）
    fireEvent.mouseEnter(screen.getByRole('button', { name: '问题1' }));
    expect(screen.getByText('问题1')).toBeTruthy();
    expect(screen.getByText('回答1')).toBeTruthy();
  });
});
