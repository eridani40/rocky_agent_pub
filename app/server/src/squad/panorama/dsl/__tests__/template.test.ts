/**
 * template UT — interpolate / resolveRef 覆盖：
 *   {field} / {ref.target} / {field|fallback} / {{esc}} / null / 多插值 / 静态文本.
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §5.5
 */
import { describe, it, expect } from 'vitest';
import { interpolate, resolveRef } from '../template';
import type { PanoramaSchema } from '../types';

const dsl = { meta: { version: '1.0' }, entities: {}, views: [] } as PanoramaSchema;

describe('interpolate — 简单字段', () => {
  it('{field} → 字段值', () => {
    expect(interpolate('{branch}', { branch: 'main' }, dsl, '')).toBe('main');
  });

  it('多字段插值', () => {
    expect(interpolate('{id} . {branch}', { id: 'run-1', branch: 'main' }, dsl, '')).toBe('run-1 . main');
  });

  it('静态文本（无插值）原样输出', () => {
    expect(interpolate('hello world', {}, dsl, '')).toBe('hello world');
  });
});

describe('interpolate — null / 缺失 / fallback', () => {
  it('字段值为 null → 空串', () => {
    expect(interpolate('{x}', { x: null }, dsl, '')).toBe('');
  });

  it('字段缺失 → 空串', () => {
    expect(interpolate('{x}', {}, dsl, '')).toBe('');
  });

  it('字段为空串 → 空串', () => {
    expect(interpolate('{x}', { x: '' }, dsl, '')).toBe('');
  });

  it('{field|fallback} null → fallback', () => {
    expect(interpolate('{x|N/A}', { x: null }, dsl, '')).toBe('N/A');
  });

  it('{field|fallback} 有值 → 值', () => {
    expect(interpolate('{x|N/A}', { x: 'ok' }, dsl, '')).toBe('ok');
  });
});

describe('interpolate — ref 嵌套', () => {
  it('{ref.target} → 目标实例字段值', () => {
    const record = { pipeline_ref: { branch: 'dev', id: 'run-0' } };
    expect(interpolate('{pipeline_ref.branch}', record, dsl, '')).toBe('dev');
  });

  it('{ref.target|fallback} 目标已删 → fallback', () => {
    const record = { pipeline_ref: null };
    expect(interpolate('{pipeline_ref.branch|未知}', record, dsl, '')).toBe('未知');
  });

  it('{ref.target} ref 值为字符串 ID（未预解析）→ 空串', () => {
    const record = { pipeline_ref: 'run-0' };
    expect(interpolate('{pipeline_ref.branch}', record, dsl, '')).toBe('');
  });
});

describe('interpolate — {{转义}}', () => {
  it('{{field}} → {field} 字面输出', () => {
    expect(interpolate('{{field}}', { field: 'val' }, dsl, '')).toBe('{field}');
  });

  it('混合：插值 + 转义', () => {
    expect(interpolate('{branch} {{literal}}', { branch: 'main' }, dsl, '')).toBe('main {literal}');
  });
});

describe('interpolate — 边界', () => {
  it('tpl=undefined → 空串', () => {
    expect(interpolate(undefined, {}, dsl, '')).toBe('');
  });

  it('数字字段值转字符串', () => {
    expect(interpolate('{count}', { count: 42 }, dsl, '')).toBe('42');
  });

  it('boolean 字段值转字符串', () => {
    expect(interpolate('{flag}', { flag: true }, dsl, '')).toBe('true');
  });
});

describe('resolveRef', () => {
  it('返回预解析的目标对象', () => {
    const record = { ref: { id: '1', name: 'test' } };
    expect(resolveRef(record, 'ref', dsl)).toEqual({ id: '1', name: 'test' });
  });

  it('null ref → null', () => {
    expect(resolveRef({ ref: null }, 'ref', dsl)).toBeNull();
  });

  it('字符串 ID（未预解析）→ null', () => {
    expect(resolveRef({ ref: 'some-id' }, 'ref', dsl)).toBeNull();
  });

  it('缺失字段 → null', () => {
    expect(resolveRef({}, 'ref', dsl)).toBeNull();
  });
});
