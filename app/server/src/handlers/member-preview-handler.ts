/**
 * member-preview-handler — POST /squad/:id/member/derive-academy/preview
 * 参考: specs/api/overall/11a-squad-endpoints.md §2.5（preview endpoint + PreviewResult schema）
 *       specs/tech/academy/[P1]derive_preview_conflict.md §2（预检算法 + 补偿不变量边界）
 *
 * 纯只读预检：读学生版本源（version.workspaceDir）+ squad 团队盘目标 → PreviewResult
 * （清单 + 同名标）。不写任何文件（previewDeriveAcademySeed 内部保证）。
 *
 * 错误码（与 hire 一致）：
 *   - body 非法 JSON / 三字段任一缺 → 400 invalid_academy_source
 *   - squad 不存在 → 404 squad not found
 *   - resolveAcademyDeriveIdentity 失败（version 非 formal+active / classroom 不存在）
 *     → InvalidAcademySourceError → 400 invalid_academy_source
 *
 * 自包含：json helper + store 构造本地一份（与 member-hire-handler 同款模式）。
 */
import { SquadStore, squadRootDir } from '../stores/squad-store';
import { AcademyStore } from '../academy/academy-store';
import { previewDeriveAcademySeed, InvalidAcademySourceError } from '../services/member-academy-bridge';
import type { SquadHandlerDeps } from './squad';

/** JSON Response 构造（与 member-hire-handler 同款） */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * POST /squad/:id/member/derive-academy/preview — derive_academy 派生前预检（纯只读）。
 *
 * 入参 body `{ classroomId, studentId, versionId }`（与 hire body academySource 同结构）；
 * 出参 `PreviewResult`（agentsMd.exists + skills/memory Array<{name, sameNameConflict}>）。
 */
export async function handleDeriveAcademyPreview(
  req: Request,
  squadId: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  let body: { classroomId?: string; studentId?: string; versionId?: string };
  try {
    body = (await req.json()) as { classroomId?: string; studentId?: string; versionId?: string };
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid body' });
  // 三字段必填（与 hire 入参校验同口径）→ 400 invalid_academy_source
  if (!body.classroomId || !body.studentId || !body.versionId) {
    return json(400, { error: 'invalid_academy_source' });
  }

  // squad 必须存在（同 hire 404 语义；11a §2.5 step1）
  const squadStore = new SquadStore({ root: deps.dataDir });
  const squad = await squadStore.getSquad(squadId);
  if (!squad) return json(404, { error: 'squad not found' });

  const academyStore = new AcademyStore({ root: deps.dataDir });
  const squadRoot = squadRootDir(deps.dataDir, squadId);
  try {
    const result = await previewDeriveAcademySeed({
      academyStore,
      classroomId: body.classroomId,
      studentId: body.studentId,
      versionId: body.versionId,
      squadRoot,
    });
    return json(200, result);
  } catch (e) {
    // 复用 resolveAcademyDeriveIdentity 失败映射 400 invalid_academy_source（与 hire 错误码一致）
    if (e instanceof InvalidAcademySourceError) {
      return json(400, { error: 'invalid_academy_source' });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: 'preview derive_academy failed', detail: msg });
  }
}
