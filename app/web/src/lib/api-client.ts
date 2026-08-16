/**
 * api-client — 设置页消费 T4 HTTP facade 的薄封装
 * 参考: specs/api/overall/02-llm-chat.md §4（/config 三域 get-set）/ §5（/provider /model CRUD）
 *
 * 复用 api-base.resolveApiBase（不重复解析 VITE_API_BASE，避免重复逻辑）。
 * 仅暴露设置页用到的端点子集；错误时抛 Error（调用方 catch 处理）。
 */
import { resolveApiBase } from './api-base';
// v0.0.26 scope 维度类型（PluginScope + inventory scope 视图扩展），独立文件避免本文件膨胀
// 参考: specs/tech/config/[P0]ext_impl_scope.md §2（PluginScope）/ §7（PluginInventoryTree 扩展）
import type { PluginScope, PluginScopeMeta } from './types/plugin-scope';

// v0.0.26 re-export：scope 类型从 types/ 拆出，旧 import 路径仍可用
export type { PluginScope, PluginScopeMeta };

/**
 * [v0.0.53] protocol id 字面量（与 server ProtocolName 对齐；当前唯一 'anthropic_messages'）。
 * 未来扩多 protocol 时此 union 跟着加（'openai_chat_completions' 等）。
 */
export type ProtocolName = 'anthropic_messages';

/**
 * [v0.0.350] provider 类型 id（决策⑤；与 server ProviderName union 同构）。
 * anthropic_compatible = 通用（缺省兼容）；其余 4 个 = native coding plan 类型
 * （POST/PUT name 白名单 5 值；额度总览仅 4 native 参与——api 02-llm-chat.md 1.8 §5.2/§5.6）。
 */
export type ProviderName =
  | 'anthropic_compatible'
  | 'kimi_coding_plan'
  | 'glm_coding_plan'
  | 'minimax_coding_plan'
  | 'deepseek_api';

/** provider 实例（响应形状，credentials 已脱敏 ***）—— 与 server ProviderInstance 同构 */
export interface ProviderInstance {
  id: string;
  /** [v0.0.350] 类型放宽 ProviderName union（旧响应缺省视为通用 anthropic_compatible） */
  name: ProviderName;
  /** [v0.0.53] 1 provider : 1 protocol 锁定，必填（迁自 ModelInstance.protocolId，单一事实源） */
  protocolId: ProtocolName;
  label: string;
  baseUrl: string;
  credentials: { key: string };
  enabled: boolean;
  models: ModelInstance[];
}

/** model 实例（嵌套 provider.models[]） */
export interface ModelInstance {
  modelId: string;
  // [v0.0.53] protocolId 已迁出 → ProviderInstance.protocolId
  contextWindow: number;
  maxOutputTokens: number;
  /** v0.0.7：显示名（区分同 provider 下多个 model） */
  label: string;
  /** v0.0.7：启停（关闭后在模型选择器隐藏） */
  enabled: boolean;
}

/**
 * [v0.0.53] 已注册 llm_protocol ext impl 元数据（GET /provider 响应顶层附带）。
 * 前端用 label 渲染下拉选项 + path 拼「实际请求地址」预览（baseUrl + path）。
 */
export interface ProtocolMeta {
  /** implId / 持久化标识（= ProtocolName），如 'anthropic_messages' */
  id: ProtocolName;
  /** 人类可读展示名（如 'Anthropic Messages 风格'） */
  label: string;
  /** endpoint path（如 '/v1/messages'），拼接地址用 */
  path: string;
}

/**
 * fetch 封装：统一拼 URL + 错误转异常。
 * [v0.0.26] export 给拆出的 plugin-scope-api.ts 复用（避免重复 fetch/错误处理逻辑）。
 */
