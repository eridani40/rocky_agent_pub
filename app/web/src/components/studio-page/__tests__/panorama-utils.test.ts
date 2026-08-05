/**
 * panorama-utils 单测 —— enumValueLabel 查找优先级 + parsePanoramaDsl 结构守卫.
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §4.4（{field}_labels 字段级优先 → status_labels 全局兜底 → 原值）
 *
 * v0.0.243：删 mergeBuiltinSchema case（前端镜像废除，后端返 schema 已含 task，前端不再合成）.
 */
import { describe, it, expect } from 'vitest';
import { enumValueLabel, parsePanoramaDsl } from '../panorama-utils';
import type { EntityDef } from '../panorama-types';

/** 无 states 实体：env / status 两个 enum 字段含同名值 prod */
const ENTITY: EntityDef = {
  label: '部署',
  id_field: 'id',
  fields: {
    id: { type: 'string' },
    env: { type: 'enum', values: ['staging', 'prod'] },
    status: { type: 'enum', values: ['queued', 'prod', 'failed'] },
  },
  display: {
    status_labels: { queued: '排队中', prod: '生产', failed: '失败' },
    env_labels: { prod: '生产环境' },
  },
};

const STATE_ENTITY: EntityDef = {
  ...ENTITY,
  states: { field: 'status', initial: 'queued', transitions: {} },
};

describe('enumValueLabel — enum 值中文 label 查找优先级', () => {
  it('状态机字段 → 走 status_labels', () => {
    expect(enumValueLabel(STATE_ENTITY, 'status', 'queued')).toBe('排队中');
  });

  it('非状态机 enum 无 {field}_labels → status_labels 全局兜底', () => {
    expect(enumValueLabel(ENTITY, 'status', 'queued')).toBe('排队中');
  });

  it('{field}_labels 覆盖 status_labels（同名值区分含义）', () => {
    expect(enumValueLabel(ENTITY, 'env', 'prod')).toBe('生产环境');
  });

  it('字段级与全局均无配置 → 兜底原值', () => {
    expect(enumValueLabel(ENTITY, 'env', 'staging')).toBe('staging');
  });
});

describe('parsePanoramaDsl — 结构守卫', () => {
  it('合法 DSL（含 entities + views）→ 解析返 schema', () => {
    const dsl = `
entities:
  feature:
    label: 功能
    id_field: id
    fields:
      id: { type: string }
views:
  - id: feat_tbl
    label: 功能表
    entity: feature
    component: table
    columns: [id]
`;
    const schema = parsePanoramaDsl(dsl);
    expect(schema.entities.feature).toBeDefined();
    expect(schema.views).toHaveLength(1);
    expect(schema.views[0]!.id).toBe('feat_tbl');
  });

  it('缺 entities → 抛 Error', () => {
    expect(() => parsePanoramaDsl('views: []')).toThrow(/missing entities/);
  });

  it('缺 views → 抛 Error', () => {
    expect(() => parsePanoramaDsl('entities: {}')).toThrow(/missing entities/);
  });
});
