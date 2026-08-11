/**
 * app-settings-config-defs 团队同步 tab 注册单测（v0.0.319）
 * 参考: specs/tech/version_logs/v0.0.319/change_plan.md D5
 *
 * 覆盖（test-plan §2 UT 组 6）：
 *   - TabId 含 team_sync（APP_SETTINGS_TABS 有对应条目）
 *   - APP_SETTINGS_TABS team_sync 位于 memory 之后（inSystemArea=false）
 *   - TAB_KV_GROUPS team_sync = []（自渲染即时操作，不进 KV dirty）
 */
import { describe, it, expect } from 'vitest';
import { APP_SETTINGS_TABS, TAB_KV_GROUPS, type TabId } from '../app-settings-config-defs';

describe('app-settings-config-defs — team_sync tab 注册（v0.0.319）', () => {
  it('APP_SETTINGS_TABS 含 team_sync，位于 memory 之后，非系统收起区', () => {
    const ids: TabId[] = APP_SETTINGS_TABS.map((t) => t.id);
    expect(ids).toContain('team_sync');
    expect(ids.indexOf('team_sync')).toBeGreaterThan(ids.indexOf('memory'));
    const def = APP_SETTINGS_TABS.find((t) => t.id === 'team_sync');
    expect(def?.inSystemArea).toBe(false);
    expect(def?.labelKey).toBe('tab.team_sync.label');
  });

  it('TAB_KV_GROUPS team_sync = []（即时操作页，不进 KV dirty 跟踪）', () => {
    expect(TAB_KV_GROUPS.team_sync).toEqual([]);
  });
});
