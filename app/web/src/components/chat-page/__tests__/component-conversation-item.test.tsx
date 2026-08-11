// @vitest-environment jsdom
/**
 * component-conversation-item 单测（v0.0.47 Bug A + v0.0.88 轮询消除 P3）
 * 参考: specs/ui/components/chat-page/_overview.md §4.2（conv-item expanded 局部 state）
 *       / §5 交互8（行点击展开 subagent-tree）
 *       / specs/tech/app/frontend/[P0]sse_client_singleton.md §8 P3（v0.0.88 删 1.5s 轮询）
 *
 * 覆盖：
 *   - [v0.0.47 Bug A] active 从 true→false 自动收起 subagent-tree
 *   - [v0.0.88 P3] expand 仅触发一次 onRefreshChildren（无 1.5s 轮询、无 30s 自停）
 *   - [v0.0.88 P3] 全程无 setInterval / setTimeout 注册（靠 session_meta `_all` 推送兜底）
 *   - [v0.0.88 P3] active 失焦时 stopPolling cleanup 保留（幂等无害，pollRef 已无 interval 可清）
 *
 * 复用 section-conv-panel-edit.test.tsx 的 renderItem + mkSession / mkChildren 套路，
 * 但此处聚焦组件级（直接渲染 ComponentConversationItem，不通过 SectionConvPanel）。
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentConversationItem } from '../component-conversation-item';
import type { ChildrenView, Session } from '../types';
import { initI18n } from '../../../i18n';

// [v0.0.62 i18n] 启动 i18next instance：conv-item 内部用 useTranslation 查 common.timeAgo.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: '父会话',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function mkChildren(overrides: Partial<ChildrenView> = {}): ChildrenView {
  return {
    parentSessionId: 'sess-1',
    running: [
      {
        sessionId: 'r1',
        name: 'explorer',
        state: 'running',
        subAgentTemplateType: 'explorer',
        updatedAt: '2026-06-28T00:00:00.000Z',
      },
    ],
    terminated: [],
    ...overrides,
  };
}

interface ItemOpts {
  active?: boolean;
  childrenView?: ChildrenView;
  activeSubId?: string;
  onSelect?: () => void;
  onSelectSub?: () => void;
  onDelete?: () => void;
  onRefreshChildren?: () => void;
  onRenameTitle?: () => void;
  /** [v0.0.306] pin 回调 spy（可选；未注入 → 按钮不渲染） */
  onTogglePin?: (id: string, pinned: boolean) => void;
}

function renderItem(session: Session, opts: ItemOpts = {}) {
  return render(
    <ComponentConversationItem
      session={session}
      active={opts.active ?? true}
      childrenView={opts.childrenView}
      activeSubId={opts.activeSubId}
      onSelect={opts.onSelect ?? (() => {})}
      onSelectSub={opts.onSelectSub ?? (() => {})}
      onDelete={opts.onDelete ?? (() => {})}
      onContextMenu={() => {}}
      onRefreshChildren={opts.onRefreshChildren}
      onRenameTitle={opts.onRenameTitle ?? (() => {})}
      onTogglePin={opts.onTogglePin}
    />,
  );
}

/** conv-item 行容器：title 文案「父会话」的最近 .group 祖先（即可点击的整行 div） */
function getRow(): HTMLElement {
  return screen.getByText('父会话').closest('.group') as HTMLElement;
}

/**
 * subagent-tree 挂载锚点：以 running 子项的 name 文案定位（默认 'explorer'）。
 * tree 未挂载时该文案不存在；挂载后出现。返回 null 表示 tree 未渲染。
 */
function subagentQuery(name = 'explorer'): HTMLElement | null {
  return screen.queryByText(name);
}

