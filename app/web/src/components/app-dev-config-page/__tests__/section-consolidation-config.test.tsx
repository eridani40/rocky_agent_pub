/**
 * @vitest-environment jsdom
 * section-consolidation-config 单测
 * 参考: specs/ui/components/app-dev-config-page/section-consolidation-config.md
 *
 * 校验点：
 *   - group 标题渲染 + 说明含用户裁决固定句
 *   - enabled/dailyTime/modelId 三字段渲染 + 受控值
 *   - 改 enabled → onChange('enabled', boolean)；改 dailyTime → onChange('dailyTime', string)；
 *     modelId picker 交互 → onChange('modelId', value|undefined)
 *   - enabled=false 时 dailyTime input disabled + modelId picker 外层 aria-disabled（禁用态语义）
 *   - 重启生效提示渲染
 *   - 只读「上次整理」区：从未整理过 / 已整理过 / 请求失败三种场景（req mock 控制）
 *   - 立即整理按钮：空闲态可点 / 点击调 runConsolidation / running 态 disabled /
 *     SSE running→disabled、done→恢复可点 / 409 显示提示 / 5xx 显示 error banner
 *   - i18n 双语言：zh-CN 固定句 + en 对应文案均渲染（缺 key 检测：不含【资源】兜底标记）
 *
 * vi.mock 用 __dirname 派生绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { initI18n, i18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const keyModelPickerPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../common/component-key-model-picker'),
);
vi.mock(keyModelPickerPath, () => ({
  KeyModelPicker: ({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) => (
    <div>
      <span>{value ?? '未配置'}</span>
      <button onClick={() => onChange(undefined)}>✕</button>
      <button onClick={() => onChange('gpt-4o')}>pick</button>
    </div>
  ),
}));

const apiClientPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/api-client'),
);
const reqMock = vi.fn();
const runConsolidationMock = vi.fn();
vi.mock(apiClientPath, () => ({
  req: (...args: unknown[]) => reqMock(...args),
  runConsolidation: (...args: unknown[]) => runConsolidationMock(...args),
}));

// —— fake SSE 单例：捕获 subscribe 的 handler 供 emit —— //
const { sseState, singletonPath } = vi.hoisted(() => ({
  sseState: {
    subs: [] as Array<{ topic: string; group: string; handler: (f: unknown) => void }>,
    subscribeCalls: 0,
    unsubscribeCalls: 0,
  },
  singletonPath: require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
}));
vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: async (topic: string, group: string, handler: (f: unknown) => void) => {
      sseState.subscribeCalls++;
      const entry = { topic, group, handler };
      sseState.subs.push(entry);
      return {
        subId: `sub-${sseState.subscribeCalls}`,
        topic,
        group,
        unsubscribe: async () => {
          sseState.unsubscribeCalls++;
          const idx = sseState.subs.indexOf(entry);
          if (idx !== -1) sseState.subs.splice(idx, 1);
        },
      };
    },
    isConnected: () => true,
  }),
}));

import { SectionConsolidationConfig } from '../section-consolidation-config';

/** 向订阅了 (topic, group) 的所有 handler 派发一个 SSE 帧 */
function emitFrame(topic: string, group: string, data: unknown) {
  const subs = sseState.subs.filter((s) => s.topic === topic && s.group === group);
  for (const s of subs) {
    s.handler({ topic, group, data, timestamp: new Date().toISOString(), subId: `sub-${sseState.subscribeCalls}` });
  }
}

/** 排空 hook 挂载后异步副作用（onInit await + establishSubscriptions） */
async function flushLifecycle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

/** 获取「立即整理」按钮（zh-CN 环境） */
function getRunNowBtn() {
  return screen.getByRole('button', { name: '立即整理' }) as HTMLButtonElement;
}

