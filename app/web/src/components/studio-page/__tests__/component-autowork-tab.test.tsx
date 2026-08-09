/**
 * @vitest-environment jsdom
 * component-autowork-tab 单测（v0.0.57 新建容器：toggle + budget + history 三块组合渲染）
 * 参考: specs/ui/components/studio-page/squad-panel.md §组合（autowork-tab 容器）
 *       states/v0.0.57.squad_ui_1/design.md「Task B / D3」（autowork 扩为组合页）
 *
 * vi.mock 绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { AutoworkTab } from '../component-autowork-tab';
import { mkDetail } from './_fixtures';

// [v0.0.62 i18n] 启动 i18next：autowork 三块均走 studio ns
beforeAll(async () => {
  await initI18n('zh-CN');
});

// 绝对路径 mock squad-api（BudgetMeter → getBudgetUsage；AutoWorkHistory → getSchedulerHistory）
const mocks = vi.hoisted(() => ({
  getBudgetUsage: vi.fn(),
  getSchedulerHistory: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/squad-api'));
vi.mock(apiPath, () => mocks);

/** autonomy toggle 根（label 定位 → closest data-squad-id 容器） */
const autonomyRoot = () =>
  screen.getByText('enableHeartBeat（自主性总开关）').closest('[data-squad-id]') as HTMLElement;

describe('AutoworkTab（v0.0.57 新建容器）', () => {
  beforeEach(() => {
    mocks.getBudgetUsage.mockResolvedValue({
      squadId: 's1',
      limit: 1000000,
      window: 'daily',
      consumed: 200000,
      remaining: 800000,
      windowStart: '2026-06-29T16:00:00.000Z',
      windowEnd: '2026-06-30T16:00:00.000Z',
      perSession: [],
      timezone: 'Asia/Shanghai',
    } as never);
    mocks.getSchedulerHistory.mockResolvedValue([] as never);
  });

  afterEach(() => {
    cleanup();
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  it('渲染 autowork-tab 容器根 + 三块都在（toggle + budget + history）', async () => {
    const { container } = render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} />);

    // 容器根（垂直堆叠 flex-col）
    expect(container.firstElementChild).toBeTruthy();

    // 三块组合成员都在 —— 自主性归位（toggle+budget 从 manage-tab 迁来；history 重组为容器成员）
    expect(autonomyRoot()).toBeTruthy();
    expect(within(autonomyRoot()).getByRole('switch')).toBeTruthy();
    expect(screen.getByText(/budget（团队 token 预算/)).toBeTruthy();
    // history 列表根（seed 空历史 → empty banner）
    await waitFor(() => expect(screen.getByText('暂无自动工作记录')).toBeTruthy());
  });

  it('反映 detail.enableHeartBeat 当前态（killswitch off 态存在）', () => {
    // mkDetail 默认 enableHeartBeat=false → off 态
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} />);
    expect(within(autonomyRoot()).getByText('已暂停自主工作，成员仅响应对话')).toBeTruthy();
    expect(within(autonomyRoot()).queryByText('自主工作已开启，成员将按心跳节奏主动运转')).toBeNull();
  });

  // [v0.0.292] GroupChatToggle 迁出到 manage-tab，autowork-tab 不再渲染群聊开关
  // —— 原「v0.0.270 群聊开关」两个 case 已删除

  it('点击 toggle switch → 上抛 PATCH enableHeartBeat（透传 onSaveMeta）', async () => {
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={onSaveMeta} />);

    const sw = within(autonomyRoot()).getByRole('switch');
    fireEvent.click(sw);

    // PATCH body：当前 off → 翻转为 true
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledWith({ enableHeartBeat: true }));
  });

  it('detail.enableHeartBeat=true 时 on 态存在（off 态不存在）', () => {
    render(<AutoworkTab detail={mkDetail({ enableHeartBeat: true })} onSaveMeta={async () => {}} />);
    expect(within(autonomyRoot()).getByText('自主工作已开启，成员将按心跳节奏主动运转')).toBeTruthy();
    expect(within(autonomyRoot()).queryByText('已暂停自主工作，成员仅响应对话')).toBeNull();
  });

  it('BudgetMeter 异步拉取后渲染 consumed 数字节点', async () => {
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} />);
    // consumed 节点仅在 usage 加载完成后出现（200000 → toLocaleString '200,000'）
    expect(await screen.findByText('200,000')).toBeTruthy();
    expect(mocks.getBudgetUsage).toHaveBeenCalledWith('s1');
  });

  it('AutoWorkHistory 调 GET /scheduler/history', async () => {
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} />);
    await waitFor(() => expect(mocks.getSchedulerHistory).toHaveBeenCalledWith('s1', undefined));
  });
});
