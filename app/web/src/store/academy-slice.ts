/**
 * academy-slice —— Academy 板块内存路由 + 选中态（无 URL router，与 view-store 同范式）
 * 参考: specs/ui/overall/12-academy.md §2（主区按 route 多态互斥）
 *       specs/ui/components/academy-page/page-academy.md（路由态定义）
 *
 * 职责：academy 主区 route（classroom-list / classroom-detail / student-detail /
 *   training-observe / version-chat / session-readonly）+ 切换 action。
 * 数据（教室/学生/任务实体）不走本 store——走 useLifecycle hooks（三形契约），
 * 本 store 只存「当前在哪」。
 */
import { create } from 'zustand';

/** academy 主区路由联合（page-academy.md「路由态」契约） */
export type AcademyRoute =
  /** 空态 hero（无教室选中） */
  | { kind: 'classroom-list' }
  /** 教室详情（左 head 对话 + 右学生/资源 tab） */
  | { kind: 'classroom-detail'; classroomId: string }
  /** 学生详情（版本树 + 五元组；versionId 缺省 = 当前正式版） */
  | { kind: 'student-detail'; classroomId: string; studentId: string; versionId?: string }
  /** 训练观察（coach 对话 + 右训练视图） */
  | { kind: 'training-observe'; classroomId: string; studentId: string; taskId: string }
  /** 版本会话（复用 playground-rocky；sessionId 缺省 = 列表首个/新建） */
  | { kind: 'version-chat'; classroomId: string; studentId: string; versionId: string; sessionId?: string }
  /** 只读 transcript（subagent 观察；backTo 记录返回路由） */
  | { kind: 'session-readonly'; sessionId: string; title?: string; backTo: AcademyRoute };

/** store shape */
export interface AcademySliceState {
  route: AcademyRoute;
  /** 切路由（整体替换） */
  setRoute: (route: AcademyRoute) => void;
}

/** 创建 academy slice store（工厂形态便于单测隔离） */
export function createAcademySliceStore() {
  return create<AcademySliceState>((set) => ({
    route: { kind: 'classroom-list' },
    setRoute: (route) => set({ route }),
  }));
}

/** 全局单例（PageAcademy 消费） */
export const useAcademyStore = createAcademySliceStore();
