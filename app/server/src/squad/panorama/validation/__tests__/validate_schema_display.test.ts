/**
 * validate_schema display 校验 UT —— checkDisplay 的 warning 行为.
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §4.4
 * 无 states 实体也校验：status_labels/status_colors key 对任一 enum 字段 values 并集；
 * {field}_labels key 对应该字段 values，field 名写错也告警。
 */
import { describe, it, expect } from 'vitest';
import { validateSchema } from '../validate_schema';

const BASE = `
meta:
  version: "1.0"
entities:
  deployment:
    label: 部署
    id_field: id
    fields:
      id: { type: string }
      env: { type: enum, values: [staging, prod] }
      region: { type: enum, values: [east, west] }
    DISPLAY
views: []`;

const withDisplay = (display: string) => validateSchema(BASE.replace('DISPLAY', display));
const warns = (r: ReturnType<typeof validateSchema>) =>
  r.warnings.filter(w => w.code === 'panorama_warn_unknown_display_key');

describe('checkDisplay — display key warning（无 states 实体）', () => {
  it('status_labels key 不在任一 enum values 并集内 → warn', () => {
    const r = withDisplay('display:\n      status_labels: { prod: 生产, bogus: 未知 }');
    const w = warns(r);
    expect(w).toHaveLength(1);
    expect(w[0]!.path).toContain('bogus');
  });

  it('status_labels key 在非状态机 enum 字段 values 内 → 不 warn', () => {
    const r = withDisplay('display:\n      status_labels: { prod: 生产, east: 东部 }');
    expect(warns(r)).toHaveLength(0);
  });

  it('{field}_labels 合法（field 是 enum 字段且 key 在 values 内）→ 不 warn', () => {
    const r = withDisplay('display:\n      env_labels: { staging: 预发, prod: 生产 }');
    expect(warns(r)).toHaveLength(0);
  });

  it('{field}_labels key 不在该字段 values 内（即使在别的字段 values 里）→ warn', () => {
    const r = withDisplay('display:\n      env_labels: { east: 东部 }');
    const w = warns(r);
    expect(w).toHaveLength(1);
    expect(w[0]!.path).toContain('env_labels.east');
  });

  it('{name}_labels 的 name 不是任何 enum 字段名 → warn', () => {
    const r = withDisplay('display:\n      evn_labels: { prod: 生产 }');
    const w = warns(r);
    expect(w).toHaveLength(1);
    expect(w[0]!.path).toContain('evn_labels');
  });
});
