/**
 * @vitest-environment jsdom
 * section-skill-market 单测（U7 市场部分）：能力门控渲染 + 搜索结果网格。
 * 参考: specs/ui/components/skill-page/section-skill-market.md；invariant#4。
 *
 * 覆盖：getMarketCapabilities 返 null → noProvider 引导态（不渲染搜索框）；
 * ready → 渲染搜索框；搜索返回 items → 市场卡（同源 installed 态）。
 *
 * bun --bun 下 vi.mock 需绝对路径（同 page-skill.test.tsx）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SectionSkillMarket } from '../section-skill-market';
import type { SkillEntry } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => { await initI18n('zh-CN'); });

const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
const mocks = vi.hoisted(() => ({
  getMarketCapabilities: vi.fn(),
  searchMarket: vi.fn(),
  installMarketSkill: vi.fn(),
  getMarketDetail: vi.fn(),
}));
vi.mock(apiPath, () => ({
  getMarketCapabilities: (...a: unknown[]) => mocks.getMarketCapabilities(...a),
  searchMarket: (...a: unknown[]) => mocks.searchMarket(...a),
  installMarketSkill: (...a: unknown[]) => mocks.installMarketSkill(...a),
  getMarketDetail: (...a: unknown[]) => mocks.getMarketDetail(...a),
}));

const CAPS = { id: 'skills_sh', label: 'skills.sh', capabilities: { stats: ['installs'] } };

function renderSection(installed: SkillEntry[] = []) {
  const onInstalled = vi.fn();
  render(<SectionSkillMarket installedSkills={installed} onInstalled={onInstalled} />);
  return { onInstalled };
}

describe('SectionSkillMarket — 能力协商门控', () => {
  beforeEach(() => {
    mocks.getMarketCapabilities.mockReset();
    mocks.searchMarket.mockReset();
    mocks.installMarketSkill.mockReset();
  });
  afterEach(() => cleanup());

  it('capabilities 返 null → 渲染 noProvider 引导态，不渲染搜索框', async () => {
    mocks.getMarketCapabilities.mockResolvedValue(null);
    renderSection();
    await waitFor(() => expect(screen.getByText('市场未配置生效来源')).toBeTruthy());
    expect(screen.queryByPlaceholderText('搜索 Skill…')).toBeNull();
  });

  it('capabilities ready → 渲染搜索框', async () => {
    mocks.getMarketCapabilities.mockResolvedValue(CAPS);
    renderSection();
    await waitFor(() => expect(screen.getByPlaceholderText('搜索 Skill…')).toBeTruthy());
  });

  it('capabilities 请求抛错 → 渲染 error 态', async () => {
    mocks.getMarketCapabilities.mockRejectedValue(new Error('boom'));
    renderSection();
    await waitFor(() => expect(screen.getByText('加载失败，请重试')).toBeTruthy());
  });
});

describe('SectionSkillMarket — 搜索结果网格', () => {
  beforeEach(() => {
    mocks.getMarketCapabilities.mockReset();
    mocks.searchMarket.mockReset();
    mocks.getMarketCapabilities.mockResolvedValue(CAPS);
  });
  afterEach(() => cleanup());

  it('回车触发搜索 → 渲染卡片；同源已安装项显示已安装态', async () => {
    mocks.searchMarket.mockResolvedValue({
      items: [
        { ref: 'a/b/pdf', name: 'pdf', stats: { installs: 1200 } },
        { ref: 'a/b/docx', name: 'docx' },
      ],
    });
    const installed: SkillEntry[] = [
      { name: 'pdf', description: '', scope: 'app', skillDir: '/x', enabled: true, marketRef: 'a/b/pdf', installedHash: 'h1' },
    ];
    renderSection(installed);
    await waitFor(() => expect(screen.getByPlaceholderText('搜索 Skill…')).toBeTruthy());
    const input = screen.getByPlaceholderText('搜索 Skill…');
    fireEvent.change(input, { target: { value: 'doc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 同源已安装 pdf → 已安装 badge（列表阶段惰性，只 ref 匹配）
    await waitFor(() => expect(screen.getByText('已安装')).toBeTruthy());
    // 未安装 docx → 安装按钮
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
  });

  it('搜索返回空 → 渲染 empty 态', async () => {
    mocks.searchMarket.mockResolvedValue({ items: [] });
    renderSection();
    await waitFor(() => expect(screen.getByPlaceholderText('搜索 Skill…')).toBeTruthy());
    const input = screen.getByPlaceholderText('搜索 Skill…');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('没有找到匹配的 Skill')).toBeTruthy());
  });
});
