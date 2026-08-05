/**
 * member handlers — /squad/:id/member/* 管理（hire / edit / deploy / bench，无 DELETE）
 * 参考: specs/api/overall/11a-squad-endpoints.md §2（hire/edit/deploy/bench payload + 响应 + 错误码）
 *       specs/tech/squad/[P1]data_model.md §5（createMemberService）+ squad_definition §8（leader 不可 bench）
 *       specs/tech/academy/[P1]squad_derive.md §2-3（derive_academy 模式 + 400 invalid_academy_source）
 *
 * 职责（4 端点，member 不可删——bench 兜底）：
 *   - POST /squad/:id/member           hire（fresh / derive / derive_academy）→ 201 + { member, sessionId }
 *   - PATCH /squad/:id/member/:mid     edit（name/intro/skillConfig/workStyle；不可改 role/state/squadId/sessionId）；
 *       intro 提供但 trim 后为空 → 400 intro required（与创建口径一致）
 *   - POST  /squad/:id/member/:mid/deploy  benched → deployed（幂等）
 *   - POST  /squad/:id/member/:mid/bench   deployed → benched（leader 返 403 leader_not_benchable）
 *
 * dead 字段（旧 client 传 → accept-and-ignore + warn，不 400）：tools（static-by-type）/ heartbeat（升级 squad.heartbeatConfig）/ model（member 不持运行配置，model 走 session）。
 * 双层拒 leader bench：handler 返 403 + UI 隐藏按钮。
 */
import { SquadStore, MemberStore } from '../stores/squad-store';
// hire（fresh/derive/derive_academy）已拆 member-hire-handler.ts（本文件 ≤300 行约束）
import { handleHire } from './member-hire-handler';
// [v0.0.233] derive_academy 预检 endpoint（纯只读，独立 handler）
import { handleDeriveAcademyPreview } from './member-preview-handler';
// PATCH name 冲突复用 hire 的错误类型（409 member_name_conflict）
import { MemberNameConflictError } from '../services/member-service';
import {
  deployMemberService,
  benchMemberService,
  patchMemberService,
  MemberNotFoundError,
  LeaderNotBenchableError,
} from '../services/member-mutations';
import type { PatchMemberInput } from '../services/member-mutations';
import type { MemberSkillConfig } from '../agent/schema_defs/squad/member';
import type { SquadHandlerDeps } from './squad';

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 内部构造 squad/member store（与 SquadHandler 一致，handler 自包含） */
function makeStores(deps: SquadHandlerDeps): { squadStore: SquadStore; memberStore: MemberStore } {
  return {
    squadStore: new SquadStore({ root: deps.dataDir }),
    memberStore: new MemberStore({ root: deps.dataDir }),
  };
}

/** PATCH member 请求体（11a §2.2 PatchMemberBody，仅可变字段） */
//   dead 字段：tools（v0.0.48）/ model（v0.0.155 A4 硬删）→ accept-and-ignore + warn（不返 400）
//   intro（一句话介绍）可编辑：提供但 trim 后为空 → 400（与创建校验口径一致）
//   [v0.0.113] skills?: string[] → skillConfig?（整体替换 overlay 快照，含 mode 切换 + overrides）
interface PatchMemberBody {
  name?: string;
  intro?: string;
  /** 工作方式（v0.0.142，可空，空串=清空回写，无非空 400——区别于 intro） */
  workStyle?: string;
  skillConfig?: MemberSkillConfig;
  heartbeat?: object | null;
}

/** bench 请求体（11a §2.4 BenchBody） */
interface BenchBody {
  reason: string;
}

/**
 * /squad/:id/member/* 路由分发（hire / edit / deploy / bench，无 DELETE）。
 *
 * @param req     入站 Request
 * @param method  HTTP 方法（大写）
 * @param path    URL pathname（/squad/:id/member...，squadId 由本函数从 path 解析）
 * @param deps    handler 依赖（SessionStore + dataDir）
 */
