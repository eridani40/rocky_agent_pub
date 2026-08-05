/**
 * @vitest-environment jsdom
 * section-version-chat 单测 —— 学生版本会话页（SectionChatSession 迁移后）
 * 参考: specs/ui/components/academy-page/section-version-chat.md
 *       specs/tech/version_logs/v0.0.216/change_plan.md E 段（风险2：禁 onMessagesChange 回收 messages）
 *
 * 覆盖（v0.0.216 E 段验收）：
 * - chat 列 = SectionChatSession：选中会话 id 透传 + topbarLeft render-prop
 * - 风险2 锁定：不再传 onMessagesChange（防父级回收 messages 双 useMessages 订阅）
 * - ws-panel 与 chat 列同 sessionId；无会话时渲空态、不挂 SectionChatSession
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { Session } from '../../chat-page/types';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）
const { sectionChatSessionPath, wsPanelPath, chatProps, wsProps } = vi.hoisted(() => ({
  sectionChatSessionPath: require('node:path').resolve(__dirname, '../../chat-page/section-chat-session.tsx'),
  wsPanelPath: require('node:path').resolve(__dirname, '../../chat-page/section-workspace-panel.tsx'),
  chatProps: { current: null as Record<string, unknown> | null },
  wsProps: { current: null as Record<string, unknown> | null },
}));

vi.mock(sectionChatSessionPath, () => ({
  SectionChatSession: (props: Record<string, unknown>) => {
    chatProps.current = props;
    return null;
  },
}));
vi.mock(wsPanelPath, () => ({
  SectionWorkspacePanel: (props: Record<string, unknown>) => {
    wsProps.current = props;
    return null;
  },
}));

import { SectionVersionChat } from '../section-version-chat';

beforeAll(async () => {
  await initI18n('zh-CN');
});
beforeEach(() => {
  chatProps.current = null;
  wsProps.current = null;
  localStorage.clear();
});
afterEach(() => cleanup());

const sessions: Session[] = [
  { id: 'vs-1', title: '会话一', updatedAt: new Date().toISOString() } as Session,
  { id: 'vs-2', title: '会话二', updatedAt: new Date().toISOString() } as Session,
];

function renderPage(extra: Partial<Parameters<typeof SectionVersionChat>[0]> = {}) {
  return render(
    <SectionVersionChat
      classroomId="c1"
      studentId="stu1"
      versionId="ver1"
      versionLabel="v2.0"
      studentName="小北"
      sessions={sessions}
      onSelectSession={() => {}}
      onSessionCreated={() => {}}
      onBack={() => {}}
      {...extra}
    />,
  );
}

describe('SectionVersionChat（版本会话页装配）', () => {
  it('选中会话透传 SectionChatSession；ws-panel 同 sessionId', () => {
    renderPage({ sessionId: 'vs-2' });
    expect(chatProps.current).not.toBeNull();
    expect(chatProps.current!.sessionId).toBe('vs-2');
    expect(typeof chatProps.current!.topbarLeft).toBe('function');
    expect(typeof chatProps.current!.placeholder).toBe('string');
    expect(wsProps.current!.sessionId).toBe('vs-2');
  });

  it('风险2 锁定：不传 onMessagesChange（minimap/usage 全内置，父级不回收 messages）', () => {
    renderPage({ sessionId: 'vs-1' });
    expect(chatProps.current!.onMessagesChange).toBeUndefined();
  });

  it('缺省选中列表首个会话；空列表渲空态不挂 chat 列', () => {
    renderPage();
    expect(chatProps.current!.sessionId).toBe('vs-1');
    cleanup();
    chatProps.current = null;
    renderPage({ sessions: [] });
    expect(chatProps.current).toBeNull();
  });
});
