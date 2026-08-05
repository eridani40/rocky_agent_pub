/**
 * @vitest-environment jsdom
 * SeatsPanel 单测 —— v0.0.240 修订（首页 IA：左列队长+TokenWidget / 右列成员 / 第二栏全景内嵌）
 * 参考: specs/ui/components/studio-page/component-seats-panel.md
 *       specs/ui/components/studio-page/component-seats-body.md
 *
 * vi.mock 用 __dirname 绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 * 定位策略：tab=按钮文案；队长卡=「队长」seclabel 的 rounded-xl 祖先；mate 行=「张三」的 group 祖先。
 * v0.0.240 变更：tab「坐席」→「首页」；删 SeatStats 2×2 + TeamEntryRow；左列加 TokenWidget；第二栏内嵌 PanoramaRoute。
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
  // 后端 ensureSystemEntities 后恒返含 task 的 DSL（v0.0.243 task 改普通 entity）
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
  // 不再覆盖 mockResolvedValue：用 hoisted 默认（task-only DSL）
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
/** 首页三 tab（v0.0.240 第一项改名「首页」） */
const seatsTab = () => screen.getByRole('button', { name: '首页' });
const panelTab = () => screen.getByRole('button', { name: '管理' });
const autoworkTabBtn = () => screen.getByRole('button', { name: '自动工作' });
/** 队长卡根（「队长」seclabel 的 rounded-xl 祖先） */
const leaderCardRoot = () => screen.getByText('队长').closest('.rounded-xl') as HTMLElement;
/** mate（张三）行根（「张三」的 group 祖先） */
const mateRowRoot = () => screen.getByText('张三').closest('div[class*="group"]') as HTMLElement;
/** 「+ 新增成员」按钮（roster 头） */
const addBtn = () => screen.getByRole('button', { name: '新增成员' });
/** v0.0.240 TokenWidget 根（「Token 用量」标题的 button 祖先） */
const tokenWidgetBtn = () => screen.getByRole('button', { name: /Token 用量/ });
/** 队长卡群聊按钮 */
const groupChatBtn = () => screen.getByRole('button', { name: '群聊' });
/** 管理 tab 字段（按 label 定位） */
function manageField(labelText: string): HTMLElement {
  const label = screen.getByText(labelText, { selector: 'label' });
  const wrap = label.closest('div')!;
  return (wrap.querySelector('input') ?? wrap.querySelector('textarea')) as HTMLElement;
}
const squadNameInput = () => manageField('squad 名称');

describe('SeatsPanel — v0.0.240 结构（首页 IA）', () => {
  it('渲染 header + seats-console（左列队长+TokenWidget / 右列 roster）', async () => {
    const { container } = render(<SeatsPanel {...mkProps()} />);
    expect(mainRoot(container)).toBeTruthy();
    expect(seatsTab()).toBeTruthy(); // header tab「首页」
    await screen.findByText('张三');
    // 左列：队长卡 + TokenWidget（无 SeatStats 2×2 / 无 TeamEntryRow）
    expect(leaderCardRoot()).toBeTruthy();
    expect(tokenWidgetBtn()).toBeTruthy();
    // v0.0.240 删 SeatStats/TeamEntryRow：无「业务全景」link、无「成员在线」grid label
    expect(screen.queryByRole('button', { name: '业务全景' })).toBeNull();
    // 右列 roster：mate 行 + 新增按钮
    expect(mateRowRoot()).toBeTruthy();
    expect(addBtn()).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/^\d+ 在线$/).textContent).toContain('2'));
  });

  it('v0.0.240 roster 头计数「成员 · N」（N=当前视图行数；v0.0.244 起跟随视图过滤）', async () => {
    render(<SeatsPanel {...mkProps()} />);
    await screen.findByText('张三');
    // mkDetail 默认 1 leader + 1 deployed mate → 默认在岗视图 N=1
    expect(screen.getByText(/成员 · 1/)).toBeTruthy();
  });

  it('empty mates → roster 体内空态占位 + 头部新增按钮仍在；leader 卡仍在左列', () => {
    const leader = mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader' });
    const detail = mkDetail({
      members: [leader],
      leaderId: 'leader1',
      memberIds: ['leader1'],
    });
    render(<SeatsPanel {...mkProps({ detail })} />);
    expect(leaderCardRoot()).toBeTruthy();
    expect(addBtn()).toBeTruthy();
    // 成员 · 0
    expect(screen.getByText(/成员 · 0/)).toBeTruthy();
  });

  it('v0.0.170 页头 C 化：tabs 下划线式（border-b-2）', () => {
    render(<SeatsPanel {...mkProps()} />);
    const seats = seatsTab();
    expect(seats.className).toContain('border-b-2');
    expect(seats.className).toContain('border-b-fg');
    expect(panelTab().className).toContain('border-b-transparent');
  });

  it('v0.0.240 第二栏内嵌全景：任务 tab 出现（label「任务」，后端 ensure 注入）', async () => {
    render(<SeatsPanel {...mkProps()} />);
    // 后端返 task-only DSL（含 task_kanban view，由 ensureSystemEntities 注入）→ 任务 tab 在场
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
  });
});

