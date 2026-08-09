/**
 * @vitest-environment jsdom
 * v0.0.292 群聊开关 tab 迁移测试（autowork → manage）
 * 参考: specs/ui/components/studio-page/component-autowork-tab.md
 *       specs/ui/components/studio-page/component-group-chat-toggle.md
 *       specs/prd/v0.0.292-squad-home-fixes/PRD.md §D5
 *
 * 覆盖：
 *   - AutoworkTab 不再渲染 GroupChatToggle（无 data-action-key=studio.squad.toggle-group-chat）
 *   - ManageTab 渲染 GroupChatToggle（有 data-action-key=studio.squad.toggle-group-chat）
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { AutoworkTab } from '../component-autowork-tab';
import { ManageTab } from '../component-manage-tab';
import { mkDetail } from './_fixtures';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

const TOGGLE_ACTION_KEY = 'studio.squad.toggle-group-chat';

describe('AutoworkTab — [v0.0.292] 群聊开关已迁出', () => {
  it('AutoworkTab 不渲染 GroupChatToggle（无 toggle-group-chat action key）', () => {
    const detail = mkDetail();
    render(<AutoworkTab detail={detail} onSaveMeta={vi.fn()} />);
    // 不存在 GroupChatToggle 的 data-action-key（其他 switch 存在但 action-key 不同）
    const switches = screen.getAllByRole('switch');
    const hasGroupChat = switches.some((sw) => sw.getAttribute('data-action-key') === TOGGLE_ACTION_KEY);
    expect(hasGroupChat).toBe(false);
  });
});

describe('ManageTab — [v0.0.292] 群聊开关迁入', () => {
  it('ManageTab 渲染 GroupChatToggle（有 toggle-group-chat action key）', () => {
    const detail = mkDetail();
    render(<ManageTab detail={detail} onSaveMeta={vi.fn()} onDelete={vi.fn().mockResolvedValue(true)} />);
    // GroupChatToggle 用 role=switch + data-action-key 定位
    const switches = screen.getAllByRole('switch');
    const gcSwitch = switches.find((sw) => sw.getAttribute('data-action-key') === TOGGLE_ACTION_KEY);
    expect(gcSwitch).toBeTruthy();
  });

  it('ManageTab GroupChatToggle 透传 enableGroupChat（aria-checked 反映当前值）', () => {
    const detail = mkDetail({ enableGroupChat: false });
    render(<ManageTab detail={detail} onSaveMeta={vi.fn()} onDelete={vi.fn().mockResolvedValue(true)} />);
    const switches = screen.getAllByRole('switch');
    const gcSwitch = switches.find((sw) => sw.getAttribute('data-action-key') === TOGGLE_ACTION_KEY);
    expect(gcSwitch?.getAttribute('aria-checked')).toBe('false');
  });
});
