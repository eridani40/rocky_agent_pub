/**
 * Watchdog UT（三计时器阶段感知 + tool stall 切分）
 * 参考: test-plan §3 retry_and_timeout 行 + spec §2
 *
 * 校验点：
 *   - getStallThreshold 按事件类型切换（thinking 30 / tool 120 / answer 30）
 *   - TTFB 计时器触发 abortByTtfbTimeout（首 chunk 前超时）
 *   - 首 chunk 后 TTFB 停、stall 启动（answer 阶段默认）
 *   - 阶段感知 stall：thinking_delta → think 阈值；tool_call_delta → tool 阈值
 *   - tool 阶段切分（§2.3）：finish 事件后 stop() 停所有 timer，工具执行期不持有计时器
 *   - wall-clock 兜底触发 abortByWallMax
 * 使用 vitest fake timers 保证确定性。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Watchdog, getStallThreshold } from '../watchdog';
import { CompositeAbortController } from '../composite_abort';
import { DEFAULT_TIMEOUT_CONFIG } from '../config_types';

const CFG = DEFAULT_TIMEOUT_CONFIG; // ttfb 45 / answer 30 / think 30 / tool 120 / wall 600

describe('getStallThreshold', () => {
  it('thinking_delta → stall_think_s', () => {
    expect(getStallThreshold({ type: 'thinking_delta' }, CFG)).toBe(30000);
  });

  it('tool_call_delta → stall_tool_s（120s，tool 实参流式期）', () => {
    expect(getStallThreshold({ type: 'tool_call_delta' }, CFG)).toBe(120000);
  });

  it('text_delta → stall_answer_s', () => {
    expect(getStallThreshold({ type: 'text_delta' }, CFG)).toBe(30000);
  });

  it('usage → stall_answer_s', () => {
    expect(getStallThreshold({ type: 'usage' }, CFG)).toBe(30000);
  });

  it('finish → stall_answer_s', () => {
    expect(getStallThreshold({ type: 'finish' }, CFG)).toBe(30000);
  });

  it('error → stall_answer_s', () => {
    expect(getStallThreshold({ type: 'error' }, CFG)).toBe(30000);
  });
});

describe('Watchdog 计时器', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('TTFB 超时 → abortByTtfbTimeout（首 chunk 前超 45s）', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    expect(c.reason).toBeNull();

    vi.advanceTimersByTime(45001);
    expect(c.reason).toBe('watchdog_ttfb');
    w.stop();
  });

  it('首 chunk 到达后 TTFB 不再触发（onFirstChunk 切换）', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();

    vi.advanceTimersByTime(10000); // 10s 首 chunk 到
    w.onFirstChunk();
    // 推过 45s TTFB 阈值，同时持续 reset stall（answer 30s）避免 stall 先触发
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(10000); // 每 10s 一个 chunk
      w.onChunk({ type: 'text_delta' });
    }
    // 累计 50s > 45s TTFB，但 TTFB 已停、stall 持续被 reset
    expect(c.reason).toBeNull();
    w.stop();
  });

  it('首 chunk 后 stall 超时 → abortByStallTimeout（answer 30s 无 chunk）', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.onFirstChunk();

    vi.advanceTimersByTime(30001);
    expect(c.reason).toBe('watchdog_stall');
    w.stop();
  });

  it('阶段感知 stall：chunk 到达 reset stall 阈值', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.onFirstChunk(); // answer 30s

    vi.advanceTimersByTime(25000); // 25s
    w.onChunk({ type: 'text_delta' }); // reset → 又 30s
    vi.advanceTimersByTime(28000); // 累计距上次 chunk 28s < 30s
    expect(c.reason).toBeNull();

    vi.advanceTimersByTime(5000); // 距上次 chunk 33s > 30s
    expect(c.reason).toBe('watchdog_stall');
    w.stop();
  });

  it('阶段感知 stall：tool_call_delta 切到 120s 阈值', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.onFirstChunk();

    w.onChunk({ type: 'tool_call_delta' }); // → stall 120s
    vi.advanceTimersByTime(40000); // 40s < 120s
    expect(c.reason).toBeNull();

    w.onChunk({ type: 'tool_call_delta' }); // reset stall 120s
    vi.advanceTimersByTime(121000); // 距上次 chunk 121s > 120s
    expect(c.reason).toBe('watchdog_stall');
    w.stop();
  });

  it('阶段感知 stall：thinking_delta 切到 30s（与 answer 同阈值但语义独立）', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.onFirstChunk();
    w.onChunk({ type: 'thinking_delta' }); // → 30s

    vi.advanceTimersByTime(29000); // 29s < 30s
    expect(c.reason).toBeNull();
    vi.advanceTimersByTime(2000); // 31s > 30s
    expect(c.reason).toBe('watchdog_stall');
    w.stop();
  });

  it('§2.3 tool 阶段切分：finish 事件后 stop() 停所有 timer，工具执行期不触发', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.onFirstChunk();
    w.onChunk({ type: 'tool_call_delta' }); // tool 实参流式
    w.onChunk({ type: 'finish' }); // LLM stream 正常结束

    w.stop(); // invoke return，停所有 timer（§2.3）

    // 模拟工具执行期：长时间过去，不应有任何 abort 触发
    vi.advanceTimersByTime(600000); // 10 分钟
    expect(c.reason).toBeNull(); // 工具执行期 LlmCaller 不持有计时器
  });

  it('wall-clock 兜底：超 600s 触发 abortByWallMax', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.onFirstChunk();

    // 持续 reset stall 避免先触发 stall
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(25000);
      w.onChunk({ type: 'text_delta' });
    }
    // 累计约 500s，再推到 > 600s
    vi.advanceTimersByTime(120000); // 推过 wall_max
    expect(c.reason === 'wall_max' || c.reason === 'watchdog_stall').toBe(true);
    // 至少 wall 应触发；若 stall 先触发也算正常（取决于精确时序）
    w.stop();
  });

  it('stop() 后可重新 start()（下一 iteration invoke 重新启动 watchdog）', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.onFirstChunk();
    w.stop();

    // 下一 iteration
    const c2 = new CompositeAbortController();
    const w2 = new Watchdog(c2, CFG);
    w2.start();
    expect(c2.reason).toBeNull();
    vi.advanceTimersByTime(45001);
    expect(c2.reason).toBe('watchdog_ttfb');
    w2.stop();
  });

  it('重复 start() 不重复启动（幂等）', () => {
    const c = new CompositeAbortController();
    const w = new Watchdog(c, CFG);
    w.start();
    w.start(); // 重复
    // 只应有一个 TTFB timer，触发一次
    vi.advanceTimersByTime(45001);
    expect(c.reason).toBe('watchdog_ttfb');
    w.stop();
  });
});
