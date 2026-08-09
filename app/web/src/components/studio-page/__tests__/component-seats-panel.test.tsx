/**
 * @vitest-environment jsdom
 * SeatsPanel 单测 —— v0.0.288 重构（左竖条 token+成员 / 右全景 / 删 leaderCard / 群聊图标头部）
 * 参考: specs/ui/components/studio-page/component-seats-panel.md
 *       specs/ui/components/studio-page/component-seats-body.md
 *
 * vi.mock 用 __dirname 绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 * v0.0.288 变更：删 leaderCard → 队长入 MemberRosterList 行内 isLeader badge；
 *   全景从底部 section 移入 SeatsBody 右列；群聊/加号改 icon-only 按钮在成员卡头部。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { mkDetail, mkMember } from './_fixtures';

// 绝对路径 mock（避免 bun+jsdom 相对路径失效 + 避免 worktree 硬编码）
const chatMocks = vi.hoisted(() => ({
  listSessions: vi.fn(async () => [
    { id: 'sess-leader', title: 'L', status: 'active', updatedAt: '2026-07-17T10:00:00.000Z', createdAt: '2026-07-17T09:00:00.000Z' },
    { id: 'sess-m2', title: 'M', status: 'active', updatedAt: '2026-07-17T10:30:00.000Z', createdAt: '2026-07-17T09:00:00.000Z' },
  ]),
}));
const chatApiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/chat-api'));
vi.mock(chatApiPath, () => chatMocks);

const squadMocks = vi.hoisted(() => ({
  getBudgetUsage: vi.fn(async () => ({
    squadId: 's1', limit: 100000, window: 'daily',
    consumed: 23400, remaining: 76600, windowStart: '', windowEnd: '',
    perSession: [], timezone: 'UTC',
  })),
  getSchedulerHistory: vi.fn(async () => []),
  fetchTokenStats: vi.fn(async () => ({ series: [], granularity: 'day', scope: '__team__', from: '', to: '', timezone: 'UTC', squadId: 's1' })),
}));
const squadApiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/squad-api'));
vi.mock(squadApiPath, () => squadMocks);

const panoMocks = vi.hoisted(() => ({
  getPanoramaSchema: vi.fn(async () => `
meta: { version: '1.0' }
entities:
  task:
    system: true
    label: 任务
    id_field: id
    fields:
      id: { type: string, required: true }
      title: { type: string, required: true }
      status: { type: enum, values: [todo, waiting, in_progress, done], required: true }
    states: { field: status, initial: todo, transitions: {}, terminal: [done] }
views:
  - id: task_kanban
    label: 任务
    entity: task
    component: kanban
    group_by: status
    columns: [todo, waiting, in_progress, done]
    card: { title: '{title}', badges: [owner, status] }
`),
  listPanoramaEntities: vi.fn(async () => []),
  listPanoramaEvents: vi.fn(async () => []),
}));
const panoApiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/panorama-api'));
vi.mock(panoApiPath, () => panoMocks);

const ssePath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
vi.mock(ssePath, () => ({
  getSseClient: () => ({
    subscribe: vi.fn(async () => ({ subId: 'x', topic: 'panorama', group: 'g', unsubscribe: vi.fn() })),
  }),
}));

import { SeatsPanel } from '../component-seats-panel';

beforeAll(async () => {
  await initI18n('zh-CN');
});
beforeEach(() => {
  vi.clearAllMocks();
  panoMocks.listPanoramaEntities.mockResolvedValue([]);
  panoMocks.listPanoramaEvents.mockResolvedValue([]);
});
afterEach(() => cleanup());

/** 构造 SeatsPanel 默认 props（所有回调 vi.fn() 便于断言） */
function mkProps(over: Partial<Parameters<typeof SeatsPanel>[0]> = {}): Parameters<typeof SeatsPanel>[0] {
  return {
    squadId: 's1',
    detail: mkDetail(),
    stateMap: {},
    onEnterChat: vi.fn(),
    onOpenGroupChat: vi.fn(),
    onEditMember: vi.fn(),
    onBenchMember: vi.fn(),
    onDeployMember: vi.fn(),
    onHire: vi.fn(),
    onSaveMeta: vi.fn(async () => {}),
    onDelete: vi.fn(async () => true),
    onAtLeader: vi.fn(),
    ...over,
  };
}