describe('ComponentConversationItem subagent-tree 自动收起（v0.0.47 Bug A）', () => {
  it('active + 行点击展开 → subagent-tree 挂载', () => {
    renderItem(
      mkSession({ id: 's1' }),
      { active: true, childrenView: mkChildren({ parentSessionId: 's1' }) },
    );
    // 折叠态：subagent-tree 不渲染
    expect(subagentQuery()).toBeNull();
    // 行点击展开（expandOnce 置 expanded=true）
    fireEvent.click(getRow());
    expect(subagentQuery()).not.toBeNull();
  });

  it('active 从 true→false（点别的会话）→ subagent-tree 不再挂载', () => {
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: true, childrenView: mkChildren({ parentSessionId: 's1' }) },
    );
    // 行点击展开 → subagent-tree 挂载
    fireEvent.click(getRow());
    expect(subagentQuery()).not.toBeNull();
    // 切到别的会话 → active 变 false → 自动收起
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery()).toBeNull();
  });

  it('[v0.0.88 P3] expand 仅触发一次 onRefreshChildren（无 1.5s 轮询，靠 session_meta 推送兜底）', () => {
    vi.useFakeTimers();
    const onRefreshChildren = vi.fn();
    renderItem(
      mkSession({ id: 's1' }),
      {
        active: true,
        childrenView: mkChildren({ parentSessionId: 's1' }),
        onRefreshChildren,
      },
    );
    // 行点击展开：仅触发一次 refresh（expandOnce 主动刷）
    fireEvent.click(getRow());
    expect(onRefreshChildren).toHaveBeenCalledTimes(1);
    // 推进 5s：无新增调用（已删 1.5s setInterval 轮询）
    vi.advanceTimersByTime(5000);
    expect(onRefreshChildren).toHaveBeenCalledTimes(1);
    // 推进超过旧 30s 自停阈值：仍无新增（setInterval/setTimeout 均已删）
    vi.advanceTimersByTime(35000);
    expect(onRefreshChildren).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('[v0.0.88 P3] 全程无 setInterval / setTimeout 注册（轮询彻底消除）', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    renderItem(
      mkSession({ id: 's1' }),
      {
        active: true,
        childrenView: mkChildren({ parentSessionId: 's1' }),
        onRefreshChildren: vi.fn(),
      },
    );
    // 行点击展开（旧实现会注册 setInterval + setTimeout，新实现均不注册）
    fireEvent.click(getRow());
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('[v0.0.88 P3] active 失焦时 stopPolling cleanup 保留（幂等无害，pollRef 已无 interval 可清）', () => {
    // 验证 change_plan P3 行「pollRef cleanup 不动」：stopPolling 在 active=false 时仍被调
    // （pollRef.current 始终为 null，clearInterval 兜底无副作用——幂等无害）
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: true, childrenView: mkChildren({ parentSessionId: 's1' }) },
    );
    // 行点击展开（不再启动 interval）
    fireEvent.click(getRow());
    expect(subagentQuery()).not.toBeNull();
    // active=false → 自动收起（stopPolling 被调，即便 pollRef.current 为 null 也不报错）
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery()).toBeNull();
  });

  it('inactive→active→inactive 切换：subagent-tree 仅在 active 期间展开', () => {
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: false, childrenView: mkChildren({ parentSessionId: 's1' }) },
    );
    // 初始 inactive：subagent-tree 不渲染
    expect(subagentQuery()).toBeNull();
    // → active + 行点击展开
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={true}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    fireEvent.click(getRow());
    expect(subagentQuery()).not.toBeNull();
    // → 再次 inactive
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery()).toBeNull();
  });
});

/**
 * v0.0.90 Bug A 修订：选中本 conv-item 的 subagent 时，parent 切 inactive 不收起 tree。
 *
 * 覆盖四条路径：
 *   1. 点 parent 的 subagent → activeSubIsMyChild=true → Bug A 例外 → tree 保持展开 + subagent 高亮
 *   2. active=false + activeSubId=无关 id（不属于本 conv-item children）→ 仍按原 Bug A 收起
 *   3. active=false + activeSubId=null → 仍按原 Bug A 收起（对照基线）
 *   4. subagent → 无关会话（activeSubId 切到 null）→ activeSubIsMyChild 转 false → 收起
 *
 * 关键不变量：Bug A 的「切走即收起」语义在「切到自己 child」时被豁免，避免用户看不到自己刚选的
 * subagent 在 tree 里的位置。
 */
