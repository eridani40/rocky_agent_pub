/**
 * @vitest-environment jsdom
 * component-session-readonly 单测 —— subagent 只读 transcript（SectionChatSession 迁移后）
 * 参考: specs/ui/components/academy-page/page-academy.md（session-readonly 路由）
 *       specs/ui/components/chat-page/section-chat-session.md（readOnly = prop ∪ chrome.readOnly）
 *
 * 覆盖（v0.0.216 E 段验收）：
 * - chat 列 = SectionChatSession：sessionId 透传 + readOnly=true 双保险 + backActionKey
 * - gold banner 不变（只读语义零回归）
 * - topbarLeft render-prop 注入（身份 header 由消费方提供）
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）—— bun+jsdom 全量并发下相对路径静默失效
const { sectionChatSessionPath, capturedProps } = vi.hoisted(() => ({
  sectionChatSessionPath: require('node:path').resolve(__dirname, '../../chat-page/section-chat-session.tsx'),
  capturedProps: { current: null as Record<string, unknown> | null },
}));

// SectionChatSession 桩：捕获 props（不挂真实 hooks/网络）
vi.mock(sectionChatSessionPath, () => ({
  SectionChatSession: (props: Record<string, unknown>) => {
    capturedProps.current = props;
    return null;
  },
}));

import { SessionReadonlyView } from '../component-session-readonly';

beforeAll(async () => {
  await initI18n('zh-CN');
});
beforeEach(() => {
  capturedProps.current = null;
});
afterEach(() => cleanup());

describe('SessionReadonlyView（subagent 只读页）', () => {
  const route = { kind: 'session-readonly', sessionId: 'sub-1', title: '子代理 A' } as Parameters<
    typeof SessionReadonlyView
  >[0]['route'];

  it('SectionChatSession 接线：sessionId + readOnly 双保险 + academy 返回键语义', () => {
    render(<SessionReadonlyView route={route} onBack={() => {}} />);
    expect(capturedProps.current).not.toBeNull();
    expect(capturedProps.current!.sessionId).toBe('sub-1');
    expect(capturedProps.current!.readOnly).toBe(true);
    expect(capturedProps.current!.backActionKey).toBe('academy.chat.back');
    expect(typeof capturedProps.current!.onBack).toBe('function');
    expect(typeof capturedProps.current!.topbarLeft).toBe('function');
  });

  it('gold banner 保留（只读提示条零回归）', () => {
    const { container } = render(<SessionReadonlyView route={route} onBack={() => {}} />);
    expect(container.querySelector('.bg-gold-bg')).not.toBeNull();
  });
});
