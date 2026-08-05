/**
 * @vitest-environment jsdom
 * component-panorama-route 单测 —— task_kanban tab 恒在（system entity 由后端注入）
 * 参考: specs/ui/components/studio-page/component-panorama-route.md
 *
 * v0.0.243：task 改普通 entity（落盘进 schema），后端 ensureSystemEntities 恒返含 task 的 DSL.
 * mock getPanoramaSchema 返 task-only DSL（模拟首访问 squad 后端 ensure 后状态），不再 dsl=null 合成.
 *
 * 覆盖：
 *   1. task-only DSL → task_kanban tab + 渲染 panorama-view
 *   2. DSL 含 leader entity → task tab + 动态 tab
 *   3. 加载失败 → error 态 + 重试按钮
 *   4. SSE schema_update → 重拉 schema 重建 tab 装配
 *   5. 内嵌组件：无返回键头部（v0.0.240 删 onBack）
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

const mocks = vi.hoisted(() => ({
  getPanoramaSchema: vi.fn(),
  listPanoramaEntities: vi.fn(),
  listPanoramaEvents: vi.fn(),
  subscribe: vi.fn(),
  onAtLeader: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/panorama-api'));
vi.mock(apiPath, () => ({
  getPanoramaSchema: mocks.getPanoramaSchema,
  listPanoramaEntities: mocks.listPanoramaEntities,
  listPanoramaEvents: mocks.listPanoramaEvents,
}));
const ssePath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
vi.mock(ssePath, () => ({
  getSseClient: () => ({ subscribe: mocks.subscribe }),
}));

import { PanoramaRoute } from '../component-panorama-route';

// 后端 ensureSystemEntities 后的 task-only DSL（首访问 squad 的真实返回；
// 前端不再合成 builtin，task entity 已在 DSL 内）
const TASK_ONLY_DSL = `
meta:
  version: '1.0'
entities:
  task:
    system: true
    label: 任务
    id_field: id
    fields:
      id: { type: string, required: true, label: ID }
      title: { type: string, required: true, max: 200, label: 标题 }
      status: { type: enum, values: [todo, waiting, in_progress, done], required: true, label: 状态 }
    states:
      field: status
      initial: todo
      transitions:
        todo: [{ to: in_progress }, { to: waiting }]
        waiting: [{ to: todo }]
        in_progress: [{ to: done }]
      terminal: [done]
    display:
      status_labels: { todo: 未开始, waiting: 等待中, in_progress: 进行中, done: 已结束 }
views:
  - id: task_kanban
    label: 任务
    entity: task
    component: kanban
    group_by: status
    columns: [todo, waiting, in_progress, done]
    card: { title: '{title}', badges: [owner, status] }
`;

const DSL = `
meta:
  version: '1.0'
entities:
  task:
    system: true
    label: 任务
    id_field: id
    fields:
      id: { type: string, required: true }
      title: { type: string, required: true, max: 200 }
      status: { type: enum, values: [todo, waiting, in_progress, done], required: true }
    states: { field: status, initial: todo, transitions: { todo: [{to: in_progress}], in_progress: [{to: done}] }, terminal: [done] }
  item:
    label: 条目
    id_field: id
    fields:
      id: { type: string }
      status: { type: enum, values: [open, done] }
views:
  - id: task_kanban
    label: 任务
    entity: task
    component: kanban
    group_by: status
    columns: [todo, waiting, in_progress, done]
    card: { title: '{title}', badges: [owner, status] }
  - id: item_table
    label: 条目表
    component: table
    entity: item
    columns: [id, status]
`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPanoramaEntities.mockResolvedValue([]);
  mocks.listPanoramaEvents.mockResolvedValue([]);
  mocks.subscribe.mockResolvedValue({ subId: 'x', topic: 'panorama', group: 'g', unsubscribe: vi.fn() });
});

describe('PanoramaRoute — task entity 落盘后 task tab 恒在', () => {
  it('task-only DSL → task_kanban tab（任务）+ 渲染 panorama-view（refresh 按钮）', async () => {
    mocks.getPanoramaSchema.mockResolvedValue(TASK_ONLY_DSL);
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    // task_kanban tab 出现 + activeTab 校正后渲染 panorama-view（toolbar refresh）
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: /刷新/ })).toBeTruthy());
    // 订阅 SSE topic=panorama + per-squad group
    expect(mocks.subscribe).toHaveBeenCalledWith('panorama', 'panorama:squad:sq1:entity', expect.any(Function));
  });

  it('DSL 含 leader entity → task 任务 tab + 动态「条目表」tab（task 首项）', async () => {
    mocks.getPanoramaSchema.mockResolvedValue(DSL);
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '条目表' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '任务' })).toBeTruthy();
  });

  it('加载失败 → error 态 + 重试按钮；重试后恢复', async () => {
    mocks.getPanoramaSchema.mockRejectedValue(new Error('boom'));
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    mocks.getPanoramaSchema.mockResolvedValue(DSL);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
  });

  it('SSE 收 panorama_schema_update → 重拉 schema 重建 tab 装配', async () => {
    mocks.getPanoramaSchema.mockResolvedValue(TASK_ONLY_DSL);
    let handler: ((frame: { data: unknown }) => void) | null = null;
    mocks.subscribe.mockImplementation(async (_t: string, _g: string, h: (frame: { data: unknown }) => void) => {
      handler = h;
      return { subId: 'x', topic: 'panorama', group: 'g', unsubscribe: vi.fn() };
    });
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
    // schema 变为含 leader entity → 重建：动态条目表 tab 出现
    mocks.getPanoramaSchema.mockResolvedValue(DSL);
    handler!({ data: { type: 'panorama_schema_update', squadId: 'sq1', seq: 2 } });
    await waitFor(() => expect(screen.getByRole('button', { name: '条目表' })).toBeTruthy());
  });

  it('v0.0.240 内嵌：无返回键头部（onBack 已删）', async () => {
    mocks.getPanoramaSchema.mockResolvedValue(TASK_ONLY_DSL);
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /返回/ })).toBeNull();
  });
});

describe('PanoramaRoute — v0.0.243 固定「更多」tab 永远在最右', () => {
  it('task-only schema 也含「更多」tab（永远在最右）', async () => {
    mocks.getPanoramaSchema.mockResolvedValue(TASK_ONLY_DSL);
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
    // 「更多」tab 出现（i18n key panorama.tabs.more = "更多"）
    expect(screen.getByRole('button', { name: '更多' })).toBeTruthy();
  });

  it('点击「更多」→ 渲 PanoramaIdle 引导卡（非 PanoramaView，无 refresh 按钮）', async () => {
    mocks.getPanoramaSchema.mockResolvedValue(DSL);
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '条目表' })).toBeTruthy());
    // 初始在动态 view（PanoramaView 的 refresh 按钮在场）
    await waitFor(() => expect(screen.getByRole('button', { name: /刷新/ })).toBeTruthy());
    // 点击「更多」tab → 切到 PanoramaIdle（refresh 按钮消失，引导按钮「找 leader 搭看板」出现）
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    // 用 /搭看板/ 稳定部分匹配降低文案微调维护成本
    await waitFor(() => expect(screen.getByRole('button', { name: /搭看板/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /刷新/ })).toBeNull();
  });

  it('「更多」tab 点「找 leader 搭看板」→ 调 onAtLeader 回调', async () => {
    mocks.getPanoramaSchema.mockResolvedValue(TASK_ONLY_DSL);
    render(<PanoramaRoute squadId="sq1" onAtLeader={mocks.onAtLeader} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '任务' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /搭看板/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /搭看板/ }));
    expect(mocks.onAtLeader).toHaveBeenCalledTimes(1);
  });
});
