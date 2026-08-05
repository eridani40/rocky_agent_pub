/**
 * use-academy-data —— Academy 板块数据 hooks（useLifecycle 四方法契约）
 * 参考: specs/tech/app/frontend/[P0]academy_component_architecture.md §3（hook 拆解表）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 契约 + 6 不变量）
 *       specs/api/overall/18-academy.md（HTTP 端点）
 *
 * 设计：全部是 Snapshot 形（T | null）——academy 列表短（教室/学生/任务均 << 百条），
 *   mutation 全部用户触发（建教室/学生/任务、编辑版本），mutation 后调 reload() 重读保权威。
 *   SSE：后端未实现 training.* 事件（T1 事实，18 §6 声明未落地）→ 不订阅 SSE，
 *   训练任务详情走轮询（useTrainingTask 内部 startTimer，running 时 4s 间隔）。
 *
 * v0.0.219：useStudentDetail / useClassroomDetail 检测到 active task 时起 5s 轮询（startTimer
 *   + onTick mutateCtx 软刷新），让运行中训练的过程版/状态实时可见（PRD §2.3 coach 持续可达）。
 *   onTick 走软刷新（mutateCtx 写回新 detail），**禁调 r.reload/runInit**——runInit 内 setCtx(null)
 *   会 nullify ctx → 消费方 ternary 翻转 → 子树卸载/重挂死循环（参考 use-training-task.ts 同模式）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLifecycle } from '../../lib/use-lifecycle';
import {
  getClassroomDetail,
  getStudentDetail,
  getVersionContent,
  listAcademySessions,
  listClassrooms,
  type ClassroomDetail,
  type ClassroomEntity,
  type StudentDetail,
  type TrainingTaskEntity,
  type VersionContent,
} from '../../lib/academy-api';
import type { Session } from '../chat-page/types';

/** hook 统一返回形（Snapshot + 控制面） */
export interface AcademyDataResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** 命令式重读（mutation 后 / 手动刷新） */
  reload: () => Promise<void>;
}

/** 把 useLifecycle 结果投影为 AcademyDataResult（Snapshot 形） */
function toResult<T>(r: { ctx: T | null; loading: boolean; error: Error | null; reload: () => Promise<void> }): AcademyDataResult<T> {
  return { data: r.ctx, loading: r.loading, error: r.error, reload: r.reload };
}

/** 任务活跃态（三态机：pending/running 在产需轮询；paused 是稳态不轮询） */
const ACTIVE_TASK_STATUSES = new Set<TrainingTaskEntity['status']>(['pending', 'running']);

/** detail.tasks 中是否有活跃任务（驱动轮询；空 tasks 不轮询） */
function hasActiveTask(detail: { tasks?: TrainingTaskEntity[] } | null): boolean {
  return !!detail && Array.isArray(detail.tasks) && detail.tasks.some((tk) => ACTIVE_TASK_STATUSES.has(tk.status));
}

/** 教室列表（GET /academy/classroom） */
export function useClassrooms(): AcademyDataResult<ClassroomEntity[]> {
  const r = useLifecycle<ClassroomEntity[]>({
    onInit: async ({ signal }) => {
      const items = await listClassrooms();
      // 不变量②：fetch 后校验 signal.aborted
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return items;
    },
    deps: [],
  });
  return toResult(r);
}

/** 教室详情聚合（GET /academy/classroom/:cid → classroom+students+tasks+datasets+graders） */
export function useClassroomDetail(classroomId: string): AcademyDataResult<ClassroomDetail> {
  const r = useLifecycle<ClassroomDetail>({
    onInit: async ({ signal, startTimer }) => {
      if (!classroomId) return null as unknown as ClassroomDetail;
      const detail = await getClassroomDetail(classroomId);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      // 有活跃任务 → 5s 轮询（running 中 fork 的过程版/任务状态实时可见；timer 由 useLifecycle 自动回收）
      if (hasActiveTask(detail)) {
        startTimer({
          intervalMs: 5000,
          justification: '教室详情有活跃训练任务，轮询刷新（后端无 training.* SSE，T1 事实）',
        });
      }
      return detail;
    },
    onTick: async (ctx) => {
      // 终态后停推（下一 tick 短路；timer 空转无害，由 deps 变/re-init 回收）
      if (!ctx || !hasActiveTask(ctx)) return;
      try {
        return await getClassroomDetail(classroomId);
      } catch {
        return; // 单 tick 失败静默（下 tick 重试；不污染 error 态）
      }
    },
    deps: [classroomId],
  });

  // 软刷新（mutateCtx，不走 runInit 的 setCtx(null)——避免消费方 ternary 翻转子树卸载）
  const softReload = useCallback(async () => {
    if (!classroomId) return;
    try {
      const detail = await getClassroomDetail(classroomId);
      r.mutateCtx(() => detail);
    } catch {
      // 单次刷新失败静默（下次 onTick 或手动重试；不污染 error 态）
    }
  }, [classroomId, r.mutateCtx]);
  return { data: r.ctx, loading: r.loading, error: r.error, reload: softReload };
}

