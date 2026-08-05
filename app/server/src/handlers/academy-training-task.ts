/**
 * academy-training-task handlers — /academy/training-task/* 路由分发
 * 参考: specs/api/overall/18-academy.md §2（任务端点契约）
 *       specs/tech/academy/[P0]training_engine.md（状态机）
 *
 * v0.0.221 模型重构（design.md §3 + §5）：
 *   - 删除 /accept /reject /stop 路由（propose→accept/reject 链解耦）
 *   - 新增 /adopt /pause /resume /update-task 路由（两轴模型）
 *
 * 职责：
 *   - POST /academy/classroom/:cid/student/:sid/training-task   发起训练（拆到 academy-training-task-create.ts）
 *   - GET  /academy/training-task/:tid                          任务详情（含历史轮次）
 *   - POST /academy/training-task/:tid/revise                   推进一轮（coach 主导修订）
 *   - POST /academy/training-task/:tid/adopt                    旁路归档（任意 process → 新 formal）
 *   - POST /academy/training-task/:tid/pause                    可逆暂停
 *   - POST /academy/training-task/:tid/resume                   续训（maxturns 硬门 → 409）
 *   - POST /academy/training-task/:tid/update-task              patch maxTurns/directive
 *   - POST /academy/training-task/:tid/inject-directive         训练中注入指导
 *
 * 不变量：
 *   - adopt 是旁路动作：不改 task.status，可重复（多次产 major 递增 formal）
 *   - 并发：revise 用 SessionTaskLock type='training-turn'（TrainingEngine 内部 acquire）
 *   - task 状态机三态（pending/running/paused+pausedReason）；maxTurns 硬门
 *
 * 单文件 ≤300 行（create 拆到 academy-training-task-create.ts）。
 */
import type { TrainingTurnEntity } from '../academy/academy-store';
import type { AcademyHandlerDeps } from '../routes/academy-routes';
import { handleCreateTask } from './academy-training-task-create';
import {
  json,
  locateTask,
  mapEngineError,
  buildInjectDirectiveMessage,
  attachBaseVersionLabel,
} from './academy-training-task-shared';

/**
 * /academy/training-task/* 路由分发（含 /academy/classroom/:cid/student/:sid/training-task 创建）。
 */
export async function handleTrainingTaskRoute(
  req: Request,
  method: string,
  path: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  // POST /academy/classroom/:cid/student/:sid/training-task
  const createMatch = path.match(/^\/academy\/classroom\/([^/]+)\/student\/([^/]+)\/training-task$/);
  if (createMatch) {
    const [_, cid, sid] = createMatch;
    if (method === 'POST') return handleCreateTask(req, cid!, sid!, deps);
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }

  // /academy/training-task/:tid/:action（v0.0.221：adopt/pause/resume/update-task 取代 accept/reject/stop）
  const actionMatch = path.match(/^\/academy\/training-task\/([^/]+)\/(revise|adopt|pause|resume|update-task|inject-directive)$/);
  if (actionMatch) {
    const [_, tid, action] = actionMatch;
    if (method !== 'POST') return json(405, { error: 'Method Not Allowed' }, 'POST');
    switch (action!) {
      case 'revise': return handleRevise(tid!, deps);
      case 'adopt': return handleAdopt(req, tid!, deps);
      case 'pause': return handlePause(req, tid!, deps);
      case 'resume': return handleResume(tid!, deps);
      case 'update-task': return handleUpdateTask(req, tid!, deps);
      case 'inject-directive': return handleInjectDirective(req, tid!, deps);
    }
  }

  // GET /academy/training-task/:tid
  const detailMatch = path.match(/^\/academy\/training-task\/([^/]+)$/);
  if (detailMatch) {
    const tid = detailMatch[1]!;
    if (method === 'GET') return handleGetTask(tid, deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }

  return json(404, { error: 'Not Found' });
}

// ── handlers ───────────────────────────────────────────────────

/** GET /academy/training-task/:tid — 任务详情（spec §2.2） */
async function handleGetTask(
  tid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const located = await locateTask(deps, tid);
  if (!located) return json(404, { error: 'task_not_found' });
  const { classroomId, task } = located;
  const turns: TrainingTurnEntity[] = await deps.academyStore.listTurns(classroomId, tid);
  const currentTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
  // baselineScore = 当前临时基线的最近 avgScore（无 → undefined）
  let baselineScore: number | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.candidateVersionId === task.temporaryBaselineVersionId && t.avgScore !== undefined) {
      baselineScore = t.avgScore;
      break;
    }
  }
  const history = turns.map((t) => ({
    round: t.round,
    avgScore: t.avgScore,
    decision: t.decision,
    status: t.status,
  }));
  // task DTO 反规范化 baseVersionLabel（spec §2.2）：读不到留 undefined。
  const taskWithLabel = await attachBaseVersionLabel(deps.academyStore, classroomId, task);
  return json(200, { task: taskWithLabel, turns, currentTurn, baselineScore, history });
}

