// @vitest-environment jsdom
/**
 * component-quota-provider-card.test.tsx — 双态卡单测
 * 参考: states/v0.0.356/test-plan.md §2.2
 *
 * 覆盖：
 *   ① 收起结构（双环左右/环上字下/chevron）
 *   ② formatSingleUnit 四分支直测 + 渲染
 *   ③ 独立 toggle（A 展开不影响 B）
 *   ④ 展开替换层（主副标题/baseUrl/item 行/双柱/倒计时）
 *   ⑤ 余额型/无周档形态
 *   ⑥ aria + 烧快琥珀
 */
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

import { ComponentQuotaProviderCard } from '../component-quota-provider-card';
import { formatSingleUnit } from '../../providers/quota-format';
import type { CardVM } from '../use-squad-quota';
import type { QuotaSnapshot } from '../../../lib/api-client';

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.now();

/** 额度型快照夹具（补齐 QuotaSnapshot 必填字段） */
function mkTierSnapshot(
  providerId: string,
  providerLabel: string,
  tiers: { window: 'five_hour' | 'weekly'; usedPercent: number; resetsAt: string }[],
): QuotaSnapshot {
  return {
    providerId,
    providerLabel,
    implId: 'minimax_coding_plan',
    kind: 'quota',
    isAvailable: true,
    tiers: tiers.map((t) => ({ window: t.window, usedPercent: t.usedPercent, resetsAt: t.resetsAt })),
    fetchedAt: NOW,
  };
}

/** 余额型快照夹具 */
function mkBalanceSnapshot(providerId: string, providerLabel: string, total: number): QuotaSnapshot {
  return {
    providerId,
    providerLabel,
    implId: 'deepseek_api',
    kind: 'balance',
    isAvailable: false,
    balance: { currency: 'CNY', total },
    fetchedAt: NOW,
  };
}

function mkCard(over: Partial<CardVM> & { snapshot?: CardVM['snapshot'] } = {}): CardVM {
  return {
    providerId: 'p1',
    providerLabel: 'MiniMax',
    modelId: 'm1',
    state: 'working',
    stateKey: 'working',
    offWindow: false,
    remainingSeconds: null,
    // v0.0.364：连续 2..23（原 [2,23] 字面量是两个离散小时，非连续段——fmtHours 会拆成两段）
    hours: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    baseUrl: 'https://api.minimax.chat',
    ...over,
    snapshot: over.snapshot ?? mkTierSnapshot('p1', 'MiniMax', [
      { window: 'five_hour', usedPercent: 30, resetsAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString() },
      { window: 'weekly', usedPercent: 55, resetsAt: new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString() },
    ]),
  } as CardVM;
}

describe('ComponentQuotaProviderCard — 收起态结构', () => {
  it('渲染状态点 + 头像 + provider/model 两行', () => {
    render(<ComponentQuotaProviderCard card={mkCard()} now={NOW} />);
    expect(screen.getByText('MiniMax')).toBeTruthy();
    expect(screen.getByText('m1')).toBeTruthy();
    expect(screen.getByLabelText(/工作中/)).toBeTruthy();
  });

  it('双档左右排列：「5小时额度」「周额度」两组并列，环上字下', () => {
    render(<ComponentQuotaProviderCard card={mkCard()} now={NOW} />);
    const labels = screen.getAllByText(/5小时额度|周额度/);
    expect(labels).toHaveLength(2);
  });

  it('无周档套餐只显示 5小时额度', () => {
    const card = mkCard({
      snapshot: mkTierSnapshot('p1', 'MiniMax', [
        { window: 'five_hour', usedPercent: 30, resetsAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString() },
      ]),
    });
    render(<ComponentQuotaProviderCard card={card} now={NOW} />);
    expect(screen.getByText('5小时额度')).toBeTruthy();
    expect(screen.queryByText('周额度')).toBeNull();
  });
});

describe('ComponentQuotaProviderCard — formatSingleUnit 四分支', () => {
  const labels = { day: '天', hour: '小时', minute: 'm', zero: '0min' };

  it('≥1 天 → X天', () => {
    expect(formatSingleUnit(new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString(), NOW, labels)).toBe('3天');
  });

  it('≥1 小时 → X小时（无分钟）', () => {
    expect(formatSingleUnit(new Date(NOW + 2 * 60 * 60 * 1000).toISOString(), NOW, labels)).toBe('2小时');
  });

  it('<60 分钟 → Xm', () => {
    expect(formatSingleUnit(new Date(NOW + 30 * 60 * 1000).toISOString(), NOW, labels)).toBe('30m');
  });

  it('<1 分钟 → 0min', () => {
    expect(formatSingleUnit(new Date(NOW + 30 * 1000).toISOString(), NOW, labels)).toBe('0min');
  });
});