/**
 * 学生详情（GET .../student/:sid → student+versions 版本树 + tasks；id 空不拉）
 *
 * refetchKey（v0.0.221 BUG-003 修复）：训练完成 task 进 paused 终态后轮询停止（paused 稳态不轮询是对的），
 *   但后端可能刚写新版本（过程版/formal/采纳按钮）——此时从 training-observe back-nav 回 student-detail，
 *   ids 不变 → useLifecycle 不 re-init → 版本树陈旧。caller 传 route.kind 作 refetchKey，key 变化时
 *   软刷新一次（mutateCtx，不走 setCtx(null)——避免消费方 ternary 翻转 + 子树卸载死循环）。
 *   ids 变化时 useLifecycle 已 re-init，refetchKey 效果跳过，避免双拉。
 */
export function useStudentDetail(
  classroomId: string,
  studentId: string,
  refetchKey?: unknown,
): AcademyDataResult<StudentDetail> {
  const r = useLifecycle<StudentDetail>({
    onInit: async ({ signal, startTimer }) => {
      if (!classroomId || !studentId) return null as unknown as StudentDetail;
      const detail = await getStudentDetail(classroomId, studentId);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      // 有活跃任务 → 5s 轮询（running 中 fork 的 round2+ 过程版实时可见，PRD §2.3 coach 持续可达）
      if (hasActiveTask(detail)) {
        startTimer({
          intervalMs: 5000,
          justification: '学生详情有活跃训练任务，轮询刷新过程版/任务状态（后端无 training.* SSE，T1 事实）',
        });
      }
      return detail;
    },
    onTick: async (ctx) => {
      if (!ctx || !hasActiveTask(ctx)) return;
      try {
        return await getStudentDetail(classroomId, studentId);
      } catch {
        return;
      }
    },
    deps: [classroomId, studentId],
  });

  const softReload = useCallback(async () => {
    if (!classroomId || !studentId) return;
    try {
      const detail = await getStudentDetail(classroomId, studentId);
      r.mutateCtx(() => detail);
    } catch {
      // 静默
    }
  }, [classroomId, studentId, r.mutateCtx]);

  // refetchKey 变化 → 软刷新（BUG-003：back-nav 版本树陈旧）
  // 仅当 key 变且 ids 不变时触发——ids 变走 useLifecycle re-init（避免双拉）
  const prevKeyRef = useRef<unknown>(refetchKey);
  const prevIdsRef = useRef({ classroomId, studentId });
  useEffect(() => {
    const idsChanged =
      prevIdsRef.current.classroomId !== classroomId ||
      prevIdsRef.current.studentId !== studentId;
    prevIdsRef.current = { classroomId, studentId };

    const keyChanged = prevKeyRef.current !== refetchKey;
    prevKeyRef.current = refetchKey;

    if (keyChanged && !idsChanged && classroomId && studentId) {
      void softReload();
    }
  }, [refetchKey, classroomId, studentId, softReload]);

  return { data: r.ctx, loading: r.loading, error: r.error, reload: softReload };
}

/** 版本内容（GET .../version/:vid → meta + 五元组内容；vid 空串时不拉） */
export function useVersionContent(classroomId: string, studentId: string, versionId: string): AcademyDataResult<VersionContent> {
  const r = useLifecycle<VersionContent>({
    onInit: async ({ signal }) => {
      if (!versionId) return null as unknown as VersionContent;
      const detail = await getVersionContent(classroomId, studentId, versionId);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return detail;
    },
    deps: [classroomId, studentId, versionId],
  });
  return toResult(r);
}

/** academy 域 session 列表（GET /session?biz=academy + classroomId 前端过滤） */
export function useAcademySessions(classroomId?: string): AcademyDataResult<Session[]> {
  const r = useLifecycle<Session[]>({
    onInit: async ({ signal }) => {
      if (!classroomId) return [];
      const items = await listAcademySessions(classroomId);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return items;
    },
    deps: [classroomId],
  });
  return toResult(r);
}
