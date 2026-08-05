/**
 * channel handlers — /config/channels CRUD（IM 渠道配置面 HTTP facade）
 * 参考: specs/api/overall/17-channel.md §2-§5（端点契约 — 权威响应字段）
 *       specs/tech/channel/[P0]channel_manager.md §3（双状态机 + ChannelManager API）
 *       app/server/src/handlers/connector.ts（同款 fire-and-forget 模式）
 *
 * 设计（与 connector 的关键差异：多 instance + 凭证字段）：
 *   - GET /config/channels → 200 { items: ChannelApiResponse[] }（spec §2 字段：enabled/config/connection/...）
 *   - POST /config/channels → 201 ChannelApiResponse（校验 implId 注册+激活 + configSchema → configService.create + cm.registerConfig）
 *   - PUT /config/channels/:id → 202 {ok:true}（mergeChannelSecret + configService.update + cm.setEnabled fire-and-forget）
 *   - DELETE /config/channels/:id → 200 {ok:true}（cm.unregisterConfig 含 disconnect + 清 binding + 落盘删）
 *   - GET /config/channels/impl-types → 200 { items: [{implId,label}] }（scope 激活集合驱动，v0.0.206）
 *
 * spec 契约映射（api/overall/17-channel.md §2 权威）：
 *   - 内部 ChannelState 用 switch（状态机术语）；API 出参用 enabled（bool）
 *   - config 必须含 appSecret redact '***'（前端编辑回填用）
 *   - errorDetail/lastConnectedAt 缺省显式 null（非 undefined）
 *
 * 约束（D + 运行时不写 policy）：
 *   - appSecret GET 明文返回（secret mask 收敛到前端展示层）；入参 '***' → mergeChannelSecret 回填落盘原值
 *   - implId 双段校验（v0.0.206）：①Registry 登记（管理面）②scope 'default' 激活
 *     （channelManager.listActiveImpls——scope 解析单源=PluginManager 经 manager 物化；
 *     MUST NOT 用 registry 判激活）；两段各返不同 400 文案
 *   - fire-and-forget：PUT setEnabled 不 await 完成（状态机后台迁移）
 */
import type { ChannelManager } from '../channel/channel-manager';
import type { ChannelState, ChannelConfig } from '../channel/types';
import type { Registry } from '../plugin/registry';
import type { RegisteredExtImpl, JsonSchema } from '../plugin/manifest';
import { ChannelConfigService } from '../channel/channel-config-service';
import { mergeChannelSecret } from './channel-redact';

/** channel handler 依赖集合（router 注入；UT 可 mock） */
export interface ChannelHandlerDeps {
  /** ChannelManager（lifecycle: registerConfig/unregisterConfig/setEnabled/getAllStates/listActiveImpls） */
  channelManager: ChannelManager;
  /** channel_config 域逻辑服务（create/update/getRaw/list；与 ChannelManager 内部的同域，stateless file ops） */
  configService: ChannelConfigService;
  /** plugin Registry（implId 校验：getByPoint('channel') 注册段 + impl-types label 反查） */
  registry: Registry;
}

/**
 * API 响应项（spec api/overall/17-channel.md §2 权威契约）。
 * 内部 ChannelState 用 switch（状态机术语，对齐 connector）；API 出参用 enabled（bool，spec 契约）。
 * config 含 appSecret 明文（secret mask 收敛到前端 SecretInput 展示层）。
 */
export interface ChannelApiResponse {
  id: string;
  implId: string;
  name: string;
  /** switch intent（true=on，用户启用） */
  enabled: boolean;
  /** 凭证配置（appSecret 明文，前端 mask 展示） */
  config: Record<string, unknown>;
  /** 运行时连接实况 */
  connection: 'disconnected' | 'connecting' | 'connected' | 'error';
  /** connection='error' 时原因；无错 null */
  errorDetail: string | null;
  /** 最近一次成功连接时间；未连过 null */
  lastConnectedAt: string | null;
  /** 当前绑定数 */
  bindingCount: number;
  /** 创建时间（store 信封注入，isoDate） */
  createdAt?: string;
  /** 最近更新时间（store 信封注入，isoDate） */
  updatedAt?: string;
}

/**
 * 内部 ChannelState + ChannelConfig → API 响应（spec §2 字段映射）。
 * - enabled = state.switch === 'on'
 * - config = channelConfig.config 明文（secret mask 收敛到前端展示层）
 * - errorDetail/lastConnectedAt 缺省 → null（spec 要求显式 null 非 undefined）
 */
