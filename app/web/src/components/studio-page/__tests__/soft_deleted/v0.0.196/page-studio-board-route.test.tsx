/**
 * @vitest-environment jsdom
 * page-studio board 路由态单测（v0.0.168 修订：入口迁首页坐席团队入口卡）
 * 参考: specs/ui/components/studio-page/_overview.md §1（主区四态：board 路由态独立于 panel/chat/member）
 *       specs/ui/components/studio-page/squad-board.md（board 路由 + board-topbar-back-btn 返回入口）
 *       specs/ui/overall/06-studio.md §5（v0.0.168：侧栏树删除；board/chat 入口收敛到首页 seats）
 *
 * v0.0.168 修订：侧栏 accordion 二级树已删；board 入口从「树 squad-tree-board-{squadId}」迁到
 *   「首页 seats 团队入口卡 seat-team-entry-board」。SquadBoard 路由态本身逻辑不变，仅入口切换。
 *
 * 覆盖：
 *   - 首页 seats「团队看板」入口卡点击 → 主区切 board 路由态渲染 SquadBoard（隔离 mock）
 *   - board 路由态头部 back-btn（「返回」按钮）出现
 *   - 点 back-btn → 主区回到 seats 面板（board 卡渲染消失，seats-panel 回归）
 *
 * 隔离策略：mock SquadBoard（避开 getBoard 真实 fetch），断言 MainView 切到 board 态。
 * vi.mock 绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效；用 __dirname 派生 portable 路径）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { mkDetail, mkSummary } from './_fixtures';

// [v0.0.62 i18n] 启动 i18next：board 路由副标题 + 首页团队入口卡走 studio ns
beforeAll(async () => {
  await initI18n('zh-CN');
});

// 绝对路径 mock squad-api（含 sidebar 的 getSquad；getBoard 防 SquadBoard 真调）
// [v0.0.165 T5] 补 getBudgetUsage（use-seats-data 依赖，SeatsPanel 挂载即拉）
const mocks = vi.hoisted(() => ({
  listSquads: vi.fn(),
  getSquad: vi.fn(),
  getBoard: vi.fn(),
  getCharterHistory: vi.fn(),
  getBudgetUsage: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/squad-api'));
vi.mock(apiPath, () => mocks);

// chat-api mock（page-studio import 链 StudioChatRouter → chat-api，防真 fetch）
// [v0.0.165 T5] 补 listSessions（use-seats-data 依赖）
const chatMocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  postMessage: vi.fn(),
  getSummary: vi.fn(),
  postCompact: vi.fn(),
  listSessions: vi.fn(),
}));
const chatApiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/chat-api'));
vi.mock(chatApiPath, () => chatMocks);

// mock SquadBoard：board 路由态触发的标志（隔离看板内部 getBoard/三视图逻辑，专注 page-studio 路由）
// 用 React.createElement 避免 hoisted factory 内 JSX runtime 顺序问题。
const React = vi.hoisted(() => require('react'));
const boardPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../component-squad-board'));
vi.mock(boardPath, () => ({
  SquadBoard: (props: { squadId: string }) =>
    React.createElement('div', { 'data-squad-id': props.squadId }, 'mock SquadBoard'),
}));

import { PageStudio } from '../page-studio';

describe('PageStudio board 路由态（v0.0.168 修订：入口迁首页 seats）', () => {
  beforeEach(() => {
    cleanup();
    mocks.listSquads.mockResolvedValue([mkSummary()]);
    mocks.getSquad.mockResolvedValue(mkDetail());
    mocks.getBoard.mockResolvedValue({
      squadId: 's1',
      goals: { total: 0, items: [] },
      requirements: { total: 0, items: [] },
      tasks: { total: 0, items: [] },
    });
    mocks.getCharterHistory.mockResolvedValue([]);
    chatMocks.getMessages.mockResolvedValue({ items: [], hasMore: false });
    chatMocks.postMessage.mockResolvedValue({ runId: 'r1' });
    chatMocks.getSummary.mockResolvedValue({ summary: null });
    chatMocks.postCompact.mockResolvedValue({ ok: true });
    // [v0.0.165 T5] listSessions（空列表）+ getBudgetUsage（未配 budget → null 降级）
    chatMocks.listSessions.mockResolvedValue([]);
    mocks.getBudgetUsage.mockResolvedValue({
      squadId: 's1', limit: -1, window: 'daily', consumed: 0, remaining: -1,
      windowStart: '', windowEnd: '', perSession: [], timezone: 'UTC',
    });
  });
  afterEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    for (const fn of Object.values(chatMocks)) fn.mockReset();
  });

  it('v0.0.168：首页坐席「团队看板」入口卡点击 → 主区切 board 路由态（渲染 SquadBoard）', async () => {
    render(<PageStudio />);
    // 首页 seats-panel 挂载后团队入口行渲染（「团队看板」入口卡 = seats 态信号）
    const boardEntry = await screen.findByRole('button', { name: /团队看板/ });
    // 点击前：主区无 mock SquadBoard
    expect(screen.queryByText('mock SquadBoard')).toBeNull();
    fireEvent.click(boardEntry);
    // 主区切 board 路由态：mock SquadBoard 渲染
    const board = await screen.findByText('mock SquadBoard');
    expect((board as HTMLElement).dataset.squadId).toBe('s1');
    // 首页 seats 已离开（入口卡消失）
    expect(screen.queryByRole('button', { name: /团队看板/ })).toBeNull();
  });

  it('v0.0.168：board 路由态渲染返回键（BoardRoute 头部）', async () => {
    render(<PageStudio />);
    fireEvent.click(await screen.findByRole('button', { name: /团队看板/ }));
    await screen.findByText('mock SquadBoard');
    // BoardRoute 顶部返回键（v0.0.168 新增）
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
  });

  it('v0.0.168：点 back-btn → 主区回 seats-panel（board 卡消失，坐席回归）', async () => {
    render(<PageStudio />);
    fireEvent.click(await screen.findByRole('button', { name: /团队看板/ }));
    await screen.findByText('mock SquadBoard');
    // 点返回键 → fallbackToSeats
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    // 主区回到 seats-panel（board 已卸载，入口卡回归）
    expect(await screen.findByRole('button', { name: /团队看板/ })).toBeTruthy();
    expect(screen.queryByText('mock SquadBoard')).toBeNull();
  });
});