export async function handleMemberRoute(
  req: Request,
  method: string,
  path: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  // /squad/:id/member（hire）
  const collMatch = path.match(/^\/squad\/([^/]+)\/member$/);
  if (collMatch) {
    if (method === 'POST') return handleHire(req, collMatch[1]!, deps);
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  // [v0.0.233] /squad/:id/member/derive-academy/preview（预检，纯只读 POST）
  // 4 段路径与下面 item match（3 段，`:mid`=`[^/]+` 不含 `/`）天然互斥，无歧义
  const previewMatch = path.match(/^\/squad\/([^/]+)\/member\/derive-academy\/preview$/);
  if (previewMatch) {
    if (method === 'POST') return handleDeriveAcademyPreview(req, previewMatch[1]!, deps);
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  // /squad/:id/member/:mid（PATCH edit）
  const itemMatch = path.match(/^\/squad\/([^/]+)\/member\/([^/]+)$/);
  if (itemMatch) {
    if (method === 'PATCH') return handlePatchMember(req, itemMatch[1]!, itemMatch[2]!, deps);
    return json(405, { error: 'Method Not Allowed' }, 'PATCH');
  }
  // /squad/:id/member/:mid/deploy | /bench
  const stateMatch = path.match(/^\/squad\/([^/]+)\/member\/([^/]+)\/(deploy|bench)$/);
  if (stateMatch) {
    const op = stateMatch[3]!;
    if (method !== 'POST') {
      return json(405, { error: 'Method Not Allowed' }, 'POST');
    }
    if (op === 'deploy') return handleDeploy(req, stateMatch[1]!, stateMatch[2]!, deps);
    return handleBench(req, stateMatch[1]!, stateMatch[2]!, deps);
  }
  return json(404, { error: 'Not Found' });
}

/** PATCH /squad/:id/member/:mid — edit 可变字段（thin wrapper 调 patchMemberService，11a §2.2） */
async function handlePatchMember(
  req: Request,
  squadId: string,
  memberId: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  let body: PatchMemberBody;
  try {
    body = (await req.json()) as PatchMemberBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid body' });

  // dead 字段 accept-and-ignore + warn（11a §2.2 向后兼容契约；仍声明但不入 PatchMemberInput）：
  //   tools（static-by-type）/ heartbeat（升级 squad.heartbeatConfig）/ model（走 PUT /session）。
  const rawBody = body as Record<string, unknown>;
  if (rawBody.tools !== undefined) {
    console.warn('[v0.0.48] PatchMemberBody.tools is dead (static-by-type via tool-policy.ts); ignoring');
  }
  if (rawBody.heartbeat !== undefined) {
    console.warn('[v0.0.116] PatchMemberBody.heartbeat is dead (use PATCH /squad heartbeatConfig); ignoring');
  }
  if (rawBody.model !== undefined) {
    console.warn('PatchMemberBody.model is dead (member 不持 model；use PUT /session for model); ignoring');
  }

  // 构 PatchMemberInput（drop dead tools/heartbeat/model，仅传业务字段；service 负责 read-modify-write + 校验）
  const patch: PatchMemberInput = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.intro !== undefined) patch.intro = body.intro;
  if (body.workStyle !== undefined) patch.workStyle = body.workStyle;
  if (body.skillConfig !== undefined) patch.skillConfig = body.skillConfig;

  const { memberStore } = makeStores(deps);
  try {
    const member = await patchMemberService(
      { memberStore },
      squadId,
      memberId,
      patch,
    );
    return json(200, { member });
  } catch (e) {
    if (e instanceof MemberNotFoundError) return json(404, { error: 'member not found' });
    if (e instanceof MemberNameConflictError) return json(400, { error: 'member_name_conflict' });
    const msg = e instanceof Error ? e.message : String(e);
    // service 校验错误透传：intro trim 后空
    if (msg === 'intro required') return json(400, { error: 'intro required' });
    return json(500, { error: 'patch member failed', detail: msg });
  }
}

/** POST /squad/:id/member/:mid/deploy — benched → deployed（thin wrapper 调 deployMemberService，幂等，11a §2.3） */
async function handleDeploy(
  _req: Request,
  squadId: string,
  memberId: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  const { memberStore } = makeStores(deps);
  try {
    const member = await deployMemberService({ memberStore }, squadId, memberId);
    return json(200, { member });
  } catch (e) {
    if (e instanceof MemberNotFoundError) return json(404, { error: 'member not found' });
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: 'deploy member failed', detail: msg });
  }
}

/** POST /squad/:id/member/:mid/bench — deployed → benched（thin wrapper 调 benchMemberService，leader 返 403，11a §2.4） */
async function handleBench(
  req: Request,
  squadId: string,
  memberId: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  let body: BenchBody;
  try {
    body = (await req.json()) as BenchBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  // reason required 入参校验保留在 handler 入口（HTTP 400 语义前置；service 兜底也校验但保持顺序在前）
  if (!body || typeof body.reason !== 'string' || body.reason.length === 0) {
    return json(400, { error: 'reason required' });
  }

  const { memberStore } = makeStores(deps);
  try {
    const member = await benchMemberService({ memberStore }, squadId, memberId, body.reason);
    return json(200, { member });
  } catch (e) {
    if (e instanceof MemberNotFoundError) return json(404, { error: 'member not found' });
    // leader 不可 bench（双层拒：handler 403 + UI 隐藏按钮，squad_definition §8）
    if (e instanceof LeaderNotBenchableError) return json(403, { error: 'leader_not_benchable' });
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: 'bench member failed', detail: msg });
  }
}
