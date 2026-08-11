// @vitest-environment jsdom
/**
 * section-preview-area 容器单测（v0.0.320 D3；[老板试玩] 修复1/2/6；[老板第三批] 删右条+悬浮按钮+收起展开+自动展开）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D3（预览区容器 + Provider 契约）
 *
 * [老板第三批补充] collapsed 下移到 hook 层；收起态 openTab/activateTab → 自动展开。
 *
 * mock 策略：ContextProvider wrapper 用 React state 模拟真实 collapsed 行为（setCollapsed 更新 context）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { useState, type ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SectionPreviewArea, pvLsKey, readPvWidth, writePvWidth } from '../section-preview-area';
import { PreviewAreaContext, type PreviewAreaContextValue } from '../preview-area-context';
import type { DoorState } from '../use-preview-collapsed';
import { ComponentPreviewDirtyModal } from '../component-preview-dirty-modal';
import { ComponentPreviewViewer } from '../component-preview-viewer';
import { PV_WIDTH_DEFAULT, PV_WIDTH_MIN, PV_WIDTH_MAX } from '../../../lib/layout-width-engine';
import type { PreviewTab } from '../preview-tabs-types';

/** 构造 mock context value（tabs 可控） */
function mkCtx(over: Partial<PreviewAreaContextValue> & { tabs?: PreviewTab[] } = {}): PreviewAreaContextValue {
  return {
    openTab: vi.fn(),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    tabs: over.tabs ?? [],
    activeTabId: over.activeTabId ?? null,
    sessionId: 's1',
    dirtyPending: null,
    conflictPending: null,
    collapsed: over.collapsed ?? false,
    setCollapsed: over.setCollapsed ?? vi.fn(),
    door: over.door ?? 'center',
    setDoor: over.setDoor ?? vi.fn(),
    saveTab: vi.fn(),
    resolveDirty: vi.fn(),
    resolveConflict: vi.fn(),
    setDraft: vi.fn(),
    setMode: vi.fn(),
    retryLoad: vi.fn(),
    ...over,
  };
}

/**
 * 可更新 collapsed/door 的 Context Provider wrapper——模拟真实 hook（use-preview-collapsed）行为：
 * collapsed 派生自 door（collapsed = door !== 'center'）；setCollapsed(v) 桥接 setDoor(v?'right':'center')。
 */
function CtxProvider({ children, ctx }: { children: ReactNode; ctx: PreviewAreaContextValue }) {
  const [door, setDoorState] = useState(ctx.door);
  const setDoor = (v: DoorState) => {
    ctx.setDoor(v);
    setDoorState(v);
  };
  const collapsed = door !== 'center';
  const setCollapsed = (v: boolean) => setDoor(v ? 'right' : 'center');
  const value: PreviewAreaContextValue = {
    ...ctx,
    collapsed,
    setCollapsed,
    door,
    setDoor,
  };
  return <PreviewAreaContext.Provider value={value}>{children}</PreviewAreaContext.Provider>;
}

/** 容器渲染包装：用 CtxProvider（可更新 collapsed） */
function renderArea(props: React.ComponentProps<typeof SectionPreviewArea>, ctx: PreviewAreaContextValue) {
  return render(
    <CtxProvider ctx={ctx}>
      <SectionPreviewArea {...props} />
    </CtxProvider>,
  );
}

/** 构造 loaded tab */
function mkTab(over: Partial<PreviewTab> = {}): PreviewTab {
  return {
    id: 'workspace:a.md',
    path: 'a.md',
    fileName: 'a.md',
    subtitle: 'a.md',
    source: 'workspace',
    format: 'md',
    version: 'v1',
    mode: 'view',
    dirty: false,
    content: '# hello',
    draft: '# hello',
    loadState: 'loaded',
    ...over,
  };
}

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '{}' }) as Response));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('localStorage 读写（per session key）', () => {
  it('pvLsKey 格式 pv-width-{sid}', () => {
    expect(pvLsKey('s1', 'width')).toBe('pv-width-s1');
  });

  it('readPvWidth 缺省 360；写入后读回；坏值兜底 clamp', () => {
    expect(readPvWidth('s1')).toBe(PV_WIDTH_DEFAULT);
    writePvWidth('s1', 500);
    expect(readPvWidth('s1')).toBe(500);
    writePvWidth('s1', 99999);
    expect(readPvWidth('s1')).toBe(PV_WIDTH_MAX);
    writePvWidth('s1', 10);
    expect(readPvWidth('s1')).toBe(PV_WIDTH_MIN);
  });

  it('[老板第三批③] collapsed=true → 容器渲染收起态（从 context 消费；[v0.0.329] 三态模型由 door=right 驱动）', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, door: 'right' }));
    expect(screen.queryByTestId('pv-panel')).toBeNull();
    expect(screen.getByTestId('pv-collapsed-rail')).toBeTruthy();
  });
});

