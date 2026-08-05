/**
 * provider handlers — /provider + /provider/:id/model CRUD（封装 app_config providers 组）
 * 参考: specs/api/overall/02-llm-chat.md §5（protocolId 归属 + GET 响应扩 protocols）
 *
 * provider 实例 = app_config providers 组一条 record（key=instanceId，data=ProviderInstance）。
 * 响应中 credentials.key 返回明文（BUG-002 修复：mask 收敛到前端展示层）。
 * PUT 时 key==='***' 仍视为不修改（向后兼容旧调用方，幂等无害）。
 *
 * protocol 归属：ProviderInstance.protocolId 必填（1 provider : 1 protocol 锁定，单一事实源）；
 *   ModelInstance 无 protocolId；GET 响应扩 protocols；POST 校验 protocolId 合法性；
 *   POST/PUT /provider/:id/model body 含 protocolId → 忽略（前端容错友好，201/200）。
 * group='providers' 固定；ULID 由 ulid() 生成（POST 时）。
 */
import { ulid } from '../config/ulid';
import type { AppConfigService } from '../config/app-config-service';
import type { Currency, ProtocolName } from '../llm/provider-types';
import type { PluginManager } from '../plugin/plugin-manager';
// protocol metadata + 合法性校验拆到 helper
import {
  buildProtocolMeta,
  isValidProtocolId,
  type ProtocolMeta,
} from './provider-protocol-helpers';

// re-export：api-client / handler 调用方仍可从 provider.ts 拿到 ProtocolMeta 类型
export type { ProtocolMeta };

/** 响应/落盘的 ProviderInstance 形状（specs/api §5.2，简化版） */
export interface ProviderInstance {
  id: string;
  name: 'anthropic_compatible';
  /** 1 provider : 1 protocol 锁定，必填 */
  protocolId: ProtocolName;
  label: string;
  baseUrl: string;
  credentials: { key: string };
  enabled: boolean;
  models: ModelInstance[];
}

/** model 实例（嵌套在 provider.models[]） */
export interface ModelInstance {
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** 显示名（区分同 provider 下多个 model） */
  label: string;
  /** 启停（关闭后在模型选择器隐藏） */
  enabled: boolean;
  /**
   * per-model 定价（per-instance 数据，非代码固有）。
   * 权威：specs/tech/agent/providers_and_models/[P0]llm_model_interface.md §3.3 Pricing。
   * 缺省（旧 record / 未配置）→ factory 兜底 {inputPerMillion:0, outputPerMillion:0, currency:'USD'}
   * 即 cost=0（向后兼容；minimax 等需显式配 pricing 才有 cost）。
   */
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
    currency: Currency;
  };
}

/** providers 组名（固定） */
const GROUP = 'providers';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 取整组 providers record（key=instanceId，data=ProviderInstance）；过滤 _deleted tombstone。
 *
 * 防御性 id 补全：历史脏数据 / 某些测试夹具可能直接 PUT providers 组时漏填 id
 * （ET 观察 undefined/claude-mock-1）。出口对缺 id 的 record 生成 ULID 并回写，
 * 保证 UI model picker（providerId/modelId）永不显示 undefined（specs/ui §8）。
 */
function listProviders(svc: AppConfigService): ProviderInstance[] {
  const records = svc.listGroup(GROUP);
  const out: ProviderInstance[] = [];
  for (const r of records) {
    const p = r.data as ProviderInstance;
    if (!p || (p as unknown as { _deleted?: boolean })._deleted) continue;
    if (typeof p.id !== 'string' || p.id.length === 0) {
      // 缺 id → 补 ULID 并回写（以新 id 为 key 落盘，旧 tombstone key 留存无副作用）
      const fixed: ProviderInstance = { ...p, id: ulid() };
      svc.set(GROUP, fixed.id, fixed);
      out.push(fixed);
    } else {
      out.push(p);
    }
  }
  return out;
}

/** 按 id 取单个 provider；未命中返 undefined */
function findProvider(svc: AppConfigService, id: string): ProviderInstance | undefined {
  return listProviders(svc).find((p) => p.id === id);
}

