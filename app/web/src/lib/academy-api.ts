/**
 * academy-api —— Academy 板块 HTTP 客户端（教室/学生/版本/训练任务/数据集/评估器）
 * 参考: specs/api/overall/18-academy.md（端点契约，T1 已 frozen）
 *       specs/tech/academy/[P0]data_model.md（entity schema 权威源）
 *
 * 复用 chat-api/session-api 的 req<T>（同 fetch 风格 + resolveApiBase）；
 * 错误时抛 Error（调用方 catch 显示）。所有响应 shape 对齐 18-academy.md + T1 handler 实际返回。
 *
 * 与 spec 的实际差异（T1 实现事实，汇报过 orchestrator）：
 *   - 无 GET /academy/session 端点（18 §4.1 声明但未实现）→ 用 GET /session?biz=academy + 前端按
 *     academyClassroomId / academyVersionId 过滤（Session 读侧投影已带 4 academy 字段）。
 *   - 版本内容 content.memory 恒 []（后端暂不实现）→ UI 降级展示；content.skills 已是
 *     SkillSummary（目录 + 文件树 + per-file hash，18 §1.8），单文件内容按需走 §1.11。
 */
import { req } from './chat-api/session-api';
import type { Session } from '../components/chat-page/types';
import type {
  ClassroomEntity,
  ClassroomDefaultModel,
  CreateTrainingTaskBody,
  DatasetEntity,
  GraderEntity,
  StudentEntity,
  StudentVersionEntity,
  TrainingTaskDetail,
  TrainingTaskEntity,
  ClassroomDetail,
  StudentDetail,
  VersionContent,
  VersionJson,
  VersionSkillFileContent,
} from './academy-types';

// 类型再导出（消费方维持 academy-api 单点导入，无需感知拆分）
export type {
  ClassroomEntity,
  ClassroomDefaultModel,
  StudentEntity,
  StudentVersionEntity,
  TrainingTaskEntity,
  TrainingTurnEntity,
  DatasetEntity,
  GraderEntity,
  ClassroomDetail,
  StudentDetail,
  VersionJson,
  VersionContent,
  AcademySkillFileNode,
  SkillSummary,
  VersionSkillFileContent,
  MemoryEntrySummary,
  TrainingTaskDetail,
  CreateTrainingTaskBody,
} from './academy-types';

// ── 教室 + 学生 + 版本 ───────────────────────────────────────────────────

/** GET /academy/classroom — 列教室 */
export async function listClassrooms(base?: string): Promise<ClassroomEntity[]> {
  const r = await req<{ items: ClassroomEntity[] }>('/academy/classroom', undefined, base);
  return r.items ?? [];
}

/** POST /academy/classroom — 创建教室（自动建班主任 session） */
export async function createClassroom(
  body: { name: string; logo?: string; defaultModel?: ClassroomDefaultModel },
  base?: string,
): Promise<{ classroom: ClassroomEntity; headSessionId: string }> {
  return req('/academy/classroom', { method: 'POST', body: JSON.stringify(body) }, base);
}

/** GET /academy/classroom/:cid — 教室详情（含 students/tasks/datasets/graders 概览） */
export async function getClassroomDetail(cid: string, base?: string): Promise<ClassroomDetail> {
  return req(`/academy/classroom/${encodeURIComponent(cid)}`, undefined, base);
}

/**
 * PATCH /academy/classroom/:cid — 改教室（name/logo/defaultModel，18 §1.4 + 本版新增 defaultModel）
 * defaultModel: undefined=不动；null=清除；对象=覆写
 */
export async function patchClassroom(
  cid: string,
  body: { name?: string; logo?: string; defaultModel?: ClassroomDefaultModel | null },
  base?: string,
): Promise<ClassroomEntity> {
  return req(`/academy/classroom/${encodeURIComponent(cid)}`, { method: 'PATCH', body: JSON.stringify(body) }, base);
}

/** POST /academy/classroom/:cid/student — 创建学生（自动建 0.0 初始版本） */
export async function createStudent(
  cid: string,
  body: { name: string; logo?: string },
  base?: string,
): Promise<{ student: StudentEntity; initialVersion: StudentVersionEntity }> {
  return req(`/academy/classroom/${encodeURIComponent(cid)}/student`, { method: 'POST', body: JSON.stringify(body) }, base);
}