describe('SeatsPanel — v0.0.244 视图筛选（在岗/全部 toggle + 计数口径）', () => {
  /** 1 leader + 1 deployed mate（张三）+ 1 benched mate（李四） */
  const mkViewDetail = () => {
    const leader = mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader', state: 'deployed' });
    const mate = mkMember({ id: 'm2', name: '张三', role: 'mate', sessionId: 'sess-m2', state: 'deployed' });
    const benched = mkMember({ id: 'm3', name: '李四', role: 'mate', sessionId: 'sess-m3', state: 'benched' });
    return mkDetail({ members: [leader, mate, benched], memberIds: ['leader1', 'm2', 'm3'] });
  };
  const benchedRowRoot = () => screen.getByText('李四').closest('div[class*="group"]') as HTMLElement;
  const activeSeg = () => screen.getByRole('button', { name: '在岗' });
  const allSeg = () => screen.getByRole('button', { name: '全部' });

  it('默认在岗视图：只见 deployed mate + 计数=在岗数；toggle 恒渲染且「在岗」active', async () => {
    const { container } = render(<SeatsPanel {...mkProps({ detail: mkViewDetail() })} />);
    await screen.findByText('张三');
    // benched 李四不在列表；计数=在岗 mate 数（1）
    expect(screen.queryByText('李四')).toBeNull();
    expect(screen.getByText(/成员 · 1/)).toBeTruthy();
    // toggle 恒渲染（不条件于存在 benched）+ data-action-key 锚点 + 「在岗」当前态
    expect(activeSeg().getAttribute('data-action-key')).toBe('studio.seats.view-active');
    expect(allSeg().getAttribute('data-action-key')).toBe('studio.seats.view-all');
    expect(activeSeg().getAttribute('data-active')).toBe('true');
    expect(allSeg().getAttribute('data-active')).toBe('false');
    // leader 卡不受过滤影响，仍在左列
    expect(leaderCardRoot()).toBeTruthy();
    expect(container.querySelector('main')).toBeTruthy();
  });

  it('切「全部」→ 见 benched 行（opacity-75 + mate · benched）+ 计数=全队 mate 数；切回「在岗」复原', async () => {
    render(<SeatsPanel {...mkProps({ detail: mkViewDetail() })} />);
    await screen.findByText('张三');
    fireEvent.click(allSeg());
    // benched 行出现：视觉弱化 opacity-75 + meta「mate · benched」；计数=全部 mate 数（2）
    await screen.findByText('李四');
    expect(benchedRowRoot().className).toContain('opacity-75');
    expect(screen.getByText('mate · benched')).toBeTruthy();
    expect(screen.getByText(/成员 · 2/)).toBeTruthy();
    expect(allSeg().getAttribute('data-active')).toBe('true');
    // 切回在岗 → benched 再隐藏 + 计数回 1
    fireEvent.click(activeSeg());
    expect(screen.queryByText('李四')).toBeNull();
    expect(screen.getByText(/成员 · 1/)).toBeTruthy();
  });

  it('空态跟随视图：mate 全 benched 时在岗视图显空态（成员 · 0），切全部见行', async () => {
    const leader = mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader', state: 'deployed' });
    const benched = mkMember({ id: 'm3', name: '李四', role: 'mate', sessionId: 'sess-m3', state: 'benched' });
    const detail = mkDetail({ members: [leader, benched], memberIds: ['leader1', 'm3'] });
    render(<SeatsPanel {...mkProps({ detail })} />);
    // 在岗视图：无 deployed mate → 空态 + 计数 0；toggle 仍在
    await screen.findByText(/成员 · 0/);
    expect(screen.getByText(/暂无成员/)).toBeTruthy();
    expect(activeSeg()).toBeTruthy();
    // 切全部 → benched 行可见 + 计数 1
    fireEvent.click(allSeg());
    await screen.findByText('李四');
    expect(screen.getByText(/成员 · 1/)).toBeTruthy();
  });
});

