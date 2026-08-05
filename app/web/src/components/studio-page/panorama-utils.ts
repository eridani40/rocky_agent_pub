/**
 * panorama-utils —— 全景渲染纯函数集（模板插值 / 状态展示 / 分组判定 / DSL 解析）
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §5.5（{field} 插值）
 *       reqs/[working] v0.0.189.dsl_board/demo/src/engine.js（参考实现，交互思路非照抄）
 */
import { parse as parseYaml } from 'yaml';
import type { EntityDef, KanbanViewDef, PanoramaSchema } from './panorama-types';

/**
 * 解析 DSL YAML 文本 → PanoramaSchema.
 * 服务端 define 已过四层校验 + injectSystemEntities（task entity 落盘进 schema，和 book 平级），
 * 前端只做最小结构守卫（entities/views 存在），失败抛 Error.
 */
export function parsePanoramaDsl(text: string): PanoramaSchema {
  const dsl = parseYaml(text) as PanoramaSchema | null;
  if (!dsl || typeof dsl !== 'object' || !dsl.entities || !Array.isArray(dsl.views)) {
    throw new Error('Invalid panorama DSL: missing entities or views');
  }
  return dsl;
}

/** card 模板插值："{id} · {branch}"；缺失字段渲染为空串 */
export function interpolate(tpl: string | undefined, record: Record<string, unknown>): string {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = record[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** 状态中文 label（display.status_labels 兜底原值） */
export function statusLabel(entity: EntityDef, status: string): string {
  return entity.display?.status_labels?.[status] ?? status;
}

/** 字段中文 label（fields[field].label 兜底字段名；table 表头用） */
export function fieldLabel(entity: EntityDef, field: string): string {
  return entity.fields[field]?.label ?? field;
}

/** enum 值中文 label：状态机字段走 status_labels；
 * 其他 enum 走 display.{field}_labels（字段级优先）→ display.status_labels（全局兜底）→ 原值 */
export function enumValueLabel(entity: EntityDef, field: string, value: string): string {
  if (entity.states?.field === field) return statusLabel(entity, value);
  return entity.display?.[`${field}_labels`]?.[value] ?? entity.display?.status_labels?.[value] ?? value;
}

/** 状态色（display.status_colors 兜底中性灰） */
export function statusColor(entity: EntityDef, status: string): string {
  return entity.display?.status_colors?.[status] ?? '#8b949e';
}

/** 分组列 label（= enumValueLabel：状态机字段走 status_labels，否则 `${group_by}_labels` → status_labels → 原值） */
export function groupLabel(entity: EntityDef, groupBy: string, value: string): string {
  return enumValueLabel(entity, groupBy, value);
}

/** group_by 是否就是状态机字段（决定 kanban 是否允许拖拽跃迁） */
export function isStateGrouping(entity: EntityDef, view: KanbanViewDef): boolean {
  return entity.states?.field === view.group_by;
}

/** 本地时区日期桶 key（bar_chart 用；同一天返回同 key） */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 实例主键值（entity.id_field 指向字段，转 string） */
export function recordId(entity: EntityDef, record: Record<string, unknown>): string {
  return String(record[entity.id_field] ?? '');
}
