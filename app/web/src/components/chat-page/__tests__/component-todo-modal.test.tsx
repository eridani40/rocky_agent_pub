// @vitest-environment jsdom
/**
 * component-todo-modal 单测
 * 参考: specs/ui/components/chat-page/component-todo-modal.md（组件契约 + 可见文案）
 *       specs/prd/version_logs/v0.0.223.md §2.6（双层树 + 悬停详情 + 只读）
 *
 * 覆盖：
 *   - 双层树：主 item（状态徽章 + desc + 步骤进度 N/M）+ 步骤行（缩进 + 状态徽章 + desc）
 *   - 悬停状态徽章 → 结构化详情（source/output/memo + refId）；移出收起
 *   - hover 收敛：步骤行 / 主 item 行其余区域 hover 不触发详情弹层（仅状态徽章触发，v0.0.240 收窄）
 *   - source/output/memo 全空 → 悬停不弹详情面板
 *   - 打开（挂载）调一次 crud.refetch()（skills 弹层先例）
 *   - 尺寸：面板 w-[720px] max-w-[92vw] max-h-[88vh]
 *   - 徽章色板：done=--success 绿 / not_started=muted 灰（色相拉开）
 *   - 空态（无 todo）→ idle 文案；加载态 → loading；错误态 → role=alert
 *   - 关闭：关闭按钮 / 遮罩点击 → onClose
 *   - 只读：无新建/编辑/删除按钮
 *
 * mock 策略：crud 直接以 prop 构造（useTodoCrud 不 mock——本组件契约是 prop 下传）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { TodoItem } from '../../../lib/todo-api';
import type { TodoCrud } from '../use-todo-crud';

beforeAll(async () => {
  await initI18n('zh-CN');
});

import { ComponentTodoModal } from '../component-todo-modal';

function mkItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 't1',
    desc: '写 spec 文档',
    status: 'in_progress',
    steps: [],
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
    ...overrides,
  };
}

function mkCrud(items: TodoItem[], overrides: Partial<TodoCrud> = {}): TodoCrud {
  return {
    items,
    loading: false,
    error: null,
    busyId: null,
    pendingCount: items.length,
    refetch: vi.fn(),
    handleDelete: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('ComponentTodoModal — 双层树', () => {
  it('主 item：状态徽章 + desc + 步骤进度 N/M（仅 steps 非空渲染）', () => {
    const item = mkItem({
      steps: [
        { id: 's1', desc: '列大纲', status: 'done' },
        { id: 's2', desc: '写正文', status: 'in_progress' },
        { id: 's3', desc: '审校', status: 'not_started' },
      ],
    });
    render(<ComponentTodoModal crud={mkCrud([item])} onClose={vi.fn()} />);
    expect(screen.getByText('写 spec 文档')).toBeTruthy();
    // 主 item + 步骤 s2 均「进行中」（两处徽章）
    expect(screen.getAllByText('进行中').length).toBe(2);
    expect(screen.getByText('步骤 1/3')).toBeTruthy();
    // 步骤行（layer 2）
    expect(screen.getByText('列大纲')).toBeTruthy();
    expect(screen.getByText('写正文')).toBeTruthy();
    expect(screen.getByText('审校')).toBeTruthy();
    expect(screen.getByText('已结束')).toBeTruthy();
    expect(screen.getByText('未开始')).toBeTruthy();
  });

  it('主 item 无 steps → 不渲染步骤进度', () => {
    render(<ComponentTodoModal crud={mkCrud([mkItem()])} onClose={vi.fn()} />);
    expect(screen.getByText('写 spec 文档')).toBeTruthy();
    expect(screen.queryByText(/步骤 \d+\/\d+/)).toBeNull();
  });
});

describe('ComponentTodoModal — 悬停结构化详情', () => {
  it('悬停状态徽章 → 显示 source/output/memo（含 refId）；移出收起', () => {
    const item = mkItem({
      source: { type: 'task', refId: 'T-0001' },
      output: { type: 'file', refId: 'spec.md' },
      memo: '先对齐 conventions',
    });
    render(<ComponentTodoModal crud={mkCrud([item])} onClose={vi.fn()} />);
    const badge = document.body.querySelector('[data-action-key="chat.todo.item.status"]')!;
    expect(badge).toBeTruthy();
    // 悬停前无详情
    expect(screen.queryByText(/先对齐 conventions/)).toBeNull();
    fireEvent.mouseEnter(badge);
    // 详情面板：来源 任务 · T-0001 / 输出 文件 · spec.md / 备忘
    expect(screen.getByText(/来源/).textContent).toContain('任务');
    expect(screen.getByText(/来源/).textContent).toContain('T-0001');
    expect(screen.getByText(/输出/).textContent).toContain('文件');
    expect(screen.getByText(/输出/).textContent).toContain('spec.md');
    expect(screen.getByText(/备忘/).textContent).toContain('先对齐 conventions');
    fireEvent.mouseLeave(badge);
    expect(screen.queryByText(/先对齐 conventions/)).toBeNull();
  });

  it('source/output/memo 全空 → 悬停状态徽章不弹详情面板', () => {
    render(<ComponentTodoModal crud={mkCrud([mkItem()])} onClose={vi.fn()} />);
    const badge = document.body.querySelector('[data-action-key="chat.todo.item.status"]')!;
    fireEvent.mouseEnter(badge);
    expect(screen.queryByText(/来源/)).toBeNull();
    expect(screen.queryByText(/输出/)).toBeNull();
    expect(screen.queryByText(/备忘/)).toBeNull();
  });

  it('[v0.0.228] hover 收敛：步骤行 / 主 item 行其余区域 hover 不触发详情弹层（仅状态徽章触发，v0.0.240 收窄）', () => {
    const item = mkItem({
      memo: '主 item 备忘',
      steps: [{ id: 's1', desc: '子步骤一', status: 'done' }],
    });
    render(<ComponentTodoModal crud={mkCrud([item])} onClose={vi.fn()} />);
    // 悬停步骤行：不弹详情（hover 触发域已收敛到状态徽章）
    fireEvent.mouseEnter(screen.getByText('子步骤一'));
    expect(screen.queryByText(/主 item 备忘/)).toBeNull();
    // 悬停主 item 行 desc：不弹详情（v0.0.240 收窄后触发域只剩徽章）
    fireEvent.mouseEnter(screen.getByText('写 spec 文档'));
    expect(screen.queryByText(/主 item 备忘/)).toBeNull();
    // 悬停状态徽章：正常弹详情
    const badge = document.body.querySelector('[data-action-key="chat.todo.item.status"]')!;
    fireEvent.mouseEnter(badge);
    expect(screen.getByText(/主 item 备忘/)).toBeTruthy();
  });
});

describe('ComponentTodoModal — v0.0.228 打开 refetch + 尺寸 + 徽章色板', () => {
  it('弹层打开（挂载）调一次 crud.refetch()（skills 弹层先例）', () => {
    const refetch = vi.fn();
    render(<ComponentTodoModal crud={mkCrud([mkItem()], { refetch })} onClose={vi.fn()} />);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('面板尺寸：w-[720px] max-w-[92vw] max-h-[88vh]（响应式加宽对齐 md editor 档）', () => {
    render(<ComponentTodoModal crud={mkCrud([mkItem()])} onClose={vi.fn()} />);
    const panel = document.body.querySelector('[class*="w-[720px]"]');
    expect(panel).toBeTruthy();
    expect(panel!.className).toContain('max-w-[92vw]');
    expect(panel!.className).toContain('max-h-[88vh]');
  });

  it('done 徽章用 --success 绿 token；not_started 保持 muted 灰（色相拉开）', () => {
    const items = [mkItem({ id: 't1', desc: '已完成事项', status: 'done' }), mkItem({ id: 't2', desc: '待启动事项', status: 'not_started' })];
    render(<ComponentTodoModal crud={mkCrud(items)} onClose={vi.fn()} />);
    const doneBadge = screen.getByText('已结束');
    expect(doneBadge.className).toContain('var(--success)');
    expect(doneBadge.className).toContain('var(--success-bg)');
    expect(doneBadge.className).not.toContain('opacity-60');
    const notStartedBadge = screen.getByText('未开始');
    expect(notStartedBadge.className).not.toContain('var(--success)');
  });
});

describe('ComponentTodoModal — 空态 / 加载 / 错误', () => {
  it('items 空 → idle 空态文案', () => {
    render(<ComponentTodoModal crud={mkCrud([])} onClose={vi.fn()} />);
    expect(screen.getByText('暂无待办')).toBeTruthy();
    expect(screen.getByText(/自主维护手头待办/)).toBeTruthy();
  });

  it('loading 且 items 空 → loading 态', () => {
    render(<ComponentTodoModal crud={mkCrud([], { loading: true })} onClose={vi.fn()} />);
    expect(screen.getByText(/加载中/)).toBeTruthy();
  });

  it('error → role=alert 错误文案', () => {
    render(<ComponentTodoModal crud={mkCrud([], { error: 'boom' })} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });
});

describe('ComponentTodoModal — 关闭 + 只读', () => {
  it('关闭按钮 → onClose', () => {
    const onClose = vi.fn();
    render(<ComponentTodoModal crud={mkCrud([mkItem()])} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('只读：无新建/编辑/删除按钮', () => {
    render(<ComponentTodoModal crud={mkCrud([mkItem()])} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /新建/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });
});
