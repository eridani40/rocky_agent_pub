/**
 * panorama builtin 子模块统一导出（v0.0.243 — panorama_builtin §3/§4）.
 * 参考: specs/tech/squad/[P1]panorama_builtin.md
 *
 * 本子模块提供系统固定 entity（task）的 canonical 定义 + lazy migration + 自动依赖 hook.
 * 外部消费方：
 *   - panorama-tool-actions / panorama-routes-impl：ensureSystemEntities（read chokepoint）+ injectSystemEntities（define 注入）
 *   - panorama-tool-data-actions / panorama-routes-impl：afterTaskWrite（task 写后置）
 *   - validation/validate_system_entity：SYSTEM_ENTITY_DEFS（遍历判系统 entity 不可改）
 */
export {
  TASK_ENTITY_DEF, TASK_VIEW_DEF,
  TASK_STATUS, TASK_STATUSES,
} from './task-schema';
export type { TaskStatus } from './task-schema';
export {
  SYSTEM_ENTITY_DEFS, SYSTEM_VIEWS,
  injectSystemEntities, ensureSystemEntities,
} from './system-entities';
export { parseDeps, afterTaskWrite } from './task-hooks';
