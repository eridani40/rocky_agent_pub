/**
 * view-store — 内存路由（无 URL router）
 * 参考: specs/ui/overall/02-llm-chat.md §1.1 / specs/ui/overall/06-studio.md §1.1（bizType 二分）
 *       specs/ui/components/framework/nav-rail.md（[v0.0.47] view id 调整）
 *
 * v0.0.3 是单页 + 内存路由：URL 不变化，主区视图由 currentView 决定。
 * playground 切换会话区点击；settings-app 切「应用设置」合并页。
 *
 * [v0.0.33.1] view id 改名 + 新增（对齐 nav-rail.md + 06-studio.md）：
 *   - 'chat' → 'playground'（原"会话"，个人对话，路由仍到 PageChat 不变，仅 view id 字面量改名）
 *   - 新增 'studio'（squad 团队管理，路由到 PageStudio）
 *
 * [v0.0.47] view id 收纳（对齐 nav-rail.md [v0.0.47] 段）：
 *   - 删 'settings-dev' / 'settings-plugin'（合并入 'settings-app' —— dev/plugin 作为应用设置合并页内的 tab）
 *   - 'settings-app' 路由从 PageAppConfig 改路由到 PageAppSettingsMerged（app-shell.tsx）
 *   - 'skill' / 'connector' 沿用（nav 底部独立入口）
 */
import { create } from 'zustand';

/** 主区视图枚举（ui §1.1；[v0.0.210] 加 'academy' 教室培养板块） */
export type ViewId =
  | 'playground'
  | 'studio'
  | 'academy'
  | 'settings-app'
  | 'skill'
  | 'channel'
  | 'connector';

/**
 * [v0.0.210] academy → studio 跨板块派生预填（design §8.10：学生详情「派生到团队」）。
 * academy 侧写入后 setView('studio')；PageStudio 消费（自动开 member-create + 预选
 * derive_academy 模式 + 预填 academySource/name），提交/取消后清除。
 */
export interface StudioDerivePrefill {
  academySource: { classroomId: string; studentId: string; versionId: string };
  /** 预填成员名（= 学生名，可改） */
  name: string;
}

/** store shape */
export interface ViewStoreState {
  /** 当前主区视图 */
  currentView: ViewId;
  /** 切换视图 */
  setView: (view: ViewId) => void;
  /** [v0.0.210] academy → studio 派生预填（一次性消费） */
  studioDerivePrefill: StudioDerivePrefill | null;
  setStudioDerivePrefill: (p: StudioDerivePrefill | null) => void;
}

/** 创建 view store（工厂形态便于单测隔离） */
export function createViewStore() {
  return create<ViewStoreState>((set) => ({
    // [v0.0.33.1] 默认进 Playground（原 'chat' 改名，行为不变）
    currentView: 'playground',
    setView: (view) => set({ currentView: view }),
    studioDerivePrefill: null,
    setStudioDerivePrefill: (p) => set({ studioDerivePrefill: p }),
  }));
}

/** 全局单例 store（App 消费） */
export const useViewStore = createViewStore();
