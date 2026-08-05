/**
 * Partial 保留策略 UT
 * 参考: test-plan §3 retry_and_timeout 行 + spec §4
 *
 * 校验点（§4 表）：
 *   - user abort：保留（无论 tool_use 完整性）
 *   - watchdog_ttfb abort：丢弃
 *   - watchdog_stall abort：丢弃，除非无未完成 tool_use
 *   - wall_max abort：丢弃，除非无未完成 tool_use
 *   - STREAM_INCOMPLETE：视 tool_use 完整性
 *   - MAX_TOKENS_EXCEEDED：保留
 */
import { describe, it, expect } from 'vitest';
import {
  shouldKeepPartialOnAbort,
  shouldKeepPartialOnError,
} from '../partial_policy';

describe('shouldKeepPartialOnAbort（§4 abort 场景）', () => {
  it('user abort → 保留（无论 tool_use 完整性）', () => {
    expect(shouldKeepPartialOnAbort('user', false)).toBe(true);
    expect(shouldKeepPartialOnAbort('user', true)).toBe(true);
  });

  it('watchdog_ttfb abort → 丢弃（无 partial 可言）', () => {
    expect(shouldKeepPartialOnAbort('watchdog_ttfb', false)).toBe(false);
    expect(shouldKeepPartialOnAbort('watchdog_ttfb', true)).toBe(false);
  });

  it('watchdog_stall abort → 无未完成 tool_use 时保留', () => {
    expect(shouldKeepPartialOnAbort('watchdog_stall', false)).toBe(true);
  });

  it('watchdog_stall abort → 有未完成 tool_use 时丢弃（流断不可信）', () => {
    expect(shouldKeepPartialOnAbort('watchdog_stall', true)).toBe(false);
  });

  it('wall_max abort → 无未完成 tool_use 时保留', () => {
    expect(shouldKeepPartialOnAbort('wall_max', false)).toBe(true);
  });

  it('wall_max abort → 有未完成 tool_use 时丢弃', () => {
    expect(shouldKeepPartialOnAbort('wall_max', true)).toBe(false);
  });
});

describe('shouldKeepPartialOnError（§4 非 abort 错误）', () => {
  it('STREAM_INCOMPLETE + 无未完成 tool_use → 保留（供 prefill）', () => {
    expect(shouldKeepPartialOnError('STREAM_INCOMPLETE', false)).toBe(true);
  });

  it('STREAM_INCOMPLETE + 有未完成 tool_use → 丢弃', () => {
    expect(shouldKeepPartialOnError('STREAM_INCOMPLETE', true)).toBe(false);
  });

  it('MAX_TOKENS_EXCEEDED → 保留（供 prefill 续写）', () => {
    expect(shouldKeepPartialOnError('MAX_TOKENS_EXCEEDED', false)).toBe(true);
    expect(shouldKeepPartialOnError('MAX_TOKENS_EXCEEDED', true)).toBe(true);
  });

  it('OTHER → 丢弃（默认保守）', () => {
    expect(shouldKeepPartialOnError('OTHER', false)).toBe(false);
    expect(shouldKeepPartialOnError('OTHER', true)).toBe(false);
  });
});