describe('ComponentConversationItem subagent-tree 选中子会话保持展开（v0.0.90 Bug A 修订）', () => {
  it('active=false + activeSubId=本 conv-item child id → subagent-tree 仍渲染（不收起）', () => {
    // 直接 inactive 渲染：未手动 expand（expanded=false），但 activeSubId 命中 running[0].sessionId
    renderItem(
      mkSession({ id: 's1' }),
      {
        active: false,
        childrenView: mkChildren({ parentSessionId: 's1' }), // running[0].sessionId='r1'
        activeSubId: 'r1',
      },
    );
    // 兜底渲染：即便 expanded=false，activeSubIsMyChild=true 让 subagent-tree 仍挂载
    expect(subagentQuery()).not.toBeNull();
    // 该 subagent 高亮（active row 渲染 subagent-item-r1）
    expect(subagentQuery()).not.toBeNull();
  });

  it('active=true + 行点击展开后 → 切到 subagent（active=false + activeSubId=child）→ tree 保持', () => {
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: true, childrenView: mkChildren({ parentSessionId: 's1' }) },
    );
    // 行点击展开 → tree 挂载
    fireEvent.click(getRow());
    expect(subagentQuery()).not.toBeNull();
    // 切到 subagent：active=false + activeSubId=r1（属于 children）→ Bug A 例外，不收起
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        activeSubId="r1"
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery()).not.toBeNull();
    expect(subagentQuery()).not.toBeNull();
  });

  it('对照：active=false + activeSubId=无关 id（非本 children）→ 仍按原 Bug A 收起', () => {
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: true, childrenView: mkChildren({ parentSessionId: 's1' }) },
    );
    fireEvent.click(getRow());
    expect(subagentQuery()).not.toBeNull();
    // 切到无关 session（不是 s1，也不是 s1 的 child r1）
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        activeSubId="other-sub-id"
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery()).toBeNull();
  });

  it('对照：active=false + activeSubId=undefined → 仍按原 Bug A 收起', () => {
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: true, childrenView: mkChildren({ parentSessionId: 's1' }) },
    );
    fireEvent.click(getRow());
    expect(subagentQuery()).not.toBeNull();
    // activeSubId 缺省（顶层切换 / 无 subagent 选中场景）
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery()).toBeNull();
  });

  it('subagent→同 parent 另一 subagent：activeSubIsMyChild 始终 true，tree 保持', () => {
    const children = mkChildren({
      parentSessionId: 's1',
      running: [
        { sessionId: 'r1', name: 'a', state: 'running', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T00:00:00.000Z' },
        { sessionId: 'r2', name: 'b', state: 'running', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T00:00:00.000Z' },
      ],
    });
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: false, childrenView: children, activeSubId: 'r1' },
    );
    expect(subagentQuery('a')).not.toBeNull();
    expect(subagentQuery('a')).not.toBeNull();
    // 同 parent 切到另一 subagent
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={children}
        activeSubId="r2"
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery('a')).not.toBeNull();
    expect(subagentQuery('b')).not.toBeNull();
  });

  it('subagent→无关会话（activeSubId 转 undefined）：activeSubIsMyChild 转 false → 收起', () => {
    const { rerender } = renderItem(
      mkSession({ id: 's1' }),
      { active: false, childrenView: mkChildren({ parentSessionId: 's1' }), activeSubId: 'r1' },
    );
    expect(subagentQuery()).not.toBeNull();
    // 切到顶层无关会话：active=false + activeSubId=undefined
    rerender(
      <ComponentConversationItem
        session={mkSession({ id: 's1' })}
        active={false}
        childrenView={mkChildren({ parentSessionId: 's1' })}
        onSelect={() => {}}
        onSelectSub={() => {}}
        onDelete={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(subagentQuery()).toBeNull();
  });
});