function toApiResponse(
  state: ChannelState,
  channelConfig: ChannelConfig | undefined,
): ChannelApiResponse {
  return {
    id: state.id,
    implId: state.implId,
    name: state.name,
    enabled: state.switch === 'on',
    config: channelConfig?.config ?? {},
    connection: state.connection,
    errorDetail: state.errorDetail ?? null,
    lastConnectedAt: state.lastConnectedAt ?? null,
    bindingCount: state.bindingCount ?? 0,
    ...(channelConfig?.createdAt !== undefined ? { createdAt: channelConfig.createdAt } : {}),
    ...(channelConfig?.updatedAt !== undefined ? { updatedAt: channelConfig.updatedAt } : {}),
  };
}

/** 构造 JSON Response（可选 Allow 头） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 校验 config 是否满足 configSchema（minimal：required 字段存在 + 非空字符串） */
function validateConfig(
  config: unknown,
  schema: JsonSchema | undefined,
): { ok: true } | { ok: false; error: string } {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, error: 'config must be an object' };
  }
  const required = (schema?.required as string[] | undefined) ?? [];
  const cfg = config as Record<string, unknown>;
  for (const field of required) {
    const v = cfg[field];
    if (v === undefined || v === null) {
      return { ok: false, error: `config missing required field: ${field}` };
    }
    if (typeof v === 'string' && v.length === 0) {
      return { ok: false, error: `config field "${field}" must be non-empty` };
    }
  }
  return { ok: true };
}

/**
 * implId 双段校验（v0.0.206）：
 *   ①注册：registry.getByPoint('channel') 登记（管理面/校验保留）→ 未注册 400「not registered」
 *   ②激活：channelManager.listActiveImpls()（scope 解析单源=PluginManager 经 manager 物化）
 *     → 未激活 400「registered but not activated in scope 'default'」
 * MUST NOT 用 registry 判激活。
 */
function lookupChannelImpl(
  deps: ChannelHandlerDeps,
  implId: string,
): { ok: true; reg: RegisteredExtImpl } | { ok: false; error: string } {
  const reg = deps.registry.getByPoint('channel').find((r) => r.manifest.implId === implId);
  if (!reg) {
    return { ok: false, error: `implId '${implId}' not registered as channel EP` };
  }
  if (!deps.channelManager.listActiveImpls().some((c) => c.type === implId)) {
    return { ok: false, error: `implId '${implId}' is registered but not activated in scope 'default'（default.yaml 未配置 channel impl）` };
  }
  return { ok: true, reg };
}

// ============================================================
// 4 个 handler
// ============================================================

/**
 * GET /config/channels → 200 { items: ChannelApiResponse[] }
 * JOIN ChannelState（cm.getAllStates）+ ChannelConfig（configService.list 已 redact）
 */
export function handleChannelList(deps: ChannelHandlerDeps): Response {
  const states = deps.channelManager.getAllStates();
  const configs = deps.configService.list();
  const byId = new Map(configs.map((i) => [i.id, i]));
  const items = states.map((s) => toApiResponse(s, byId.get(s.id)));
  return json(200, { items });
}

/**
 * GET /config/channels/impl-types → 200 { items: [{implId,label}] }（v0.0.206 新增）
 * scope 激活集合驱动（channelManager.listActiveImpls）；label 透传 manifest 原始
 * `__MSG_` 占位符（前端 resolveI18nField 解析）；getImplById 此处为管理面反查 pluginId。
 */
export function handleChannelImplTypes(deps: ChannelHandlerDeps): Response {
  const items = deps.channelManager.listActiveImpls().map((c) => {
    const reg = deps.registry.getImplById(c.type);
    const label = (reg && deps.registry.getPluginManifest(reg.pluginId)?.label) || c.type;
    return { implId: c.type, label };
  });
  return json(200, { items });
}

/**
 * POST /config/channels → 201 ChannelApiResponse
 * 校验 implId 双段（注册+激活）+ configSchema → configService.create → cm.registerConfig（fire-and-forget connect）
 */
export async function handleChannelCreate(
  body: unknown,
  deps: ChannelHandlerDeps,
): Promise<Response> {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { error: 'request body must be an object' });
  }
  const b = body as { implId?: unknown; name?: unknown; config?: unknown; enabled?: unknown };
  if (typeof b.implId !== 'string' || b.implId.length === 0) {
    return json(400, { error: 'implId is required (non-empty string)' });
  }
  if (typeof b.name !== 'string' || b.name.length === 0) {
    return json(400, { error: 'name is required (non-empty string)' });
  }
  const lookup = lookupChannelImpl(deps, b.implId);
  if (!lookup.ok) {
    return json(400, { error: lookup.error });
  }
  const schemaCheck = validateConfig(b.config, lookup.reg.manifest.configSchema);
  if (!schemaCheck.ok) {
    return json(400, { error: schemaCheck.error });
  }
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
    return json(400, { error: 'enabled must be boolean if provided' });
  }
  // 落盘 + 注册（registerConfig 内部 fire-and-forget connect）
  const created = deps.configService.create({
    implId: b.implId,
    name: b.name,
    config: b.config as Record<string, unknown>,
    enabled: b.enabled ?? true,
  });
  await deps.channelManager.registerConfig(created);
  // 重新读落盘记录拿 store 信封注入的 createdAt/updatedAt（create 返回的是 pre-put 对象）
  const channelConfig = deps.configService.getRaw(created.id) ?? created;
  const state = deps.channelManager.getState(created.id);
  if (!state) {
    // registerConfig 已建 runtime；state 缺失属异常，回退最小字段
    return json(201, toApiResponse(
      { id: created.id, implId: created.implId, name: created.name, switch: created.enabled ? 'on' : 'off', connection: 'disconnected' },
      channelConfig,
    ));
  }
  return json(201, toApiResponse(state, channelConfig));
}

