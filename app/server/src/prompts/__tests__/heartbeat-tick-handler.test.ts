/**
 * HeartbeatTickHandler 单测（v0.0.153 T3-d：HEARTBEAT_TICK_PROMPT 迁 content/tick_heartbeat.md）
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §0.1
 *       specs/tech/version_logs/v0.0.153/change_plan.md T3-d
 *
 * 逐字一致性验证法：ORIGINAL_HEARTBEAT_TICK_PROMPT 为 tick-message.ts 删除前的常量原文快照，
 * 断言 handler.build().content === ORIGINAL_HEARTBEAT_TICK_PROMPT（含内部 \n、无尾随换行）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HeartbeatTickHandler } from '../handlers/heartbeat-tick-handler';
import { __clearPromptCacheForTests } from '../prompt-handler';

/** 原 tick-message.ts 内 HEARTBEAT_TICK_PROMPT 常量的原文快照（迁移前逐字复制） */
const ORIGINAL_HEARTBEAT_TICK_PROMPT =
  '这是团队自动工作的提醒。\n你可以检查现在属于你的任务、需求、目标等，或者之前被中断的工作。如果无需继续工作，则可以直接输出<EOS>并退出。';

describe('HeartbeatTickHandler（v0.0.153 T3-d）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('build().content === 原 HEARTBEAT_TICK_PROMPT（逐字一致，含内部 \\n、无尾随换行）', () => {
    const content = new HeartbeatTickHandler().build({}).content;
    expect(content).toBe(ORIGINAL_HEARTBEAT_TICK_PROMPT);
  });

  it('含 <EOS> 软出口引导句（不是 stop token，是文案内容）', () => {
    const content = new HeartbeatTickHandler().build({}).content;
    expect(content).toContain('<EOS>');
  });

  it('产出无尾随换行', () => {
    const content = new HeartbeatTickHandler().build({}).content;
    expect(content.endsWith('\n')).toBe(false);
  });
});
