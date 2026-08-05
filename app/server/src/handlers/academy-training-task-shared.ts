/**
 * academy-training-task-shared — task handler 共享（json + locateTask + mapEngineError）
 * 参考: specs/api/overall/18-academy.md §2/§7（错误码映射）
 */
import { ulid } from '../config/ulid';
import type { AcademyHandlerDeps } from '../routes/academy-routes';
import type { TrainingTaskEntity } from '../academy/academy-store';
import type { MessageInput } from '../message/types';

/** JSON Response 构造（与现有 handler 一致） */
export function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 按 tid 全局定位 task（遍历 classrooms 分片） */
export async function locateTask(
  deps: AcademyHandlerDeps,
  tid: string,
): Promise<{ classroomId: string; task: TrainingTaskEntity } | null> {
  const classrooms = await deps.academyStore.listClassrooms();
  for (const c of classrooms) {
    const task = await deps.academyStore.getTask(c.id, tid);
    if (task) return { classroomId: c.id, task };
  }
  return null;
}

/**
 * task DTO 反规范化 `baseVersionLabel`（spec §2.2）：教室训练 tab / 任务卡 /
 * 训练观察页无 versions 上下文，由后端 read 时 `getVersion(cid, task.baseVersionId).versionLabel`
 * 反规范化挂字段，供前端拼任务名「v{baseMajor}.{taskSeq}」（PRD §2.5）。读不到留 undefined。
 *
 * 三处 handler 共享：handleGetClassroom / handleGetTask / handleCreateTask。
 */
export async function attachBaseVersionLabel(
  store: AcademyHandlerDeps['academyStore'],
  classroomId: string,
  task: TrainingTaskEntity,
): Promise<TrainingTaskEntity & { baseVersionLabel?: string }> {
  const base = await store.getVersion(classroomId, task.baseVersionId);
  return { ...task, baseVersionLabel: base?.versionLabel };
}

/** 把 TrainingEngine Error 映射为 HTTP 错误码（spec §7；v0.0.221：去 nothing_to_adopt/accept，加 task_at_maxturns） */
export function mapEngineError(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  // maxTurns 到顶（resume 时硬门）：409 task_at_maxturns（指引 update-task 调大）
  if (/task_at_maxturns/.test(msg)) {
    return json(409, {
      error: 'task_at_maxturns',
      detail: 'maxTurns 到顶，须先调 update-task 调大 maxTurns 才能 resume 续训',
    });
  }
  // 状态机校验失败（不允许该 action；v0.0.221 扩 regex 含 pause/resume/adopt）
  if (/status .* 不允许|已达 maxTurns|不允许 (pause|resume|adopt|revise)/.test(msg)) {
    return json(409, { error: 'invalid_task_state', detail: msg });
  }
  // per-task lock 冲突
  if (/lock 冲突/.test(msg)) {
    return json(409, { error: 'task_already_running', detail: msg });
  }
  // 429/503 上游
  if (/429|529|503|rate.?limit/i.test(msg)) {
    return json(503, { error: 'rate_limited', detail: msg });
  }
  return json(500, { error: 'internal_error', detail: msg });
}

/** 构造注入到 coach session 的文本消息（inject-directive 用） */
export function buildInjectDirectiveMessage(
  coachSessionId: string,
  directive: string,
): MessageInput {
  const text = `[head 指导] ${directive}`;
  return {
    id: ulid(),
    sessionId: coachSessionId,
    role: 'user',
    content: [{ type: 'text', text }],
  };
}
