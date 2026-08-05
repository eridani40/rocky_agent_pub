/**
 * @vitest-environment jsdom
 * component-panorama-view 单测 —— v0.0.196 受控化（tab 条上提 route，本组件吃 activeViewId）
 * 参考: specs/ui/components/studio-page/component-panorama-view.md v2.0（受控 activeViewId）
 *       specs/ui/components/studio-page/component-panorama-entity-modal.md v1.0（字段类型→控件映射）
 *
 * vi.mock 绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效；__dirname 派生 portable 路径）。
 * 定位策略（v0.0.197 删 testid）：三原语=data-view-id 锚点；kanban 列=列头文案的 section；
 *   卡片=标题文案的 article；表格行=单元格文案的 tr；弹层字段=label 的兄弟控件；toolbar=按钮文案。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { PanoramaSchema } from '../panorama-types';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

// mock panorama-api（避免真 fetch；实体数据内存 fixture）
const mocks = vi.hoisted(() => ({
  listPanoramaEntities: vi.fn(),
  listPanoramaEvents: vi.fn(),
  createPanoramaEntity: vi.fn(),
  patchPanoramaEntity: vi.fn(),
  transitionPanoramaEntity: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/panorama-api'));
vi.mock(apiPath, () => mocks);

import { PanoramaView } from '../component-panorama-view';

/** DSL fixture：2 实体（pipeline_run 全字段类型集 + deployment 带 ref）× 4 view（3 原语 + table#2） */
function mkSchema(): PanoramaSchema {
  return {
    entities: {
      pipeline_run: {
        label: '流水线运行',
        id_field: 'id',
        fields: {
          id: { type: 'string' },
          branch: { type: 'string', label: '分支' },
          status: { type: 'enum', values: ['queued', 'running', 'success', 'failed'], label: '状态' },
          duration_sec: { type: 'number' },
          active: { type: 'boolean' },
          started_at: { type: 'datetime' },
        },
        states: {
          field: 'status',
          initial: 'queued',
          transitions: { queued: [{ to: 'running' }], running: [{ to: 'success' }], success: [], failed: [] },
          terminal: ['success', 'failed'],
        },
        display: {
          status_labels: { queued: '排队中', running: '运行中', success: '成功', failed: '失败' },
          status_colors: { queued: '#8b949e', running: '#4c9aff', success: '#3fb950', failed: '#f85149' },
        },
      },
      deployment: {
        label: '部署',
        id_field: 'id',
        fields: {
          id: { type: 'string' },
          env: { type: 'enum', values: ['staging', 'prod'], label: '环境' },
          region: { type: 'enum', values: ['east', 'west'] },
          pipeline_run_id: { type: 'ref', entity: 'pipeline_run' },
        },
        display: {
          env_labels: { staging: '预发', prod: '生产' },
        },
      },
    },
    views: [
      {
        id: 'run_kanban', label: '流水线看板', component: 'kanban', entity: 'pipeline_run',
        group_by: 'status', columns: ['queued', 'running', 'success', 'failed'],
        card: { title: '{id} · {branch}', badges: ['duration_sec'], footer: 'by {triggered_by}' },
      },
      { id: 'run_table', label: '运行记录', component: 'table', entity: 'pipeline_run', columns: ['id', 'branch', 'status'] },
      { id: 'run_chart', label: '近7天趋势', component: 'bar_chart', entity: 'pipeline_run', bucket: { field: 'started_at', unit: 'day', days: 7 }, stack_by: 'status' },
      { id: 'deploy_table', label: '部署列表', component: 'table', entity: 'deployment', columns: ['id', 'env', 'region'] },
    ],
  };
}