// —— 语义/结构定位辅助 —— //
const mainRoot = (container: HTMLElement) => container.querySelector('main');
const seatsTab = () => screen.getByRole('button', { name: '首页' });
const panelTab = () => screen.getByRole('button', { name: '管理' });
const autoworkTabBtn = () => screen.getByRole('button', { name: '自动工作' });
/** v0.0.240 TokenWidget 根（「Token 用量」标题的 button 祖先） */
const tokenWidgetBtn = () => screen.getByRole('button', { name: /Token 用量/ });
/** v0.0.288 成员卡头部群聊图标按钮（icon-only，testid 定位） */
const groupChatBtn = () => screen.getByTestId('seats-group-chat-btn');
/** v0.0.288 成员卡头部加号图标按钮（icon-only，testid 定位） */
const hireBtn = () => screen.getByTestId('seats-hire-btn');
/** 管理 tab 字段（按 label 定位） */
function manageField(labelText: string): HTMLElement {
  const label = screen.getByText(labelText, { selector: 'label' });
  const wrap = label.closest('div')!;
  return (wrap.querySelector('input') ?? wrap.querySelector('textarea')) as HTMLElement;
}
const squadNameInput = () => manageField('squad 名称');

// ─── v0.0.288 布局结构 ─────────────────────────────────────────────────────

