/**
 * member-hire-handler — POST /squad/:id/member（hire fresh / derive / derive_academy）
 * 参考: specs/api/overall/11a-squad-endpoints.md §2.1（hire payload + 响应 + 错误码）
 *       specs/tech/academy/[P1]squad_derive.md §2-3（derive_academy + 400 invalid_academy_source）
 *
 * 拆分原因：member.ts 加 derive_academy 后超 300 行；hire 是成员管理里最重的一段（三模式校验 +
 *   dead 字段兼容 + 事务调用 + 错误映射），独立成文件保持单文件 ≤300。
 * 自包含：json helper + store 构造本地一份（与 member.ts 同款模式，handler 自包含惯例）。
 */
import { SquadStore, MemberStore } from '../stores/squad-store';
import { AcademyStore } from '../academy/academy-store';
import { createMemberService, MemberNameConflictError, DeriveSourceNotFoundError } from '../services/member-service';
import type { CreateMemberInput, CreateMemberDeps } from '../services/member-service';
import type { MemberSkillConfig } from '../agent/schema_defs/squad/member';
import type { DeriveResolution } from '../services/member-academy-bridge';
import type { SquadHandlerDeps } from './squad';

/** JSON Response 构造（与 member.ts 同款，handler 自包含惯例） */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** hire 请求体（11a §2.1 HireMemberBody，判别联合 fresh | derive | derive_academy） */
//   workStyle?（trim 回写、空串=空串无 400）；skillConfig?（缺省 inherit，后端 seed）
//   dead 字段：tools / model → accept-and-ignore + warn（不 400）
//   derive_academy：academySource 三字段必填（squad_derive §2.1），name 必填；
//     源不可派生（version 非 formal+active / classroom 不存在）→ 400 invalid_academy_source（§3）
type HireBody =
  | { mode: 'fresh'; name: string; intro: string; workStyle?: string; skillConfig?: MemberSkillConfig }
  | {
      mode: 'derive';
      deriveFrom: string;
      overrides?: Partial<{ name: string; intro: string; workStyle: string; skillConfig: MemberSkillConfig }>;
    }
  | {
      mode: 'derive_academy';
      name: string;
      intro?: string;
      workStyle?: string;
      skillConfig?: MemberSkillConfig;
      academySource: { classroomId: string; studentId: string; versionId: string };
      // [v0.0.233] 同名裁决（undefined = 默认全 skip 同名 + 不同名 merge）
      resolution?: DeriveResolution;
    };

/** POST /squad/:id/member — hire（fresh / derive / derive_academy，事务 + 补偿回滚） */
export async function handleHire(req: Request, squadId: string, deps: SquadHandlerDeps): Promise<Response> {
  let body: HireBody;
  try {
    body = (await req.json()) as HireBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object'
    || (body.mode !== 'fresh' && body.mode !== 'derive' && body.mode !== 'derive_academy')) {
    return json(400, { error: 'mode required (fresh | derive | derive_academy)' });
  }

  // 入参校验（service 兜底也校验）：fresh 缺 name/intro → 400；derive 缺 deriveFrom → 400；
  //   derive_academy 缺 name → 400；academySource 结构缺 → 400 invalid_academy_source（squad_derive §3）
  if (body.mode === 'fresh') {
    if (!body.name || body.name.length === 0) return json(400, { error: 'name required' });
    if (!body.intro || body.intro.trim().length === 0) return json(400, { error: 'intro required' });
  } else if (body.mode === 'derive') {
    if (!body.deriveFrom) return json(400, { error: 'deriveFrom required' });
  } else {
    if (!body.name || body.name.length === 0) return json(400, { error: 'name required' });
    const src = body.academySource;
    if (!src || typeof src !== 'object' || !src.classroomId || !src.studentId || !src.versionId) {
      return json(400, { error: 'invalid_academy_source' });
    }
  }
  // dead 字段：旧 client 传 → accept-and-ignore + warn（不 400）。model 走 session（PUT /session/:id）。
  const rawBody = body as Record<string, unknown>;
  if (rawBody.model !== undefined) {
    console.warn('HireBody.model is dead (member 不持 model；use PUT /session for model); ignoring');
  }
  const rawOverrides =
    body.mode === 'derive' ? (body.overrides as Record<string, unknown> | undefined) : undefined;
  if (rawOverrides && rawOverrides.model !== undefined) {
    console.warn('HireBody.overrides.model is dead (member 不持 model); ignoring');
  }
  if (rawBody.tools !== undefined) {
    console.warn('[v0.0.48] HireBody.tools is dead (static-by-type via tool-policy.ts); ignoring');
  }
  if (rawOverrides && rawOverrides.tools !== undefined) {
    console.warn('[v0.0.48] HireBody.overrides.tools is dead (static-by-type via tool-policy.ts); ignoring');
  }

  const input: CreateMemberInput = {
    squadId,
    mode: body.mode,
    ...(body.mode === 'fresh'
      ? {
          name: body.name,
          intro: body.intro, // fresh 必填（已校验非空）
          ...(body.workStyle !== undefined ? { workStyle: body.workStyle } : {}),
          ...(body.skillConfig !== undefined ? { skillConfig: body.skillConfig } : {}),
        }
      : body.mode === 'derive'
        ? {
            deriveFrom: body.deriveFrom,
            ...(body.overrides !== undefined ? { overrides: body.overrides } : {}),
          }
        : {
            // derive_academy：name 必填已校验；intro/workStyle/skillConfig 可选直传
            name: body.name,
            academySource: body.academySource,
            ...(body.intro !== undefined ? { intro: body.intro } : {}),
            ...(body.workStyle !== undefined ? { workStyle: body.workStyle } : {}),
            ...(body.skillConfig !== undefined ? { skillConfig: body.skillConfig } : {}),
            // [v0.0.233] 透传同名裁决结果（trust 前端，service/seed 用枚举闭合消费）
            ...(body.resolution !== undefined ? { resolution: body.resolution } : {}),
          }),
  };

  const memberDeps: CreateMemberDeps = {
    sessionStore: deps.sessionStore,
    squadStore: new SquadStore({ root: deps.dataDir }),
    memberStore: new MemberStore({ root: deps.dataDir }),
    academyStore: new AcademyStore({ root: deps.dataDir }),
    dataDir: deps.dataDir,
    appConfig: deps.appConfig,
  };
  try {
    const created = await createMemberService(memberDeps, input);
    // [v0.0.305] 落盘成功后 broadcast squad 聚合（在线数变化；PRD §4.4.2）
    deps.squadMetaBroadcaster?.broadcast(squadId);
    return json(201, { member: created.member, sessionId: created.sessionId });
  } catch (e) {
    if (e instanceof MemberNameConflictError) return json(409, { error: 'member_name_conflict' });
    if (e instanceof DeriveSourceNotFoundError) {
      // derive_academy 源不可派生 → 400 invalid_academy_source（squad_derive §3）；
      //   普通 derive 的 deriveFrom 不存在 → 404（11a §2.1）
      if (body.mode === 'derive_academy') return json(400, { error: 'invalid_academy_source' });
      return json(404, { error: 'deriveFrom member not found' });
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'squad not found') return json(404, { error: 'squad not found' });
    // 入参缺失（name required / intro required / academySource required）→ 400
    if (/required/.test(msg)) return json(400, { error: msg });
    return json(500, { error: 'hire member failed', detail: msg });
  }
}