const RUNS: Record<string, unknown>[] = [
  { id: 'RUN-1', branch: 'main', status: 'queued', duration_sec: 42, active: true, started_at: new Date().toISOString(), triggered_by: 'alice' },
  { id: 'RUN-2', branch: 'dev', status: 'running', duration_sec: 7, active: false, started_at: new Date().toISOString(), triggered_by: 'bob' },
];
const DEPLOYS: Record<string, unknown>[] = [{ id: 'D-1', env: 'staging', region: 'east', pipeline_run_id: 'RUN-1' }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPanoramaEntities.mockImplementation(async (_sid: string, entity: string) =>
    entity === 'deployment' ? [...DEPLOYS] : [...RUNS],
  );
  mocks.listPanoramaEvents.mockResolvedValue([]);
});

// —— 语义/结构定位辅助 —— //
/** 三原语渲染区（data-view-id 锚点） */
const viewRoot = (viewId: string) => document.querySelector(`[data-view-id="${viewId}"]`);
/** kanban 列（列头文案的 section 祖先） */
const kanbanColumn = (headerLabel: string) => screen.getByText(headerLabel).closest('section') as HTMLElement;
/** kanban 卡片（标题文案的 article 祖先） */
const kanbanCard = (titleText: string) => screen.getByText(titleText).closest('article') as HTMLElement;
/** 表格行（单元格文案的 tr 祖先） */
const tableRow = (cellText: string) => screen.getByText(cellText).closest('tr') as HTMLElement;
/** toolbar 新建按钮（文案「新建{实体label}」） */
const toolbarCreate = () => screen.getByRole('button', { name: /新建/ });
/** toolbar 刷新按钮 */
const toolbarRefresh = () => screen.getByRole('button', { name: '刷新' });
/** 弹层字段控件（label 的兄弟 input，无则下拉 trigger button） */
function fieldControl(labelText: string): HTMLElement {
  const label = screen.getByText(new RegExp(`^${labelText}`), { selector: 'label' });
  const wrap = label.closest('div')!;
  return (wrap.querySelector('input') ?? wrap.querySelector('button')) as HTMLElement;
}
const fieldInput = (labelText: string) => fieldControl(labelText) as HTMLInputElement;

describe('PanoramaView — 受控 view 渲染（v0.0.196 tab 条上提 route）', () => {
  it('v0.0.196 tab 条上提 route：本组件不渲 tab 按钮（受控 activeViewId 渲 kanban）', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(viewRoot('run_kanban')).toBeTruthy());
    // v0.0.196 tab 条已上提 route，本组件不再渲 view label 按钮
    expect(screen.queryByRole('button', { name: '流水线看板' })).toBeNull();
    expect(screen.queryByRole('button', { name: '运行记录' })).toBeNull();
  });

  it('kanban：按 states.field 分 4 列 + 卡片标题插值 {id} · {branch}', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(kanbanCard('RUN-1 · main')).toBeTruthy());
    // 4 列（列头走 display.status_labels 中文）
    for (const label of ['排队中', '运行中', '成功', '失败']) {
      expect(kanbanColumn(label)).toBeTruthy();
    }
    expect(kanbanCard('RUN-1 · main').textContent).toContain('RUN-1 · main');
    // 列头 label 走 display.status_labels
    expect(kanbanColumn('排队中').textContent).toContain('排队中');
  });

  it('切 activeViewId（rerender 传新值）→ table 渲染（行=实例，列=DSL columns）', async () => {
    const { rerender } = render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(viewRoot('run_kanban')).toBeTruthy());
    // v0.0.196 受控改造：切 view 用 rerender 传新 activeViewId
    rerender(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_table" />);
    await waitFor(() => expect(viewRoot('run_table')).toBeTruthy());
    expect(tableRow('RUN-2').textContent).toContain('RUN-2');
    // 状态列渲染中文 label
    expect(tableRow('RUN-2').textContent).toContain('运行中');
  });

  it('切 activeViewId → bar_chart 渲染（桶 + 图例）', async () => {
    const { rerender } = render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(viewRoot('run_kanban')).toBeTruthy());
    rerender(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_chart" />);
    await waitFor(() => expect(viewRoot('run_chart')).toBeTruthy());
    // stack_by=status → 图例含中文状态名
    const chart = viewRoot('run_chart') as HTMLElement;
    expect(chart.textContent).toContain('排队中');
    expect(chart.textContent).toContain('运行中');
  });

  it('toolbar：+新建 / 刷新；刷新重拉当前实体', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(toolbarCreate()).toBeTruthy());
    expect(toolbarCreate().textContent).toContain('流水线运行');
    const before = mocks.listPanoramaEntities.mock.calls.length;
    fireEvent.click(toolbarRefresh());
    await waitFor(() => expect(mocks.listPanoramaEntities.mock.calls.length).toBeGreaterThan(before));
  });

  it('table 表头 = field.label（中文），无 label 兜底字段名', async () => {
    const { rerender } = render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(viewRoot('run_kanban')).toBeTruthy());
    rerender(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_table" />);
    await waitFor(() => expect(viewRoot('run_table')).toBeTruthy());
    const thead = document.querySelector('table')!.querySelector('thead')!;
    // branch/status 配了 label → 中文表头；id 未配 → 兜底字段名
    expect(thead.textContent).toContain('分支');
    expect(thead.textContent).toContain('状态');
    expect(thead.textContent).toContain('id');
  });

  it('table enum 列 = display labels（中文），无 labels 配置兜底原值', async () => {
    const { rerender } = render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(viewRoot('run_kanban')).toBeTruthy());
    rerender(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="deploy_table" />);
    await waitFor(() => expect(viewRoot('deploy_table')).toBeTruthy());
    const row = tableRow('D-1');
    // env 非状态机 enum → display.env_labels 映射中文；region 无 labels → 兜底原值
    expect(row.textContent).toContain('预发');
    expect(row.textContent).not.toContain('staging');
    expect(row.textContent).toContain('east');
    // 表头 env 配了 label → 中文；region 未配 → 兜底字段名
    const head = document.querySelector('table')!.querySelector('thead')!.textContent!;
    expect(head).toContain('环境');
    expect(head).toContain('region');
  });
});

