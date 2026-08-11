/**
 * @vitest-environment jsdom
 * section-tab-panel 单测（v0.0.199）— 可观测性 detail 视图隐藏 tab 内 logs group。
 * 参考 specs/ui/components/app-dev-config-page/page-app-settings-merged.md
 *
 * 修复的 bug：observability tab 进入 detail（新增/编辑配置）后往下滚会看到 tab 内「日志」group。
 * 根因：section-tab-panel 的 case 'observability' 无条件渲染 logs group，不感知 SectionObservability
 *   进入了 detail。修复方式：SectionObservability 通过 onDetailViewChange 同步上报，tab-panel 用
 *   obsInDetail 状态条件渲染 logs/标题。
 *
 * 校验点：
 *   - list 态：渲染「可观测性」标题 + 「日志」group（回归保护）
 *   - detail 态（onDetailViewChange(true)）：「可观测性」标题 + 「日志」group 均不渲染
 *   - 返回 list（onDetailViewChange(false)）：「日志」group 恢复渲染
 *
 * vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const observabilityPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../observability-config/section-observability'),
);
const logsConfigPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../section-logs-config'),
);

// mock SectionObservability：暴露两个按钮模拟 list↔detail 切换（上抛 onDetailViewChange）
vi.mock(observabilityPath, () => ({
  SectionObservability: ({ onDetailViewChange }: { onDetailViewChange?: (v: boolean) => void }) => (
    <div>
      observability-mock
      <button onClick={() => onDetailViewChange?.(true)}>模拟进详情</button>
      <button onClick={() => onDetailViewChange?.(false)}>模拟返回列表</button>
    </div>
  ),
}));
// mock SectionLogsConfig：logs group 不再走 kvGroups，改由 SectionLogsConfig 自行 GET /config/app?group=logs
vi.mock(logsConfigPath, () => ({
  SectionLogsConfig: () => <div>logs-config-mock</div>,
}));

import { SectionTabPanel } from '../section-tab-panel';
import type { SectionTabPanelProps } from '../section-tab-panel';

/** 构造 observability tab 所需的最小 props（logs 由 SectionLogsConfig 自行 GET，不经 kvGroups） */
function renderObservabilityTab() {
  return render(
    <SectionTabPanel
      selectedTab="observability"
      kvGroups={{}}
      defaultModelsDraft={{}}
      onDefaultModelsChange={() => {}}
      onKeyChange={() => {}}
      consolidationDraft={{ enabled: false, dailyTime: '00:00' }}
    />,
  );
}

describe('SectionTabPanel — observability tab detail 视图隐藏 logs group（v0.0.199）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('list 态：渲染「可观测性」标题 + 「日志」group（回归保护）', () => {
    renderObservabilityTab();
    expect(screen.getByRole('heading', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日志' })).toBeTruthy();
    // logs group 渲染 SectionLogsConfig
    expect(screen.getByText('logs-config-mock')).toBeTruthy();
  });

  it('detail 态（onDetailViewChange(true)）：「可观测性」标题 + 「日志」group 均不渲染（核心 bug 修复）', () => {
    renderObservabilityTab();
    // 进详情
    fireEvent.click(screen.getByRole('button', { name: '模拟进详情' }));
    // 标题 + logs group 都应消失
    expect(screen.queryByRole('heading', { name: '可观测性' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '日志' })).toBeNull();
    expect(screen.queryByText('logs-config-mock')).toBeNull();
    // SectionObservability 本体仍渲染（两种态都渲染）
    expect(screen.getByText('observability-mock')).toBeTruthy();
  });

  it('返回 list（onDetailViewChange(false)）：「日志」group 恢复渲染', () => {
    renderObservabilityTab();
    // 进详情 → 隐藏
    fireEvent.click(screen.getByRole('button', { name: '模拟进详情' }));
    expect(screen.queryByRole('heading', { name: '日志' })).toBeNull();
    // 返回 list → 恢复
    fireEvent.click(screen.getByRole('button', { name: '模拟返回列表' }));
    expect(screen.getByRole('heading', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日志' })).toBeTruthy();
    expect(screen.getByText('logs-config-mock')).toBeTruthy();
  });

  it('切离 observability tab 后 obsInDetail 重置：切回时 logs/标题不被错误隐藏', () => {
    // 覆盖边界：SectionObservability 仅在 observability case 渲染，切走时 unmount（内部 detail state 丢失）。
    // 若 obsInDetail 不重置，切回时 stale=true 会错误隐藏 list 态的 logs/标题。
    const props: SectionTabPanelProps = {
      selectedTab: 'observability',
      kvGroups: {},
      defaultModelsDraft: {},
      onDefaultModelsChange: () => {},
      onKeyChange: () => {},
      consolidationDraft: { enabled: false, dailyTime: '00:00' },
    };
    const { rerender } = render(<SectionTabPanel {...props} />);
    // 进详情 → obsInDetail=true
    fireEvent.click(screen.getByRole('button', { name: '模拟进详情' }));
    expect(screen.queryByRole('heading', { name: '日志' })).toBeNull();
    // 切到 session tab（SectionObservability unmount）
    rerender(<SectionTabPanel {...props} selectedTab="session" />);
    // 切回 observability tab（SectionObservability 重新 mount = list 态）
    rerender(<SectionTabPanel {...props} selectedTab="observability" />);
    // obsInDetail 应已被 useEffect 重置：list 态正常渲染标题 + logs
    expect(screen.getByRole('heading', { name: '可观测性' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日志' })).toBeTruthy();
    expect(screen.getByText('logs-config-mock')).toBeTruthy();
  });
});
