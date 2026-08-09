/**
 * @vitest-environment jsdom
 * component-token-widget 单测 —— 首页左列 token 用量图文小组件（复用详情统计）
 * 参考: specs/ui/components/studio-page/component-token-widget.md
 *
 * 覆盖（v0.0.288 改造：去三色条→今日总量/60天总量并排）：
 *   1. 整卡点击 → onOpenTokenStats(squadId)（action-key 稳定）
 *   2. 复用详情统计：fetchTokenStats 传 scope='team' + 近 60 天 day（不再查 budget）
 *   3. 今日总量 = totalOf(today.breakdown)（input+output+cache 之和）
 *   4. 60 天总量 = Σ series（cumulative，=详情合计口径）
 *   5. 7 日迷你柱保留（h-[22px] 压缩变矮）
 *   6. 无 TokenBar 三色比例条（DOM 不含三色条结构）
 *   7. fetchTokenStats 失败 → 降级「—」（不崩）
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { mkDetail } from './_fixtures';

const squadMocks = vi.hoisted(() => ({
  fetchTokenStats: vi.fn(),
}));
const squadApiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/squad-api'));
vi.mock(squadApiPath, () => squadMocks);

import { TokenWidget } from '../component-token-widget';

beforeAll(async () => {
  await initI18n('zh-CN');
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

const TODAY = (() => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
})();

const YDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

/** 构造 fetchTokenStats 响应（series，末点 = 今日） */
function mkSeries(today: { input: number; output: number; cache: number } | null, prevTotal = 100000) {
  const series = [
    {
      bucket: YDAY,
      input_no_cache: prevTotal / 2,
      cache_read: 0,
      cache_creation: 0,
      output_response: prevTotal / 2,
      output_reasoning: 0,
      cost: 0,
      llmCallCount: 1,
      total: prevTotal,
      cacheRate: 0,
    },
  ];
  if (today) {
    series.push({
      bucket: TODAY,
      input_no_cache: today.input,
      cache_read: today.cache,
      cache_creation: 0,
      output_response: today.output,
      output_reasoning: 0,
      cost: 0,
      llmCallCount: 1,
      total: today.input + today.output + today.cache,
      cacheRate: 0,
    });
  }
  return {
    squadId: 's1',
    granularity: 'day' as const,
    scope: 'team',
    from: YDAY,
    to: TODAY,
    timezone: 'UTC',
    series,
  };
}

describe('TokenWidget — 复用详情统计（v0.0.240）', () => {
  it('整卡点击 → onOpenTokenStats(squadId)；data-action-key 稳定', async () => {
    squadMocks.fetchTokenStats.mockResolvedValue(mkSeries(null));
    const onOpenTokenStats = vi.fn();
    render(<TokenWidget squadId="s1" detail={mkDetail()} onOpenTokenStats={onOpenTokenStats} />);
    const card = await screen.findByRole('button', { name: /Token 用量/ });
    fireEvent.click(card);
    expect(onOpenTokenStats).toHaveBeenCalledWith('s1');
    expect(card.getAttribute('data-action-key')).toBe('studio.squad.open-token-statistics');
  });

  it('复用详情统计：fetchTokenStats 传 scope=team + 近 60 天 day（不再查 budget）', async () => {
    squadMocks.fetchTokenStats.mockResolvedValue(mkSeries(null));
    render(<TokenWidget squadId="s1" detail={mkDetail()} onOpenTokenStats={() => {}} />);
    await screen.findByText(/Token 用量/);
    expect(squadMocks.fetchTokenStats).toHaveBeenCalledTimes(1);
    const opts = squadMocks.fetchTokenStats.mock.calls[0]![1] as {
      scope: string;
      granularity: string;
      from: string;
      to: string;
    };
    // 修复核心：scope='team'（旧 bug 传 '__team__' 被后端当 memberId → 今日空数据）
    expect(opts.scope).toBe('team');
    expect(opts.granularity).toBe('day');
    expect(opts.from).not.toBe(opts.to); // 近 60 天范围（from 早于 to）
  });

  it('今日总量 = totalOf(today.breakdown)（input+output+cache 之和）', async () => {
    // 今日 input 12.4M + output 45.2M + cache 8.1M = 65.7M
    squadMocks.fetchTokenStats.mockResolvedValue(
      mkSeries({ input: 12_400_000, output: 45_200_000, cache: 8_100_000 }),
    );
    render(<TokenWidget squadId="s1" detail={mkDetail()} onOpenTokenStats={() => {}} />);
    await waitFor(() => expect(screen.getByText('65.7M')).toBeTruthy());
    // 标签 = 今日（todayTotal）
    expect(screen.getByText('今日')).toBeTruthy();
  });

  it('7 日迷你柱保留（h-[22px] 压缩变矮）', async () => {
    squadMocks.fetchTokenStats.mockResolvedValue(mkSeries(null, 200000));
    const { container } = render(<TokenWidget squadId="s1" detail={mkDetail()} onOpenTokenStats={() => {}} />);
    await screen.findByText(/Token 用量/);
    const spark = container.querySelector('.h-\\[22px\\]');
    expect(spark).toBeTruthy();
    expect(spark!.children.length).toBeGreaterThanOrEqual(1);
  });

  it('60 天总量 = Σ series（cumulative，=详情合计口径）', async () => {
    // 昨日 100k + 今日 input 1.2M + output 0.8M + cache 0 = Σ 2.1M
    squadMocks.fetchTokenStats.mockResolvedValue(
      mkSeries({ input: 1_200_000, output: 800_000, cache: 0 }, 100000),
    );
    render(<TokenWidget squadId="s1" detail={mkDetail()} onOpenTokenStats={() => {}} />);
    await waitFor(() => expect(screen.getByText('2.1M')).toBeTruthy());
    // 标签 = 60 天总量（total60d）
    expect(screen.getByText('60 天总量')).toBeTruthy();
  });

  it('无 TokenBar 三色比例条（DOM 不含三色条结构）', async () => {
    squadMocks.fetchTokenStats.mockResolvedValue(
      mkSeries({ input: 1_000_000, output: 2_000_000, cache: 500_000 }),
    );
    const { container } = render(<TokenWidget squadId="s1" detail={mkDetail()} onOpenTokenStats={() => {}} />);
    await screen.findByText(/Token 用量/);
    // 三色条容器使用 h-[7px]（TokenBar 内部比例条高度），改后不应存在
    const oldBars = container.querySelectorAll('.h-\\[7px\\]');
    expect(oldBars.length).toBe(0);
    // 输入/输出/缓存 标签不应出现（i18n kindInput/Output/Cache 已删）
    expect(screen.queryByText('输入')).toBeNull();
    expect(screen.queryByText('输出')).toBeNull();
    expect(screen.queryByText('缓存')).toBeNull();
  });

  it('fetchTokenStats 失败 → 降级（今日/累计显「—」，不崩）', async () => {
    squadMocks.fetchTokenStats.mockRejectedValue(new Error('boom'));
    render(<TokenWidget squadId="s1" detail={mkDetail()} onOpenTokenStats={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Token 用量/ })).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
