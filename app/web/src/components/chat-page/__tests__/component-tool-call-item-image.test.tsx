/**
 * @vitest-environment jsdom
 * component-tool-call-item 图片块渲染单测（P1 最小占位）
 * 参考: specs/ui/components/chat-page/_overview.md §4.9
 *
 * 覆盖：computer use get_app_state 的 tool_result content 含 image + text 双 block →
 *   image 渲染为缩略图 + click 切换展开；text 仍渲染。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentToolCallItem } from '../component-tool-call-item';
import type { ViewElement } from '../types';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

/** 构造带 image+text result 的 tool-call-item 视图元素（computer use get_app_state 形态） */
function imageCall(
  toolCallId: string,
  source: { kind: 'url'; url: string } | { kind: 'base64'; data: string },
): Extract<ViewElement, { kind: 'tool-call-item' }> {
  return {
    kind: 'tool-call-item',
    key: `k-${toolCallId}`,
    messageId: 'm1',
    toolCallId,
    name: 'get_app_state',
    arguments: {},
    result: {
      isError: false,
      content: [
        { type: 'image', source, mediaType: 'image/png' },
        { type: 'text', text: 'ax tree text' },
      ],
    },
  };
}

describe('ComponentToolCallItem image 渲染', () => {
  it('base64 image → data URI src；展开后 text 与 image 均渲染', () => {
    render(<ComponentToolCallItem call={imageCall('c1', { kind: 'base64', data: 'PNGDATA' })} />);
    // 展开 body（点击 head 行工具名）
    fireEvent.click(screen.getByText('get_app_state'));

    const img = screen.getByAltText('tool result screenshot') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,PNGDATA');
    // text block 仍渲染
    expect(screen.getByText('ax tree text')).toBeTruthy();
  });

  it('url image → 直接用 url 作 src', () => {
    render(
      <ComponentToolCallItem
        call={imageCall('c2', { kind: 'url', url: 'https://ex.com/s.png' })}
      />,
    );
    fireEvent.click(screen.getByText('get_app_state'));
    const img = screen.getByAltText('tool result screenshot') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://ex.com/s.png');
  });

  it('click image 切换展开（max-h-24 缩略 ↔ max-w-full 全宽）', () => {
    render(<ComponentToolCallItem call={imageCall('c3', { kind: 'base64', data: 'X' })} />);
    fireEvent.click(screen.getByText('get_app_state'));
    const img = screen.getByAltText('tool result screenshot');
    // 默认缩略
    expect(img.className).toContain('max-h-24');
    fireEvent.click(img);
    // 展开全宽
    expect(img.className).toContain('max-w-full');
  });
});