describe('[老板试玩修复1] 预览区显示 = tabs.length > 0', () => {
  it('tabs 为空 → 返 null', () => {
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [] }));
    expect(screen.queryByTestId('pv-panel')).toBeNull();
  });

  it('tabs 有内容 → 渲染 pv-panel + TabBar', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    expect(screen.getByTestId('pv-panel')).toBeTruthy();
    expect(screen.getByTestId('pv-tabbar-scroll')).toBeTruthy();
    // [老板第三批④] 只有左分隔条
    expect(screen.getByTestId('pv-resize-left')).toBeTruthy();
    expect(screen.queryByTestId('pv-resize-right')).toBeNull();
  });
});

describe('[老板试玩修复2] 拖拽方向修正', () => {
  it('左分隔条 side=right → 拖左（dx<0）预览变宽', async () => {
    const onLayoutChange = vi.fn();
    const onDragModeChange = vi.fn();
    const tab = mkTab();
    renderArea(
      { sessionId: 's1', onLayoutChange, onDragModeChange },
      mkCtx({ tabs: [tab], activeTabId: tab.id }),
    );
    await waitFor(() => {
      expect(onLayoutChange).toHaveBeenCalledWith({ settingWidth: PV_WIDTH_DEFAULT, collapsed: false });
    });
    fireEvent.mouseDown(screen.getByTestId('pv-resize-left'), { clientX: 100 });
    expect(onDragModeChange).toHaveBeenLastCalledWith(true);
    fireEvent.mouseMove(window, { clientX: 0 });
    await waitFor(() => {
      expect(onLayoutChange).toHaveBeenLastCalledWith({ settingWidth: 460, collapsed: false });
    });
    fireEvent.mouseUp(window);
    expect(onDragModeChange).toHaveBeenLastCalledWith(false);
  });

  it('renderWidth prop 优先于内部 width', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1', renderWidth: 500 }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    expect(screen.getByTestId('pv-panel').style.width).toBe('500px');
  });
});

describe('[老板第三批②] 正文区悬浮操作按钮', () => {
  it('只读态：显示编辑按钮', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    expect(screen.getByTestId('pv-float-edit')).toBeTruthy();
    expect(screen.queryByTestId('pv-float-save')).toBeNull();
  });

  it('编辑态：显示保存+撤销', () => {
    const tab = mkTab({ mode: 'edit' });
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    expect(screen.getByTestId('pv-float-save')).toBeTruthy();
    expect(screen.getByTestId('pv-float-undo')).toBeTruthy();
    expect(screen.queryByTestId('pv-float-edit')).toBeNull();
  });

  it('点击编辑 → setMode edit', () => {
    const setMode = vi.fn();
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, setMode }));
    fireEvent.click(screen.getByTestId('pv-float-edit'));
    expect(setMode).toHaveBeenCalledWith(tab.id, 'edit');
  });

  it('点击撤销 → setMode view', () => {
    const setMode = vi.fn();
    const tab = mkTab({ mode: 'edit' });
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, setMode }));
    fireEvent.click(screen.getByTestId('pv-float-undo'));
    expect(setMode).toHaveBeenCalledWith(tab.id, 'view');
  });
});

