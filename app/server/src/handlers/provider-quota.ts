/**
 * provider-quota — 额度端点（v0.0.350 决策②⑦ → v0.0.363 语义改造）
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.3
 *       specs/api/overall/02-llm-chat.md §5.6（端点契约）
 *
 * [v0.0.363] 语义变更（推翻 350 决策⑥「server 不缓存」）：
 * - GET /provider/quota：读 QuotaStore 立即返回 { items, lastSyncedAt }（秒回）；
 *   store 空（启动空窗）→ 异步触发 syncOnce 不等待 + 返回 { items: [], lastSyncedAt: null }。
 * - POST /provider/quota/sync：触发增量同步 fire-and-forget（202 { syncing: true,
 *   lastTriggeredAt }；inFlight/节流命中 → 202 { syncing: false, reason }）。
 * - collectQuotaSnapshots：聚合逻辑纯函数（自 350 handler 提取，GET 旧实现与
 *   QuotaSyncService.syncOnce 两处共用零重复）。
 */
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import type { ProviderName, QuotaSnapshot } from '../llm/provider-types';
import { LlmProviderPoint } from '../plugin/extension-point';
import type { LlmProvider } from '../llm/provider';
import { listProviders, PROVIDER_NAME_WHITELIST, type ProviderInstance } from './provider';
import type { QuotaStore } from '../llm/quota-store';
import type { QuotaSyncService } from '../llm/quota-sync-service';

/** 4 native coding plan 类型 = 白名单去通用项（单一权威=PROVIDER_NAME_WHITELIST，零字面量重复防漂移） */
const NATIVE_QUOTA_NAMES: readonly ProviderName[] = PROVIDER_NAME_WHITELIST.filter(
  (n) => n !== 'anthropic_compatible',
);

/** 响应 JSON（可选 headers——405 allow 透传） */
function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * 聚合全部 native coding plan provider 额度/余额快照（纯函数，GET 旧逻辑提取）。
 * 逐 provider：实例 label 覆盖 impl 快照占位（impl 只知 config.id）；fetchedAt 统一取本批时刻。
 * 错误隔离：单渠道失败 → item 带 error 不炸整体；零 native provider → items: []。
 * 消费方：QuotaSyncService.syncOnce（周期/增量）。
 */
export async function collectQuotaSnapshots(
  svc: AppConfigService,
  pluginManager: PluginManager,
): Promise<QuotaSnapshot[]> {
  const natives = listProviders(svc).filter((p) =>
    (NATIVE_QUOTA_NAMES as readonly string[]).includes(p.name),
  );
  if (natives.length === 0) return [];

  // 按实例 name 找对应 impl（getExtensionImpls 单参 ≡ default scope，决策⑦）
  const providerImpls = pluginManager.getExtensionImpls<LlmProvider>(LlmProviderPoint);
  const fetchedAt = Date.now();
  return Promise.all(
    natives.map(async (p): Promise<QuotaSnapshot> => {
      const snap = await queryOne(providerImpls, p);
      // impl 产出统一盖 label + 本批 fetchedAt（决策⑦：label 取实例 label，fetchedAt 聚合端点填充）
      return { ...snap, providerLabel: p.label, fetchedAt };
    }),
  );
}

/**
 * GET /provider/quota：读 store 秒回（v0.0.363 语义）。
 * store 空（启动空窗）→ 异步触发 syncOnce（不等待）+ 立即返回空视图——前端 lastGood
 * 兜底 + SSE 到达刷新。store/syncService 由 bootstrap 注入（misc-routes 透传 bs）。
 */
export function handleProviderQuota(
  method: string,
  quotaStore: QuotaStore,
  syncService: QuotaSyncService,
): Response {
  if (method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' }, { allow: 'GET' });
  }
  // 启动空窗：异步触发首轮（不等待——GET 秒回硬约束）
  if (quotaStore.isEmpty()) {
    syncService.triggerSync();
    return json(200, { items: [], lastSyncedAt: null });
  }
  return json(200, quotaStore.view());
}

/**
 * POST /provider/quota/sync：触发一次增量同步（fire-and-forget）。
 * 接受 → 202 { syncing: true, lastTriggeredAt }；inFlight/节流命中 → 202 { syncing: false, reason }。
 * 打开页面时前端调用（change_plan §1.3：提前跑一轮 syncOnce，与 5min 兜底同构）。
 */
export function handleProviderQuotaSync(
  method: string,
  syncService: QuotaSyncService,
): Response {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, { allow: 'POST' });
  }
  const reason = syncService.triggerSync();
  if (reason !== null) {
    return json(202, { syncing: false, reason });
  }
  return json(202, { syncing: true, lastTriggeredAt: syncService.lastTriggeredAt });
}

/** 单 provider 查询（找 name 对应 impl 调 queryQuota；无 impl/无能力/异常 → error item 不炸整体） */
async function queryOne(
  impls: LlmProvider[],
  p: ProviderInstance,
): Promise<QuotaSnapshot> {
  // implId cast 同 llm-client-factory L76 先例（LlmProvider 接口不含 implId，具体 impl 类持有）
  const impl = impls.find((i) => (i as { implId?: string }).implId === p.name);
  if (!impl || typeof impl.queryQuota !== 'function') {
    return errorItem(p, { kind: 'business', message: `provider impl 未注册或无额度查询能力: ${p.name}` });
  }
  try {
    const snap = await impl.queryQuota(toLlmProviderConfig(p));
    if (snap === null) {
      return errorItem(p, { kind: 'business', message: '该 provider 类型不支持额度查询' });
    }
    return snap;
  } catch (e) {
    return errorItem(p, {
      kind: 'business',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** error 态 item（最小形状：provider 身份 + error） */
function errorItem(p: ProviderInstance, error: QuotaSnapshot['error']): QuotaSnapshot {
  return {
    providerId: p.id,
    providerLabel: p.label,
    implId: p.name,
    kind: 'balance',
    error,
    fetchedAt: Date.now(),
  };
}

/**
 * ProviderInstance（落盘形状）→ LlmProviderConfig（impl 消费形状）宽转。
 * credentials 落盘单 key { key } / impl 期望 CredentialConfig 同形态；字段超集直接透传。
 */
function toLlmProviderConfig(p: ProviderInstance): Parameters<NonNullable<LlmProvider['queryQuota']>>[0] {
  return {
    id: p.id,
    name: p.name,
    protocolId: p.protocolId,
    baseUrl: p.baseUrl,
    credentials: p.credentials as never,
    pluginId: 'builtin.llm_anthropic',
    enabled: p.enabled,
    models: [] as never[],
  };
}
