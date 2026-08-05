/**
 * Panorama 跃迁校验 — transitions 表 + terminal 锁 + guard 求值.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §7
 *
 * 三路写入（拖拽/工具/API）共用同一函数。非法时返回可读 reason + suggestion。
 */
import type { PanoramaSchema, EntityDef, EnumFieldDef, Guard, GuardOp } from '../dsl/types';

export interface TransitionResult {
  ok: boolean;
  code?: string;
  message?: string;
  suggestion?: string;
}

/**
 * @param schema  PanoramaSchema（从中查 entityDef + states）
 * @param entity  实体名
 * @param from    当前状态
 * @param to      目标状态
 * @param instance 当前实例（guard 求值读字段值；undefined 则跳过 guard）
 */
export function validateTransition(
  schema: PanoramaSchema,
  entity: string,
  from: string,
  to: string,
  instance?: Record<string, unknown>,
): TransitionResult {
  const entityDef = schema.entities[entity];
  if (!entityDef) {
    return fail('panorama_unknown_entity', `实体 "${entity}" 不存在`, '');
  }
  const states = entityDef.states;
  if (!states) {
    return fail('panorama_no_state_machine', `实体 "${entity}" 没有状态机`, '');
  }

  const sf = entityDef.fields[states.field];
  const enumVals = sf?.type === 'enum' ? (sf as EnumFieldDef).values : [];
  const valSet = new Set(enumVals);

  // from / to 合法状态
  if (!valSet.has(from)) {
    return fail('panorama_illegal_transition', `from "${from}" 不是合法状态`, '检查实例当前状态');
  }
  if (!valSet.has(to)) {
    return fail('panorama_illegal_transition', `to "${to}" 不是合法状态`, '检查目标状态');
  }

  // 终态锁：from 是终态 → 不可跃迁
  if (states.terminal?.includes(from)) {
    return fail('panorama_terminal_locked', `状态 "${from}" 是终态，不可跃迁`,
      '终态不可跃迁，需新建实例');
  }

  // transitions 表查找
  const targets = states.transitions[from] ?? [];
  const match = targets.find(t => t.to === to);
  if (!match) {
    const legal = targets.map(t => t.to);
    return fail('panorama_illegal_transition', `"${from}" → "${to}" 不在 transitions 表中`,
      legal.length ? `合法目标: ${legal.join(', ')}` : `"${from}" 无出边`);
  }

  // guard 求值
  if (match.guard && instance) {
    const g = evalGuard(match.guard, instance);
    if (!g.passed) {
      return fail('panorama_guard_failed', g.message, g.suggestion);
    }
  }

  return { ok: true };
}

function fail(code: string, message: string, suggestion: string): TransitionResult {
  return { ok: false, code, message, suggestion: suggestion || undefined };
}

function evalGuard(
  guard: Guard, instance: Record<string, unknown>,
): { passed: boolean; message: string; suggestion: string } {
  const actual = instance[guard.field];
  const expected = guard.value;
  const passed = compare(actual, guard.op, expected);

  if (passed) return { passed: true, message: '', suggestion: '' };

  const a = actual === undefined ? 'undefined' : JSON.stringify(actual);
  const exp = Array.isArray(expected) ? `[${expected.join(', ')}]` : JSON.stringify(expected);
  return {
    passed: false,
    message: `guard 不满足: ${guard.field}(${a}) ${guard.op} ${exp}`,
    suggestion: `guard 条件: ${guard.field} ${guard.op} ${exp}；当前值: ${a}`,
  };
}

function compare(actual: unknown, op: GuardOp, expected: string | number | boolean | string[]): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return typeof actual === 'number' && actual > (expected as number);
    case 'gte': return typeof actual === 'number' && actual >= (expected as number);
    case 'lt': return typeof actual === 'number' && actual < (expected as number);
    case 'lte': return typeof actual === 'number' && actual <= (expected as number);
    case 'in': return Array.isArray(expected) && expected.includes(String(actual));
    case 'not_in': return Array.isArray(expected) && !expected.includes(String(actual));
    default: return false;
  }
}