/** POST /academy/training-task/:tid/revise — 推进一轮（spec §2.3；调 engine.reviseCandidate） */
async function handleRevise(
  tid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const located = await locateTask(deps, tid);
  if (!located) return json(404, { error: 'task_not_found' });
  try {
    const result = await deps.trainingEngine.reviseCandidate(tid, located.classroomId);
    return json(200, result);
  } catch (e) {
    return mapEngineError(e);
  }
}

/** POST /academy/training-task/:tid/adopt — 旁路归档（任意 process → 新 formal；不改 task 状态；可重复） */
async function handleAdopt(
  req: Request,
  tid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const located = await locateTask(deps, tid);
  if (!located) return json(404, { error: 'task_not_found' });
  let body: { versionId?: string };
  try {
    body = (await req.json()) as { versionId?: string };
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object' || !body.versionId) {
    return json(400, { error: 'invalid_input', detail: 'versionId required' });
  }
  try {
    const result = await deps.trainingEngine.adoptVersion(tid, located.classroomId, body.versionId);
    return json(200, result);
  } catch (e) {
    return mapEngineError(e);
  }
}

/** POST /academy/training-task/:tid/pause — 可逆暂停（reason 可选） */
async function handlePause(
  req: Request,
  tid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const located = await locateTask(deps, tid);
  if (!located) return json(404, { error: 'task_not_found' });
  let reason: string | undefined;
  try {
    const text = await req.text();
    if (text.length > 0) {
      const body = JSON.parse(text) as { reason?: string };
      reason = body.reason;
    }
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  try {
    const task = await deps.trainingEngine.pauseTask(
      tid, located.classroomId,
      reason as 'stopped' | 'earlystop' | 'maxturns' | 'completed' | undefined,
    );
    return json(200, { taskId: tid, status: task.status, pausedReason: task.pausedReason });
  } catch (e) {
    return mapEngineError(e);
  }
}

/** POST /academy/training-task/:tid/resume — 续训（maxturns 硬门 → 409 task_at_maxturns） */
async function handleResume(
  tid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const located = await locateTask(deps, tid);
  if (!located) return json(404, { error: 'task_not_found' });
  try {
    const task = await deps.trainingEngine.resumeTask(tid, located.classroomId);
    return json(200, { taskId: tid, status: task.status });
  } catch (e) {
    return mapEngineError(e);
  }
}

/** POST /academy/training-task/:tid/update-task — patch maxTurns / directive */
async function handleUpdateTask(
  req: Request,
  tid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const located = await locateTask(deps, tid);
  if (!located) return json(404, { error: 'task_not_found' });
  let body: { maxTurns?: number; directive?: string };
  try {
    body = (await req.json()) as { maxTurns?: number; directive?: string };
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'invalid_input' });
  }
  // 仅 maxTurns / directive 可 patch（其他字段拒）；至少一字段
  const hasMaxTurns = typeof body.maxTurns === 'number';
  const hasDirective = typeof body.directive === 'string';
  if (!hasMaxTurns && !hasDirective) {
    return json(400, { error: 'invalid_input', detail: 'at least one of maxTurns or directive required' });
  }
  const task = located.task;
  const { createdAt: _c, updatedAt: _u, version: _v, ...rec } = task;
  if (hasMaxTurns) rec.maxTurns = body.maxTurns;
  if (hasDirective) rec.directive = body.directive;
  await deps.academyStore.putTask(rec);
  return json(200, {
    taskId: tid,
    ...(hasMaxTurns ? { maxTurns: body.maxTurns } : {}),
    ...(hasDirective ? { directive: body.directive } : {}),
  });
}

/** POST /academy/training-task/:tid/inject-directive — 注入指导（spec §2.7） */
async function handleInjectDirective(
  req: Request,
  tid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const located = await locateTask(deps, tid);
  if (!located) return json(404, { error: 'task_not_found' });
  let body: { directive?: string };
  try {
    body = (await req.json()) as { directive?: string };
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object' || !body.directive || body.directive.length === 0) {
    return json(400, { error: 'invalid_input', detail: 'directive required' });
  }
  // 1. append 进 task.directive（不替换，多段拼接 spec §2.7）
  const task = located.task;
  const { createdAt: _c, updatedAt: _u, version: _v, ...rec } = task;
  const newDirective = task.directive
    ? `${task.directive}\n\n[注入] ${body.directive}`
    : body.directive;
  await deps.academyStore.putTask({ ...rec, directive: newDirective });
  // 2. deliverTo coach（fire-and-forget；失败不影响 directive 落盘）
  try {
    await deps.sessionStore.appendMessages(
      task.coachSessionId,
      [buildInjectDirectiveMessage(task.coachSessionId, body.directive)],
    );
  } catch {
    /* fire-and-forget；失败不影响 directive 落盘 */
  }
  return json(200, { ok: true });
}
