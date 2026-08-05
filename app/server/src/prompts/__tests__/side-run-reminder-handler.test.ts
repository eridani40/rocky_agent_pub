/**
 * SideRunReminderHandler 单测（buildReminderText 骨架/两态/mode_tail 由 md 承载）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]forked_reminder.md §3
 *
 * 逐字一致性验证法：originalBuildReminderText 复刻 buildReminderText 的 lines 数组拼接逻辑，
 * 对比新实现（handler.build() + readToolsNone）在代表性输入下产出完全相等。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SideRunReminderHandler } from '../handlers/side-run-reminder-handler';
import { buildReminderText } from '../../agent/side-run-reminder-injector';
import { __clearPromptCacheForTests } from '../prompt-handler';

/** buildReminderText 预期实现快照（逐字拼接逻辑，供回归对比） */
function originalBuildReminderText(input: {
  allowedTools: string[];
  runKind: string;
}): string {
  const { allowedTools, runKind } = input;

  const actualToolsDescription =
    allowedTools.length === 0
      ? '[] (no tools allowed — output summary text directly)'
      : `[${allowedTools.join(', ')}]`;

  const lines: string[] = [
    '[Side Run Context]',
    `You are running as a side run (runKind=${runKind}) — a short-lived in-memory run that reuses the main agent's prompt and tools for cache efficiency.`,
    '',
    'Key facts:',
    '- Your system prompt and tool definitions come from the MAIN agent (shared for cache), NOT chosen for this task.',
    `- The tools you can ACTUALLY EXECUTE = ${actualToolsDescription}.`,
    "- Focus on completing THIS message's task; do not call tools outside the executable list.",
    '- Output your result as final text answer (no send_message back to parent).',
  ];

  if (runKind === 'summary') {
    lines.push('');
    lines.push('This is a compaction run: produce a concise summary of the conversation so far as your final answer. Do NOT call any tools.');
  } else if (runKind === 'consolidate') {
    lines.push('');
    lines.push('This is a memory extraction run: use the allowed tools to extract and persist long-term memory, then output a brief status as final answer.');
  }

  return lines.join('\n');
}

describe('SideRunReminderHandler + buildReminderText（逐字回归）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  const cases: Array<{
    name: string;
    input: { allowedTools: string[]; runKind: string };
  }> = [
    { name: '零工具态 + summary tail', input: { allowedTools: [], runKind: 'summary' } },
    { name: '限定白名单态 + 无 tail', input: { allowedTools: ['read', 'write'], runKind: 'other' } },
    { name: '零工具态 + consolidate tail', input: { allowedTools: [], runKind: 'consolidate' } },
    { name: '限定单工具 + 无 tail', input: { allowedTools: ['bash'], runKind: '' } },
  ];

  for (const c of cases) {
    it(`${c.name} → 新实现与预期逐字等价`, () => {
      const expected = originalBuildReminderText(c.input);
      const actual = buildReminderText({ ...c.input, sessionId: 's1' });
      expect(actual).toBe(expected);
    });
  }

  it('SideRunReminderHandler.readToolsNone() 返 tools_none.md trim 后正文', () => {
    expect(new SideRunReminderHandler().readToolsNone()).toBe(
      '[] (no tools allowed — output summary text directly)',
    );
  });

  it('build() 未传 mode_tail_key → 只有骨架，不追加 tail 段', () => {
    const content = new SideRunReminderHandler().build({
      vars: { mode_key: 'x', actual_tools_description: 'y' },
    }).content;
    expect(content).not.toContain('compaction run');
    expect(content).not.toContain('memory extraction run');
  });
});
