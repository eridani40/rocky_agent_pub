/**
 * 系统固定 entity 不可变校验（v0.0.243 — panorama_validation §3）.
 * 参考: specs/tech/squad/[P1]panorama_builtin.md §3 不变量（system entity 不可 edit/delete）
 *       specs/tech/version_logs/v0.0.243/change_plan.md §1 决策 4
 *
 * 职责：leader 提交的 schema 命中系统 entity 名（如 task）且字段与 canonical 不一致 → error.
 * 比较时排除 `system` 字段（leader DSL 经 parser 后无 system，含 system 比较必假——见决策 3）.
 *
 * 三态：
 *   - leader 改 task 字段（label/fields/states/display 漂移）→ error `panorama_system_entity_immutable`
 *   - leader 提交的 task 字段与 canonical 一致（parser 丢 system 后）→ pass（inject 兜底补 system flag）
 *   - leader 未提交 task（schema 无 task）→ pass（inject 阶段补全 canonical）
 */
import type { PanoramaSchema, EntityDef } from '../dsl/types';
import { makeError, type ValidationError } from './types';
import { SYSTEM_ENTITY_DEFS } from '../builtin';

/** 共享错误工厂别名 */
const e = makeError;

/**
 * 比较两个 EntityDef 是否字段一致（排除 system 标记）.
 * leader DSL 经 parser 后 system 字段被丢弃 → canonical 比较 strip 掉 system 才公平.
 */
function entityFieldsEqual(a: EntityDef, b: EntityDef): boolean {
  const { system: _a, ...aRest } = a;
  const { system: _b, ...bRest } = b;
  return JSON.stringify(aRest) === JSON.stringify(bRest);
}

/**
 * 校验 leader 提交的 schema 是否擅自改了系统固定 entity.
 *
 * @param schema parser 后的 leader schema（task 可能存在但无 system flag）
 * @param errors 收集错误（命中即 push panorama_system_entity_immutable）
 */
export function checkSystemEntityImmutable(
  schema: PanoramaSchema,
  errors: ValidationError[],
): void {
  for (const [name, canonical] of Object.entries(SYSTEM_ENTITY_DEFS)) {
    const submitted = schema.entities[name];
    if (!submitted) continue; // 缺失 → pass（inject 兜底补全）
    if (!entityFieldsEqual(submitted, canonical)) {
      errors.push(e(
        'schema',
        'panorama_system_entity_immutable',
        `entities.${name}`,
        `系统固定 entity "${name}" 不可修改（字段需与系统版本一致）`,
        `移除该 entity 定义或改名（system entity 由系统注入）`,
      ));
    }
  }
}
