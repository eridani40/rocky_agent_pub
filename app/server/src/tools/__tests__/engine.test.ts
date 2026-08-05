/**
 * ToolExecutionEngine validateInput UT（v0.0.68 R5 / D5 default-fill 通用机制）
 * 参考: specs/tech/version_logs/v0.0.68/change_plan.md R5 section
 *       specs/tech/agent/tools/[P1]agent_tools.md §validateInput（doc-modifier 阶段 5 同步）
 *
 * 锁定契约：
 *   - schema.properties[k].default → obj[k] 注入（缺字段补 default）
 *   - 已有值不覆盖（显式传值优先于 default）
 *   - default:false / 0 / '' 等 false-y 值**也注入**（!== undefined 判定，非 truthy）
 *   - default-fill 放 required + 类型校验**之后**（default 不绕过必填/类型约束）
 *
 * 白盒：直接调导出的 validateInput 函数，验证 mutate 副作用 + 校验通过返回 null。
 *      不走 engine.execute 全链路（default-fill 是 validateInput 内行为，单测聚焦）。
 */
import { describe, it, expect } from 'vitest';
import { validateInput } from '../engine';
import type { JSONSchemaLike } from '../types';

describe('validateInput default-fill（v0.0.68 R5 / D5 通用机制）', () => {
  it('缺字段 + schema 该字段有 default → 注入到 input（mutate 透传到 tool.run）', () => {
    const schema: JSONSchemaLike = {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string' },
        needReply: { type: 'boolean', default: true },
      },
    };
    const input: Record<string, unknown> = { target: 'parent' };
    const err = validateInput(schema, input);
    expect(err).toBeNull();
    // default-fill mutate：needReply 被注入为 true
    expect(input.needReply).toBe(true);
  });

  it('已有值 + schema 该字段有 default → 不覆盖（显式传值优先）', () => {
    const schema: JSONSchemaLike = {
      type: 'object',
      properties: {
        needReply: { type: 'boolean', default: true },
      },
    };
    const input: Record<string, unknown> = { needReply: false };
    const err = validateInput(schema, input);
    expect(err).toBeNull();
    // 显式 false 不被 default 覆盖（UC-14 关键约束）
    expect(input.needReply).toBe(false);
  });

  it('default:false（false-y 值）也注入——判定用 !== undefined，非 truthy', () => {
    const schema: JSONSchemaLike = {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', default: false },
        count: { type: 'number', default: 0 },
        label: { type: 'string', default: '' },
      },
    };
    const input: Record<string, unknown> = {};
    const err = validateInput(schema, input);
    expect(err).toBeNull();
    // false-y default 都被注入（如果用 truthy 判定会跳过 → bug）
    expect(input.verbose).toBe(false);
    expect(input.count).toBe(0);
    expect(input.label).toBe('');
  });

  it('default-fill 放 required 之后：required 缺失仍返错误（default 不绕过必填）', () => {
    const schema: JSONSchemaLike = {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string' },
        needReply: { type: 'boolean', default: true },
      },
    };
    const input: Record<string, unknown> = {}; // target 缺失
    const err = validateInput(schema, input);
    expect(err).toBe('missing required field: target');
    // 校验失败时不应触发 default-fill（短路 return）
    expect(input.needReply).toBeUndefined();
  });

  it('default-fill 放类型校验之后：类型不匹配仍返错误（default 不绕过类型约束）', () => {
    const schema: JSONSchemaLike = {
      type: 'object',
      properties: {
        needReply: { type: 'boolean', default: true },
      },
    };
    // 显式传错类型 → 类型校验拦（不会因 default:true 而"修正"）
    const input: Record<string, unknown> = { needReply: 'not-bool' };
    const err = validateInput(schema, input);
    expect(err).toBe('field needReply must be boolean');
  });

  it('无 properties / 无 default 字段：行为不变（向后兼容）', () => {
    const schema: JSONSchemaLike = {
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string' } },
    };
    const input: Record<string, unknown> = { target: 'parent' };
    const before = { ...input };
    const err = validateInput(schema, input);
    expect(err).toBeNull();
    expect(input).toEqual(before); // 无 default 字段，input 不变
  });

  it('schema 为 undefined → null（向后兼容，无 mutate）', () => {
    const input: Record<string, unknown> = { foo: 'bar' };
    const err = validateInput(undefined, input);
    expect(err).toBeNull();
    expect(input.foo).toBe('bar');
  });

  it('send_message 首消费者契约：needReply 缺失 → default:true 注入（UC-13）', () => {
    // 模拟 send_message inputSchema 形态（不直接 import 工具，保持 engine UT 独立）
    const schema: JSONSchemaLike = {
      type: 'object',
      required: ['target', 'content'],
      properties: {
        target: { description: 'agent ref' },
        content: { type: 'array' },
        needReply: { type: 'boolean', default: true },
      },
    };
    const input: Record<string, unknown> = {
      target: 'parent',
      content: [{ type: 'text', text: 'hi' }],
    };
    const err = validateInput(schema, input);
    expect(err).toBeNull();
    expect(input.needReply).toBe(true);
  });
});
