/**
 * KV config handlers — /config/app GET/PUT/DELETE（通用 KV 形状 + secret redact）
 * 参考: specs/api/overall/02-llm-chat.md §4（get-set）
 *       specs/api/overall/21-model-routing.md §2.2/§2.3（方案库校验钩子 + DELETE 白名单）
 *       specs/prd/version_logs/v0.0.89/05-dev-to-app-migration.md §3.1.D/E
 *
 * 设计：
 *   - app：通用 KV（委托 AppConfigService）
 *       GET ?group=&key= → 单值 { value }（缺失返 null）
 *       GET ?group=      → 整组 { items:[{key,data}] }
 *       PUT {group,key,data}              → { ok:true }（单 key，向后兼容）
 *       PUT {group,items:[{key,data},...]} → { ok:true }（整组原子提交）
 *       DELETE ?group=&key=               → [v0.0.347] 仅 model_routing_plans 白名单（其他 405）
 *   - secret 处理：GET 全部明文返回（secret mask 收敛到前端 SecretInput 展示层，与
 *     observability / providers / web_search 一致）；PUT 占位 '***' merge 回落盘原值
 *     （observability 列表 / web.jinaApiKey 标量，向后兼容旧前端）。
 *   - [v0.0.347] PUT 校验钩子：model_routing_plans → validateModelRoutingPlan（违规 400）；
 *     model_routing/default → setPlaygroundPlanId（playgroundPlanId 不存在 → 400）。
 */
import type { AppConfigService } from '../config/app-config-service';
import type { ObservabilityConfigItem } from '../observability/observability-manager';
import {
  isObservabilityKV,
  mergeObservabilityPlaceholderSecrets,
} from './observability-redact';
// app_config web group secret merge（jinaApiKey PUT 占位 merge；GET 明文，mask 收敛前端）
import {
  isWebSecretKV,
  mergeWebSecretPlaceholder,
} from './web-config-redact';
// [v0.0.347] DELETE 分支：方案库删除（group 白名单 + 引用解除）+ PUT 方案校验钩子
import { SquadStore } from '../stores/squad-store';
import { validateModelRoutingPlan } from '../services/model-routing-validation';
import {
  deletePlan,
  savePlan,
  setPlaygroundPlanId,
  MODEL_ROUTING_PLANS_GROUP,
  MODEL_ROUTING_GROUP,
  MODEL_ROUTING_DEFAULT_KEY,
  ModelRoutingValidationError,
  ModelRoutingPlanNotFoundError,
} from '../services/model-routing-store';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 对 PUT 入参的 data 做 secret 占位 merge（observability 列表 + web.jinaApiKey 标量）。
 * 占位 `'***'` 视为「不改」→ 回填落盘原值；明文 → 直接入参。其他 KV 透传。
 */
function mergePut(
  service: AppConfigService,
  group: string,
  key: string,
  data: unknown,
): unknown {
  if (isObservabilityKV(group, key)) {
    return mergeObservabilityPlaceholderSecrets(
      (data as ObservabilityConfigItem[]) ?? [],
      (service.get(group, key) as ObservabilityConfigItem[] | undefined) ?? [],
    );
  }
  if (isWebSecretKV(group, key)) {
    return mergeWebSecretPlaceholder(data, service.get(group, key));
  }
  return data;
}

/** PUT /config/{app,dev} 请求体形状（两种形态并存：单 key 或整组） */
interface KvPutBody {
  group?: string;
  /** 单 key 形态（向后兼容） */
  key?: string;
  data?: unknown;
  /** 整组提交形态：body 含 items[] 时走 setGroup，items 空数组为 no-op */
  items?: { key: string; data: unknown }[];
}

/**
 * 处理 /config/app 的 GET（通用 KV 形状）。
 * [v0.0.347] 保持同步签名（既有调用零回归）；DELETE 走 handleKvConfigDelete（async）。
 */
export function handleKvConfig(
  req: Request,
  method: string,
  url: URL,
  service: AppConfigService,
): Response {
  if (method === 'GET') {
    const group = url.searchParams.get('group');
    const key = url.searchParams.get('key');
    if (!group) return json(400, { error: 'missing group query' });
    if (key !== null) {
      // 单值：GET 明文返回（secret mask 收敛到前端 SecretInput 展示层）
      const items = service.listGroup(group);
      const hit = items.find((i) => i.key === key);
      const value = hit ? hit.data : null;
      return json(200, { value });
    }
    // 整组：每项 data 明文返回（secret mask 收敛到前端展示层）
    const items = service.listGroup(group);
    return json(200, { items });
  }
  return json(500, { error: 'use handleKvConfigPut' });
}