/** 处理 /provider（无 id）：GET 列 / POST 创 */
export async function handleProviderCollection(
  req: Request,
  method: string,
  svc: AppConfigService,
  pluginManager?: PluginManager,
): Promise<Response> {
  if (method === 'GET') {
    const items = listProviders(svc);
    // 顶层附带 protocols metadata（前端拼接地址 + 下拉用）；pluginManager 缺失时返空数组（向后兼容旧调用）
    const protocols = pluginManager ? buildProtocolMeta(pluginManager) : [];
    return json(200, { items, protocols });
  }
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }
  let body: Partial<ProviderInstance> & { credentials?: { key?: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (
    body.name !== 'anthropic_compatible' ||
    typeof body.label !== 'string' ||
    typeof body.baseUrl !== 'string' ||
    typeof body.credentials?.key !== 'string'
  ) {
    return json(400, { error: 'body requires name=anthropic_compatible, label, baseUrl, credentials.key' });
  }
  // protocolId 必填校验
  if (typeof body.protocolId !== 'string' || body.protocolId.length === 0) {
    return json(400, { error: 'body requires protocolId' });
  }
  // protocolId 合法性校验（在已注册 llm_protocol impl 集合内；pluginManager 缺失则跳过校验向后兼容）
  if (pluginManager && !isValidProtocolId(pluginManager, body.protocolId)) {
    return json(400, { error: `protocolId must be one of registered llm_protocol impls; got: ${body.protocolId}` });
  }
  const instance: ProviderInstance = {
    id: ulid(),
    name: 'anthropic_compatible',
    protocolId: body.protocolId,
    label: body.label,
    baseUrl: body.baseUrl,
    credentials: { key: body.credentials.key },
    enabled: body.enabled ?? true,
    models: [],
  };
  svc.set(GROUP, instance.id, instance);
  return json(201, { provider: instance });
}

/** 处理 /provider/:id：GET/PUT/DELETE */
export async function handleProviderItem(
  req: Request,
  method: string,
  id: string,
  svc: AppConfigService,
  pluginManager?: PluginManager,
): Promise<Response> {
  const existing = findProvider(svc, id);
  if (!existing) return json(404, { error: 'Not Found' });
  if (method === 'GET') {
    return json(200, { provider: existing });
  }
  if (method === 'DELETE') {
    // service 无 delete 接口；用 _deleted tombstone 标记 + findProvider 过滤（GET/再 PUT 不可见）
    svc.set(
      GROUP,
      id,
      { id, _deleted: true } as unknown as ProviderInstance,
    );
    return json(200, { ok: true });
  }
  if (method !== 'PUT') {
    return json(405, { error: 'Method Not Allowed' });
  }
  let body: Partial<ProviderInstance> & { credentials?: { key?: string }; enabled?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  // protocolId 可选：传则校验合法性（pluginManager 缺失时跳过）
  const protocolChanged = typeof body.protocolId === 'string' && body.protocolId.length > 0;
  if (protocolChanged && pluginManager && !isValidProtocolId(pluginManager, body.protocolId!)) {
    return json(400, { error: `protocolId must be one of registered llm_protocol impls; got: ${body.protocolId}` });
  }
  // credentials.key === '***' 视为不修改
  const keyChanged = typeof body.credentials?.key === 'string' && body.credentials.key !== '***';
  const updated: ProviderInstance = {
    ...existing,
    protocolId: protocolChanged ? (body.protocolId as ProtocolName) : existing.protocolId,
    label: typeof body.label === 'string' ? body.label : existing.label,
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : existing.baseUrl,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
    credentials: keyChanged
      ? { key: body.credentials!.key! }
      : existing.credentials,
  };
  svc.set(GROUP, id, updated);
  return json(200, { provider: updated });
}

/** 处理 /provider/:id/model（无 modelId）：GET 列 / POST 加 */
export async function handleModelCollection(
  req: Request,
  method: string,
  providerId: string,
  svc: AppConfigService,
): Promise<Response> {
  const provider = findProvider(svc, providerId);
  if (!provider) return json(404, { error: 'Not Found' });
  if (method === 'GET') {
    return json(200, { items: provider.models });
  }
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }
  let body: Partial<ModelInstance>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (
    typeof body.modelId !== 'string'
  ) {
    return json(400, { error: 'body requires modelId' });
  }
  if (provider.models.some((m) => m.modelId === body.modelId)) {
    return json(409, { error: 'Conflict' });
  }
  // body.protocolId / body.default 若存在 → 静默忽略（protocolId 归属 ProviderInstance；
  // per-model default 字段已于 v0.0.143 删除，被 app_config/default_models 取代）
  const model: ModelInstance = {
    modelId: body.modelId,
    contextWindow: body.contextWindow ?? 0,
    maxOutputTokens: body.maxOutputTokens ?? 0,
    label: typeof body.label === 'string' ? body.label : body.modelId,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
  };
  const updated: ProviderInstance = { ...provider, models: [...provider.models, model] };
  svc.set(GROUP, providerId, updated);
  return json(201, { model });
}

/** 处理 /provider/:id/model/:modelId：PUT/DELETE */
export async function handleModelItem(
  req: Request,
  method: string,
  providerId: string,
  modelId: string,
  svc: AppConfigService,
): Promise<Response> {
  const provider = findProvider(svc, providerId);
  if (!provider) return json(404, { error: 'Not Found' });
  const idx = provider.models.findIndex((m) => m.modelId === modelId);
  if (idx < 0) return json(404, { error: 'Not Found' });
  const existing = provider.models[idx]!;
  if (method === 'DELETE') {
    const models = provider.models.filter((m) => m.modelId !== modelId);
    svc.set(GROUP, providerId, { ...provider, models });
    return json(200, { ok: true });
  }
  if (method !== 'PUT') {
    return json(405, { error: 'Method Not Allowed' });
  }
  let body: Partial<ModelInstance>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  // body.default 若存在 → 静默忽略（per-model default 字段已于 v0.0.143 删除）
  const updated: ModelInstance = {
    ...existing,
    contextWindow: typeof body.contextWindow === 'number' ? body.contextWindow : existing.contextWindow,
    maxOutputTokens: typeof body.maxOutputTokens === 'number' ? body.maxOutputTokens : existing.maxOutputTokens,
    label: typeof body.label === 'string' ? body.label : existing.label,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
  };
  const models = provider.models.map((m) => (m.modelId === modelId ? updated : m));
  svc.set(GROUP, providerId, { ...provider, models });
  return json(200, { model: updated });
}
