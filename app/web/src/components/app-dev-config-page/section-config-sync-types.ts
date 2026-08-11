/**
 * section-config-sync-types — 配置同步页共享类型。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D6
 */

/** 配置同步页视图模式 */
export type ViewMode = 'landing' | 'export' | 'import';

/** toast 类型 */
export type ToastKind = 'success' | 'error';

/** toast 状态 */
export interface ToastState {
  kind: ToastKind;
  message: string;
}

/** 构建全选 SelectionState */
export function buildSelectAll(
  providers: string[],
  tools: string[],
): import('./component-config-tree').SelectionState {
  return {
    providers: new Set(providers),
    tools: new Set(tools),
  };
}
