/**
 * HeartbeatTickHandler 单测。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §0.1
 *
 * 逐字一致性验证法：EXPECTED_HEARTBEAT_TICK_PROMPT 与 src/prompts/content/tick_heartbeat.md 原文快照对齐，
 * 断言 handler.build().content === EXPECTED_HEARTBEAT_TICK_PROMPT（含内部 \n、无尾随换行）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HeartbeatTickHandler } from '../handlers/heartbeat-tick-handler';
import { __clearPromptCacheForTests } from '../prompt-handler';

/** 与 content/tick_heartbeat.md 原文对齐的快照 */
const EXPECTED_HEARTBEAT_TICK_PROMPT =
  '这是团队自动工作的提醒。\n你可以检查现在属于你的任务、需求、目标等，或者之前被中断的工作。如无需要进行的工作，回复「无进行中工作，退出」';

describe('HeartbeatTickHandler', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('build().content === tick_heartbeat.md 原文（逐字一致，含内部 \\n、无尾随换行）', () => {
    const content = new HeartbeatTickHandler().build({}).content;
    expect(content).toBe(EXPECTED_HEARTBEAT_TICK_PROMPT);
  });

  it('含「无进行中工作，退出」软出口引导句', () => {
    const content = new HeartbeatTickHandler().build({}).content;
    expect(content).toContain('无进行中工作，退出');
  });

  it('产出无尾随换行', () => {
    const content = new HeartbeatTickHandler().build({}).content;
    expect(content.endsWith('\n')).toBe(false);
  });
});