/** GET /academy/classroom/:cid/student/:sid — 学生详情（含版本树） */
export async function getStudentDetail(cid: string, sid: string, base?: string): Promise<StudentDetail> {
  return req(`/academy/classroom/${encodeURIComponent(cid)}/student/${encodeURIComponent(sid)}`, undefined, base);
}

/** GET .../version/:vid — 版本内容（五元组） */
export async function getVersionContent(cid: string, sid: string, vid: string, base?: string): Promise<VersionContent> {
  return req(
    `/academy/classroom/${encodeURIComponent(cid)}/student/${encodeURIComponent(sid)}/version/${encodeURIComponent(vid)}`,
    undefined,
    base,
  );
}

/** PATCH .../version/:vid — 编辑版本内容（仅 formal 可编辑，process 只读 409） */
export async function patchVersion(
  cid: string,
  sid: string,
  vid: string,
  body: { agentsMd?: string; versionJson?: Partial<VersionJson> },
  base?: string,
): Promise<StudentVersionEntity> {
  return req(
    `/academy/classroom/${encodeURIComponent(cid)}/student/${encodeURIComponent(sid)}/version/${encodeURIComponent(vid)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    base,
  );
}

/** POST .../version/:vid/session — 基于版本工作区启动 academy-student 会话 */
export async function startVersionSession(
  cid: string,
  sid: string,
  vid: string,
  body?: { title?: string },
  base?: string,
): Promise<{ sessionId: string }> {
  return req(
    `/academy/classroom/${encodeURIComponent(cid)}/student/${encodeURIComponent(sid)}/version/${encodeURIComponent(vid)}/session`,
    { method: 'POST', body: JSON.stringify(body ?? {}) },
    base,
  );
}

// ── 版本 skill 单文件读 / 写（18-academy §1.11） ─────────────────────────

/** 版本 skill 文件端点 URL（cid/sid/vid/skillName 全 encode；path 走 query，不传 workspaceDir） */
function versionSkillFileUrl(cid: string, sid: string, vid: string, skillName: string): string {
  return `/academy/classroom/${encodeURIComponent(cid)}/student/${encodeURIComponent(sid)}/version/${encodeURIComponent(vid)}/skill/${encodeURIComponent(skillName)}/file`;
}

/**
 * GET .../version/:vid/skill/:name/file?path= — 读版本 skill 内单文件。
 * binary=true 时 content=''（前端显「不可预览」）；超 256KB → truncated=true。
 */
export async function getVersionSkillFile(
  cid: string,
  sid: string,
  vid: string,
  skillName: string,
  path: string,
  base?: string,
): Promise<VersionSkillFileContent> {
  const q = new URLSearchParams({ path });
  return req(`${versionSkillFileUrl(cid, sid, vid, skillName)}?${q.toString()}`, undefined, base);
}

/**
 * PATCH .../version/:vid/skill/:name/file — 覆写版本 skill 内单文件（仅 formal）。
 *
 * 调用方门禁：只在 formal 版本调用；后端仍二次校验（process → 409 process_version_readonly）。
 * 后端只覆写已存在的文本文件——不存在 → 404，二进制目标 → 400 binary_not_writable。
 */
export async function saveVersionSkillFile(
  cid: string,
  sid: string,
  vid: string,
  skillName: string,
  path: string,
  content: string,
  base?: string,
): Promise<{ ok: true; path: string }> {
  return req(
    versionSkillFileUrl(cid, sid, vid, skillName),
    { method: 'PATCH', body: JSON.stringify({ path, content }) },
    base,
  );
}

// ── 训练任务 ─────────────────────────────────────────────────────────────

/** POST .../student/:sid/training-task — 发起训练（建 coach session + task record） */
export async function createTrainingTask(
  cid: string,
  sid: string,
  body: CreateTrainingTaskBody,
  base?: string,
): Promise<{ task: TrainingTaskEntity; coachSessionId: string }> {
  return req(
    `/academy/classroom/${encodeURIComponent(cid)}/student/${encodeURIComponent(sid)}/training-task`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/** GET /academy/training-task/:tid — 任务详情（含历史轮次） */
export async function getTrainingTaskDetail(tid: string, base?: string): Promise<TrainingTaskDetail> {
  return req(`/academy/training-task/${encodeURIComponent(tid)}`, undefined, base);
}

/** POST /academy/training-task/:tid/revise — 推进一轮 revise（调试/手动推进用，coach 自主跑为主） */
export async function reviseTask(tid: string, base?: string): Promise<unknown> {
  return req(`/academy/training-task/${encodeURIComponent(tid)}/revise`, { method: 'POST', body: '{}' }, base);
}

/**
 * POST /academy/training-task/:tid/adopt — 旁路归档（v0.0.221）。
 * 任意 process 版定稿为新 formal（x.0 递增）；不改 task 状态；可重复。
 * 返新 formal 版本 id + label + workspaceDir。
 */
export async function adoptTaskVersion(
  tid: string,
  versionId: string,
  base?: string,
): Promise<{ newFormalVersionId: string; newLabel: string; newWorkspaceDir: string }> {
  return req(
    `/academy/training-task/${encodeURIComponent(tid)}/adopt`,
    { method: 'POST', body: JSON.stringify({ versionId }) },
    base,
  );
}

/** POST /academy/training-task/:tid/pause — 可逆暂停（reason 可选，缺省 stopped） */
export async function pauseTrainingTask(
  tid: string,
  reason?: 'stopped' | 'earlystop' | 'maxturns' | 'completed',
  base?: string,
): Promise<{ taskId: string; status: string; pausedReason?: string }> {
  return req(
    `/academy/training-task/${encodeURIComponent(tid)}/pause`,
    { method: 'POST', body: JSON.stringify({ reason }) },
    base,
  );
}

/** POST /academy/training-task/:tid/resume — 续训（reason=maxturns 时后端返 409 task_at_maxturns） */
export async function resumeTrainingTask(tid: string, base?: string): Promise<{ taskId: string; status: string }> {
  return req(`/academy/training-task/${encodeURIComponent(tid)}/resume`, { method: 'POST', body: '{}' }, base);
}

/** POST /academy/training-task/:tid/update-task — patch maxTurns / directive（head 监督级） */
export async function updateTrainingTask(
  tid: string,
  body: { maxTurns?: number; directive?: string },
  base?: string,
): Promise<{ taskId: string; maxTurns?: number; directive?: string }> {
  return req(
    `/academy/training-task/${encodeURIComponent(tid)}/update-task`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/** POST /academy/training-task/:tid/inject-directive — 训练中注入指导（透传 coach + append directive） */
export async function injectTrainingDirective(tid: string, directive: string, base?: string): Promise<{ ok: true }> {
  return req(
    `/academy/training-task/${encodeURIComponent(tid)}/inject-directive`,
    { method: 'POST', body: JSON.stringify({ directive }) },
    base,
  );
}

/** GET /academy/classroom/:cid/dataset/:did — 数据集详情（含 items；case 表 question join 用） */
export async function getDataset(cid: string, did: string, base?: string): Promise<DatasetEntity> {
  return req(`/academy/classroom/${encodeURIComponent(cid)}/dataset/${encodeURIComponent(did)}`, undefined, base);
}

/** GET /academy/classroom/:cid/grader/:gid — 评估器详情 */
export async function getGrader(cid: string, gid: string, base?: string): Promise<GraderEntity> {
  return req(`/academy/classroom/${encodeURIComponent(cid)}/grader/${encodeURIComponent(gid)}`, undefined, base);
}

/** 分数 0-1 → demo 0-10 显示域（engine 契约 score∈[0,1]，demo 视觉契约 7.6/6.2 十分制） */
export function score10(score: number | undefined): number | undefined {
  return score === undefined ? undefined : Math.round(score * 100) / 10;
}

// ── academy session 列表（18 §4.1 的 GET /academy/session 未实现；用 ?biz=academy 前端过滤） ──

/** GET /session?biz=academy — academy 域全部 session（head/coach/student），可选 classroomId 前端过滤 */
export async function listAcademySessions(classroomId?: string, base?: string): Promise<Session[]> {
  const r = await req<{ items: Session[] }>('/session?biz=academy', undefined, base);
  const items = r.items ?? [];
  return classroomId ? items.filter((s) => s.academyClassroomId === classroomId) : items;
}

