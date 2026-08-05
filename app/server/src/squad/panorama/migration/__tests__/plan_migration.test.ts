/**
 * plan_migration UT — 分类 + 审批门槛 + 方案生成覆盖：
 *   纯增量/破坏性分类/major vs minor/planMigration 生成 operations/validateMigrationCoverage.
 */
import { describe, it, expect } from 'vitest';
import { classifyChanges, requiresApproval, analyzeMigration, planMigration, validateMigrationCoverage } from '../plan_migration';
import type { SchemaChange } from '../types';
import type { PanoramaSchema } from '../../dsl/types';

function schema(): PanoramaSchema {
  return {
    meta: { version: '1.0' },
    entities: { e1: { label: 'E', id_field: 'id', fields: { id: { type: 'string' }, s: { type: 'enum', values: ['a', 'b'] } } } },
    views: [],
  };
}

describe('classifyChanges', () => {
  it('增量变更分类正确', () => {
    const changes: SchemaChange[] = [
      { kind: 'entity_added', entity: 'e2' },
      { kind: 'field_added', entity: 'e1', field: 'f1' },
      { kind: 'enum_expanded', entity: 'e1', field: 's' },
    ];
    const { incremental, breaking } = classifyChanges(changes);
    expect(incremental).toHaveLength(3);
    expect(breaking).toHaveLength(0);
  });

  it('破坏性变更分类正确', () => {
    const changes: SchemaChange[] = [
      { kind: 'entity_deleted', entity: 'e1' },
      { kind: 'enum_narrowed', entity: 'e1', field: 's' },
      { kind: 'field_type_changed', entity: 'e1', field: 'f1' },
    ];
    const { incremental, breaking } = classifyChanges(changes);
    expect(breaking).toHaveLength(3);
    expect(incremental).toHaveLength(0);
  });

  it('混合变更正确分离', () => {
    const changes: SchemaChange[] = [
      { kind: 'field_added', entity: 'e1', field: 'f2' },
      { kind: 'entity_deleted', entity: 'e1' },
    ];
    const { incremental, breaking } = classifyChanges(changes);
    expect(incremental).toHaveLength(1);
    expect(breaking).toHaveLength(1);
  });
});

describe('requiresApproval', () => {
  it('无破坏性 → none', () => {
    expect(requiresApproval([])).toBe('none');
  });

  it('删实体(有数据) → major', () => {
    const breaking: SchemaChange[] = [{ kind: 'entity_deleted', entity: 'e1' }];
    expect(requiresApproval(breaking, { hasInstances: () => 5 })).toBe('major');
  });

  it('删实体(无数据) → minor', () => {
    const breaking: SchemaChange[] = [{ kind: 'entity_deleted', entity: 'e1' }];
    expect(requiresApproval(breaking, { hasInstances: () => 0 })).toBe('minor');
  });

  it('收紧约束(有数据) → minor', () => {
    const breaking: SchemaChange[] = [{ kind: 'constraint_tightened', entity: 'e1', field: 'f1' }];
    expect(requiresApproval(breaking, { hasInstances: () => 5 })).toBe('minor');
  });

  it('改字段类型(有数据) → major', () => {
    const breaking: SchemaChange[] = [{ kind: 'field_type_changed', entity: 'e1', field: 'f1' }];
    expect(requiresApproval(breaking, { hasInstances: () => 1 })).toBe('major');
  });

  it('缺省 hasInstances 保守判 major', () => {
    const breaking: SchemaChange[] = [{ kind: 'enum_narrowed', entity: 'e1', field: 's' }];
    expect(requiresApproval(breaking)).toBe('major');
  });
});

describe('analyzeMigration', () => {
  it('纯增量 schema → needsMigrationPlan=false', () => {
    const old = schema();
    const next: PanoramaSchema = { ...old, entities: { ...old.entities, e2: { label: 'E2', id_field: 'id', fields: { id: { type: 'string' } } } } };
    const analysis = analyzeMigration(old, next);
    expect(analysis.needsMigrationPlan).toBe(false);
    expect(analysis.approval).toBe('none');
  });

  it('含删字段 → needsMigrationPlan=true', () => {
    const old = schema();
    const next: PanoramaSchema = { ...old, entities: { e1: { label: 'E', id_field: 'id', fields: { id: { type: 'string' } } } } };
    const analysis = analyzeMigration(old, next);
    expect(analysis.needsMigrationPlan).toBe(true);
  });
});

describe('planMigration', () => {
  it('生成 operations 覆盖所有 breaking changes', () => {
    const old = schema();
    const next: PanoramaSchema = { ...old, entities: { e1: { label: 'E', id_field: 'id', fields: { id: { type: 'string' }, s: { type: 'enum', values: ['a'] } } } } };
    const plan = planMigration(old, next);
    expect(plan.operations.length).toBeGreaterThanOrEqual(1);
    // enum_narrowed → narrow_enum operation
    const hasNarrow = plan.operations.some(op => op.operation === 'narrow_enum');
    expect(hasNarrow).toBe(true);
  });

  it('删实体 → delete_entity + archive handler', () => {
    const old = schema();
    const next: PanoramaSchema = { ...old, entities: {} };
    const plan = planMigration(old, next);
    const op = plan.operations.find(o => o.operation === 'delete_entity');
    expect(op).toBeDefined();
    expect(op!.handler.strategy).toBe('archive');
  });

  it('改字段类型 → change_field_type + default handler', () => {
    const old = schema();
    const next: PanoramaSchema = { ...old, entities: { e1: { label: 'E', id_field: 'id', fields: { id: { type: 'number' }, s: { type: 'enum', values: ['a', 'b'] } } } } };
    const plan = planMigration(old, next);
    const op = plan.operations.find(o => o.operation === 'change_field_type');
    expect(op).toBeDefined();
    expect(op!.handler.strategy).toBe('default');
  });
});

describe('validateMigrationCoverage', () => {
  it('plan 覆盖所有 breaking → 不抛', () => {
    const old = schema();
    const next: PanoramaSchema = { ...old, entities: {} };
    const analysis = analyzeMigration(old, next);
    const plan = planMigration(old, next);
    expect(() => validateMigrationCoverage(analysis, plan)).not.toThrow();
  });

  it('plan 缺 operation → throw MigrationMismatchError', () => {
    const old = schema();
    const next: PanoramaSchema = { ...old, entities: {} };
    const analysis = analyzeMigration(old, next);
    const plan = { operations: [] }; // 空 plan
    expect(() => validateMigrationCoverage(analysis, plan)).toThrow();
  });
});
