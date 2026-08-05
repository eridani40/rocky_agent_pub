/**
 * Side-run Reminder 注入器单元测试
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]forked_reminder.md（主契约 §3/§4/§6）
 *
 * 覆盖：
 *   - 两态文案对应 allowedTools 内容（§3.2）：compaction=[] / =[read,write]
 *   - buildReminderText 含「side run」自述 + 「MAIN agent」+ 「ACTUALLY EXECUTE」（§3.1）
 *   - injectSideRunReminder 返回 user-role Message（sender.source=system）
 *
 * 本文件只测 injector 自身：buildReminderText 文案 + injectSideRunReminder Message 形态。
 * reminder 注入位置 + cache 前缀不变（§2.2/§6.1）经 buildRunDeps 端到端覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
  injectSideRunReminder,
  buildReminderText,
  type SideRunReminderInput,
} from '../side-run-reminder-injector';

describe('side-run-reminder-injector — buildReminderText 两态文案（§3.2）', () => {
  const base = { runKind: 'summary', sessionId: 's1' } as const;

  it('零工具态（compaction：allowedTools=[]）→ 文案含「no tools allowed」', () => {
    const input: SideRunReminderInput = { ...base, allowedTools: [] };
    const text = buildReminderText(input);
    expect(text).toContain('no tools allowed');
    // runKind=summary 微调（§3.3）：含 compaction run 提示
    expect(text).toContain('compaction run');
    expect(text).toContain('Do NOT call any tools');
  });

  it('限定白名单态（allowedTools=[read,write]）→ 文案列出 read/write', () => {
    const input: SideRunReminderInput = { ...base, allowedTools: ['read', 'write'] };
    const text = buildReminderText(input);
    expect(text).toContain('[read, write]');
    expect(text).not.toContain('no tools allowed');
  });

  it('runKind=consolidate 微调（§3.3）→ 文案含「memory extraction run」', () => {
    const input: SideRunReminderInput = { runKind: 'consolidate', sessionId: 's1', allowedTools: [] };
    const text = buildReminderText(input);
    expect(text).toContain('memory extraction run');
  });
});

describe('side-run-reminder-injector — buildReminderText 通用骨架（§3.1）', () => {
  const base = { runKind: 'summary', sessionId: 's1' } as const;

  it('含「side run」自述', () => {
    const text = buildReminderText({ ...base, allowedTools: [] });
    expect(text).toContain('side run');
  });

  it('含「MAIN agent」来源说明', () => {
    const text = buildReminderText({ ...base, allowedTools: [] });
    expect(text).toContain('MAIN agent');
  });

  it('含「ACTUALLY EXECUTE」实际可运行 tool 列表说明', () => {
    const text = buildReminderText({ ...base, allowedTools: [] });
    expect(text).toContain('ACTUALLY EXECUTE');
  });
});

describe('side-run-reminder-injector — injectSideRunReminder Message 形态', () => {
  it('返回 user-role Message，sender.source=system（不进 a2a 拓扑）', () => {
    const msg = injectSideRunReminder({ runKind: 'summary', sessionId: 's1', allowedTools: [] });
    expect(msg.role).toBe('user');
    expect(msg.sessionId).toBe('s1');
    expect(msg.sender?.source).toBe('system');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.type).toBe('text');
  });

  // 不写消息级 metadata.isSystemReminder（与 system_reminder_injector 一致，
  // 块级 TextBlock.isSystemReminder 为唯一权威）。防御性断言锁定行为。
  it('不写消息级 metadata.isSystemReminder（块级唯一权威）', () => {
    const msg = injectSideRunReminder({ runKind: 'summary', sessionId: 's1', allowedTools: [] });
    expect(msg.metadata?.isSystemReminder).toBeUndefined();
  });
});