describe('ComponentQuotaProviderCard — 独立 toggle', () => {
  it('点击卡片展开；再点收起；两卡独立非手风琴', () => {
    render(
      <>
        <ComponentQuotaProviderCard card={mkCard({ providerId: 'a', providerLabel: 'A', modelId: 'ma' })} now={NOW} />
        <ComponentQuotaProviderCard card={mkCard({ providerId: 'b', providerLabel: 'B', modelId: 'mb' })} now={NOW} />
      </>,
    );

    const aBtn = screen.getByTestId('quota-provider-card-a');
    const bBtn = screen.getByTestId('quota-provider-card-b');

    fireEvent.click(aBtn);
    expect(aBtn.getAttribute('aria-expanded')).toBe('true');
    expect(bBtn.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(bBtn);
    expect(aBtn.getAttribute('aria-expanded')).toBe('true');
    expect(bBtn.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(aBtn);
    expect(aBtn.getAttribute('aria-expanded')).toBe('false');
    expect(bBtn.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ComponentQuotaProviderCard — 展开态替换层', () => {
  it('展开后主标题 provider + 副标题 model + baseUrl mono 行', () => {
    const { container } = render(<ComponentQuotaProviderCard card={mkCard()} now={NOW} />);
    const btn = screen.getByTestId('quota-provider-card-p1');
    fireEvent.click(btn);

    expect(container.textContent).toContain('MiniMax');
    expect(container.textContent).toContain('m1');
    expect(container.textContent).toContain('https://api.minimax.chat');
  });

  it('展开后显示 item 行（时间条件+状态词）', () => {
    render(<ComponentQuotaProviderCard card={mkCard()} now={NOW} />);
    fireEvent.click(screen.getByTestId('quota-provider-card-p1'));
    expect(screen.getByText(/02:00-24:00/)).toBeTruthy();
  });

  it('多段 hours 分段展示（prod 实数据形态 [0..13,18..23]，v0.0.364）', () => {
    const card = mkCard({ hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 18, 19, 20, 21, 22, 23] });
    render(<ComponentQuotaProviderCard card={card} now={NOW} />);
    fireEvent.click(screen.getByTestId('quota-provider-card-p1'));
    expect(screen.getByText(/00:00-14:00, 18:00-24:00/)).toBeTruthy();
  });

  it('hours 为空展示「不限时」（fmtHours 空数组 falsy 兼容）', () => {
    const card = mkCard({ hours: undefined });
    render(<ComponentQuotaProviderCard card={card} now={NOW} />);
    fireEvent.click(screen.getByTestId('quota-provider-card-p1'));
    expect(screen.getByText('不限时')).toBeTruthy();
  });

  it('熔断状态显示倒计时文案', () => {
    const card = mkCard({ state: 'open', stateKey: 'open', remainingSeconds: 87 });
    render(<ComponentQuotaProviderCard card={card} now={NOW} />);
    fireEvent.click(screen.getByTestId('quota-provider-card-p1'));
    expect(screen.getByText(/87/)).toBeTruthy();
  });

  it('展开态渲染双柱（five_hour + weekly）', () => {
    render(<ComponentQuotaProviderCard card={mkCard()} now={NOW} />);
    fireEvent.click(screen.getByTestId('quota-provider-card-p1'));
    expect(screen.getByText('5小时额度')).toBeTruthy();
    expect(screen.getByText('周额度')).toBeTruthy();
  });
});

describe('ComponentQuotaProviderCard — 余额型形态', () => {
  it('收起态无环，直接金额 +「充值余额」', () => {
    const card = mkCard({
      state: 'open',
      stateKey: 'open',
      snapshot: mkBalanceSnapshot('p2', 'DeepSeek', 9118.81),
    });
    render(<ComponentQuotaProviderCard card={card} now={NOW} />);
    expect(screen.getByText('¥9,118.81')).toBeTruthy();
    expect(screen.queryByText('5小时额度')).toBeNull();
  });

  it('展开态大字金额 + 余额不足标签', () => {
    const card = mkCard({
      providerId: 'p2',
      providerLabel: 'DeepSeek',
      modelId: 'm2',
      snapshot: mkBalanceSnapshot('p2', 'DeepSeek', 9118.81),
    });
    const { container } = render(<ComponentQuotaProviderCard card={card} now={NOW} />);
    fireEvent.click(screen.getByTestId('quota-provider-card-p2'));
    expect(screen.getByText('¥9,118.81')).toBeTruthy();
    expect(container.textContent).toContain('余额不足');
  });
});

describe('ComponentQuotaProviderCard — aria 与烧快琥珀', () => {
  it('高用量环带 aria-label', () => {
    render(<ComponentQuotaProviderCard card={mkCard()} now={NOW} />);
    expect(screen.getByLabelText(/MiniMax.*5小时额度.*30%/)).toBeTruthy();
  });

  it('消耗偏快时渲染琥珀 FAST 徽标', () => {
    const card = mkCard({
      snapshot: mkTierSnapshot('p1', 'MiniMax', [
        { window: 'five_hour', usedPercent: 95, resetsAt: new Date(NOW + 30 * 60 * 1000).toISOString() },
      ]),
    });
    render(<ComponentQuotaProviderCard card={card} now={NOW} />);
    fireEvent.click(screen.getByTestId('quota-provider-card-p1'));
    expect(screen.getAllByText(/消耗偏快/).length).toBeGreaterThan(0);
  });
});