/**
 * [v0.0.347] DELETE /config/app?group=model_routing_plans&key=<planId> — 删除方案（api §2.3）。
 *
 * 语义：group 白名单仅 `model_routing_plans`（其他 group → 405 不落盘）；
 * key 缺失 → 400；方案不存在 → 404；成功 → { ok: true, detached: string[] }（引用解除清单）。
 * 引用解除（squad.modelRoutingPlanId / playgroundPlanId 清空）先于删 record（tech §8.3）。
 *
 * @param dataDir  squad entity 数据根（SquadStore 引用解除扫描用；与 app_config 同 DATA_DIR）
 */
export async function handleKvConfigDelete(
  url: URL,
  service: AppConfigService,
  dataDir: string,
): Promise<Response> {
  const group = url.searchParams.get('group');
  const key = url.searchParams.get('key');
  if (group !== MODEL_ROUTING_PLANS_GROUP) {
    return json(405, { error: 'Method Not Allowed' });
  }
  if (!key || key.length === 0) {
    return json(400, { error: 'key query required' });
  }
  const detached = await deletePlan(service, key, {
    squadStore: new SquadStore({ root: dataDir }),
  });
  if (detached === undefined) return json(404, { error: 'plan not found' });
  return json(200, { ok: true, detached });
}

/**
 * 解析并校验 PUT /config/app body；按 body 形态分发：
 *  - body 含 items[] → setGroup（整组原子提交）
 *  - 否则 → set（单 key，向后兼容）
 *
 * [v0.0.347] 校验钩子（api §2.2/§2.4）：
 *  - group=model_routing_plans → 调 validateModelRoutingPlan（违规 400 + message，不落盘）
 *  - group=model_routing & key=default → 调 setPlaygroundPlanId（playgroundPlanId 不存在 → 400）
 */
export async function handleKvConfigPut(
  req: Request,
  service: AppConfigService,
): Promise<Response> {
  let body: KvPutBody;
  try {
    body = (await req.json()) as KvPutBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (typeof body.group !== 'string') {
    return json(400, { error: 'body requires group' });
  }
  // 整组提交分支：body 含 items[]
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) {
      return json(400, { error: 'items must be array' });
    }
    if (body.items.length === 0) {
      return json(200, { ok: true });
    }
    for (const item of body.items) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof item.key !== 'string' ||
        item.data === undefined
      ) {
        return json(400, { error: 'each item requires { key, data }' });
      }
    }
    // [v0.0.347] 整组提交 model_routing_plans 也做方案校验（防绕过；其他 group 透传）
    const group = body.group as string;
    if (group === MODEL_ROUTING_PLANS_GROUP) {
      for (const item of body.items) {
        const v = validateModelRoutingPlan(item.data, service);
        if (!v.ok) return json(400, { error: v.error });
      }
    }
    // PUT 整组：每 item 走占位 merge 调度（observability 列表 / web.jinaApiKey 标量；其他透传）。
    // secret 占位 '***' → 回填落盘原值；明文 → 直接入参。
    const mergedItems = body.items.map((raw) => {
      const item = raw as { key: string; data: unknown };
      return { key: item.key, data: mergePut(service, group, item.key, item.data) };
    });
    service.setGroup(body.group, mergedItems);
    return json(200, { ok: true });
  }
  // 单 key 分支（向后兼容）
  if (typeof body.key !== 'string' || body.data === undefined) {
    return json(400, { error: 'body requires group, key, data' });
  }
  const group2 = body.group as string;
  const key2 = body.key;
  // [v0.0.347] 方案库 PUT：savePlan（校验 + 落盘一体；违规 throw → 400 不落盘）
  if (group2 === MODEL_ROUTING_PLANS_GROUP) {
    try {
      savePlan(service, body.data);
      return json(200, { ok: true });
    } catch (err) {
      if (err instanceof ModelRoutingValidationError) {
        return json(400, { error: err.message });
      }
      throw err;
    }
  }
  // [v0.0.347] playground 挂载 PUT：playgroundPlanId 非空时校验方案存在
  if (group2 === MODEL_ROUTING_GROUP && key2 === MODEL_ROUTING_DEFAULT_KEY) {
    const pg = body.data as { playgroundPlanId?: string } | undefined;
    const pgId = pg && typeof pg === 'object' ? pg.playgroundPlanId : undefined;
    try {
      setPlaygroundPlanId(service, pgId);
      return json(200, { ok: true });
    } catch (err) {
      if (err instanceof ModelRoutingPlanNotFoundError) {
        return json(400, { error: err.message });
      }
      throw err;
    }
  }
  service.set(group2, key2, mergePut(service, group2, key2, body.data));
  return json(200, { ok: true });
}
