/**
 * KV config handlers — /config/app GET/PUT（通用 KV 形状 + secret redact）
 * 参考: specs/api/overall/02-llm-chat.md §4（get-set）
 *       specs/prd/version_logs/v0.0.89/05-dev-to-app-migration.md §3.1.D/E
 *
 * 设计：
 *   - app：通用 KV（委托 AppConfigService）
 *       GET ?group=&key= → 单值 { value }（缺失返 null）
 *       GET ?group=      → 整组 { items:[{key,data}] }
 *       PUT {group,key,data}              → { ok:true }（单 key，向后兼容）
 *       PUT {group,items:[{key,data},...]} → { ok:true }（整组原子提交）
 *   - secret 处理：GET 全部明文返回（secret mask 收敛到前端 SecretInput 展示层，与
 *     observability / providers / web_search 一致）；PUT 占位 '***' merge 回落盘原值
 *     （observability 列表 / web.jinaApiKey 标量，向后兼容旧前端）。
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

/** 处理 /config/app 的 GET（通用 KV 形状） */
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
 * 解析并校验 PUT /config/app body；按 body 形态分发：
 *  - body 含 items[] → setGroup（整组原子提交）
 *  - 否则 → set（单 key，向后兼容）
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
    // PUT 整组：每 item 走占位 merge 调度（observability 列表 / web.jinaApiKey 标量；其他透传）。
    // secret 占位 '***' → 回填落盘原值；明文 → 直接入参。
    const group = body.group as string;
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
  service.set(group2, key2, mergePut(service, group2, key2, body.data));
  return json(200, { ok: true });
}