describe('[老板第三批③] 收起/展开', () => {
  it('展开态：收起手柄图标 →（ChevronRight）', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    const btn = screen.getByTestId('pv-door-right');
    const path = btn.querySelector('svg path');
    expect(path?.getAttribute('d')).toBe('M9 18l6-6-6-6');
  });

  it('只读态点收起 → 预览区隐藏 + 展开手柄 ←（ChevronLeft）', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    fireEvent.click(screen.getByTestId('pv-door-right'));
    expect(screen.queryByTestId('pv-panel')).toBeNull();
    expect(screen.getByTestId('pv-collapsed-rail')).toBeTruthy();
    const path = screen.getByTestId('pv-collapse-expand').querySelector('svg path');
    expect(path?.getAttribute('d')).toBe('M15 18l-6-6 6-6');
  });

  it('收起态点展开 → 恢复预览区', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    fireEvent.click(screen.getByTestId('pv-door-right'));
    expect(screen.getByTestId('pv-collapsed-rail')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pv-collapse-expand'));
    expect(screen.getByTestId('pv-panel')).toBeTruthy();
    expect(screen.queryByTestId('pv-collapsed-rail')).toBeNull();
  });

  it('编辑态点收起 → 弹守卫 dirty modal', () => {
    const tab = mkTab({ mode: 'edit' });
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    fireEvent.click(screen.getByTestId('pv-door-right'));
    expect(screen.getByTestId('pv-dirty-modal')).toBeTruthy();
    expect(screen.getByTestId('pv-panel')).toBeTruthy();
  });

  it('编辑态守卫 → 取消 → 不收起', () => {
    const tab = mkTab({ mode: 'edit' });
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    fireEvent.click(screen.getByTestId('pv-door-right'));
    fireEvent.click(screen.getByTestId('pv-dirty-cancel'));
    expect(screen.getByTestId('pv-panel')).toBeTruthy();
  });

  it('编辑态守卫 → 放弃 → 收起', async () => {
    const setMode = vi.fn();
    const setDraft = vi.fn();
    const tab = mkTab({ mode: 'edit', draft: '# changed', content: '# hello' });
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, setMode, setDraft }));
    fireEvent.click(screen.getByTestId('pv-door-right'));
    fireEvent.click(screen.getByTestId('pv-dirty-discard'));
    expect(setDraft).toHaveBeenCalledWith(tab.id, '# hello');
    expect(setMode).toHaveBeenCalledWith(tab.id, 'view');
    expect(screen.queryByTestId('pv-panel')).toBeNull();
    expect(screen.getByTestId('pv-collapsed-rail')).toBeTruthy();
  });

  it('collapsed 上报给布局引擎', async () => {
    const onLayoutChange = vi.fn();
    const tab = mkTab();
    renderArea(
      { sessionId: 's1', onLayoutChange },
      mkCtx({ tabs: [tab], activeTabId: tab.id }),
    );
    await waitFor(() => {
      expect(onLayoutChange).toHaveBeenCalledWith({ settingWidth: PV_WIDTH_DEFAULT, collapsed: false });
    });
    fireEvent.click(screen.getByTestId('pv-door-right'));
    await waitFor(() => {
      expect(onLayoutChange).toHaveBeenCalledWith({ settingWidth: PV_WIDTH_DEFAULT, collapsed: true });
    });
  });
});

