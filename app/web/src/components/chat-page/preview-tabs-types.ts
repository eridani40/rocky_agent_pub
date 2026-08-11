/**
 * preview-tabs-types —— 预览区 tab 类型定义（v0.0.320 D4，独立文件控行数）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D4（PreviewTab 契约）
 *       specs/prd/version_logs/v0.0.320-file-preview.md §3.1（数据结构）
 *
 * 与 use-preview-tabs.ts 分离：类型被 preview-area-context / section-preview-area /
 * component-preview-* 多处 import，独立文件避免状态机实现被类型撑破 300 行限制。
 */
import type { FileFormat } from '../../lib/file-format';
import type { OpenLocalTarget } from '../../lib/open-local-path';

/** 预览 tab（PRD §3.1） */
export interface PreviewTab {
  id: string; // `${source}:${path}`
  path: string;
  fileName: string;
  subtitle: string;
  source: 'workspace' | 'absolute';
  format: FileFormat;
  /** workspace 源后端 version；absolute 源 '' */
  version: string;
  mode: 'view' | 'edit';
  dirty: boolean;
  content: string;
  draft: string;
  loadState: 'idle' | 'loading' | 'loaded' | 'error';
  errorMsg?: string;
}

/** dirty 守卫 modal 三选 */
export type DirtyAction = 'save-switch' | 'discard' | 'cancel';
/** 409 冲突 modal 两选（取消=reload / 覆盖=force） */
export type ConflictAction = 'reload' | 'overwrite';

/** dirty 守卫 pending 状态（null = 无 pending） */
export interface DirtyPending {
  tabId: string;
  /** activate=切已有 tab；close=关闭；open=打开新文件（树文件/chat 链接，[ET-fix 修复3]） */
  action: 'activate' | 'close' | 'open';
  targetTabId: string | null; // activate/open 时目标 tab；close 时 null
  /** [ET-fix 修复3] action='open' 时的原始打开目标（确认后执行完整 openTab 语义：新建+load） */
  pendingOpen?: OpenLocalTarget;
}

/** 409 冲突 pending 状态（null = 无 pending） */
export interface ConflictPending {
  tabId: string;
  currentVersion: string;
}