describe('SectionConsolidationConfig', () => {
  beforeEach(() => {
    cleanup();
    reqMock.mockReset();
    runConsolidationMock.mockReset();
    sseState.subs.length = 0;
    sseState.subscribeCalls = 0;
    sseState.unsubscribeCalls = 0;
    reqMock.mockResolvedValue({ lastRunAt: null, summary: null });
  });
  afterEach(() => cleanup());

  const defaultDraft = { enabled: false, dailyTime: '04:00', modelId: undefined };

  it('渲染 group 标题', async () => {
    render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '整理' })).toBeTruthy();
  });

  it('说明文案含用户裁决固定句「这个整理是对 skill 和 memory 进行整合整理」', async () => {
    render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    expect(screen.getByText(/这个整理是对 skill 和 memory 进行整合整理/).textContent).toContain('这个整理是对 skill 和 memory 进行整合整理');
  });

  it('渲染三字段：enabled 开关 + dailyTime 输入 + modelId picker', async () => {
    const { container } = render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeTruthy();
    expect(container.querySelector('input[type="time"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'pick' })).toBeTruthy();
  });

  it('受控值反映 draft（dailyTime=09:30）', async () => {
    const { container } = render(<SectionConsolidationConfig draft={{ ...defaultDraft, dailyTime: '09:30' }} onChange={vi.fn()} />);
    const input = container.querySelector('input[type="time"]') as HTMLInputElement;
    expect(input.value).toBe('09:30');
  });

  it('点 enabled 开关 → onChange("enabled", true)', async () => {
    const onChange = vi.fn();
    render(<SectionConsolidationConfig draft={defaultDraft} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith('enabled', true);
  });

  it('改 dailyTime input → onChange("dailyTime", "20:00")', async () => {
    const onChange = vi.fn();
    const { container } = render(<SectionConsolidationConfig draft={{ ...defaultDraft, enabled: true }} onChange={onChange} />);
    const input = container.querySelector('input[type="time"]')!;
    fireEvent.change(input, { target: { value: '20:00' } });
    expect(onChange).toHaveBeenCalledWith('dailyTime', '20:00');
  });

  it('点 modelId picker pick → onChange("modelId", "gpt-4o")', async () => {
    const onChange = vi.fn();
    render(<SectionConsolidationConfig draft={{ ...defaultDraft, enabled: true }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    expect(onChange).toHaveBeenCalledWith('modelId', 'gpt-4o');
  });

  it('点 modelId clear → onChange("modelId", undefined)', async () => {
    const onChange = vi.fn();
    render(<SectionConsolidationConfig draft={{ ...defaultDraft, enabled: true, modelId: 'gpt-4o' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(onChange).toHaveBeenCalledWith('modelId', undefined);
  });

  it('enabled=false 时 dailyTime input disabled=true + modelId 外层 aria-disabled=true（禁用态语义 UC-2）', async () => {
    const { container } = render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    const input = container.querySelector('input[type="time"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(container.querySelector('[aria-disabled]')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('enabled=true 时 dailyTime input 不 disabled + modelId 外层 aria-disabled=false', async () => {
    const { container } = render(<SectionConsolidationConfig draft={{ ...defaultDraft, enabled: true }} onChange={vi.fn()} />);
    const input = container.querySelector('input[type="time"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(container.querySelector('[aria-disabled]')!.getAttribute('aria-disabled')).toBe('false');
  });

  it('enabled 开关自身始终可点（不因 enabled=false 被禁用）', async () => {
    render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    const toggle = screen.getByRole('switch');
    expect(toggle.hasAttribute('disabled')).toBe(false);
  });

  it('渲染重启生效提示', async () => {
    render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    expect(screen.getByText(/需重启应用后才会生效/)).toBeTruthy();
  });

  it('从未整理过（lastRunAt=null）→ 显示「尚未整理过」', async () => {
    reqMock.mockResolvedValue({ lastRunAt: null, summary: null });
    render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('尚未整理过')).toBeTruthy());
    expect(screen.queryByText(/上次整理时间/)).toBeNull();
  });

  it('已整理过 → 显示上次整理时间 + 一句话摘要', async () => {
    reqMock.mockResolvedValue({ lastRunAt: '2026-07-15T04:00:03.211Z', summary: '合并 2 条 · 归档 5 条' });
    render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/上次整理时间/)).toBeTruthy());
    expect(screen.getByText('合并 2 条 · 归档 5 条').textContent).toBe('合并 2 条 · 归档 5 条');
    expect(screen.queryByText('尚未整理过')).toBeNull();
  });

  it('状态端点请求失败（404/网络错误）→ 优雅降级为「尚未整理过」，不崩不显 error', async () => {
    reqMock.mockRejectedValue(new Error('Not Found'));
    expect(() => render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />)).not.toThrow();
    await waitFor(() => expect(screen.getByText('尚未整理过')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // —— 立即整理按钮 —— //

  describe('立即整理按钮', () => {
    it('按钮存在 + 空闲态可点', async () => {
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      const btn = getRunNowBtn();
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(false);
    });

    it('挂载时订阅 (app_task, _all) SSE topic', async () => {
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      const sub = sseState.subs.find((s) => s.topic === 'app_task' && s.group === '_all');
      expect(sub).toBeTruthy();
    });

    it('点击按钮 → 调 runConsolidation()', async () => {
      runConsolidationMock.mockResolvedValue({ ok: true, runId: 'manual:01AB' });
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      await act(async () => {
        fireEvent.click(getRunNowBtn());
        await Promise.resolve();
      });
      expect(runConsolidationMock).toHaveBeenCalledTimes(1);
    });

    it('SSE running 事件 → 按钮 disabled + 显示「整理中」提示', async () => {
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      act(() => {
        emitFrame('app_task', '_all', {
          id: 'evt-1',
          type: 'consolidation_task_update',
          createdAt: new Date().toISOString(),
          data: { status: 'running', runId: 'cron:2026-07-17T04:00', startedAt: new Date().toISOString() },
        });
      });
      await waitFor(() => {
        expect(getRunNowBtn().disabled).toBe(true);
      });
      expect(screen.getByText('整理中…')).toBeTruthy();
    });

    it('SSE running → done → 按钮恢复可点 + 面板刷新 lastRunAt/summary', async () => {
      reqMock.mockResolvedValueOnce({ lastRunAt: null, summary: null });
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      act(() => {
        emitFrame('app_task', '_all', {
          id: 'evt-1',
          type: 'consolidation_task_update',
          createdAt: new Date().toISOString(),
          data: { status: 'running', runId: 'manual:01' },
        });
      });
      await waitFor(() => expect(getRunNowBtn().disabled).toBe(true));
      // done 事件到达前，二次 fetchStatus 应返回新时间/摘要
      reqMock.mockResolvedValueOnce({ lastRunAt: '2026-07-17T04:15:00.000Z', summary: '合并 3 条' });
      act(() => {
        emitFrame('app_task', '_all', {
          id: 'evt-2',
          type: 'consolidation_task_update',
          createdAt: new Date().toISOString(),
          data: { status: 'done', runId: 'manual:01' },
        });
      });
      await waitFor(() => expect(getRunNowBtn().disabled).toBe(false));
      await waitFor(() => expect(screen.getByText('合并 3 条').textContent).toBe('合并 3 条'));
    });

    it('runConsolidation 返 409 → 保持 disabled + 显示 inProgress 提示', async () => {
      runConsolidationMock.mockResolvedValue({ error: 'consolidation_in_progress' });
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      await act(async () => {
        fireEvent.click(getRunNowBtn());
        await Promise.resolve(); await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      expect(screen.getByRole('alert').textContent).toContain('已在进行');
      expect(getRunNowBtn().disabled).toBe(true);
    });

    it('runConsolidation 抛 5xx → 回滚 isRunning + 显示 network 错误', async () => {
      runConsolidationMock.mockRejectedValue(new Error('HTTP 500'));
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      await act(async () => {
        fireEvent.click(getRunNowBtn());
        await Promise.resolve(); await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      expect(screen.getByRole('alert').textContent).toContain('HTTP 500');
      expect(getRunNowBtn().disabled).toBe(false);
    });

    it('SSE failed 事件 → 按钮恢复可点 + errorMsg 展示 data.error', async () => {
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      act(() => {
        emitFrame('app_task', '_all', {
          id: 'evt-1',
          type: 'consolidation_task_update',
          createdAt: new Date().toISOString(),
          data: { status: 'failed', error: 'LLM timeout' },
        });
      });
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      expect(screen.getByRole('alert').textContent).toBe('LLM timeout');
      expect(getRunNowBtn().disabled).toBe(false);
    });

    // —— [v0.0.205.t2_cons] onInit 按 status.status 初始化 isRunning（UC-C2 切走切回修复）—— //

    it('onInit 读到 status=running → 按钮 disabled + 显示「整理中」（切走切回仍禁用，UC-C2）', async () => {
      reqMock.mockResolvedValue({
        lastRunAt: '2026-07-20T04:00:00.000Z',
        summary: null,
        status: 'running',
        startedAt: '2026-07-26T10:00:00.000Z',
      });
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      await waitFor(() => expect(getRunNowBtn().disabled).toBe(true));
      expect(screen.getByText('整理中…')).toBeTruthy();
    });

    it('onInit 读到 status=idle → 按钮可点（空闲态）', async () => {
      reqMock.mockResolvedValue({
        lastRunAt: '2026-07-20T04:00:00.000Z',
        summary: '合并 1 条',
        status: 'idle',
        startedAt: null,
      });
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      await waitFor(() => expect(getRunNowBtn().disabled).toBe(false));
      expect(screen.queryByText('整理中…')).toBeNull();
    });

    it('onInit 读到 status=failed → 按钮可点（failed 非 running，可重试）', async () => {
      reqMock.mockResolvedValue({
        lastRunAt: null,
        summary: null,
        status: 'failed',
        startedAt: null,
      });
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      await waitFor(() => expect(getRunNowBtn().disabled).toBe(false));
    });

    it('status 响应缺 status 字段（旧后端）→ 按 idle 兜底不崩', async () => {
      reqMock.mockResolvedValue({ lastRunAt: null, summary: null });
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      await waitFor(() => expect(getRunNowBtn().disabled).toBe(false));
    });
  });

  describe('i18n 双语言', () => {
    afterAll(async () => {
      await i18n.changeLanguage('zh-CN');
    });

    it('zh-CN 按钮文案 = 「立即整理」，无【资源】兜底标记', async () => {
      await i18n.changeLanguage('zh-CN');
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      const btn = screen.getByRole('button', { name: '立即整理' });
      expect(btn.textContent).toBe('立即整理');
      expect(btn.textContent).not.toContain('【资源');
    });

    it('en locale 下按钮 + 提示文案正常渲染（无缺 key 兜底标记）', async () => {
      await i18n.changeLanguage('en');
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Run now' }).textContent).toBe('Run now');
      const desc = screen.getByText(/This consolidation merges/).textContent ?? '';
      expect(desc).not.toContain('【资源');
      expect(desc.length).toBeGreaterThan(0);
      expect(screen.getByText(/require an app restart/).textContent).not.toContain('【资源');
    });

    it('en locale 下 running 提示 = "Running…"（i18n key 完整）', async () => {
      await i18n.changeLanguage('en');
      render(<SectionConsolidationConfig draft={defaultDraft} onChange={vi.fn()} />);
      await flushLifecycle();
      act(() => {
        emitFrame('app_task', '_all', {
          id: 'evt-1',
          type: 'consolidation_task_update',
          createdAt: new Date().toISOString(),
          data: { status: 'running' },
        });
      });
      await waitFor(() => expect(screen.getByText('Running…').textContent).toBe('Running…'));
    });
  });
});
