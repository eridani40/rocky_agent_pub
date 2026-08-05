/**
 * validate_system_entity UT — checkSystemEntityImmutable（panorama_validation §3 / panorama_builtin §3 不变量）.
 * 参考: specs/tech/version_logs/v0.0.243/change_plan.md §1 决策 4
 *
 * 三态：
 *   - leader 改 task 字段（label/fields/states/display 漂移）→ error `panorama_system_entity_immutable`
 *   - leader 提交的 task 字段与 canonical 一致（parser 丢 system flag）→ pass（inject 兜底补 system flag）
 *   - leader 未提交 task → pass（inject 阶段补全 canonical）
 *
 * 比较时排除 system 字段（leader DSL 经 parser 后无 system，含 system 比较必假——见决策 3）.
 */
import { describe, it, expect } from 'vitest';
import { checkSystemEntityImmutable } from '../validate_system_entity';
import type { ValidationError } from '../types';
import { TASK_ENTITY_DEF } from '../../builtin/task-schema';
import type { PanoramaSchema, EntityDef } from '../../dsl/types';

/** 收集 errors 的辅助 */
function run(schema: PanoramaSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  checkSystemEntityImmutable(schema, errors);
  return errors;
}

const baseSchema: PanoramaSchema = {
  meta: { version: '1.0' },
  entities: {},
  views: [],
};

describe('checkSystemEntityImmutable — 系统固定 entity 不可变', () => {
  it('态 1：leader 改 task.label → error panorama_system_entity_immutable', () => {
    const tampered: EntityDef = { ...TASK_ENTITY_DEF, label: '被改的标签' };
    const schema: PanoramaSchema = {
      ...baseSchema,
      entities: { task: tampered },
    };
    const errors = run(schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('panorama_system_entity_immutable');
    expect(errors[0]!.path).toBe('entities.task');
    expect(errors[0]!.layer).toBe('schema');
    expect(errors[0]!.message).toContain('task');
  });

  it('态 1：leader 改 task.fields（删字段）→ error', () => {
    const tampered: EntityDef = {
      ...TASK_ENTITY_DEF,
      fields: { id: TASK_ENTITY_DEF.fields.id! }, // 删了大部分字段
    };
    const schema: PanoramaSchema = {
      ...baseSchema,
      entities: { task: tampered },
    };
    const errors = run(schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('panorama_system_entity_immutable');
  });

  it('态 1：leader 改 task.states.initial → error', () => {
    const tampered: EntityDef = {
      ...TASK_ENTITY_DEF,
      states: { ...TASK_ENTITY_DEF.states!, initial: 'done' },
    };
    const schema: PanoramaSchema = {
      ...baseSchema,
      entities: { task: tampered },
    };
    const errors = run(schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('panorama_system_entity_immutable');
  });

  it('态 2：leader 提交 task 字段与 canonical 一致（无 system flag）→ pass', () => {
    // 模拟 parser 后状态：leader 复制了 TASK_ENTITY_DEF 但 system flag 被 parser 丢弃
    const { system: _drop, ...withoutSystem } = TASK_ENTITY_DEF;
    const submitted: EntityDef = withoutSystem as EntityDef;
    const schema: PanoramaSchema = {
      ...baseSchema,
      entities: { task: submitted },
    };
    const errors = run(schema);
    expect(errors).toHaveLength(0);
  });

  it('态 3：leader 未提交 task（schema 无 task）→ pass（inject 兜底）', () => {
    const schema: PanoramaSchema = {
      ...baseSchema,
      entities: {
        book: { label: '书', id_field: 'id', fields: { id: { type: 'string' } } },
      },
    };
    const errors = run(schema);
    expect(errors).toHaveLength(0);
  });

  it('非 system entity（book）字段随意 → 不影响（不在 SYSTEM_ENTITY_DEFS 内）', () => {
    const schema: PanoramaSchema = {
      ...baseSchema,
      entities: {
        book: { label: '任何', id_field: 'whatever', fields: { whatever: { type: 'string' } } },
      },
    };
    const errors = run(schema);
    expect(errors).toHaveLength(0);
  });

  it('suggestion 含修复指引（移除/改名）', () => {
    const tampered: EntityDef = { ...TASK_ENTITY_DEF, label: '改' };
    const schema: PanoramaSchema = {
      ...baseSchema,
      entities: { task: tampered },
    };
    const errors = run(schema);
    expect(errors[0]!.suggestion).toBeDefined();
    expect(errors[0]!.suggestion).toContain('移除');
  });
});