describe('PanoramaEntityModal — 字段集动态生成', () => {
  it('create 弹层：6 种字段类型 → 对应控件（input/toggle/selector）', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(toolbarCreate()).toBeTruthy());
    fireEvent.click(toolbarCreate());
    await waitFor(() => expect(screen.getByText('新建 流水线运行')).toBeTruthy());
    // string → text input
    expect(fieldInput('id').getAttribute('type')).toBe('text');
    expect(fieldInput('分支').getAttribute('type')).toBe('text');
    // number → number input
    expect(fieldInput('duration_sec').getAttribute('type')).toBe('number');
    // boolean → checkbox toggle
    expect(fieldInput('active').getAttribute('type')).toBe('checkbox');
    // datetime → datetime-local input
    expect(fieldInput('started_at').getAttribute('type')).toBe('datetime-local');
    // enum（≤4 选项 → ChoiceCards）→ selector
    expect(screen.getByRole('button', { name: /queued/ })).toBeTruthy();
    // create 默认 states.initial=queued 选中
    expect(screen.getByRole('button', { name: /queued/ }).getAttribute('data-selected')).toBe('true');
  });

  it('edit 弹层：initial 快照回填 + id_field 只读', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(kanbanCard('RUN-1 · main')).toBeTruthy());
    fireEvent.click(kanbanCard('RUN-1 · main'));
    await waitFor(() => expect(screen.getByText('编辑 流水线运行')).toBeTruthy());
    const idInput = fieldInput('id');
    expect(idInput.value).toBe('RUN-1');
    expect(idInput.disabled).toBe(true);
    expect(fieldInput('分支').value).toBe('main');
  });

  it('edit 弹层：状态字段只读（中文 label 呈现，无 selector 可编辑）', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(kanbanCard('RUN-1 · main')).toBeTruthy());
    fireEvent.click(kanbanCard('RUN-1 · main'));
    await waitFor(() => expect(screen.getByText('编辑 流水线运行')).toBeTruthy());
    // 状态字段不再是可编辑 selector（无 queued 选项按钮）
    expect(screen.queryByRole('button', { name: /queued/ })).toBeNull();
    // 退化为只读 input，值为 display.status_labels 中文
    const statusInput = fieldInput('状态');
    expect(statusInput.disabled).toBe(true);
    expect(statusInput.value).toBe('排队中');
  });

  it('ref 字段 → 实例选择 selector（目标实体实例作选项）', async () => {
    const { rerender } = render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(viewRoot('run_kanban')).toBeTruthy());
    rerender(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="deploy_table" />);
    await waitFor(() => expect(viewRoot('deploy_table')).toBeTruthy());
    fireEvent.click(toolbarCreate());
    await waitFor(() => expect(screen.getByText('新建 部署')).toBeTruthy());
    expect(fieldControl('pipeline_run_id')).toBeTruthy();
  });

  it('required 空提交 → 不调 API（前端拦截）', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(toolbarCreate()).toBeTruthy());
    fireEvent.click(toolbarCreate());
    await waitFor(() => expect(screen.getByText('新建 流水线运行')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(mocks.createPanoramaEntity).not.toHaveBeenCalled();
  });
});

