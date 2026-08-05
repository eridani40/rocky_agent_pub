// @vitest-environment node
/**
 * sse-client 单测（v0.0.88：{topic,group,data,timestamp,subId} 帧格式）
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §4（SSE channel）
 *
 * 帧格式：`data: {"topic":...,"group":...,"data":<AgentEvent>,"timestamp":...,"subId":...}\n\n`
 */
import { describe, it, expect } from 'vitest';
import { parseSseFrames } from '../sse-client';

describe('parseSseFrames — v0.0.88 帧解析', () => {
  it('完整单帧解析出 topic/group/data/timestamp/subId', () => {
    const frame =
      'data: {"topic":"agent_loop","group":"session_id:S1","data":{"type":"run_start","runId":"R1"},"timestamp":"2026-06-21T00:00:00Z","subId":"sub-1"}\n\n';
    const { frames, rest } = parseSseFrames(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      topic: 'agent_loop',
      group: 'session_id:S1',
      timestamp: '2026-06-21T00:00:00Z',
      subId: 'sub-1',
    });
    expect((frames[0]!.data as { type: string }).type).toBe('run_start');
    expect(rest).toBe('');
  });

  it('多帧一次性解析', () => {
    const chunk =
      'data: {"topic":"agent_loop","group":"session_id:S1","data":{"type":"run_start"},"timestamp":"t1","subId":"sub-a"}\n\n' +
      'data: {"topic":"agent_loop","group":"session_id:S1","data":{"type":"run_end","stopReason":"no_tool_call"},"timestamp":"t2","subId":"sub-b"}\n\n';
    const { frames } = parseSseFrames(chunk);
    expect(frames).toHaveLength(2);
    expect((frames[0]!.data as { type: string }).type).toBe('run_start');
    expect((frames[1]!.data as { type: string; stopReason: string }).stopReason).toBe('no_tool_call');
  });

  it('半帧缓冲（缺结尾 \\n\\n 不产出，留 rest）', () => {
    const half =
      'data: {"topic":"agent_loop","group":"session_id:S1","data":{"type":"run_start"}';
    const { frames, rest } = parseSseFrames(half);
    expect(frames).toEqual([]);
    expect(rest).toBe(half);
  });

  it('跨帧拼接（先半帧，补全后产出）', () => {
    const half =
      'data: {"topic":"agent_loop","group":"session_id:S1","data":{"type":"run_start"}';
    const { frames: e1, rest: r1 } = parseSseFrames(half);
    expect(e1).toEqual([]);
    const { frames: e2, rest: r2 } = parseSseFrames(r1 + ',"timestamp":"t1","subId":"sub-c"}\n\n');
    expect(e2).toHaveLength(1);
    expect(r2).toBe('');
  });

  it('坏 JSON 帧忽略不抛错', () => {
    const chunk = 'data: {not json\n\n';
    const { frames } = parseSseFrames(chunk);
    expect(frames).toEqual([]);
  });
});
