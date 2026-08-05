/**
 * app_config sub_agent_templates 保护 handler
 * 参考: specs/api/overall/10-multi-agent.md §5.2（PUT builtin 保护）/ §5.3（DELETE /config/app/sub_agent_templates）
 *       specs/tech/multi_agent/[P1]subagent_templates.md §3（CRUD + builtin 只读可复制）
 *       specs/prd/version_logs/v0.0.89/05-dev-to-app-migration.md §3.1.C
 *
 * 职责：
 *   - handleKvConfigAppTemplateDelete: DELETE /config/app/sub_agent_templates（仅该 group 允许；
 *     builtin:true 拒 403 builtin_readonly；其他 group 拒 403 group_not_deletable）
 *   - handleKvConfigAppTemplatePut: PUT 包装（写 sub_agent_templates group 时做 builtin 保护；
 *     新建禁止 builtin:true；改 builtin 模板拒 403 builtin_readonly）
 */
import type { AppConfigService } from '../config/app-config-service';
import { SUB_AGENT_TEMPLATES_GROUP } from '../agent/tools/template-store';
import { handleKvConfigPut } from './kv-config-handlers';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** DELETE /config/app/sub_agent_templates 请求体 */
interface AppTemplateDeleteBody {
  group?: string;
  key?: string;
}

/**
 * 处理 DELETE /config/app/sub_agent_templates（api spec §5.3）。
 *
 * 分支：
 *   1. body 缺 group/key → 400
 *   2. group !== sub_agent_templates → 403 group_not_deletable（保守：仅模板组允许删，
 *      系统/未知 group 一律拒）
 *   3. record 不存在 → 404 Not Found
 *   4. record.data.builtin === true → 403 builtin_readonly（builtin 模板只读，可 copy 不可删）
 *   5. 正常删除 → 200 { ok: true }
 *
 * @param req  Request（读 body）
 * @param svc  AppConfigService
 * @returns Response
 */
export async function handleKvConfigAppTemplateDelete(
  req: Request,
  svc: AppConfigService,
): Promise<Response> {
  let body: AppTemplateDeleteBody;
  try {
    body = (await req.json()) as AppTemplateDeleteBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (typeof body.group !== 'string' || typeof body.key !== 'string') {
    return json(400, { error: 'body requires group, key' });
  }
  const group = body.group;
  const key = body.key;

  // 分支 2：group 范围门控（仅 sub_agent_templates 允许删，其他一律拒）。
  if (group !== SUB_AGENT_TEMPLATES_GROUP) {
    return json(403, { error: 'group_not_deletable' });
  }

  // 分支 3：record 不存在 → 404
  const existing = svc.get(group, key);
  if (existing === undefined) {
    return json(404, { error: 'Not Found' });
  }

  // 分支 4：builtin:true → 403 builtin_readonly
  const isBuiltin =
    typeof existing === 'object' &&
    existing !== null &&
    (existing as { builtin?: unknown }).builtin === true;
  if (isBuiltin) {
    return json(403, { error: 'builtin_readonly' });
  }

  // 分支 5：正常删除
  svc.delete(group, key);
  return json(200, { ok: true });
}

/**
 * PUT /config/app/sub_agent_templates 包装：先做 builtin 保护校验，再委托 handleKvConfigPut。
 *
 * builtin 保护覆盖两种 body 形态：
 *   - 单 key 形态（{group,key,data}）：checkBuiltinProtection(group,key,data)
 *   - 整组形态（{group,items[]}）：逐 item checkBuiltinProtection
 *
 * 任一 item 命中保护 → 立即返 403，不写入任何 item（原子：保护失败=整体拒绝）。
 * 非 sub_agent_templates group 放行（checkBuiltinProtection 内部短路）。
 */
export async function handleKvConfigAppTemplatePut(
  req: Request,
  svc: AppConfigService,
): Promise<Response> {
  // 预读 body 做保护校验（req.json() 一次性，需 clone 让下游 handleKvConfigPut 再读）
  let body: {
    group?: string;
    key?: string;
    data?: unknown;
    items?: { key: string; data: unknown }[];
  };
  try {
    body = (await req.clone().json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  const group = typeof body.group === 'string' ? body.group : '';
  if (group === SUB_AGENT_TEMPLATES_GROUP) {
    // 整组形态：逐 item 校验保护（任一拒=整体拒，原子）
    if (body.items !== undefined) {
      for (const item of body.items) {
        const blocked = checkBuiltinProtection(svc, group, item.key, item.data);
        if (blocked) return blocked;
      }
    } else if (typeof body.key === 'string') {
      // 单 key 形态
      const blocked = checkBuiltinProtection(svc, group, body.key, body.data);
      if (blocked) return blocked;
    }
  }
  // 放行：走原 handleKvConfigPut（secret redact + setGroup/set 分发）
  return handleKvConfigPut(req, svc);
}

/**
 * PUT /config/app/sub_agent_templates 的 builtin 保护钩子（api spec §5.2）。
 * 仅当 group === sub_agent_templates 时生效；其他 group 直接放行（返 null）。
 *
 * 规则：
 *   - 新建（record 不存在）禁止 builtin:true（仅系统预配）→ 返 403 builtin_readonly
 *   - 改 builtin 模板（record.data.builtin === true）→ 返 403 builtin_readonly（builtin 只读）
 *
 * @param svc    AppConfigService
 * @param group  body.group
 * @param key    body.key
 * @param data   body.data（写入值）
 * @returns Response（拒绝时）；null（放行，由调用方继续 set）
 */
export function checkBuiltinProtection(
  svc: AppConfigService,
  group: string,
  key: string,
  data: unknown,
): Response | null {
  if (group !== SUB_AGENT_TEMPLATES_GROUP) return null; // 非 sub_agent_templates 放行
  const existing = svc.get(group, key);
  const writingBuiltin =
    typeof data === 'object' &&
    data !== null &&
    (data as { builtin?: unknown }).builtin === true;
  // 新建禁止 builtin:true（仅系统预配）
  if (existing === undefined && writingBuiltin) {
    return json(403, { error: 'builtin_readonly' });
  }
  // 改 builtin 模板（已存在的 builtin:true record）→ 拒（只读）
  const existingBuiltin =
    typeof existing === 'object' &&
    existing !== null &&
    (existing as { builtin?: unknown }).builtin === true;
  if (existingBuiltin) {
    return json(403, { error: 'builtin_readonly' });
  }
  return null;
}