describe('PanoramaKanban — v0.0.223 响应式列宽 + 甬道色块多通道（PRD §2.2）', () => {
  // jsdom 对 hex 色的序列化不稳定（hex 原样或 rgb()），统一容忍两种表达
  const expectColor = (actual: string, hex: string, rgb: string) => {
    expect(actual === hex || actual.replace(/\s/g, '') === rgb.replace(/\s/g, '')).toBe(true);
  };

  it('列宽：min-w-[200px] flex-1（不再 w-[240px] shrink-0），overflow-x-auto 兜底保留', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(kanbanColumn('排队中')).toBeTruthy());
    const col = kanbanColumn('排队中');
    expect(col.className).toContain('min-w-[200px]');
    expect(col.className).toContain('flex-1');
    expect(col.className).not.toContain('w-[240px]');
    expect(col.className).not.toContain('shrink-0');
    // 容器 overflow-x-auto 兜底
    expect((viewRoot('run_kanban') as HTMLElement).className).toContain('overflow-x-auto');
  });

  it('甬道多通道：列顶全宽色带 + 列头底色（rgba 12%）+ 状态文字带色（同一 statusColor）', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(kanbanColumn('运行中')).toBeTruthy());
    const col = kanbanColumn('运行中');
    // ① 列顶全宽色带（section 首个子元素，h-1 w-full，bg=statusColor）
    const band = col.firstElementChild as HTMLElement;
    expect(band.className).toContain('h-1');
    expect(band.className).toContain('w-full');
    expectColor(band.style.background, '#4c9aff', 'rgb(76,154,255)');
    // ② 列头底色（statusColor 12% alpha → rgba(76,154,255,0.12)）
    const header = col.querySelector('header') as HTMLElement;
    expect(header.style.background.replace(/\s/g, '')).toContain('rgba(76,154,255,0.12)');
    // ③ 状态文字带色（label span style.color = statusColor）
    const label = screen.getByText('运行中') as HTMLElement;
    expectColor(label.style.color, '#4c9aff', 'rgb(76,154,255)');
    // 旧 8×8 圆点已移除（列头无 rounded-full 色点）
    expect(header.querySelector('span.rounded-full')).toBeNull();
  });

  it('卡片左缘竖条：border-l-4 + borderLeftColor = 所属列 statusColor', async () => {
    render(<PanoramaView squadId="s1" schema={mkSchema()} activeViewId="run_kanban" />);
    await waitFor(() => expect(kanbanCard('RUN-1 · main')).toBeTruthy());
    // RUN-1 status=queued → #8b949e
    const card1 = kanbanCard('RUN-1 · main');
    expect(card1.className).toContain('border-l-4');
    expectColor(card1.style.borderLeftColor, '#8b949e', 'rgb(139,148,158)');
    // RUN-2 status=running → #4c9aff
    const card2 = kanbanCard('RUN-2 · dev');
    expectColor(card2.style.borderLeftColor, '#4c9aff', 'rgb(76,154,255)');
  });
});
