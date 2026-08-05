/**
 * [v0.0.130.hang 模块 A] resolveEffectiveTimeout / formatTimeoutText UT（白盒，纯函数）
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 A
 *       tools/engine-timeout.ts
 *
 * 覆盖：
 *   - per-call > per-tool > engine 默认 30s 三层优先级全分支
 *   - clamp 边界：1 / 600000 / 超界值归位
 *   - per-call 非法值（非 number / NaN / Infinity / <=0）一律忽略，降级下一优先级
 *   - formatTimeoutText 文本格式（含/不含 suffix）
 */
import { describe, it, expect } from 'vitest';
import { resolveEffectiveTimeout, formatTimeoutText, DEFAULT_TOOL_TIMEOUT_MS, TOOL_TIMEOUT_CEILING_MS } from '../engine-timeout';
import type { Tool } from '../types';

/** 构造一个仅用于本文件的最小 Tool（只需 definition.name + 可选 defaultTimeoutMs） */
function makeTool(defaultTimeoutMs?: number): Tool {
  return {
    definition: { name: 'fixture-tool', description: 'fixture', inputSchema: { type: 'object' } },
    defaultTimeoutMs,
    run: async () => ({ content: [], isError: false }),
  };
}

describe('resolveEffectiveTimeout（三层优先级 + clamp）', () => {
  it('per-call 提供且合法 → 优先于 per-tool 和默认', () => {
    const tool = makeTool(5000);
    expect(resolveEffectiveTimeout(2000, tool)).toBe(2000);
  });

  it('per-call 缺失（undefined）→ 降级 per-tool', () => {
    const tool = makeTool(5000);
    expect(resolveEffectiveTimeout(undefined, tool)).toBe(5000);
  });

  it('per-call 和 per-tool 都缺失 → 降级 engine 默认 30000', () => {
    const tool = makeTool(undefined);
    expect(resolveEffectiveTimeout(undefined, tool)).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30000);
  });

  it('per-call 非 number 类型（字符串）→ 忽略，降级 per-tool', () => {
    const tool = makeTool(8000);
    expect(resolveEffectiveTimeout('not-a-number', tool)).toBe(8000);
  });

  it('per-call = NaN → 忽略，降级 per-tool', () => {
    const tool = makeTool(8000);
    expect(resolveEffectiveTimeout(NaN, tool)).toBe(8000);
  });

  it('per-call = Infinity（非 finite）→ 忽略，降级 per-tool', () => {
    const tool = makeTool(8000);
    expect(resolveEffectiveTimeout(Infinity, tool)).toBe(8000);
  });

  it('per-call <= 0（0 或负数）→ 忽略，降级 per-tool', () => {
    const tool = makeTool(8000);
    expect(resolveEffectiveTimeout(0, tool)).toBe(8000);
    expect(resolveEffectiveTimeout(-100, tool)).toBe(8000);
  });

  it('per-call = null → 忽略，降级 per-tool', () => {
    const tool = makeTool(8000);
    expect(resolveEffectiveTimeout(null, tool)).toBe(8000);
  });

  it('clamp 下限：per-call 极小正数（0.5）不足 1 → clamp 到 1', () => {
    const tool = makeTool(undefined);
    expect(resolveEffectiveTimeout(0.5, tool)).toBe(1);
  });

  it('clamp 上限：per-call 超硬天花板 → clamp 到 600000', () => {
    const tool = makeTool(undefined);
    expect(resolveEffectiveTimeout(999999999, tool)).toBe(TOOL_TIMEOUT_CEILING_MS);
    expect(TOOL_TIMEOUT_CEILING_MS).toBe(600000);
  });

  it('per-tool 声明值超硬天花板（理论异常配置）→ 仍 clamp 到 600000', () => {
    const tool = makeTool(700000);
    expect(resolveEffectiveTimeout(undefined, tool)).toBe(600000);
  });

  it('边界值恰好 = 600000（硬天花板本身）→ 保留不变', () => {
    const tool = makeTool(undefined);
    expect(resolveEffectiveTimeout(600000, tool)).toBe(600000);
  });

  it('边界值恰好 = 1（下限本身）→ 保留不变', () => {
    const tool = makeTool(undefined);
    expect(resolveEffectiveTimeout(1, tool)).toBe(1);
  });

  it('不 mutate 入参 tool 对象（纯函数）', () => {
    const tool = makeTool(5000);
    const before = { ...tool };
    resolveEffectiveTimeout(2000, tool);
    expect(tool.defaultTimeoutMs).toBe(before.defaultTimeoutMs);
  });
});

describe('formatTimeoutText（统一超时文案格式化，AT designer flag 裁决①）', () => {
  it('无 suffix → `[timeout] <name> exceeded <ms>ms`', () => {
    expect(formatTimeoutText('bash', 2000)).toBe('[timeout] bash exceeded 2000ms');
  });

  it('有 suffix → 主文案后空格拼接 suffix', () => {
    expect(formatTimeoutText('bash', 125000, '(engine backstop)')).toBe(
      '[timeout] bash exceeded 125000ms (engine backstop)',
    );
  });

  it('文本恒以 [timeout] 开头（跨工具名/ms 值稳定契约）', () => {
    expect(formatTimeoutText('web_fetch', 30000)).toMatch(/^\[timeout\]/);
    expect(formatTimeoutText('agent', 600000, 'suffix')).toMatch(/^\[timeout\]/);
  });
});