export async function req<T>(path: string, init?: RequestInit, base?: string): Promise<T> {
  const res = await fetch(`${resolveApiBase(base)}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

// —— /config/dev（llm_request 两 key）——
// 前端不再 read/write appearance.theme（light-only）；backend `appearance` group 仍存
// （language 走同 group，change-language.ts 不改）。

/** GET /config/dev?group=llm_request —— 回填 stall_timeout_s / max_retry_times（ui §6） */
export async function getDevLlmConfig(base?: string): Promise<{
  stall_timeout_s: number | null;
  max_retry_times: number | null;
}> {
  const r = await req<{ items: Array<{ key: string; data: number }> }>(
    '/config/dev?group=llm_request',
    undefined,
    base,
  );
  const find = (k: string) => r.items.find((i) => i.key === k)?.data ?? null;
  return {
    stall_timeout_s: find('stall_timeout_s'),
    max_retry_times: find('max_retry_times'),
  };
}

/** PUT /config/dev —— 写单个 key（ui §6） */
export async function putDevLlmKey(
  key: 'stall_timeout_s' | 'max_retry_times',
  data: number,
  base?: string,
): Promise<void> {
  await req<{ ok: true }>('/config/dev', {
    method: 'PUT',
    body: JSON.stringify({ group: 'llm_request', key, data }),
  }, base);
}

// —— /config/{app|dev} 整组 GET / 整组 PUT（v0.0.5 §4.1/§4.2 整组提交分支，给三栏 group 保存用）——

/** GET /config/{app|dev}?group=<g> → 该组全部 record（api §4.1/§4.2 整组） */
export async function getConfigGroup(
  domain: 'app' | 'dev',
  group: string,
  base?: string,
): Promise<{ key: string; data: unknown }[]> {
  const r = await req<{ items: { key: string; data: unknown }[] }>(
    `/config/${domain}?group=${encodeURIComponent(group)}`,
    undefined,
    base,
  );
  return r.items ?? [];
}

/** PUT /config/{app|dev} 整组提交（api §4.1/§4.2 [v0.0.5] items[] 分支，原子） */
export async function putConfigGroup(
  domain: 'app' | 'dev',
  group: string,
  items: { key: string; data: unknown }[],
  base?: string,
): Promise<void> {
  await req<{ ok: true }>(`/config/${domain}`, {
    method: 'PUT',
    body: JSON.stringify({ group, items }),
  }, base);
}

/**
 * POST /consolidation/run —— 手动触发一次二级整理任务（v0.0.164.memory_opt）。
 * 参考: specs/api/overall/03-config-center.md §2.8 / specs/tech/agent/session/[P0]app_task_lock.md §4
 *
 * fire-and-forget UX：不 await 任务完成，服务端 acquire 成功即立刻返 202；
 * 撞车（cron 或另一手动触发已 running）则 409。两者都是合法业务响应，直接 return 供 UI 分支处理。
 * 其他 4xx/5xx 视为异常，向上 throw 让调用方展示 error banner。
 */
export async function runConsolidation(
  base?: string,
): Promise<{ ok: true; runId: string } | { error: string }> {
  const res = await fetch(`${resolveApiBase(base)}/consolidation/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (res.status === 202 && typeof body === 'object' && body && 'ok' in body) {
    const runId = 'runId' in body ? String((body as { runId: unknown }).runId) : '';
    return { ok: true, runId };
  }
  if (res.status === 409 && typeof body === 'object' && body && 'error' in body) {
    return { error: String((body as { error: unknown }).error) };
  }
  // 其他非 2xx（5xx/其他 4xx）或响应体形状异常 → throw 供 UI 展示 error banner
  const msg = typeof body === 'object' && body && 'error' in body
    ? String((body as { error: unknown }).error)
    : `HTTP ${res.status}`;
  throw new Error(msg);
}

// —— /config/plugin（inventory group-centric + PUT op）——

/**
 * [v0.0.71 D7] JSON Schema 类型（透传 manifest configSchema，让前端 modal 可读形状）。
 * 服务端 JsonSchema = Record<string, unknown>，前端同形态（宽松，控件路由按 properties.<key>.type 分发）。
 */
export type JsonSchema = Record<string, unknown>;

/** inventory 顶层 plugins[] 平面项（v0.0.5 plugin tab UI 用） */
export interface PluginListItem {
  pluginId: string;
  label: string;
  description: string;
  enabled: boolean;
}

/**
 * inventory group-centric 节点：单个 ext impl（v0.0.71 D3+D7：嵌套在 groups[].points[].impls[] 下）。
 *
 * v0.0.71 关键变更：
 *   - 删 `schemaConfig?`（D7：单一 configSchema 源）
 *   - 加 `configSchema?`（D7：透传 manifest configSchema）
 *   - 删 `pointActivated?`（信息上提到 PluginGroup.points[].activated）
 *   - `config` 始终 = manifest default ⊕ scope configValues 合并（bug-A JOIN 修复）
 *
 * [v0.0.179] enabled/selected/order 都由后端 inventory 按 scope 配置 membership 派生好透传，
 *   前端只消费派生值（不在前端重算）。字段 shape 不变（向后兼容）：
 *   - `enabled` = membership（impl 在当前 scope active 列表 → true；未列候选仍进 impls[] 但 enabled=false）
 *   - `selected` = exclusive EP active 列表 order 最小者（list/ordered 永远 false）
 *   - `order` = YAML 数组序（per-point effective 1..n）
 */
export interface PluginExtImpl {
  pluginId: string;
  pointId: string;
  implId: string;
  /** v0.0.5：原 cardinality 改名 type（值 exclusive/list/ordered） */
  type?: 'exclusive' | 'list' | 'ordered';
  /** 兼容旧 cardinality 字段（后端可能仍返回） */
  cardinality?: string;
  pluginEnabled: boolean;
  /** [v0.0.179] membership 派生：impl 在当前 scope active 列表（inventory 算好透传，前端不重算） */
  enabled: boolean;
  /** [v0.0.71 D7] manifest configSchema 透传（modal 控件路由源；无则 UI 不出齿轮） */
  configSchema?: JsonSchema;
  /** impl 的 config 值（v0.0.71 bug-A：始终 = manifest default ⊕ scope configValues 合并结果） */
  config?: Record<string, unknown>;
  /** ordered 类型：当前顺序（父级按 order 升序传入）；[v0.0.18] 语义改 per-point 连续 1..n。
   *  [v0.0.179] 值源 = YAML 数组序（membership 派生；前端按 inventory 给定值排序，不重算） */
  order?: number;
  /** [v0.0.18] impl 级 description（来自 ExtImpl.description，代码硬编码，无则空串） */
  description?: string;
  /** [v0.0.18] EP 级 description（来自 ExtensionPoint.description，同 point 所有 impl 共享，无则空串） */
  pointDescription?: string;
  /** [v0.0.18] plugin 级 description（来自 PluginManifest.description，同 plugin 所有 impl 共享，无则空串） */
  pluginDescription?: string;
  /** [v0.0.55] selected 派生字段（exclusive point 选中项；list/ordered 永远 false）。
   *  前端 radio 直接读，不再按 enabled 瞎猜（修「两红框一 dot」bug）。后端 inventory 算出来不入库。
   *  [v0.0.179] 派生规则：exclusive EP active 列表 order 最小者（membership 单一源；validator 保证 active 恰好 1）。 */
  selected?: boolean;
}

/**
 * inventory group 分区（v0.0.71 D3 嵌套化：groups[].points[].impls[]）。
 *
 * v0.0.71 关键变更（破坏性 schema 变更）：
 *   - 删 `extImpls[]`（impl 跨 point 平铺数组）
 *   - 旧 `points?`（仅含激活状态）改强嵌套 `points[]: { pointId, activated, impls[] }`
 *   - impl 显式归 point 节点下（不再跨 point 平铺）
 */
export interface PluginGroup {
  groupId: string;
  /** 该 group 下每个 point 节点（含激活状态 + impls[]）。v0.0.71：必填（不再可选）。 */
  points: {
    pointId: string;
    /** 该 point 在当前 scope 的激活态（同 point 所有 impl 共享）。
     *  default scope 全 true；其他 scope 未激活 EP=false（impls 取 default 回退视图，UI 灰显）。 */
    activated: boolean;
    /** 该 point 的 impl 节点（per-point effective order 排序） */
    impls: PluginExtImpl[];
  }[];
}

/** GET /config/plugin inventory 全量树（v0.0.5：顶层 plugins[] + groups[]；v0.0.26：加 scope/scopes） */
export interface PluginInventory {
  plugins: PluginListItem[];
  groups: PluginGroup[];
  /** [v0.0.26] 当前查询 scope 的元信息（缺省查 default 时 = default scope 元信息） */
  scope?: PluginScopeMeta;
  /** [v0.0.26] 全部 scope 列表（供 UI 切换器，default 首位） */
  scopes?: PluginScope[];
}

/**
 * GET /config/plugin —— 取 inventory 全量树（v0.0.5：顶层 plugins[] + groups[]；v0.0.26：加 scopeId?；
 *   v0.0.71：嵌套 groups[].points[].impls[]）。
 * @param scopeId [v0.0.26] 可选 scope id，缺省不传 = 'default'（与 v0.0.18 行为完全一致，向后兼容）。
 *   非 default 时：未激活 EP 的 points[].activated=false，impls 取 default 回退视图（UI 灰显）。
 * @param base 可选 API base（测试用）
 */
export async function getPluginInventory(
  scopeId?: string,
  base?: string,
): Promise<PluginInventory> {
  const q = scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : '';
  const r = await req<{ tree: PluginInventory }>(
    `/config/plugin${q}`,
    undefined,
    base,
  );
  return r.tree ?? { plugins: [], groups: [] };
}

// —— /config/plugin/scopes（v0.0.26 scope list / activation list，api change_log §1/§2）——
// v0.0.67：写函数（putPluginOp + createScope/deleteScope/activateEp/deactivateEp）已删，
// 配置只读化（用户指示「直接删写端点，无死代码」）。读函数拆到 plugin-scope-api.ts。
// 此处 re-export 保旧 import 路径 `from './api-client'` 仍可用（零调用方改动）。
export {
  listScopes,
  listActivations,
} from './plugin-scope-api';

// —— /memory/:scope（v0.0.55 memory UI CRUD，specs/api/overall/15-memory-ui.md）——
// 拆到 memory-api.ts（同 plugin-scope-api 范式，保持本文件 ≤ 行数预算）。
export {
  listMemory,
  writeMemory,
  patchMemory,
  archiveMemory,
  type MemoryEntry,
  type MemoryType,
  type MemoryScope,
  type MemoryWriteInput,
} from './memory-api';

// —— /provider CRUD ——

/** [v0.0.53] GET /provider 响应形状（顶层 = items + protocols） */
interface ProviderListResponse {
  items: ProviderInstance[];
  protocols: ProtocolMeta[];
}

/** GET /provider —— 列所有 provider 实例（ui §5） */
export async function listProviders(base?: string): Promise<ProviderInstance[]> {
  const r = await req<ProviderListResponse>('/provider', undefined, base);
  return r.items ?? [];
}

/**
 * [v0.0.53] 一次调用同时取 items + protocols（节省一次 round-trip；section-providers 进 list 时用）。
 * GET /provider 响应 = { items, protocols }，本 helper 直接返回拆解后两字段。
 * protocols 一次加载全程共享（不随 detail 切换重拉）。
 */
export async function loadProvidersAndProtocols(base?: string): Promise<{
  items: ProviderInstance[];
  protocols: ProtocolMeta[];
}> {
  const r = await req<ProviderListResponse>('/provider', undefined, base);
  return { items: r.items ?? [], protocols: r.protocols ?? [] };
}

/** POST /provider —— 创建 provider 实例（ui §5；[v0.0.350] name 可选透传，缺省 anthropic_compatible） */
export async function createProvider(
  body: { label: string; baseUrl: string; apiKey: string; protocolId: ProtocolName; name?: ProviderName },
  base?: string,
): Promise<ProviderInstance> {
  const r = await req<{ provider: ProviderInstance }>('/provider', {
    method: 'POST',
    body: JSON.stringify({
      // [v0.0.350] 类型透传（决策⑤；缺省通用向后兼容——后端白名单校验）
      name: body.name ?? 'anthropic_compatible',
      // [v0.0.53] protocolId 必填（缺 → 后端 400）
      protocolId: body.protocolId,
      label: body.label,
      baseUrl: body.baseUrl,
      credentials: { key: body.apiKey },
      enabled: true,
    }),
  }, base);
  return r.provider;
}

/** DELETE /provider/:id —— 删 provider（级联删 models[]）（ui §5） */
export async function deleteProvider(id: string, base?: string): Promise<void> {
  await req<{ ok: true }>(`/provider/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }, base);
}

// —— [v0.0.350] GET /provider/quota 额度聚合（api 02-llm-chat.md 1.8 §5.6）——

/** 额度桶（5 小时 / 周两桶；usedPercent = 已用百分比） */
export interface QuotaTier {
  window: 'five_hour' | 'weekly';
  usedPercent: number;
  resetsAt?: string;
}

/** 单渠道额度/余额快照（统一形状，四渠道解析器唯一输出契约——决策⑧） */
export interface QuotaSnapshot {
  providerId: string;
  providerLabel: string;
  implId: ProviderName;
  kind: 'quota' | 'balance';
  tiers?: QuotaTier[];
  membership?: string;
  balance?: { currency: string; total: number; granted?: number; toppedUp?: number };
  isAvailable?: boolean;
  error?: { kind: 'auth' | 'business' | 'network' | 'timeout'; message: string };
  fetchedAt: number;
}

/** GET /provider/quota —— 读全局额度 store 秒回（[v0.0.363] T1 契约：store 权威源；空窗 {items:[], lastSyncedAt:null}；单渠道失败 item.error 不炸整体） */
export async function fetchProviderQuota(base?: string): Promise<{ items: QuotaSnapshot[]; lastSyncedAt: number | null }> {
  return req<{ items: QuotaSnapshot[]; lastSyncedAt: number | null }>('/provider/quota', undefined, base);
}

/** POST /provider/quota/sync —— 触发增量同步（[v0.0.363] T1 契约：202 fire-and-forget；inFlight/30s 节流在 server 挡叠加；结果经 SSE provider_quota 帧到达） */
export async function syncProviderQuota(base?: string): Promise<void> {
  await req('/provider/quota/sync', { method: 'POST' }, base);
}

/** PUT /provider/:id —— 更新 provider 实例（label/baseUrl/enabled/apiKey/protocolId/name）（v0.0.7 + v0.0.53 + [v0.0.350] name） */
export async function updateProvider(
  id: string,
  body: { label?: string; baseUrl?: string; enabled?: boolean; apiKey?: string; protocolId?: ProtocolName; name?: ProviderName },
  base?: string,
): Promise<ProviderInstance> {
  const r = await req<{ provider: ProviderInstance }>(
    `/provider/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        label: body.label,
        baseUrl: body.baseUrl,
        enabled: body.enabled,
        // [v0.0.53] 可选 protocolId（修改 protocol = 换接入点风格）
        ...(body.protocolId ? { protocolId: body.protocolId } : {}),
        // [v0.0.350] 可选 name（类型切换通道，决策⑤；不传不写保持兼容）
        ...(body.name ? { name: body.name } : {}),
        ...(body.apiKey ? { credentials: { key: body.apiKey } } : {}),
      }),
    },
    base,
  );
  return r.provider;
}