describe('SeatsPanel — v0.0.288 布局结构（左竖条 + 右全景）', () => {
  it('渲染 header + 左竖条（TokenWidget + 成员卡）+ 右全景', async () => {
    const { container } = render(<SeatsPanel {...mkProps()} />);
    expect(mainRoot(container)).toBeTruthy();
    expect(seatsTab()).toBeTruthy();
    await screen.findByText('张三');
    // 左竖条：TokenWidget + 成员卡（无独立 leaderCard——v0.0.288 删除）
    expect(tokenWidgetBtn()).toBeTruthy();
    // 成员计数 header 存在（v0.0.292 计数含队长=2；i18next {{count}} 插值拆多文本节点 → 查 container.textContent）
    await waitFor(() => expect(container.textContent).toMatch(/成员 · 2/));
    // v0.0.288 删 leaderCard：无「队长」sectionLabel（leader 入 MemberRosterList 行内 badge）
    expect(screen.queryByText('队长')).toBeNull();
    // 右全景：任务 tab 出现（PanoramaRoute 在 SeatsBody 右列）
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/^\d+ 在线$/).textContent).toContain('2'));
  });

  it('成员卡头部：左标题 + 右组（在岗/全部 + 群聊图标 + 加号图标）', async () => {
    render(<SeatsPanel {...mkProps()} />);
    await screen.findByText('张三');
    // 在岗/全部切换恒渲染
    expect(screen.getByRole('button', { name: '在岗' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部' })).toBeTruthy();
    // 群聊图标按钮（icon-only，testid 定位，非文字「群聊」按钮）
    expect(groupChatBtn()).toBeTruthy();
    // 加号图标按钮（icon-only，testid 定位，非文字「新增成员」按钮）
    expect(hireBtn()).toBeTruthy();
    // 加号 icon-only 按钮 aria-label=「新增成员」（无障碍标签），无独立文字按钮
    expect(hireBtn().querySelector('svg')).toBeTruthy();
  });

  it('右全景不横滑（overflow-hidden class）', async () => {
    const { container } = render(<SeatsPanel {...mkProps()} />);
    await screen.findByText('张三');
    // 右主体容器 min-w-0 flex-1（v0.0.292 删 overflow-hidden，高度随内容撑开）
    const rightPanel = container.querySelector('.min-w-0.flex-1');
    expect(rightPanel).toBeTruthy();
  });

  it('空成员 → 成员卡空态占位 + 头部群聊/加号按钮仍在', async () => {
    const leader = mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader' });
    const detail = mkDetail({
      members: [leader],
      leaderId: 'leader1',
      memberIds: ['leader1'],
    });
    const { container } = render(<SeatsPanel {...mkProps({ detail })} />);
    // 成员计数（v0.0.292 计数含队长=1；i18next {{count}} 插值拆多文本节点 → 查 container.textContent）
    await waitFor(() => expect(container.textContent).toMatch(/成员 · 1/));
    expect(groupChatBtn()).toBeTruthy();
    expect(hireBtn()).toBeTruthy();
  });

  it('v0.0.170 页头 C 化：tabs 下划线式（border-b-2）', () => {
    render(<SeatsPanel {...mkProps()} />);
    const seats = seatsTab();
    expect(seats.className).toContain('border-b-2');
    expect(seats.className).toContain('border-b-fg');
    expect(panelTab().className).toContain('border-b-transparent');
  });
});

// ─── v0.0.244 视图筛选（在岗/全部 toggle + 计数口径） ──────────────────────

describe('SeatsPanel — v0.0.288 视图筛选（在岗/全部 toggle + 三分区计数）', () => {
  /** 1 leader + 1 deployed mate（张三）+ 1 benched mate（李四） */
  const mkViewDetail = () => {
    const leader = mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader', state: 'deployed' });
    const mate = mkMember({ id: 'm2', name: '张三', role: 'mate', sessionId: 'sess-m2', state: 'deployed' });
    const benched = mkMember({ id: 'm3', name: '李四', role: 'mate', sessionId: 'sess-m3', state: 'benched' });
    return mkDetail({ members: [leader, mate, benched], memberIds: ['leader1', 'm2', 'm3'] });
  };
  const activeSeg = () => screen.getByRole('button', { name: '在岗' });
  const allSeg = () => screen.getByRole('button', { name: '全部' });

  it('默认在岗视图：只见 deployed 成员 + 计数=在岗数；toggle 恒渲染', async () => {
    const { container } = render(<SeatsPanel {...mkProps({ detail: mkViewDetail() })} />);
    await screen.findByText('张三');
    // benched 李四不在列表；计数=在岗成员数（2=leader+m2，含 leader 因为 derivePanelRows 不排除 leader）
    expect(screen.queryByText('李四')).toBeNull();
    expect(activeSeg().getAttribute('data-active')).toBe('true');
    expect(allSeg().getAttribute('data-active')).toBe('false');
    expect(container.querySelector('main')).toBeTruthy();
  });

  it('切「全部」→ 见 benched 行（opacity-[0.55] + grayscale）+ 计数增加', async () => {
    render(<SeatsPanel {...mkProps({ detail: mkViewDetail() })} />);
    await screen.findByText('张三');
    fireEvent.click(allSeg());
    // benched 行出现
    await screen.findByText('李四');
    // benched 行灰度比 idle 更灰（opacity-[0.55]）
    const benchedRow = screen.getByText('李四').closest('button');
    expect(benchedRow?.className).toContain('opacity-[0.55]');
    expect(allSeg().getAttribute('data-active')).toBe('true');
    // 切回在岗 → benched 再隐藏
    fireEvent.click(activeSeg());
    expect(screen.queryByText('李四')).toBeNull();
  });
});

// ─── 交互回调 ──────────────────────────────────────────────────────────────

describe('SeatsPanel — v0.0.288 交互回调', () => {
  it('点成员行进入对话 → onEnterChat(node)', async () => {
    const props = mkProps();
    render(<SeatsPanel {...props} />);
    await screen.findByText('张三');
    // MemberRosterList 行 = 整行 button（data-testid=squad-status-row-{id}）
    const row = screen.getByTestId('squad-status-row-m2');
    fireEvent.click(row);
    expect(props.onEnterChat).toHaveBeenCalledTimes(1);
    const node = (props.onEnterChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(node?.sessionId).toBe('sess-m2');
    expect(node?.squadId).toBe('s1');
  });

  it('点成员卡头部群聊图标按钮 → onOpenGroupChat', async () => {
    const props = mkProps();
    render(<SeatsPanel {...props} />);
    await screen.findByText('张三');
    fireEvent.click(groupChatBtn());
    expect(props.onOpenGroupChat).toHaveBeenCalledTimes(1);
    const gnode = (props.onOpenGroupChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(gnode?.sessionId).toBe('sess-group');
    expect(gnode?.squadId).toBe('s1');
  });

  it('点成员卡头部加号图标按钮 → onHire', async () => {
    const props = mkProps();
    render(<SeatsPanel {...props} />);
    await screen.findByText('张三');
    fireEvent.click(hireBtn());
    expect(props.onHire).toHaveBeenCalledTimes(1);
  });

  it('TokenWidget 整卡点击 → onOpenTokenStats(squadId)', async () => {
    const props = mkProps({ onOpenTokenStats: vi.fn() });
    render(<SeatsPanel {...props} />);
    fireEvent.click(tokenWidgetBtn());
    expect(props.onOpenTokenStats).toHaveBeenCalledWith('s1');
  });
});

// ─── v0.0.270 群聊开关两态（v0.0.288 迁移到成员卡头部图标） ──────────────

describe('SeatsPanel — v0.0.288 群聊开关图标按钮两态', () => {
  it('enableGroupChat=默认 → 成员卡头部群聊图标按钮可见', async () => {
    render(<SeatsPanel {...mkProps()} />);
    await screen.findByText('张三');
    expect(groupChatBtn()).toBeTruthy();
  });

  it('enableGroupChat=false → 成员卡头部无群聊图标按钮', async () => {
    const props = mkProps({ detail: mkDetail({ enableGroupChat: false }) });
    render(<SeatsPanel {...props} />);
    await screen.findByText('张三');
    expect(screen.queryByTestId('seats-group-chat-btn')).toBeNull();
  });
});

// ─── tab 内联切换 ──────────────────────────────────────────────────────────

describe('SeatsPanel — tab 内联切换（v0.0.168）', () => {
  it('默认 seats tab active；点管理 → 内联渲染 ManageTab，头部常驻', async () => {
    render(<SeatsPanel {...mkProps()} />);
    expect(seatsTab().getAttribute('data-active')).toBe('true');
    expect(panelTab().getAttribute('data-active')).toBe('false');
    fireEvent.click(panelTab());
    expect(panelTab().getAttribute('data-active')).toBe('true');
    await waitFor(() => expect(squadNameInput()).toBeTruthy());
    expect(manageField('squad 介绍')).toBeTruthy();
    // 切到管理 tab 后 seats 主体消失
    expect(screen.queryByText('张三')).toBeNull();
  });

  it('点自动工作 → 内联渲染 AutoworkTab', async () => {
    render(<SeatsPanel {...mkProps()} />);
    fireEvent.click(autoworkTabBtn());
    expect(autoworkTabBtn().getAttribute('data-active')).toBe('true');
    await waitFor(() => expect(screen.getByText('enableHeartBeat（自主性总开关）')).toBeTruthy());
  });

  it('从 panel tab 切回 seats → 恢复 TokenWidget + 成员列表', async () => {
    render(<SeatsPanel {...mkProps()} />);
    fireEvent.click(panelTab());
    await waitFor(() => expect(squadNameInput()).toBeTruthy());
    fireEvent.click(seatsTab());
    await waitFor(() => expect(tokenWidgetBtn()).toBeTruthy());
    expect(screen.getByText('张三')).toBeTruthy();
    expect(screen.queryByText('squad 名称')).toBeNull();
  });

  it('initialTab=panel → 首次渲染即在管理 tab', async () => {
    render(<SeatsPanel {...mkProps({ initialTab: 'panel' })} />);
    expect(panelTab().getAttribute('data-active')).toBe('true');
    await waitFor(() => expect(squadNameInput()).toBeTruthy());
  });
});
