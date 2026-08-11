/**
 * preview-area-context —— 预览区 Context + hook（v0.0.320 D3，D7/D12 偏离升级：Provider 上移）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D3（preview-area-context.ts 契约）
 *
 * 独立文件（不与 section-preview-area.tsx 合并）以断开循环依赖：
 *   workspace-panel / message-stream → usePreviewArea（纯 TS 无 JSX）
 *   section-preview-area → usePreviewArea 消费方
 *
 * [v0.0.320 Task 3 偏离（leader 已确认）] Provider 上移到 page-chat / studio-chat-router 顶层
 *   （preview-area-provider.tsx 内部 usePreviewTabs + Provider 包整行）：D7/D12 消费方
 *   （SectionWorkspacePanel / ComponentMessageStream）是 SectionPreviewArea 的**兄弟节点**，
 *   React Context 只能向下传，原 D3「Provider 挂容器内」导致兄弟节点永远拿到 null。
 *   SectionPreviewArea 改为从 context 消费 tabs（受控渲染），用户可见行为零变化。
 *
 * 无 Provider 返 null（academy/studio 无预览区场景消费方降级，见 change_plan D7 降级路径）。
 */
import { createContext, useContext } from 'react';
import type { OpenLocalTarget } from '../../lib/open-local-path';
import type { DoorState } from './use-preview-collapsed';
import type {
  ConflictAction,
  ConflictPending,
  DirtyAction,
  DirtyPending,
  PreviewTab,
} from './preview-tabs-types';

/** Context value：消费方（workspace 文件树 / chat 链接）打开文件 → 预览区 openTab */
export interface PreviewAreaContextValue {
  /** 打开文件（同 path 已存在 → activate；不存在 → 新建 + 异步 load） */
  openTab(target: OpenLocalTarget): void;
  /** 关闭 tab（dirty 守卫 + 焦点左移） */
  closeTab(id: string): void;
  /** 激活 tab（dirty 守卫拦截切换） */
  activateTab(id: string): void;
  /** 当前 tabs 列表 */
  tabs: PreviewTab[];
  /** 当前激活 tab id（null = 空态） */
  activeTabId: string | null;
  /** 当前 session（workspace 源 HTTP 读写用） */
  sessionId: string;
  // ── [Task 3 偏离] Provider 上移后，SectionPreviewArea 也从本 context 消费（容器纯渲染） ──
  /** dirty 守卫 modal pending（null = 无） */
  dirtyPending: DirtyPending | null;
  /** 409 冲突 modal pending（null = 无） */
  conflictPending: ConflictPending | null;
  // ── [老板第三批补充] collapsed 下移到 hook 层（openTab/activateTab 成功后自动展开） ──
  /** 预览区收起态（true=隐藏，per session localStorage）。派生 = door !== 'center'（v0.0.329） */
  collapsed: boolean;
  /** 设置收起态（含 localStorage 持久化）。桥接 = setDoor(v?'right':'center') */
  setCollapsed(v: boolean): void;
  // ── [v0.0.329 门模型] 门三态下传（D6） ──
  /** 门态（center 2/3 共存 / left 遮2露3 / right 遮3露2） */
  door: DoorState;
  /** 设置门态（含 localStorage 持久化） */
  setDoor(v: DoorState): void;
  /** 保存 tab（viewer/editor 保存按钮入口） */
  saveTab(id: string): Promise<void>;
  /** dirty 守卫确认（save-switch / discard / cancel） */
  resolveDirty(action: DirtyAction): Promise<void>;
  /** 冲突确认（reload / overwrite） */
  resolveConflict(action: ConflictAction): Promise<void>;
  /** 编辑态 draft 更新（dirty=true） */
  setDraft(id: string, draft: string): void;
  /** 切 view/edit 模式 */
  setMode(id: string, mode: 'view' | 'edit'): void;
  /** 重试读（error pill 按钮） */
  retryLoad(id: string): void;
}

/** 默认 null：无 Provider 时 usePreviewArea 返 null（消费方降级弹层） */
export const PreviewAreaContext = createContext<PreviewAreaContextValue | null>(null);

/**
 * 取预览区上下文。workspace-panel / message-stream / section-preview-area 消费：
 * 有 Provider → onEditor 改调 preview.openTab；无 Provider → 降级既有弹层。
 */
export function usePreviewArea(): PreviewAreaContextValue | null {
  return useContext(PreviewAreaContext);
}
