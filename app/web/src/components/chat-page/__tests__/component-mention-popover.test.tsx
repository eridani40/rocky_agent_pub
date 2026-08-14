/**
 * @vitest-environment jsdom
 * component-mention-popover 单测（v0.0.346-2 追加问题 4）
 * 参考: specs/ui/components/chat-page/mention-popover.md
 *       specs/tech/version_logs/v0.0.346/change_plan.md（追加问题 4：popover 行）
 *
 * 覆盖（追加问题 4 验收 13-16 / UC-14/15/16）：
 *   - file 目录条目：FolderIcon（gold text-gold）+ 根路径 subtitle '/' 始终展示（UC-14/15）
 *   - file 文件条目：FileIcon（muted text-muted）+ dirname 路径展示（UC-14/16）
 *   - 非 file provider（skill/member）item 无 isDir：不渲染 icon、不崩溃，保持现状
 *   - subtitle 始终渲染：file provider 根路径 '/' 不再空缺
 *
 * mock 策略：真实组件（走 fetch），mock globalThis.fetch 拦截 /mention/search
 * （bun 下 vi.mock 拦不住模块导入 —— group memory bun-vitest-vi-mock-module-cache-di-fallback）。
 */
import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MentionPopover, type MentionItem } from '../component-mention-popover';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
  // jsdom 缺 scrollIntoView（popover focusIndex 滚动 effect 调用）——polyfill 防 uncaught
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 模拟 fetch 响应（/mention/search） */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** 默认 fetch 实现：/mention/search → 空结果 */
function defaultFetch(_url: string | URL | Request, _init?: RequestInit): Promise<Response> {
  return Promise.resolve(jsonResponse(200, { items: [], nextCursor: undefined }));
}

/** 构造 file 类型 MentionItem（isDir 单独参数；文件条目缺省 isDir，不写 false） */
function fileItem(path: string, isDir = false): MentionItem {
  const name = path.split('/').pop()!;
  const dirPart = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/';
  return {
    type: 'file',
    path,
    ...(isDir ? { isDir: true } : {}),
    display: { icon: 'file', label: name },
    listView: {
      title: name,
      subtitle: isDir && !path.includes('/') ? '/' : dirPart,
      icon: isDir ? 'folder' : 'file',
    },
  };
}

/** 渲染 popover 并等待 fetch 返回（debounce 200ms + 异步 resolve） */
async function renderPopover(items: MentionItem[]): Promise<HTMLElement> {
  const fetchMock = vi.fn((url: string | URL | Request) =>
    Promise.resolve(jsonResponse(200, { items, nextCursor: undefined })),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(
    <MentionPopover
      providers={[
        { name: 'file', label: 'Files' },
        { name: 'skill', label: 'Skills' },
      ]}
      query="auth"
      sessionId="s1"
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  // 等待 debounce + fetch + setState 落定
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(container.querySelector('[data-action-key="chat.mention.select"]')).toBeTruthy();
  });
  return container;
}

describe('MentionPopover（v0.0.346-2 item icon 区分 + 路径始终展示）', () => {
  it('目录条目渲染 FolderIcon（gold）+ 根路径 subtitle "/"', async () => {
    const container = await renderPopover([
      fileItem('src', true),
    ]);
    // 目录 icon：FolderIcon 渲染（data-testid mention-item-icon-dir）+ gold 色
    const icon = container.querySelector('[data-testid="mention-item-icon-dir"]')!;
    expect(icon).toBeTruthy();
    expect(icon.querySelector('svg')).toBeTruthy();
    expect(icon.className).toContain('text-gold');
    // 根路径 subtitle '/' 始终展示（不再空缺）
    expect(container.textContent).toContain('/');
  });

  it('文件条目渲染 FileIcon（muted）+ dirname 路径', async () => {
    const container = await renderPopover([
      fileItem('src/utils/helper.ts'),
    ]);
    // 文件 icon：FileIcon 渲染（data-testid mention-item-icon-file）+ muted 色
    const icon = container.querySelector('[data-testid="mention-item-icon-file"]')!;
    expect(icon).toBeTruthy();
    expect(icon.querySelector('svg')).toBeTruthy();
    expect(icon.className).toContain('text-muted');
    // 下排路径 = dirname（非根）
    expect(container.textContent).toContain('src/utils');
  });

  it('根目录文件 subtitle 显示 "/"（根路径始终展示，UC-15）', async () => {
    const container = await renderPopover([
      fileItem('README.md'),
    ]);
    const icon = container.querySelector('[data-testid="mention-item-icon-file"]')!;
    expect(icon).toBeTruthy();
    // 根路径文件：subtitle '/' 渲染（之前是 undefined 空缺）
    expect(container.textContent).toContain('/');
  });

  it('非 file provider item 无 isDir 不崩溃、不渲染 icon（保持现状）', async () => {
    // skill item：type='skill'、无 isDir、listView.icon='skill'
    const skillItem: MentionItem = {
      type: 'skill',
      path: '/skills/drama',
      display: { icon: 'skill', label: 'drama-script-writer' },
      listView: { title: 'drama-script-writer', subtitle: '编剧', icon: 'skill' },
    };
    const container = await renderPopover([skillItem]);
    // 非 file provider 不渲染 file 图标（保持现状：无 icon 纯文本）
    expect(container.querySelector('[data-testid^="mention-item-icon-"]')).toBeNull();
    // title 正常渲染 + 不崩溃
    expect(container.textContent).toContain('drama-script-writer');
    // subtitle 仍渲染（skill 有 description）
    expect(container.textContent).toContain('编剧');
  });

  it('非 file provider item 无 subtitle 不崩溃', async () => {
    // member item：无 subtitle
    const memberItem: MentionItem = {
      type: 'member',
      id: 'member-1',
      display: { icon: 'member', label: 'Alice' },
      listView: { title: 'Alice', icon: 'member' },
    };
    const container = await renderPopover([memberItem]);
    expect(container.textContent).toContain('Alice');
  });
});