describe('[v0.0.329 门模型] 三态渲染把手位置', () => {
  it('center 态：细线左◀（pv-door-left）+ 右▶（pv-door-right）双把手并存', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id }));
    const left = screen.getByTestId('pv-door-left');
    const right = screen.getByTestId('pv-door-right');
    // 左把手 chevron ◀（ChevronLeft），右把手 chevron ▶（ChevronRight）
    expect(left.querySelector('svg path')?.getAttribute('d')).toBe('M15 18l-6-6 6-6');
    expect(right.querySelector('svg path')?.getAttribute('d')).toBe('M9 18l6-6-6-6');
    // 贴线侧：左把手 -left-[8px]（骑线左凸，偏移=handle 宽 8px 同步）、右把手 left-0（贴线右）
    expect(left.className).toContain('-left-[8px]');
    expect(right.className).toContain('left-0');
    // 面板正常显示
    expect(screen.getByTestId('pv-panel')).toBeTruthy();
    expect(screen.queryByTestId('pv-collapsed-rail')).toBeNull();
  });

  it('center 态点左◀ → setDoor(left)', () => {
    const setDoor = vi.fn();
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, setDoor }));
    fireEvent.click(screen.getByTestId('pv-door-left'));
    expect(setDoor).toHaveBeenCalledWith('left');
  });

  it('left 态：粗线 rail（pv-collapsed-rail）贴门框左缘 + ▶贴粗线右（pv-door-center）+ 面板占满', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, door: 'left' }));
    // 粗线 rail + 面板并存（preview 显示，chat 被遮由顶层 chatCollapsed 控制）
    expect(screen.getByTestId('pv-collapsed-rail')).toBeTruthy();
    expect(screen.getByTestId('pv-panel')).toBeTruthy();
    // ▶ 贴粗线右（-right-[8px]，偏移=handle 宽 8px 同步）
    const center = screen.getByTestId('pv-door-center');
    expect(center.querySelector('svg path')?.getAttribute('d')).toBe('M9 18l6-6-6-6');
    expect(center.className).toContain('-right-[8px]');
  });

  it('left 态点 ▶（pv-door-center）→ setDoor(center)', () => {
    const setDoor = vi.fn();
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, door: 'left', setDoor }));
    fireEvent.click(screen.getByTestId('pv-door-center'));
    expect(setDoor).toHaveBeenCalledWith('center');
  });

  it('right 态：粗线 rail + ◀贴粗线左（pv-collapse-expand）回居中（现状路径）', () => {
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, door: 'right' }));
    expect(screen.getByTestId('pv-collapsed-rail')).toBeTruthy();
    expect(screen.queryByTestId('pv-panel')).toBeNull();
    // ◀ 贴粗线左（-left-[8px]，偏移=handle 宽 8px 同步）
    const expand = screen.getByTestId('pv-collapse-expand');
    expect(expand.querySelector('svg path')?.getAttribute('d')).toBe('M15 18l-6-6 6-6');
    expect(expand.className).toContain('-left-[8px]');
  });
});

describe('[老板第三批补充] 收起态打开/切换文件 → 自动展开', () => {
  it('[v0.0.329] 点收起按钮 → 桥接 setDoor(right)（collapsed 派生语义）', () => {
    const setDoor = vi.fn();
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, setDoor }));
    // CtxProvider 桥接：setCollapsed(true) → setDoor('right')
    fireEvent.click(screen.getByTestId('pv-door-right'));
    expect(setDoor).toHaveBeenCalledWith('right');
  });

  it('收起态打开新文件 → hook 层 openTabDirect 自动展开', () => {
    // collapsed 在 hook 层管理——openTabDirect 内部 setCollapsed(false)
    // 容器测试只能验证：收起态渲染 pv-collapsed-rail + 展开→恢复
    const tab = mkTab();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [tab], activeTabId: tab.id, door: 'right' }));
    expect(screen.getByTestId('pv-collapsed-rail')).toBeTruthy();
    // 模拟 hook 层 setCollapsed(false)（自动展开 → door=center）
    fireEvent.click(screen.getByTestId('pv-collapse-expand'));
    expect(screen.getByTestId('pv-panel')).toBeTruthy();
  });

  it('collapsed per session localStorage key 格式', () => {
    // hook 层管理：pv-collapsed-{sid}
    expect(pvLsKey('s1', 'collapsed')).toBe('pv-collapsed-s1');
  });
});