describe('SeatsPanel — 交互回调（seats tab）', () => {
  it('点某坐席卡「进入对话」→ onEnterChat(node)', async () => {
    const props = mkProps();
    render(<SeatsPanel {...props} />);
    await screen.findByText('张三');
    fireEvent.click(within(mateRowRoot()).getByRole('button', { name: '进入对话' }));
    expect(props.onEnterChat).toHaveBeenCalledTimes(1);
    const node = (props.onEnterChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(node?.sessionId).toBe('sess-m2');
    expect(node?.squadId).toBe('s1');
  });

  it('点队长卡群聊按钮 → onOpenGroupChat', () => {
    const props = mkProps();
    render(<SeatsPanel {...props} />);
    fireEvent.click(groupChatBtn());
    const gnode = (props.onOpenGroupChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(gnode?.sessionId).toBe('sess-group');
    expect(gnode?.squadId).toBe('s1');
  });

  it('点「+」卡 → onHire 触发（[v0.0.169] 主区 member-create 创建页）', () => {
    const props = mkProps();
    render(<SeatsPanel {...props} />);
    fireEvent.click(addBtn());
    expect(props.onHire).toHaveBeenCalledTimes(1);
  });

  it('v0.0.240 TokenWidget 整卡点击 → onOpenTokenStats(squadId)', async () => {
    const props = mkProps({ onOpenTokenStats: vi.fn() });
    render(<SeatsPanel {...props} />);
    fireEvent.click(tokenWidgetBtn());
    expect(props.onOpenTokenStats).toHaveBeenCalledWith('s1');
  });
});

describe('SeatsPanel — tab 内联切换（v0.0.168）', () => {
  it('默认 seats tab active；点管理 → 内联渲染 ManageTab，头部常驻', async () => {
    render(<SeatsPanel {...mkProps()} />);
    expect(seatsTab().getAttribute('data-active')).toBe('true');
    expect(panelTab().getAttribute('data-active')).toBe('false');
    fireEvent.click(panelTab());
    expect(panelTab().getAttribute('data-active')).toBe('true');
    expect(seatsTab()).toBeTruthy();
    await waitFor(() => expect(squadNameInput()).toBeTruthy());
    expect(manageField('squad 介绍')).toBeTruthy();
    expect(screen.queryByText('队长')).toBeNull();
    expect(screen.queryByText('张三')).toBeNull();
  });

  it('点自动工作 → 内联渲染 AutoworkTab', async () => {
    render(<SeatsPanel {...mkProps()} />);
    fireEvent.click(autoworkTabBtn());
    expect(autoworkTabBtn().getAttribute('data-active')).toBe('true');
    await waitFor(() => expect(screen.getByText('enableHeartBeat（自主性总开关）')).toBeTruthy());
    expect(seatsTab()).toBeTruthy();
  });

  it('从 panel tab 切回 seats → 恢复 leader 卡 + mate 行', async () => {
    render(<SeatsPanel {...mkProps()} />);
    fireEvent.click(panelTab());
    await waitFor(() => expect(squadNameInput()).toBeTruthy());
    fireEvent.click(seatsTab());
    await waitFor(() => expect(screen.getByText('队长')).toBeTruthy());
    expect(screen.getByText('张三')).toBeTruthy();
    expect(screen.queryByText('squad 名称')).toBeNull();
  });

  it('initialTab=panel → 首次渲染即在管理 tab', async () => {
    render(<SeatsPanel {...mkProps({ initialTab: 'panel' })} />);
    expect(panelTab().getAttribute('data-active')).toBe('true');
    await waitFor(() => expect(squadNameInput()).toBeTruthy());
  });
});

describe('SeatsPanel — v0.0.168 右键复制 Session ID 浮层', () => {
  const writeText = vi.fn();
  beforeAll(() => {
    Object.assign(navigator, { clipboard: { writeText } });
  });
  afterEach(() => {
    writeText.mockReset();
  });

  it('右键 mate 坐席卡 → 出现复制浮层（sessionId=member.sessionId）', async () => {
    const { container } = render(<SeatsPanel {...mkProps()} />);
    await screen.findByText('张三');
    fireEvent.contextMenu(mateRowRoot(), { clientX: 100, clientY: 100 });
    const copy = await screen.findByRole('button', { name: '复制 Session ID' });
    const menu = copy.parentElement as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.parentElement).toBe(document.body);
    expect(mainRoot(container)!.contains(menu)).toBe(false);
    writeText.mockResolvedValue(undefined);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith('sess-m2');
  });

  it('右键 leader 坐席卡 → 复制 leader sessionId', async () => {
    render(<SeatsPanel {...mkProps()} />);
    await screen.findByText('队长');
    fireEvent.contextMenu(leaderCardRoot(), { clientX: 50, clientY: 60 });
    writeText.mockResolvedValue(undefined);
    fireEvent.click(await screen.findByRole('button', { name: '复制 Session ID' }));
    expect(writeText).toHaveBeenCalledWith('sess-leader');
  });

  it('右键队长卡群聊按钮 → 复制 squadChat sessionId', async () => {
    render(<SeatsPanel {...mkProps()} />);
    fireEvent.contextMenu(groupChatBtn(), { clientX: 30, clientY: 40 });
    writeText.mockResolvedValue(undefined);
    fireEvent.click(await screen.findByRole('button', { name: '复制 Session ID' }));
    expect(writeText).toHaveBeenCalledWith('sess-group');
  });
});
