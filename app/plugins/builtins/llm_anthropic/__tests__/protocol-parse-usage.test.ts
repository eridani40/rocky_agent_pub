/**
 * parseAnthropicUsage 单测（白盒）—— anthropic wire usage → spec Usage 字段
 * 参考: specs/tech/agent/session/[P0]session_usage.md §1（Usage 字段集权威）
 *       specs/research/v0.0.3-anthropic-protocol.md §3（anthropic wire usage 字段）
 *
 * v0.0.10 t6 新增：验证 anthropic wire 字段（input_tokens / output_tokens /
 * cache_read_input_tokens / cache_creation_input_tokens）翻译为 spec 完整 Usage
 * 字段（input_no_cache / output_response / input_cache_read / input_cache_write）
 * + derived totals（input_total_tokens / output_total_tokens / total_tokens）。
 */
import { describe, it, expect } from 'vitest';
import { parseAnthropicUsage } from '../protocol-parse-stream';

describe('parseAnthropicUsage — anthropic wire → spec Usage', () => {
  it('空/非对象输入返回空 Usage', () => {
    expect(parseAnthropicUsage(undefined)).toEqual({});
    expect(parseAnthropicUsage(null)).toEqual({});
    expect(parseAnthropicUsage('str')).toEqual({});
  });

  it('基础：input_tokens + output_tokens（无 cache）→ 翻译 + derived totals', () => {
    const u = parseAnthropicUsage({
      input_tokens: 320,
      output_tokens: 12,
    });
    expect(u.input_no_cache).toBe(320);
    expect(u.output_response).toBe(12);
    expect(u.input_total_tokens).toBe(320);
    expect(u.output_total_tokens).toBe(12);
    expect(u.total_tokens).toBe(332);
    // 无 cache → cache 字段不写入（避免噪声）
    expect(u.input_cache_read).toBeUndefined();
    expect(u.input_cache_write).toBeUndefined();
  });

  it('cache_control 命中：cache_read + cache_creation + input 翻译完整', () => {
    const u = parseAnthropicUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 80,
    });
    expect(u.input_cache_read).toBe(200);
    expect(u.input_cache_write).toBe(80);
    expect(u.input_no_cache).toBe(100);
    expect(u.output_response).toBe(50);
    // input_total = 200 + 80 + 100 = 380（spec §1）
    expect(u.input_total_tokens).toBe(380);
    expect(u.output_total_tokens).toBe(50);
    expect(u.total_tokens).toBe(430);
  });

  it('0 值字段不写入（避免输出全 0 噪声，undefined 不序列化）', () => {
    const u = parseAnthropicUsage({
      input_tokens: 0,
      output_tokens: 0,
    });
    // 0 值 input_no_cache/output_response 不写入；但 derived totals 是固定计算，写入
    expect(u.input_no_cache).toBeUndefined();
    expect(u.output_response).toBeUndefined();
    expect(u.input_total_tokens).toBe(0);
    expect(u.output_total_tokens).toBe(0);
    expect(u.total_tokens).toBe(0);
  });

  it('cost / currency / char 字段不在此填（由 client.computeCost / agent loop 填）', () => {
    const u = parseAnthropicUsage({
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(u.cost).toBeUndefined();
    expect(u.currency).toBeUndefined();
    expect(u.inputCharCount).toBeUndefined();
    expect(u.outputCharCount).toBeUndefined();
  });

  it('非 number 字段被忽略（容错）', () => {
    const u = parseAnthropicUsage({
      input_tokens: '320',
      output_tokens: 12,
    });
    // input_tokens 非 number → 按 0 处理
    expect(u.input_total_tokens).toBe(0);
    expect(u.output_response).toBe(12);
  });
});