describe('[老板第三批 Tab 键] 循环切换 tab', () => {
  it('Tab 键 → 切换到下一个 tab', () => {
    const t1 = mkTab({ id: 'workspace:a.md', fileName: 'a.md' });
    const t2 = mkTab({ id: 'workspace:b.md', fileName: 'b.md', path: 'b.md' });
    const activateTab = vi.fn();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [t1, t2], activeTabId: t1.id, activateTab }));
    const scroll = screen.getByTestId('pv-tabbar-scroll');
    scroll.focus();
    fireEvent.keyDown(scroll, { key: 'Tab' });
    expect(activateTab).toHaveBeenCalledWith(t2.id);
  });

  it('Tab 键在最后一个 tab → 循环回第一个', () => {
    const t1 = mkTab({ id: 'workspace:a.md', fileName: 'a.md' });
    const t2 = mkTab({ id: 'workspace:b.md', fileName: 'b.md', path: 'b.md' });
    const activateTab = vi.fn();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [t1, t2], activeTabId: t2.id, activateTab }));
    const scroll = screen.getByTestId('pv-tabbar-scroll');
    scroll.focus();
    fireEvent.keyDown(scroll, { key: 'Tab' });
    expect(activateTab).toHaveBeenCalledWith(t1.id);
  });

  it('Shift+Tab → 反向切换到上一个 tab', () => {
    const t1 = mkTab({ id: 'workspace:a.md', fileName: 'a.md' });
    const t2 = mkTab({ id: 'workspace:b.md', fileName: 'b.md', path: 'b.md' });
    const activateTab = vi.fn();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [t1, t2], activeTabId: t2.id, activateTab }));
    const scroll = screen.getByTestId('pv-tabbar-scroll');
    scroll.focus();
    fireEvent.keyDown(scroll, { key: 'Tab', shiftKey: true });
    expect(activateTab).toHaveBeenCalledWith(t1.id);
  });

  it('Shift+Tab 在第一个 tab → 循环回最后一个', () => {
    const t1 = mkTab({ id: 'workspace:a.md', fileName: 'a.md' });
    const t2 = mkTab({ id: 'workspace:b.md', fileName: 'b.md', path: 'b.md' });
    const activateTab = vi.fn();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [t1, t2], activeTabId: t1.id, activateTab }));
    const scroll = screen.getByTestId('pv-tabbar-scroll');
    scroll.focus();
    fireEvent.keyDown(scroll, { key: 'Tab', shiftKey: true });
    expect(activateTab).toHaveBeenCalledWith(t2.id);
  });

  it('编辑态 Tab 切换 → activateTab 走守卫（不绕过）', () => {
    const t1 = mkTab({ id: 'workspace:a.md', fileName: 'a.md', mode: 'edit' });
    const t2 = mkTab({ id: 'workspace:b.md', fileName: 'b.md', path: 'b.md' });
    const activateTab = vi.fn();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [t1, t2], activeTabId: t1.id, activateTab }));
    const scroll = screen.getByTestId('pv-tabbar-scroll');
    scroll.focus();
    fireEvent.keyDown(scroll, { key: 'Tab' });
    // activateTab 被调用（内部会因 mode='edit' 触发守卫 pending）
    expect(activateTab).toHaveBeenCalledWith(t2.id);
  });

  it('仅 1 个 tab → Tab 键不触发切换', () => {
    const t1 = mkTab({ id: 'workspace:a.md', fileName: 'a.md' });
    const activateTab = vi.fn();
    renderArea({ sessionId: 's1' }, mkCtx({ tabs: [t1], activeTabId: t1.id, activateTab }));
    const scroll = screen.getByTestId('pv-tabbar-scroll');
    scroll.focus();
    fireEvent.keyDown(scroll, { key: 'Tab' });
    expect(activateTab).not.toHaveBeenCalled();
  });
});

describe('[老板第三批①] viewer 顶栏删除', () => {
  it('viewer 不再有编辑按钮', () => {
    render(<ComponentPreviewViewer tab={mkTab()} sessionId="s1" />);
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.queryByTestId('pv-viewer-edit')).toBeNull();
  });

  it('viewer plain → pre', () => {
    render(<ComponentPreviewViewer tab={mkTab({ format: 'txt', content: 'plain text body' })} sessionId="s1" />);
    expect(screen.getByText('plain text body')).toBeTruthy();
  });
});

describe('dirty modal（{{name}} 插值）', () => {
  it('标题含文件名', () => {
    const onResolve = vi.fn();
    render(<ComponentPreviewDirtyModal fileName="line1.md" onResolve={onResolve} />);
    expect(screen.getByText('文件「line1.md」有未保存的修改')).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('文件「line1.md」有未保存的修改');
  });
});