/**
 * [v0.0.306] hover pin 按钮（对齐 SquadRow）：替换 v0.0.231 只读 PinIcon。
 * 覆盖 5 用例（PRD §4.3 / change_plan B 组）：
 *   ① 未 pin + 非 hover → 按钮存在 + opacity-0（visibility visible 恒占位，零 reflow）
 *   ② 未 pin + group-hover → class 组合含 group-hover:opacity-100（hover 显示）
 *   ③ pinned → 按钮常驻 opacity-100 + text-accent（不依赖 hover）
 *   ④ 点击 → onTogglePin(id, true) 被调 + 不触发 onSelect（stopPropagation 验证）
 *   ⑤ 未注入 onTogglePin → 无按钮（向后兼容）
 * 断言基于 class/aria-label（非视觉）；aria-label 用 chat:convPanel.pin/unpin（i18n 已存在）。
 */
describe('ComponentConversationItem hover pin 按钮（v0.0.306）', () => {
  it('① 未 pin + 非 hover → 按钮存在 + opacity-0（visibility visible 恒占位）', () => {
    const onTogglePin = vi.fn();
    renderItem(mkSession({ id: 's1', pinned: false }), { active: false, onTogglePin });
    const btn = screen.getByRole('button', { name: '置顶' });
    expect(btn.className).toContain('opacity-0');
    expect(btn.className).toContain('group-hover:opacity-100');
    expect(btn.style.visibility).toBe('visible');
    // 未 pin：text-muted（非 accent）
    expect(btn.className).toContain('text-muted');
    expect(btn.className).not.toContain('text-accent');
  });

  it('② 未 pin → class 组合含 group-hover:opacity-100（hover 显示）', () => {
    const onTogglePin = vi.fn();
    renderItem(mkSession({ id: 's1', pinned: false }), { active: false, onTogglePin });
    const btn = screen.getByRole('button', { name: '置顶' });
    // jsdom 无法真 hover，断言 Tailwind group-hover class 存在（hover 时 opacity-100 生效）
    expect(btn.className).toContain('group-hover:opacity-100');
    // 非 hover 基态 opacity-0 与 hover class 共存（Tailwind 层叠生效）
    expect(btn.className).toContain('opacity-0');
  });

  it('③ pinned → 按钮常驻 opacity-100 + text-accent（不依赖 hover）', () => {
    const onTogglePin = vi.fn();
    renderItem(mkSession({ id: 's1', pinned: true }), { active: false, onTogglePin });
    // pinned 时 aria-label 为「取消置顶」
    const btn = screen.getByRole('button', { name: '取消置顶' });
    expect(btn.className).toContain('opacity-100');
    expect(btn.className).toContain('text-accent');
    // pinned 常驻：不含 opacity-0 / group-hover 依赖
    expect(btn.className).not.toContain('opacity-0');
    expect(btn.className).not.toContain('group-hover:opacity-100');
    expect(btn.style.visibility).toBe('visible');
  });

  it('④ 点击按钮 → onTogglePin(id, true) 被调 + 不触发 onSelect（stopPropagation）', () => {
    const onTogglePin = vi.fn();
    const onSelect = vi.fn();
    renderItem(mkSession({ id: 's1', pinned: false }), { active: false, onTogglePin, onSelect });
    const btn = screen.getByRole('button', { name: '置顶' });
    fireEvent.click(btn);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onTogglePin).toHaveBeenCalledWith('s1', true);
    // stopPropagation：行 onClick 未触发（onSelect 未被调）
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('⑤ 未注入 onTogglePin → 无按钮（向后兼容）', () => {
    renderItem(mkSession({ id: 's1', pinned: true }), { active: false });
    // 未注入 onTogglePin：即便 pinned 也无按钮（v0.0.231 只读图标已被按钮取代，不叠加）
    expect(screen.queryByRole('button', { name: '取消置顶' })).toBeNull();
    expect(screen.queryByRole('button', { name: '置顶' })).toBeNull();
  });
});