/** POST /provider/:id/model —— 给 provider 加 model（ui §5；v0.0.7 全字段；[v0.0.53] model 无 protocolId） */
export async function createModel(
  providerId: string,
  body: { modelId: string; contextWindow?: number; maxOutputTokens?: number; label?: string; enabled?: boolean },
  base?: string,
): Promise<ModelInstance> {
  const r = await req<{ model: ModelInstance }>(
    `/provider/${encodeURIComponent(providerId)}/model`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    base,
  );
  return r.model;
}

/** PUT /provider/:id/model/:modelId —— 更新 model（v0.0.7） */
export async function updateModel(
  providerId: string,
  modelId: string,
  body: { contextWindow?: number; maxOutputTokens?: number; label?: string; enabled?: boolean },
  base?: string,
): Promise<ModelInstance> {
  const r = await req<{ model: ModelInstance }>(
    `/provider/${encodeURIComponent(providerId)}/model/${encodeURIComponent(modelId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
    base,
  );
  return r.model;
}

/** DELETE /provider/:id/model/:modelId —— 删 model（ui §5） */
export async function deleteModel(
  providerId: string,
  modelId: string,
  base?: string,
): Promise<void> {
  await req<{ ok: true }>(
    `/provider/${encodeURIComponent(providerId)}/model/${encodeURIComponent(modelId)}`,
    { method: 'DELETE' },
    base,
  );
}

/**
 * saveProviderWithModels —— v0.0.7 统一保存（UI 算 diff + 逐条 CRUD）。
 * provider 字段变了 → PUT /provider（新建则 POST /provider）；model 按 modelId 配对算
 * 新增/编辑/删除，逐条 POST/PUT/DELETE。后端端点不变。
 *
 * [v0.0.53] provider 字段集 += protocolId（新建 POST 必填；已存 PUT 若变才传）。
 *
 * @param snapshot 进入二级页时的已持久化 provider（新建则 null）
 * @param draft    二级页编辑后的 provider（含全部 model + protocolId）
 * @returns 持久化后的 provider（reload 后）
 */
export async function saveProviderWithModels(
  snapshot: ProviderInstance | null,
  draft: { id?: string; label: string; baseUrl: string; apiKey: string; enabled: boolean; protocolId: ProtocolName; models: ModelInstance[]; name?: ProviderName },
  base?: string,
): Promise<ProviderInstance> {
  // provider 字段 diff（apiKey === '***' 视为未改，与后端脱敏一致）
  const providerChanged =
    snapshot === null ||
    snapshot.label !== draft.label ||
    snapshot.baseUrl !== draft.baseUrl ||
    snapshot.enabled !== draft.enabled ||
    // [v0.0.53] protocolId 变更也算 provider dirty
    snapshot.protocolId !== draft.protocolId ||
    // [v0.0.350] name（类型）变更也算 provider dirty（决策⑤：PUT 才会发出）
    (snapshot.name ?? 'anthropic_compatible') !== (draft.name ?? 'anthropic_compatible') ||
    (draft.apiKey && draft.apiKey !== '***' && draft.apiKey !== snapshot.credentials.key);

  // 1) provider 本体：新建 POST / 已存且变 → PUT
  let providerId = snapshot?.id ?? '';
  if (snapshot === null) {
    const created = await createProvider(
      // [v0.0.53] 新建必传 protocolId（避免后端 400）；[v0.0.350] name 透传（缺省通用兼容）
      { label: draft.label, baseUrl: draft.baseUrl, apiKey: draft.apiKey, protocolId: draft.protocolId, name: draft.name },
      base,
    );
    providerId = created.id;
  } else if (providerChanged) {
    // [v0.0.350] name（类型）变才透传（PUT 可选通道）
    const nameChanged = (snapshot.name ?? 'anthropic_compatible') !== (draft.name ?? 'anthropic_compatible');
    await updateProvider(snapshot.id, {
      label: draft.label,
      baseUrl: draft.baseUrl,
      enabled: draft.enabled,
      apiKey: draft.apiKey,
      // [v0.0.53] 若 protocolId 变则传（PUT 可选）
      ...(snapshot.protocolId !== draft.protocolId ? { protocolId: draft.protocolId } : {}),
      ...(nameChanged ? { name: draft.name } : {}),
    }, base);
  }

  // 2) model diff（按 modelId 配对）
  const oldModels = new Map((snapshot?.models ?? []).map((m) => [m.modelId, m]));
  const newIds = new Set(draft.models.map((m) => m.modelId));
  // 删除：old 有 new 无
  for (const [mid, m] of oldModels) {
    if (!newIds.has(mid) && snapshot) {
      await deleteModel(providerId, mid, base);
    }
  }
  for (const m of draft.models) {
    const old = oldModels.get(m.modelId);
    if (!old) {
      // 新增
      await createModel(providerId, { ...m }, base);
    } else {
      // 编辑（字段变才 PUT）
      const changed =
        old.label !== m.label ||
        old.enabled !== m.enabled ||
        old.contextWindow !== m.contextWindow ||
        old.maxOutputTokens !== m.maxOutputTokens;
      if (changed) {
        await updateModel(providerId, m.modelId, {
          label: m.label,
          enabled: m.enabled,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
        }, base);
      }
    }
  }

  // 3) reload 返回最新
  const fresh = await listProviders(base);
  return fresh.find((p) => p.id === providerId) ?? fresh[0]!;
}

// —— /skill（v0.0.21 skill 管理页，非流式 JSON；标识 = name + scope）——
// 参考: specs/api/overall/06-skill.md

/**
 * skill 条目（对齐 06-skill.md §3.2 SkillEntry；[v0.0.55] mutable→evolvable 改名）。
 * scope 值域含 'group'（后端 SkillScope 四层 builtin|app|workspace|group）；
 * group=squad 团队 ws `.rocky/skills/`，仅 `?sessionId=` 入口会命中。
 */
export interface SkillEntry {
  name: string;
  description: string;
  scope: 'builtin' | 'app' | 'workspace' | 'group';
  skillDir: string;
  enabled: boolean;
  source?: 'user' | 'agent';
  productionMethod?: 'handwritten' | 'consolidation' | 'download';
  /** [v0.0.55] 是否允许 agent 修改/整理（原 mutable 改名，对齐 06a-skill-governance v2.0） */
  evolvable?: boolean;
  // —— 市场来源锚点（[v0.0.167]，镜像后端 skills/types.ts；仅市场安装写，缺省=本地/手写/builtin 来源）——
  /** 安装用的 provider ref（如 github/awesome-copilot/git-commit）；市场 tab 据 item.ref===marketRef 精确匹配判「同源已安装」 */
  marketRef?: string;
  /** 安装来源 provider id（如 skills_sh）；来源展示用 */
  marketSource?: string;
  /** 安装时内容哈希（可更新惰性比对锚点：市场详情 detail.hash 与之不同 → 可更新） */
  installedHash?: string;
}

/** skill 预览文件树节点（API 扁平形态，06-skill.md §6.2） */
export interface SkillFileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

/** skill 预览文件内容响应（06-skill.md §7.2） */
export interface SkillFileContent {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * GET /skill —— skill 列表（双层合并，06-skill.md §3）。
 * @param workspace 可选 workspace 绝对路径（提供则同时扫 workspace 级）
 */
export async function listSkills(base?: string, workspace?: string): Promise<SkillEntry[]> {
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const r = await req<{ items: SkillEntry[] }>(`/skill${q}`, undefined, base);
  return r.items ?? [];
}

/**
 * GET /skill?sessionId=<sid> —— 按 session record 派生的四层合并 catalog（06-skill.md §3.1）。workspace=session.workspaceDir、group 层=session.squadId
 * 团队 ws；响应 scope 值域含 'group'。chat 悬浮菜单 skills 入口数据源（前端免组装 session 字段）。
 * session not found → 404（req 抛错，由调用方 hook 的 error 通道承载）。
 * @param sessionId 当前会话 id
 */
export async function listSkillsBySession(sessionId: string, base?: string): Promise<SkillEntry[]> {
  const r = await req<{ items: SkillEntry[] }>(
    `/skill?sessionId=${encodeURIComponent(sessionId)}`,
    undefined,
    base,
  );
  return r.items ?? [];
}

/**
 * POST /skill/install —— multipart 上传安装 skill（06-skill.md §2）。
 * 注意：此处不能用 req()（它强制 content-type: application/json），需裸 fetch。
 * @param files 上传文件数组（单文件 .md/.zip/.skill；folder 用多 file 带 relativePath）
 * @param scope app|workspace（默认 app）
 * @param workspace scope=workspace 时必需
 */
export async function installSkill(
  files: File[],
  opts: { scope?: 'app' | 'workspace'; workspace?: string } = {},
  base?: string,
): Promise<SkillEntry> {
  const fd = new FormData();
  for (const f of files) {
    // folder 场景：用 webkitRelativePath 作 filename，后端按相对路径还原目录结构
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    const filename = rel && rel.length > 0 ? rel : f.name;
    // 用第三个参数指定 filename，使 FormData 内 filename 含目录层级（06-skill.md §2.1 folder 字段说明）
    fd.append('file', f, filename);
  }
  const scope = opts.scope ?? 'app';
  fd.append('scope', scope);
  if (scope === 'workspace' && opts.workspace) fd.append('workspace', opts.workspace);

  const res = await fetch(`${resolveApiBase(base)}/skill/install`, {
    method: 'POST',
    body: fd,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (body as { skill: SkillEntry }).skill;
}

/**
 * PATCH /skill/:name —— toggle enabled（06-skill.md §4）。
 * @param name skill 名（kebab-case）
 * @param enabled 目标启用态
 * @param scope 可选显式层（缺省 = 合并层命中）
 * @param workspace scope=workspace 时必需
 */
export async function patchSkillEnabled(
  name: string,
  enabled: boolean,
  opts: { scope?: 'builtin' | 'app' | 'workspace'; workspace?: string } = {},
  base?: string,
): Promise<SkillEntry> {
  const body: Record<string, unknown> = { enabled };
  if (opts.scope) body.scope = opts.scope;
  if (opts.workspace) body.workspace = opts.workspace;
  const r = await req<{ skill: SkillEntry }>(
    `/skill/${encodeURIComponent(name)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    base,
  );
  return r.skill;
}

/**
 * [v0.0.55] PATCH /skill/:name/governance —— UI 改 evolvable（06a-skill-governance.md v2.0）。
 *
 * 与 `patchSkillEnabled` 区别：本端点只写 frontmatter `evolvable` 字段，无 lock 约束
 * （v0.0.55 删 mutableLocked 维度）。agent 工具（skill_manage）不碰治理元字段，
 * UI 改 evolvable 是用户行为，走独立 HTTP 端点（见 06a §1）。
 *
 * @param name skill 名（kebab-case）
 * @param evolvable 目标值（true↔false 都允许）
 * @param opts.scope 必需（app|workspace，强制 caller 显式指定，避免误改另一层同名 skill）
 * @param opts.workspace scope=workspace 时必需（绝对路径）
 */
export async function patchSkillEvolvable(
  name: string,
  evolvable: boolean,
  opts: { scope: 'app' | 'workspace'; workspace?: string },
  base?: string,
): Promise<SkillEntry> {
  const body: Record<string, unknown> = { scope: opts.scope, evolvable };
  if (opts.workspace) body.workspace = opts.workspace;
  const r = await req<{ skill: SkillEntry }>(
    `/skill/${encodeURIComponent(name)}/governance`,
    { method: 'PATCH', body: JSON.stringify(body) },
    base,
  );
  return r.skill;
}

/**
 * DELETE /skill/:name —— 物理删除（06-skill.md §5）。
 * @param scope 可选显式层（缺省 = 合并层命中）
 * @param workspace scope=workspace 时必需
 */
export async function deleteSkill(
  name: string,
  opts: { scope?: 'app' | 'workspace'; workspace?: string } = {},
  base?: string,
): Promise<void> {
  const params = new URLSearchParams();
  if (opts.scope) params.set('scope', opts.scope);
  if (opts.workspace) params.set('workspace', opts.workspace);
  const q = params.toString() ? `?${params.toString()}` : '';
  await req<{ ok: true }>(`/skill/${encodeURIComponent(name)}${q}`, { method: 'DELETE' }, base);
}

/**
 * GET /skill/:name/tree —— 预览文件树（扁平数组，06-skill.md §6）。
 * @param workspace 可选 workspace 绝对路径
 */
export async function getSkillTree(
  name: string,
  base?: string,
  workspace?: string,
): Promise<SkillFileNode[]> {
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const r = await req<{ tree: SkillFileNode[] }>(
    `/skill/${encodeURIComponent(name)}/tree${q}`,
    undefined,
    base,
  );
  return r.tree ?? [];
}

/**
 * GET /skill/:name/file?path= —— 预览单文件内容（06-skill.md §7）。
 * @param path 相对 skillDir 的文件路径（必填）
 * @param workspace 可选 workspace 绝对路径
 */
export async function getSkillFile(
  name: string,
  path: string,
  base?: string,
  workspace?: string,
): Promise<SkillFileContent> {
  const params = new URLSearchParams({ path });
  if (workspace) params.set('workspace', workspace);
  const r = await req<SkillFileContent>(
    `/skill/${encodeURIComponent(name)}/file?${params.toString()}`,
    undefined,
    base,
  );
  return r;
}

// —— /skills/market（[v0.0.167] skill 市场 tab；复用 v0.0.166 market 后端）——
// 参考: specs/tech/agent/skills/[P1]skill_market.md §9；镜像后端 tools/skill-market/types.ts

/**
 * 市场能力协商响应（GET /skills/market/capabilities，镜像后端 { id, label, capabilities }）。
 * UI 先读 capabilities 再决定渲染哪些维度——缺字段=provider 未声明，不渲染、不造假（能力门控）。
 * skills.sh = `{ stats:['installs'] }`（无 categories/collections/sorts/stars）。
 */
export interface MarketCapabilities {
  /** provider id（如 skills_sh） */
  id: string;
  /** 展示名 */
  label: string;
  capabilities: {
    /** 结果统计维度（skills.sh 仅 installs） */
    stats?: ('installs' | 'stars')[];
    /** 分类枚举；false=显式不支持分类；undefined=未声明 */
    categories?: string[] | false;
    /** 集合/精选清单名 */
    collections?: string[];
    /** 排序模式 */
    sorts?: string[];
  };
}

/**
 * 市场结果卡数据形（GET /skills/market/search items[]，镜像后端 SkillMarketItem 核心 + 门控字段）。
 * ref/name 必有；其余可选且能力门控（skills.sh search 无 description，只在 detail 补）。
 */
export interface MarketItem {
  /** install 唯一标识（provider 定义格式；skills.sh = `{owner}/{repo}/{slug}`） */
  ref: string;
  name: string;
  /** search 阶段部分源（skills.sh）不返回；缺则不渲染描述 */
  description?: string;
  /** 统计维度（能力门控，skills.sh 仅 installs） */
  stats?: { installs?: number; stars?: number };
}

/**
 * 市场详情（GET /skills/market/detail，镜像后端 SkillMarketDetail = MarketItem + 详情字段）。
 * hash/files 为 v0.0.167 新增：hash 供详情 modal 与已安装 SkillEntry.installedHash 本地比对判「可更新」；
 * files 仅相对路径（不含 contents）供文件清单展示。缺 hash=provider 未返 → 不做可更新判定（能力门控）。
 */
export interface MarketDetail extends MarketItem {
  readme?: string;
  /** 仓库定位（url + 可选 subpath，monorepo skill 指向子目录） */
  repository?: { url: string; subpath?: string };
  /** 当前内容哈希（可更新惰性比对锚点） */
  hash?: string;
  /** 包含文件列表（仅相对路径，不回传 contents） */
  files?: Array<{ path: string }>;
}

/**
 * GET /skills/market/capabilities —— 取当前生效市场源的能力协商信息。
 * 无 active provider 时后端返 503 → 本函数返回 `null`（供 section 区分「无 provider」noProvider 态）；
 * 其他非 2xx（4xx/5xx）→ throw Error 供上层 error 态展示。用裸 fetch（需区分 503，同 runConsolidation 范式）。
 */
export async function getMarketCapabilities(base?: string): Promise<MarketCapabilities | null> {
  const res = await fetch(`${resolveApiBase(base)}/skills/market/capabilities`, {
    headers: { 'content-type': 'application/json' },
  });
  if (res.status === 503) return null; // 无生效市场源 → noProvider 态（非错误）
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as MarketCapabilities;
}

/**
 * GET /skills/market/search?q=&owner=&limit= —— 市场搜索（透传 provider 返回，取 items）。
 * 只传 q（+ 可选 owner/limit）；后端返回 SkillMarketSearchResult，本函数取 `.items` 归一为 `{ items }`。
 * @param opts.q 查询词（必填）；owner 按 gh_owner 过滤；limit 结果上限
 */
export async function searchMarket(
  opts: { q: string; owner?: string; limit?: number },
  base?: string,
): Promise<{ items: MarketItem[] }> {
  const params = new URLSearchParams({ q: opts.q });
  if (opts.owner) params.set('owner', opts.owner);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const r = await req<{ items?: MarketItem[] }>(
    `/skills/market/search?${params.toString()}`,
    undefined,
    base,
  );
  return { items: r.items ?? [] };
}

/**
 * GET /skills/market/detail?ref= —— 取 skill 市场详情（ref 含 `/` 走 query，需 encodeURIComponent）。
 * 返回含 readme/files/hash（可更新惰性比对锚点）。
 */
export async function getMarketDetail(ref: string, base?: string): Promise<MarketDetail> {
  return await req<MarketDetail>(
    `/skills/market/detail?ref=${encodeURIComponent(ref)}`,
    undefined,
    base,
  );
}

/**
 * POST /skills/market/install —— 安装/更新市场 skill（成功 202 { skill }，取 `.skill`）。
 * overwrite=true 触发同源更新重装（后端仅当磁盘同名 skill 的 market_ref===本次 ref 才覆盖，守卫读磁盘 frontmatter）；
 * 默认 false=保持 409 语义。冲突（409）经 `req` 抛 Error 透传 caller（UI 反馈）。
 */
export async function installMarketSkill(
  input: { ref: string; overwrite?: boolean },
  base?: string,
): Promise<SkillEntry> {
  const body: { ref: string; overwrite?: boolean } = { ref: input.ref };
  if (input.overwrite !== undefined) body.overwrite = input.overwrite;
  const r = await req<{ skill: SkillEntry }>(
    '/skills/market/install',
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
  return r.skill;
}

// —— /config/connectors（v0.0.23 连接器端点组，08-web-tools.md §6）——

/** 连接器 id（v0.0.23 仅 browser） */
export type ConnectorId = 'browser';

/** 连接态（运行时连接实况） */
export type ConnectorConnection = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * 连接器实时状态（双状态机，tech [P1]connectors.md §3.1 + api 08 §6.1）。
 * switch=on 实时表示「已连上」（持久化值是 intent，非实时态）。
 */
export interface ConnectorState {
  id: ConnectorId;
  /** 实时开关态（on=连上）；持久化值是 intent，重启 reconnect 期间实时 off */
  switch: 'on' | 'off';
  connection: ConnectorConnection;
  /** connection=error 时原因（chrome 未开 / 未开 remote debugging / 版本<144 / 拒绝 prompt） */
  errorDetail?: string;
  /** 上次 connected 时间戳 */
  lastConnectedAt?: number;
}

/**
 * GET /config/connectors —— 所有连接器当前实时状态（08-web-tools.md §6.1）。
 * 端点 200 + { items: ConnectorState[] }；UI 轮询感知 connecting → connected/error 终态。
 */
export async function listConnectors(base?: string): Promise<ConnectorState[]> {
  const r = await req<{ items: ConnectorState[] }>(
    '/config/connectors',
    undefined,
    base,
  );
  return r.items ?? [];
}

/**
 * PUT /config/connectors/:id —— 派发 enable/disable（08-web-tools.md §6.2）。
 * fire-and-forget：202 = 已接收，状态异步迁移中；调用方轮询 GET 感知终态。
 * @param enable true=set intent=on + 触发 connect；false=intent=off + disconnect
 */
export async function putConnectorToggle(
  id: ConnectorId,
  enable: boolean,
  base?: string,
): Promise<void> {
  await req<{ ok: true }>(
    `/config/connectors/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify({ enable }) },
    base,
  );
}