/**
 * PUT /config/channels/:id → 202 {ok:true}
 * mergeChannelSecret（'***' → 回填原值）→ configService.update → 若 enabled 改 → cm.setEnabled（fire-and-forget）
 */
export async function handleChannelUpdate(
  id: string,
  body: unknown,
  deps: ChannelHandlerDeps,
): Promise<Response> {
  const existing = deps.configService.getRaw(id);
  if (!existing) {
    return json(404, { error: `channel config not found: ${id}` });
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { error: 'request body must be an object' });
  }
  const b = body as { name?: unknown; config?: unknown; enabled?: unknown };
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
    return json(400, { error: 'enabled must be boolean if provided' });
  }
  // merge：appSecret '***' → 回填落盘原值；其余字段 incoming 优先
  const mergedConfig = b.config !== undefined
    ? mergeChannelSecret(
        b.config as Record<string, unknown>,
        existing.config as Record<string, unknown> | undefined,
      )
    : undefined;
  const patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> } = {};
  if (typeof b.name === 'string' && b.name.length > 0) patch.name = b.name;
  if (b.enabled !== undefined) patch.enabled = b.enabled;
  if (mergedConfig !== undefined) patch.config = mergedConfig;
  deps.configService.update(id, patch);
  // 同步 ChannelManager 内存 configs Map：GET 的 state.name 来自内存 configs，落盘更新后须同步内存否则 UI 刷新得旧值（BUG v0.0.106 #4）
  deps.channelManager.updateConfig(id, { name: patch.name, config: patch.config, enabled: patch.enabled });
  // enabled 切换 → cm.setEnabled（fire-and-forget connect/disconnect）
  if (b.enabled !== undefined) {
    void deps.channelManager.setEnabled(id, b.enabled).catch(() => {
      /* 状态机已落 error 态，吞掉避免 unhandled rejection */
    });
  }
  return json(202, { ok: true });
}

/** DELETE /config/channels/:id → 200 {ok:true}（cm.unregisterConfig 含 disconnect + 清 binding + 落盘删） */
export async function handleChannelDelete(
  id: string,
  deps: ChannelHandlerDeps,
): Promise<Response> {
  const existing = deps.configService.getRaw(id);
  if (!existing) {
    return json(404, { error: `channel config not found: ${id}` });
  }
  await deps.channelManager.unregisterConfig(id);
  return json(200, { ok: true });
}

// ============================================================
// 路由分发
// ============================================================

/**
 * 路由分发 /config/channels（GET/POST）+ /config/channels/:id（PUT/DELETE）。
 * @param req Request（POST/PUT 读 body）
 * @param method HTTP method
 * @param path 完整路径
 * @param deps ChannelHandlerDeps
 */
export async function handleChannelRoute(
  req: Request,
  method: string,
  path: string,
  deps: ChannelHandlerDeps,
): Promise<Response> {
  // /config/channels/impl-types（字面分支必须位于 /config/channels/:id 正则之前，否则 'impl-types' 被 :id 吞）
  if (path === '/config/channels/impl-types') {
    if (method === 'GET') return handleChannelImplTypes(deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }
  // /config/channels（无 :id）
  if (path === '/config/channels') {
    if (method === 'GET') return handleChannelList(deps);
    if (method === 'POST') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: 'invalid json body' });
      }
      return handleChannelCreate(body, deps);
    }
    return json(405, { error: 'Method Not Allowed' }, 'GET,POST');
  }
  // /config/channels/:id
  const match = path.match(/^\/config\/channels\/([^/]+)$/);
  if (match) {
    const id = match[1]!;
    if (method === 'DELETE') return handleChannelDelete(id, deps);
    if (method === 'PUT') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: 'invalid json body' });
      }
      return handleChannelUpdate(id, body, deps);
    }
    return json(405, { error: 'Method Not Allowed' }, 'PUT,DELETE');
  }
  return json(404, { error: 'Not Found' });
}
